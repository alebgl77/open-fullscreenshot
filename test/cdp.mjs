/**
 * Minimal zero-dependency Chrome DevTools Protocol client.
 *
 * Node 22 ships a global WebSocket, so this needs nothing from npm. Only the
 * handful of CDP calls the test harness uses are wrapped.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Reproduce Chrome's deterministic id for an unpacked extension:
 * SHA-256 of the absolute path (UTF-16LE on Windows, with an upper-case drive
 * letter, matching crx_file::id_util::GenerateIdForPath), first 16 bytes, each
 * nibble mapped to 'a'..'p'.
 *
 * Needed because a stopped MV3 service worker exposes no CDP target, so the id
 * cannot always be discovered by enumeration.
 */
export function extensionIdForPath(dir) {
  let abs = path.resolve(dir);
  let bytes;
  if (process.platform === 'win32') {
    if (/^[a-z]:/.test(abs)) abs = abs[0].toUpperCase() + abs.slice(1);
    bytes = Buffer.from(abs, 'utf16le');
  } else {
    bytes = Buffer.from(abs, 'utf8');
  }
  const hash = createHash('sha256').update(bytes).digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    id += String.fromCharCode(97 + (hash[i] >> 4));
    id += String.fromCharCode(97 + (hash[i] & 0x0f));
  }
  return id;
}

/** Locate a Chrome binary on this machine. */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    process.env['ProgramFiles(x86)'] &&
      path.join(process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA &&
      path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`);
  if (!res.ok) throw new Error(`${route} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Launch Chrome with the extension loaded and the DevTools endpoint open.
 * @returns {Promise<{ browser: CDPSession, kill: () => void, userDataDir: string }>}
 */
export async function launchChrome({ extensionDir, port = 9333, headless = true, extraArgs = [] }) {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome not found. Set CHROME_PATH.');

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'open-fullscreenshot-e2e-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    // Chrome 137+ ignores --load-extension while a remote-debugging port is
    // open unless this switch is present.
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--allow-file-access-from-files',
    '--window-size=1280,900',
    ...extraArgs,
    'about:blank'
  ];
  if (headless) args.unshift('--headless=new', '--disable-gpu');

  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = [];
  child.stderr.on('data', (b) => stderr.push(String(b)));

  // Wait for the endpoint to answer.
  let version = null;
  for (let i = 0; i < 100 && !version; i++) {
    try {
      version = await httpJson(port, '/json/version');
    } catch {
      await sleep(100);
    }
  }
  if (!version) {
    child.kill();
    throw new Error(`Chrome never opened the DevTools endpoint.\n${stderr.join('')}`);
  }

  const browser = await CDPSession.connect(version.webSocketDebuggerUrl);
  return {
    browser,
    version,
    userDataDir,
    stderr,
    kill() {
      try {
        browser.close();
      } catch {
        /* already gone */
      }
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      try {
        rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* Windows sometimes holds the profile briefly; harmless */
      }
    }
  };
}

/** One WebSocket connection, multiplexed over flat sessions. */
export class CDPSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const h of this.handlers.get(msg.method) || []) h(msg.params, msg.sessionId);
        for (const h of this.handlers.get('*') || []) h(msg, msg.sessionId);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new CDPSession(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  close() {
    this.ws.close();
  }

  /** Attach to a target and return its flat session id. */
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  /** Poll Target.getTargets until `predicate` matches or the timeout elapses. */
  async waitForTarget(predicate, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { targetInfos } = await this.send('Target.getTargets');
      const hit = targetInfos.find(predicate);
      if (hit) return hit;
      await sleep(200);
    }
    return null;
  }

  /** Open a page and return `{ targetId, sessionId }` with Runtime enabled. */
  async openPage(url) {
    const { targetId } = await this.send('Target.createTarget', { url });
    const sessionId = await this.attach(targetId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    return { targetId, sessionId };
  }

  /**
   * Evaluate an expression and return its JSON value, throwing on a page-side
   * exception so failures are never silently swallowed.
   */
  async eval(sessionId, expression, { awaitPromise = true } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise, returnByValue: true, userGesture: true },
      sessionId
    );
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'page exception');
    }
    return res.result?.value;
  }
}

export { sleep };
