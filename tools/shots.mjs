#!/usr/bin/env node
/**
 * Open FullScreenshot — screenshots of the extension's own three pages.
 *
 *   node tools/shots.mjs [--theme=dark|light|both] [--headful] [--keep] [--plain]
 *
 * Writes docs/img/popup-<theme>.png, docs/img/options-<theme>.png and
 * docs/img/editor-<theme>.png. Nothing here is mocked up: each page is the real
 * file from src/, loaded in a real Chrome, with only the `chrome.*` surface
 * stubbed — the same trick test/e2e.mjs phase 3 uses to prove those pages boot.
 * The stub answers chrome.i18n from _locales/en/messages.json and
 * chrome.runtime.getManifest() from manifest.json, so every label and every
 * shortcut chip in the images is the string the product actually ships.
 *
 * The editor is the interesting one. Rather than hand it a placeholder, this
 * script first runs the REAL capture engine (the same eight sources
 * mcp/chrome-stub.mjs lists, wired to genuine Page.captureScreenshot frames,
 * exactly as test/pipeline.mjs does) against test/fixtures/long-article.html
 * served over loopback HTTP. The stitched PNG that comes out is then what the
 * editor page opens — so the dimensions, the byte count, the filename and the
 * source URL in the status bar are all measured, not written by hand.
 *
 * Zero dependencies. `ffmpeg`, if it is on PATH, is used at the end to bring
 * every PNG under the size budget; without it the images are still written,
 * just larger.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, sleep } from '../test/cdp.mjs';
import { STUB, ENGINE_SOURCES } from '../mcp/chrome-stub.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs/img');

const HEADFUL = process.argv.includes('--headful');
const KEEP = process.argv.includes('--keep');
/** Skip the redaction demonstrated in the editor shot. */
const PLAIN = process.argv.includes('--plain');
const THEME_ARG = (process.argv.find((a) => a.startsWith('--theme=')) || '--theme=both').split('=')[1];
const THEMES = THEME_ARG === 'both' ? ['dark', 'light'] : [THEME_ARG];
/** Photograph all five options sections instead of cutting at a section border. */
const OPTIONS_FULL = process.argv.includes('--options-full');
const OPTIONS_MAX = Number((process.argv.find((a) => a.startsWith('--options-max=')) || '--options-max=1100').split('=')[1]);

/** Fixed so two runs produce byte-comparable images, port collisions aside. */
const FIXTURE_PORT = 8713;
const FIXTURE_FILE = 'long-article.html';

/** A README image wider than this is wasted; heavier than this is rude. */
const MAX_WIDTH = 1600;
const MAX_BYTES = 300 * 1024;

/** Rendering scale. 2 keeps the type crisp once the PNG is scaled back down. */
const DSF = 2;

/* ---------------------------------------------------------------- helpers */

function log(...args) {
  console.log(...args);
}

/** Width and height straight out of a PNG's IHDR. */
function pngSize(file) {
  const buf = readFileSync(file);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}

function hasFfmpeg() {
  // No shell: the repository path may contain spaces, and a shell would split it.
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return probe.status === 0;
}

/**
 * Scale a PNG down until it fits the width and byte budget, re-encoding at
 * ffmpeg's slowest (smallest) PNG setting. Returns the final geometry.
 */
function optimise(file, ffmpegAvailable) {
  let info = pngSize(file);
  if (!ffmpegAvailable) return info;

  let width = Math.min(info.width, MAX_WIDTH);
  for (let attempt = 0; attempt < 6; attempt++) {
    const run = spawnSync(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', file, '-vf', `scale=${width}:-1:flags=lanczos`, '-compression_level', '100', file + '.tmp.png'],
      { stdio: 'inherit' }
    );
    if (run.status !== 0) return info;
    const next = pngSize(file + '.tmp.png');
    writeFileSync(file, readFileSync(file + '.tmp.png'));
    info = next;
    if (info.bytes <= MAX_BYTES) break;
    width = Math.round(width * 0.82);
    if (width < 640) break;
  }
  try {
    unlinkSync(file + '.tmp.png');
  } catch (_) {
    /* a leftover temp file is not worth failing the run over */
  }
  return info;
}

