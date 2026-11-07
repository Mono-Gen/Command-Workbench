// A stand-in for net.Server: the test hands it connections instead of the network.
const { EventEmitter } = require('node:events');
const { FakeSocket } = require('./fakes');

class FakeServer extends EventEmitter {
  constructor(handler, options = {}) {
    super();
    this.handler = handler;
    this.listenOptions = null;
    this.closed = false;
    // Set to an error code to make listen() fail like a busy port.
    this.failWith = options.failWith ?? null;
    this.port = options.port ?? 5555;
    // When false, close() never calls back (a server that is slow to release its port).
    this.autoClose = true;
    this.closeCallback = null;
  }

  listen(options, callback) {
    this.listenOptions = options;
    queueMicrotask(() => {
      if (this.failWith) this.emit('error', Object.assign(new Error('listen failed'), { code: this.failWith }));
      else callback();
    });
  }

  address() {
    return { port: this.port };
  }

  close(callback) {
    this.closed = true;
    this.closeCallback = callback;
    if (this.autoClose) queueMicrotask(callback);
  }

  // Creates a fake client socket and hands it to the server, like an accepted connection.
  accept({ remoteAddress = '192.0.2.50', remotePort = 40000 } = {}) {
    const socket = new FakeSocket();
    socket.remoteAddress = remoteAddress;
    socket.remotePort = remotePort;
    socket.setNoDelay = () => {};
    this.handler(socket);
    return socket;
  }
}

module.exports = { FakeServer };
