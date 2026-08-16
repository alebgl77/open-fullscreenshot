/**
 * Open FullScreenshot — popup logic.
 *
 * Only ever shown when settings.defaultAction === 'menu' or from the
 * "More…" context menu item. Sends a capture request and closes itself
 * immediately: holding focus interferes with the capture that follows.
 *
 * Shift+click on a capture button adds `after: 'copy'` to that one request,
 * which sends the image straight to the clipboard instead of opening the
 * editor. It is an override for that capture only — nothing is persisted, and
 * a plain click is byte-for-byte the message it has always been.
 *
 * Classic script — protocol.js, util.js and settings.js are loaded before
 * this file (see popup.html).
 */
(function () {
  'use strict';

  const FS = globalThis.FS;

  /**
   * Value sent as UI_CAPTURE's `after` for a Shift+click. It is a member of the
   * afterCapture enum in settings.js; the background validates it against that
   * same enum and ignores anything it does not recognize, so a typo here can
   * only ever fall back to the user's stored preference.
   */
  const AFTER_COPY = 'copy';

  /**
   * Live shortcuts, keyed by command name. Falls back to the manifest's
   * `suggested_key` when chrome.commands.getAll() reports no shortcut for a
   * command that does exist (e.g. the user cleared it in
   * chrome://extensions/shortcuts).
   */
  async function loadShortcuts() {
    const manifest = chrome.runtime.getManifest();
    const result = {};

    for (const [name, config] of Object.entries(manifest.commands || {})) {
      const key = config.suggested_key || {};
      result[name] = key.default || key.windows || key.mac || key.linux || key.chromeos || '';
    }

    const live = await new Promise((resolve) => {
      try {
        chrome.commands.getAll((commands) => resolve(commands || []));
      } catch (_) {
        resolve([]);
      }
    });

    for (const command of live) {
      if (command.shortcut) result[command.name] = command.shortcut;
    }

    return result;
  }

  function renderShortcuts(shortcuts) {
    document.querySelectorAll('[data-cmd]').forEach((el) => {
      const shortcut = shortcuts[el.getAttribute('data-cmd')];
      if (shortcut) {
        el.textContent = shortcut;
        el.classList.remove('fs-popup__shortcut--unset');
      } else {
        el.textContent = FS.util.t('popup_shortcut_not_set');
        el.classList.add('fs-popup__shortcut--unset');
      }
    });
  }

  /**
   * @param {string} mode FS.MODE value
   * @param {string} [after] one-run afterCapture override. Omitted entirely
   *   unless asked for, so a plain click sends the exact message it always did.
   */
  function sendCapture(mode, after) {
    const message = { type: FS.MSG.UI_CAPTURE, mode };
    if (after) message.after = after;
    chrome.runtime.sendMessage(message);
    window.close();
  }

  /**
   * Mirror the live Shift state onto the popup root, so the hint (and the
   * capture buttons' border) show what the next click will do. Keyboard
   * activation is covered too: Shift+Enter on a focused button fires a click
   * carrying shiftKey, and the same handler reads it.
   */
  function trackShift(root) {
    if (!root) return;
    const sync = (event) => root.classList.toggle('fs-popup--shift', !!event.shiftKey);
    document.addEventListener('keydown', sync);
    document.addEventListener('keyup', sync);
    // Releasing Shift while another window has focus never reaches us.
    window.addEventListener('blur', () => root.classList.remove('fs-popup--shift'));
  }

  function openOptions() {
    chrome.runtime.sendMessage({ type: FS.MSG.UI_OPEN_OPTIONS });
    window.close();
  }

  async function applyTheme() {
    try {
      const settings = await FS.Settings.get();
      if (settings.theme === 'light' || settings.theme === 'dark') {
        document.documentElement.setAttribute('data-theme', settings.theme);
      }
    } catch (_) {
      /* Storage unavailable — fall back to the OS theme via prefers-color-scheme. */
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    FS.util.localizeDocument();
    applyTheme();

    trackShift(document.querySelector('.fs-popup'));

    document.querySelectorAll('.fs-popup__btn[data-mode]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        // Shift is the one-gesture path to the clipboard: it overrides
        // afterCapture for this capture alone and stores nothing, so the next
        // capture behaves however the user configured it.
        sendCapture(btn.getAttribute('data-mode'), event.shiftKey ? AFTER_COPY : undefined);
      });
    });

    const optionsBtn = document.getElementById('fs-options-btn');
    if (optionsBtn) optionsBtn.addEventListener('click', openOptions);

    loadShortcuts()
      .then(renderShortcuts)
      .catch(() => {
        /* No shortcut info available — buttons stay usable, just unlabelled. */
      });
  });
})();