/** Static file server for test/fixtures, so the captured page has a real URL. */
function serveFixtures() {
  const root = path.join(ROOT, 'test/fixtures');
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript' };
  const server = createServer((req, res) => {
    const name = path.basename(decodeURIComponent((req.url || '/').split('?')[0]));
    const file = path.join(root, name);
    if (!name || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(FIXTURE_PORT, '127.0.0.1', () => {
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

/* ------------------------------------------------------- the capture pass */

/**
 * Run the real engine against the fixture and return the stitched PNG plus the
 * CaptureResult the editor would have been handed.
 * @returns {Promise<{ base64: string, result: object }>}
 */
async function runRealCapture(chrome, origin) {
  const url = `${origin}/${FIXTURE_FILE}`;
  log(`[capture] running the engine against ${url}`);
  const { targetId, sessionId } = await chrome.browser.openPage(url);
  await sleep(900);

  // captureVisibleTab in the stub calls this binding; answer with a real shot.
  await chrome.browser.send('Runtime.addBinding', { name: '__fsShot' }, sessionId);
  chrome.browser.on('Runtime.bindingCalled', async (p, sid) => {
    if (sid !== sessionId || p.name !== '__fsShot') return;
    let data = null;
    try {
      const shot = await chrome.browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
      data = `data:image/png;base64,${shot.data}`;
    } catch (_) {
      /* the engine handles a null frame; the assertions below will notice */
    }
    await chrome.browser.send(
      'Runtime.evaluate',
      { expression: `__shotResolve(${JSON.stringify(p.payload)}, ${data ? JSON.stringify(data) : 'null'})` },
      sessionId
    );
  });

  await chrome.browser.eval(
    sessionId,
    `globalThis.__settings = ${JSON.stringify({
      afterCapture: 'editor',
      showHud: false,
      preScrollForLazy: true,
      format: 'png',
      scaleMode: 'device',
      hideFixed: 'smart',
      settleMs: 0
    })}; true`,
    { awaitPromise: false }
  );
  await chrome.browser.eval(sessionId, STUB, { awaitPromise: false });
  for (const rel of ENGINE_SOURCES) {
    await chrome.browser.eval(sessionId, readFileSync(path.join(ROOT, rel), 'utf8'), { awaitPromise: false });
  }

  const run = await chrome.browser.eval(
    sessionId,
    `(async () => {
       try {
         const settings = await FS.Settings.get();
         const out = await FS.Engine.run({
           mode: FS.MODE.FULLPAGE,
           tab: { id: 1, windowId: 1, index: 0, url: location.href, title: document.title },
           settings
         });
         return { ok: true, out };
       } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
     })()`
  );
  if (!run.ok || !run.out || !run.out.url) throw new Error(`engine run failed: ${run.error || JSON.stringify(run.out)}`);

  const base64 = await chrome.browser.eval(
    sessionId,
    `(async () => {
       const buf = await (await fetch(${JSON.stringify(run.out.url)})).arrayBuffer();
       const bytes = new Uint8Array(buf);
       let s = '';
       for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
       return btoa(s);
     })()`
  );

  await chrome.browser.send('Target.closeTarget', { targetId }).catch(() => {});
  log(`[capture] ${run.out.width}x${run.out.height}, ${(run.out.byteLength / 1024).toFixed(0)} KB, ${run.out.filename}`);
  return { base64, result: run.out };
}

/* ------------------------------------------------------------- the UI stub */

/**
 * The `chrome.*` surface the three extension pages touch. Unlike the harness
 * stubs this one serves the REAL localized strings and the REAL manifest, so
 * what lands in the PNG is what a user sees.
 */
function uiStub({ messages, manifest, settings, capture }) {
  return `
globalThis.__messages = ${JSON.stringify(messages)};
globalThis.__manifest = ${JSON.stringify(manifest)};
globalThis.__settings = ${JSON.stringify(settings)};
globalThis.__capture = ${capture ? JSON.stringify(capture) : 'null'};

/** chrome.i18n.getMessage, including named placeholders and $1..$9. */
function __getMessage(key, subs) {
  const entry = globalThis.__messages[key];
  if (!entry) return '';
  let out = String(entry.message);
  const holders = entry.placeholders || {};
  out = out.replace(/\\$([A-Za-z0-9_]+)\\$/g, (m, name) => {
    const found = holders[name] || holders[name.toLowerCase()];
    return found ? String(found.content) : m;
  });
  if (subs != null) {
    const list = Array.isArray(subs) ? subs : [subs];
    out = out.replace(/\\$([1-9])/g, (m, d) => (list[Number(d) - 1] !== undefined ? String(list[Number(d) - 1]) : m));
  }
  return out;
}

globalThis.chrome = {
  runtime: {
    id: 'open-fullscreenshot',
    lastError: null,
    getManifest: () => globalThis.__manifest,
    getURL: (p) => p,
    openOptionsPage: () => {},
    onMessage: { addListener: () => {}, removeListener: () => {} },
    sendMessage: (message, cb) => {
      const MSG = (globalThis.FS && globalThis.FS.MSG) || {};
      let reply = null;
      if (message && message.type === MSG.UI_GET_CAPTURE) reply = globalThis.__capture;
      if (typeof cb === 'function') { setTimeout(() => cb(reply), 0); return; }
      return Promise.resolve(reply);
    }
  },
  i18n: { getMessage: __getMessage, getUILanguage: () => 'en' },
  commands: {
    getAll: (cb) => {
      const list = Object.entries(globalThis.__manifest.commands || {}).map(([name, config]) => ({
        name,
        description: '',
        shortcut: (config.suggested_key || {}).default || ''
      }));
      if (typeof cb === 'function') { cb(list); return; }
      return Promise.resolve(list);
    }
  },
  storage: {
    local: {
      get: (key, cb) => {
        const out = { settings: globalThis.__settings };
        if (typeof cb === 'function') { cb(out); return; }
        return Promise.resolve(out);
      },
      set: (patch, cb) => {
        if (patch && patch.settings) globalThis.__settings = patch.settings;
        if (typeof cb === 'function') { cb(); return; }
        return Promise.resolve();
      },
      remove: (k, cb) => (typeof cb === 'function' ? cb() : Promise.resolve())
    },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  },
  tabs: { create: () => Promise.resolve({}), getCurrent: () => Promise.resolve({ id: 1 }) }
};
`;
}

/* -------------------------------------------------------------- the shots */

/** Open a page with the stub installed and the theme media emulated. */
async function openStubbed(chrome, { url, stub, width, height, theme }) {
  const { targetId } = await chrome.browser.send('Target.createTarget', { url: 'about:blank' });
  const sessionId = await chrome.browser.attach(targetId);
  await chrome.browser.send('Runtime.enable', {}, sessionId);
  await chrome.browser.send('Page.enable', {}, sessionId);
  const errors = [];
  chrome.browser.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid === sessionId) errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });

  await chrome.browser.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: DSF, mobile: false },
    sessionId
  );
  // The pages declare `color-scheme: light dark`, so the OS preference is what
  // decides both the tokens and the native form controls. Emulating it is the
  // faithful way to photograph the default theme setting ("Match system").
  await chrome.browser.send(
    'Emulation.setEmulatedMedia',
    {
      features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: 'reduce' }
      ]
    },
    sessionId
  );
  await chrome.browser.send('Page.addScriptToEvaluateOnNewDocument', { source: stub }, sessionId);
  await chrome.browser.send('Page.navigate', { url }, sessionId);
  await sleep(1000);
  return { targetId, sessionId, errors };
}

