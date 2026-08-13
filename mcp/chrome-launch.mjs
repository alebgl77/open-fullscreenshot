/**
 * Locating, launching and tearing down the Chrome instance the `cdp` backend
 * drives.
 *
 * The instance is deliberately NOT the user's everyday browser: Chrome 136 and
 * later refuse remote debugging on the default user-data-dir, so this launches a
 * separate, persistent profile under the user's local app data. That profile is
 * a second browser identity — `fullscreenshot_login` exists so the user can sign
 * in to it once, on purpose, rather than having it happen invisibly.
 *
 * Security-relevant flags that must NEVER appear here, each for its own reason:
 *   --remote-debugging-port / --remote-debugging-address
 *        opens a TCP socket any local process can drive; the pipe does not.
 *   --load-extension / --enable-unsafe-extension-debugging
 *        this backend runs the engine sources directly, never a side-loaded
 *        extension, and Chrome 137+ ignores the switch anyway.
 *   --allow-file-access-from-files
 *        present in test/cdp.mjs for the fixture harness; letting every local
 *        page read every other local file is not something a capture needs.
 * `assertNoForbiddenFlags` enforces this at runtime and test/mcp-cdp.mjs asserts
 * it from the outside.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpPipe } from './cdp-pipe.mjs';

/** Flags that would undo the transport's security properties. */
export const FORBIDDEN_FLAGS = [
  '--remote-debugging-port',
  '--remote-debugging-address',
  '--load-extension',
  '--enable-unsafe-extension-debugging',
  '--allow-file-access-from-files'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Locate a Chrome binary on this machine. `CHROME_PATH` wins, as in test/cdp.mjs.
 * @returns {string|null}
 */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'),
    process.env['ProgramFiles(x86)'] &&
      path.join(process.env['ProgramFiles(x86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

/** Per-user state root. Everything the bridge writes lives under this one dir. */
export function stateDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'OpenFullScreenshot');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'OpenFullScreenshot');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'open-fullscreenshot');
}

/** The persistent Chrome profile the cdp backend drives. */
export function profileDir() {
  return path.join(stateDir(), 'mcp-profile');
}

/** Default destination for captured images. */
export function defaultOutputDir() {
  return path.join(stateDir(), 'out');
}

/** mkdir -p, returning the path so callers can inline it. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** @throws {Error} when a caller tries to smuggle in a flag from the deny list. */
export function assertNoForbiddenFlags(args) {
  for (const arg of args) {
    const flag = String(arg).split('=')[0];
    if (FORBIDDEN_FLAGS.includes(flag)) {
      throw new Error(`refusing to launch Chrome with ${flag}`);
    }
  }
  return args;
}

function baseArgs({ profile, windowSize }) {
  return [
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--hide-crash-restore-bubble',
    `--window-size=${windowSize}`,
    'about:blank'
  ];
}

/**
 * A live Chrome plus its CDP pipe. One instance is reused for the lifetime of
 * the MCP server process; it is killed on exit, on SIGINT/SIGTERM, and — because
 * the transport is a pipe rather than a port — by Chrome itself as soon as the
 * descriptors close, which is what makes an abrupt `TerminateProcess` on Windows
 * safe rather than orphaning a browser.
 */
export class Browser {
  constructor(child, pipe, info) {
    this.child = child;
    this.pipe = pipe;
    this.info = info;
    this.dead = false;
    child.once('exit', () => {
      this.dead = true;
      pipe.close();
    });
  }

  /**
   * Open a tab and attach to it.
   * @returns {Promise<{ targetId: string, sessionId: string }>}
   */
  async openPage(url) {
    const { targetId } = await this.pipe.send('Target.createTarget', { url: url || 'about:blank' });
    const sessionId = await this.pipe.attach(targetId);
    await this.pipe.send('Page.enable', {}, sessionId);
    await this.pipe.send('Runtime.enable', {}, sessionId);
    return { targetId, sessionId };
  }

  async closePage(targetId) {
    try {
      await this.pipe.send('Target.closeTarget', { targetId }, undefined, 5000);
    } catch {
      /* the tab or the browser is already gone */
    }
  }

  /** Graceful `Browser.close`, then a hard kill if Chrome ignores it. */
  async close() {
    if (this.dead) return;
    try {
      await this.pipe.send('Browser.close', {}, undefined, 3000);
    } catch {
      /* fall through to the kill */
    }
    for (let i = 0; i < 20 && !this.dead; i++) await sleep(50);
    this.kill();
  }

  /** Synchronous teardown, safe to call from a `process.on('exit')` handler. */
  kill() {
    this.pipe.close();
    try {
      this.child.kill();
    } catch {
      /* already reaped */
    }
  }
}

/**
 * Spawn Chrome with the CDP pipe on inherited fds 3 and 4.
 * @param {Object} [options]
 * @param {boolean} [options.headful] show the window (default: headless)
 * @param {string}  [options.chromePath] explicit binary, else findChrome()
 * @param {string}  [options.profile] user-data-dir, else profileDir()
 * @param {string}  [options.windowSize] `WxH`
 * @param {number}  [options.timeoutMs] how long to wait for the first CDP reply
 * @returns {Promise<Browser>}
 */
export async function launchBrowser(options = {}) {
  const bin = options.chromePath || findChrome();
  if (!bin) {
    const error = new Error('Chrome was not found. Set CHROME_PATH to the chrome executable.');
    error.code = 'chrome_not_found';
    throw error;
  }

  const profile = ensureDir(options.profile || profileDir());
  const args = baseArgs({ profile, windowSize: options.windowSize || '1280,900' });
  if (!options.headful) args.unshift('--headless=new', '--disable-gpu');
  assertNoForbiddenFlags(args);

  // fds 0-2 as usual, then 3 (we write) and 4 (we read) for the CDP pipe.
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] });
  const stderr = [];
  if (child.stderr) child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
  if (child.stdout) child.stdout.resume();

  let exited = null;
  child.once('exit', (code) => {
    exited = code;
  });

  const pipe = new CdpPipe(child.stdio[3], child.stdio[4]);
  let info;
  try {
    info = await pipe.send('Browser.getVersion', {}, undefined, options.timeoutMs || 20000);
  } catch (err) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    const error = new Error(
      exited !== null
        ? `Chrome exited immediately (code ${exited}). Another Chrome is probably already using the ` +
          `Open FullScreenshot profile at ${profile} — close the login window and retry. ${stderr.join('').slice(-400)}`
        : `Chrome did not answer on the debugging pipe: ${err.message}`
    );
    error.code = 'capture_failed';
    throw error;
  }

  return new Browser(child, pipe, info);
}

/**
 * Open a normal, visible Chrome window on the capture profile and detach from
 * it, so the user can sign in to the sites they care about exactly once. No
 * debugging pipe is opened for this window: it is an ordinary browser session
 * whose cookies persist in the profile for later captures.
 * @returns {{ pid: number|undefined, profile: string }}
 */
export function launchLoginWindow({ chromePath, url } = {}) {
  const bin = chromePath || findChrome();
  if (!bin) {
    const error = new Error('Chrome was not found. Set CHROME_PATH to the chrome executable.');
    error.code = 'chrome_not_found';
    throw error;
  }
  const profile = ensureDir(profileDir());
  const args = assertNoForbiddenFlags([
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    url || 'about:blank'
  ]);
  const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return { pid: child.pid, profile };
}
