// Application service for the device role (the main-process side of the "virtual device" tab).
//
// The page is untrusted. It never passes file paths or definitions: it asks this service to load
// one through a native file dialog or from the bundled samples, and to start/stop the server. All
// arguments are validated here again, and the dialog that guards "listen on all interfaces" is a
// native one owned by the main process.
const { parseDefinitionText } = require('../core/device-definition');
const { createDeviceEngine } = require('../core/device-engine');
const { isValidatedDefinition } = require('../core/device-definition');
const { formatView } = require('../core/format-view');
const { buildTableDefinition, tableDefinitionText } = require('../core/table-definition');
const { ALLOWED_HOSTS, isValidPort } = require('./device-server');

const STATE_TICK_MS = 1000;
// Event-driven state pushes are spaced at least this far apart; the tick delivers the latest one.
const MIN_PUSH_INTERVAL_MS = 250;
const MAX_ERRORS_TO_PAGE = 50;
// Scanning the samples folder reads up to 30 files: one scan at a time, and not more often than this.
const DEFAULT_LIMITS = { logEventsPerSecond: 200, sampleRefreshMinMs: 300 };
// These server events change what the page shows, so they also push a fresh state at once.
const STATE_EVENTS = new Set(['listening', 'stopped', 'connection_opened', 'connection_closed', 'variables', 'faults']);

function describeDefinition(definition, { source, fileName }) {
  const initial = createDeviceEngine(definition).getState().values;
  const variables = Object.entries(definition.variables).map(([name, spec]) => {
    const info = { name, type: spec.type, initial: initial[name] };
    if (spec.values) info.values = [...spec.values];
    if (spec.min !== undefined) info.min = spec.min;
    if (spec.max !== undefined) info.max = spec.max;
    if (spec.type === 'string' && spec.maxLength !== undefined) info.maxLength = spec.maxLength;
    return info;
  });
  const patterns = definition.commands.map((c) => c.sourcePattern);
  return {
    source,
    fileName,
    name: definition.name,
    transport: definition.transport,
    description: definition.description,
    terminator: definition.framing.terminator,
    hasGreeting: definition.greeting !== null,
    connection: { ...definition.connection },
    variables,
    commandCount: patterns.length,
    patterns,
    notificationCount: definition.notifications.length,
  };
}