async function shoot(chrome, sessionId, file) {
  const shot = await chrome.browser.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
}

/** Re-fit the emulated viewport to the page's own content height. */
async function fitViewportToContent(chrome, sessionId, width, max) {
  const height = await chrome.browser.eval(
    sessionId,
    `Math.ceil(document.body.getBoundingClientRect().height)`
  );
  const clamped = Math.min(Math.max(Math.ceil(height), 120), max);
  await chrome.browser.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height: clamped, deviceScaleFactor: DSF, mobile: false },
    sessionId
  );
  await sleep(400);
  return clamped;
}

async function shootPopup(chrome, stub, theme) {
  const url = pathToFileURL(path.join(ROOT, 'src/popup/popup.html')).href;
  const { targetId, sessionId, errors } = await openStubbed(chrome, { url, stub, width: 300, height: 900, theme });
  const height = await fitViewportToContent(chrome, sessionId, 300, 900);
  const file = path.join(OUT_DIR, `popup-${theme}.png`);
  await shoot(chrome, sessionId, file);
  await chrome.browser.send('Target.closeTarget', { targetId }).catch(() => {});
  return { file, css: `300x${height}`, errors };
}

/**
 * The options page is one long column — all five sections come to roughly 2500
 * CSS px, which is unreadable at README width. Unless --options-full is passed,
 * the shot is cut at the last fieldset border that fits OPTIONS_MAX, so the
 * image ends on a section edge instead of through the middle of a control.
 */
