// Application service for the relay role (the main-process side of the "relay" tab).
//
// The page is untrusted. It never passes file paths, recordings or definitions: it asks this
// service to start/stop the relay, to save/load a recording through a native file dialog, to draft
// a definition, and to hand the draft to the virtual device. The draft stays in the main process
// all the time; the page only sees a summary. The dialog that guards "listen on all interfaces" is
// native and names the REAL target (the address the relay will actually connect to).
const { formatView } = require('../core/format-view');
const { RECORDING_LIMITS, parseRecordingText, serializeRecording } = require('../core/recording');
const { draftDefinition, evaluateHoldout, replayCheck, canDraft } = require('../core/definition-draft');
const { describeDefinition } = require('./device-service');
const { ALLOWED_LISTEN_HOSTS, isValidPort } = require('./relay');

const STATE_TICK_MS = 1000;
// Event-driven state pushes are spaced at least this far apart; the tick delivers the latest one.
const MIN_PUSH_INTERVAL_MS = 250;
const MAX_ERRORS_TO_PAGE = 50;
// Longest part of one chunk that is decoded for the screen log (the recording keeps everything).
const MAX_SHOWN_BYTES = 1024;
// Drafting runs synchronously in the main process. Above this many events only the draft itself is
// made (the extra checks would triple the time), and calls cannot follow each other closer than
// the cool-down.
const DEFAULT_LIMITS = { logEventsPerSecond: 200, checkMaxEvents: 50000, draftCooldownMs: 1000 };
const STATE_EVENTS = new Set(['listening', 'stopped', 'connection_opened', 'connection_closed', 'recording_full']);
const SOURCES = ['live', 'loaded'];
const TERMINATORS = ['cr', 'lf', 'crlf'];

