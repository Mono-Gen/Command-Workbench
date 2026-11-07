const MAX_DATAGRAM_BYTES = 65507;
const RECOMMENDED_MAX_BYTES = 1472;

const TERMINATORS = Object.freeze({
  cr: Uint8Array.of(0x0d),
  lf: Uint8Array.of(0x0a),
  crlf: Uint8Array.of(0x0d, 0x0a),
});

function toMessage(bytes, terminator) {
  if (!(bytes instanceof Uint8Array) || !Object.hasOwn(TERMINATORS, terminator)) {
    throw new TypeError('Invalid datagram message');
  }
  const ending = TERMINATORS[terminator];
  const matches = bytes.length >= ending.length
    && ending.every((byte, index) => bytes[bytes.length - ending.length + index] === byte);
  return Uint8Array.from(matches ? bytes.subarray(0, bytes.length - ending.length) : bytes);
}

function checkSendSize(length) {
  if (!Number.isInteger(length) || length < 0) throw new TypeError('Invalid datagram length');
  if (length === 0) return { ok: false, code: 'empty' };
  if (length > MAX_DATAGRAM_BYTES) return { ok: false, code: 'too_large' };
  return { ok: true, fragmentation: length > RECOMMENDED_MAX_BYTES };
}

module.exports = {
  MAX_DATAGRAM_BYTES,
  RECOMMENDED_MAX_BYTES,
  toMessage,
  checkSendSize,
};
