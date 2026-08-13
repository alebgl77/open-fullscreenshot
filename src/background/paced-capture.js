/**
 * Open FullScreenshot — adaptive pacer for chrome.tabs.captureVisibleTab.
 *
 * Chrome rate-limits captureVisibleTab and the exact ceiling is neither
 * documented nor stable across versions, so the interval is *learned* at
 * runtime: every quota rejection widens it, and the widened value survives for
 * the whole service-worker lifetime (module-level state) so a long stitch pays
 * the discovery cost only once.
 *
 * Classic script — attaches to globalThis.FS. Load protocol.js and util.js first.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  if (FS.PacedCapture) return;

  const INITIAL_INTERVAL = 60;
  const MAX_INTERVAL = 1200;
  const MAX_QUOTA_RETRIES = 8;
  /** Unknown, non-fatal failures (renderer busy, transient OOM) get a few tries. */
  const MAX_SOFT_RETRIES = 2;

  const QUOTA = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i;
  const FATAL = /Tab was closed|No tab with id|Cannot access|activeTab/i;

  let minInterval = INITIAL_INTERVAL;
  let lastCallAt = 0;
  /** Serializes concurrent callers so the interval is honoured, not raced. */
  let queue = Promise.resolve();

  function noop() {}

  function enqueue(task) {
    const result = queue.then(task, task);
    queue = result.then(noop, noop);
    return result;
  }

  /** One raw call. Rejects with the verbatim Chrome message so it can be classified. */
  function captureOnce(windowId, options) {
    return new Promise((resolve, reject) => {
      const args = [];
      if (typeof windowId === 'number') args.push(windowId);
      args.push(options);
      args.push((dataUrl) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || 'captureVisibleTab failed'));
          return;
        }
        if (!dataUrl) {
          reject(new Error('captureVisibleTab returned no data'));
          return;
        }
        resolve(dataUrl);
      });
      try {
        chrome.tabs.captureVisibleTab.apply(chrome.tabs, args);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async function paced(windowId, options) {
    // PNG always: the stitched image is encoded once, at export, so a lossy
    // format is never applied twice.
    const opts = Object.assign({}, options, { format: 'png' });
    let quotaRetries = 0;
    let softRetries = 0;

    for (;;) {
      const wait = minInterval - (Date.now() - lastCallAt);
      if (wait > 0) await FS.util.sleep(wait);

      lastCallAt = Date.now();
      try {
        const dataUrl = await captureOnce(windowId, opts);
        lastCallAt = Date.now();
        return dataUrl;
      } catch (error) {
        lastCallAt = Date.now();
        const message = String((error && error.message) || error || '');

        if (QUOTA.test(message)) {
          if (++quotaRetries > MAX_QUOTA_RETRIES) throw new Error(FS.ERR.QUOTA);
          minInterval = Math.min(MAX_INTERVAL, minInterval * 1.6 + 40);
          await FS.util.sleep(minInterval);
          continue;
        }
        if (FATAL.test(message)) throw new Error(FS.ERR.CAPTURE_FAILED);
        if (++softRetries > MAX_SOFT_RETRIES) throw new Error(FS.ERR.CAPTURE_FAILED);
        await FS.util.sleep(minInterval);
      }
    }
  }

  FS.PacedCapture = {
    /**
     * Capture the visible area of `windowId`, waiting out the quota if needed.
     * @param {number|undefined} windowId
     * @param {{format?: string}} [options]
     * @returns {Promise<string>} PNG data URL
     */
    capture(windowId, options) {
      return enqueue(() => paced(windowId, options || {}));
    },

    /** Forget the learned interval (used by tests and after a long idle). */
    reset() {
      minInterval = INITIAL_INTERVAL;
      lastCallAt = 0;
    },

    /** Current learned interval, ms — diagnostics only. */
    get interval() {
      return minInterval;
    }
  };
})();
