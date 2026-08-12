/**
 * FullShot — selection overlay (content script).
 *
 * Injected on demand after protocol.js and util.js, in the same isolated world
 * as page-driver.js. Classic script, no module, no build step.
 *
 * One overlay serves both jobs (ARCHITECTURE §6): hovering outlines the element
 * under the cursor and a click captures it, while a drag draws a free region
 * with resize handles. Everything lives in a CLOSED shadow root with inline
 * styles, so no page CSS and no page CSP can touch it — and page script cannot
 * read the selection back.
 *
 * Resolves CS_SELECT with { rect: DocRect, kind } in DOCUMENT space, or
 * { cancelled: true }, and leaves no node and no listener behind either way.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  // executeScript re-runs this file on every select capture in the same tab.
  if (FS.selectOverlay) return;

  const ATTR_UI = 'data-fullshot-ui';

  const EDGE = 40; // auto-scroll band, px from the viewport edge
  const EDGE_MAX_SPEED = 24; // px per frame at the very edge
  const CLICK_SLOP = 5; // below this, a press+release is a click, not a drag
  const MIN_SIZE = 4; // anything smaller is an empty selection
  const HANDLE = 10; // resize handle side, px
  const MIN_HIT = 8; // a hit box smaller than this walks up to its parent
  const ACCENT = '#4c8dff';
  const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const CURSORS = {
    nw: 'nwse-resize',
    n: 'ns-resize',
    ne: 'nesw-resize',
    e: 'ew-resize',
    se: 'nwse-resize',
    s: 'ns-resize',
    sw: 'nesw-resize',
    w: 'ew-resize'
  };

  /** At most one overlay at a time. */
  let session = null;

  // ------------------------------------------------------------------ CSS

  const HOST_CSS = [
    'all: initial !important',
    'position: fixed !important',
    'left: 0 !important',
    'top: 0 !important',
    'width: 100% !important',
    'height: 100% !important',
    'margin: 0 !important',
    'z-index: 2147483647 !important',
    'display: block !important',
    'pointer-events: auto !important',
    'cursor: crosshair !important'
  ].join(';');

  /**
   * Full-viewport transparent layer, appended FIRST so every other layer paints
   * above it. Without it a press on the backdrop would hit the host element,
   * which lives outside the shadow tree — the shadow-root listeners below would
   * never see it. Handles and the ✓ button sit above this layer, so the real
   * target still tells them apart.
   */
  const CATCHER_CSS = [
    'position: fixed',
    'left: 0',
    'top: 0',
    'width: 100%',
    'height: 100%',
    'background: transparent',
    'pointer-events: auto',
    'cursor: crosshair'
  ].join(';');

  const DIM_CSS = 'position: fixed;background: rgba(0, 0, 0, 0.42);pointer-events: none';
  const OUTLINE_CSS = [
    'position: fixed',
    'box-sizing: border-box',
    'pointer-events: none',
    'display: none',
    'box-shadow: 0 0 0 1px ' + ACCENT + ', 0 0 0 2px rgba(255, 255, 255, 0.55)'
  ].join(';');
  const READOUT_CSS = [
    'position: fixed',
    'box-sizing: border-box',
    'padding: 3px 7px',
    'border-radius: 6px',
    'background: rgba(18, 19, 23, 0.92)',
    'color: #f4f5f7',
    'font: 600 11px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    'font-variant-numeric: tabular-nums',
    'white-space: nowrap',
    'pointer-events: none',
    'user-select: none',
    'display: none'
  ].join(';');
  const HINT_CSS = [
    'position: fixed',
    'left: 50%',
    'top: 16px',
    'transform: translateX(-50%)',
    'box-sizing: border-box',
    'max-width: 92%',
    'padding: 9px 14px',
    'border-radius: 10px',
    'background: rgba(18, 19, 23, 0.92)',
    'color: #f4f5f7',
    'font: 500 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    'text-align: center',
    'box-shadow: 0 8px 28px rgba(0, 0, 0, 0.38)',
    'pointer-events: none',
    'user-select: none'
  ].join(';');
  const HINT_KEYS_CSS = 'margin-top: 3px;font-size: 11px;opacity: .65';
  const HANDLE_CSS = [
    'position: fixed',
    'box-sizing: border-box',
    'width: ' + HANDLE + 'px',
    'height: ' + HANDLE + 'px',
    'border: 1px solid ' + ACCENT,
    'border-radius: 2px',
    'background: #ffffff',
    'box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4)',
    'pointer-events: auto',
    'display: none'
  ].join(';');
  const CONFIRM_CSS = [
    'position: fixed',
    'box-sizing: border-box',
    'width: 30px',
    'height: 30px',
    'border-radius: 15px',
    'background: ' + ACCENT,
    'color: #ffffff',
    'font: 700 15px/30px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    'text-align: center',
    'box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4)',
    'pointer-events: auto',
    'cursor: pointer',
    'user-select: none',
    'display: none'
  ].join(';');

  // -------------------------------------------------------------- helpers

  function finiteOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function scrollLeftOf() {
    return finiteOr(window.scrollX, finiteOr(document.documentElement && document.documentElement.scrollLeft, 0));
  }

  function scrollTopOf() {
    return finiteOr(window.scrollY, finiteOr(document.documentElement && document.documentElement.scrollTop, 0));
  }

  function viewportWidth() {
    return Math.max(1, finiteOr(window.innerWidth, finiteOr(document.documentElement && document.documentElement.clientWidth, 1)));
  }

  function viewportHeight() {
    return Math.max(1, finiteOr(window.innerHeight, finiteOr(document.documentElement && document.documentElement.clientHeight, 1)));
  }

  function rectFromPoints(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y)
    };
  }

  function docPoint(event) {
    return { x: finiteOr(event.clientX, 0) + scrollLeftOf(), y: finiteOr(event.clientY, 0) + scrollTopOf() };
  }

  function makeDiv(css, parent) {
    const el = document.createElement('div');
    el.style.cssText = css;
    if (parent) parent.appendChild(el);
    return el;
  }

  function setBox(el, left, top, width, height) {
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.style.width = Math.max(0, Math.round(width)) + 'px';
    el.style.height = Math.max(0, Math.round(height)) + 'px';
  }

  // ---------------------------------------------------------- hit testing

  /**
   * The element under the cursor, skipping our own overlay. The shadow root is
   * closed, so document.elementsFromPoint reports the host — never its inner
   * nodes — which makes the filter a simple identity check. Tiny hit boxes
   * (inline text wrappers) walk up until the box is usable.
   */
  function pickAt(clientX, clientY) {
    let list;
    try {
      list = document.elementsFromPoint(clientX, clientY);
    } catch (_) {
      return null;
    }
    let el = null;
    for (let i = 0; i < list.length; i++) {
      const candidate = list[i];
      if (!candidate || candidate === session.host) continue;
      try {
        if (candidate.hasAttribute && candidate.hasAttribute(ATTR_UI)) continue;
      } catch (_) {
        continue;
      }
      el = candidate;
      break;
    }
    let guard = 0;
    while (el && guard++ < 24) {
      let r = null;
      try {
        r = el.getBoundingClientRect();
      } catch (_) {
        return null;
      }
      if (r && r.width >= MIN_HIT && r.height >= MIN_HIT) {
        return {
          x: r.left + scrollLeftOf(),
          y: r.top + scrollTopOf(),
          w: r.width,
          h: r.height
        };
      }
      el = el.parentElement;
    }
    return null;
  }

  // -------------------------------------------------------------- drawing

  function activeRect() {
    const s = session;
    if (!s) return null;
    if (s.sel) return s.sel;
    if (s.mode === 'element' && s.hover) return s.hover;
    return null;
  }

  function adjusting() {
    const s = session;
    return !!(s && s.sel && s.phase !== 'drag');
  }

  function render() {
    const s = session;
    if (!s) return;
    const vw = viewportWidth();
    const vh = viewportHeight();
    const doc = activeRect();

    s.hintMain.textContent = FS.util.t(
      s.mode === 'element' ? 'select_hint_element' : 'select_hint_region'
    );

    if (!doc) {
      setBox(s.dim.top, 0, 0, vw, vh);
      setBox(s.dim.bottom, 0, 0, 0, 0);
      setBox(s.dim.left, 0, 0, 0, 0);
      setBox(s.dim.right, 0, 0, 0, 0);
      s.outline.style.display = 'none';
      s.readout.style.display = 'none';
      showHandles(false);
      return;
    }

    const left = doc.x - scrollLeftOf();
    const top = doc.y - scrollTopOf();
    const l = clamp(left, 0, vw);
    const t = clamp(top, 0, vh);
    const r = clamp(left + doc.w, 0, vw);
    const b = clamp(top + doc.h, 0, vh);

    setBox(s.dim.top, 0, 0, vw, t);
    setBox(s.dim.bottom, 0, b, vw, vh - b);
    setBox(s.dim.left, 0, t, l, b - t);
    setBox(s.dim.right, r, t, vw - r, b - t);

    s.outline.style.display = 'block';
    setBox(s.outline, left, top, doc.w, doc.h);

    s.readout.style.display = 'block';
    // Escaped code points so the source stays pure ASCII on disk.
    s.readout.textContent = Math.round(doc.w) + ' \u00d7 ' + Math.round(doc.h);
    const readoutTop = top + doc.h + 6 > vh - 24 ? Math.max(2, top + doc.h - 24) : top + doc.h + 6;
    s.readout.style.left = Math.round(clamp(left, 2, vw - 90)) + 'px';
    s.readout.style.top = Math.round(clamp(readoutTop, 2, vh - 24)) + 'px';

    const show = adjusting();
    showHandles(show);
    if (show) {
      const points = {
        nw: [left, top],
        n: [left + doc.w / 2, top],
        ne: [left + doc.w, top],
        e: [left + doc.w, top + doc.h / 2],
        se: [left + doc.w, top + doc.h],
        s: [left + doc.w / 2, top + doc.h],
        sw: [left, top + doc.h],
        w: [left, top + doc.h / 2]
      };
      for (let i = 0; i < DIRS.length; i++) {
        const dir = DIRS[i];
        const el = s.handles[dir];
        el.style.left = Math.round(points[dir][0] - HANDLE / 2) + 'px';
        el.style.top = Math.round(points[dir][1] - HANDLE / 2) + 'px';
      }
      s.confirm.style.left = Math.round(clamp(left + doc.w - 34, 4, vw - 34)) + 'px';
      s.confirm.style.top = Math.round(clamp(top + doc.h + 8, 4, vh - 34)) + 'px';
    }
  }

  function showHandles(on) {
    const s = session;
    for (let i = 0; i < DIRS.length; i++) s.handles[DIRS[i]].style.display = on ? 'block' : 'none';
    s.confirm.style.display = on ? 'block' : 'none';
  }

  // ------------------------------------------------------------ auto-scroll

  function startAutoScroll() {
    const s = session;
    if (s.rafId) return;
    const tick = () => {
      const live = session;
      if (!live || live !== s) return;
      s.rafId = 0;
      const vw = viewportWidth();
      const vh = viewportHeight();
      const p = s.pointer;
      let dx = 0;
      let dy = 0;
      if (p.x < EDGE) dx = -speed(EDGE - p.x);
      else if (p.x > vw - EDGE) dx = speed(p.x - (vw - EDGE));
      if (p.y < EDGE) dy = -speed(EDGE - p.y);
      else if (p.y > vh - EDGE) dy = speed(p.y - (vh - EDGE));
      if (dx || dy) {
        try {
          window.scrollBy(dx, dy);
        } catch (_) {
          /* the page refuses to scroll — keep dragging inside the viewport */
        }
        updateFromPointer();
      }
      s.rafId = requestAnimationFrame(tick);
    };
    s.rafId = requestAnimationFrame(tick);
  }

  function speed(distance) {
    return Math.min(EDGE_MAX_SPEED, 4 + distance * 0.6);
  }

  function stopAutoScroll() {
    const s = session;
    if (!s || !s.rafId) return;
    try {
      cancelAnimationFrame(s.rafId);
    } catch (_) {
      /* already fired */
    }
    s.rafId = 0;
  }

  /** Re-derive the live geometry from the last pointer position (used by both
   *  mousemove and every auto-scroll frame, so a scroll extends the drag). */
  function updateFromPointer() {
    const s = session;
    const point = { x: s.pointer.x + scrollLeftOf(), y: s.pointer.y + scrollTopOf() };

    if (s.phase === 'drag') {
      s.sel = rectFromPoints(s.dragStart, point);
    } else if (s.phase === 'resize') {
      const base = s.resizeBase;
      let x1 = base.x;
      let y1 = base.y;
      let x2 = base.x + base.w;
      let y2 = base.y + base.h;
      if (s.resizeDir.indexOf('n') !== -1) y1 = point.y;
      if (s.resizeDir.indexOf('s') !== -1) y2 = point.y;
      if (s.resizeDir.indexOf('w') !== -1) x1 = point.x;
      if (s.resizeDir.indexOf('e') !== -1) x2 = point.x;
      s.sel = rectFromPoints({ x: x1, y: y1 }, { x: x2, y: y2 });
    } else if (s.phase === 'move') {
      s.sel = {
        x: point.x - s.grab.x,
        y: point.y - s.grab.y,
        w: s.sel.w,
        h: s.sel.h
      };
    } else if (s.mode === 'element') {
      s.hover = pickAt(s.pointer.x, s.pointer.y);
    }
    render();
  }

  // ------------------------------------------------------------- resolving

  function normalized(rect) {
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    return {
      x: x,
      y: y,
      w: Math.max(0, Math.round(rect.w - (x - rect.x))),
      h: Math.max(0, Math.round(rect.h - (y - rect.y)))
    };
  }

  function confirmSelection() {
    const s = session;
    if (!s) return;
    const rect = activeRect();
    if (!rect) return;
    const out = normalized(rect);
    if (out.w < MIN_SIZE || out.h < MIN_SIZE) {
      finish({ error: FS.ERR.EMPTY_SELECTION });
      return;
    }
    finish({ rect: out, kind: s.kind });
  }

  function finish(result) {
    const s = session;
    if (!s) return;
    session = null;
    teardown(s);
    try {
      s.resolve(result);
    } catch (_) {
      /* the engine is gone; the page is clean either way */
    }
  }

  function teardown(s) {
    try {
      if (s.rafId) cancelAnimationFrame(s.rafId);
    } catch (_) {
      /* already fired */
    }
    for (let i = 0; i < s.listeners.length; i++) {
      const entry = s.listeners[i];
      try {
        entry[0].removeEventListener(entry[1], entry[2], entry[3]);
      } catch (_) {
        /* target gone with the node */
      }
    }
    s.listeners.length = 0;
    try {
      if (s.host && s.host.parentNode) s.host.parentNode.removeChild(s.host);
    } catch (_) {
      /* the page already tore it out */
    }
  }

  // ---------------------------------------------------------------- input

  function onMouseDown(event) {
    const s = session;
    if (!s || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    s.pointer = { x: finiteOr(event.clientX, 0), y: finiteOr(event.clientY, 0) };
    const point = docPoint(event);

    if (event.target === s.confirm) {
      confirmSelection();
      return;
    }

    const dir = s.handleDir.get(event.target);
    if (dir && s.sel) {
      s.phase = 'resize';
      s.resizeDir = dir;
      s.resizeBase = { x: s.sel.x, y: s.sel.y, w: s.sel.w, h: s.sel.h };
      s.kind = 'region';
      startAutoScroll();
      return;
    }

    if (s.sel && point.x >= s.sel.x && point.x <= s.sel.x + s.sel.w && point.y >= s.sel.y && point.y <= s.sel.y + s.sel.h) {
      s.phase = 'move';
      s.grab = { x: point.x - s.sel.x, y: point.y - s.sel.y };
      s.kind = 'region';
      startAutoScroll();
      return;
    }

    s.phase = 'drag';
    s.dragStart = point;
    s.downClient = { x: s.pointer.x, y: s.pointer.y };
    s.moved = false;
    s.sel = null;
    startAutoScroll();
    render();
  }

  function onMouseMove(event) {
    const s = session;
    if (!s) return;
    s.pointer = { x: finiteOr(event.clientX, 0), y: finiteOr(event.clientY, 0) };
    if (s.phase === 'drag' && !s.moved) {
      const dx = s.pointer.x - s.downClient.x;
      const dy = s.pointer.y - s.downClient.y;
      if (Math.abs(dx) >= CLICK_SLOP || Math.abs(dy) >= CLICK_SLOP) s.moved = true;
    }
    updateFromPointer();
  }

  function onMouseUp(event) {
    const s = session;
    if (!s) return;
    if (event && event.stopPropagation) {
      event.preventDefault();
      event.stopPropagation();
    }
    stopAutoScroll();

    if (s.phase === 'drag') {
      if (!s.moved) {
        // A press+release under the slop is a click: take the element under it.
        s.sel = null;
        if (s.mode === 'element') {
          s.hover = pickAt(s.pointer.x, s.pointer.y);
          if (s.hover) {
            s.kind = 'element';
            s.phase = 'idle';
            confirmSelection();
            return;
          }
        }
        s.phase = 'idle';
      } else {
        s.kind = 'region';
        s.phase = 'adjust';
      }
    } else if (s.phase === 'resize' || s.phase === 'move') {
      s.phase = 'adjust';
    }
    render();
  }

  function onKeyDown(event) {
    const s = session;
    if (!s) return;
    const key = event.key;

    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish({ cancelled: true });
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      confirmSelection();
      return;
    }
    if (key === ' ' || key === 'Spacebar') {
      event.preventDefault();
      event.stopPropagation();
      s.mode = s.mode === 'element' ? 'region' : 'element';
      s.hover = null;
      if (s.mode === 'element') {
        s.sel = null;
        s.kind = 'element';
        s.hover = pickAt(s.pointer.x, s.pointer.y);
      }
      render();
      return;
    }

    const step = event.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    if (key === 'ArrowLeft') dx = -step;
    else if (key === 'ArrowRight') dx = step;
    else if (key === 'ArrowUp') dy = -step;
    else if (key === 'ArrowDown') dy = step;
    else return;

    event.preventDefault();
    event.stopPropagation();
    // Nudging an outlined element adopts it as a free region.
    if (!s.sel && s.hover) s.sel = { x: s.hover.x, y: s.hover.y, w: s.hover.w, h: s.hover.h };
    if (!s.sel) return;
    s.sel = { x: s.sel.x + dx, y: s.sel.y + dy, w: s.sel.w, h: s.sel.h };
    s.kind = 'region';
    s.phase = 'adjust';
    render();
  }

  function onViewportChange() {
    if (!session) return;
    render();
  }

  function onContextMenu(event) {
    // A right-click during selection would hand the page a menu over the
    // overlay; cancel instead, which is what users expect from a picker.
    event.preventDefault();
    event.stopPropagation();
    finish({ cancelled: true });
  }

  // ----------------------------------------------------------------- open

  function open() {
    return new Promise((resolve) => {
      // A second CS_SELECT supersedes a pending one rather than stacking.
      if (session) finish({ cancelled: true });

      const root = document.documentElement || document.body;
      if (!root) {
        resolve({ error: FS.ERR.EMPTY_SELECTION });
        return;
      }

      const host = document.createElement('div');
      host.setAttribute(ATTR_UI, 'select');
      host.style.cssText = HOST_CSS;
      const shadow = host.attachShadow({ mode: 'closed' });

      const s = {
        host: host,
        shadow: shadow,
        resolve: resolve,
        listeners: [],
        handleDir: new Map(),
        handles: {},
        mode: 'element',
        kind: 'element',
        phase: 'idle',
        sel: null,
        hover: null,
        pointer: { x: -1000, y: -1000 },
        downClient: { x: 0, y: 0 },
        dragStart: { x: 0, y: 0 },
        grab: { x: 0, y: 0 },
        resizeDir: '',
        resizeBase: null,
        moved: false,
        rafId: 0
      };
      session = s;

      s.catcher = makeDiv(CATCHER_CSS, shadow);
      s.dim = {
        top: makeDiv(DIM_CSS, shadow),
        bottom: makeDiv(DIM_CSS, shadow),
        left: makeDiv(DIM_CSS, shadow),
        right: makeDiv(DIM_CSS, shadow)
      };
      s.outline = makeDiv(OUTLINE_CSS, shadow);
      s.readout = makeDiv(READOUT_CSS, shadow);
      s.hint = makeDiv(HINT_CSS, shadow);
      s.hintMain = makeDiv('', s.hint);
      s.hintKeys = makeDiv(HINT_KEYS_CSS, s.hint);
      s.hintKeys.textContent = FS.util.t('select_hint_keys');
      for (let i = 0; i < DIRS.length; i++) {
        const dir = DIRS[i];
        const handle = makeDiv(HANDLE_CSS, shadow);
        handle.style.cursor = CURSORS[dir];
        s.handles[dir] = handle;
        s.handleDir.set(handle, dir);
      }
      s.confirm = makeDiv(CONFIRM_CSS, shadow);
      s.confirm.textContent = '\u2713';

      root.appendChild(host);

      // Pointer events are taken on the shadow root: inside its own tree the
      // real target is visible, which is how the handles and the ✓ button are
      // told apart from the backdrop. stopPropagation there keeps every one of
      // them from ever reaching the page.
      on(shadow, 'mousedown', onMouseDown, true);
      on(shadow, 'mousemove', onMouseMove, true);
      on(shadow, 'mouseup', onMouseUp, true);
      on(shadow, 'contextmenu', onContextMenu, true);
      // Safety net: a release outside the window still ends the drag.
      on(window, 'mouseup', onMouseUp, true);
      on(window, 'keydown', onKeyDown, true);
      on(window, 'scroll', onViewportChange, true);
      on(window, 'resize', onViewportChange, true);

      render();
    });
  }

  function on(target, type, handler, capture) {
    target.addEventListener(type, handler, capture);
    session.listeners.push([target, type, handler, capture]);
  }

  // ------------------------------------------------------------- dispatch

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== FS.MSG.CS_SELECT) return undefined; // not ours
    open()
      .then((result) => {
        try {
          sendResponse(result);
        } catch (_) {
          /* the engine gave up waiting */
        }
      })
      .catch((err) => {
        try {
          sendResponse({ error: String((err && err.message) || err) });
        } catch (_) {
          /* same */
        }
      });
    return true; // answered when the user is done
  });

  FS.selectOverlay = {
    version: FS.VERSION,
    /** Exposed so anything else injected can force the overlay down. */
    cancel: function cancel() {
      finish({ cancelled: true });
    }
  };
})();
