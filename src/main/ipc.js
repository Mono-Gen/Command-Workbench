// IPC layer between the renderer and the application service.
// The renderer is untrusted: every argument is checked here (types, ranges, known values) and
// only known fields are passed on. Each channel maps to one fixed service call; there is no
// generic "call anything" channel.
const CHANNELS = [
  'init', 'saveData', 'importTable', 'parsePreview', 'connect', 'disconnect', 'setKeepAlive',
  'sendSaved', 'sendDirect', 'startPeriodic', 'stopPeriodic', 'setLocale',
  'deviceState', 'deviceLoadFile', 'deviceLoadSample', 'deviceRefreshSamples', 'deviceTablePreview', 'deviceTableUse', 'deviceTableSave', 'deviceStart', 'deviceStop', 'deviceSetFault', 'deviceCloseAll',
  'relayState', 'relayStart', 'relayStop', 'relayClearRecording', 'relaySaveRecording', 'relayLoadRecording',
  'relayDraft', 'relaySaveDraft', 'relayUseDraft',
];

const INVALID = Object.freeze({ ok: false, code: 'invalid_arguments' });
const MODES = ['text', 'hex'];
const TERMINATORS = ['none', 'cr', 'lf', 'crlf'];
const MAX_TEXT_UNITS = 1048576;
const DEVICE_HOSTS = ['127.0.0.1', '0.0.0.0'];
// 0 asks the OS for a free port; below 1024 is never useful for a practice device.
const isDevicePort = (port) => Number.isInteger(port) && (port === 0 || (port >= 1024 && port <= 65535));

// The table of the "make a definition" dialog. Cells are plain text; the service builds the
// definition and the validator judges it. The caps here only keep a hostile page from sending a
// huge value (the real limits are in table-definition.js and are reported per row).
const TABLE_TRANSPORTS = ['tcp', 'udp'];
const TABLE_MAX_ROWS = 600;
const TABLE_MAX_CELL = 2000;

function readTable(arg) {
  if (!isPlainWithKeys(arg, ['name', 'transport', 'terminator', 'greeting', 'unknownReply', 'rows'])) return null;
  const { name, transport, terminator, greeting, unknownReply, rows } = arg;
  if (![name, greeting, unknownReply].every((v) => typeof v === 'string' && v.length <= TABLE_MAX_CELL)) return null;
  if (!TABLE_TRANSPORTS.includes(transport) || !RELAY_TERMINATORS.includes(terminator)) return null;
  if (!Array.isArray(rows) || rows.length > TABLE_MAX_ROWS) return null;
  const copy = [];
  for (const row of rows) {
    if (!isPlainWithKeys(row, ['command', 'reply'])) return null;
    if (typeof row.command !== 'string' || typeof row.reply !== 'string') return null;
    if (row.command.length > TABLE_MAX_CELL || row.reply.length > TABLE_MAX_CELL) return null;
    copy.push({ command: row.command, reply: row.reply });
  }
  // Only the known fields are passed on.
  return { name, transport, terminator, greeting, unknownReply, rows: copy };
}

const RELAY_SOURCES = ['live', 'loaded'];
const RELAY_TERMINATORS = ['cr', 'lf', 'crlf'];

