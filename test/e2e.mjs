/**
 * FullShot harness — content-script layer. Zero dependencies, Node 22+.
 *
 *   node test/e2e.mjs [--headful] [--keep]
 *
 * Phase 1  Runs page-driver.js inside a real fixture page (with a stubbed
 *          `chrome`) and asserts the page plan, the tile walk, and — the
 *          property that matters most — that the page is restored EXACTLY.
 * Phase 2  Drives select-overlay.js with synthetic input and checks the
 *          document-space rectangle it returns.
 *
 * The extension is deliberately NOT installed here: Google Chrome 137+ removed
 * the --load-extension switch ("--load-extension is not allowed in Google
 * Chrome, ignoring"), so no automation surface can side-load it. Everything
 * below therefore exercises the real source files directly in a real page.
 * test/pipeline.mjs goes further and runs the whole capture engine that way.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchChrome, sleep } from './cdp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADFUL = process.argv.includes('--headful');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).replace(/\n/g, '\n        ')}` : ''}`);
  return ok;
}

function readSrc(rel) {
  const file = path.join(ROOT, rel);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Stub of the extension APIs a content script touches, plus `__fsCall` which
 * delivers a message to the listeners the content script registered and
 * resolves with the reply.
 */
export const CHROME_STUB = `
globalThis.__fsInbox = [];
globalThis.__fsSent = [];
globalThis.chrome = {
  runtime: {
    id: 'test-extension-id',
    lastError: null,
    getManifest: () => ({ version: '1.0.0', name: 'FullShot' }),
    getURL: (p) => 'chrome-extension://test/' + p,
    onMessage: {
      addListener: (fn) => globalThis.__fsInbox.push(fn),
      removeListener: (fn) => {
        const i = globalThis.__fsInbox.indexOf(fn);
        if (i >= 0) globalThis.__fsInbox.splice(i, 1);
      }
    },
    sendMessage: (msg, cb) => {
      globalThis.__fsSent.push(msg);
      if (typeof cb === 'function') cb({ ok: true });
      return Promise.resolve({ ok: true });
    }
  },
  i18n: { getMessage: (k) => k },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  }
};
globalThis.__fsCall = (message) => new Promise((resolve) => {
  let settled = false;
  const done = (r) => { if (!settled) { settled = true; resolve(r === undefined ? { __undefined: true } : r); } };
  let async = false;
  for (const fn of globalThis.__fsInbox.slice()) {
    let returned;
    try { returned = fn(message, { id: 'test' }, done); } catch (e) { return done({ __threw: String(e) }); }
    if (returned === true) async = true;
  }
  if (!async) setTimeout(() => done({ __nohandler: true }), 60);
  setTimeout(() => done({ __timeout: true }), 20000);
});
`;

