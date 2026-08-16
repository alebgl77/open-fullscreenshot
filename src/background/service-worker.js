/**
 * Open FullScreenshot — service worker (entry point).
 *
 * Classic worker, not a module: every shared file is a plain script that
 * attaches to globalThis.FS, so the exact same source loads here, in the content
 * scripts and in the extension pages (ARCHITECTURE.md §3). importScripts()
 * resolves relative to this file's URL.
 *
 * Responsibilities: the four entry points (toolbar, commands, context menus, UI
 * messages), the single-capture guard, and the toolbar badge. All capture logic
 * lives in capture-engine.js.
 */
importScripts(
  '../shared/protocol.js',
  '../shared/util.js',
  '../shared/settings.js',
  './paced-capture.js',
  './offscreen-host.js',
  './capture-engine.js'
);

(function () {
  'use strict';

  const FS = globalThis.FS;

  const POPUP_PAGE = 'src/popup/popup.html';
  const PAGE_CONTEXTS = ['page', 'selection', 'image', 'link'];
  const ACTION_CONTEXTS = ['action'];
  /** Above this many tiles a percentage is more informative than a spinner. */
  const PERCENT_FROM_TILES = 4;

  const COLOR_BUSY = '#1f6feb';
  const COLOR_OK = '#1a7f37';
  const COLOR_ERROR = '#b42318';

  const MENU_ITEMS = [
    { id: 'fs-fullpage', key: 'menu_capture_fullpage', mode: FS.MODE.FULLPAGE, contexts: PAGE_CONTEXTS },
    { id: 'fs-visible', key: 'menu_capture_visible', mode: FS.MODE.VISIBLE, contexts: PAGE_CONTEXTS },
    { id: 'fs-select', key: 'menu_capture_select', mode: FS.MODE.SELECT, contexts: PAGE_CONTEXTS },
    { id: 'fs-action-fullpage', key: 'menu_capture_fullpage', mode: FS.MODE.FULLPAGE, contexts: ACTION_CONTEXTS },
    { id: 'fs-action-visible', key: 'menu_capture_visible', mode: FS.MODE.VISIBLE, contexts: ACTION_CONTEXTS },
    { id: 'fs-action-select', key: 'menu_capture_select', mode: FS.MODE.SELECT, contexts: ACTION_CONTEXTS },
    { id: 'fs-action-options', key: 'menu_options', mode: null, contexts: ACTION_CONTEXTS }
  ];

  /**
   * Keyboard commands -> { mode, after? }.
   *
   * `after` is a one-run override of settings.afterCapture (see mergeAfter);
   * a command without one behaves exactly as it always has.
   *
   * The copy-* pair ships with NO `suggested_key`, on purpose. Chrome honours
   * `suggested_key` for at most four commands per extension, and the manifest
   * already spends all four on _execute_action plus the three capture-*
   * commands. A fifth suggested binding would be accepted by the manifest and
   * then silently bind nothing, which is worse than no default: users assign
   * these two at chrome://extensions/shortcuts, and the README says so.
   */
  const COMMANDS = {
    'capture-fullpage': { mode: FS.MODE.FULLPAGE },
    'capture-visible': { mode: FS.MODE.VISIBLE },
    'capture-region': { mode: FS.MODE.SELECT },
    'copy-fullpage': { mode: FS.MODE.FULLPAGE, after: 'copy' },
    'copy-region': { mode: FS.MODE.SELECT, after: 'copy' }
  };

  /** In-flight capture. The engine refuses concurrency; this reports it nicely. */
  let activeCapture = null;

  function ignore(promise) {
    if (promise && typeof promise.catch === 'function') {
      promise.catch((error) => console.debug('Open FullScreenshot: ignored', error));
    }
  }

  // ----------------------------------------------------------------- badge --

  let badgeTimer = null;

  function setBadge(text, color) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
    ignore(chrome.action.setBadgeText({ text }));
    if (color) {
      ignore(chrome.action.setBadgeBackgroundColor({ color }));
      if (chrome.action.setBadgeTextColor) {
        ignore(chrome.action.setBadgeTextColor({ color: '#ffffff' }));
      }
    }
  }

  function autoClear(delay) {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      badgeTimer = null;
      ignore(chrome.action.setBadgeText({ text: '' }));
      ignore(chrome.action.setTitle({ title: FS.util.t('action_title') }));
    }, delay);
  }

  /**
   * Toolbar feedback for the whole capture lifecycle (ARCHITECTURE.md §7).
   * Defined here and consumed by capture-engine.js at call time.
   */
  FS.Badge = {
    progress(done, total) {
      const text = total > PERCENT_FROM_TILES
        ? `${Math.min(99, Math.round((done / total) * 100))}%`
        : '…';
      setBadge(text, COLOR_BUSY);
    },
    success() {
      setBadge('✓', COLOR_OK);
      autoClear(1500);
    },
    error(message) {
      setBadge('!', COLOR_ERROR);
      if (message) ignore(chrome.action.setTitle({ title: message }));
      autoClear(5000);
    },
    clear() {
      setBadge('', null);
      ignore(chrome.action.setTitle({ title: FS.util.t('action_title') }));
    }
  };

  // ------------------------------------------------------------- lifecycle --

  /**
   * The toolbar button either captures immediately or opens the mode chooser.
   * Chrome routes the click to the popup as soon as one is set, so `defaultAction`
   * is expressed purely through setPopup.
   */
  async function applyDefaultAction(settings) {
    const popup = settings.defaultAction === 'menu' ? POPUP_PAGE : '';
    try {
      await chrome.action.setPopup({ popup });
    } catch (error) {
      console.warn('Open FullScreenshot: setPopup failed', error);
    }
  }

  async function createMenus() {
    await chrome.contextMenus.removeAll();
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create(
        { id: item.id, title: FS.util.t(item.key), contexts: item.contexts },
        () => {
          const lastError = chrome.runtime.lastError;
          if (lastError) console.warn('Open FullScreenshot: menu', item.id, lastError.message);
        }
      );
    }
  }

  async function bootstrap() {
    const settings = await FS.Settings.get();
    await applyDefaultAction(settings);
  }

  chrome.runtime.onInstalled.addListener(() => {
    ignore(createMenus());
    ignore(bootstrap());
  });

  chrome.runtime.onStartup.addListener(() => {
    ignore(bootstrap());
  });

  FS.Settings.onChange((settings) => {
    ignore(applyDefaultAction(settings));
  });

  // --------------------------------------------------------------- capture --

  function normalizeMode(mode) {
    for (const key of Object.keys(FS.MODE)) {
      if (FS.MODE[key] === mode) return mode;
    }
    return FS.MODE.FULLPAGE;
  }

  /**
   * Apply a per-capture `afterCapture` on top of the stored settings.
   *
   * Validated against the single enum that already governs the setting
   * (FS.Settings.ENUMS.afterCapture) rather than a parallel list here, so the
   * two can never drift. Anything the enum does not contain — undefined, a
   * number, a stale value from an older build — is ignored and the user's own
   * preference stands; this never throws.
   *
   * The result is a COPY. Nothing is written back to storage: the override
   * lasts exactly one capture, which is the whole point of it.
   *
   * @param {Object} settings the sanitized stored settings
   * @param {*} after candidate override, from a command table or a UI message
   * @returns {Object} `settings` itself when there is nothing to override
   */
  function mergeAfter(settings, after) {
    const allowed = (FS.Settings.ENUMS && FS.Settings.ENUMS.afterCapture) || [];
    if (typeof after !== 'string' || !allowed.includes(after)) return settings;
    if (after === settings.afterCapture) return settings;
    return Object.assign({}, settings, { afterCapture: after });
  }

  async function resolveTab(hint) {
    if (hint && typeof hint === 'object' && typeof hint.id === 'number') return hint;
    if (typeof hint === 'number') {
      try {
        return await chrome.tabs.get(hint);
      } catch (error) {
        // Stale id from a UI page: fall back to whatever is in front now.
        console.debug('Open FullScreenshot: stale tab id', error);
      }
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  /**
   * Single entry point for every gesture. Only one capture runs at a time; a
   * second request is answered with a toast instead of a queue, because two
   * captures would fight over the same scroll position.
   * @param {string} mode FS.MODE value
   * @param {chrome.tabs.Tab|number|undefined} tabHint
   * @param {string} [after] one-run afterCapture override; see mergeAfter
   */
  async function startCapture(mode, tabHint, after) {
    if (activeCapture) {
      const busyTab = await resolveTab(tabHint);
      if (busyTab) ignore(FS.Engine.toast(busyTab.id, FS.util.t('progress_capturing'), 'info'));
      return;
    }

    let tab = null;
    const task = (async () => {
      const settings = mergeAfter(await FS.Settings.get(), after);
      tab = await resolveTab(tabHint);
      if (!tab || typeof tab.id !== 'number') throw FS.Engine.fail(FS.ERR.CAPTURE_FAILED);
      // tab.url is only populated once activeTab is granted; when it is missing
      // we let the injection failure classify the page instead of guessing.
      if (tab.url && FS.isRestrictedUrl(tab.url)) throw FS.Engine.fail(FS.ERR.RESTRICTED_URL);
      FS.Badge.progress(0, 1);
      return FS.Engine.run({ mode, tab, settings });
    })();

    activeCapture = task;
    try {
      await task;
    } catch (error) {
      await FS.Engine.reportFailure(tab, error);
    } finally {
      activeCapture = null;
    }
  }

  chrome.action.onClicked.addListener((tab) => {
    ignore(
      (async () => {
        const settings = await FS.Settings.get();
        // 'menu' means a popup is configured; onClicked then never fires, so
        // reaching here with it means setPopup has not landed yet.
        const action = settings.defaultAction === 'menu' ? FS.MODE.FULLPAGE : settings.defaultAction;
        await startCapture(normalizeMode(action), tab);
      })()
    );
  });

  chrome.commands.onCommand.addListener((command, tab) => {
    const entry = COMMANDS[command];
    if (!entry) return; // _execute_action is handled by the popup / onClicked
    ignore(startCapture(entry.mode, tab, entry.after));
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const item = MENU_ITEMS.find((entry) => entry.id === info.menuItemId);
    if (!item) return;
    if (!item.mode) {
      ignore(chrome.runtime.openOptionsPage());
      return;
    }
    ignore(startCapture(item.mode, tab));
  });

  // -------------------------------------------------------------- messages --

  /**
   * @returns {Promise<Object>|null} null when the message is not ours, so other
   * listeners (offscreen document, editor) keep their reply channel.
   */
  function route(message, sender) {
    switch (message.type) {
      // Payload: { mode, tabId?, after? }. `after` is optional and applies to
      // this capture only — an absent or unknown value keeps settings.afterCapture
      // exactly as stored, so an older caller sees no change in behaviour.
      case FS.MSG.UI_CAPTURE: {
        const hint = typeof message.tabId === 'number' ? message.tabId : sender && sender.tab;
        // Answer immediately: the popup closes itself so it must not await us.
        ignore(startCapture(normalizeMode(message.mode), hint, message.after));
        return Promise.resolve({ ok: true });
      }
      case FS.MSG.UI_GET_CAPTURE:
        return Promise.resolve(FS.Engine.getResult(message.id));
      case FS.MSG.UI_RELEASE_CAPTURE:
        FS.Engine.releaseResult(message.id);
        return Promise.resolve({ ok: true });
      case FS.MSG.UI_OPEN_OPTIONS:
        return chrome.runtime.openOptionsPage().then(() => ({ ok: true }));
      case FS.MSG.UI_DOWNLOAD:
        return chrome.downloads
          .download({
            url: message.url,
            filename: FS.util.sanitizeFilename(message.filename),
            saveAs: !!message.saveAs
          })
          .then((downloadId) => ({ ok: true, downloadId }));
      case FS.MSG.BG_CANCEL:
        return Promise.resolve({ ok: FS.Engine.cancel(message.id) });
      default:
        return null;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    if (message.target === FS.TARGET.OFFSCREEN) return false; // for the stitcher

    const task = route(message, sender);
    if (!task) return false;

    const answer = (payload) => {
      try {
        sendResponse(payload);
      } catch (error) {
        // The sender closed (popups do, on purpose) — nothing to deliver to.
        console.debug('Open FullScreenshot: reply dropped', error);
      }
    };
    task.then(
      (value) => answer(value === undefined ? null : value),
      (error) => {
        const info = FS.Engine.describe(error);
        answer({ error: info.code, message: info.message });
      }
    );
    return true;
  });
})();
