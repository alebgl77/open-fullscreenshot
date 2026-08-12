/**
 * FullShot — capture engine (ARCHITECTURE.md §5, §7).
 *
 * Owns one capture from end to end: inject the content script, freeze and tile
 * the page, pace the frame grabs, stitch them in the offscreen document, encode
 * and dispatch the result. Two invariants drive the whole file:
 *
 *   1. The page is ALWAYS restored — success, error, cancel, thrown timeout.
 *   2. The blob URL produced by the offscreen document only dies once every
 *      consumer released it (or after a 90 s safety net), because the document
 *      that owns it must outlive them.
 *
 * Classic script — attaches to globalThis.FS. Load protocol.js, util.js,
 * paced-capture.js and offscreen-host.js first.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  if (FS.Engine) return;

  const CONTENT_FILES = ['src/shared/protocol.js', 'src/shared/util.js', 'src/content/page-driver.js'];
  const SELECT_FILES = ['src/content/select-overlay.js'];
  const EDITOR_PAGE = 'src/editor/editor.html';

  const PING_TIMEOUT_MS = 1500;
  /** Prepare runs the lazy-load pre-pass, which is legitimately slow. */
  const PREPARE_TIMEOUT_MS = 60000;
  const GOTO_TIMEOUT_MS = 15000;
  const SHORT_TIMEOUT_MS = 5000;
  const RESULT_TTL_MS = 90000;
  /** Above this, a data URL round-trip for the clipboard costs more than it wins. */
  const CLIPBOARD_INLINE_LIMIT = 32 * 1024 * 1024;
  const WHITE = '#ffffff';

  /** id -> { result, holds, timer }. See ARCHITECTURE.md §7. */
  const results = new Map();
  /** chrome.downloads id -> capture id, so onChanged can release the blob. */
  const downloads = new Map();

  let active = null;

  const NULL_BADGE = { progress() {}, success() {}, error() {}, clear() {} };
  /** FS.Badge is defined by service-worker.js after importScripts; resolve late. */
  function badge() {
    return FS.Badge || NULL_BADGE;
  }

  // ---------------------------------------------------------------- errors --

  /**
   * Build a typed failure. `code` is an FS.ERR value; `messageKey` overrides the
   * derived i18n key (used for the file:// special case, which shares a code
   * with restricted URLs but needs its own explanation).
   * @returns {Error}
   */
  function fail(code, messageKey) {
    const error = new Error(code);
    error.code = code;
    error.messageKey = messageKey || keyFor(code);
    return error;
  }

  function keyFor(code) {
    return 'err_' + String(code).replace(/-/g, '_');
  }

  function normalizeCode(error) {
    const raw = String((error && (error.code || error.message)) || '');
    for (const key of Object.keys(FS.ERR)) {
      if (FS.ERR[key] === raw) return FS.ERR[key];
    }
    return FS.ERR.CAPTURE_FAILED;
  }

  /**
   * Turn anything thrown inside the engine into a code plus a localized string.
   * @returns {{ code: string, message: string }}
   */
  function describe(error) {
    const code = normalizeCode(error);
    const key = (error && error.messageKey) || keyFor(code);
    return { code, message: FS.util.t(key) };
  }

  // -------------------------------------------------------------- plumbing --

  function checkCancel(state) {
    if (state.cancelled) throw fail(FS.ERR.CANCELLED);
  }

  function withTimeout(promise, ms, code) {
    if (!ms) return promise;
    let timer = null;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail(code || FS.ERR.CAPTURE_FAILED)), ms);
    });
    return Promise.race([
      promise.then(
        (value) => {
          clearTimeout(timer);
          return value;
        },
        (error) => {
          clearTimeout(timer);
          throw error;
        }
      ),
      guard
    ]);
  }

  /**
   * Message the top frame of a tab and apply the `{ error }` reply convention.
   * @returns {Promise<Object>}
   */
  async function tell(tabId, type, payload, timeoutMs, code) {
    const message = Object.assign({ type }, payload);
    const reply = await withTimeout(
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      timeoutMs,
      code
    );
    if (reply && reply.error) throw fail(normalizeCode({ message: reply.error }), reply.messageKey);
    return reply;
  }

  async function toast(tabId, text, tone) {
    if (typeof tabId !== 'number') return false;
    try {
      await tell(tabId, FS.MSG.CS_TOAST, { text, tone: tone || 'info' }, SHORT_TIMEOUT_MS);
      return true;
    } catch (error) {
      // Restricted page, or the tab navigated away: the badge already reported it.
      console.debug('FullShot: toast not delivered', error);
      return false;
    }
  }

  function broadcast(done, total, phase) {
    const message = { type: FS.MSG.UI_PROGRESS, done, total, phase };
    return chrome.runtime.sendMessage(message).catch((error) => {
      // Nothing is listening — normal when no extension page is open.
      console.debug('FullShot: no progress listener', error);
    });
  }

  async function reportProgress(tabId, done, total, phase, label) {
    badge().progress(done, total);
    await Promise.all([
      tell(tabId, FS.MSG.CS_PROGRESS, { done, total, label }, SHORT_TIMEOUT_MS).catch((error) => {
        console.debug('FullShot: HUD update skipped', error);
      }),
      broadcast(done, total, phase)
    ]);
  }

  // ------------------------------------------------------------- injection --

  function injectionError(error, tab) {
    const message = String((error && error.message) || error || '');
    const url = (tab && tab.url) || '';
    if (/^file:/i.test(url) || /file:\/\//i.test(message)) {
      return fail(FS.ERR.RESTRICTED_URL, 'err_file_urls');
    }
    if (/cannot access contents of|must request permission|extension manifest|cannot be scripted|chrome:\/\//i.test(message)) {
      return fail(FS.ERR.RESTRICTED_URL);
    }
    return fail(FS.ERR.NO_CONTENT_SCRIPT);
  }

  async function injectFiles(tab, files) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: false }, files });
    } catch (error) {
      throw injectionError(error, tab);
    }
  }

  /** Injection can succeed while the script is dead (CSP, torn-down frame). */
  async function ping(tabId) {
    try {
      const reply = await tell(tabId, FS.MSG.CS_PING, {}, PING_TIMEOUT_MS, FS.ERR.NO_CONTENT_SCRIPT);
      if (reply && reply.ok) return;
    } catch (error) {
      console.debug('FullShot: ping failed', error);
    }
    throw fail(FS.ERR.NO_CONTENT_SCRIPT);
  }

  // -------------------------------------------------------------- geometry --

  function numberOr(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
  }

  /**
   * Canvas size and output scale for a capture area. §5.5 / §5.7.
   * @returns {{ width:number, height:number, outScale:number, truncated:boolean }}
   */
  function planCanvas(area, scale, settings) {
    const base = settings.scaleMode === 'css' ? 1 / scale : 1;
    const width = Math.max(1, Math.round(area.w * scale * base));
    const height = Math.max(1, Math.round(area.h * scale * base));
    const fit = FS.util.fitToBudget(width, height, settings.maxPixels);
    return {
      width: fit.width,
      height: fit.height,
      outScale: base * fit.scale,
      truncated: fit.clamped
    };
  }

  /**
   * Source/destination rectangles for one frame, in device px. Returns null when
   * the frame contributes nothing (fully clipped by the area or the canvas).
   */
  function placeFrame(frame) {
    const { area, scale, outScale, canvasWidth, canvasHeight } = frame;
    // Content starts at the scroller's client box inside the frame — the origin
    // only differs from (0,0) when a nested element is the scroller.
    let sx = Math.round(numberOr(frame.srcX, 0) * scale);
    let sy = Math.round(numberOr(frame.srcY, 0) * scale);
    let sw = Math.round(frame.viewportWidth * scale);
    let sh = Math.round(frame.viewportHeight * scale);
    let offsetX = frame.ax - area.x;
    let offsetY = frame.ay - area.y;

    // The browser clamps scrolling at the document edge, so the last tile can
    // start *before* the area origin: drop the overlapping strip at the source.
    if (offsetX < 0) {
      const cut = Math.round(-offsetX * scale);
      sx += cut;
      sw -= cut;
      offsetX = 0;
    }
    if (offsetY < 0) {
      const cut = Math.round(-offsetY * scale);
      sy += cut;
      sh -= cut;
      offsetY = 0;
    }
    if (sw <= 0 || sh <= 0) return null;

    const dx = Math.round(offsetX * scale * outScale);
    const dy = Math.round(offsetY * scale * outScale);
    if (dx >= canvasWidth || dy >= canvasHeight) return null;

    let dw = Math.round(sw * outScale);
    let dh = Math.round(sh * outScale);
    if (dx + dw > canvasWidth) {
      const ratio = (canvasWidth - dx) / dw;
      dw = canvasWidth - dx;
      sw = Math.max(1, Math.round(sw * ratio));
    }
    if (dy + dh > canvasHeight) {
      const ratio = (canvasHeight - dy) / dh;
      dh = canvasHeight - dy;
      sh = Math.max(1, Math.round(sh * ratio));
    }
    if (dw <= 0 || dh <= 0) return null;

    return { sx, sy, sw, sh, dx, dy, dw, dh };
  }

  /**
   * Decode just enough of a frame to read its pixel size. A service worker has
   * no Image constructor, hence createImageBitmap on the decoded blob.
   */
  async function measureFrame(dataUrl) {
    const bitmap = await createImageBitmap(FS.util.dataUrlToBlob(dataUrl));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }

  // ---------------------------------------------------------------- passes --

  async function restorePage(tabId, page) {
    if (!page.prepared || page.restored) return;
    page.restored = true;
    try {
      await tell(tabId, FS.MSG.CS_RESTORE, {}, SHORT_TIMEOUT_MS);
    } catch (error) {
      // The tab may have navigated or died; nothing left to restore there.
      console.warn('FullShot: restore failed', error);
    }
  }

  /** VISIBLE mode: one frame, no freeze, no tiling. */
  async function captureVisible(state, tab, settings) {
    await reportProgress(tab.id, 0, 1, 'capturing', FS.util.t('progress_capturing'));
    const dataUrl = await FS.PacedCapture.capture(tab.windowId, { format: 'png' });
    checkCancel(state);

    const size = await measureFrame(dataUrl);
    // Without a PagePlan there is no viewport measurement, so `scaleMode` has no
    // reference to convert to: the captured frame is the image.
    const fit = FS.util.fitToBudget(size.width, size.height, settings.maxPixels);

    await FS.Offscreen.ensure();
    await FS.Offscreen.send(FS.MSG.OFF_INIT, {
      width: fit.width,
      height: fit.height,
      background: WHITE
    });
    await FS.Offscreen.send(FS.MSG.OFF_DRAW, {
      dataUrl,
      sx: 0,
      sy: 0,
      sw: size.width,
      sh: size.height,
      dx: 0,
      dy: 0,
      dw: fit.width,
      dh: fit.height
    });
    await reportProgress(tab.id, 1, 1, 'capturing', FS.util.t('progress_capturing'));

    const identity = await tabIdentity(tab);
    return {
      width: fit.width,
      height: fit.height,
      truncated: fit.clamped,
      title: identity.title,
      url: identity.url
    };
  }

  /** FULLPAGE / SELECT: freeze, tile, stitch. */
  async function captureTiled(state, tab, settings, mode, rect, page) {
    const options = {
      hideFixed: settings.hideFixed,
      preScrollForLazy: settings.preScrollForLazy,
      showHud: settings.showHud,
      rect: rect || null,
      settleMs: settings.settleMs
    };

    // Prepare mutates the page before it can fail, so arm the restore first.
    page.prepared = true;
    const plan = await tell(tab.id, FS.MSG.CS_PREPARE, { mode, options }, PREPARE_TIMEOUT_MS);
    if (!plan || !Array.isArray(plan.tiles) || !plan.tiles.length) throw fail(FS.ERR.CAPTURE_FAILED);
    checkCancel(state);

    const area = plan.area || { x: 0, y: 0, w: plan.fullWidth, h: plan.fullHeight };
    const total = plan.tiles.length;
    const label = FS.util.t('progress_capturing');
    let canvas = null;
    let scale = 1;

    for (let index = 0; index < total; index++) {
      checkCancel(state);
      const tile = plan.tiles[index];
      const at = await tell(
        tab.id,
        FS.MSG.CS_GOTO,
        { x: tile.x, y: tile.y, index, total, hideFixed: settings.hideFixed },
        GOTO_TIMEOUT_MS
      );
      checkCancel(state);

      const dataUrl = await FS.PacedCapture.capture(tab.windowId, { format: 'png' });
      checkCancel(state);

      if (!canvas) {
        // §5.1: the only trustworthy scale is the one the first frame reveals.
        const size = await measureFrame(dataUrl);
        // The frame spans the whole window, so the window's own CSS width is the
        // only correct denominator: with a nested scroller the plan's viewport
        // width describes the container, not the captured frame.
        const cssWidth = plan.windowWidth || plan.viewportWidth + (plan.scrollbarWidth || 0);
        scale = size.width / Math.max(1, cssWidth);
        if (!Number.isFinite(scale) || scale <= 0) scale = 1;
        canvas = planCanvas(area, scale, settings);

        await FS.Offscreen.ensure();
        await FS.Offscreen.send(FS.MSG.OFF_INIT, {
          width: canvas.width,
          height: canvas.height,
          background: WHITE
        });
      }

      const frame = placeFrame({
        ax: numberOr(at && at.x, tile.x),
        ay: numberOr(at && at.y, tile.y),
        viewportWidth: numberOr(at && at.viewportWidth, plan.viewportWidth),
        viewportHeight: numberOr(at && at.viewportHeight, plan.viewportHeight),
        srcX: plan.sourceRect ? plan.sourceRect.x : 0,
        srcY: plan.sourceRect ? plan.sourceRect.y : 0,
        area,
        scale,
        outScale: canvas.outScale,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height
      });
      if (frame) await FS.Offscreen.send(FS.MSG.OFF_DRAW, Object.assign({ dataUrl }, frame));

      await reportProgress(tab.id, index + 1, total, 'capturing', label);
    }

    return {
      width: canvas.width,
      height: canvas.height,
      truncated: canvas.truncated,
      title: plan.title || '',
      url: plan.url || ''
    };
  }

  /**
   * Page identity for VISIBLE mode. activeTab is granted by the gesture that
   * started the capture, so tabs.get is populated by then; fall back to whatever
   * the caller already had.
   */
  async function tabIdentity(tab) {
    try {
      const fresh = await chrome.tabs.get(tab.id);
      return { title: fresh.title || '', url: fresh.url || '' };
    } catch (error) {
      console.debug('FullShot: tabs.get unavailable', error);
      return { title: (tab && tab.title) || '', url: (tab && tab.url) || '' };
    }
  }

  // ------------------------------------------------------- result lifetime --

  function retain(result) {
    const entry = {
      result,
      holds: 0,
      timer: setTimeout(() => {
        console.warn('FullShot: capture result expired', result.id);
        drop(result.id);
      }, RESULT_TTL_MS)
    };
    results.set(result.id, entry);
    return entry;
  }

  function hold(id) {
    const entry = results.get(id);
    if (entry) entry.holds++;
  }

  function release(id) {
    const entry = results.get(id);
    if (!entry) return;
    entry.holds--;
    if (entry.holds <= 0) drop(id);
  }

  function drop(id) {
    const entry = results.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    results.delete(id);
    void maybeCloseOffscreen();
  }

  /** The offscreen document owns every blob URL, so it dies last. */
  async function maybeCloseOffscreen() {
    if (results.size || active) return;
    try {
      if (!(await FS.Offscreen.isOpen())) return;
      await FS.Offscreen.send(FS.MSG.OFF_RELEASE, {});
    } catch (error) {
      console.debug('FullShot: release skipped', error);
    }
    if (results.size || active) return;
    await FS.Offscreen.close();
  }

  chrome.downloads.onChanged.addListener((delta) => {
    const captureId = downloads.get(delta.id);
    if (!captureId) return;
    const state = delta.state && delta.state.current;
    if (state === 'complete' || state === 'interrupted' || delta.error) {
      downloads.delete(delta.id);
      release(captureId);
    }
  });

  // -------------------------------------------------------------- dispatch --

  /** Data URL of an already-encoded blob, without FileReader (service worker). */
  async function blobUrlToDataUrl(url, type) {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    const mime = type || response.headers.get('content-type') || 'image/png';
    return `data:${mime};base64,${btoa(binary)}`;
  }

  /**
   * Clipboard, in the only order that has a chance of working (§7): the captured
   * tab holds focus, the offscreen document usually does not.
   */
  async function copyToClipboard(tabId, result) {
    if (typeof tabId === 'number' && result.byteLength <= CLIPBOARD_INLINE_LIMIT) {
      try {
        const dataUrl = await blobUrlToDataUrl(result.url, result.type);
        const reply = await tell(tabId, FS.MSG.CS_CLIPBOARD_WRITE, { dataUrl }, SHORT_TIMEOUT_MS);
        if (reply && reply.ok) return true;
      } catch (error) {
        console.debug('FullShot: page clipboard refused', error);
      }
    }
    try {
      const reply = await FS.Offscreen.send(FS.MSG.OFF_CLIPBOARD, {});
      if (reply && reply.ok) return true;
    } catch (error) {
      console.debug('FullShot: offscreen clipboard refused', error);
    }
    return false;
  }

  async function startDownload(result, settings) {
    hold(result.id);
    try {
      const downloadId = await chrome.downloads.download({
        url: result.url,
        filename: result.filename,
        saveAs: !!settings.saveAs
      });
      if (typeof downloadId === 'number') {
        downloads.set(downloadId, result.id);
        return;
      }
      release(result.id);
    } catch (error) {
      release(result.id);
      throw error;
    }
  }

  async function openEditor(result, tab) {
    hold(result.id);
    try {
      const props = { url: chrome.runtime.getURL(`${EDITOR_PAGE}#${result.id}`), active: true };
      if (tab && typeof tab.index === 'number') props.index = tab.index + 1;
      if (tab && typeof tab.windowId === 'number') props.windowId = tab.windowId;
      await chrome.tabs.create(props);
    } catch (error) {
      release(result.id);
      throw error;
    }
  }

  async function dispatchResult(result, tab, settings) {
    const after = settings.afterCapture;
    const wantsCopy = after === 'copy' || after === 'download-copy';
    const wantsDownload = after === 'download' || after === 'download-copy';
    let copied = null;

    if (wantsCopy) {
      copied = await copyToClipboard(tab.id, result);
      if (!copied) result.notice = 'err_clipboard';
    }
    if (wantsDownload) await startDownload(result, settings);

    // Copy is the only mode with no artefact to fall back on when it fails.
    if (after === 'editor' || (after === 'copy' && copied === false)) {
      await openEditor(result, tab);
    }

    if (copied === true) await toast(tab.id, FS.util.t('toast_copied'), 'info');
    else if (copied === false) await toast(tab.id, FS.util.t('toast_copy_failed'), 'error');
    else if (wantsDownload) await toast(tab.id, FS.util.t('toast_saved'), 'info');
  }

  // ------------------------------------------------------------------ run ---

  /**
   * Run one capture. Rejects with a typed error (see describe()).
   * @param {{ mode: string, tab: chrome.tabs.Tab, settings: Object }} input
   * @returns {Promise<Object>} the CaptureResult
   */
  async function run(input) {
    const { mode, tab, settings } = input;
    if (active) throw fail(FS.ERR.CAPTURE_FAILED);

    const state = { id: FS.util.newId(), mode, tabId: tab.id, cancelled: false };
    const page = { prepared: false, restored: false };
    active = state;

    try {
      await injectFiles(tab, CONTENT_FILES);
      await ping(tab.id);
      checkCancel(state);

      let rect = null;
      if (mode === FS.MODE.SELECT) {
        await injectFiles(tab, SELECT_FILES);
        const selection = await tell(tab.id, FS.MSG.CS_SELECT, {}, 0);
        if (!selection || selection.cancelled) throw fail(FS.ERR.CANCELLED);
        rect = selection.rect;
        if (!rect || !(rect.w >= 4) || !(rect.h >= 4)) throw fail(FS.ERR.EMPTY_SELECTION);
        checkCancel(state);
      }

      const outcome =
        mode === FS.MODE.VISIBLE
          ? await captureVisible(state, tab, settings)
          : await captureTiled(state, tab, settings, mode, rect, page);
      checkCancel(state);

      await reportProgress(tab.id, 1, 1, 'encoding', FS.util.t('progress_encoding'));
      // Unfreeze before encoding: the page is no longer needed and the user gets
      // it back while Chrome compresses.
      await restorePage(tab.id, page);

      const exported = await FS.Offscreen.send(FS.MSG.OFF_EXPORT, {
        format: settings.format,
        quality: settings.quality,
        crop: null,
        maxPixels: settings.maxPixels
      });
      if (!exported || !exported.url) throw fail(FS.ERR.TOO_LARGE);

      const filename =
        FS.util.applyTemplate(settings.filenameTemplate, {
          title: outcome.title,
          url: outcome.url,
          width: exported.width,
          height: exported.height,
          mode
        }) +
        '.' +
        FS.util.extFor(settings.format);

      /** @type {Object} CaptureResult */
      const result = {
        id: state.id,
        url: exported.url,
        width: exported.width,
        height: exported.height,
        byteLength: exported.byteLength,
        type: exported.type,
        filename,
        pageTitle: outcome.title,
        pageUrl: outcome.url,
        createdAt: Date.now(),
        truncated: !!outcome.truncated
      };

      retain(result);
      hold(result.id);
      try {
        await dispatchResult(result, tab, settings);
      } finally {
        release(result.id);
      }

      badge().success();
      return result;
    } finally {
      active = null;
      await restorePage(tab.id, page);
      void maybeCloseOffscreen();
    }
  }

  FS.Engine = {
    run,

    /**
     * Flag the running capture as cancelled. Without an id, cancels whatever is
     * running (the content script's Escape handler has no id to send).
     * @returns {boolean} true when a capture was actually flagged
     */
    cancel(captureId) {
      if (!active) return false;
      if (captureId && active.id !== captureId) return false;
      active.cancelled = true;
      return true;
    },

    /** @returns {boolean} */
    isBusy() {
      return !!active;
    },

    /** @returns {Object|null} the CaptureResult for the editor. */
    getResult(id) {
      const entry = results.get(id);
      return entry ? entry.result : null;
    },

    /** A consumer is done with the blob URL. */
    releaseResult(id) {
      release(id);
    },

    /** Badge + on-page toast for a failed capture. @returns {Promise<Object>} */
    async reportFailure(tab, error) {
      const info = describe(error);
      const tabId = tab && tab.id;
      if (info.code === FS.ERR.CANCELLED) {
        badge().clear();
        await toast(tabId, FS.util.t('toast_cancelled'), 'info');
        return info;
      }
      console.warn('FullShot: capture failed', info.code, error);
      badge().error(info.message);
      await toast(tabId, info.message, 'error');
      return info;
    },

    fail,
    describe,
    toast
  };
})();