const formatTarget = (address, port) => (address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`);

function summarizeRecording(recording) {
  let payloadBytes = 0;
  for (const event of recording.events) payloadBytes += event.bytes.length;
  return {
    transport: recording.transport,
    events: recording.events.length,
    payloadBytes,
    connections: recording.connections.length,
    truncated: recording.truncated === true,
    truncatedReason: recording.truncatedReason ?? null,
  };
}

function createRelayService({
  relay,
  // The UDP implementation; optional so a TCP-only setup (and older tests) keeps working.
  udpRelay = null,
  recorder,
  deviceService,
  saveText,
  loadText,
  confirm,
  emit = () => {},
  now = Date.now,
  scheduler = { setInterval, clearInterval },
  limits = {},
}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let loaded = null; // { recording, fileName, summary }
  let draft = null; // { result, source, summary }
  let stateTimer = null;
  let dialogBusy = false;
  let lastDraftAt = -Infinity;

  // One native dialog at a time: a second click must not queue another dialog (and another copy
  // of a large recording in memory) behind the first.
  async function oneDialog(fn) {
    if (dialogBusy) return { ok: false, code: 'busy' };
    dialogBusy = true;
    try {
      return await fn();
    } finally {
      dialogBusy = false;
    }
  }

  const allRelays = () => (udpRelay === null ? [relay] : [relay, udpRelay]);
  const isActive = (state) => state.running === true || (state.lifecycle !== undefined && state.lifecycle !== 'idle');
  // The implementation that is running (or starting/stopping); otherwise the TCP one, whose idle
  // state has the same shape.
  const activeRelay = () => allRelays().find((x) => isActive(x.getState())) ?? relay;

  const decodeText = (bytes) => new TextDecoder().decode(bytes);

  // ---- events to the page (rate limited: a busy link must not flood the screen) ------------

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
      emit('relayEvent', { type: 'omitted', count: omitted });
      omitted = 0;
    }
  }

  // A draft from the live recording is a snapshot: it is out of date once more was recorded.
  const isStale = (d) => d.source === 'live' && (d.epoch !== recorder.epoch() || d.events !== recorder.stats().events);

  function getState() {
    return {
      relay: activeRelay().getState(),
      recording: recorder.stats(),
      loaded: loaded === null ? null : { fileName: loaded.fileName, ...loaded.summary },
      draft: draft === null ? null : { ...draft.summary, stale: isStale(draft) },
    };
  }

  let lastPushAt = -Infinity;
  function pushState({ force = false } = {}) {
    const t = now();
    if (!force && t - lastPushAt < MIN_PUSH_INTERVAL_MS) return;
    lastPushAt = t;
    emit('relayState', getState());
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

  function handleRelayEvent(event) {
    if (event.type === 'data') {
      if (!allowToPage()) return;
      const shown = event.bytes.subarray(0, MAX_SHOWN_BYTES);
      emit('relayLog', {
        dir: event.dir,
        t: event.t,
        connectionId: event.connectionId,
        length: event.bytes.length,
        rows: formatView(shown),
        text: decodeText(shown),
        truncated: event.bytes.length > shown.length,
      });
      return;
    }
    const { bytes, ...rest } = event;
    // The relay may stop by itself (an error after listening): the timers must follow its state.
    if (event.type === 'stopped') {
      stopTimers();
      flushOmitted();
      emit('relayEvent', rest);
      pushState({ force: true });
      return;
    }
    // Events that a peer on the network can produce at will are rate limited like the traffic.
    const peerDriven = event.type === 'refused' || event.type === 'fin' || event.type === 'upstream_open';
    if (peerDriven && !allowToPage()) return;
    emit('relayEvent', rest);
    if (STATE_EVENTS.has(event.type)) pushState();
  }

  // ---- relay control --------------------------------------------------------------------

  async function start(args) {
    if (args === null || typeof args !== 'object') return { ok: false, code: 'invalid_arguments' };
    const { listenHost, listenPort, upstreamHost, upstreamPort, transport = 'tcp' } = args;
    if (!ALLOWED_LISTEN_HOSTS.includes(listenHost)) return { ok: false, code: 'invalid_host' };
    if (!isValidPort(listenPort)) return { ok: false, code: 'invalid_port' };
    if (transport !== 'tcp' && transport !== 'udp') return { ok: false, code: 'invalid_arguments' };
    if (transport === 'udp' && udpRelay === null) return { ok: false, code: 'udp_unsupported' };
    if (allRelays().some((x) => isActive(x.getState()))) return { ok: false, code: 'already_running' };

    // A recording holds either datagrams or a byte stream, never both. It can only change kind
    // while it is empty; otherwise the user has to save or clear it first.
    if (recorder.transport() !== transport) {
      if (!recorder.setTransport(transport)) return { ok: false, code: 'recording_transport_mismatch' };
      if (draft !== null && draft.source === 'live') draft = null;
    }

    const chosen = transport === 'udp' ? udpRelay : relay;
    const reasons = transport === 'udp' ? ['relay_bind_all', 'udp_spoofable'] : ['relay_bind_all'];
    const result = await chosen.start(
      { listenHost, listenPort, upstreamHost, upstreamPort },
      {
        // Listening on all interfaces lets other machines use the relay to reach the target: ask,
        // natively, and name the address the relay will really connect to.
        beforeListen: async ({ upstreamAddress, upstreamPort: port }) => (
          (await confirm({ reasons, items: null, target: formatTarget(upstreamAddress, port) })) === true
        ),
      },
    );
    if (result.ok) {
      startTimers();
      pushState({ force: true });
    }
    return result;
  }

  async function stop() {
    const results = await Promise.all(allRelays().map((x) => x.stop()));
    const result = results.find((x) => !x.ok) ?? { ok: true };
    if (result.ok) {
      stopTimers();
      flushOmitted();
      pushState({ force: true });
    }
    return result;
  }

  // ---- recording ------------------------------------------------------------------------

  function clearRecording() {
    recorder.clear();
    if (draft !== null && draft.source === 'live') draft = null;
    pushState({ force: true });
    return { ok: true };
  }

  // The text is produced only after the user chose a place (makeText), so it is current and no
  // large copy waits in memory behind an open dialog.
  const saveRecording = () => oneDialog(async () => {
    if (recorder.stats().events === 0) return { ok: false, code: 'empty' };
    const saved = await saveText({
      kind: 'recording',
      makeText: () => {
        const snapshot = recorder.snapshot();
        return snapshot.events.length === 0 ? null : serializeRecording(snapshot);
      },
    });
    return saved.ok ? { ok: true, fileName: saved.fileName } : saved;
  });

  const loadRecording = () => oneDialog(async () => {
    const read = await loadText({ kind: 'recording', maxBytes: RECORDING_LIMITS.MAX_FILE_BYTES });
    if (!read.ok) return read;
    const parsed = parseRecordingText(read.text);
    if (!parsed.ok) {
      return {
        ok: false,
        code: 'invalid_recording',
        fileName: read.fileName,
        errors: parsed.errors.slice(0, MAX_ERRORS_TO_PAGE),
        totalErrors: parsed.errors.length,
      };
    }
    loaded = { recording: parsed.recording, fileName: read.fileName, summary: summarizeRecording(parsed.recording) };
    if (draft !== null && draft.source === 'loaded') draft = null;
    pushState({ force: true });
    return { ok: true, fileName: read.fileName, summary: loaded.summary };
  });

  // ---- draft ----------------------------------------------------------------------------

  function makeDraft(args) {
    if (args === null || typeof args !== 'object') return { ok: false, code: 'invalid_arguments' };
    const { source, terminator, quietMs } = args;
    if (!SOURCES.includes(source)) return { ok: false, code: 'invalid_arguments' };
    if (terminator !== undefined && !TERMINATORS.includes(terminator)) return { ok: false, code: 'invalid_arguments' };
    if (quietMs !== undefined && !(Number.isInteger(quietMs) && quietMs >= 0 && quietMs <= 60000)) {
      return { ok: false, code: 'invalid_arguments' };
    }

    if (now() - lastDraftAt < lim.draftCooldownMs) return { ok: false, code: 'busy' };
    const recording = source === 'loaded' ? (loaded === null ? null : loaded.recording) : recorder.snapshot();
    if (recording === null) return { ok: false, code: 'no_recording' };
    if (recording.events.length === 0) return { ok: false, code: 'empty' };
    // Drafting from datagram recordings is not supported yet (phase 4b): say why instead of guessing.
    const allowed = canDraft(recording);
    if (!allowed.ok) return { ok: false, code: allowed.code };

    const options = {};
    if (terminator !== undefined) options.terminator = terminator;
    if (quietMs !== undefined) options.quietMs = quietMs;
    const result = draftDefinition(recording, options);
    const small = recording.events.length <= lim.checkMaxEvents;
    const holdout = small ? evaluateHoldout(recording, options) : { evaluable: false, reason: 'too_large' };
    const replay = small ? replayCheck(result, recording) : { checked: 0, failures: [] };
    lastDraftAt = now();
    const summary = {
      source,
      info: describeDefinition(result.definition, { source: 'draft', fileName: 'draft.json' }),
      homework: result.homework,
      stats: result.stats,
      holdout,
      replay: { checked: replay.checked, failed: replay.failures.length, skipped: !small },
      truncated: recording.truncated === true,
    };
    draft = { result, source, summary, epoch: recorder.epoch(), events: recorder.stats().events };
    pushState({ force: true });
    return { ok: true, draft: summary };
  }

  const saveDraft = () => oneDialog(async () => {
    if (draft === null) return { ok: false, code: 'no_draft' };
    const shown = draft;
    const saved = await saveText({ kind: 'draft', makeText: () => `${JSON.stringify(shown.result.json, null, 2)}\n` });
    return saved.ok ? { ok: true, fileName: saved.fileName } : saved;
  });

  // The definition goes straight to the device service inside the main process.
  function useDraft() {
    if (draft === null) return { ok: false, code: 'no_draft' };
    const handed = deviceService.loadDraft(draft.result.definition, { fileName: 'draft.json' });
    return handed.ok ? { ok: true } : handed;
  }

  async function shutdown() {
    await Promise.all(allRelays().map((x) => x.stop()));
    stopTimers();
  }

  return {
    handleRelayEvent, start, stop, getState, clearRecording, saveRecording, loadRecording, draft: makeDraft, saveDraft, useDraft, shutdown,
  };
}

module.exports = { createRelayService, formatTarget, MAX_SHOWN_BYTES };
