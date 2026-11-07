// Validation for the saved command list (the JSON next to the executable).
// Pure: no file access here. The schema is strict on purpose: an unknown field is an error,
// because silently dropping it on the next save would destroy the user's data.
const SCHEMA_VERSION = 1;

const LIMITS = {
  maxDevices: 200,
  maxCommandsPerDevice: 1000,
  maxNameLength: 100,
  maxHostLength: 253,
  // UTF-8 bytes, matching the 64 KiB send limit (UTF-16 length would let 4-byte characters through).
  maxTextBytes: 65536,
  // Total of all command texts. Without it the per-command limits would allow gigabytes in total.
  maxStoreTextBytes: 5 * 1024 * 1024,
};

const MODES = ['text', 'hex'];
const TERMINATORS = ['none', 'cr', 'lf', 'crlf'];
const KINDS = ['query', 'set'];

const ROOT_FIELDS = ['schemaVersion', 'devices'];
// transport / localPort / acceptAnySource are optional (UDP settings of a device).
const DEVICE_FIELDS = ['name', 'host', 'port', 'transport', 'localPort', 'acceptAnySource', 'commands'];
const COMMAND_FIELDS = ['name', 'text', 'mode', 'appendTerminator', 'kind', 'expectsReply'];

function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, devices: [] };
}

// Plain data only: an object that merely inherits its fields (Object.create(template)) must not
// pass, because its fields would not survive JSON.stringify.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidName(value) {
  return typeof value === 'string'
    && value.length <= LIMITS.maxNameLength
    && value.trim().length >= 1;
}

// Names that differ only by case, surrounding spaces or Unicode form look identical in a
// selection list, so they count as duplicates. The stored name keeps its original spelling.
function nameKey(name) {
  return name.trim().normalize('NFC').toLowerCase();
}

function isValidHost(value) {
  // No whitespace or control characters: they cannot be part of a host name or address.
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= LIMITS.maxHostLength
    && /^[^\s\u0000-\u001f\u007f]+$/.test(value);
}

function checkUnknownFields(object, allowed, path, errors) {
  if (Object.keys(object).some((key) => !allowed.includes(key))) {
    errors.push({ path, code: 'unknown_field' });
  }
}

function validateCommand(command, path, seenNames, errors, budget) {
  if (budget.exceeded) return null;
  if (!isPlainObject(command)) {
    errors.push({ path, code: 'not_an_object' });
    return null;
  }
  checkUnknownFields(command, COMMAND_FIELDS, path, errors);

  if (!isValidName(command.name)) {
    errors.push({ path: `${path}.name`, code: 'invalid_name' });
  } else if (seenNames.has(nameKey(command.name))) {
    errors.push({ path: `${path}.name`, code: 'duplicate_name' });
  } else {
    seenNames.add(nameKey(command.name));
  }
  const textBytes = typeof command.text === 'string' ? Buffer.byteLength(command.text, 'utf8') : 0;
  if (typeof command.text !== 'string' || command.text.length < 1 || textBytes > LIMITS.maxTextBytes) {
    errors.push({ path: `${path}.text`, code: 'invalid_text' });
  } else {
    budget.bytes += textBytes;
    if (budget.bytes > LIMITS.maxStoreTextBytes) budget.exceeded = true;
  }
  if (!MODES.includes(command.mode)) {
    errors.push({ path: `${path}.mode`, code: 'invalid_mode' });
  }
  if (!TERMINATORS.includes(command.appendTerminator)) {
    errors.push({ path: `${path}.appendTerminator`, code: 'invalid_terminator' });
  }
  const hasKind = command.kind !== undefined;
  if (hasKind && !KINDS.includes(command.kind)) {
    errors.push({ path: `${path}.kind`, code: 'invalid_kind' });
  }
  if (command.expectsReply !== undefined && typeof command.expectsReply !== 'boolean') {
    errors.push({ path: `${path}.expectsReply`, code: 'invalid_expects_reply' });
  }

  const normalized = {
    name: command.name,
    text: command.text,
    mode: command.mode,
    appendTerminator: command.appendTerminator,
    // Preserve the legacy default for set commands; new commands default to expecting a reply.
    expectsReply: typeof command.expectsReply === 'boolean' ? command.expectsReply : !hasKind || command.kind !== 'set',
  };
  if (hasKind) normalized.kind = command.kind;
  return normalized;
}

