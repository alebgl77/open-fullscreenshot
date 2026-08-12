/**
 * FullShot — result editor page.
 *
 * Classic script — runs after protocol.js, util.js, settings.js and (if
 * present) lib/pdf.js have attached themselves to window.FS. Bootstraps from
 * `editor.html#<captureId>`, fetches its own copy of the capture blob, then
 * is fully self-sufficient: the service worker can restart and this page
 * keeps working.
 *
 * Editing model: `state.sourceCanvas` holds the decoded image and is NEVER
 * mutated. `state.ops` is an ordered list of { type: 'crop'|'redact', rect }
 * operations, each rect expressed in the pixel space of the canvas as it
 * exists right before that operation is applied. `rebuild()` always starts
 * from a fresh copy of the source and replays `state.ops` in order to
 * produce `state.workingCanvas` — so Undo (pop the last op) and Reset (clear
 * the list) are both exact and trivial, and Redact rasterizes real opaque
 * pixels rather than an overlay that could be peeled off.
 */
(function () {
  'use strict';

  const FS = window.FS || {};

  // ---------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------

  const appEl = document.getElementById('app');
  const emptyStateEl = document.getElementById('empty-state');
  const emptyCloseBtn = document.getElementById('empty-close-btn');

  const filenameInput = document.getElementById('filename-input');
  const formatSelect = document.getElementById('format-select');
  const qualityGroup = document.getElementById('quality-group');
  const qualityInput = document.getElementById('quality-input');
  const qualityValue = document.getElementById('quality-value');
  const pdfGroup = document.getElementById('pdf-group');
  const pdfPageSizeSelect = document.getElementById('pdf-pagesize-select');

  const saveBtn = document.getElementById('save-btn');
  const saveAsBtn = document.getElementById('save-as-btn');
  const copyBtn = document.getElementById('copy-btn');
  const closeBtn = document.getElementById('close-btn');

  const cropBtn = document.getElementById('crop-btn');
  const redactBtn = document.getElementById('redact-btn');
  const undoBtn = document.getElementById('undo-btn');
  const resetBtn = document.getElementById('reset-btn');
  const zoomOutBtn = document.getElementById('zoom-out-btn');
  const zoomInBtn = document.getElementById('zoom-in-btn');
  const zoomFitBtn = document.getElementById('zoom-fit-btn');
  const zoomLevelEl = document.getElementById('zoom-level');

  const viewport = document.getElementById('viewport');
  const canvasWrap = document.getElementById('canvas-wrap');
  const stage = document.getElementById('stage');
  const selectionBox = document.getElementById('selection-box');
  const cropConfirm = document.getElementById('crop-confirm');
  const cropConfirmBtn = document.getElementById('crop-confirm-btn');
  const cropCancelBtn = document.getElementById('crop-cancel-btn');

  const statusDimensions = document.getElementById('status-dimensions');
  const statusSize = document.getElementById('status-size');
  const statusUrl = document.getElementById('status-url');
  const statusTruncated = document.getElementById('status-truncated');

  const toastEl = document.getElementById('toast');

  // ---------------------------------------------------------------------
  // Constants & state
  // ---------------------------------------------------------------------

  const MIN_ZOOM = 0.02;
  const MAX_ZOOM = 16;
  const ZOOM_STEP = 1.25;

  const state = {
    id: null,
    result: null,
    settings: null,
    blob: null,
    objectUrl: null,
    dragUrl: null,
    sourceCanvas: null,
    workingCanvas: null,
    ops: [],
    tool: 'none', // 'none' | 'crop' | 'redact'
    zoom: 1,
    panX: 0,
    panY: 0,
    format: 'png',
    quality: 0.92,
    pdfPageSize: 'fit',
    filenameBase: 'capture'
  };

  let pendingSelection = null; // { startX, startY } in canvas-px space, while dragging
  let pendingCrop = null; // finalized crop rect awaiting confirm
  let dragPanStart = null; // native-drag pan tracking
  let encodeTimer = null;
  let toastTimer = null;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function extForFormat(format) {
    return format === 'pdf' ? 'pdf' : FS.util.extFor(format);
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            reject(new Error(err.message));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas-encode-failed'));
      }, type, quality);
    });
  }

  function applyTheme(theme) {
    const html = document.documentElement;
    if (theme === 'light' || theme === 'dark') html.setAttribute('data-theme', theme);
    else html.removeAttribute('data-theme');
  }

  function showToast(text, tone) {
    clearTimeout(toastTimer);
    toastEl.textContent = text;
    toastEl.classList.toggle('toast-error', tone === 'error');
    toastEl.hidden = false;
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 2500);
  }

  function showEmptyState() {
    appEl.hidden = true;
    emptyStateEl.hidden = false;
  }

  // ---------------------------------------------------------------------
  // Editing model — source is immutable, working canvas is derived.
  // ---------------------------------------------------------------------

  function copyCanvas(source) {
    const c = document.createElement('canvas');
    c.width = source.width;
    c.height = source.height;
    c.getContext('2d').drawImage(source, 0, 0);
    return c;
  }

  function cropCanvas(source, rect) {
    const x = clamp(Math.round(rect.x), 0, source.width);
    const y = clamp(Math.round(rect.y), 0, source.height);
    const w = clamp(Math.round(rect.w), 1, source.width - x);
    const h = clamp(Math.round(rect.h), 1, source.height - y);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(source, x, y, w, h, 0, 0, w, h);
    return c;
  }

  function applyRedact(canvas, rect) {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  function pushOp(op) {
    state.ops.push(op);
    rebuild();
  }

  function rebuild() {
    let canvas = copyCanvas(state.sourceCanvas);
    for (const op of state.ops) {
      if (op.type === 'crop') canvas = cropCanvas(canvas, op.rect);
      else if (op.type === 'redact') applyRedact(canvas, op.rect);
    }
    state.workingCanvas = canvas;
    drawStage();
    updateDimensionsStatus();
    updateUndoResetButtons();
    refreshDragUrl();
    refreshEncodedSize();
  }

  function drawStage() {
    const c = state.workingCanvas;
    stage.width = c.width;
    stage.height = c.height;
    const ctx = stage.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(c, 0, 0);
    canvasWrap.style.width = c.width + 'px';
    canvasWrap.style.height = c.height + 'px';
  }

  function doUndo() {
    if (!state.ops.length) return;
    state.ops.pop();
    rebuild();
  }

  function doReset() {
    if (!state.ops.length) return;
    state.ops = [];
    rebuild();
    fitToView();
  }

  function updateUndoResetButtons() {
    const has = state.ops.length > 0;
    undoBtn.disabled = !has;
    resetBtn.disabled = !has;
  }

  // ---------------------------------------------------------------------
  // Zoom & pan
  // ---------------------------------------------------------------------

  function applyTransform() {
    canvasWrap.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    stage.classList.toggle('pixelated', state.zoom > 2);
    zoomLevelEl.textContent = Math.round(state.zoom * 100) + '%';
  }

  function zoomAt(px, py, nextZoomRaw) {
    const nextZoom = clamp(nextZoomRaw, MIN_ZOOM, MAX_ZOOM);
    const cx = (px - state.panX) / state.zoom;
    const cy = (py - state.panY) / state.zoom;
    state.panX = px - cx * nextZoom;
    state.panY = py - cy * nextZoom;
    state.zoom = nextZoom;
    applyTransform();
  }

  function zoomStep(factor) {
    const rect = viewport.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, state.zoom * factor);
  }

  function fitToView() {
    if (!state.workingCanvas) return;
    const rect = viewport.getBoundingClientRect();
    const cw = state.workingCanvas.width;
    const ch = state.workingCanvas.height;
    if (!cw || !ch || !rect.width || !rect.height) return;
    const scale = clamp(Math.min(rect.width / cw, rect.height / ch), MIN_ZOOM, MAX_ZOOM);
    state.zoom = scale;
    state.panX = (rect.width - cw * scale) / 2;
    state.panY = (rect.height - ch * scale) / 2;
    applyTransform();
  }

  function onWheel(e) {
    if (!state.workingCanvas) return;
    e.preventDefault();
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (e.ctrlKey || e.metaKey) {
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(mx, my, state.zoom * factor);
    } else {
      state.panX -= e.deltaX;
      state.panY -= e.deltaY;
      applyTransform();
    }
  }

  // ---------------------------------------------------------------------
  // Tools — crop & redact
  // ---------------------------------------------------------------------

  function setTool(tool) {
    state.tool = tool;
    cropBtn.setAttribute('aria-pressed', String(tool === 'crop'));
    redactBtn.setAttribute('aria-pressed', String(tool === 'redact'));
    viewport.dataset.tool = tool;
    stage.draggable = tool === 'none';
    hideSelection();
    hideCropConfirm();
  }

  function clientToCanvasPoint(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    const w = state.workingCanvas.width;
    const h = state.workingCanvas.height;
    const x = rect.width ? ((clientX - rect.left) / rect.width) * w : 0;
    const y = rect.height ? ((clientY - rect.top) / rect.height) * h : 0;
    return { x: clamp(x, 0, w), y: clamp(y, 0, h) };
  }

  function normalizeRect(x1, y1, x2, y2, maxW, maxH) {
    const x = clamp(Math.min(x1, x2), 0, maxW);
    const y = clamp(Math.min(y1, y2), 0, maxH);
    const w = clamp(Math.abs(x2 - x1), 0, maxW - x);
    const h = clamp(Math.abs(y2 - y1), 0, maxH - y);
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function showSelection(x, y, w, h, tool) {
    selectionBox.hidden = false;
    selectionBox.classList.toggle('crop', tool === 'crop');
    selectionBox.classList.toggle('redact', tool === 'redact');
    selectionBox.style.left = x + 'px';
    selectionBox.style.top = y + 'px';
    selectionBox.style.width = w + 'px';
    selectionBox.style.height = h + 'px';
  }

  function hideSelection() {
    selectionBox.hidden = true;
  }

  function showCropConfirm(rect) {
    pendingCrop = rect;
    const stageRect = stage.getBoundingClientRect();
    const vpRect = viewport.getBoundingClientRect();
    const scaleX = state.workingCanvas.width ? stageRect.width / state.workingCanvas.width : 1;
    const scaleY = state.workingCanvas.height ? stageRect.height / state.workingCanvas.height : 1;
    const left = stageRect.left - vpRect.left + rect.x * scaleX;
    const top = stageRect.top - vpRect.top + (rect.y + rect.h) * scaleY + 6;
    cropConfirm.style.left = clamp(left, 4, Math.max(4, vpRect.width - 60)) + 'px';
    cropConfirm.style.top = clamp(top, 4, Math.max(4, vpRect.height - 32)) + 'px';
    cropConfirm.hidden = false;
  }

  function hideCropConfirm() {
    cropConfirm.hidden = true;
    pendingCrop = null;
  }

  function onSelectionStart(e) {
    if (e.button !== 0) return;
    if (state.tool !== 'crop' && state.tool !== 'redact') return;
    if (!state.workingCanvas) return;
    const pt = clientToCanvasPoint(e.clientX, e.clientY);
    pendingSelection = { startX: pt.x, startY: pt.y };
    showSelection(pt.x, pt.y, 0, 0, state.tool);
    window.addEventListener('mousemove', onSelectionMove);
    window.addEventListener('mouseup', onSelectionEnd, { once: true });
  }

  function onSelectionMove(e) {
    if (!pendingSelection) return;
    const pt = clientToCanvasPoint(e.clientX, e.clientY);
    const rect = normalizeRect(
      pendingSelection.startX,
      pendingSelection.startY,
      pt.x,
      pt.y,
      state.workingCanvas.width,
      state.workingCanvas.height
    );
    showSelection(rect.x, rect.y, rect.w, rect.h, state.tool);
  }

  function onSelectionEnd(e) {
    window.removeEventListener('mousemove', onSelectionMove);
    if (!pendingSelection) return;
    const pt = clientToCanvasPoint(e.clientX, e.clientY);
    const rect = normalizeRect(
      pendingSelection.startX,
      pendingSelection.startY,
      pt.x,
      pt.y,
      state.workingCanvas.width,
      state.workingCanvas.height
    );
    pendingSelection = null;
    if (rect.w < 2 || rect.h < 2) {
      hideSelection();
      return;
    }
    if (state.tool === 'redact') {
      pushOp({ type: 'redact', rect });
      hideSelection();
    } else if (state.tool === 'crop') {
      showCropConfirm(rect);
    }
  }

  // ---------------------------------------------------------------------
  // Native drag — dragging the image both starts a desktop "drag-out" and
  // pans the canvas (draggable is toggled off while crop/redact is active,
  // see setTool, so tool drags never race the native drag gesture).
  // ---------------------------------------------------------------------

  function onDragStart(e) {
    const url = state.dragUrl || state.objectUrl;
    if (url) {
      const name = FS.util.sanitizeFilename(state.filenameBase || 'capture') + '.png';
      e.dataTransfer.setData('DownloadURL', `image/png:${name}:${url}`);
      e.dataTransfer.effectAllowed = 'copy';
    }
    dragPanStart = { x: e.clientX, y: e.clientY, panX: state.panX, panY: state.panY };
    viewport.classList.add('panning');
  }

  function onDrag(e) {
    if (!dragPanStart) return;
    // Chrome fires a final synthetic drag event at (0,0); ignore that jump.
    if (e.clientX === 0 && e.clientY === 0) return;
    state.panX = dragPanStart.panX + (e.clientX - dragPanStart.x);
    state.panY = dragPanStart.panY + (e.clientY - dragPanStart.y);
    applyTransform();
  }

  function onDragEnd() {
    dragPanStart = null;
    viewport.classList.remove('panning');
  }

  // ---------------------------------------------------------------------
  // Status bar
  // ---------------------------------------------------------------------

  function updateDimensionsStatus() {
    const c = state.workingCanvas;
    statusDimensions.textContent = FS.util.t('editor_dimensions', [String(c.width), String(c.height)]);
  }

  function refreshEncodedSize() {
    clearTimeout(encodeTimer);
    if (state.format === 'pdf') {
      statusSize.textContent = FS.util.t('editor_size', ['—']);
      return;
    }
    encodeTimer = setTimeout(() => {
      const mime = FS.util.mimeFor(state.format);
      const quality = state.format === 'jpeg' || state.format === 'webp' ? state.quality : undefined;
      canvasToBlob(state.workingCanvas, mime, quality)
        .then((blob) => {
          statusSize.textContent = FS.util.t('editor_size', [FS.util.formatBytes(blob.size)]);
        })
        .catch(() => {
          /* leave the previous value in place */
        });
    }, 250);
  }

  function refreshDragUrl() {
    state.workingCanvas.toBlob((blob) => {
      if (!blob) return;
      const previous = state.dragUrl;
      state.dragUrl = URL.createObjectURL(blob);
      if (previous) URL.revokeObjectURL(previous);
    }, 'image/png');
  }

  // ---------------------------------------------------------------------
  // Format / quality / PDF controls
  // ---------------------------------------------------------------------

  function updateFormatUi() {
    const isRaster = state.format === 'jpeg' || state.format === 'webp';
    qualityGroup.hidden = !isRaster;
    pdfGroup.hidden = state.format !== 'pdf';
    refreshEncodedSize();
  }

  function checkPdfAvailability() {
    const pdfOption = formatSelect.querySelector('option[value="pdf"]');
    if (!FS.pdf || typeof FS.pdf.fromImage !== 'function') {
      pdfOption.disabled = true;
      pdfOption.title = FS.util.t('editor_pdf_unavailable');
    }
  }

  // ---------------------------------------------------------------------
  // Save & copy
  // ---------------------------------------------------------------------

  function setSaving(saving) {
    saveBtn.disabled = saving;
    saveAsBtn.disabled = saving;
  }

  async function doSave(forceSaveAs) {
    if (!state.workingCanvas) return;
    setSaving(true);
    try {
      const format = state.format;
      let blob;
      if (format === 'pdf') {
        if (!FS.pdf || typeof FS.pdf.fromImage !== 'function') throw new Error('pdf-unavailable');
        const pngBlob = await canvasToBlob(state.workingCanvas, 'image/png');
        blob = await FS.pdf.fromImage(pngBlob, {
          width: state.workingCanvas.width,
          height: state.workingCanvas.height,
          pageSize: state.pdfPageSize,
          title: state.filenameBase
        });
      } else {
        const mime = FS.util.mimeFor(format);
        const quality = format === 'jpeg' || format === 'webp' ? state.quality : undefined;
        blob = await canvasToBlob(state.workingCanvas, mime, quality);
      }
      const filename = FS.util.sanitizeFilename(state.filenameBase) + '.' + extForFormat(format);
      const url = URL.createObjectURL(blob);
      const saveAs = forceSaveAs === true ? true : Boolean(state.settings && state.settings.saveAs);
      await sendMessage({ type: FS.MSG.UI_DOWNLOAD, url, filename, saveAs });
      URL.revokeObjectURL(url);
      showToast(FS.util.t('toast_saved'), 'info');
    } catch (err) {
      showToast(FS.util.t('editor_save_failed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function doCopy() {
    if (!state.workingCanvas) return;
    try {
      const blob = await canvasToBlob(state.workingCanvas, 'image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast(FS.util.t('toast_copied'), 'info');
    } catch (err) {
      showToast(FS.util.t('toast_copy_failed'), 'error');
    }
  }

  // ---------------------------------------------------------------------
  // Keyboard map
  // ---------------------------------------------------------------------

  function onKeyDown(e) {
    const typing = isTypingTarget(document.activeElement);

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      doSave(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      doCopy();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      doUndo();
      return;
    }
    if (e.key === 'Escape') {
      if (state.tool !== 'none') {
        setTool('none');
      } else {
        window.close();
      }
      return;
    }
    if (typing) return;
    if (e.key === '0') {
      e.preventDefault();
      fitToView();
      return;
    }
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomStep(ZOOM_STEP);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      zoomStep(1 / ZOOM_STEP);
    }
  }

  // ---------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------

  function bootstrapUiFromResult(result) {
    const base = result.filename ? result.filename.replace(/\.[a-z0-9]{1,5}$/i, '') : 'capture';
    state.filenameBase = base;
    filenameInput.value = base;
    statusUrl.textContent = result.pageUrl || '';
    statusUrl.title = result.pageUrl || '';
    statusTruncated.hidden = !result.truncated;
  }

  function loadImage() {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        state.sourceCanvas = c;
        resolve();
      };
      img.onerror = () => reject(new Error('image-decode-failed'));
      img.src = state.objectUrl;
    });
  }

  function bindStaticEvents() {
    filenameInput.addEventListener('input', () => {
      state.filenameBase = filenameInput.value;
    });

    formatSelect.addEventListener('change', () => {
      state.format = formatSelect.value;
      updateFormatUi();
    });
    qualityInput.addEventListener('input', () => {
      state.quality = Number(qualityInput.value) / 100;
      qualityValue.textContent = qualityInput.value + '%';
      refreshEncodedSize();
    });
    pdfPageSizeSelect.addEventListener('change', () => {
      state.pdfPageSize = pdfPageSizeSelect.value;
    });

    saveBtn.addEventListener('click', () => doSave(false));
    saveAsBtn.addEventListener('click', () => doSave(true));
    copyBtn.addEventListener('click', doCopy);
    closeBtn.addEventListener('click', () => window.close());
    emptyCloseBtn.addEventListener('click', () => window.close());

    cropBtn.addEventListener('click', () => setTool(state.tool === 'crop' ? 'none' : 'crop'));
    redactBtn.addEventListener('click', () => setTool(state.tool === 'redact' ? 'none' : 'redact'));
    undoBtn.addEventListener('click', doUndo);
    resetBtn.addEventListener('click', doReset);
    zoomOutBtn.addEventListener('click', () => zoomStep(1 / ZOOM_STEP));
    zoomInBtn.addEventListener('click', () => zoomStep(ZOOM_STEP));
    zoomFitBtn.addEventListener('click', fitToView);

    cropConfirmBtn.addEventListener('click', () => {
      if (!pendingCrop) return;
      pushOp({ type: 'crop', rect: pendingCrop });
      setTool('none');
      fitToView();
    });
    cropCancelBtn.addEventListener('click', () => setTool('none'));

    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('mousedown', onSelectionStart);
    stage.addEventListener('dragstart', onDragStart);
    stage.addEventListener('drag', onDrag);
    stage.addEventListener('dragend', onDragEnd);

    document.addEventListener('keydown', onKeyDown);

    window.addEventListener('pagehide', () => {
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
      if (state.dragUrl) URL.revokeObjectURL(state.dragUrl);
    });

    setTool('none');
  }

  async function init() {
    FS.util.localizeDocument();
    bindStaticEvents();

    let settings = FS.Settings && FS.Settings.DEFAULTS ? Object.assign({}, FS.Settings.DEFAULTS) : {};
    try {
      settings = await FS.Settings.get();
    } catch (err) {
      /* fall back to defaults captured above */
    }
    applyTheme(settings.theme);
    state.settings = settings;
    state.format = settings.format || 'png';
    state.quality = typeof settings.quality === 'number' ? settings.quality : 0.92;

    formatSelect.value = state.format;
    qualityInput.value = String(Math.round(state.quality * 100));
    qualityValue.textContent = qualityInput.value + '%';
    pdfPageSizeSelect.value = state.pdfPageSize;
    checkPdfAvailability();
    updateFormatUi();

    const id = decodeURIComponent(location.hash.slice(1));
    if (!id) {
      showEmptyState();
      return;
    }
    state.id = id;

    try {
      const result = await sendMessage({ type: FS.MSG.UI_GET_CAPTURE, id });
      if (!result || !result.url) throw new Error('missing-capture');
      state.result = result;

      const blobUrl = result.url; // always a blob: URL minted by the offscreen document
      const response = await fetch(blobUrl);
      const blob = await response.blob();
      state.blob = blob;
      state.objectUrl = URL.createObjectURL(blob);

      sendMessage({ type: FS.MSG.UI_RELEASE_CAPTURE, id }).catch((err) => {
        console.warn('FullShot: release-capture failed', err);
      });

      await loadImage();
      bootstrapUiFromResult(result);
      rebuild();
      fitToView();
    } catch (err) {
      console.warn('FullShot: editor bootstrap failed', err);
      showEmptyState();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