// A plain object (not an array, class instance or exotic object) with exactly the allowed keys.
function isPlainWithKeys(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(value);
  return required.every((k) => keys.includes(k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function readKeepAlive(value) {
  if (value === undefined) return { ok: true, value: undefined };
  if (!isObject(value) || typeof value.enabled !== 'boolean') return { ok: false };
  if (value.initialDelayMs !== undefined && !isInt(value.initialDelayMs, 1000, 3600000)) return { ok: false };
  return { ok: true, value: { enabled: value.enabled, initialDelayMs: value.initialDelayMs } };
}

function readInput(arg, { withReply }) {
  if (!isObject(arg)) return null;
  const { text, mode, appendTerminator, expectsReply } = arg;
  if (typeof text !== 'string' || text.length > MAX_TEXT_UNITS) return null;
  if (!MODES.includes(mode) || !TERMINATORS.includes(appendTerminator)) return null;
  if (!withReply) return { text, mode, appendTerminator };
  if (expectsReply !== undefined && typeof expectsReply !== 'boolean') return null;
  // `kind` (a classification claimed by the renderer) is dropped on purpose.
  return expectsReply === undefined ? { text, mode, appendTerminator } : { text, mode, appendTerminator, expectsReply };
}

const { isSampleId } = require('./sample-store');

function createIpcHandlers({ service, deviceService, relayService, setLocale, onError = (e) => console.error('[ipc] handler failed:', e) }) {
  // Turns exceptions into results so nothing leaks to the renderer as a stack trace.
  const guard = (fn) => async (arg) => {
    try {
      return await fn(arg);
    } catch (error) {
      if (error instanceof TypeError) return INVALID;
      onError(error);
      return { ok: false, code: 'internal_error' };
    }
  };

  return {
    init: guard(() => service.init()),

    saveData: guard((arg) => (isObject(arg) ? service.saveData(arg) : INVALID)),

    importTable: guard((arg) => {
      if (!isPlainWithKeys(arg, ['table', 'target'])) return INVALID;
      const table = readTable(arg.table);
      if (table === null || !isPlainWithKeys(arg.target, [], ['existing', 'create'])) return INVALID;
      const targetKeys = Object.keys(arg.target);
      if (targetKeys.length !== 1) return INVALID;
      let target;
      if (targetKeys[0] === 'existing') {
        if (typeof arg.target.existing !== 'string' || arg.target.existing.length < 1 || arg.target.existing.length > 100) return INVALID;
        target = { existing: arg.target.existing };
      } else {
        const create = arg.target.create;
        if (!isPlainWithKeys(create, ['name', 'host', 'port'])) return INVALID;
        if (typeof create.name !== 'string' || create.name.length < 1 || create.name.length > 100) return INVALID;
        if (typeof create.host !== 'string' || create.host.length < 1 || create.host.length > 253) return INVALID;
        if (!isInt(create.port, 1, 65535)) return INVALID;
        target = { create: { name: create.name, host: create.host, port: create.port } };
      }
      return service.importTable({ table, target });
    }),

    parsePreview: guard((arg) => {
      const input = readInput(arg, { withReply: false });
      return input ? service.parsePreview(input) : INVALID;
    }),

    connect: guard((arg) => {
      if (!isObject(arg) || typeof arg.host !== 'string' || typeof arg.port !== 'number') return INVALID;
      if (arg.timeoutMs !== undefined && !isInt(arg.timeoutMs, 1000, 60000)) return INVALID;
      const keepAlive = readKeepAlive(arg.keepAlive);
      if (!keepAlive.ok) return INVALID;
      if (arg.transport !== undefined && arg.transport !== 'tcp' && arg.transport !== 'udp') return INVALID;
      if (arg.transport === 'udp') {
        // Exactly the UDP fields: TCP-only settings (keepAlive) or unknown fields are refused, not dropped.
        const allowed = ['host', 'port', 'transport', 'timeoutMs', 'localPort', 'acceptAnySource'];
        if (Object.keys(arg).some((key) => !allowed.includes(key))) return INVALID;
        if (arg.localPort !== undefined && !isDevicePort(arg.localPort)) return INVALID;
        if (arg.acceptAnySource !== undefined && typeof arg.acceptAnySource !== 'boolean') return INVALID;
        return service.connect({
          transport: 'udp', host: arg.host, port: arg.port, timeoutMs: arg.timeoutMs, localPort: arg.localPort, acceptAnySource: arg.acceptAnySource,
        });
      }
      // The UDP-only settings make no sense for TCP: refuse instead of silently ignoring them.
      if (arg.localPort !== undefined || arg.acceptAnySource !== undefined) return INVALID;
      return service.connect({ host: arg.host, port: arg.port, timeoutMs: arg.timeoutMs, keepAlive: keepAlive.value });
    }),

    disconnect: guard(() => service.disconnect()),

    setKeepAlive: guard((arg) => {
      if (!isObject(arg) || typeof arg.enabled !== 'boolean') return INVALID;
      const delay = arg.initialDelayMs === undefined ? 30000 : arg.initialDelayMs;
      if (!isInt(delay, 1000, 3600000)) return INVALID;
      return service.setKeepAlive(arg.enabled, delay);
    }),

    sendSaved: guard((arg) => {
      if (!isObject(arg) || typeof arg.device !== 'string' || typeof arg.command !== 'string') return INVALID;
      return service.sendSaved({ device: arg.device, command: arg.command });
    }),

    sendDirect: guard((arg) => {
      const input = readInput(arg, { withReply: true });
      return input ? service.sendDirect(input) : INVALID;
    }),

    startPeriodic: guard((arg) => {
      if (!isObject(arg) || typeof arg.device !== 'string' || typeof arg.command !== 'string') return INVALID;
      if (!Number.isInteger(arg.intervalMs)) return INVALID;
      return service.startPeriodic({ device: arg.device, command: arg.command, intervalMs: arg.intervalMs });
    }),

    stopPeriodic: guard(() => service.stopPeriodic()),

    setLocale: guard((arg) => {
      if (arg !== 'ja' && arg !== 'en') return INVALID;
      setLocale(arg);
      return { ok: true };
    }),

    // ---- device role -------------------------------------------------------------------
    // The page never passes a path or a definition: it can only ask for a native file dialog, a
    // bundled sample by name, and start/stop with a host from a fixed list.
    deviceState: guard(() => deviceService.getState()),

    deviceLoadFile: guard(() => deviceService.loadFile()),

    // The id is a file name from the folder scan: only that exact shape is passed on, and the
    // service checks it against a new scan before anything is read.
    deviceLoadSample: guard((arg) => {
      if (!isPlainWithKeys(arg, ['id']) || !isSampleId(arg.id)) return INVALID;
      return deviceService.loadSample(arg.id);
    }),

    deviceRefreshSamples: guard((arg) => (arg === undefined ? deviceService.refreshSamples() : INVALID)),

    deviceTablePreview: guard((arg) => {
      const table = readTable(arg);
      return table === null ? INVALID : deviceService.tablePreview(table);
    }),

    deviceTableUse: guard((arg) => {
      const table = readTable(arg);
      return table === null ? INVALID : deviceService.tableUse(table);
    }),

    deviceTableSave: guard((arg) => {
      const table = readTable(arg);
      return table === null ? INVALID : deviceService.tableSave(table);
    }),

    deviceStart: guard((arg) => {
      if (!isObject(arg) || !DEVICE_HOSTS.includes(arg.host) || !isDevicePort(arg.port)) return INVALID;
      return deviceService.start({ host: arg.host, port: arg.port });
    }),

    deviceStop: guard(() => deviceService.stop()),

    deviceSetFault: guard((arg) => {
      if (!isObject(arg)) return INVALID;
      const faults = {};
      if (arg.dropNextReplies !== undefined) {
        if (!Number.isInteger(arg.dropNextReplies)) return INVALID;
        faults.dropNextReplies = arg.dropNextReplies;
      }
      if (arg.extraDelayMs !== undefined) {
        if (!Number.isInteger(arg.extraDelayMs)) return INVALID;
        faults.extraDelayMs = arg.extraDelayMs;
      }
      if (arg.muted !== undefined) {
        if (typeof arg.muted !== 'boolean') return INVALID;
        faults.muted = arg.muted;
      }
      // Ranges are checked by the server (0-1000 drops, 0-60000 ms). An object with no known field
      // is refused there: a call that changes nothing is a mistake.
      return deviceService.setFault(faults);
    }),

    deviceCloseAll: guard(() => deviceService.closeAll()),

    // ---- relay role --------------------------------------------------------------------
    // Same rules: no paths, recordings or definitions from the page. Files go through native
    // dialogs, the draft stays in the main process, and the relay target is re-checked there.
    relayState: guard((arg) => (arg === undefined ? relayService.getState() : INVALID)),

    relayStart: guard((arg) => {
      if (!isPlainWithKeys(arg, ['listenHost', 'listenPort', 'upstreamHost', 'upstreamPort'], ['transport'])) return INVALID;
      if (arg.transport !== undefined && arg.transport !== 'tcp' && arg.transport !== 'udp') return INVALID;
      if (!DEVICE_HOSTS.includes(arg.listenHost) || !isDevicePort(arg.listenPort)) return INVALID;
      if (typeof arg.upstreamHost !== 'string' || arg.upstreamHost.length < 1 || arg.upstreamHost.length > 253) return INVALID;
      if (!isInt(arg.upstreamPort, 1, 65535)) return INVALID;
      const options = {
        listenHost: arg.listenHost,
        listenPort: arg.listenPort,
        upstreamHost: arg.upstreamHost,
        upstreamPort: arg.upstreamPort,
      };
      if (arg.transport !== undefined) options.transport = arg.transport;
      return relayService.start(options);
    }),

    relayStop: guard((arg) => (arg === undefined ? relayService.stop() : INVALID)),

    relayClearRecording: guard((arg) => (arg === undefined ? relayService.clearRecording() : INVALID)),

    relaySaveRecording: guard((arg) => (arg === undefined ? relayService.saveRecording() : INVALID)),

    relayLoadRecording: guard((arg) => (arg === undefined ? relayService.loadRecording() : INVALID)),

    relayDraft: guard((arg) => {
      if (!isPlainWithKeys(arg, ['source'], ['terminator', 'quietMs']) || !RELAY_SOURCES.includes(arg.source)) return INVALID;
      if (arg.terminator !== undefined && !RELAY_TERMINATORS.includes(arg.terminator)) return INVALID;
      if (arg.quietMs !== undefined && !isInt(arg.quietMs, 0, 60000)) return INVALID;
      const options = { source: arg.source };
      if (arg.terminator !== undefined) options.terminator = arg.terminator;
      if (arg.quietMs !== undefined) options.quietMs = arg.quietMs;
      return relayService.draft(options);
    }),

    relaySaveDraft: guard((arg) => (arg === undefined ? relayService.saveDraft() : INVALID)),

    relayUseDraft: guard((arg) => (arg === undefined ? relayService.useDraft() : INVALID)),
  };
}

// Only the top frame of our own page may call the main process. Sub-frames and any other URL
// (including our page with a query string) are refused.
function isTrustedSender(event, pageUrl) {
  const frame = event && event.senderFrame;
  if (!frame || frame.parent !== null) return false;
  return typeof frame.url === 'string' && frame.url.split('#')[0] === pageUrl;
}

function registerIpc({ ipcMain, handlers, pageUrl, onUntrusted = () => {} }) {
  for (const name of CHANNELS) {
    ipcMain.handle(`wb:${name}`, (event, arg) => {
      if (!isTrustedSender(event, pageUrl)) {
        onUntrusted(name);
        return { ok: false, code: 'untrusted_sender' };
      }
      return handlers[name](arg);
    });
  }
}

module.exports = { CHANNELS, createIpcHandlers, isTrustedSender, registerIpc };