function createDeviceService({
  server,
  // The UDP implementation; optional so that a TCP-only setup (and older tests) keeps working.
  udpServer = null,
  chooseFile,
  // { list(), read(id) }: see sample-store.js. The page only ever sees ids from its list.
  sampleStore,
  confirm,
  // Native "save as" dialog: ({ kind, makeText }) -> { ok, fileName } | { ok: false, code }. Optional.
  saveText = null,
  emit = () => {},
  now = Date.now,
  scheduler = { setInterval, clearInterval },
  limits = {},
}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let current = null; // { definition, info }
  let confirming = false;
  let stateTimer = null;
  // The last scan of the samples folder. getState() stays synchronous and returns this copy;
  // refreshSamples() makes a new scan.
  let samples = { source: null, dir: null, items: [], omitted: 0, error: null };
  let refreshing = null;
  let lastScanAt = -Infinity;
  // Loading a definition takes time (a dialog, a file read). Only the newest request may replace the
  // current definition, and starting is refused while one is on its way.
  let loadSeq = 0;
  let loadsInFlight = 0;
  let tableSaving = false;

  const allServers = () => (udpServer === null ? [server] : [server, udpServer]);
  const serverFor = (definition) => (definition.transport === 'udp' && udpServer !== null ? udpServer : server);
  const isActive = (state) => state.running === true || (state.lifecycle !== undefined && state.lifecycle !== 'idle');
  // The implementation that is running (or starting/stopping); when none is, the one the loaded
  // definition would use, so that the idle state has the right shape.
  const activeServer = () => {
    const busy = allServers().find((s) => isActive(s.getState()));
    if (busy) return busy;
    return current === null ? server : serverFor(current.definition);
  };

  // `running` is false while the server is still starting or already stopping, but its definition
  // must not be replaced then either.
  const isBusy = () => allServers().some((s) => isActive(s.getState()));

  // One decoder per direction and connection would be exact; the log text is only a convenience
  // next to the hex cells, so each entry is decoded on its own.
  const decodeText = (bytes) => new TextDecoder().decode(bytes);

  // ---- events to the page (rate limited: a LAN peer must not flood the screen) ------------

  let windowStart = 0;
  let sentInWindow = 0;
  let omitted = 0;

  function allowToPage() {
    const t = now();
    if (t - windowStart >= 1000) {
      windowStart = t;
      sentInWindow = 0;
    }
    if (sentInWindow >= lim.logEventsPerSecond) {
      omitted += 1;
      return false;
    }
    sentInWindow += 1;
    return true;
  }

  function flushOmitted() {
    if (omitted > 0) {
      emit('deviceEvent', { type: 'omitted', count: omitted });
      omitted = 0;
    }
  }

  // A burst of events (many connections, many commands) must not become a burst of full-state
  // messages to the page: pushes are spaced out, and a skipped one is delivered by the next tick.
  let lastPushAt = -Infinity;
  function pushState({ force = false } = {}) {
    const t = now();
    if (!force && t - lastPushAt < MIN_PUSH_INTERVAL_MS) return;
    lastPushAt = t;
    emit('deviceState', activeServer().getState());
  }

  function startTimers() {
    if (stateTimer === null) {
      stateTimer = scheduler.setInterval(() => {
        flushOmitted();
        pushState({ force: true });
      }, STATE_TICK_MS);
    }
  }

  function stopTimers() {
    if (stateTimer !== null) {
      scheduler.clearInterval(stateTimer);
      stateTimer = null;
    }
  }

  function handleServerEvent(event) {
    if (event.type === 'rx' || event.type === 'tx') {
      if (!allowToPage()) return;
      const bytes = event.bytes;
      emit('deviceLog', {
        dir: event.type,
        t: event.t,
        connectionId: event.connectionId,
        length: bytes.length,
        rows: formatView(bytes),
        text: decodeText(bytes),
        outcome: event.outcome ?? null,
        overflow: event.overflow === true,
        kind: event.kind ?? null,
      });
      return;
    }
    // Everything else is small and carries no payload bytes.
    const { bytes, ...rest } = event;
    // The server may stop by itself (an error after listening): the timers must follow its real state.
    if (event.type === 'stopped') {
      stopTimers();
      flushOmitted();
      emit('deviceEvent', rest);
      pushState({ force: true });
      return;
    }
    // Events that a peer on the network can produce at will are rate limited like the traffic.
    const peerDriven = event.type === 'dropped' || event.type === 'muted' || event.type === 'refused'
      || event.type === 'ignored' || event.type === 'idle' || event.type === 'send_error';
    if (peerDriven && !allowToPage()) return;
    emit('deviceEvent', event.type === 'dropped' || event.type === 'muted' ? { ...rest, length: bytes ? bytes.length : 0 } : rest);
    if (STATE_EVENTS.has(event.type)) pushState();
  }

  // ---- definition ---------------------------------------------------------------------

  function accept(text, meta) {
    const result = parseDefinitionText(text);
    if (!result.ok) {
      return {
        ok: false,
        code: 'invalid_definition',
        fileName: meta.fileName,
        errors: result.errors.slice(0, MAX_ERRORS_TO_PAGE),
        totalErrors: result.errors.length,
      };
    }
    const info = describeDefinition(result.definition, meta);
    current = { definition: result.definition, info };
    return { ok: true, info };
  }

  async function loadFile() {
    if (isBusy()) return { ok: false, code: 'running' };
    const seq = ++loadSeq;
    loadsInFlight += 1;
    try {
      const chosen = await chooseFile();
      if (!chosen.ok) return chosen;
      // The server may have been started while the dialog was open.
      if (isBusy()) return { ok: false, code: 'running' };
      if (seq !== loadSeq) return { ok: false, code: 'busy' };
      return accept(chosen.text, { source: 'file', fileName: chosen.fileName });
    } finally {
      loadsInFlight -= 1;
    }
  }

  // Scans the samples folder (or the bundled samples) again. One scan runs at a time (a caller that
  // asks meanwhile gets the same result), and a scan that just finished is not repeated at once.
  function refreshSamples() {
    if (refreshing !== null) return refreshing;
    if (now() - lastScanAt < lim.sampleRefreshMinMs) return Promise.resolve({ ok: samples.error === null, samples: { ...samples } });
    refreshing = (async () => {
      try {
        const found = await sampleStore.list();
        samples = {
          source: found.source,
          dir: found.source === 'folder' ? found.dir : null,
          items: found.items.map(({ id, name, ok, reason }) => (ok ? { id, name, ok } : { id, name, ok, reason })),
          omitted: found.omitted ?? 0,
          error: found.ok ? null : found.code,
        };
        lastScanAt = now();
        pushState({ force: true });
        return { ok: found.ok, samples: { ...samples } };
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function loadSample(id) {
    if (isBusy()) return { ok: false, code: 'running' };
    const seq = ++loadSeq;
    loadsInFlight += 1;
    try {
      // The store accepts an id only if the folder, looked at now, contains it: the id never becomes a path.
      const read = await sampleStore.read(id);
      if (!read.ok) {
        if (read.code === 'sample_unreadable') return { ok: false, code: 'sample_unreadable', reason: read.reason };
        if (read.code === 'unknown_sample') return { ok: false, code: 'unknown_sample' };
        return { ok: false, code: 'read_failed', errno: read.code };
      }
      if (isBusy()) return { ok: false, code: 'running' };
      if (seq !== loadSeq) return { ok: false, code: 'busy' };
      return accept(read.text, { source: 'sample', fileName: read.fileName });
    } finally {
      loadsInFlight -= 1;
    }
  }

  // Used by the relay service only (never reachable from the page): hands over a definition that
  // was drafted from a recording. It must already be validated, and the server must be stopped.
  function loadDraft(definition, meta = {}) {
    if (!isValidatedDefinition(definition)) return { ok: false, code: 'invalid_definition' };
    if (isBusy()) return { ok: false, code: 'running' };
    const fileName = typeof meta.fileName === 'string' ? meta.fileName.slice(0, 100) : 'draft';
    const info = describeDefinition(definition, { source: 'draft', fileName });
    current = { definition, info };
    // The page learns the definition from the result of its own load calls; this one was not asked
    // for by the page, so it is announced.
    emit('deviceDefinition', info);
    pushState({ force: true });
    return { ok: true, info };
  }

  // ---- definition made from a table (the beginner path) -----------------------------------
  //
  // The page passes the table cells (checked again in ipc.js); this service builds the definition
  // itself and the validator has the last word. Nothing is kept between calls: each one starts
  // again from the table it was given, so the preview, "use" and "save" can never disagree.

  function invalidTable(errors) {
    return { ok: false, code: 'invalid_table', errors: errors.slice(0, MAX_ERRORS_TO_PAGE), totalErrors: errors.length };
  }

  function tablePreview(input) {
    const built = buildTableDefinition(input);
    return built.ok ? { ok: true, text: tableDefinitionText(built.json) } : invalidTable(built.errors);
  }

  function tableUse(input) {
    if (isBusy()) return { ok: false, code: 'running' };
    const built = buildTableDefinition(input);
    if (!built.ok) return invalidTable(built.errors);
    // A file dialog opened earlier must not replace this definition when it closes.
    loadSeq += 1;
    const info = describeDefinition(built.definition, { source: 'table', fileName: 'table.json' });
    current = { definition: built.definition, info };
    pushState({ force: true });
    return { ok: true, info };
  }

  async function tableSave(input) {
    if (saveText === null) return { ok: false, code: 'save_unavailable' };
    if (tableSaving) return { ok: false, code: 'busy' };
    const built = buildTableDefinition(input);
    if (!built.ok) return invalidTable(built.errors);
    tableSaving = true;
    try {
      const saved = await saveText({ kind: 'draft', makeText: () => tableDefinitionText(built.json) });
      return saved.ok ? { ok: true, fileName: saved.fileName } : saved;
    } finally {
      tableSaving = false;
    }
  }

  // ---- server control -----------------------------------------------------------------

  async function start(args) {
    if (args === null || typeof args !== 'object') return { ok: false, code: 'invalid_arguments' };
    const { host, port } = args;
    if (!ALLOWED_HOSTS.includes(host)) return { ok: false, code: 'invalid_host' };
    if (!isValidPort(port)) return { ok: false, code: 'invalid_port' };
    if (loadsInFlight > 0) return { ok: false, code: 'busy' };
    if (current === null) return { ok: false, code: 'no_definition' };
    if (current.definition.transport === 'udp' && udpServer === null) return { ok: false, code: 'udp_unsupported' };
    if (allServers().some((s) => s.getState().running)) return { ok: false, code: 'already_running' };

    // Listening on all interfaces lets other machines on the network connect: ask, natively.
    // For UDP the dialog also says that the sender address can be forged.
    const { definition } = current;
    if (host === '0.0.0.0') {
      if (confirming) return { ok: false, code: 'busy' };
      confirming = true;
      let accepted;
      try {
        const reasons = definition.transport === 'udp' ? ['bind_all', 'udp_spoofable'] : ['bind_all'];
        accepted = (await confirm({ reasons, items: null })) === true;
      } finally {
        confirming = false;
      }
      if (!accepted) return { ok: false, code: 'cancelled' };
    }

    // The definition may have been replaced while the dialog was open (the dialog text depends on
    // its transport): then what was confirmed is not what would start.
    if (current === null || current.definition !== definition) return { ok: false, code: 'busy' };
    const result = await serverFor(definition).start({ definition, host, port });
    if (result.ok) {
      startTimers();
      pushState({ force: true });
    }
    return result;
  }

  async function stop() {
    const results = await Promise.all(allServers().map((s) => s.stop()));
    const result = results.find((r) => !r.ok) ?? { ok: true };
    if (result.ok) {
      stopTimers();
      flushOmitted();
      pushState({ force: true });
    }
    return result;
  }

  const setFault = (faults) => activeServer().setFault(faults);
  const closeAll = () => activeServer().closeAllConnections();

  function getState() {
    return {
      definition: current === null ? null : current.info,
      server: activeServer().getState(),
      samples: { ...samples },
    };
  }

  async function shutdown() {
    await Promise.all(allServers().map((s) => s.stop()));
    stopTimers();
  }

  return { handleServerEvent, loadFile, loadSample, refreshSamples, loadDraft, tablePreview, tableUse, tableSave, start, stop, setFault, closeAll, getState, shutdown };
}

module.exports = { createDeviceService, describeDefinition, MAX_ERRORS_TO_PAGE };
