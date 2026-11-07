// The "relay" view. Runs in the sandboxed renderer: it can only call the fixed bridge functions from
// preload.js. It never passes a file path, a recording or a definition (the main process owns all
// three, and files go through native dialogs). Text from the network and from recordings is
// untrusted: DOM is built with textContent only.
(function relayView() {
  'use strict';

  const wb = window.workbench;
  const C = window.WbCommon;
  const { $, el, t, showNotice } = C;
  const REMEMBER_KEY = 'wb.relay.target';

  const R = {
    state: {
      relay: { running: false, connections: [] },
      recording: { events: 0, payloadBytes: 0, connections: 0, truncated: false, truncatedReason: null },
      loaded: null,
      draft: null,
    },
    recErrors: null,
  };

  const logView = C.createLogView({ logId: 'rl-log', emptyId: 'rl-log-empty', truncatedId: 'rl-log-truncated' });

  // Translates a code with a prefix, falling back to the code itself when no text exists.
  function tr(prefix, code) {
    const key = `${prefix}.${code}`;
    const text = t(key);
    return text === key ? String(code) : text;
  }

  function failText(result) {
    if (!result || typeof result.code !== 'string') return t('err.unknown', { code: 'no_result' });
    if (result.code === 'listen_failed' && result.errno === 'EADDRINUSE') return t('relay.err.listen_failed_inuse');
    const key = `relay.err.${result.code}`;
    const text = t(key, { errno: result.errno ?? '' });
    return text === key ? t('err.unknown', { code: result.code }) : text;
  }

  const running = () => R.state.relay.running === true;

  // ---- rendering -----------------------------------------------------------------------------

  function renderStatus() {
    const r = R.state.relay;
    $('rl-status').className = `badge ${running() ? 'state-connected' : 'state-idle'}`;
    $('rl-status-icon').textContent = running() ? '●' : '○';
    $('rl-status-text').textContent = running()
      ? t(r.transport === 'udp' ? 'relay.status.runningUdp' : 'relay.status.running', { host: r.host, port: r.port })
      : t('relay.status.stopped');
  }

  function renderBanners() {
    const box = $('rl-banners');
    box.replaceChildren();
    const privacy = el('div', 'banner warn');
    privacy.appendChild(el('div', 'banner-text', t('relay.privacy')));
    box.appendChild(privacy);
    const r = R.state.relay;
    if (running()) {
      const usage = el('div', 'banner info');
      const shownHost = r.host === '0.0.0.0' ? '127.0.0.1' : r.host;
      usage.appendChild(el('div', 'banner-text', t(r.transport === 'udp' ? 'relay.usageUdp' : 'relay.usage', {
        host: shownHost, port: r.port, target: `${r.upstream.address}:${r.upstream.port}`,
      })));
      box.appendChild(usage);
      if (r.lan) {
        const warn = el('div', 'banner warn');
        warn.appendChild(el('div', 'banner-text', t(r.transport === 'udp' ? 'relay.lanWarningUdp' : 'relay.lanWarning')));
        box.appendChild(warn);
      }
    }
  }

  function renderRecording() {
    const s = R.state.recording;
    const stats = $('rl-rec-stats');
    stats.textContent = s.events === 0
      ? t('relay.rec.empty')
      : t('relay.rec.stats', { events: s.events, bytes: s.payloadBytes ?? 0, connections: s.connections });
    const note = $('rl-rec-truncated');
    note.hidden = !s.truncated;
    if (s.truncated) note.textContent = t('relay.rec.truncated', { reason: tr('relay.fullReason', s.truncatedReason) });

    const loaded = $('rl-rec-loaded');
    loaded.hidden = R.state.loaded === null;
    if (R.state.loaded) {
      loaded.textContent = t('relay.rec.loaded', {
        file: R.state.loaded.fileName, events: R.state.loaded.events, connections: R.state.loaded.connections,
      });
    }
    renderRecordingErrors();
  }

  function renderRecordingErrors() {
    const box = $('rl-rec-errors');
    box.replaceChildren();
    if (R.recErrors === null) return;
    box.appendChild(el('p', 'error', t('relay.rec.invalid', { file: R.recErrors.file ?? '', count: R.recErrors.total })));
    const list = el('ul', 'messages');
    for (const error of R.recErrors.items) {
      const item = el('li', '', tr('relay.reccode', error.code));
      item.appendChild(el('div', 'muted small-text mono', t('relay.rec.at', { pointer: error.pointer === '' ? '/' : error.pointer })));
      list.appendChild(item);
    }
    box.appendChild(list);
    if (R.recErrors.total > R.recErrors.items.length) {
      box.appendChild(el('p', 'muted', t('relay.rec.more', { count: R.recErrors.total - R.recErrors.items.length })));
    }
  }

  function renderConnections() {
    const box = $('rl-conns');
    box.replaceChildren();
    const conns = R.state.relay.connections || [];
    $('rl-conns-empty').hidden = conns.length > 0;
    for (const conn of conns) {
      const card = el('div', 'conn');
      card.appendChild(el('div', 'conn-head', t('relay.conns.item', { id: conn.id, remote: conn.remote })));
      card.appendChild(el('div', 'muted small-text', conn.state === 'connecting'
        ? t('relay.conns.connecting')
        : t('relay.conns.bytes', { up: conn.upBytes, down: conn.downBytes })));
      box.appendChild(card);
    }
  }

  function fidelityText(draft) {
    const h = draft.holdout;
    if (h.evaluable) return t('relay.draft.fidelity.ok', { reproduced: h.reproduced, exchanges: h.exchanges });
    return tr('relay.draft.fidelity', h.reason);
  }

  function renderDraft() {
    const draft = R.state.draft;
    $('rl-draft-none').hidden = draft !== null;
    const box = $('rl-draft-result');
    box.hidden = draft === null;
    box.replaceChildren();
    if (draft === null) return;

    box.appendChild(el('p', 'info-line', t('relay.draft.summary', {
      commands: draft.info.commandCount,
      greeting: draft.info.hasGreeting ? t('relay.draft.greeting') : '',
    })));
    if (draft.stale) box.appendChild(el('p', 'error', t('relay.draft.stale')));
    const list = el('ul', 'patterns');
    for (const pattern of draft.info.patterns) list.appendChild(el('li', 'mono', pattern));
    box.appendChild(list);

    box.appendChild(el('h3', 'def-sub', t('relay.draft.fidelity.title')));
    box.appendChild(el('p', 'info-line', fidelityText(draft)));
    if (draft.replay.failed > 0) box.appendChild(el('p', 'error', t('relay.draft.replayFailed', { n: draft.replay.failed })));

    box.appendChild(el('h3', 'def-sub', t('relay.hw.title')));
    const hw = el('ul', 'homework');
    for (const item of draft.homework) {
      const li = el('li', '', t(`relay.hw.${item.code}`, { count: item.count }));
      if (item.examples.length > 0) {
        li.appendChild(el('div', 'muted small-text mono', t('relay.hw.examples', { list: item.examples.join(' , ') })));
      }
      hw.appendChild(li);
    }
    box.appendChild(hw);
  }

  function updateControls() {
    const on = running();
    $('rl-start').disabled = on;
    $('rl-stop').disabled = !on;
    for (const id of ['rl-up-host', 'rl-up-port', 'rl-transport', 'rl-host', 'rl-port']) $(id).disabled = on;
    $('rl-save').disabled = R.state.recording.events === 0;
    $('rl-clear').disabled = R.state.recording.events === 0;
    const source = $('rl-source').value;
    $('rl-draft-make').disabled = source === 'loaded' ? R.state.loaded === null : R.state.recording.events === 0;
    $('rl-draft-save').disabled = R.state.draft === null;
    $('rl-draft-use').disabled = R.state.draft === null;
  }

  function renderAll() {
    renderStatus();
    renderBanners();
    renderRecording();
    renderConnections();
    renderDraft();
    updateControls();
  }

  // ---- remembered target (a convenience only) ------------------------------------------------------

  function rememberTarget() {
    try {
      localStorage.setItem(REMEMBER_KEY, JSON.stringify({ host: $('rl-up-host').value, port: $('rl-up-port').value }));
    } catch {
      // Not remembered; not worth interrupting the user.
    }
  }

  function restoreTarget() {
    try {
      const saved = JSON.parse(localStorage.getItem(REMEMBER_KEY) || 'null');
      if (saved && typeof saved.host === 'string' && typeof saved.port === 'string') {
        $('rl-up-host').value = saved.host.slice(0, 253);
        $('rl-up-port').value = saved.port.slice(0, 5);
      }
    } catch {
      // Unreadable storage: the fields simply stay empty.
    }
  }

  // ---- actions ----------------------------------------------------------------------------------

  async function start() {
    const result = await wb.relayStart({
      listenHost: $('rl-host').value,
      listenPort: Number($('rl-port').value),
      upstreamHost: $('rl-up-host').value.trim(),
      upstreamPort: Number($('rl-up-port').value),
      transport: $('rl-transport').value,
    });
    if (result.ok) rememberTarget();
    else if (result.code !== 'cancelled') showNotice(failText(result), true);
  }

  async function stop() {
    const result = await wb.relayStop();
    if (!result.ok) showNotice(failText(result), true);
  }

  async function saveRecording() {
    const result = await wb.relaySaveRecording();
    if (result.ok) showNotice(t('relay.rec.saved', { file: result.fileName }));
    else if (result.code !== 'cancelled') showNotice(failText(result), true);
  }

  async function loadRecording() {
    const result = await wb.relayLoadRecording();
    if (result.ok) {
      R.recErrors = null;
      $('rl-source').value = 'loaded';
      showNotice(t('relay.rec.loaded', {
        file: result.fileName, events: result.summary.events, connections: result.summary.connections,
      }));
      renderRecordingErrors();
      updateControls();
      return;
    }
    if (result.code === 'cancelled') return;
    if (result.code === 'invalid_recording') {
      R.recErrors = { items: result.errors, total: result.totalErrors, file: result.fileName };
      renderRecordingErrors();
      showNotice(t('relay.rec.invalid', { file: result.fileName ?? '', count: result.totalErrors }), true);
      return;
    }
    showNotice(failText(result), true);
  }

  async function clearRecording() {
    const result = await wb.relayClearRecording();
    if (!result.ok) showNotice(failText(result), true);
  }

  async function makeDraft() {
    const request = { source: $('rl-source').value };
    const terminator = $('rl-term').value;
    if (terminator !== 'auto') request.terminator = terminator;
    const quiet = $('rl-quiet').value.trim();
    if (quiet !== '') request.quietMs = Number(quiet);
    const result = await wb.relayDraft(request);
    if (result.ok) {
      R.state.draft = { ...result.draft, stale: false };
      renderDraft();
      updateControls();
    } else {
      showNotice(failText(result), true);
    }
  }

  async function saveDraft() {
    const result = await wb.relaySaveDraft();
    if (result.ok) showNotice(t('relay.draft.saved', { file: result.fileName }));
    else if (result.code !== 'cancelled') showNotice(failText(result), true);
  }

  async function useDraft() {
    const result = await wb.relayUseDraft();
    if (!result.ok) {
      showNotice(failText(result), true);
      return;
    }
    showNotice(t('relay.draft.used'));
    // The device view shows the loaded definition; take the user there.
    $('tab-device').click();
  }

  // ---- events from the main process -------------------------------------------------------------------

  function eventText(e) {
    switch (e.type) {
      case 'listening': return t('relay.event.listening', { host: e.host, port: e.port });
      case 'stopped': return t('relay.event.stopped');
      case 'connection_opened': return t('relay.event.connection_opened', { id: e.connectionId, remote: e.remote });
      case 'connection_closed': return t('relay.event.connection_closed', { id: e.connectionId, reason: tr('relay.closeReason', e.reason) });
      case 'upstream_open': return t('relay.event.upstream_open', { id: e.connectionId });
      case 'send_error': return t('relay.event.send_error', { id: e.connectionId, errno: e.errno ?? '' });
      case 'fin': return t('relay.event.fin', { id: e.connectionId, dir: t(`relay.dir.${e.dir}`) });
      case 'refused': return t('relay.event.refused', { reason: tr('relay.refusedReason', e.reason) });
      case 'recording_full': return t('relay.event.recording_full', { reason: tr('relay.fullReason', e.reason) });
      case 'omitted': return t('relay.event.omitted', { count: e.count });
      case 'server_error': return t('relay.event.server_error', { errno: e.errno ?? '' });
      default: return null;
    }
  }

  function onMainEvent(message) {
    switch (message.channel) {
      case 'relayLog': {
        const p = message.payload;
        logView.appendLog({
          // tx/rx only choose the arrow and color; the label says which way the bytes went.
          dir: p.dir === 'up' ? 'tx' : 'rx',
          label: t(`relay.dir.${p.dir}`),
          note: p.truncated ? t('relay.log.shown', { n: p.text.length }) : null,
          t: p.t,
          connectionId: p.connectionId,
          length: p.length,
          rows: p.rows,
          text: p.text,
        });
        break;
      }
      case 'relayEvent': {
        const text = eventText(message.payload);
        if (text) logView.appendSys(text);
        break;
      }
      case 'relayState':
        R.state = message.payload;
        renderAll();
        break;
      default:
        break;
    }
  }

  // ---- wiring -----------------------------------------------------------------------------------------

  function bind() {
    $('rl-start').addEventListener('click', start);
    $('rl-stop').addEventListener('click', stop);
    $('rl-save').addEventListener('click', saveRecording);
    $('rl-load').addEventListener('click', loadRecording);
    $('rl-clear').addEventListener('click', clearRecording);
    $('rl-source').addEventListener('change', updateControls);
    $('rl-draft-make').addEventListener('click', makeDraft);
    $('rl-draft-save').addEventListener('click', saveDraft);
    $('rl-draft-use').addEventListener('click', useDraft);
    $('rl-log-clear').addEventListener('click', logView.clear);
  }

  async function start0() {
    restoreTarget();
    bind();
    wb.onEvent(onMainEvent);
    C.onLocaleChange(renderAll);
    R.state = await wb.relayState();
    renderAll();
  }

  start0().catch((error) => {
    // Show why instead of leaving the tab silently empty.
    showNotice(`Relay view failed to start: ${error && error.message}`, true);
  });
}());
