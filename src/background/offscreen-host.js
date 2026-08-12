/**
 * FullShot — lifecycle of the offscreen stitching document.
 *
 * A service worker has no DOM, so every canvas operation happens in a hidden
 * offscreen document. Chrome allows exactly ONE per extension, and creating a
 * second one throws; two overlapping ensure() calls are therefore a real race
 * and are collapsed onto a single in-flight promise here.
 *
 * Classic script — attaches to globalThis.FS. Load protocol.js first.
 */
(function () {
  'use strict';

  const FS = (globalThis.FS = globalThis.FS || {});
  if (FS.Offscreen) return;

  const PATH = 'src/offscreen/offscreen.html';
  const REASONS = ['BLOBS', 'CLIPBOARD'];
  const JUSTIFICATION =
    'Stitches the captured tab frames onto a canvas, encodes the result as a ' +
    'Blob and copies it to the clipboard. Both need DOM APIs a service worker lacks.';
  /** Chrome's wording when a second document is requested while one exists. */
  const DUPLICATE = /single offscreen document/i;

  let creating = null;

  async function documentExists() {
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === 'function') {
      try {
        return await chrome.offscreen.hasDocument();
      } catch (error) {
        // Older builds reject instead of answering; fall through to getContexts.
        console.debug('FullShot: hasDocument unavailable', error);
      }
    }
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [chrome.runtime.getURL(PATH)]
      });
      return contexts.length > 0;
    }
    return false;
  }

  FS.Offscreen = {
    /** @returns {Promise<boolean>} */
    isOpen() {
      return documentExists();
    },

    /**
     * Guarantee the offscreen document exists. Safe to call concurrently and
     * repeatedly: parallel callers await the same creation.
     * @returns {Promise<void>}
     */
    async ensure() {
      if (creating) {
        await creating;
        return;
      }
      if (await documentExists()) return;

      creating = chrome.offscreen
        .createDocument({ url: PATH, reasons: REASONS, justification: JUSTIFICATION })
        .catch((error) => {
          // Lost the race against another ensure(): the document we wanted now
          // exists, which is exactly the postcondition asked for.
          if (DUPLICATE.test(String((error && error.message) || error))) return;
          throw error;
        })
        .finally(() => {
          creating = null;
        });

      await creating;
    },

    /**
     * Send one message to the offscreen document and unwrap its reply.
     * @param {string} type one of the OFF_* message names from protocol.js
     * @param {Object} [payload]
     * @returns {Promise<Object>} the reply, minus the `{ error }` convention
     */
    async send(type, payload) {
      await FS.Offscreen.ensure();
      const message = Object.assign({ target: FS.TARGET.OFFSCREEN, type }, payload);
      const reply = await chrome.runtime.sendMessage(message);
      if (reply && reply.error) throw new Error(reply.error);
      return reply;
    },

    /** Tear the document down. Never throws — a missing document is a success. */
    async close() {
      creating = null;
      try {
        if (await documentExists()) await chrome.offscreen.closeDocument();
      } catch (error) {
        console.debug('FullShot: offscreen already closed', error);
      }
    }
  };
})();
