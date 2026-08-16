/**
 * The capture backend behind the MCP tools: the REAL Open FullScreenshot engine,
 * running inside a real page, driven over the CDP pipe.
 *
 * It is the same dance test/pipeline.mjs performs, and deliberately so — the
 * harness and the server share `mcp/chrome-stub.mjs`, so if the engine ever
 * stops working here, `node test/pipeline.mjs` fails too. Nothing is
 * reimplemented: the tiling, the sticky-header policy, the pacing, the stitching
 * and the encoding are the extension's own code.
 *
 * Two differences from the harness, both on purpose:
 *   - the engine runs in an ISOLATED WORLD, exactly like a content script in the
 *     shipped extension, so the page's own globals (`window.chrome`, a page-level
 *     `FS`, a monkey-patched `fetch`) can neither be clobbered by us nor
 *     interfere with the capture;
 *   - `chrome.tabs.captureVisibleTab` is answered from Node with a genuine
 *     `Page.captureScreenshot` through a `Runtime.addBinding` binding.
 *
 * The Chrome it drives is NOT the user's everyday browser (see chrome-launch.mjs
 * and docs/MCP.md): Chrome 136+ refuses remote debugging on the default
 * user-data-dir, so this owns a separate profile and pages behind a login will
 * show the login wall.
 *
 * Node 22, zero dependencies.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUB, ENGINE_SOURCES } from './chrome-stub.mjs';
import { findChrome, launchBrowser, profileDir } from './chrome-launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Name of the isolated world the engine lives in. */
const WORLD = 'open-fullscreenshot';
/** CDP binding the stubbed captureVisibleTab calls to ask Node for a frame. */
const BINDING = '__fsShot';
/** Base64 is pulled back in slices so one CDP frame never carries a whole PNG. */
const CHUNK_CHARS = 4 * 1024 * 1024;

const DEFAULTS = Object.freeze({
  viewportWidth: 1280,
  viewportHeight: 900,
  format: 'png',
  quality: 0.92,
  settleMs: 0,
  loadWaitMs: 500,
  timeoutMs: 180000
});

