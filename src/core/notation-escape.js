const LIMITS = Object.freeze({
  PART_UNITS: 1024,
  MAX_PARTS: 32,
  REPLY_BYTES: 4096,
  PATTERN_UNITS: 256,
});

function assertScalarString(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('text contains a lone surrogate');
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('text contains a lone surrogate');
    }
  }
}

function tokenFor(text, index, codePoint, character) {
  if (codePoint === 0x0d) return '[CR]';
  if (codePoint === 0x0a) return '[LF]';
  if (codePoint === 0x09) return '[TAB]';
  if ((codePoint >= 0 && codePoint <= 0x1f) || codePoint === 0x7f) {
    return `\\x${codePoint.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  if (character === '\\') return '\\\\';
  if (character === '[' || character === ']' || character === '<' || character === '>') {
    return `\\${character}`;
  }
  if (character === '0' && (text[index + 1] === 'x' || text[index + 1] === 'X')) return '\\x30';
  if (codePoint === 0xfeff) return '\\xEF\\xBB\\xBF';
  if (character === '{') return '{{';
  if (character === '}') return '}}';
  return character;
}

function toNotationParts(text) {
  assertScalarString(text);
  if (text.length === 0 || Buffer.byteLength(text, 'utf8') > LIMITS.REPLY_BYTES) return null;

  const parts = [];
  let part = '';
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    const token = tokenFor(text, index, codePoint, character);
    if (part.length + token.length > LIMITS.PART_UNITS) {
      if (part.length > 0) parts.push(part);
      part = '';
      if (parts.length >= LIMITS.MAX_PARTS || token.length > LIMITS.PART_UNITS) return null;
    }
    part += token;
    index += character.length;
  }
  if (part.length > 0) parts.push(part);
  return parts.length > LIMITS.MAX_PARTS ? null : parts;
}

function toPattern(text) {
  assertScalarString(text);
  if (text.length === 0 || text.startsWith('\ufeff')) return null;
  let pattern = '';
  for (const character of text) {
    if (character === '{') pattern += '{{';
    else if (character === '}') pattern += '}}';
    else if (character === '*') pattern += '**';
    else pattern += character;
    if (pattern.length > LIMITS.PATTERN_UNITS) return null;
  }
  return pattern;
}

module.exports = { toNotationParts, toPattern, LIMITS };
