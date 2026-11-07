// Parses the notation used in device manuals ("[CR]", "<LF>", "0x0D", "\r") into the exact
// bytes to send. Pure and deterministic: see .tasks/phase1_controller/core_spec.md section 1.
const textEncoder = new TextEncoder();

const NAMED_BYTES = new Map([
  ['NUL', [0x00]], ['SOH', [0x01]], ['STX', [0x02]], ['ETX', [0x03]],
  ['EOT', [0x04]], ['ENQ', [0x05]], ['ACK', [0x06]], ['BEL', [0x07]],
  ['BS', [0x08]], ['TAB', [0x09]], ['HT', [0x09]], ['LF', [0x0a]],
  ['VT', [0x0b]], ['FF', [0x0c]], ['CR', [0x0d]], ['SO', [0x0e]],
  ['SI', [0x0f]], ['DLE', [0x10]], ['DC1', [0x11]], ['DC2', [0x12]],
  ['DC3', [0x13]], ['DC4', [0x14]], ['NAK', [0x15]], ['SYN', [0x16]],
  ['ETB', [0x17]], ['CAN', [0x18]], ['EM', [0x19]], ['SUB', [0x1a]],
  ['ESC', [0x1b]], ['FS', [0x1c]], ['GS', [0x1d]], ['RS', [0x1e]],
  ['US', [0x1f]], ['SP', [0x20]], ['DEL', [0x7f]], ['CRLF', [0x0d, 0x0a]],
]);

const TERMINATORS = {
  none: [],
  cr: [0x0d],
  lf: [0x0a],
  crlf: [0x0d, 0x0a],
};

function isHexDigit(char) {
  return char !== undefined && /^[0-9A-Fa-f]$/.test(char);
}

function isAsciiLetterOrDigit(char) {
  return char !== undefined && /^[0-9A-Za-z]$/.test(char);
}

// A message that is wrong in thousands of places is not shown thousands of times: the first ones
// are enough to fix it, and the work stays bounded.
const MAX_ERRORS = 1000;

function scanText(text) {
  const bytes = [];
  const errors = [];
  let i = 0;
  // Once a closing bracket is known to be missing after some position it is missing after every
  // later position too: searching again from each opening bracket would make this quadratic.
  const noCloserAfter = { ']': false, '>': false };

  while (i < text.length && errors.length < MAX_ERRORS) {
    if (text[i] === '\\') {
      if (i + 1 >= text.length) {
        errors.push({ position: i, length: 1, code: 'dangling_backslash' });
        i += 1;
        continue;
      }

      const escaped = text[i + 1];
      const simpleEscapes = {
        '\\': 0x5c, r: 0x0d, n: 0x0a, t: 0x09, 0: 0x00,
        '[': 0x5b, ']': 0x5d, '<': 0x3c, '>': 0x3e,
      };
      if (Object.hasOwn(simpleEscapes, escaped)) {
        bytes.push(simpleEscapes[escaped]);
        i += 2;
        continue;
      }

      if (escaped === 'x') {
        let digitCount = 0;
        while (digitCount < 2 && isHexDigit(text[i + 2 + digitCount])) {
          digitCount += 1;
        }
        if (digitCount < 2) {
          errors.push({ position: i, length: 2 + digitCount, code: 'invalid_hex_escape' });
          i += 2 + digitCount;
          continue;
        }
        bytes.push(Number.parseInt(text.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }

      errors.push({ position: i, length: 2, code: 'unknown_escape' });
      i += 2;
      continue;
    }

    if (text[i] === '[' || text[i] === '<') {
      const closer = text[i] === '[' ? ']' : '>';
      const closeIndex = noCloserAfter[closer] ? -1 : text.indexOf(closer, i + 1);
      if (closeIndex === -1) {
        noCloserAfter[closer] = true;
        errors.push({ position: i, length: 1, code: 'unclosed_bracket' });
        i += 1;
        continue;
      }

      const name = text.slice(i + 1, closeIndex);
      const tokenLength = closeIndex - i + 1;
      if (name.length === 0) {
        errors.push({ position: i, length: tokenLength, code: 'empty_name' });
      } else {
        const namedBytes = /^[0-9A-Za-z]+$/.test(name) ? NAMED_BYTES.get(name.toUpperCase()) : undefined;
        if (namedBytes === undefined) {
          errors.push({ position: i, length: tokenLength, code: 'unknown_name' });
        } else {
          bytes.push(...namedBytes);
        }
      }
      i = closeIndex + 1;
      continue;
    }

    // A "0x" directly after a letter or digit is ordinary text (e.g. "abc0x0D"), because
    // treating it as a byte there would silently change what a beginner typed.
    if (
      text[i] === '0'
      && (text[i + 1] === 'x' || text[i + 1] === 'X')
      && (i === 0 || !isAsciiLetterOrDigit(text[i - 1]))
    ) {
      let end = i + 2;
      while (isHexDigit(text[end])) {
        end += 1;
      }
      const digitCount = end - (i + 2);
      if (digitCount !== 2) {
        errors.push({ position: i, length: end - i, code: 'invalid_hex_literal' });
      } else {
        bytes.push(Number.parseInt(text.slice(i + 2, end), 16));
      }
      i = end;
      continue;
    }

    const codeUnit = text.charCodeAt(i);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = text.charCodeAt(i + 1);
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        bytes.push(...textEncoder.encode(text.slice(i, i + 2)));
        i += 2;
      } else {
        errors.push({ position: i, length: 1, code: 'lone_surrogate' });
        i += 1;
      }
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      errors.push({ position: i, length: 1, code: 'lone_surrogate' });
      i += 1;
      continue;
    }

    bytes.push(...textEncoder.encode(text[i]));
    i += 1;
  }

  return { bytes, errors };
}

