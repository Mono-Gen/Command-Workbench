// Test doubles shared by the connection and periodic-message tests.
const { EventEmitter } = require('node:events');

// A manual clock: timers fire only when the test advances time, so no real waiting happens.
function createFakeClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();

  function addTimer(fn, ms, repeat) {
    const id = nextId++;
    timers.set(id, { fn, due: current + ms, ms, repeat });
    return id;
  }

  return {
    now: () => current,
    scheduler: {
      setTimeout: (fn, ms) => addTimer(fn, ms, false),
      clearTimeout: (id) => { timers.delete(id); },
      setInterval: (fn, ms) => addTimer(fn, ms, true),
      clearInterval: (id) => { timers.delete(id); },
    },
    pendingTimers: () => timers.size,
    // Fires due timers in time order, moving "now" to each timer's due time.
    advance(ms) {
      const target = current + ms;
      for (;;) {
        let nextEntry = null;
        for (const [id, timer] of timers) {
          if (timer.due <= target && (!nextEntry || timer.due < nextEntry[1].due)) {
            nextEntry = [id, timer];
          }
        }
        if (!nextEntry) break;
        const [id, timer] = nextEntry;
        current = timer.due;
        if (timer.repeat) {
          timer.due += timer.ms;
        } else {
          timers.delete(id);
        }
        timer.fn();
      }
      current = target;
    },
  };
}

// Mimics the parts of net.Socket the connection code uses. The test drives it by emitting events.
class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.connectArgs = null;
    this.written = [];
    this.keepAliveCalls = [];
    this.destroyed = false;
    this.ended = false;
    // When true, end()/destroy() emit 'close' like a real socket does shortly after.
    this.autoClose = true;
    // When set, write() reports this error through its callback.
    this.writeError = null;
  }

  connect(options) {
    this.connectArgs = options;
  }

  write(buffer, callback) {
    this.written.push(Uint8Array.from(buffer));
    queueMicrotask(() => callback(this.writeError));
    return true;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.resumeCalls = (this.resumeCalls ?? 0) + 1;
  }

  setKeepAlive(enable, delay) {
    this.keepAliveCalls.push([enable, delay]);
  }

  end() {
    this.ended = true;
    if (this.autoClose) queueMicrotask(() => this.emit('close', false));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.autoClose) queueMicrotask(() => this.emit('close', false));
  }
}

// Lets already-queued microtasks (socket callbacks, promise chains) run.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

module.exports = { createFakeClock, FakeSocket, flush };
