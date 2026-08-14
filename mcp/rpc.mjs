/**
 * MCP stdio transport: newline-delimited JSON, and a stdout that cannot be
 * polluted.
 *
 * Three things break hand-rolled stdio MCP servers, and all three are handled
 * here rather than at the call sites, because a call site only has to forget
 * once:
 *
 *   1. FRAMING. MCP over stdio is one complete JSON object per line, UTF-8 —
 *      NOT the LSP `Content-Length` framing. A read may deliver half a message,
 *      three messages, or a chunk that ends in the middle of a multi-byte
 *      character. `LineSplitter` buffers BYTES and only splits on 0x0A; since
 *      no UTF-8 continuation byte can be 0x0A, a character split across two
 *      chunks is reassembled before anything is decoded.
 *   2. STDOUT PURITY. One stray `console.log` and every client sees a protocol
 *      error. `installStdoutGuard()` hands the real `write` to the RPC layer and
 *      then re-points `process.stdout.write` at stderr, so a log line, a
 *      deprecation warning or a third-party banner lands on stderr instead of the
 *      channel. The guard is JavaScript-level, not descriptor-level: a caller that
 *      goes around it with `fs.writeSync(1, …)` or spawns a child with
 *      `stdio: 'inherit'` would still reach fd 1. Nothing in `mcp/` does either —
 *      Chrome is spawned with fd 1 explicitly NOT inherited — and nothing may
 *      start to.
 *   3. NOTIFICATIONS. A message with no `id` MEMBER is a notification and must
 *      never be answered. A message that carries `id: null` is, per JSON-RPC 2.0,
 *      a (discouraged) request and is answered; `dispatch` additionally keeps
 *      every `notifications/*` method silent whatever its id looks like.
 *
 * Node 22, zero dependencies.
 */

export const JSONRPC_VERSION = '2.0';

/** JSON-RPC 2.0 error codes (the only ones this server produces). */
export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
});

/**
 * A single line beyond this is treated as a lost stream rather than buffered
 * forever. Generous, because a client may legitimately send a large tool
 * argument, but bounded, because an unterminated stream must not eat all memory.
 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/**
 * Byte-level newline framing, resilient to arbitrary chunk boundaries.
 *
 * Usage: `for (const line of splitter.push(chunk)) { … }`, then check
 * `splitter.dropped` to report the bytes that had to be discarded.
 */
export class LineSplitter {
  /** @param {{ maxLineBytes?: number }} [options] */
  constructor(options = {}) {
    this.maxLineBytes = options.maxLineBytes || MAX_LINE_BYTES;
    this.buffer = Buffer.alloc(0);
    /** Lines discarded because they exceeded the ceiling. */
    this.dropped = 0;
    /**
     * Set once a line blows the ceiling, and cleared at that line's terminating
     * newline. Without it, the TAIL of the discarded line would be handed on as
     * if it were a message of its own and draw a second, meaningless parse error.
     */
    this.skipping = false;
  }

  /**
   * @param {Buffer|Uint8Array|string} chunk
   * @returns {string[]} the complete lines contained in everything seen so far
   */
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;

    const lines = [];
    for (;;) {
      const index = this.buffer.indexOf(0x0a);
      if (index < 0) break;
      let line = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (this.skipping) {
        // That newline ended the oversize line; resume with the next one.
        this.skipping = false;
        continue;
      }
      // Tolerate CRLF: some Windows clients pipe through a text-mode filter.
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      const text = line.toString('utf8').trim();
      if (text) lines.push(text);
    }

    if (this.buffer.length > this.maxLineBytes) {
      this.buffer = Buffer.alloc(0);
      if (!this.skipping) this.dropped++;
      this.skipping = true;
    } else if (this.skipping) {
      // Still inside the oversize line: keep nothing, wait for the newline.
      this.buffer = Buffer.alloc(0);
    }
    return lines;
  }
}

/**
 * Take ownership of stdout for the protocol and send everything else to stderr.
 * @returns {(message: Object) => void} the only function that may write to stdout
 */
export function installStdoutGuard() {
  const stdout = process.stdout;
  const write = stdout.write.bind(stdout);

  stdout.write = function redirected(chunk, encoding, callback) {
    try {
      return process.stderr.write(chunk, encoding, callback);
    } catch {
      // stderr can be closed (a client that only wired stdin/stdout). Swallow:
      // a failed log line must never take the server down.
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    }
  };

  return function send(message) {
    try {
      write(JSON.stringify(message) + '\n');
    } catch (error) {
      // A dead stdout means the client is gone; there is nowhere left to report.
      process.stderr.write(`[open-fullscreenshot-mcp] cannot write to stdout: ${error && error.message}\n`);
    }
  };
}

/** @returns {Object} a JSON-RPC success response. */
export function result(id, value) {
  return { jsonrpc: JSONRPC_VERSION, id, result: value };
}

/** @returns {Object} a JSON-RPC error response. `id` is null for unparseable input. */
export function failure(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id: id === undefined ? null : id, error };
}

/**
 * A request carries an `id` MEMBER and expects exactly one response; a
 * notification omits it and must be answered with silence.
 *
 * JSON-RPC 2.0 defines a Notification as a request object *without* an `id`
 * member — `id: null` is a discouraged but real request, and a client that emits
 * one waits forever if it is treated as a notification. Presence of the key is
 * therefore what decides, not its value. `dispatch` layers a second rule on top:
 * a `notifications/*` method is silent whatever its id looks like.
 * @returns {boolean}
 */
export function isNotification(message) {
  if (!message || typeof message !== 'object') return true;
  return !('id' in message) || message.id === undefined;
}
