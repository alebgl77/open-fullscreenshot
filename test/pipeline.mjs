/**
 * Open FullScreenshot full-pipeline harness — zero dependencies, Node 22+.
 *
 *   node test/pipeline.mjs [--headful] [--fixture=long-article]
 *
 * Runs the REAL capture engine — service-worker modules, offscreen stitcher and
 * page driver — inside one real page, with only the extension APIs stubbed.
 * `tabs.captureVisibleTab` is wired through a CDP binding to an actual
 * Page.captureScreenshot, so the frames being stitched are genuine screenshots
 * of the fixture at each scroll offset.
 *
 * The stitched PNG is written to test/out/ so it can be inspected by eye; the
 * assertions below cover geometry, band distinctness (a repeated frame means a
 * tiling bug) and the sticky-header policy.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADFUL = process.argv.includes('--headful');
const FIXTURE = (process.argv.find((a) => a.startsWith('--fixture=')) || '--fixture=long-article').split('=')[1];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
  return ok;
}

const SOURCES = [
  'src/shared/protocol.js',
  'src/shared/util.js',
  'src/shared/settings.js',
  'src/background/paced-capture.js',
  'src/background/offscreen-host.js',
  'src/background/capture-engine.js',
  'src/offscreen/offscreen.js',
  'src/content/page-driver.js'
];

/** Everything the engine, the stitcher and the driver touch on `chrome`. */
const STUB = `
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

async function main() {
  const fixturePath = path.join(ROOT, `test/fixtures/${FIXTURE}.html`);
  if (!existsSync(fixturePath)) {
    console.error(`fixture not found: ${fixturePath}`);
    process.exit(2);
  }

  const chrome = await launchChrome({ extensionDir: ROOT, headless: !HEADFUL, port: 9344 });
  try {
    console.log(`\n[pipeline] real engine + real screenshots on ${FIXTURE}.html`);
    const { sessionId } = await chrome.browser.openPage(pathToFileURL(fixturePath).href);
    const pageErrors = [];
    chrome.browser.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid === sessionId) pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
    });
    await sleep(900);

    // Route the stubbed captureVisibleTab to a genuine screenshot.
    await chrome.browser.send('Runtime.addBinding', { name: '__fsShot' }, sessionId);
    chrome.browser.on('Runtime.bindingCalled', async (p, sid) => {
      if (sid !== sessionId || p.name !== '__fsShot') return;
      try {
        const shot = await chrome.browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
        await chrome.browser.send(
          'Runtime.evaluate',
          { expression: `__shotResolve(${JSON.stringify(p.payload)}, "data:image/png;base64,${shot.data}")`, returnByValue: true },
          sessionId
        );
      } catch (err) {
        await chrome.browser.send(
          'Runtime.evaluate',
          { expression: `__shotResolve(${JSON.stringify(p.payload)}, null)`, returnByValue: true },
          sessionId
        );
      }
    });

    await chrome.browser.eval(sessionId, `globalThis.__settings = ${JSON.stringify({
      afterCapture: 'editor', showHud: false, preScrollForLazy: true,
      format: 'png', scaleMode: 'device', hideFixed: 'smart', settleMs: 0
    })}; true`, { awaitPromise: false });
    await chrome.browser.eval(sessionId, STUB, { awaitPromise: false });

    for (const rel of SOURCES) {
      const src = readFileSync(path.join(ROOT, rel), 'utf8');
      try {
        await chrome.browser.eval(sessionId, src, { awaitPromise: false });
      } catch (e) {
        check(`${rel} evaluates`, false, String(e));
        return finish(chrome);
      }
    }
    check('all engine modules load in one page', true, `${SOURCES.length} files`);

    const wired = await chrome.browser.eval(sessionId, `({
      engine: typeof FS.Engine?.run, pacer: typeof FS.PacedCapture?.capture,
      offscreen: typeof FS.Offscreen?.ensure, driver: !!FS.pageDriver, listeners: __inbox.length })`);
    check('engine, pacer, stitcher and driver are all present',
      wired.engine === 'function' && wired.pacer === 'function' && wired.offscreen === 'function' && wired.driver,
      JSON.stringify(wired));

    const started = Date.now();
    const run = await chrome.browser.eval(sessionId, `(async () => {
      try {
        const settings = await FS.Settings.get();
        const out = await FS.Engine.run({
          mode: FS.MODE.FULLPAGE,
          tab: { id: 1, windowId: 1, index: 0, url: location.href, title: document.title },
          settings
        });
        return { ok: true, out: out && { id: out.id, url: out.url, width: out.width, height: out.height,
                 byteLength: out.byteLength, type: out.type, filename: out.filename, truncated: out.truncated } };
      } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    })()`);

    if (!check('FS.Engine.run completes', run.ok === true, run.error || '')) return finish(chrome);
    console.log(`        (${((Date.now() - started) / 1000).toFixed(1)}s)`);

    // The engine may hand the result back directly or only through its result map.
    let result = run.out && run.out.url ? run.out : null;
    if (!result) {
      result = await chrome.browser.eval(sessionId, `(() => {
        const created = globalThis.__created[0];
        if (!created || !created.url) return null;
        const id = String(created.url).split('#')[1];
        const r = FS.Engine.getResult ? FS.Engine.getResult(id) : null;
        return r ? { id: r.id, url: r.url, width: r.width, height: r.height, byteLength: r.byteLength,
                     type: r.type, filename: r.filename, truncated: r.truncated } : null;
      })()`);
    }
    if (!check('a capture result is available', !!(result && result.url), JSON.stringify(result))) return finish(chrome);

    if (process.argv.includes('--trace')) {
      const trace = await chrome.browser.eval(sessionId, `globalThis.__trace.map(e => e.t === 'cs:prepare'
        ? { t: e.t, area: e.reply.area, full: [e.reply.fullWidth, e.reply.fullHeight],
            vp: [e.reply.viewportWidth, e.reply.viewportHeight], sb: [e.reply.scrollbarWidth, e.reply.scrollbarHeight],
            scrollsWindow: e.reply.scrollsWindow, tiles: e.reply.tiles }
        : { t: e.t, req: [e.req.x, e.req.y], got: [e.reply.x, e.reply.y, e.reply.viewportWidth, e.reply.viewportHeight] })`);
      console.log('  trace:', JSON.stringify(trace, null, 1).replace(/\n\s*/g, ' ').slice(0, 1800));
    }

    const shots = await chrome.browser.eval(sessionId, `globalThis.__shotCount`);
    const geometry = await chrome.browser.eval(sessionId, `(() => {
      const d = document.documentElement;
      return { fullHeight: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0),
               viewportHeight: d.clientHeight, viewportWidth: d.clientWidth, dpr: window.devicePixelRatio };
    })()`);

    // Ground truth is the plan the driver produced (e2e.mjs verifies the plan
    // itself against the DOM); here we check the stitcher honoured it.
    const plan = await chrome.browser.eval(sessionId, `(() => {
      const e = globalThis.__trace.find(e => e.t === 'cs:prepare');
      return e ? { area: e.reply.area, tiles: e.reply.tiles.length, scrollsWindow: e.reply.scrollsWindow,
                   viewportHeight: e.reply.viewportHeight } : null;
    })()`);
    if (!check('the driver produced a plan', !!plan)) return finish(chrome);

    const expectedW = Math.round(plan.area.w * geometry.dpr);
    const expectedH = Math.round(plan.area.h * geometry.dpr);
    check('stitched height matches the planned area', Math.abs(result.height - expectedH) <= 4,
      `got ${result.height}, expected ≈${expectedH} (area.h ${plan.area.h} × dpr ${geometry.dpr})`);
    check('stitched width matches the planned area', Math.abs(result.width - expectedW) <= 4,
      `got ${result.width}, expected ≈${expectedW} (area.w ${plan.area.w})`);
    check('one screenshot per tile', shots === plan.tiles, `screenshots=${shots} tiles=${plan.tiles}`);
    check('filename was templated and sanitized',
      typeof result.filename === 'string' && result.filename.endsWith('.png') && !/[\\/:*?"<>|]/.test(result.filename),
      result.filename);

    // Band analysis: decode the stitched PNG and fingerprint each viewport band.
    const bands = await chrome.browser.eval(sessionId, `(async () => {
      const blob = await (await fetch(${JSON.stringify(result.url)})).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const bandH = Math.round(${plan.viewportHeight} * ${geometry.dpr});
      const out = [];
      for (let top = 0; top < bmp.height; top += bandH) {
        const h = Math.min(bandH, bmp.height - top);
        const data = ctx.getImageData(0, top, bmp.width, h).data;
        let sum = 0, white = 0;
        for (let i = 0; i < data.length; i += 4 * 97) {
          const v = data[i] * 65536 + data[i + 1] * 256 + data[i + 2];
          sum = (sum * 31 + v) % 2147483647;
          if (data[i] > 245 && data[i+1] > 245 && data[i+2] > 245) white++;
        }
        out.push({ top, h, sig: sum, whiteRatio: white / Math.ceil(data.length / (4 * 97)) });
      }
      // Lowest row carrying ink: proves the final, browser-clamped tile was
      // placed at its ACTUAL offset instead of leaving a gap at the bottom.
      let lowestInk = -1;
      for (let y = bmp.height - 1; y >= 0 && lowestInk < 0; y -= 2) {
        const row = ctx.getImageData(0, y, bmp.width, 1).data;
        for (let i = 0; i < row.length; i += 4 * 13) {
          if (row[i] < 240 || row[i + 1] < 240 || row[i + 2] < 240) { lowestInk = y; break; }
        }
      }
      bmp.close();
      return { width: bmp.width, height: bmp.height, bands: out, lowestInk };
    })()`);

    const sigs = bands.bands.map((b) => b.sig);
    check('no two viewport bands are identical', new Set(sigs).size === sigs.length,
      `${sigs.length} bands, ${new Set(sigs).size} distinct`);
    // Trailing whitespace can be legitimate page padding; what must hold is that
    // the last tile contributed content, i.e. ink appears below the point where
    // the second-to-last tile stopped.
    const lastTileTop = bands.height - Math.round(plan.viewportHeight * geometry.dpr);
    check('the final clamped tile landed at its actual offset', bands.lowestInk > lastTileTop,
      `lowest ink at y=${bands.lowestInk}, last tile starts at y=${lastTileTop}`);

    // Save it so a human (and the reviewer) can look at the actual output.
    const outDir = path.join(ROOT, 'test/out');
    mkdirSync(outDir, { recursive: true });
    const b64 = await chrome.browser.eval(sessionId, `(async () => {
      const buf = await (await fetch(${JSON.stringify(result.url)})).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    })()`);
    const outFile = path.join(outDir, `${FIXTURE}.png`);
    writeFileSync(outFile, Buffer.from(b64, 'base64'));
    const png = readFileSync(outFile);
    const ihdrW = png.readUInt32BE(16);
    const ihdrH = png.readUInt32BE(20);
    check('output is a valid PNG with matching IHDR',
      png[0] === 0x89 && png[1] === 0x50 && ihdrW === result.width && ihdrH === result.height,
      `${ihdrW}×${ihdrH}, ${(png.length / 1024).toFixed(0)} KB -> ${path.relative(ROOT, outFile)}`);

    const after = await chrome.browser.eval(sessionId, `(() => ({
      y: window.scrollY,
      freeze: !!document.getElementById('ofs-freeze'),
      marks: document.querySelectorAll('[data-ofs-hidden],[data-ofs-static]').length,
      ui: document.querySelectorAll('[data-ofs-ui]').length,
      badge: globalThis.__badge.slice(-3) }))()`);
    check('page restored after the real run',
      after.y === 0 && !after.freeze && after.marks === 0 && after.ui === 0, JSON.stringify(after));
    check('no page exceptions during the run', pageErrors.length === 0, pageErrors.slice(0, 3).join('\n'));
  } finally {
    finish(chrome);
  }
}

function finish(chrome) {
  if (!process.argv.includes('--keep')) chrome.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` :: ${String(f.detail).split('\n')[0]}` : ''}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\nharness crashed:', err);
  process.exit(2);
});