async function shootOptions(chrome, stub, theme) {
  const url = pathToFileURL(path.join(ROOT, 'src/options/options.html')).href;
  const width = 700;
  const { targetId, sessionId, errors } = await openStubbed(chrome, { url, stub, width, height: 2600, theme });

  const bounds = await chrome.browser.eval(
    sessionId,
    `({ body: Math.ceil(document.body.getBoundingClientRect().height),
        fieldsets: [...document.querySelectorAll('.fs-fieldset')].map(el => Math.ceil(el.getBoundingClientRect().bottom)) })`
  );
  // Sections sit 18 px apart and the next legend straddles its own top border,
  // so the cut lands just past the border of the last section that fits.
  const fitting = bounds.fieldsets.filter((bottom) => bottom + 10 <= OPTIONS_MAX);
  const height = OPTIONS_FULL || !fitting.length ? bounds.body : fitting[fitting.length - 1] + 10;

  await chrome.browser.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: DSF, mobile: false },
    sessionId
  );
  await sleep(400);
  const file = path.join(OUT_DIR, `options-${theme}.png`);
  await shoot(chrome, sessionId, file);
  await chrome.browser.send('Target.closeTarget', { targetId }).catch(() => {});
  return {
    file,
    css: `${width}x${height}`,
    errors,
    note: height < bounds.body ? `cut at a section border; the whole page is ${bounds.body} CSS px tall` : ''
  };
}

/**
 * The editor, holding the capture taken above. The zoom and the redaction are
 * performed by dispatching real input to the page — the product's own wheel
 * handler and its own selection code do the work.
 */
