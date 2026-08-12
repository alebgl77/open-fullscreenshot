/**
 * FullShot — small helpers shared by every context.
 * Classic script — attaches to globalThis.FS. Load protocol.js first.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  if (FS.util) return;

  const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
  const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };

  /**
   * Characters Windows, macOS and Linux collectively refuse in a filename.
   * Spaces and hyphens are legal and are kept — the default template uses them.
   * Control codes are stripped separately, by code point, in sanitizeFilename.
   */
  const ILLEGAL = /[\\/:*?"<>|]/g;
  /** Windows reserved device names — a file called `CON.png` cannot be created. */
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  /** Drop C0/C1 control characters without relying on regex escapes. */
  function stripControls(text) {
    let out = '';
    for (const ch of text) {
      const code = ch.codePointAt(0);
      if (code < 32 || code === 127) out += ' ';
      else out += ch;
    }
    return out;
  }

  const util = {
    MIME,
    EXT,

    mimeFor(format) {
      return MIME[format] || MIME.png;
    },
    extFor(format) {
      return EXT[format] || EXT.png;
    },

    /** ms sleep. */
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    /**
     * Make an arbitrary string safe as a single filename segment.
     * Never returns an empty string and never returns a Windows device name.
     */
    sanitizeFilename(name, fallback = 'capture') {
      let out = stripControls(String(name == null ? '' : name))
        .replace(ILLEGAL, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        // A trailing dot or space makes the file unopenable on Windows.
        .replace(/[. ]+$/, '');
      if (RESERVED.test(out)) out = `_${out}`;
      if (!out) out = fallback;
      // Leave room for the extension and the " (1)" Chrome appends on collision.
      return out.slice(0, 120);
    },

    /**
     * Expand a filename template.
     * Supported tokens: {title} {host} {path} {date} {time} {datetime}
     *                   {width} {height} {mode} {timestamp}
     */
    applyTemplate(template, context) {
      const d = context.date instanceof Date ? context.date : new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const date = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      const time = `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;

      let host = '';
      let path = '';
      try {
        const u = new URL(context.url || '');
        host = u.hostname.replace(/^www\./, '');
        path = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\//g, '-');
      } catch (_) {
        /* about:blank, file://… — leave both empty */
      }

      const tokens = {
        title: context.title || 'capture',
        host: host || 'page',
        path: path || '',
        date,
        time,
        datetime: `${date} ${time}`,
        timestamp: String(d.getTime()),
        width: String(context.width || ''),
        height: String(context.height || ''),
        mode: context.mode || ''
      };

      const expanded = String(template || '{title}_{date}_{time}').replace(
        /\{(\w+)\}/g,
        (match, key) => (key in tokens ? tokens[key] : match)
      );

      // Collapse the separator runs left behind by empty tokens.
      const cleaned = expanded
        .replace(/[_\-\s]{2,}/g, (m) => m[0])
        .replace(/^[_\-\s]+|[_\-\s]+$/g, '');

      return util.sanitizeFilename(cleaned);
    },

    /** Human-readable byte count. */
    formatBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    },

    /** `1234` -> `1 234`, locale-neutral. */
    formatNumber(value) {
      return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    },

    /**
     * Decode a data: URL without fetch(). Works in a service worker.
     * @returns {Blob}
     */
    dataUrlToBlob(dataUrl) {
      const comma = dataUrl.indexOf(',');
      const header = dataUrl.slice(0, comma);
      const type = (header.match(/data:([^;,]+)/) || [, 'application/octet-stream'])[1];
      const body = dataUrl.slice(comma + 1);
      if (!/;base64/i.test(header)) {
        return new Blob([decodeURIComponent(body)], { type });
      }
      const binary = atob(body);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type });
    },

    /** Crypto-random id. */
    newId() {
      const bytes = new Uint8Array(8);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    },

    /**
     * Fit `{ width, height }` under a pixel-area budget and Chrome's per-side
     * canvas limit, preserving the aspect ratio.
     * @returns {{ width:number, height:number, scale:number, clamped:boolean }}
     */
    fitToBudget(width, height, maxPixels) {
      const limits = FS.CANVAS_LIMITS;
      const budget = Math.min(Number(maxPixels) || limits.MAX_AREA, limits.MAX_AREA);
      let scale = 1;

      if (width * height > budget) scale = Math.sqrt(budget / (width * height));
      if (width * scale > limits.MAX_SIDE) scale = Math.min(scale, limits.MAX_SIDE / width);
      if (height * scale > limits.MAX_SIDE) scale = Math.min(scale, limits.MAX_SIDE / height);

      return {
        width: Math.max(1, Math.floor(width * scale)),
        height: Math.max(1, Math.floor(height * scale)),
        scale,
        clamped: scale < 1
      };
    },

    /**
     * Localized string with a safe fallback, so a missing key shows the key
     * rather than an empty label.
     */
    t(key, substitutions) {
      try {
        const value = chrome.i18n.getMessage(key, substitutions);
        return value || key;
      } catch (_) {
        return key;
      }
    },

    /** Replace textContent of [data-i18n] nodes and attributes of [data-i18n-attr]. */
    localizeDocument(root = document) {
      root.querySelectorAll('[data-i18n]').forEach((node) => {
        node.textContent = util.t(node.getAttribute('data-i18n'));
      });
      root.querySelectorAll('[data-i18n-attr]').forEach((node) => {
        // Format: "title:key_one;aria-label:key_two"
        node
          .getAttribute('data-i18n-attr')
          .split(';')
          .forEach((pair) => {
            const [attr, key] = pair.split(':').map((s) => s && s.trim());
            if (attr && key) node.setAttribute(attr, util.t(key));
          });
      });
    }
  };

  FS.util = util;
})();
