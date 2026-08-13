/**
 * Open FullScreenshot — offscreen stitcher.
 *
 * The service worker has no DOM, so this hidden document owns the one canvas
 * every frame is drawn onto, the encoder, and the blob URLs handed back to the
 * editor or to chrome.downloads. Those URLs stay alive until OFF_RELEASE, which
 * is why the service worker keeps this document open until its consumers are
 * done (ARCHITECTURE.md §7).
 *
 * Classic script. Load protocol.js and util.js first.
 */
(function () {
  'use strict';

  const FS = globalThis.FS;
  const WHITE = '#ffffff';

  /** @type {HTMLCanvasElement|null} */
  let canvas = null;
  /** @type {CanvasRenderingContext2D|null} */
  let ctx = null;
  let background = WHITE;
  /** Every blob URL this document created, so none can leak. */
  const urls = new Set();

  function requireCanvas() {
    if (!canvas || !ctx) throw new Error(FS.ERR.CAPTURE_FAILED);
    return canvas;
  }

  function newContext(target) {
    // alpha:false + an explicit fill: JPEG has no alpha channel, so anything not
    // covered by a frame would otherwise encode as black.
    const context = target.getContext('2d', { alpha: false });
    if (!context) throw new Error(FS.ERR.TOO_LARGE);
    context.fillStyle = background;
    context.fillRect(0, 0, target.width, target.height);
    return context;
  }

  function toBlob(target, type, quality) {
    return new Promise((resolve, reject) => {
      const done = (blob) => (blob ? resolve(blob) : reject(new Error(FS.ERR.TOO_LARGE)));
      if (type === 'image/png') target.toBlob(done, type);
      else target.toBlob(done, type, quality);
    });
  }

  function init(message) {
    const width = Math.max(1, Math.round(Number(message.width) || 0));
    const height = Math.max(1, Math.round(Number(message.height) || 0));
    const limits = FS.CANVAS_LIMITS;
    if (width > limits.MAX_SIDE || height > limits.MAX_SIDE || width * height > limits.MAX_AREA) {
      throw new Error(FS.ERR.TOO_LARGE);
    }

    background = message.background || WHITE;
    if (!canvas) canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = newContext(canvas);
    // Blob URLs from a previous capture are deliberately NOT revoked here: their
    // consumer may still be reading them.
    return { ok: true, width, height };
  }

  async function draw(message) {
    requireCanvas();
    const bitmap = await createImageBitmap(FS.util.dataUrlToBlob(message.dataUrl));
    try {
      let { sx, sy, sw, sh, dx, dy, dw, dh } = message;
      // A frame can be a hair smaller than the engine predicted (window resized
      // mid-capture): clip source and destination together so nothing stretches.
      if (sx + sw > bitmap.width) {
        const ratio = Math.max(0, (bitmap.width - sx) / sw);
        sw = bitmap.width - sx;
        dw = Math.round(dw * ratio);
      }
      if (sy + sh > bitmap.height) {
        const ratio = Math.max(0, (bitmap.height - sy) / sh);
        sh = bitmap.height - sy;
        dh = Math.round(dh * ratio);
      }
      if (sw > 0 && sh > 0 && dw > 0 && dh > 0) {
        ctx.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
      }
    } finally {
      bitmap.close();
    }
    return { ok: true };
  }

  function cropRect(crop) {
    const source = requireCanvas();
    if (!crop) return { x: 0, y: 0, w: source.width, h: source.height };
    const x = Math.max(0, Math.min(source.width - 1, Math.round(crop.x || 0)));
    const y = Math.max(0, Math.min(source.height - 1, Math.round(crop.y || 0)));
    return {
      x,
      y,
      w: Math.max(1, Math.min(source.width - x, Math.round(crop.w || source.width))),
      h: Math.max(1, Math.min(source.height - y, Math.round(crop.h || source.height)))
    };
  }

  async function exportImage(message) {
    const source = requireCanvas();
    const format = FS.util.EXT[message.format] ? message.format : 'png';
    const type = FS.util.mimeFor(format);
    const area = cropRect(message.crop);
    const fit = FS.util.fitToBudget(area.w, area.h, message.maxPixels);

    let target = source;
    if (area.x || area.y || area.w !== source.width || area.h !== source.height || fit.clamped) {
      target = document.createElement('canvas');
      target.width = fit.width;
      target.height = fit.height;
      const context = newContext(target);
      context.drawImage(source, area.x, area.y, area.w, area.h, 0, 0, fit.width, fit.height);
    }

    const blob = await toBlob(target, type, message.quality);
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return {
      url,
      width: target.width,
      height: target.height,
      byteLength: blob.size,
      type: blob.type || type
    };
  }

  async function copyToClipboard() {
    const source = requireCanvas();
    // Only PNG survives the system clipboard as an image on every platform.
    const blob = await toBlob(source, 'image/png');
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (error) {
      // Typically "Document is not focused": the caller falls back to the page.
      console.warn('Open FullScreenshot offscreen: clipboard refused', error);
      throw new Error(FS.ERR.CLIPBOARD);
    }
    return { ok: true };
  }

  function release(message) {
    const keep = message && message.keepUrl;
    for (const url of Array.from(urls)) {
      if (url === keep) continue;
      URL.revokeObjectURL(url);
      urls.delete(url);
    }
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
      ctx = null;
    }
    return { ok: true };
  }

  function handle(message) {
    switch (message.type) {
      case FS.MSG.OFF_INIT:
        return Promise.resolve(init(message));
      case FS.MSG.OFF_DRAW:
        return draw(message);
      case FS.MSG.OFF_EXPORT:
        return exportImage(message);
      case FS.MSG.OFF_CLIPBOARD:
        return copyToClipboard();
      case FS.MSG.OFF_RELEASE:
        return Promise.resolve(release(message));
      default:
        return null;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== FS.TARGET.OFFSCREEN) return false;
    let task = null;
    try {
      task = handle(message);
    } catch (error) {
      sendResponse({ error: String((error && error.message) || error) });
      return true;
    }
    if (!task) return false;
    task.then(sendResponse, (error) => {
      console.warn('Open FullScreenshot offscreen:', message.type, error);
      sendResponse({ error: String((error && error.message) || error) });
    });
    return true;
  });
})();