async function shootEditor(chrome, stub, theme) {
  const url = pathToFileURL(path.join(ROOT, 'src/editor/editor.html')).href + '#ofs-shot';
  // Wide enough that a capture taken in a 1280 px window fits at 100% with the
  // canvas edge showing on both sides, rather than bleeding off the frame.
  const width = 1300;
  const height = 780;
  const { targetId, sessionId, errors } = await openStubbed(chrome, { url, stub, width, height, theme });
  await sleep(900); // decode + first rebuild + fitToView

  const geom = () =>
    chrome.browser.eval(
      sessionId,
      `(() => {
         const v = document.getElementById('viewport').getBoundingClientRect();
         const s = document.getElementById('stage').getBoundingClientRect();
         return { vx: v.left, vy: v.top, vw: v.width, vh: v.height,
                  sx: s.left, sy: s.top, sw: s.width, sh: s.height,
                  zoom: document.getElementById('zoom-level').textContent };
       })()`
    );

  const wheel = (x, y, deltaX, deltaY, modifiers) =>
    chrome.browser.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: modifiers || 0, button: 'none', pointerType: 'mouse' },
      sessionId
    );

  // 1. Ctrl+wheel up to 100%. editor.js zooms by exp(-deltaY * 0.0015), so the
  //    delta needed is exact — but Chrome caps how much one wheel event carries,
  //    hence the loop. The anchor stays on the image's top-left corner while
  //    that corner is still on screen, so the capture's head stays in frame.
  const canvasWidth = await chrome.browser.eval(sessionId, `document.getElementById('stage').width`);
  let g = await geom();
  for (let step = 0; step < 20; step++) {
    g = await geom();
    const zoom = g.sw / canvasWidth;
    if (Math.abs(zoom - 1) < 0.004) break; // tight enough that the rail reads 100%
    const exact = -Math.log(1 / zoom) / 0.0015;
    const delta = Math.max(-300, Math.min(300, exact));
    const ax = Math.max(g.vx + 1, Math.min(g.vx + g.vw - 1, g.sx));
    const ay = Math.max(g.vy + 1, Math.min(g.vy + g.vh - 1, g.sy + 1));
    await wheel(ax, ay, 0, delta, 2 /* Ctrl */);
    await sleep(120);
  }

  // 2. Plain wheels to park the head of the captured page at the top of the
  //    frame, centred if it is narrower than the viewport. Wheel deltas are
  //    clamped the same way, so this loops too, until it is within a pixel.
  for (let step = 0; step < 20; step++) {
    g = await geom();
    const dx = g.sx - g.vx - Math.max(0, (g.vw - g.sw) / 2);
    const dy = g.sy - g.vy;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
    await wheel(
      g.vx + g.vw / 2,
      g.vy + g.vh / 2,
      Math.max(-400, Math.min(400, dx)),
      Math.max(-400, Math.min(400, dy))
    );
    await sleep(120);
  }

  // 3. Redact a paragraph, using the redact tool exactly as a user would. The
  //    rectangle is expressed against the canvas, not the window, so it lands on
  //    the same words whatever the pan ended up being.
  if (!PLAIN) {
    const btn = await chrome.browser.eval(
      sessionId,
      `(() => { const r = document.getElementById('redact-btn').getBoundingClientRect();
                return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    for (const type of ['mousePressed', 'mouseReleased']) {
      await chrome.browser.send(
        'Input.dispatchMouseEvent',
        { type, x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 },
        sessionId
      );
    }
    await sleep(200);

    g = await geom();
    // The fixture's standfirst paragraph, in the capture's own pixel space.
    const from = { x: g.sx + 262, y: g.sy + 214 };
    const to = { x: g.sx + 975, y: g.sy + 276 };
    await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 }, sessionId);
    await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 }, sessionId);
    await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, button: 'left', buttons: 1 }, sessionId);
    await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1 }, sessionId);
    await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 }, sessionId);
    await sleep(700);
    // Park the pointer off the canvas so no hover state is photographed.
    await chrome.browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, buttons: 0 }, sessionId);
    await sleep(200);
  }

  const state = await chrome.browser.eval(
    sessionId,
    `(() => ({ zoom: document.getElementById('zoom-level').textContent,
               undo: !document.getElementById('undo-btn').disabled,
               dims: document.getElementById('status-dimensions').textContent,
               size: document.getElementById('status-size').textContent,
               url: document.getElementById('status-url').textContent,
               toast: !document.getElementById('toast').hidden,
               empty: !document.getElementById('empty-state').hidden }))()`
  );

  const file = path.join(OUT_DIR, `editor-${theme}.png`);
  await shoot(chrome, sessionId, file);
  await chrome.browser.send('Target.closeTarget', { targetId }).catch(() => {});
  return { file, css: `${width}x${height}`, errors, state };
}

/* ---------------------------------------------------------------- driver */

async function main() {
  const messages = JSON.parse(readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  const fixtures = await serveFixtures();
  const chrome = await launchChrome({ extensionDir: ROOT, headless: !HEADFUL, port: 9366 });
  const produced = [];
  const problems = [];

  try {
    const { base64, result } = await runRealCapture(chrome, fixtures.origin);
    const capture = {
      id: 'ofs-shot',
      url: `data:image/png;base64,${base64}`,
      width: result.width,
      height: result.height,
      byteLength: result.byteLength,
      type: result.type,
      filename: result.filename,
      pageTitle: result.pageTitle,
      pageUrl: result.pageUrl,
      truncated: Boolean(result.truncated)
    };

    for (const theme of THEMES) {
      // Settings stay at their defaults — theme included — so the pages are
      // photographed exactly as a fresh install renders them.
      const stub = uiStub({ messages, manifest, settings: {}, capture });
      for (const shooter of [shootPopup, shootOptions, shootEditor]) {
        const out = await shooter(chrome, stub, theme);
        if (out.errors.length) problems.push(`${path.basename(out.file)}: ${out.errors[0]}`);
        if (out.state) log(`[editor:${theme}]`, JSON.stringify(out.state));
        if (out.note) log(`[options:${theme}] ${out.note}`);
        produced.push(out);
      }
    }
  } finally {
    if (!KEEP) chrome.kill();
    fixtures.close();
  }

  const ffmpegAvailable = hasFfmpeg();
  if (!ffmpegAvailable) log('[optimise] ffmpeg not found on PATH — writing unoptimised PNGs');

  log('');
  for (const item of produced) {
    const before = pngSize(item.file);
    const after = optimise(item.file, ffmpegAvailable);
    log(
      `${path.relative(ROOT, item.file).replace(/\\/g, '/')}  ` +
        `${after.width}x${after.height}  ${(after.bytes / 1024).toFixed(0)} KB  ` +
        `(rendered ${before.width}x${before.height} from a ${item.css} CSS viewport)`
    );
    if (after.bytes > MAX_BYTES) problems.push(`${path.basename(item.file)} is ${(after.bytes / 1024).toFixed(0)} KB`);
  }

  if (problems.length) {
    log('\nProblems:');
    for (const p of problems) log(`  - ${p}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nshots crashed:', err);
  process.exit(2);
});