const MIME = Object.freeze({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' });
const EXT = Object.freeze({ png: 'png', jpeg: 'jpg', webp: 'webp' });

/** Engine error codes → something a human or an agent can act on. */
const ERROR_HELP = Object.freeze({
  'restricted-url': 'Chrome refuses to script or capture this URL (chrome://, the Web Store, view-source: and friends).',
  'no-content-script': 'The page blocked the capture engine before it could measure the document.',
  'capture-failed': 'The capture engine failed mid-run. A page that navigates or closes itself during the capture is the usual cause.',
  quota: "Chrome's screenshot rate limit could not be satisfied; the page is probably too tall for the current settings.",
  'too-large': "The stitched image exceeded Chrome's canvas ceiling. Capture a region, or use a narrower viewport.",
  cancelled: 'The capture was cancelled.',
  'empty-selection': 'The requested region is empty or smaller than 4x4 CSS pixels.'
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------- filesystem --

/**
 * The one directory tree this server is allowed to write into. Every image a
 * tool writes lands inside it; `out_dir` may pick a subdirectory of it and
 * nothing else. The USER moves it — not the agent, and certainly not the page
 * being captured — by setting `OFS_MCP_OUT_DIR` in the `env` block of their MCP
 * client configuration.
 */
export function outRoot() {
  const override = process.env.OFS_MCP_OUT_DIR;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.tmpdir(), 'open-fullscreenshot');
}

/** Where captures land when the caller does not say: the root itself. */
export function defaultOutDir() {
  return outRoot();
}

/** Case-insensitive on Windows, where two spellings are one path. */
function samePathSpace(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** @returns {boolean} true when `candidate` is `root` itself or sits below it. */
function isInside(root, candidate) {
  const r = samePathSpace(root);
  const c = samePathSpace(candidate);
  if (c === r) return true;
  return c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** realpath where the directory exists, the lexical path where it does not yet. */
function realOrSelf(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** mkdir -p, with the failure turned into a sentence instead of an errno. */
export function ensureOutDir(dir) {
  const abs = path.resolve(dir);
  try {
    mkdirSync(abs, { recursive: true });
  } catch (error) {
    throw new Error(`cannot create the output directory ${abs}: ${(error && error.message) || error}`);
  }
  return abs;
}

/**
 * Turn a caller-supplied `out_dir` into an absolute directory that is provably
 * inside `outRoot()`, creating it when needed.
 *
 * `out_dir` arrives from a tool call, which in practice means from a model,
 * which means it can be steered by whatever that model just read — a web page it
 * captured a moment ago, for instance. An unconstrained `mkdir -p` followed by a
 * write is enough to drop a file into a startup folder, so the path is confined:
 *
 *   - a RELATIVE `out_dir` resolves against the root, so `shots/pricing` means
 *     `<root>/shots/pricing`;
 *   - an ABSOLUTE `out_dir` must already be inside the root, or it is refused
 *     before anything at all is created;
 *   - the check is repeated against the REAL path after creation, so a symlink
 *     or a Windows junction already sitting inside the root cannot be used to
 *     step out of it.
 *
 * @param {string} [requested]
 * @returns {string} an absolute, contained directory that exists
 * @throws {Error} naming the root and the supported way to move it
 */
export function resolveOutDir(requested) {
  const root = outRoot();
  const realRoot = realOrSelf(root);
  if (requested === undefined || requested === null || String(requested).trim() === '') {
    return ensureOutDir(realRoot);
  }

  const abs = path.resolve(realRoot, String(requested).trim());
  const refuse = (why) =>
    new Error(
      `"out_dir" ${why}. This server writes only inside ${root}: pass a RELATIVE path such as ` +
        '"pricing-shots" to use a subdirectory of it, or set OFS_MCP_OUT_DIR in the env block of your ' +
        'MCP client configuration to move the whole output tree somewhere else.'
    );

  if (!isInside(root, abs) && !isInside(realRoot, abs)) {
    throw refuse(`resolves to ${abs}, which is outside the output directory`);
  }
  ensureOutDir(abs);
  const real = realOrSelf(abs);
  if (!isInside(realOrSelf(root), real)) {
    throw refuse(`resolves through a link to ${real}, which is outside the output directory`);
  }
  return real;
}

/** Control characters, which have no business in a filename or a report line. */
function isControl(cp) {
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
}

/**
 * Characters that occupy no visual space: zero-width joiners, bidi overrides,
 * the BOM. A name ending in a right-to-left override renders in a file manager
 * as something other than what it is, which is a disguise rather than a name;
 * in a report line they hide whatever follows them.
 */
function isInvisible(cp) {
  return (
    cp === 0x00ad ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  );
}

/** @returns {string} `text` without its invisible characters. */
function stripInvisible(text) {
  let out = '';
  for (const ch of text) {
    if (!isInvisible(ch.codePointAt(0))) out += ch;
  }
  return out;
}

/**
 * Text that came from the captured page — a title, a final URL, an exception
 * message — on its way into a tool result, i.e. straight into a model's context.
 *
 * The page author chooses `document.title`, and it has no practical length
 * limit, so copying it into the result verbatim hands a hostile page an
 * unbounded channel for writing text into the transcript. Flatten it to a single
 * line so it cannot forge further report fields, drop the characters that hide
 * what follows them, and cap the length.
 * @returns {string}
 */
export function untrustedText(value, limit = 200) {
  const raw = String(value === undefined || value === null ? '' : value);
  let text = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    if (isInvisible(cp)) continue;
    text += isControl(cp) ? ' ' : ch;
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > limit) text = `${text.slice(0, limit)}... [truncated, ${text.length} characters]`;
  return text;
}

/**
 * The engine templates the filename from the PAGE TITLE, which is attacker
 * controlled: re-sanitize it here before it ever reaches the filesystem.
 * @returns {string} a bare filename, never a path
 */
export function safeFilename(candidate, format) {
  const ext = EXT[format] || 'png';
  let name = path.basename(String(candidate || '').replace(/[\\/]+/g, '_'));
  name = name.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  // Windows-illegal characters and every control character.
  name = name.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/\s+/g, ' ').trim();
  name = stripInvisible(name);
  name = name.replace(/\s+/g, ' ').trim();
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!name) name = 'capture';
  if (name.length > 120) name = name.slice(0, 120);
  // Reserved DOS device names would make the write fail in a baffling way.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name = `_${name}`;
  return `${name}.${ext}`;
}

/**
 * Never silently overwrite a previous capture — including on the thousandth
 * capture of the same page title, where a counter bounded at 1000 would run out
 * and hand back a name that is already taken.
 */
function uniquePath(dir, filename) {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let i = 2; existsSync(candidate) && i < 1000; i++) candidate = path.join(dir, `${stem}-${i}${ext}`);
  while (existsSync(candidate)) candidate = path.join(dir, `${stem}-${randomBytes(4).toString('hex')}${ext}`);
  return candidate;
}

// ------------------------------------------------------------ engine source --

let engineCache = null;

/** Read the eight engine files once per process, in dependency order. */
function engineSources() {
  if (engineCache) return engineCache;
  engineCache = ENGINE_SOURCES.map((rel) => {
    const abs = path.join(ROOT, rel);
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      throw new Error(`engine source missing: ${abs} — run the server from a complete checkout of the extension`);
    }
    return { rel, source };
  });
  return engineCache;
}

// ----------------------------------------------------------------- browser ---

/** @type {import('./chrome-launch.mjs').Browser|null} */
let shared = null;
let launching = null;
let hooked = false;
/**
 * Bumped by `shutdown()`. A launch that was in flight when it happened resolves
 * into a browser nobody asked for any more, so it compares its own era against
 * this before publishing itself as `shared`.
 */
let era = 0;

function hookExit() {
  if (hooked) return;
  hooked = true;
  const kill = () => {
    if (shared) shared.kill();
    shared = null;
  };
  process.on('exit', kill);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      kill();
      process.exit(0);
    });
  }
}

