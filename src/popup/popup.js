/**
 * FullShot — popup logic.
 *
 * Only ever shown when settings.defaultAction === 'menu' or from the
 * "More…" context menu item. Sends a capture request and closes itself
 * immediately: holding focus interferes with the capture that follows.
 *
 * Classic script — protocol.js, util.js and settings.js are loaded before
 * this file (see popup.html).
 */
(function () {
  'use strict';

  const FS = globalThis.FS;

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

  function sendCapture(mode) {
    chrome.runtime.sendMessage({ type: FS.MSG.UI_CAPTURE, mode });
    window.close();
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

    document.querySelectorAll('.fs-popup__btn[data-mode]').forEach((btn) => {
      btn.addEventListener('click', () => sendCapture(btn.getAttribute('data-mode')));
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