/** Load protocol/util (+ extras) into a page that already has the stub. */
async function loadSources(chrome, sessionId, files) {
  for (const rel of files) {
    const src = readSrc(rel);
    if (!src) {
      check(`${rel} exists`, false, 'file missing');
      return false;
    }
    try {
      await chrome.browser.eval(sessionId, src, { awaitPromise: false });
    } catch (e) {
      check(`${rel} evaluates in a page`, false, String(e));
      return false;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ phase 1 */

async function phase1(chrome) {
  console.log('\n[phase 1] page driver on test/fixtures/long-article.html');

  const fixture = pathToFileURL(path.join(ROOT, 'test/fixtures/long-article.html')).href;
  const { sessionId } = await chrome.browser.openPage(fixture);
  const pageErrors = [];
  chrome.browser.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid === sessionId) pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });
  await sleep(800);

  await chrome.browser.eval(sessionId, CHROME_STUB, { awaitPromise: false });
  if (!(await loadSources(chrome, sessionId, ['src/shared/protocol.js', 'src/shared/util.js', 'src/content/page-driver.js'])))
    return;
  check('content scripts evaluate in a page', true);

  // Re-injection must be harmless: the background injects on every capture.
  await loadSources(chrome, sessionId, ['src/content/page-driver.js']);
  const listenerCount = await chrome.browser.eval(sessionId, `globalThis.__fsInbox.length`);
  check('re-injection registers no duplicate listener', listenerCount === 1, `listeners=${listenerCount}`);

  const before = await chrome.browser.eval(
    sessionId,
    `(() => ({ html: document.documentElement.outerHTML, y: window.scrollY, x: window.scrollX }))()`
  );

  const plan = await chrome.browser.eval(
    sessionId,
    `__fsCall({ type: FS.MSG.CS_PREPARE, mode: FS.MODE.FULLPAGE, options:
        { hideFixed: 'smart', preScrollForLazy: true, showHud: false, rect: null, settleMs: 0 } })`
  );

  if (!plan || plan.__nohandler || plan.__timeout || plan.error || !plan.tiles) {
    check('CS_PREPARE returns a plan', false, JSON.stringify(plan).slice(0, 500));
    return;
  }
  check('CS_PREPARE returns a plan', true);

  const required = ['fullWidth','fullHeight','viewportWidth','viewportHeight','scrollbarWidth',
                    'scrollbarHeight','devicePixelRatio','windowWidth','windowHeight','sourceRect',
                    'area','tiles','scrollsWindow','title','url'];
  const missing = required.filter((k) => !(k in plan));
  check('PagePlan has every contract field', missing.length === 0, missing.join(', '));
  check('plan measures a multi-viewport document', plan.fullHeight > plan.viewportHeight * 3,
        `fullHeight=${plan.fullHeight} viewportHeight=${plan.viewportHeight}`);

  const expected = Math.ceil(plan.area.h / plan.viewportHeight) * Math.ceil(plan.area.w / plan.viewportWidth);
  check('tile count matches the area and viewport', plan.tiles.length === expected,
        `got ${plan.tiles.length}, expected ${expected}`);

  const walk = [];
  for (let i = 0; i < plan.tiles.length; i++) {
    const t = plan.tiles[i];
    walk.push(await chrome.browser.eval(
      sessionId,
      `__fsCall({ type: FS.MSG.CS_GOTO, x: ${t.x}, y: ${t.y}, index: ${i}, total: ${plan.tiles.length}, hideFixed: 'smart' })`
    ));
  }
  const bad = walk.findIndex((w) => !w || typeof w.y !== 'number' || typeof w.x !== 'number');
  check('every CS_GOTO reports actual offsets', bad === -1, bad === -1 ? '' : `tile ${bad}: ${JSON.stringify(walk[bad])}`);

  const ys = walk.map((w) => w && w.y);
  check('scroll walk is monotonic', ys.every((y, i) => i === 0 || y >= ys[i - 1]), ys.join(','));
  const maxScroll = plan.fullHeight - plan.viewportHeight;
  check('final tile is clamped to the document end', Math.abs(ys[ys.length - 1] - maxScroll) <= 4,
        `lastY=${ys[ys.length - 1]} maxScroll=${maxScroll}`);

  const mid = await chrome.browser.eval(sessionId, `(() => ({
      freeze: !!document.getElementById('fullshot-freeze'),
      hidden: document.querySelectorAll('[data-fullshot-hidden]').length,
      statics: document.querySelectorAll('[data-fullshot-static]').length }))()`);
  check('freeze stylesheet installed during capture', mid.freeze === true, JSON.stringify(mid));
  check('fixed elements hidden on later frames', mid.hidden > 0, `hidden=${mid.hidden} static=${mid.statics}`);

  const restore = await chrome.browser.eval(sessionId, `__fsCall({ type: FS.MSG.CS_RESTORE })`);
  check('CS_RESTORE replies', !!restore && !restore.__nohandler && !restore.__timeout,
        JSON.stringify(restore).slice(0, 200));

  await sleep(400);
  const after = await chrome.browser.eval(sessionId, `(() => ({
      html: document.documentElement.outerHTML,
      y: window.scrollY, x: window.scrollX,
      freeze: !!document.getElementById('fullshot-freeze'),
      hidden: document.querySelectorAll('[data-fullshot-hidden]').length,
      statics: document.querySelectorAll('[data-fullshot-static]').length,
      ui: document.querySelectorAll('[data-fullshot-ui]').length }))()`);

  check('freeze stylesheet removed', after.freeze === false);
  check('no capture attributes left behind', after.hidden === 0 && after.statics === 0,
        `hidden=${after.hidden} static=${after.statics}`);
  check('no overlay nodes left behind', after.ui === 0, `ui nodes=${after.ui}`);
  check('scroll position restored', Math.abs(after.y - before.y) <= 1 && Math.abs(after.x - before.x) <= 1,
        `before=${before.y} after=${after.y}`);

  if (after.html !== before.html) {
    const a = before.html, b = after.html;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    check('DOM identical after restore', false,
      `first difference at char ${i}\nbefore: …${a.slice(Math.max(0, i - 70), i + 90)}…\nafter:  …${b.slice(Math.max(0, i - 70), i + 90)}…`);
  } else {
    check('DOM identical after restore', true);
  }

  // Second capture on the same page must behave identically (state leakage check).
  const plan2 = await chrome.browser.eval(
    sessionId,
    `__fsCall({ type: FS.MSG.CS_PREPARE, mode: FS.MODE.FULLPAGE, options:
        { hideFixed: 'smart', preScrollForLazy: false, showHud: false, rect: null, settleMs: 0 } })`
  );
  check('a second CS_PREPARE yields the same geometry',
        !!plan2 && plan2.fullHeight === plan.fullHeight && plan2.tiles?.length === plan.tiles.length,
        `first=${plan.fullHeight}/${plan.tiles.length} second=${plan2 && plan2.fullHeight}/${plan2 && plan2.tiles?.length}`);
  await chrome.browser.eval(sessionId, `__fsCall({ type: FS.MSG.CS_RESTORE })`);

  check('no page exceptions during the run', pageErrors.length === 0, pageErrors.slice(0, 3).join('\n'));
}