function scanHex(text) {
  const bytes = [];
  const errors = [];
  const tokenPattern = /[^ \t\r\n]+/g;

  for (const match of text.matchAll(tokenPattern)) {
    if (errors.length >= MAX_ERRORS) break;
    const token = match[0];
    const position = match.index;
    if (!/^[0-9A-Fa-f]+$/.test(token)) {
      errors.push({ position, length: token.length, code: 'invalid_hex_char' });
      continue;
    }
    if (token.length % 2 !== 0) {
      errors.push({ position, length: token.length, code: 'odd_hex_length' });
      continue;
    }
    for (let i = 0; i < token.length; i += 2) {
      bytes.push(Number.parseInt(token.slice(i, i + 2), 16));
    }
  }

  return { bytes, errors };
}

// The byte limit is only known after a full scan, so also cut off absurdly long input early.
// Any valid command that fits the byte limit is far shorter than this many UTF-16 units.
const MAX_INPUT_UNITS = 1048576;
const MAX_BYTES = 65536;

function parseCommand(text, { mode, appendTerminator }) {
  // Programmer errors throw; user input errors are returned as codes.
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string');
  }
  if (mode !== 'text' && mode !== 'hex') {
    throw new TypeError('Invalid mode');
  }
  if (!Object.hasOwn(TERMINATORS, appendTerminator)) {
    throw new TypeError('Invalid appendTerminator');
  }

  if (text.length === 0 || (mode === 'hex' && /^[ \t\r\n]*$/.test(text))) {
    return { ok: false, errors: [{ position: 0, length: 0, code: 'empty_input' }] };
  }
  if (text.length > MAX_INPUT_UNITS) {
    return { ok: false, errors: [{ position: 0, length: text.length, code: 'too_large' }] };
  }

  const { bytes, errors } = mode === 'text' ? scanText(text) : scanHex(text);
  if (bytes.length > MAX_BYTES) {
    return { ok: false, errors: [{ position: 0, length: text.length, code: 'too_large' }] };
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const warnings = [];
  if (
    appendTerminator !== 'none'
    && bytes.length > 0
    && (bytes[bytes.length - 1] === 0x0d || bytes[bytes.length - 1] === 0x0a)
  ) {
    warnings.push('terminator_doubled');
  }

  return {
    ok: true,
    bytes: Uint8Array.from([...bytes, ...TERMINATORS[appendTerminator]]),
    warnings,
  };
}

module.exports = { parseCommand };