/**
 * The one Chrome this process drives, launched on first use and reused after.
 *
 * Reuse is conditional on the TRANSPORT as well as on the child. `dead` only
 * flips when Chrome exits, but `CdpPipe` closes itself on a read `end`, a read
 * error or a WRITE error — none of which implies the process went away. Without
 * the `pipe.closed` half of this test, one transport failure over a live Chrome
 * is permanent: every later call hands back the same unreachable browser and
 * every capture fails identically until the server process is restarted.
 *
 * Dropping such a browser is not enough either, because nothing else would ever
 * close fds 3 and 4 — and a Chrome launched with `--remote-debugging-pipe` keeps
 * running while they are open, holding the lock on the capture profile, so the
 * relaunch below would fail in the `profile_busy` branch and tell the user to
 * close a window that has no window. `kill()` is synchronous and idempotent
 * (`pipe.close()` returns early when already closed, `child.kill()` on a reaped
 * child is swallowed), so calling it here is free even on the already-dead path.
 * @returns {Promise<import('./chrome-launch.mjs').Browser>}
 */
export async function getBrowser() {
  if (shared && !shared.dead && !shared.pipe.closed) return shared;
  if (shared) shared.kill();
  shared = null;
  if (!launching) {
    hookExit();
    const mine = era;
    launching = launchBrowser({
      headful: process.env.OFS_MCP_HEADFUL === '1',
      windowSize: `${DEFAULTS.viewportWidth},${DEFAULTS.viewportHeight}`
    }).then(
      (browser) => {
        // `shutdown()` happened while this was starting: publishing the browser
        // now would leave one running that no later call has a handle on.
        if (mine !== era) {
          browser.kill();
          throw new Error('the capture browser was shut down while it was starting');
        }
        shared = browser;
        launching = null;
        return browser;
      },
      (error) => {
        if (mine === era) launching = null;
        throw error;
      }
    );
  }
  return launching;
}

/** Drop the shared browser (used by --selftest teardown and by check_setup). */
export function shutdown() {
  if (shared) shared.kill();
  shared = null;
  // A launch in flight must not resolve into a new `shared` after this point.
  era++;
  launching = null;
}

/**
 * Captures are serialized: one visible tab at a time is the only honest setup.
 *
 * Requests are dispatched concurrently, so an agent that batches five capture
 * calls queues five runs behind one another; at the 180 s ceiling of
 * `DEFAULTS.timeoutMs` the last of them can leave the client with no answer for
 * a quarter of an hour. Past a small depth the honest reply is to refuse now,
 * in words the caller can act on, rather than to accept and go quiet.
 */