/* ---------------------------------------------------- phase 1b: inner scroll */

async function phase1b(chrome) {
  console.log('\n[phase 1b] scroller detection on test/fixtures/inner-scroll.html');
  const fixture = pathToFileURL(path.join(ROOT, 'test/fixtures/inner-scroll.html')).href;
  const { sessionId } = await chrome.browser.openPage(fixture);
  await sleep(700);
  await chrome.browser.eval(sessionId, CHROME_STUB, { awaitPromise: false });
  if (!(await loadSources(chrome, sessionId, ['src/shared/protocol.js', 'src/shared/util.js', 'src/content/page-driver.js'])))
    return;

  const plan = await chrome.browser.eval(
    sessionId,
    `__fsCall({ type: FS.MSG.CS_PREPARE, mode: FS.MODE.FULLPAGE, options:
        { hideFixed: 'smart', preScrollForLazy: false, showHud: false, rect: null, settleMs: 0 } })`
  );
  if (!plan || !plan.tiles) {
    check('inner-scroll CS_PREPARE returns a plan', false, JSON.stringify(plan).slice(0, 300));
    return;
  }
  check('inner-scroll CS_PREPARE returns a plan', true);
  check('detects the nested scroll container', plan.scrollsWindow === false, `scrollsWindow=${plan.scrollsWindow}`);
  check('measures beyond one viewport', plan.fullHeight > plan.viewportHeight * 1.5,
        `fullHeight=${plan.fullHeight} viewportHeight=${plan.viewportHeight}`);
  check('produces more than one tile', plan.tiles.length > 1, `tiles=${plan.tiles.length}`);

  const last = plan.tiles[plan.tiles.length - 1];
  const got = await chrome.browser.eval(
    sessionId,
    `__fsCall({ type: FS.MSG.CS_GOTO, x: ${last.x}, y: ${last.y}, index: ${plan.tiles.length - 1}, total: ${plan.tiles.length}, hideFixed: 'smart' })`
  );
  const scrolled = await chrome.browser.eval(sessionId, `document.querySelector('.feed').scrollTop`);
  check('the nested container actually scrolled', scrolled > 100, `scrollTop=${scrolled} reported=${JSON.stringify(got)}`);

  await chrome.browser.eval(sessionId, `__fsCall({ type: FS.MSG.CS_RESTORE })`);
  await sleep(300);
  const restored = await chrome.browser.eval(sessionId, `document.querySelector('.feed').scrollTop`);
  check('nested container scroll restored', restored <= 1, `scrollTop=${restored}`);
}

