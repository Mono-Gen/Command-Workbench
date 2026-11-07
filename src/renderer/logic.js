// Pure helpers for the page. Loaded as a classic script in the browser (window.WbLogic) and as a
// CommonJS module in tests. No DOM access here, so everything can be tested without a browser.
(function register(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WbLogic = factory();
  }
}(this, () => {
  // Makes control characters visible in the text view. A log that hides CR/LF would defeat the
  // purpose of showing exactly what the device sent.
  function visibleControls(text) {
    let out = '';
    for (const char of text) {
      const code = char.codePointAt(0);
      if (char === '\r') out += '␍';
      else if (char === '\n') out += '␊';
      else if (char === '\t') out += '␉';
      else if (code < 0x20 || code === 0x7f) out += '·';
      else out += char;
    }
    return out;
  }

  const pad = (n, width) => String(n).padStart(width, '0');

  function formatClock(ms) {
    const d = new Date(ms);
    return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
  }

  const hexLine = (cells) => cells.map((c) => c.hex).join(' ');
  const charLine = (cells) => cells.map((c) => c.char).join('');

  function nextDefaultName(base, existingNames) {
    const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let i = 2; ; i += 1) {
      const candidate = `${base} ${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  const clone = (value) => JSON.parse(JSON.stringify(value));

  // ---- command list edits: pure, return a new object or null when the target is missing ----

  // The target of a device: name, host, port and, for UDP only, the transport and its settings.
  function deviceFields(device) {
    const fields = { name: device.name, host: device.host, port: device.port };
    if (device.transport === 'udp') {
      fields.transport = 'udp';
      if (device.localPort !== undefined) fields.localPort = device.localPort;
      if (device.acceptAnySource !== undefined) fields.acceptAnySource = device.acceptAnySource;
    }
    return fields;
  }

  function withDevice(data, oldName, device) {
    const next = clone(data);
    if (oldName === null) {
      next.devices.push({ ...deviceFields(device), commands: [] });
      return next;
    }
    const index = next.devices.findIndex((d) => d.name === oldName);
    if (index === -1) return null;
    next.devices[index] = { ...deviceFields(device), commands: next.devices[index].commands };
    return next;
  }

  function withoutDevice(data, name) {
    const index = data.devices.findIndex((d) => d.name === name);
    if (index === -1) return null;
    const next = clone(data);
    next.devices.splice(index, 1);
    return next;
  }

  function withCommand(data, deviceName, oldCommandName, command) {
    const next = clone(data);
    const device = next.devices.find((d) => d.name === deviceName);
    if (!device) return null;
    if (oldCommandName === null) {
      device.commands.push(clone(command));
      return next;
    }
    const index = device.commands.findIndex((c) => c.name === oldCommandName);
    if (index === -1) return null;
    device.commands[index] = clone(command);
    return next;
  }

  function withoutCommand(data, deviceName, commandName) {
    const next = clone(data);
    const device = next.devices.find((d) => d.name === deviceName);
    if (!device) return null;
    const index = device.commands.findIndex((c) => c.name === commandName);
    if (index === -1) return null;
    device.commands.splice(index, 1);
    return next;
  }

  // Turns a failed result from the main process into a message. `t(key, params)` returns the key
  // itself when a translation is missing, which lets this fall back instead of showing nothing.
  function describeFailure(result, t) {
    const unknown = (code) => t('err.unknown', { code });
    if (!result || typeof result.code !== 'string') return unknown('no_result');

    if (result.code === 'parse_error') {
      const first = Array.isArray(result.errors) ? result.errors[0] : null;
      const head = t('err.parse_error');
      return first ? `${head} ${t(`parse.${first.code}`, { position: first.position })}` : head;
    }
    if (result.code === 'blocked' && result.reason) {
      const key = `blocked.${result.reason}`;
      const text = t(key);
      return text === key ? unknown(result.reason) : text;
    }
    const key = `err.${result.code}`;
    const text = t(key, { errno: result.errno ?? '', code: result.code });
    return text === key ? unknown(result.code) : text;
  }

  // Rows from text copied out of a manual's command table (or a spreadsheet): one line per row, the
  // command and the reply separated by a tab. A terminator written in manual notation at the end of a
  // cell is dropped, because the table adds the terminator itself. Returns the rows and how many
  // cells had one removed, so the page can say so instead of changing text silently.
  // The hex spellings count only after a character that is not a letter or digit: that is the notation
  // parser's own rule ("abc0x0D" is ordinary text there).
  const TRAILING_TERMINATOR = /(?:\s*(?:\[(?:CR|LF|CRLF)\]|<(?:CR|LF|CRLF)>|\\r|\\n|\\x0[da]|(?<![0-9A-Za-z])0x0[da]))+\s*$/i;
  // A terminator is at the very end of a cell, so only the end is searched: a huge pasted cell cannot
  // make the pattern slow.
  const TAIL_LENGTH = 200;

  function parseTablePaste(text) {
    const rows = [];
    let stripped = 0;
    const clean = (cell) => {
      const trimmed = cell.trim();
      const head = trimmed.length > TAIL_LENGTH ? trimmed.slice(0, -TAIL_LENGTH) : '';
      const tail = trimmed.length > TAIL_LENGTH ? trimmed.slice(-TAIL_LENGTH) : trimmed;
      const without = (head + tail.replace(TRAILING_TERMINATOR, '')).trimEnd();
      if (without !== trimmed) stripped += 1;
      return without;
    };
    for (const line of String(text).split(/\r\n|\n|\r/)) {
      if (line.trim().length === 0) continue;
      const tab = line.indexOf('\t');
      const command = tab === -1 ? line : line.slice(0, tab);
      const reply = tab === -1 ? '' : line.slice(tab + 1).split('\t')[0];
      rows.push({ command: clean(command), reply: clean(reply) });
    }
    return { rows, stripped };
  }

  // Characters of a text-mode input that are not ASCII. They are still sent (as UTF-8 bytes), but many
  // devices only understand ASCII, and text copied from a manual often carries full-width letters or
  // spaces that look like ASCII on screen. `position` counts characters from 1, like the parse errors.
  // kind: 'space' (spaces that are not U+0020), 'invisible' (zero-width), 'fullwidth' (full-width forms
  // of ASCII, U+FF01-U+FF5E) or 'other'.
  function classifyNonAscii(code) {
    if (code === 0x3000 || code === 0x00a0 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f) return 'space';
    if ((code >= 0x200b && code <= 0x200d) || code === 0xfeff) return 'invisible';
    if (code >= 0xff01 && code <= 0xff5e) return 'fullwidth';
    return 'other';
  }

  function findNonAscii(text, { limit = 3 } = {}) {
    const items = [];
    let total = 0;
    let position = 0;
    for (const char of String(text)) {
      position += 1;
      const code = char.codePointAt(0);
      if (code <= 0x7f) continue;
      total += 1;
      if (items.length < limit) {
        items.push({ position, char, code: code.toString(16).toUpperCase().padStart(4, '0'), kind: classifyNonAscii(code) });
      }
    }
    return { items, total };
  }

  return { findNonAscii, parseTablePaste, visibleControls, formatClock, hexLine, charLine, nextDefaultName, withDevice, withoutDevice, withCommand, withoutCommand, describeFailure };
}));
