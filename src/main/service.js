// Application service for saved commands, connections, sending and diagnostics.
// The renderer is NOT trusted. It may only name a saved command (device + command name) or send
// raw input. Saved command content is resolved from validated main-process data.
const { parseCommand } = require('../core/parse-command');
const { formatView, createTextStream } = require('../core/format-view');
const { diagnose } = require('../core/diagnose');
const { validateStore, nameKey } = require('../core/command-store');
const { buildTableCommands } = require('../core/table-definition');
const { createPeriodic, MIN_INTERVAL_MS, MAX_INTERVAL_MS } = require('./periodic');

const HINT_TICK_MS = 1000;
// Bytes of one received UDP datagram that are shown in the log.
const UDP_SHOWN_BYTES = 4096;
// A TCP chunk can be 64 KiB: only its beginning is drawn (the decoder still sees all of it, so a
// character split across chunks stays correct); the real size is always shown.
const TCP_SHOWN_BYTES = 4096;

function endsWithTerminator(bytes) {
  const last = bytes[bytes.length - 1];
  return last === 0x0d || last === 0x0a;
}

function createService({
  connection,
  // The UDP endpoint has the same outward shape as `connection`; `active` is the one in use.
  udp = null,
  store,
  emit = () => {},
  now = Date.now,
  scheduler = { setInterval, clearInterval, setTimeout, clearTimeout },
  dataInfo = null,
}) {
  let data = { schemaVersion: 1, devices: [] };
  let loadInfo = { status: 'not_loaded', errors: [], leftoverTemps: [] };
  let active = connection;
  let hintTimer = null;
  let lastHintsJson = '[]';
  // One streaming decoder per connection: TCP may split a UTF-8 character across two chunks.
  let receiveText = createTextStream();

  // The page has no access to the core modules, so the main process prepares log entries
  // (hex + character cells, and decoded text) ready to display.
  // `note` names an unexpected sender (UDP, when replies from any source are accepted).
  // `shownLimit` caps what is decoded for the screen (a UDP datagram can be 65507 bytes); `length`
  // is always the real size.
  function emitLog(dir, bytes, text, note, shownLimit) {
    const shown = shownLimit && bytes.length > shownLimit ? bytes.subarray(0, shownLimit) : bytes;
    const entry = { dir, t: now(), length: bytes.length, rows: formatView(shown), text: shown === bytes ? text : new TextDecoder().decode(shown) };
    if (shown !== bytes) entry.shown = shown.length;
    if (note) entry.note = note;
    emit('log', entry);
  }

  const isBusy = () => [connection, udp].some((endpoint) => endpoint !== null && ['connecting', 'connected', 'closing'].includes(endpoint.getState()));

  // ---- hints --------------------------------------------------------------------------

  function updateHints() {
    const hints = diagnose(active.getHistory(), now());
    const json = JSON.stringify(hints);
    if (json !== lastHintsJson) {
      lastHintsJson = json;
      emit('hints', { hints });
    }
  }

  function startHintTimer() {
    if (hintTimer === null) {
      hintTimer = scheduler.setInterval(updateHints, HINT_TICK_MS);
    }
  }

  function stopHintTimer() {
    if (hintTimer !== null) {
      scheduler.clearInterval(hintTimer);
      hintTimer = null;
    }
  }

  // ---- periodic sender ----------------------------------------------------------------

  const periodic = createPeriodic({
    send: (command) => sendResolved(command),
    scheduler,
    onStopped: (info) => emit('periodic', { running: false, ...info }),
  });

  // ---- events from the connection -----------------------------------------------------

  function handleConnectionEvent(event) {
    emit('event', event);
    if (event.type === 'recv') {
      if (event.transport === 'udp') {
        // One datagram is one message: a character never continues in the next datagram.
        const note = event.fromTarget === false ? `${event.remote.address}:${event.remote.port}` : undefined;
        emitLog('rx', event.bytes, new TextDecoder().decode(event.bytes), note, UDP_SHOWN_BYTES);
      } else {
        emitLog('rx', event.bytes, receiveText.push(event.bytes), undefined, TCP_SHOWN_BYTES);
      }
    }
    if (event.type === 'state') {
      if (event.state === 'closed') stopHintTimer();
      return;
    }
    if (event.type === 'terminated' || event.type === 'connect_fail' || event.type === 'socket_closed') {
      // The timer must never outlive the connection it was repeating on.
      periodic.stop('connection_closed');
    }
    updateHints();
  }

  // ---- sending ------------------------------------------------------------------------

  // `command` is always built by this module from saved data or raw input; it never comes from
  // the renderer as-is.
  async function sendResolved(command) {
    const parsed = parseCommand(command.text, { mode: command.mode, appendTerminator: command.appendTerminator });
    if (!parsed.ok) {
      return { ok: false, code: 'parse_error', errors: parsed.errors };
    }
    const endpoint = active;
    if (endpoint.getState() !== 'connected') {
      return { ok: false, code: 'not_connected' };
    }
    // The send is for this connection only: if it is replaced while the write waits in the queue,
    // the bytes must not reach the new one.
    const connectionId = endpoint.getId();

    const result = await endpoint.send(parsed.bytes, {
      expectsReply: command.expectsReply,
      endsWithTerminator: endsWithTerminator(parsed.bytes),
      // Checked right before the bytes are written, after any wait in the write queue.
      guard: () => active === endpoint && endpoint.getId() === connectionId,
    });
    if (result.ok) {
      emitLog('tx', parsed.bytes, new TextDecoder().decode(parsed.bytes));
      updateHints();
      return { ok: true, warnings: parsed.warnings };
    }
    return result;
  }

  function findSaved(ref) {
    if (ref === null || typeof ref !== 'object') return null;
    const device = data.devices.find((d) => d.name === ref.device);
    const command = device && device.commands.find((c) => c.name === ref.command);
    return command ? { device, command } : null;
  }

  // ---- saving the command list --------------------------------------------------------

  async function persistData(next) {
    const validation = validateStore(next);
    if (!validation.ok) {
      return store.save(next); // returns the standard invalid_data result
    }

    const result = await store.save(validation.data);
    if (result.ok) {
      // Keep the normalized copy the store validated, not the renderer's object.
      data = validation.data;
      return { ok: true, data };
    }
    return result;
  }

  async function saveData(next) {
    return persistData(next);
  }

  async function importTable({ table, target }) {
    const built = buildTableCommands(table);
    if (!built.ok) {
      return { ok: false, code: 'invalid_table', errors: built.errors.slice(0, 50), totalErrors: built.errors.length };
    }

    let deviceIndex = -1;
    let destination;
    let devices = data.devices;
    if (Object.hasOwn(target, 'existing')) {
      deviceIndex = data.devices.findIndex((device) => device.name === target.existing);
      if (deviceIndex === -1) return { ok: false, code: 'unknown_device' };
      destination = data.devices[deviceIndex];
    } else {
      destination = { name: target.create.name, host: target.create.host, port: target.create.port, commands: [] };
      if (table.transport === 'udp') destination.transport = 'udp';
    }

    // The store's own rule for "the same name" (case, spaces and Unicode form are ignored): a command
    // that collides is skipped, never overwritten.
    const takenNames = new Set(destination.commands.map((existing) => nameKey(existing.name)));
    const addedCommands = [];
    const skipped = [];
    for (const command of built.commands) {
      const key = nameKey(command.name);
      if (takenNames.has(key)) {
        skipped.push(command.name);
      } else {
        takenNames.add(key);
        addedCommands.push(command);
      }
    }

    if (addedCommands.length === 0) return { ok: true, data, added: 0, skipped };

    if (deviceIndex === -1) {
      devices = [...data.devices, { ...destination, commands: addedCommands }];
    } else {
      devices = data.devices.map((device, index) => (index === deviceIndex
        ? { ...device, commands: [...device.commands, ...addedCommands] }
        : device));
    }
    const saved = await persistData({ schemaVersion: data.schemaVersion, devices });
    if (!saved.ok) return saved;
    return { ok: true, data: saved.data, added: addedCommands.length, skipped };
  }

  // ---- public API (everything the renderer can ask for) --------------------------------

  async function init() {
    const result = await store.load();
    loadInfo = { status: result.status, errors: result.errors ?? [], code: result.code ?? null, errno: result.errno ?? null, leftoverTemps: result.leftoverTemps ?? [] };
    if (result.data) data = result.data;
    return getState();
  }

  function getState() {
    return {
      load: loadInfo,
      data,
      connectionState: active.getState(),
      transport: active === udp ? 'udp' : 'tcp',
      periodicRunning: periodic.isRunning(),
      dataInfo,
    };
  }

  function parsePreview({ text, mode, appendTerminator }) {
    const parsed = parseCommand(text, { mode, appendTerminator });
    if (!parsed.ok) return parsed;
    return { ok: true, warnings: parsed.warnings, rows: formatView(parsed.bytes), length: parsed.bytes.length };
  }

  function connect(params) {
    const transport = params !== null && typeof params === 'object' && params.transport === 'udp' ? 'udp' : 'tcp';
    if (transport === 'udp' && udp === null) return { ok: false, code: 'unsupported' };
    // Both kinds share the log and the hints: only one may run at a time.
    if (isBusy()) return { ok: false, code: 'busy' };
    const next = transport === 'udp' ? udp : connection;
    const result = transport === 'udp'
      ? next.connect({
        host: params.host, port: params.port, localPort: params.localPort, acceptAnySource: params.acceptAnySource, timeoutMs: params.timeoutMs,
      })
      : next.connect({
        host: params.host, port: params.port, timeoutMs: params.timeoutMs, keepAlive: params.keepAlive,
      });
    if (result.ok) {
      active = next;
      receiveText.reset();
      lastHintsJson = '[]';
      emit('hints', { hints: [] });
      startHintTimer();
    }
    return result;
  }

  function disconnect() {
    periodic.stop('user');
    return active.disconnect();
  }

  function setKeepAlive(enabled, initialDelayMs) {
    return active.setKeepAlive(Boolean(enabled), initialDelayMs);
  }

  function sendSaved(ref) {
    const found = findSaved(ref);
    if (!found) return Promise.resolve({ ok: false, code: 'unknown_command' });
    return sendResolved(found.command);
  }

  // A direct send always expects a reply: only a saved command can be marked as silent.
  function sendDirect({ text, mode, appendTerminator }) {
    return sendResolved({
      name: null,
      text,
      mode,
      appendTerminator,
      expectsReply: true,
    });
  }

  async function startPeriodic({ device, command, intervalMs }) {
    const found = findSaved({ device, command });
    if (!found) return { ok: false, code: 'unknown_command' };
    if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      return { ok: false, code: 'invalid_interval' };
    }
    if (active.getState() !== 'connected') return { ok: false, code: 'not_connected' };
    if (periodic.isRunning()) return { ok: false, code: 'already_running' };
    // A command that cannot be parsed would fail on every tick; say so now.
    const parsed = parseCommand(found.command.text, { mode: found.command.mode, appendTerminator: found.command.appendTerminator });
    if (!parsed.ok) return { ok: false, code: 'parse_error', errors: parsed.errors };

    const started = periodic.start(found.command, intervalMs);
    if (started.ok) {
      emit('periodic', { running: true, command: found.command.name, intervalMs });
    }
    return started;
  }

  function stopPeriodic() {
    periodic.stop('user');
    return { ok: true };
  }

  // Called when the app is closing: nothing may keep running.
  function shutdown() {
    periodic.stop('shutdown');
    stopHintTimer();
    connection.disconnect();
    if (udp !== null) udp.disconnect();
  }

  return {
    handleConnectionEvent,
    init,
    getState,
    saveData,
    importTable,
    parsePreview,
    connect,
    disconnect,
    setKeepAlive,
    sendSaved,
    sendDirect,
    startPeriodic,
    stopPeriodic,
    shutdown,
  };
}

module.exports = { createService };