/* ------------------------------------------------------------------ phase 2 */

async function phase2(chrome) {
  console.log('\n[phase 2] selection overlay');
  const fixture = pathToFileURL(path.join(ROOT, 'test/fixtures/long-article.html')).href;
  const { sessionId } = await chrome.browser.openPage(fixture);
  await sleep(700);
  await chrome.browser.eval(sessionId, CHROME_STUB, { awaitPromise: false });
  if (!(await loadSources(chrome, sessionId,
        ['src/shared/protocol.js', 'src/shared/util.js', 'src/content/select-overlay.js'])))
    return;
  check('overlay evaluates in a page', true);

  await chrome.browser.eval(sessionId, `globalThis.__sel = __fsCall({ type: FS.MSG.CS_SELECT }); true`, { awaitPromise: false });
  await sleep(500);
  check('overlay mounts a host node',
        (await chrome.browser.eval(sessionId, `document.querySelectorAll('[data-fullshot-ui]').length`)) > 0);

  const mouse = (type, x, y, buttons) =>
    chrome.browser.send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: 1, buttons }, sessionId);

  await mouse('mouseMoved', 200, 220, 0); await sleep(150);
  await mouse('mousePressed', 200, 220, 1); await sleep(100);
  await mouse('mouseMoved', 360, 340, 1); await sleep(100);
  await mouse('mouseMoved', 520, 460, 1); await sleep(150);
  await mouse('mouseReleased', 520, 460, 0); await sleep(300);

  for (const type of ['rawKeyDown', 'keyUp']) {
    await chrome.browser.send('Input.dispatchKeyEvent',
      { type, windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, sessionId);
  }
  await sleep(500);

  const sel = await chrome.browser.eval(
    sessionId,
    `Promise.race([globalThis.__sel, new Promise(r => setTimeout(() => r({ __pending: true }), 3000))])`
  );

  if (sel && sel.rect) {
    const r = sel.rect;
    check('drag returns a plausible document rect',
      Math.abs(r.w - 320) <= 24 && Math.abs(r.h - 240) <= 24,
      `rect=${JSON.stringify(r)} kind=${sel.kind}`);
  } else {
    check('drag returns a rect', false, JSON.stringify(sel).slice(0, 400));
  }

  check('overlay removes itself after resolving',
        (await chrome.browser.eval(sessionId, `document.querySelectorAll('[data-fullshot-ui]').length`)) === 0);

  // Escape must cancel cleanly and leave nothing behind.
  await chrome.browser.eval(sessionId, `globalThis.__sel2 = __fsCall({ type: FS.MSG.CS_SELECT }); true`, { awaitPromise: false });
  await sleep(400);
  for (const type of ['rawKeyDown', 'keyUp']) {
    await chrome.browser.send('Input.dispatchKeyEvent',
      { type, windowsVirtualKeyCode: 27, key: 'Escape', code: 'Escape' }, sessionId);
  }
  await sleep(400);
  const cancelled = await chrome.browser.eval(
    sessionId,
    `Promise.race([globalThis.__sel2, new Promise(r => setTimeout(() => r({ __pending: true }), 2500))])`
  );
  check('Escape cancels the overlay', !!(cancelled && cancelled.cancelled), JSON.stringify(cancelled).slice(0, 200));
  check('nothing left behind after cancel',
        (await chrome.browser.eval(sessionId, `document.querySelectorAll('[data-fullshot-ui]').length`)) === 0);
}

