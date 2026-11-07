const TERMINATORS = new Set(['cr', 'lf', 'crlf']);

function createFramer({ terminator, maxMessageBytes = 4096 } = {}) {
  if (!TERMINATORS.has(terminator)) {
    throw new TypeError('Invalid terminator');
  }
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 0) {
    throw new TypeError('Invalid maxMessageBytes');
  }

  let pending = [];
  let pendingCr = false;
  let discarding = false;
  let discardPendingCr = false;

  function reset() {
    pending = [];
    pendingCr = false;
    discarding = false;
    discardPendingCr = false;
  }

  function emitMessage(events) {
    events.push({ type: 'message', bytes: Uint8Array.from(pending) });
    pending = [];
  }

  function appendData(byte, events) {
    if (pending.length === maxMessageBytes) {
      pending = [];
      discarding = true;
      events.push({ type: 'overflow' });
      return false;
    }
    pending.push(byte);
    return true;
  }

  function discardCrLfByte(byte) {
    if (discardPendingCr && byte === 0x0a) {
      discarding = false;
      discardPendingCr = false;
      return;
    }
    discardPendingCr = byte === 0x0d;
  }

  function push(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError('bytes must be a Uint8Array');
    }

    const events = [];
    for (const byte of bytes) {
      if (discarding) {
        if (terminator === 'crlf') {
          discardCrLfByte(byte);
        } else if ((terminator === 'cr' && byte === 0x0d)
          || (terminator === 'lf' && byte === 0x0a)) {
          discarding = false;
        }
        continue;
      }

      if (terminator === 'cr' || terminator === 'lf') {
        const endByte = terminator === 'cr' ? 0x0d : 0x0a;
        if (byte === endByte) {
          emitMessage(events);
        } else {
          appendData(byte, events);
        }
        continue;
      }

      if (pendingCr) {
        pendingCr = false;
        if (byte === 0x0a) {
          emitMessage(events);
          continue;
        }
        if (!appendData(0x0d, events)) {
          discardCrLfByte(byte);
          continue;
        }
      }

      if (byte === 0x0d) {
        pendingCr = true;
      } else {
        appendData(byte, events);
      }
    }
    return events;
  }

  return { push, reset };
}

module.exports = { createFramer };