const MAX_QUEUED = 3;
let chain = Promise.resolve();
let queued = 0;
function serialize(task) {
  if (queued >= MAX_QUEUED) {
    return Promise.reject(
      new Error(
        // `queued` counts the head of the chain too, and that one is running,
        // not waiting — say so rather than overstating the backlog.
        `This server runs captures one at a time: ${queued - 1} are waiting behind one in ` +
          'progress. Wait for them to finish, then retry this one.'
      )
    );
  }
  queued++;
  const run = chain.then(task, task).finally(() => {
    queued--;
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ------------------------------------------------------------- page driving --

async function navigate(pipe, sessionId, url, timeoutMs) {
  let settle = null;
  const loaded = new Promise((resolve) => {
    settle = resolve;
  });
  const off = pipe.on('Page.loadEventFired', (_params, sid) => {
    if (sid === sessionId) settle(true);
  });
  try {
    const res = await pipe.send('Page.navigate', { url }, sessionId, timeoutMs);
    if (res && res.errorText) throw new Error(`navigation failed (${res.errorText}): ${url}`);
    // A page that never fires `load` (long-polling, a stalled subresource) is
    // still worth capturing, so the timeout resolves instead of rejecting.
    await Promise.race([loaded, sleep(timeoutMs)]);
  } finally {
    off();
  }
}

/**
 * Answer one `captureVisibleTab` with a real screenshot. Failures resolve the
 * page-side promise with null so the engine's own retry/pacing logic sees a
 * normal capture failure instead of a hung await.
 */
async function answerShot(pipe, sessionId, contextId, payload) {
  let dataUrl = null;
  try {
    const shot = await pipe.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, sessionId, 60000);
    dataUrl = `data:image/png;base64,${shot.data}`;
  } catch {
    dataUrl = null;
  }
  const literal = dataUrl ? `"${dataUrl}"` : 'null';
  try {
    await pipe.send(
      'Runtime.evaluate',
      { expression: `__shotResolve(${JSON.stringify(String(payload))}, ${literal})`, contextId, returnByValue: true },
      sessionId,
      60000
    );
  } catch {
    /* the page went away mid-capture; the engine will report the failure */
  }
}

/**
 * Keep a handle on every Blob the stitcher publishes as an object URL.
 *
 * Reading the finished image back with `fetch(blob:…)` is subject to the PAGE's
 * Content-Security-Policy: a `connect-src` directive of the kind MDN, GitHub and
 * most banks ship blocks it, and the capture dies at the very last step. The
 * usual workaround is `Page.setBypassCSP`, i.e. switching off a site's own
 * defences for the duration — a much bigger hammer than simply holding on to the
 * Blob we already have. `Blob.arrayBuffer()` involves no request at all.
 */
const BLOB_TAP = `
globalThis.__fsBlobs = new Map();
(function () {
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (object) {
    const url = create(object);
    try { if (object instanceof Blob) globalThis.__fsBlobs.set(url, object); } catch (e) { /* not a Blob */ }
    return url;
  };
})();
true`;

/** Pull the encoded image out of the page in slices. @returns {Buffer} */
async function readImage(pipe, sessionId, contextId, blobUrl) {
  const length = await pipe.evaluate(
    sessionId,
    `(async () => {
      const url = ${JSON.stringify(blobUrl)};
      const blob = globalThis.__fsBlobs && globalThis.__fsBlobs.get(url);
      const buf = blob ? await blob.arrayBuffer() : await (await fetch(url)).arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      globalThis.__fsBase64 = btoa(binary);
      return globalThis.__fsBase64.length;
    })()`,
    { contextId, timeoutMs: 120000 }
  );
  if (!Number.isFinite(length) || length <= 0) throw new Error('the encoded image could not be read back from the page');

  const parts = [];
  for (let at = 0; at < length; at += CHUNK_CHARS) {
    parts.push(
      await pipe.evaluate(sessionId, `globalThis.__fsBase64.slice(${at}, ${at + CHUNK_CHARS})`, {
        contextId,
        awaitPromise: false,
        timeoutMs: 60000
      })
    );
  }
  return Buffer.from(parts.join(''), 'base64');
}

// --------------------------------------------------------------- the capture --

/**
 * @typedef {Object} CaptureSpec
 * @property {'fullpage'|'visible'|'region'} mode
 * @property {string} url
 * @property {string} [format] png | jpeg | webp
 * @property {number} [quality] jpeg/webp only, 0.1–1
 * @property {string} [outDir]
 * @property {number} [viewportWidth] @property {number} [viewportHeight]
 * @property {number} [settleMs] extra wait after each scroll step
 * @property {number} [loadWaitMs] extra wait after load, before capturing
 * @property {number} [timeoutMs] ceiling on the whole engine run
 * @property {{x:number,y:number,width:number,height:number}} [rect] region mode
 */

/**
 * Run one capture end to end and write the image to disk.
 * @param {CaptureSpec} spec
 * @returns {Promise<Object>} { path, width, height, byteLength, mime, ... }
 */
export function capture(spec) {
  return serialize(() => runCapture(spec));
}

async function runCapture(spec) {
  const started = Date.now();
  const format = MIME[spec.format] ? spec.format : DEFAULTS.format;
  // Re-run the containment check here rather than trusting the caller's: this is
  // the last place before a write, and it is the only one that matters.
  const outDir = resolveOutDir(spec.outDir);
  const viewportWidth = spec.viewportWidth || DEFAULTS.viewportWidth;
  const viewportHeight = spec.viewportHeight || DEFAULTS.viewportHeight;
  const timeoutMs = spec.timeoutMs || DEFAULTS.timeoutMs;

  const browser = await getBrowser();
  const pipe = browser.pipe;
  const { targetId, sessionId } = await browser.openPage('about:blank');
  const detach = [];

  try {
    await pipe.send(
      'Emulation.setDeviceMetricsOverride',
      { width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1, mobile: false },
      sessionId
    );
    // Only the front tab renders in a way `Page.captureScreenshot` can trust.
    await pipe.send('Page.bringToFront', {}, sessionId).catch(() => undefined);
    await navigate(pipe, sessionId, spec.url, Math.min(timeoutMs, 60000));
    await sleep(Math.max(0, spec.loadWaitMs === undefined ? DEFAULTS.loadWaitMs : spec.loadWaitMs));

    // Register the binding BEFORE the world exists: `executionContextName`
    // installs it into every matching context as that context is created.
    await pipe.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD }, sessionId);
    const { frameTree } = await pipe.send('Page.getFrameTree', {}, sessionId);
    const { executionContextId: contextId } = await pipe.send(
      'Page.createIsolatedWorld',
      { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: true },
      sessionId
    );

    detach.push(
      pipe.on('Runtime.bindingCalled', (params, sid) => {
        if (sid !== sessionId || params.name !== BINDING) return;
        if (params.executionContextId !== contextId) return;
        void answerShot(pipe, sessionId, contextId, params.payload);
      })
    );

    const settings = {
      afterCapture: 'editor', // with the stub this only records a tabs.create call
      showHud: false,
      preScrollForLazy: true,
      format,
      quality: spec.quality === undefined ? DEFAULTS.quality : spec.quality,
      scaleMode: 'device',
      hideFixed: 'smart',
      settleMs: spec.settleMs === undefined ? DEFAULTS.settleMs : spec.settleMs,
      saveAs: false
    };
    await pipe.evaluate(sessionId, `globalThis.__settings = ${JSON.stringify(settings)}; true`, {
      contextId,
      awaitPromise: false
    });
    await pipe.evaluate(sessionId, BLOB_TAP, { contextId, awaitPromise: false });
    await pipe.evaluate(sessionId, STUB, { contextId, awaitPromise: false });
    for (const file of engineSources()) {
      try {
        await pipe.evaluate(sessionId, file.source, { contextId, awaitPromise: false });
      } catch (error) {
        throw new Error(`the capture engine failed to load (${file.rel}): ${(error && error.message) || error}`);
      }
    }

    // Region mode reuses the engine's SELECT path, which normally asks the
    // on-page overlay for a rectangle; here the rectangle comes from the caller.
    const mode = spec.mode === 'visible' ? 'visible' : spec.mode === 'region' ? 'select' : 'fullpage';
    if (mode === 'select') {
      const rect = {
        x: Math.max(0, Math.round(spec.rect.x)),
        y: Math.max(0, Math.round(spec.rect.y)),
        w: Math.round(spec.rect.width),
        h: Math.round(spec.rect.height)
      };
      await pipe.evaluate(
        sessionId,
        `chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
          if (!msg || msg.type !== FS.MSG.CS_SELECT) return undefined;
          sendResponse({ rect: ${JSON.stringify(rect)}, kind: 'region' });
          return true;
        }); true`,
        { contextId, awaitPromise: false }
      );
    }

    const run = await pipe.evaluate(
      sessionId,
      `(async () => {
        try {
          const settings = await FS.Settings.get();
          const out = await FS.Engine.run({
            mode: ${JSON.stringify(mode)},
            tab: { id: 1, windowId: 1, index: 0, url: location.href, title: document.title },
            settings
          });
          return { ok: true, out: { url: out.url, width: out.width, height: out.height,
            byteLength: out.byteLength, type: out.type, filename: out.filename,
            truncated: out.truncated, pageTitle: out.pageTitle, pageUrl: out.pageUrl } };
        } catch (e) {
          return { ok: false, code: (e && e.code) || '', error: String((e && e.message) || e) };
        }
      })()`,
      { contextId, timeoutMs }
    );

    if (!run || !run.ok) {
      // `run.code` and `run.error` are page-reachable: an exception message can
      // be anything the page decided to throw. Bound them before they become
      // the text of a tool failure.
      const code = untrustedText((run && run.code) || 'capture-failed', 60) || 'capture-failed';
      const help = ERROR_HELP[code] || untrustedText(run && run.error, 300) || 'the capture engine reported a failure';
      throw new Error(`capture failed (${code}): ${help}`);
    }

    const image = await readImage(pipe, sessionId, contextId, run.out.url);
    const filename = safeFilename(run.out.filename, format);
    const file = uniquePath(outDir, filename);
    // Belt to the sanitizer's braces: whatever the page called itself, the write
    // happens in the directory we resolved, or it does not happen.
    if (path.dirname(path.resolve(file)) !== path.resolve(outDir)) {
      throw new Error(`internal error: refusing to write ${file} outside ${outDir}`);
    }
    writeFileSync(file, image);

    return {
      path: file,
      width: run.out.width,
      height: run.out.height,
      byteLength: image.length,
      mime: run.out.type || MIME[format],
      format,
      truncated: !!run.out.truncated,
      pageTitle: run.out.pageTitle || '',
      pageUrl: run.out.pageUrl || spec.url,
      /** What the CALLER asked for, as opposed to where the page ended up. */
      requestedUrl: spec.url,
      viewport: { width: viewportWidth, height: viewportHeight },
      elapsedMs: Date.now() - started
    };
  } finally {
    for (const off of detach) off();
    await browser.closePage(targetId);
  }
}