/* ------------------------------------------------------------------ phase 3 */

/** Stub installed BEFORE the page's own scripts, so the UI boots as if in the extension. */
const UI_STUB = `
globalThis.chrome = {
  runtime: {
    id: 'test', lastError: null,
    getManifest: () => ({ version: '1.0.0', name: 'FullShot' }),
    getURL: (p) => p,
    sendMessage: () => Promise.resolve(null),
    onMessage: { addListener: () => {}, removeListener: () => {} },
    openOptionsPage: () => {}
  },
  i18n: { getMessage: (k) => 'T:' + k },
  commands: { getAll: () => Promise.resolve([{ name: '_execute_action', shortcut: 'Alt+Shift+P' }]) },
  storage: {
    local: {
      get: () => Promise.resolve({}),
      set: (v) => { globalThis.__saved = Object.assign(globalThis.__saved || {}, v); return Promise.resolve(); },
      remove: () => Promise.resolve()
    },
    onChanged: { addListener: () => {}, removeListener: () => {} }
  },
  tabs: { create: () => Promise.resolve({}), getCurrent: () => Promise.resolve({ id: 1 }) }
};
`;

async function phase3(chrome) {
  console.log('\n[phase 3] extension pages boot');

  for (const page of ['src/editor/editor.html', 'src/popup/popup.html', 'src/options/options.html']) {
    if (!existsSync(path.join(ROOT, page))) {
      check(`${page} exists`, false, 'file missing');
      continue;
    }
    const { targetId } = await chrome.browser.send('Target.createTarget', { url: 'about:blank' });
    const sessionId = await chrome.browser.attach(targetId);
    await chrome.browser.send('Runtime.enable', {}, sessionId);
    await chrome.browser.send('Page.enable', {}, sessionId);
    const errors = [];
    chrome.browser.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid === sessionId) errors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
    });
    await chrome.browser.send('Page.addScriptToEvaluateOnNewDocument', { source: UI_STUB }, sessionId);
    await chrome.browser.send('Page.navigate', { url: pathToFileURL(path.join(ROOT, page)).href }, sessionId);
    await sleep(1200);

    const state = await chrome.browser
      .eval(sessionId, `(() => {
         const nodes = [...document.querySelectorAll('[data-i18n]')];
         const unresolved = nodes.filter(n => !n.textContent.startsWith('T:')).map(n => n.getAttribute('data-i18n'));
         return { i18nNodes: nodes.length, unresolved: unresolved.slice(0, 6),
                  buttons: document.querySelectorAll('button').length,
                  inputs: document.querySelectorAll('input,select').length,
                  theme: document.documentElement.getAttribute('data-theme') };
       })()`)
      .catch((e) => ({ error: String(e) }));

    check(`${page} boots without an exception`, errors.length === 0, errors.slice(0, 2).join('\n'));
    if (!state.error) {
      check(`${page} localizes every data-i18n node`, state.unresolved.length === 0,
        `${state.i18nNodes} nodes, unresolved: ${state.unresolved.join(', ')}`);
      check(`${page} renders its controls`, state.buttons + state.inputs > 3,
        `buttons=${state.buttons} inputs=${state.inputs}`);
    } else {
      check(`${page} is inspectable`, false, state.error);
    }
    await chrome.browser.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/* -------------------------------------------------------------------- main */

async function main() {
  const chrome = await launchChrome({ extensionDir: ROOT, headless: !HEADFUL, port: 9333 });
  try {
    await phase1(chrome);
    await phase1b(chrome);
    await phase2(chrome);
    await phase3(chrome);
  } finally {
    if (!process.argv.includes('--keep')) chrome.kill();
  }

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
