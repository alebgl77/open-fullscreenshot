/**
 * The `chrome.*` surface the capture engine, the offscreen stitcher and the page
 * driver touch, stubbed for a plain web page.
 *
 * This string is evaluated inside the target page (an isolated world for the MCP
 * server, the main world for test/pipeline.mjs) BEFORE the eight engine sources.
 * It is deliberately shared by the harness and the product so the two cannot
 * drift: a stub that only the tests use proves nothing about the server.
 *
 * Two hooks the host is expected to wire up:
 *   - `__fsShot(id)`   a CDP Runtime binding; the host answers with
 *                      `__shotResolve(id, dataUrl)` carrying a real screenshot.
 *   - `globalThis.__settings`  the object FS.Settings.get() will sanitize.
 *
 * Zero dependencies, no interpolation — the literal must survive being pasted
 * into Runtime.evaluate verbatim.
 */

/** @type {string} JavaScript source, evaluated once per page. */
export const STUB = `
globalThis.__inbox = [];
globalThis.__created = [];
globalThis.__downloads = [];
globalThis.__badge = [];
globalThis.__shotSeq = 0;
globalThis.__shotWaiters = {};
globalThis.__shotCount = 0;

globalThis.__shotResolve = (id, dataUrl) => {
  const w = globalThis.__shotWaiters[id];
  if (w) { delete globalThis.__shotWaiters[id]; w(dataUrl); }
};

globalThis.__trace = [];
const dispatch = (message) => new Promise((resolve) => {
  let settled = false;
  const done = (r) => {
    if (settled) return;
    settled = true;
    const t = message && message.type;
    if (t === 'cs:prepare' || t === 'cs:goto') globalThis.__trace.push({ t, req: message, reply: r });
    resolve(r);
  };
  let async = false;
  for (const fn of globalThis.__inbox.slice()) {
    let ret;
    try { ret = fn(message, { id: 'test' }, done); } catch (e) { return done({ error: String(e) }); }
    if (ret === true) async = true;
  }
  if (!async) setTimeout(() => done(undefined), 30);
  setTimeout(() => done({ __timeout: true, type: message && message.type }), 60000);
});

globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getManifest: () => ({ version: '1.0.0', name: 'Open FullScreenshot' }),
    getURL: (p) => 'chrome-extension://test/' + p,
    onMessage: {
      addListener: (fn) => globalThis.__inbox.push(fn),
      removeListener: (fn) => { const i = globalThis.__inbox.indexOf(fn); if (i >= 0) globalThis.__inbox.splice(i, 1); }
    },
    sendMessage: (msg, cb) => {
      const p = dispatch(msg);
      if (typeof cb === 'function') { p.then(cb); return; }
      return p;
    }
  },
  tabs: {
    get: async (id) => ({ id, windowId: 1, url: location.href, title: document.title, index: 0 }),
    query: async () => [{ id: 1, windowId: 1, url: location.href, title: document.title, index: 0 }],
    create: async (opts) => { globalThis.__created.push(opts); return { id: 99, ...opts }; },
    sendMessage: (tabId, msg, cb) => {
      const p = dispatch(msg);
      if (typeof cb === 'function') { p.then(cb); return; }
      return p;
    },
    captureVisibleTab: (windowId, opts, cb) => {
      const id = ++globalThis.__shotSeq;
      globalThis.__shotCount++;
      const p = new Promise((resolve) => { globalThis.__shotWaiters[id] = resolve; __fsShot(String(id)); });
      if (typeof cb === 'function') { p.then(cb); return; }
      if (typeof opts === 'function') { p.then(opts); return; }
      return p;
    }
  },
  scripting: { executeScript: async () => [{ result: null }] },
  offscreen: {
    Reason: { BLOBS: 'BLOBS', CLIPBOARD: 'CLIPBOARD' },
    createDocument: async () => {},
    closeDocument: async () => {},
    hasDocument: async () => true
  },
  action: {
    setBadgeText: async (o) => { globalThis.__badge.push(o && o.text); },
    setBadgeBackgroundColor: async () => {},
    setPopup: async () => {},
    setTitle: async () => {}
  },
  downloads: {
    download: async (o) => { globalThis.__downloads.push(o); return 1; },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  },
  contextMenus: { removeAll: (cb) => cb && cb(), create: () => {}, onClicked: { addListener: () => {} } },
  commands: { onCommand: { addListener: () => {} }, getAll: async () => [] },
  i18n: { getMessage: (k) => k },
  storage: {
    local: {
      get: async () => ({ settings: globalThis.__settings || {} }),
      set: async () => {},
      remove: async () => {}
    },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  },
  windows: { get: async () => ({ id: 1 }), getCurrent: async () => ({ id: 1 }) }
};
`;

/**
 * The eight engine sources, in load order. protocol.js must come first (every
 * other file reads FS.MSG from it) and page-driver.js last (it registers the
 * content-script listener the engine talks to).
 * @type {string[]} repo-relative paths
 */
export const ENGINE_SOURCES = [
  'src/shared/protocol.js',
  'src/shared/util.js',
  'src/shared/settings.js',
  'src/background/paced-capture.js',
  'src/background/offscreen-host.js',
  'src/background/capture-engine.js',
  'src/offscreen/offscreen.js',
  'src/content/page-driver.js'
];
