// A stand-in for a dgram socket: the test drives it by emitting events.
const { EventEmitter } = require('node:events');

class FakeUdp extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.bindArgs = null;
    this.connectArgs = null;
    this.sent = [];
    this.closed = false;
    this.localPort = 41000;
    this.heldSends = null; // when an array, send callbacks wait here
    this.sendError = null;
    this.throwOnSend = null;
  }

  bind(opts, callback) {
    this.bindArgs = opts;
    if (this.options.bindError) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('bind'), { code: this.options.bindError })));
      return;
    }
    queueMicrotask(() => { this.emit('listening'); if (callback) callback(); });
  }

  connect(port, address) {
    this.connectArgs = { port, address };
    queueMicrotask(() => this.emit('connect'));
  }

  address() { return { port: this.localPort, address: '0.0.0.0' }; }

  send(buffer, ...rest) {
    const callback = rest.at(-1);
    const target = rest.length === 3 ? { port: rest[0], address: rest[1] } : null;
    if (this.throwOnSend) throw this.throwOnSend;
    this.sent.push({ bytes: Uint8Array.from(buffer), target });
    if (this.heldSends) this.heldSends.push(callback);
    else queueMicrotask(() => callback(this.sendError));
  }

  close() {
    if (this.closed) throw Object.assign(new Error('not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
    this.closed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

module.exports = { FakeUdp };
