/**
 * Chrome DevTools Protocol over `--remote-debugging-pipe`.
 *
 * Chrome reads CDP requests from inherited fd 3 and writes responses to fd 4, as
 * NUL-delimited UTF-8 JSON. No TCP port is opened, so — unlike
 * `--remote-debugging-port` — there is nothing on the machine for another local
 * process to connect to and nothing for a web page to reach. Authentication is
 * process ancestry: only the parent that spawned Chrome holds those descriptors.
 *
 * This is the same session shape as `CDPSession` in test/cdp.mjs, minus the
 * WebSocket. Node 22, zero dependencies.
 */

/** A single CDP message may not exceed this before we treat the stream as lost. */
const MAX_MESSAGE_BYTES = 512 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * One CDP connection, multiplexed over flat sessions
 * (`Target.attachToTarget { flatten: true }`).
 */
export class CdpPipe {
  /**
   * @param {import('node:stream').Writable} writable Chrome's fd 3.
   * @param {import('node:stream').Readable} readable Chrome's fd 4.
   */
  constructor(writable, readable) {
    this.writable = writable;
    this.readable = readable;
    this.nextId = 1;
    /** @type {Map<number, { resolve: Function, reject: Function, timer: any }>} */
    this.pending = new Map();
    /** @type {Map<string, Function[]>} */
    this.handlers = new Map();
    this.closed = false;
    this.buffer = Buffer.alloc(0);

    readable.on('data', (chunk) => this.#ingest(chunk));
    readable.on('end', () => this.#fail(new Error('CDP pipe closed by Chrome')));
    readable.on('error', (err) => this.#fail(err));
    writable.on('error', (err) => this.#fail(err));
  }

  /** Reassemble NUL-delimited frames across arbitrary chunk boundaries. */
  #ingest(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    let index;
    while ((index = this.buffer.indexOf(0)) >= 0) {
      const frame = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (frame.length === 0) continue;
      let message;
      try {
        message = JSON.parse(frame.toString('utf8'));
      } catch (err) {
        // A malformed frame is Chrome's problem, not a reason to die.
        this.emit('__parse_error', { error: String(err) });
        continue;
      }
      this.#deliver(message);
    }
    if (this.buffer.length > MAX_MESSAGE_BYTES) {
      this.#fail(new Error('CDP frame exceeded the size ceiling'));
    }
  }

  #deliver(message) {
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
      else entry.resolve(message.result);
      return;
    }
    if (message.method) this.emit(message.method, message.params, message.sessionId);
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.emit('__closed', { error: String(error && error.message ? error.message : error) });
  }

  /**
   * Send one CDP command.
   * @param {string} method
   * @param {Object} [params]
   * @param {string} [sessionId] flat session, omitted for browser-level calls
   * @param {number} [timeoutMs]
   * @returns {Promise<Object>}
   */
  send(method, params = {}, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error(`CDP pipe is closed (${method})`));
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.writable.write(JSON.stringify(payload) + '\0');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  /** @param {string} method CDP event name, or one of the internal `__*` events. */
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
    return () => {
      const list = this.handlers.get(method) || [];
      const at = list.indexOf(handler);
      if (at >= 0) list.splice(at, 1);
    };
  }

  emit(method, params, sessionId) {
    for (const handler of (this.handlers.get(method) || []).slice()) {
      try {
        handler(params, sessionId);
      } catch (err) {
        this.emit('__handler_error', { method, error: String(err) });
      }
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.writable.end();
    } catch {
      /* Chrome already went away */
    }
  }

  /** Attach to a target and return its flat session id. */
  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  /**
   * Evaluate an expression, optionally inside one execution context, and return
   * its JSON value. A page-side exception is rethrown rather than swallowed.
   * @returns {Promise<any>}
   */
  async evaluate(sessionId, expression, { awaitPromise = true, contextId, timeoutMs } = {}) {
    const params = { expression, awaitPromise, returnByValue: true, userGesture: true };
    if (contextId) params.contextId = contextId;
    const res = await this.send('Runtime.evaluate', params, sessionId, timeoutMs);
    if (res.exceptionDetails) {
      const details = res.exceptionDetails;
      const description =
        (details.exception && (details.exception.description || details.exception.value)) ||
        details.text ||
        'page exception';
      throw new Error(String(description).split('\n')[0]);
    }
    return res.result ? res.result.value : undefined;
  }
}