// -------------------------------------------------------------- diagnostics --

/**
 * Everything `check_setup` needs, gathered without throwing: each probe records
 * its own verdict so a broken Chrome still yields a full report.
 * @param {string} [requestedOutDir] an `out_dir` to check instead of the default
 * @returns {Promise<Object>}
 */
export async function checkSetup(requestedOutDir) {
  const report = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    chromePath: findChrome(),
    chromeVersion: null,
    pipeMs: null,
    pipeError: null,
    pipeBusy: false,
    outRoot: outRoot(),
    outDir: null,
    outDirRequested: requestedOutDir || null,
    outDirWritable: false,
    outDirError: null,
    profileDir: profileDir(),
    engineFiles: ENGINE_SOURCES.length,
    engineError: null
  };

  try {
    engineSources();
  } catch (error) {
    report.engineError = (error && error.message) || String(error);
  }

  try {
    const dir = resolveOutDir(requestedOutDir);
    report.outDir = dir;
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    report.outDirWritable = true;
  } catch (error) {
    report.outDirError = (error && error.message) || String(error);
  }

  if (report.chromePath) {
    const started = Date.now();
    try {
      const browser = await getBrowser();
      const info = await browser.pipe.send('Browser.getVersion', {}, undefined, 20000);
      report.chromeVersion = info.product || '';
      report.userAgentJs = info.jsVersion || '';
      report.pipeMs = Date.now() - started;
    } catch (error) {
      report.pipeError = (error && error.message) || String(error);
      report.pipeBusy = !!(error && error.code === 'profile_busy');
    }
  }

  return report;
}