function validateDevice(device, path, seenNames, errors, budget) {
  if (!isPlainObject(device)) {
    errors.push({ path, code: 'not_an_object' });
    return null;
  }
  checkUnknownFields(device, DEVICE_FIELDS, path, errors);

  if (!isValidName(device.name)) {
    errors.push({ path: `${path}.name`, code: 'invalid_name' });
  } else if (seenNames.has(nameKey(device.name))) {
    errors.push({ path: `${path}.name`, code: 'duplicate_name' });
  } else {
    seenNames.add(nameKey(device.name));
  }
  if (!isValidHost(device.host)) {
    errors.push({ path: `${path}.host`, code: 'invalid_host' });
  }
  if (!Number.isInteger(device.port) || device.port < 1 || device.port > 65535) {
    errors.push({ path: `${path}.port`, code: 'invalid_port' });
  }

  let transport = 'tcp';
  if (device.transport !== undefined) {
    if (device.transport !== 'tcp' && device.transport !== 'udp') {
      errors.push({ path: `${path}.transport`, code: 'invalid_transport' });
    } else {
      transport = device.transport;
    }
  }
  let localPort;
  if (device.localPort !== undefined) {
    const valid = Number.isInteger(device.localPort) && (device.localPort === 0 || (device.localPort >= 1024 && device.localPort <= 65535));
    if (!valid) errors.push({ path: `${path}.localPort`, code: 'invalid_local_port' });
    else localPort = device.localPort;
  }
  let acceptAnySource;
  if (device.acceptAnySource !== undefined) {
    if (typeof device.acceptAnySource !== 'boolean') errors.push({ path: `${path}.acceptAnySource`, code: 'invalid_accept_any_source' });
    else acceptAnySource = device.acceptAnySource;
  }
  if (transport !== 'udp' && (device.localPort !== undefined || device.acceptAnySource !== undefined)) {
    errors.push({ path, code: 'udp_only_field' });
  }

  const commands = [];
  if (!Array.isArray(device.commands)) {
    errors.push({ path: `${path}.commands`, code: 'not_an_array' });
  } else if (device.commands.length > LIMITS.maxCommandsPerDevice) {
    errors.push({ path: `${path}.commands`, code: 'too_many' });
  } else {
    const commandNames = new Set();
    for (let index = 0; index < device.commands.length && !budget.exceeded; index += 1) {
      commands.push(validateCommand(device.commands[index], `${path}.commands[${index}]`, commandNames, errors, budget));
    }
  }

  const normalized = { name: device.name, host: device.host, port: device.port };
  // Only UDP devices carry the extra fields; a TCP device stays exactly as before.
  if (transport === 'udp') {
    normalized.transport = 'udp';
    if (localPort !== undefined) normalized.localPort = localPort;
    if (acceptAnySource !== undefined) normalized.acceptAnySource = acceptAnySource;
  }
  normalized.commands = commands;
  return normalized;
}

// Returns { ok: true, data } with a normalized copy, or { ok: false, errors: [{ path, code }] }.
function validateStore(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '$', code: 'not_an_object' }] };
  }

  const errors = [];
  checkUnknownFields(input, ROOT_FIELDS, '$', errors);

  if (typeof input.schemaVersion !== 'number' || !Number.isInteger(input.schemaVersion)) {
    errors.push({ path: 'schemaVersion', code: 'invalid_schema_version' });
  } else if (input.schemaVersion !== SCHEMA_VERSION) {
    // Never guess how to read a version we do not know.
    errors.push({ path: 'schemaVersion', code: 'unsupported_schema_version' });
  }

  const devices = [];
  if (!Array.isArray(input.devices)) {
    errors.push({ path: 'devices', code: 'not_an_array' });
  } else if (input.devices.length > LIMITS.maxDevices) {
    errors.push({ path: 'devices', code: 'too_many' });
  } else {
    const deviceNames = new Set();
    const budget = { bytes: 0, exceeded: false };
    for (let index = 0; index < input.devices.length && !budget.exceeded; index += 1) {
      devices.push(validateDevice(input.devices[index], `devices[${index}]`, deviceNames, errors, budget));
    }
    if (budget.exceeded) {
      // Report only this: the rest of the input was not examined.
      return { ok: false, errors: [{ path: '$', code: 'store_too_large' }] };
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data: { schemaVersion: SCHEMA_VERSION, devices } };
}

module.exports = { SCHEMA_VERSION, LIMITS, emptyStore, validateStore };
