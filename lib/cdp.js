/**
 * Minimal Chrome DevTools Protocol client over the global WebSocket.
 *
 * One connection owns the browser-level endpoint; every page operation carries
 * the flattened session id of the attached page target. Requests are matched by
 * id, events are dispatched to registered listeners, and every failure rejects
 * with the CDP error text so tools can report it verbatim.
 */

/** Resolve a command or event once its wire message settles. */
export class CdpConnection {
  constructor(url) {
    if (typeof WebSocket !== 'function') {
      throw new Error('this Host has no global WebSocket; the controlled browser cannot be driven');
    }
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    this.reason = undefined;
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => { resolve(); }, { once: true });
      this.socket.addEventListener('error', (event) => {
        reject(new Error('devtools socket error: ' + (event && event.message ? event.message : 'unavailable')));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        if (waiter === undefined) return;
        this.pending.delete(message.id);
        if (message.error !== undefined) {
          waiter.reject(new Error(message.error.message + ' (' + String(message.error.code) + ')'));
        } else {
          waiter.resolve(message.result);
        }
        return;
      }
      if (typeof message.method !== 'string') return;
      const handlers = this.listeners.get(message.method);
      if (handlers === undefined) return;
      for (const handler of [...handlers]) {
        try { handler(message.params, message.sessionId); } catch { /* a listener must not break dispatch */ }
      }
    });
    this.socket.addEventListener('close', () => { this.#shutdown(new Error('devtools socket closed')); });
    this.socket.addEventListener('error', () => { /* close follows */ });
  }

  #shutdown(error) {
    if (this.closed) return;
    this.closed = true;
    this.reason = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  /** Send one command and resolve its result. */
  send(method, params, sessionId) {
    if (this.closed) {
      return Promise.reject(this.reason === undefined ? new Error('devtools socket is closed') : this.reason);
    }
    const id = this.nextId++;
    const payload = { id, method };
    if (params !== undefined) payload.params = params;
    if (sessionId !== undefined) payload.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
    try {
      this.socket.send(JSON.stringify(payload));
    } catch (error) {
      this.pending.delete(id);
      return Promise.reject(error);
    }
    return promise;
  }

  /** Subscribe one event listener. */
  on(method, handler) {
    const set = this.listeners.get(method) || new Set();
    set.add(handler);
    this.listeners.set(method, set);
    return () => {
      const current = this.listeners.get(method);
      if (current === undefined) return;
      current.delete(handler);
      if (current.size === 0) this.listeners.delete(method);
    };
  }

  /** Resolve with the next matching event, or reject on timeout/close. */
  once(method, sessionId, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer;
      const off = this.on(method, (params, sid) => {
        if (sessionId !== undefined && sid !== sessionId) return;
        cleanup();
        resolve(params);
      });
      const cleanup = () => { clearTimeout(timer); off(); };
      timer = setTimeout(() => { cleanup(); reject(new Error('timed out waiting for ' + method)); }, timeoutMs === undefined ? 15000 : timeoutMs);
    });
  }

  /** Close the socket. */
  close() {
    this.#shutdown(new Error('devtools socket closed by the plugin'));
    try { this.socket.close(); } catch { /* already closed */ }
  }
}
