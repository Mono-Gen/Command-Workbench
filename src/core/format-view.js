// Display model for the log: one cell per byte so hex and text stay aligned.
// Line terminators get their own kind so the UI can color them.
function formatCell(byte) {
  const hex = byte.toString(16).toUpperCase().padStart(2, '0');
  if (byte === 0x0d) {
    return { hex, char: '␍', kind: 'cr' };
  }
  if (byte === 0x0a) {
    return { hex, char: '␊', kind: 'lf' };
  }
  if (byte >= 0x20 && byte <= 0x7e) {
    return { hex, char: String.fromCharCode(byte), kind: 'printable' };
  }
  if (byte <= 0x1f || byte === 0x7f) {
    return { hex, char: '·', kind: 'control' };
  }
  return { hex, char: '.', kind: 'high' };
}

function formatView(bytes, { bytesPerRow = 16 } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('bytes must be a Uint8Array');
  }
  if (!Number.isInteger(bytesPerRow) || bytesPerRow <= 0) {
    throw new TypeError('bytesPerRow must be a positive integer');
  }

  const rows = [];
  for (let offset = 0; offset < bytes.length; offset += bytesPerRow) {
    rows.push({
      offset,
      cells: Array.from(bytes.subarray(offset, offset + bytesPerRow), formatCell),
    });
  }
  return rows;
}

function createDecoder() {
  return new TextDecoder('utf-8', { fatal: false });
}

// Why a stream: TCP may split one UTF-8 character across two chunks, so each connection
// needs a decoder that keeps the unfinished bytes between pushes.
function createTextStream() {
  let decoder = createDecoder();
  return {
    push(bytes) {
      return decoder.decode(bytes, { stream: true });
    },
    reset() {
      // Finalizing first ensures the old decoder cannot retain pending state.
      decoder.decode();
      decoder = createDecoder();
    },
  };
}

module.exports = { formatView, createTextStream };
