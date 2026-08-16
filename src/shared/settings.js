/**
 * Open FullScreenshot — settings store.
 *
 * Deliberately backed by chrome.storage.LOCAL, never `sync`: preferences stay
 * on this machine and are never uploaded to a Google account. The extension
 * makes zero network requests by design.
 *
 * Classic script — attaches to globalThis.FS. Load protocol.js first.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  if (FS.Settings) return;

  const DEFAULTS = Object.freeze({
    /** What the toolbar icon and Alt+Shift+P do. 'menu' opens the mode chooser. */
    defaultAction: 'fullpage', // 'fullpage' | 'visible' | 'select' | 'menu'
    /** What happens once the image exists. */
    afterCapture: 'editor', // 'editor' | 'download' | 'copy' | 'download-copy'
    /** Output encoding. */
    format: 'png', // 'png' | 'jpeg' | 'webp'
    quality: 0.92, // jpeg/webp only, 0.1 .. 1
    /** Save dialog instead of dropping straight into the Downloads folder. */
    saveAs: false,
    filenameTemplate: '{title}_{date}_{time}',
    /** Fixed/sticky element handling — see ARCHITECTURE.md §5.3. */
    hideFixed: 'smart', // 'smart' | 'always' | 'never'
    /** One fast pass down the page before capturing, to trigger lazy images. */
    preScrollForLazy: true,
    /** Extra settle time after each scroll step, ms. 0 = auto. */
    settleMs: 0,
    /** 'device' keeps the full HiDPI resolution, 'css' downsamples to 1x. */
    scaleMode: 'device', // 'device' | 'css'
    /**
     * Ceiling on the stitched image, in pixels of area.
     *
     * NOT Chrome's limit — that is FS.CANVAS_LIMITS (65 535 px per side,
     * 268 435 456 px of area) and it stays the hard maximum anyone can dial up
     * to in Options. This is the *default* budget, and it is deliberately well
     * under the canvas ceiling for two reasons. First, at 268 Mpx the area
     * ceiling was dead configuration: it only bites below MAX_SIDE for images
     * wider than 268 435 456 / 65 535 ≈ 4090 device px, so for anyone under
     * ~2048 CSS px at DPR 2 it never fired at all. Second, what it did allow is
     * more than the editor can hold — a 268 Mpx RGBA buffer is ~1.07 GB, and
     * the editor keeps three of them live (source, working, stage).
     *
     * At 100 Mpx the area ceiling is the binding constraint above ~1526 device
     * px of width, and a 1440 CSS-px viewport at DPR 2 gets 100e6 / 2880 ≈
     * 34 722 device px ≈ 17 361 CSS px of page height before anything is
     * downscaled — past the tail of real pages, comfortably inside the editor.
     */
    maxPixels: 100000000,
    /** On-page progress HUD with Escape-to-cancel. */
    showHud: true,
    /** UI chrome. */
    theme: 'system', // 'system' | 'light' | 'dark'
    locale: 'auto' // 'auto' | 'en' | 'fr'
  });

  /** Allowed values for the enum-ish keys. Anything else falls back to default. */
  const ENUMS = {
    defaultAction: ['fullpage', 'visible', 'select', 'menu'],
    afterCapture: ['editor', 'download', 'copy', 'download-copy'],
    format: ['png', 'jpeg', 'webp'],
    hideFixed: ['smart', 'always', 'never'],
    scaleMode: ['device', 'css'],
    theme: ['system', 'light', 'dark'],
    locale: ['auto', 'en', 'fr']
  };

  const KEY = 'settings';

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  /**
   * Never trust what came out of storage: a corrupted or hand-edited value must
   * not be able to steer the engine (e.g. a maxPixels of 1e12 would hang Chrome).
   */
  function sanitize(raw) {
    const out = Object.assign({}, DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;

    for (const key of Object.keys(DEFAULTS)) {
      if (!(key in raw)) continue;
      const value = raw[key];

      if (ENUMS[key]) {
        if (ENUMS[key].includes(value)) out[key] = value;
        continue;
      }
      switch (key) {
        case 'quality':
          out.quality = clampNumber(value, 0.1, 1, DEFAULTS.quality);
          break;
        case 'settleMs':
          out.settleMs = Math.round(clampNumber(value, 0, 3000, DEFAULTS.settleMs));
          break;
        case 'maxPixels':
          out.maxPixels = Math.round(
            clampNumber(value, 1e6, FS.CANVAS_LIMITS.MAX_AREA, DEFAULTS.maxPixels)
          );
          break;
        case 'filenameTemplate':
          out.filenameTemplate =
            typeof value === 'string' && value.trim() ? value.slice(0, 200) : DEFAULTS.filenameTemplate;
          break;
        default:
          if (typeof DEFAULTS[key] === 'boolean') out[key] = Boolean(value);
      }
    }
    return out;
  }

  let cache = null;

  const Settings = {
    DEFAULTS,
    ENUMS,

    /** @returns {Promise<typeof DEFAULTS>} */
    async get() {
      if (cache) return cache;
      const stored = await chrome.storage.local.get(KEY);
      cache = sanitize(stored && stored[KEY]);
      return cache;
    },

    /** Merge a patch into the stored settings. @returns {Promise<typeof DEFAULTS>} */
    async set(patch) {
      const current = await Settings.get();
      const next = sanitize(Object.assign({}, current, patch));
      cache = next;
      await chrome.storage.local.set({ [KEY]: next });
      return next;
    },

    /** Restore factory defaults. */
    async reset() {
      cache = Object.assign({}, DEFAULTS);
      await chrome.storage.local.set({ [KEY]: cache });
      return cache;
    },

    /** Subscribe to changes made from any context. @returns {() => void} unsubscribe */
    onChange(listener) {
      const handler = (changes, area) => {
        if (area !== 'local' || !changes[KEY]) return;
        cache = sanitize(changes[KEY].newValue);
        listener(cache);
      };
      chrome.storage.onChanged.addListener(handler);
      return () => chrome.storage.onChanged.removeListener(handler);
    },

    /** Drop the in-memory cache (tests). */
    invalidate() {
      cache = null;
    }
  };

  FS.Settings = Settings;
})();
