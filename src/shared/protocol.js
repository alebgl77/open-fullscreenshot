/**
 * FullShot — shared protocol contract.
 *
 * Loaded as a CLASSIC script in every context:
 *   - service worker   : importScripts('../shared/protocol.js')
 *   - content scripts  : chrome.scripting.executeScript({ files: ['src/shared/protocol.js', ...] })
 *   - extension pages  : <script src="../shared/protocol.js"></script>
 *
 * There is no build step and no ES module anywhere: every shared file attaches
 * itself to globalThis.FS so the exact same file works in all three worlds.
 *
 * IMPORTANT: this file is the interface between the background engine, the
 * content scripts, the offscreen stitcher and the UI pages. Changing a message
 * name or a payload shape here is a breaking change for all of them.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  if (FS.MSG) return; // already loaded in this world

  /** Extension-wide constants. */
  FS.VERSION = '1.0.0';

  /**
   * Capture modes.
   *  FULLPAGE — scroll & stitch the whole scrollable document.
   *  VISIBLE  — a single captureVisibleTab frame, no scrolling.
   *  SELECT   — on-page overlay: hover highlights an element (click captures it),
   *             drag draws a free rectangle. Both resolve to a document-space rect
   *             which is then captured through the same scroll & stitch engine.
   */
  FS.MODE = Object.freeze({
    FULLPAGE: 'fullpage',
    VISIBLE: 'visible',
    SELECT: 'select'
  });

  /** Message type registry. Every runtime message is `{ type, ...payload }`. */
  FS.MSG = Object.freeze({
    // ---- background  ->  content script (chrome.tabs.sendMessage) -------------
    /** Liveness probe. Reply: { ok: true, version } */
    CS_PING: 'cs:ping',
    /**
     * Freeze the page for capture and measure it.
     * Payload: { mode, options: PrepareOptions }
     * Reply: PagePlan (see below) or { error }
     */
    CS_PREPARE: 'cs:prepare',
    /**
     * Scroll to a tile and settle.
     * Payload: { x, y, index, total, hideFixed }
     * Reply: { x, y, viewportWidth, viewportHeight } — ACTUAL scroll offsets in
     * CSS px after clamping (the engine places the frame using these, never the
     * requested values).
     */
    CS_GOTO: 'cs:goto',
    /** Undo everything CS_PREPARE changed. Reply: { ok: true } */
    CS_RESTORE: 'cs:restore',
    /** Update the on-page progress HUD. Payload: { done, total, label } */
    CS_PROGRESS: 'cs:progress',
    /** Show a transient on-page toast. Payload: { text, tone: 'info'|'error' } */
    CS_TOAST: 'cs:toast',
    /**
     * Start the selection overlay.
     * Reply: { rect: DocRect, kind: 'element'|'region' } or { cancelled: true }
     */
    CS_SELECT: 'cs:select',
    /** Copy an image to the clipboard from the page world. Payload: { dataUrl } */
    CS_CLIPBOARD_WRITE: 'cs:clipboard-write',

    // ---- content script  ->  background (chrome.runtime.sendMessage) ---------
    /** User pressed Escape during capture. Payload: {} */
    BG_CANCEL: 'bg:cancel',

    // ---- background  ->  offscreen document ---------------------------------
    /** Payload: { width, height, background } — allocates the stitch canvas. */
    OFF_INIT: 'off:init',
    /**
     * Draw one frame.
     * Payload: { dataUrl, sx, sy, sw, sh, dx, dy, dw, dh } — all in DEVICE px.
     * Reply: { ok: true }
     */
    OFF_DRAW: 'off:draw',
    /**
     * Encode the canvas.
     * Payload: { format: 'png'|'jpeg'|'webp', quality, crop?: DevRect, maxPixels }
     * Reply: { url, width, height, byteLength, type } — `url` is a blob: URL
     * owned by the offscreen document (see ARCHITECTURE.md §7 for its lifetime).
     */
    OFF_EXPORT: 'off:export',
    /** Copy the current canvas to the clipboard. Reply: { ok } or { error } */
    OFF_CLIPBOARD: 'off:clipboard',
    /** Release the canvas and revoke blob URLs. Payload: { keepUrl? } */
    OFF_RELEASE: 'off:release',

    // ---- UI pages  ->  background -------------------------------------------
    /** Start a capture. Payload: { mode, tabId? } */
    UI_CAPTURE: 'ui:capture',
    /** Editor bootstrap. Payload: { id } Reply: CaptureResult */
    UI_GET_CAPTURE: 'ui:get-capture',
    /** Editor is done with the blob. Payload: { id } */
    UI_RELEASE_CAPTURE: 'ui:release-capture',
    /** Open the options page. */
    UI_OPEN_OPTIONS: 'ui:open-options',
    /** Save bytes through chrome.downloads. Payload: { url, filename, saveAs } */
    UI_DOWNLOAD: 'ui:download',

    // ---- background  ->  UI pages -------------------------------------------
    /** Progress broadcast for any listening UI. Payload: { done, total, phase } */
    UI_PROGRESS: 'ui:progress'
  });

  /** Routing tag so the offscreen document ignores messages meant for pages. */
  FS.TARGET = Object.freeze({ OFFSCREEN: 'offscreen', EDITOR: 'editor' });

  /** Error codes surfaced to the user with a localized message. */
  FS.ERR = Object.freeze({
    RESTRICTED_URL: 'restricted-url',
    NO_CONTENT_SCRIPT: 'no-content-script',
    CAPTURE_FAILED: 'capture-failed',
    QUOTA: 'quota',
    TOO_LARGE: 'too-large',
    CANCELLED: 'cancelled',
    CLIPBOARD: 'clipboard',
    EMPTY_SELECTION: 'empty-selection'
  });

  /**
   * URL schemes Chrome refuses to script or capture. Checked before anything
   * else so the user gets a clear explanation instead of a silent failure.
   */
  FS.RESTRICTED_PREFIXES = Object.freeze([
    'chrome://',
    'chrome-untrusted://',
    'devtools://',
    'edge://',
    'about:',
    'view-source:',
    'chrome-extension://'
  ]);

  /**
   * Web Store origins, which no extension may script or capture. Matched by
   * host + path prefix rather than by a full URL literal so that http/https,
   * a trailing slash and any sub-path are all covered.
   */
  FS.RESTRICTED_HOSTS = Object.freeze({
    'chromewebstore.google.com': '/',
    'chrome.google.com': '/webstore'
  });

  /** @returns {boolean} true when Chrome will not let us touch this URL. */
  FS.isRestrictedUrl = function isRestrictedUrl(url) {
    if (!url) return true;
    const u = String(url);
    if (FS.RESTRICTED_PREFIXES.some((p) => u.startsWith(p))) return true;
    try {
      const parsed = new URL(u);
      const blockedPath = FS.RESTRICTED_HOSTS[parsed.hostname];
      return blockedPath !== undefined && parsed.pathname.startsWith(blockedPath);
    } catch (_) {
      return false; // not parseable as an absolute URL — let injection decide
    }
  };

  /**
   * Chrome's hard ceiling on a single 2D canvas: 65 535 px per side and
   * ~268 435 456 px of area. We stay a hair under both.
   */
  FS.CANVAS_LIMITS = Object.freeze({
    MAX_SIDE: 65535,
    MAX_AREA: 268435456
  });

  /**
   * Typedefs (documentation only — this is plain JS on purpose).
   *
   * @typedef {Object} DocRect      Document space, CSS px, origin = top-left of the document.
   * @property {number} x @property {number} y @property {number} w @property {number} h
   *
   * @typedef {Object} DevRect      Stitched-image space, DEVICE px.
   * @property {number} x @property {number} y @property {number} w @property {number} h
   *
   * @typedef {Object} PrepareOptions
   * @property {'smart'|'always'|'never'} hideFixed
   * @property {boolean} preScrollForLazy   Pre-scroll the page once to trigger lazy images.
   * @property {boolean} showHud            Draw the on-page progress HUD.
   * @property {DocRect|null} rect          Restrict the capture to this document rect.
   * @property {number} settleMs            Extra wait after each scroll, ms.
   *
   * @typedef {Object} PagePlan
   * @property {number} fullWidth           Document width, CSS px.
   * @property {number} fullHeight          Document height, CSS px.
   * @property {number} viewportWidth       Usable viewport width (scrollbar excluded), CSS px.
   * @property {number} viewportHeight      Usable viewport height (scrollbar excluded), CSS px.
   * @property {number} scrollbarWidth      Vertical scrollbar width, CSS px.
   * @property {number} scrollbarHeight     Horizontal scrollbar height, CSS px.
   * @property {number} devicePixelRatio    Reported DPR (the engine still measures the real
   *                                        scale from the first captured frame).
   * @property {number} windowWidth         window.innerWidth. A captured frame always spans the
   *                                        whole window, so this — not viewportWidth — is the
   *                                        denominator for the device scale.
   * @property {number} windowHeight        window.innerHeight.
   * @property {DocRect} sourceRect         Where the scroller's content sits inside the frame,
   *                                        in viewport CSS px. {0,0,viewportWidth,viewportHeight}
   *                                        when the window scrolls; the container's client box
   *                                        when a nested element does, so surrounding app chrome
   *                                        is cropped out instead of stitched into every tile.
   * @property {DocRect} area               The document region to capture.
   * @property {{x:number,y:number}[]} tiles Scroll offsets, in capture order.
   * @property {boolean} scrollsWindow      false when a nested element is the scroller.
   * @property {string} title               document.title at capture time.
   * @property {string} url                 location.href at capture time.
   *
   * @typedef {Object} CaptureResult
   * @property {string} id
   * @property {string} url                 blob: URL of the encoded image.
   * @property {number} width @property {number} height
   * @property {number} byteLength
   * @property {string} type                MIME type.
   * @property {string} filename            Already templated and sanitized.
   * @property {string} pageTitle @property {string} pageUrl
   * @property {number} createdAt
   * @property {boolean} truncated          true when the page exceeded maxPixels.
   */
})();
