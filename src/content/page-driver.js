/**
 * FullShot — page driver (content script).
 *
 * Injected on demand by the background worker, in this order and in the same
 * isolated world: protocol.js, util.js, page-driver.js. Classic script, no
 * module, no build step.
 *
 * This file owns every mutation made to the captured page — the freeze
 * stylesheet, the fixed/sticky marker attributes, the scroll position, the
 * lazy-loading hints and the progress HUD — and it owns undoing all of them in
 * CS_RESTORE. A page left frozen or scrolled is the worst possible outcome, so
 * restoration is stateless where it can be (query the marks back out of the
 * DOM) and individually guarded everywhere else.
 *
 * See ARCHITECTURE.md §5.3, §5.4 and §11.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  // executeScript re-runs this file for every repeat capture in the same tab:
  // bail out so the runtime listener is registered exactly once per world.
  if (FS.pageDriver) return;

  /** The only marks left on page nodes — attributes, never inline styles. */
  const ATTR_HIDDEN = 'data-fullshot-hidden';
  const ATTR_STATIC = 'data-fullshot-static';
  const ATTR_LAZY = 'data-fullshot-lazy';
  const ATTR_UI = 'data-fullshot-ui';
  const STYLE_ID = 'fullshot-freeze';

  /** A hostile page can hold 500 000 nodes; never walk more than this. */
  const WALK_LIMIT = 20000;
  /** settleMs === 0 means "auto". */
  const AUTO_SETTLE_MS = 90;
  /** The first frame also absorbs the reflow caused by hiding fixed elements. */
  const FIRST_SETTLE_MS = 250;
  const MAX_TILES = 1000;
  const LAZY_STEP_MS = 60;
  const LAZY_SETTLE_MS = 250;
  const LAZY_MAX_STEPS = 80;
  const TOAST_MS = 2600;

  /** ARCHITECTURE §5.3 step 3, verbatim. No interpolation, ever. */
  const FREEZE_CSS = [
    'html { scroll-behavior: auto !important; }',
    '* { scroll-behavior: auto !important; scroll-snap-type: none !important;',
    '    animation-play-state: paused !important; transition: none !important; }',
    '[data-fullshot-hidden] { visibility: hidden !important; }',
    '[data-fullshot-static]  { position: static !important; }'
  ].join('\n');

  /** Everything CS_RESTORE has to be able to undo lives here. */
  const state = {
    active: false,
    options: null,
    scroller: null,
    scrollsWindow: true,
    snapshot: null, // { x, y, winX, winY } — the only thing we have to remember
    styleEl: null,
    fixed: [],
    escapeHandler: null,
    ui: null
  };

  // ---------------------------------------------------------------- helpers

  function finiteOr(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function raf() {
    return new Promise((resolve) => {
      try {
        requestAnimationFrame(() => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  /**
   * Walk the document once, capped, with per-element isolation: a single
   * element whose getComputedStyle throws (cross-document adoption, detached
   * frames…) must not abort the pass — see the CONSTRAINTS in §11.
   */
  function eachElement(visit) {
    let nodes;
    try {
      nodes = document.querySelectorAll('*');
    } catch (_) {
      return;
    }
    const count = Math.min(nodes.length, WALK_LIMIT);
    for (let i = 0; i < count; i++) {
      try {
        visit(nodes[i]);
      } catch (_) {
        /* one hostile element must never abort the walk */
      }
    }
  }

  function setFlag(el, attr, on) {
    try {
      if (on) {
        if (!el.hasAttribute(attr)) el.setAttribute(attr, '');
      } else if (el.hasAttribute(attr)) {
        el.removeAttribute(attr);
      }
    } catch (_) {
      /* detached or read-only node — nothing to undo either */
    }
  }

  // ------------------------------------------------------- scroll plumbing

  function docScroller() {
    return document.scrollingElement || document.documentElement || null;
  }

  function windowScroll() {
    const doc = docScroller();
    return {
      x: finiteOr(window.scrollX, doc ? finiteOr(doc.scrollLeft, 0) : 0),
      y: finiteOr(window.scrollY, doc ? finiteOr(doc.scrollTop, 0) : 0)
    };
  }

  /** Current offsets of whichever element actually scrolls this capture. */
  function readScroll() {
    if (!state.scrollsWindow && state.scroller) {
      return {
        x: finiteOr(state.scroller.scrollLeft, 0),
        y: finiteOr(state.scroller.scrollTop, 0)
      };
    }
    return windowScroll();
  }

  /**
   * `behavior: 'instant'` beats a page's `scroll-behavior: smooth`; the freeze
   * stylesheet forces the same thing, which is why CS_RESTORE puts the scroll
   * back *before* removing it.
   */
  function writeScroll(x, y) {
    if (!state.scrollsWindow && state.scroller) {
      const el = state.scroller;
      try {
        el.scrollTo({ left: x, top: y, behavior: 'instant' });
      } catch (_) {
        el.scrollLeft = x;
        el.scrollTop = y;
      }
      return;
    }
    try {
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
    } catch (_) {
      window.scrollTo(x, y);
    }
  }

  function snapshotScroll() {
    const win = windowScroll();
    const own = readScroll();
    return { x: own.x, y: own.y, winX: win.x, winY: win.y };
  }

  // --------------------------------------------------------- §5.3 step 1-6

  /**
   * Normally `document.scrollingElement`. Single-page apps that scroll an inner
   * container get that container instead: it must actually overflow and cover
   * at least 60 % of the viewport, so a small overflowing widget is never
   * mistaken for the page.
   */
  function pickScroller() {
    const doc = docScroller();
    const vw = Math.max(1, finiteOr(window.innerWidth, 1));
    const vh = Math.max(1, finiteOr(window.innerHeight, 1));

    if (!doc) return { el: null, scrollsWindow: true };
    if (finiteOr(doc.scrollHeight, 0) > finiteOr(doc.clientHeight, 0) + 1) {
      return { el: doc, scrollsWindow: true };
    }

    let best = null;
    let bestCoverage = 0.6;
    let bestHeight = 0;
    eachElement((el) => {
      if (el === doc || el === document.body) return;
      if (el.hasAttribute(ATTR_UI)) return;
      const scrollH = finiteOr(el.scrollHeight, 0);
      const clientH = finiteOr(el.clientHeight, 0);
      if (scrollH <= clientH + 32) return;
      const cs = window.getComputedStyle(el);
      const overflow = cs ? cs.overflowY : '';
      if (overflow !== 'auto' && overflow !== 'scroll' && overflow !== 'overlay') return;
      const r = el.getBoundingClientRect();
      if (!r) return;
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const coverage = (w * h) / (vw * vh);
      if (coverage < bestCoverage) return;
      if (coverage > bestCoverage || scrollH > bestHeight) {
        best = el;
        bestCoverage = coverage;
        bestHeight = scrollH;
      }
    });

    if (best) return { el: best, scrollsWindow: false };
    return { el: doc, scrollsWindow: true };
  }

  function injectFreeze() {
    removeFreeze();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute(ATTR_UI, 'freeze');
    style.textContent = FREEZE_CSS;
    const parent = document.head || document.documentElement || document.body;
    if (parent) parent.appendChild(style);
    state.styleEl = style;
  }

  function removeFreeze() {
    state.styleEl = null;
    // Query rather than trust the reference: this also collects the stylesheet
    // of a previous capture that was interrupted before its CS_RESTORE.
    let nodes;
    try {
      nodes = document.querySelectorAll('style[' + ATTR_UI + '="freeze"]');
    } catch (_) {
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      try {
        const node = nodes[i];
        if (node.parentNode) node.parentNode.removeChild(node);
      } catch (_) {
        /* already gone */
      }
    }
  }

  /**
   * One pass recording every fixed/sticky element and how it is anchored, so
   * each frame only has to toggle attributes instead of re-reading layout.
   * `html`, `body` and our own UI are never candidates — hiding any of them
   * would blank the capture.
   */
  /**
   * The selection overlay reports its rectangle in window-document space
   * (§6). When a nested element turns out to be the real scroller, the plan's
   * area lives in THAT element's content space instead, so an unconverted
   * rectangle would capture the wrong part of the page. Rebasing here keeps
   * the conversion in the one place that knows which scroller was picked.
   */
  function toScrollerSpace(rect) {
    const el = state.scroller;
    if (!el) return rect;
    let box;
    try {
      box = el.getBoundingClientRect();
    } catch (_) {
      return rect;
    }
    // document -> viewport -> scroller content
    const dx = finiteOr(window.scrollX, 0) + finiteOr(box.left, 0) - finiteOr(el.scrollLeft, 0);
    const dy = finiteOr(window.scrollY, 0) + finiteOr(box.top, 0) - finiteOr(el.scrollTop, 0);
    return { x: rect.x - dx, y: rect.y - dy, w: rect.w, h: rect.h };
  }

  function classifyFixed() {
    const vh = Math.max(1, finiteOr(window.innerHeight, 1));
    const found = [];
    eachElement((el) => {
      if (el === document.documentElement || el === document.body) return;
      if (el.hasAttribute(ATTR_UI)) return;
      const cs = window.getComputedStyle(el);
      if (!cs) return;
      const position = cs.position;
      if (position !== 'fixed' && position !== 'sticky') return;
      const r = el.getBoundingClientRect();
      if (!r || !(r.width >= 1) || !(r.height >= 1)) return;

      let kind = 'other';
      if (r.top <= 4) kind = 'topAnchored';
      else if (r.bottom >= vh - 4 && r.height < vh * 0.6) kind = 'bottomAnchored';

      found.push({ el: el, kind: kind, sticky: position === 'sticky' });
    });
    state.fixed = found;
  }

  /** ARCHITECTURE §5.3 step 4 — the policy table, applied per frame. */
  function applyHidePolicy(index, policy) {
    for (let i = 0; i < state.fixed.length; i++) {
      const entry = state.fixed[i];
      let hide = false;
      let makeStatic = false;

      if (policy === 'always') {
        hide = true;
      } else if (policy !== 'never') {
        // 'smart': a sticky header belongs on the first frame only; a cookie
        // bar or a chat bubble belongs nowhere.
        if (index === 0) hide = entry.kind !== 'topAnchored';
        else if (entry.sticky) makeStatic = true;
        else hide = true;
      }

      setFlag(entry.el, ATTR_HIDDEN, hide);
      setFlag(entry.el, ATTR_STATIC, makeStatic);
    }
  }

  /**
   * ARCHITECTURE §5.3 step 5. Skipped on short pages, where nothing is below
   * the fold anyway. Bounded by LAZY_MAX_STEPS so an infinite feed cannot turn
   * this into a minute-long scroll.
   */
  async function lazyPrePass() {
    const m = measure();
    if (m.fullHeight < m.viewportHeight * 1.5) return;

    eachElement((el) => {
      // tagName keeps its case in XHTML/XML documents.
      if (String(el.tagName || '').toUpperCase() !== 'IMG') return;
      if (el.getAttribute('loading') !== 'lazy') return;
      el.setAttribute(ATTR_LAZY, '');
      el.setAttribute('loading', 'eager');
    });

    const step = Math.max(1, m.viewportHeight * 0.85);
    const maxY = Math.max(0, m.fullHeight - m.viewportHeight);
    const origin = readScroll();
    for (let i = 1, y = step; y <= maxY && i <= LAZY_MAX_STEPS; i++, y += step) {
      writeScroll(origin.x, y);
      await FS.util.sleep(LAZY_STEP_MS);
    }
    writeScroll(origin.x, origin.y);
    await FS.util.sleep(LAZY_SETTLE_MS);
  }

  /** ARCHITECTURE §5.3 step 6 — max of every reported size, per spec. */
  function measure() {
    if (!state.scrollsWindow && state.scroller) {
      const el = state.scroller;
      const vw = Math.max(1, Math.round(finiteOr(el.clientWidth, 1)));
      const vh = Math.max(1, Math.round(finiteOr(el.clientHeight, 1)));
      return {
        viewportWidth: vw,
        viewportHeight: vh,
        scrollbarWidth: Math.max(0, Math.round(finiteOr(el.offsetWidth, vw) - vw)),
        scrollbarHeight: Math.max(0, Math.round(finiteOr(el.offsetHeight, vh) - vh)),
        fullWidth: Math.max(vw, Math.round(finiteOr(el.scrollWidth, vw))),
        fullHeight: Math.max(vh, Math.round(finiteOr(el.scrollHeight, vh)))
      };
    }

    const doc = document.documentElement;
    const body = document.body;
    const vw = Math.max(
      1,
      Math.round(finiteOr(doc && doc.clientWidth, finiteOr(window.innerWidth, 1)))
    );
    const vh = Math.max(
      1,
      Math.round(finiteOr(doc && doc.clientHeight, finiteOr(window.innerHeight, 1)))
    );

    let fullWidth = vw;
    let fullHeight = vh;
    const boxes = [doc, body];
    for (let i = 0; i < boxes.length; i++) {
      const el = boxes[i];
      if (!el) continue;
      fullWidth = Math.max(
        fullWidth,
        finiteOr(el.scrollWidth, 0),
        finiteOr(el.offsetWidth, 0),
        finiteOr(el.clientWidth, 0)
      );
      fullHeight = Math.max(
        fullHeight,
        finiteOr(el.scrollHeight, 0),
        finiteOr(el.offsetHeight, 0),
        finiteOr(el.clientHeight, 0)
      );
    }

    return {
      viewportWidth: vw,
      viewportHeight: vh,
      scrollbarWidth: Math.max(0, Math.round(finiteOr(window.innerWidth, vw) - vw)),
      scrollbarHeight: Math.max(0, Math.round(finiteOr(window.innerHeight, vh) - vh)),
      fullWidth: Math.round(fullWidth),
      fullHeight: Math.round(fullHeight)
    };
  }

  function clampArea(rect, fullWidth, fullHeight) {
    const x = clamp(Math.round(finiteOr(rect.x, 0)), 0, Math.max(0, fullWidth - 1));
    const y = clamp(Math.round(finiteOr(rect.y, 0)), 0, Math.max(0, fullHeight - 1));
    return {
      x: x,
      y: y,
      w: clamp(Math.round(finiteOr(rect.w, fullWidth)), 1, fullWidth - x),
      h: clamp(Math.round(finiteOr(rect.h, fullHeight)), 1, fullHeight - y)
    };
  }

  /** Row-major, top-to-bottom. Offsets are NOT clamped: CS_GOTO reports the
   *  real ones back and the engine places frames with those (§5.5). */
  function buildTiles(area, viewportWidth, viewportHeight) {
    const stepX = Math.max(1, Math.floor(viewportWidth));
    const stepY = Math.max(1, Math.floor(viewportHeight));
    const cols = Math.max(1, Math.ceil(area.w / stepX));
    const rows = Math.max(1, Math.ceil(area.h / stepY));
    const tiles = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (tiles.length >= MAX_TILES) return tiles;
        tiles.push({ x: Math.round(area.x + col * stepX), y: Math.round(area.y + row * stepY) });
      }
    }
    return tiles;
  }

  /**
   * Where, inside the captured frame, the scroller's content is painted — in
   * viewport CSS px. For window scrolling that is simply the top-left of the
   * viewport; for a nested scroller it is that element's client box, so the
   * app chrome around it (a sidebar, a toolbar) is cropped out instead of
   * being stitched into every tile.
   */
  function sourceRect(m) {
    const base = { x: 0, y: 0, w: m.viewportWidth, h: m.viewportHeight };
    if (state.scrollsWindow || !state.scroller) return base;
    try {
      const r = state.scroller.getBoundingClientRect();
      const el = state.scroller;
      // clientLeft/clientTop are the border widths: the client box starts inside them.
      return {
        x: finiteOr(r.left, 0) + finiteOr(el.clientLeft, 0),
        y: finiteOr(r.top, 0) + finiteOr(el.clientTop, 0),
        w: m.viewportWidth,
        h: m.viewportHeight
      };
    } catch (_) {
      return base;
    }
  }

  function buildPlan(mode, options) {
    const m = measure();
    const scroll = readScroll();

    let area;
    if (options.rect) {
      area = clampArea(options.rect, m.fullWidth, m.fullHeight);
    } else if (mode === FS.MODE.VISIBLE) {
      area = clampArea(
        { x: scroll.x, y: scroll.y, w: m.viewportWidth, h: m.viewportHeight },
        m.fullWidth,
        m.fullHeight
      );
    } else {
      area = { x: 0, y: 0, w: m.fullWidth, h: m.fullHeight };
    }

    return {
      fullWidth: m.fullWidth,
      fullHeight: m.fullHeight,
      viewportWidth: m.viewportWidth,
      viewportHeight: m.viewportHeight,
      scrollbarWidth: m.scrollbarWidth,
      scrollbarHeight: m.scrollbarHeight,
      devicePixelRatio: finiteOr(window.devicePixelRatio, 1),
      // The captured frame always covers the whole window, so the engine needs
      // the window's own size to derive the device scale, and the scroller's
      // visible box to know which part of that frame carries page content.
      windowWidth: Math.max(1, finiteOr(window.innerWidth, m.viewportWidth + m.scrollbarWidth)),
      windowHeight: Math.max(1, finiteOr(window.innerHeight, m.viewportHeight + m.scrollbarHeight)),
      sourceRect: sourceRect(m),
      area: area,
      tiles: buildTiles(area, m.viewportWidth, m.viewportHeight),
      scrollsWindow: state.scrollsWindow,
      // Page-controlled strings: passed through as data only, never as HTML,
      // and capped so a megabyte-long title cannot bloat the message.
      title: String(document.title || '').slice(0, 300),
      url: String(location.href || '').slice(0, 2048)
    };
  }

  function normalizeOptions(raw) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const hideFixed = validPolicy(o.hideFixed) || 'smart';
    let rect = null;
    if (o.rect && typeof o.rect === 'object') {
      const w = finiteOr(o.rect.w, 0);
      const h = finiteOr(o.rect.h, 0);
      if (w >= 1 && h >= 1) {
        rect = { x: finiteOr(o.rect.x, 0), y: finiteOr(o.rect.y, 0), w: w, h: h };
      }
    }
    return {
      hideFixed: hideFixed,
      preScrollForLazy: o.preScrollForLazy !== false,
      showHud: o.showHud !== false,
      rect: rect,
      settleMs: clamp(Math.round(finiteOr(o.settleMs, 0)), 0, 3000)
    };
  }

  function validPolicy(value) {
    return value === 'smart' || value === 'always' || value === 'never' ? value : null;
  }

  function settleFor(index) {
    const base = state.options && state.options.settleMs > 0 ? state.options.settleMs : AUTO_SETTLE_MS;
    return index === 0 ? Math.max(FIRST_SETTLE_MS, base) : base;
  }

  // -------------------------------------------------------- cancel via Esc

  function installEscape() {
    if (state.escapeHandler) return;
    const handler = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      try {
        const sent = chrome.runtime.sendMessage({ type: FS.MSG.BG_CANCEL });
        if (sent && typeof sent.catch === 'function') sent.catch(() => {});
      } catch (_) {
        /* extension context gone — the capture is dead anyway */
      }
    };
    window.addEventListener('keydown', handler, true);
    state.escapeHandler = handler;
  }

  function removeEscape() {
    if (!state.escapeHandler) return;
    window.removeEventListener('keydown', state.escapeHandler, true);
    state.escapeHandler = null;
  }

  // ------------------------------------------------------------------ HUD

  const HOST_CSS = [
    'all: initial !important',
    'position: fixed !important',
    'right: 0 !important',
    'bottom: 0 !important',
    'width: 0 !important',
    'height: 0 !important',
    'z-index: 2147483647 !important',
    'pointer-events: none !important',
    'display: block !important'
  ].join(';');

  const PANEL_CSS = [
    'position: fixed',
    'right: 16px',
    'bottom: 16px',
    'box-sizing: border-box',
    'min-width: 170px',
    'max-width: 320px',
    'padding: 10px 12px',
    'border-radius: 10px',
    'background: rgba(18, 19, 23, 0.92)',
    'color: #f4f5f7',
    'font: 500 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    'box-shadow: 0 8px 28px rgba(0, 0, 0, 0.38)',
    'pointer-events: none',
    'user-select: none'
  ].join(';');

  const TITLE_CSS = 'font-weight: 600;letter-spacing: .02em;opacity: .95';
  const LINE_CSS = 'display: flex;gap: 10px;justify-content: space-between;margin-top: 4px';
  const COUNT_CSS = 'font-variant-numeric: tabular-nums;opacity: .8';
  const HINT_CSS = 'margin-top: 6px;font-size: 11px;opacity: .65';
  const TOAST_CSS = [
    'position: fixed',
    'right: 16px',
    'bottom: 16px',
    'box-sizing: border-box',
    'max-width: 340px',
    'padding: 9px 12px',
    'border-radius: 10px',
    'background: rgba(18, 19, 23, 0.92)',
    'color: #f4f5f7',
    'font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    'box-shadow: 0 8px 28px rgba(0, 0, 0, 0.38)',
    'pointer-events: none',
    'user-select: none',
    'display: none'
  ].join(';');

  /**
   * The HUD lives in a CLOSED shadow root with inline styles only, so neither
   * page CSS nor page CSP can reach it, and page script cannot read it back.
   */
  function ensureUi() {
    if (state.ui && state.ui.host && state.ui.host.isConnected) return state.ui;
    const root = document.documentElement || document.body;
    if (!root) return null;

    const host = document.createElement('div');
    host.setAttribute(ATTR_UI, 'hud');
    host.style.cssText = HOST_CSS;
    const shadow = host.attachShadow({ mode: 'closed' });

    const panel = document.createElement('div');
    panel.style.cssText = PANEL_CSS;
    const title = document.createElement('div');
    title.style.cssText = TITLE_CSS;
    title.textContent = FS.util.t('hud_title');
    const line = document.createElement('div');
    line.style.cssText = LINE_CSS;
    const label = document.createElement('span');
    label.textContent = FS.util.t('progress_capturing');
    const count = document.createElement('span');
    count.style.cssText = COUNT_CSS;
    const hint = document.createElement('div');
    hint.style.cssText = HINT_CSS;
    hint.textContent = FS.util.t('hud_cancel_hint');
    line.appendChild(label);
    line.appendChild(count);
    panel.appendChild(title);
    panel.appendChild(line);
    panel.appendChild(hint);

    const toast = document.createElement('div');
    toast.style.cssText = TOAST_CSS;

    shadow.appendChild(panel);
    shadow.appendChild(toast);
    root.appendChild(host);

    state.ui = {
      host: host,
      panel: panel,
      label: label,
      count: count,
      toast: toast,
      toastTimer: 0,
      hudVisible: false
    };
    return state.ui;
  }

  function showHost(ui) {
    ui.host.style.setProperty('display', 'block', 'important');
  }

  /** Called before every CS_GOTO resolves: the HUD must never be captured. */
  function hideHud() {
    const ui = state.ui;
    if (!ui || !ui.host) return;
    try {
      ui.hudVisible = false;
      ui.host.style.setProperty('display', 'none', 'important');
    } catch (_) {
      /* nothing to do: the node is already gone */
    }
  }

  function removeUi() {
    const ui = state.ui;
    state.ui = null;
    if (ui && ui.toastTimer) clearTimeout(ui.toastTimer);
    let hosts;
    try {
      hosts = document.querySelectorAll('div[' + ATTR_UI + '="hud"]');
    } catch (_) {
      return;
    }
    for (let i = 0; i < hosts.length; i++) {
      try {
        const node = hosts[i];
        if (node.parentNode) node.parentNode.removeChild(node);
      } catch (_) {
        /* already detached */
      }
    }
  }

  function showProgress(msg) {
    if (state.options && state.options.showHud === false) return;
    const ui = ensureUi();
    if (!ui) return;
    const total = Math.max(0, Math.round(finiteOr(msg.total, 0)));
    const done = clamp(Math.round(finiteOr(msg.done, 0)), 0, total || Number.MAX_SAFE_INTEGER);
    // `label` may be an i18n key or an already-localized string: t() returns
    // the key unchanged when it is not a known message, so both work.
    ui.label.textContent = msg.label
      ? FS.util.t(String(msg.label))
      : FS.util.t('progress_capturing');
    ui.count.textContent = total > 0 ? done + ' / ' + total : '';
    ui.panel.style.display = 'block';
    ui.hudVisible = true;
    showHost(ui);
  }

  function showToast(msg) {
    const ui = ensureUi();
    if (!ui) return;
    ui.toast.textContent = FS.util.t(String((msg && msg.text) || ''));
    ui.toast.style.color = msg && msg.tone === 'error' ? '#ffb4ab' : '#f4f5f7';
    ui.toast.style.display = 'block';
    ui.panel.style.display = ui.hudVisible ? 'block' : 'none';
    // Never re-reveal our own UI inside the CS_GOTO → captureVisibleTab
    // window: while a capture runs, only CS_PROGRESS may show the host again.
    if (!state.active || ui.hudVisible) showHost(ui);
    if (ui.toastTimer) clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      try {
        ui.toast.style.display = 'none';
        // Nothing left to show and no capture running: leave no node behind.
        if (!state.active && !ui.hudVisible) removeUi();
      } catch (_) {
        /* the page tore our node out — removeUi already handled it */
      }
    }, TOAST_MS);
  }

  // ------------------------------------------------------------- handlers

  async function handlePrepare(msg) {
    // A previous capture may have died between PREPARE and RESTORE.
    restore();

    const options = normalizeOptions(msg && msg.options);
    state.options = options;

    const picked = pickScroller();
    state.scroller = picked.el;
    state.scrollsWindow = picked.scrollsWindow;
    state.snapshot = snapshotScroll();

    if (options.rect && !state.scrollsWindow) options.rect = toScrollerSpace(options.rect);

    injectFreeze();
    classifyFixed();
    if (options.preScrollForLazy) {
      await lazyPrePass();
      // Elements that only mount once the page has been scrolled — a
      // back-to-top button, a lazily created sticky bar — are invisible to a
      // classification made before the pre-pass, so redo it.
      classifyFixed();
    }

    installEscape();
    state.active = true;
    return buildPlan(msg && msg.mode, options);
  }

  async function handleGoto(msg) {
    const index = Math.max(0, Math.round(finiteOr(msg.index, 0)));
    const policy = validPolicy(msg.hideFixed) || (state.options ? state.options.hideFixed : 'smart');

    applyHidePolicy(index, policy);
    hideHud();
    writeScroll(finiteOr(msg.x, 0), finiteOr(msg.y, 0));

    await raf();
    await raf();
    const settle = settleFor(index);
    if (settle > 0) await FS.util.sleep(settle);

    const actual = readScroll();
    const m = measure();
    return {
      x: actual.x,
      y: actual.y,
      viewportWidth: m.viewportWidth,
      viewportHeight: m.viewportHeight
    };
  }

  /**
   * Undo everything, in the order that makes each step safe:
   * marks first (layout back to normal), then the scroll offsets while the
   * freeze stylesheet still guarantees an instant jump, then the stylesheet,
   * then our own UI. Every step is guarded — CS_RESTORE runs in the engine's
   * `finally` and must never throw, whatever the page has done meanwhile.
   */
  function restore() {
    try {
      removeEscape();
    } catch (_) {
      /* listener already gone */
    }
    try {
      clearMarks();
    } catch (_) {
      /* attributes already gone */
    }
    try {
      restoreScroll();
    } catch (_) {
      /* scroller detached */
    }
    try {
      removeFreeze();
    } catch (_) {
      /* stylesheet already removed */
    }
    try {
      removeUi();
    } catch (_) {
      /* HUD already removed */
    }

    state.active = false;
    state.options = null;
    state.fixed = [];
    state.snapshot = null;
    state.scroller = null;
    state.scrollsWindow = true;
  }

  function clearMarks() {
    state.fixed = [];
    let marked;
    try {
      marked = document.querySelectorAll(
        '[' + ATTR_HIDDEN + '],[' + ATTR_STATIC + '],[' + ATTR_LAZY + ']'
      );
    } catch (_) {
      return;
    }
    for (let i = 0; i < marked.length; i++) {
      const el = marked[i];
      try {
        if (el.hasAttribute(ATTR_LAZY)) {
          el.setAttribute('loading', 'lazy');
          el.removeAttribute(ATTR_LAZY);
        }
        el.removeAttribute(ATTR_HIDDEN);
        el.removeAttribute(ATTR_STATIC);
      } catch (_) {
        /* skip this node, keep cleaning the others */
      }
    }
  }

  function restoreScroll() {
    const snap = state.snapshot;
    if (!snap) return;
    if (!state.scrollsWindow && state.scroller) {
      try {
        state.scroller.scrollTo({ left: snap.x, top: snap.y, behavior: 'instant' });
      } catch (_) {
        state.scroller.scrollLeft = snap.x;
        state.scroller.scrollTop = snap.y;
      }
    }
    try {
      window.scrollTo({ left: snap.winX, top: snap.winY, behavior: 'instant' });
    } catch (_) {
      window.scrollTo(snap.winX, snap.winY);
    }
  }

  async function handleClipboardWrite(msg) {
    try {
      const blob = FS.util.dataUrlToBlob(String((msg && msg.dataUrl) || ''));
      const item = new ClipboardItem({ [blob.type]: blob });
      await navigator.clipboard.write([item]);
      return { ok: true };
    } catch (_) {
      // The tab may have lost focus; the engine falls back to the offscreen
      // document and then to the editor (§7).
      return { error: FS.ERR.CLIPBOARD };
    }
  }

  // ------------------------------------------------------------- dispatch

  const HANDLERS = {};
  HANDLERS[FS.MSG.CS_PING] = function () {
    return { ok: true, version: FS.VERSION };
  };
  HANDLERS[FS.MSG.CS_PREPARE] = handlePrepare;
  HANDLERS[FS.MSG.CS_GOTO] = handleGoto;
  HANDLERS[FS.MSG.CS_RESTORE] = function () {
    restore();
    return { ok: true };
  };
  HANDLERS[FS.MSG.CS_PROGRESS] = function (msg) {
    showProgress(msg || {});
    return { ok: true };
  };
  HANDLERS[FS.MSG.CS_TOAST] = function (msg) {
    showToast(msg || {});
    return { ok: true };
  };
  HANDLERS[FS.MSG.CS_CLIPBOARD_WRITE] = handleClipboardWrite;

  function reply(sendResponse, value) {
    try {
      sendResponse(value);
    } catch (_) {
      /* the engine gave up on us; nothing to report to */
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    const type = msg && msg.type;
    if (!type || !Object.prototype.hasOwnProperty.call(HANDLERS, type)) {
      return undefined; // not ours — leave the channel to select-overlay.js
    }
    Promise.resolve()
      .then(() => HANDLERS[type](msg))
      .then((value) => reply(sendResponse, value || { ok: true }))
      .catch((err) => reply(sendResponse, { error: String((err && err.message) || err) }));
    return true; // answered asynchronously
  });

  FS.pageDriver = {
    version: FS.VERSION,
    /** Exposed so any other injected file can force the page back to normal. */
    restore: restore
  };
})();
