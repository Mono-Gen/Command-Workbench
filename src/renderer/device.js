// The "virtual device" view. Runs in the sandboxed renderer: it can only call the fixed bridge
// functions from preload.js, and it never passes a file path or a definition (the main process
// owns both). Text from the network is untrusted: DOM is built with textContent only.
(function deviceView() {
  'use strict';

  const wb = window.workbench;
  const C = window.WbCommon;
  const { $, el, t, showNotice } = C;

  const D = {
    definition: null,
    server: { running: false, connections: [] },
    samples: { source: null, dir: null, items: [], omitted: 0, error: null },
    errors: null,
  };

  const logView = C.createLogView({ logId: 'vd-log', emptyId: 'vd-log-empty', truncatedId: 'vd-log-truncated' });

  // Translates a code with a prefix, falling back to the code itself when no text exists.
  function tr(prefix, code) {
    const key = `${prefix}.${code}`;
    const text = t(key);
    return text === key ? String(code) : text;
  }

  function failText(result) {
    if (!result || typeof result.code !== 'string') return t('err.unknown', { code: 'no_result' });
    if (result.code === 'listen_failed' && result.errno === 'EADDRINUSE') return t('dev.err.listen_failed_inuse');
    const key = `dev.err.${result.code}`;
    const text = t(key, { errno: result.errno ?? '', reason: tr('dev.samples.reason', result.reason ?? '') });
    return text === key ? t('err.unknown', { code: result.code }) : text;
  }

  // ---- definition panel ---------------------------------------------------------------------

  // The list comes from the "samples" folder next to the program (or the built-in definitions). Choosing
  // an entry loads it. A file that cannot be used is listed but cannot be chosen, with the reason, so a
  // mistake in an own file is visible. The first entry is a placeholder: nothing is loaded by it.
  function renderSamples() {
    const select = $('vd-sample');
    select.replaceChildren();
    const list = D.samples;
    const placeholder = el('option', '', t('dev.definition.choose'));
    placeholder.value = '';
    select.appendChild(placeholder);
    // The name alone is shown; the file name is added only when two definitions have the same name.
    const counts = new Map();
    for (const sample of list.items) counts.set(sample.name, (counts.get(sample.name) ?? 0) + 1);
    for (const sample of list.items) {
      let label;
      if (!sample.ok) label = `${sample.id}: ${tr('dev.samples.reason', sample.reason)}`;
      else label = counts.get(sample.name) > 1 ? `${sample.name} (${sample.id})` : sample.name;
      const option = el('option', '', label);
      option.value = sample.id;
      option.disabled = !sample.ok;
      select.appendChild(option);
    }
    // The list shows what is loaded: a definition from the list, or the placeholder (a file, or none).
    const loadedId = D.definition && D.definition.source === 'sample' ? D.definition.fileName : '';
    select.value = list.items.some((sample) => sample.ok && sample.id === loadedId) ? loadedId : '';
    // Where the list comes from is shown only when it is not the usual case (and always as a tooltip).
    select.title = list.source === 'folder' && list.dir ? t('dev.samples.folder', { path: list.dir }) : '';
    let note = '';
    if (list.error) note = t('dev.samples.error', { code: list.error });
    else if (list.source === 'folder' && list.items.length === 0) note = t('dev.samples.emptyFolder', { path: list.dir });
    else if (list.source === 'builtin') note = t('dev.samples.builtin');
    if (list.omitted > 0) note = `${note} ${t('dev.samples.omitted', { count: list.omitted })}`.trim();
    $('vd-samples-note').textContent = note;
    $('vd-samples-note').hidden = note === '';
  }

  function line(text) {
    return el('p', 'info-line', text);
  }

  function renderDefinition() {
    const info = D.definition;
    $('vd-def-none').hidden = info !== null;
    const box = $('vd-def-info');
    box.hidden = info === null;
    box.replaceChildren();
    if (info === null) return;

    box.appendChild(el('h3', 'def-name', info.name));
    if (info.description) box.appendChild(el('p', 'muted small-text', info.description));
    box.appendChild(line(t(`dev.definition.source.${info.source}`, { file: info.fileName })));
    const udp = info.transport === 'udp';
    box.appendChild(line(t('dev.info.transport', { value: udp ? 'UDP' : 'TCP' })));
    box.appendChild(line(t('dev.info.terminator', { value: t(`dev.terminator.${info.terminator}`) })));
    if (!udp) box.appendChild(line(t('dev.info.greeting', { value: t(info.hasGreeting ? 'dev.info.yes' : 'dev.info.no') })));
    const c = info.connection;
    if (udp) {
      // A datagram exchange has no connection: the limits apply to sources, and every source expires.
      box.appendChild(line(t('dev.info.peerLimit', { n: c.maxConnections })));
      box.appendChild(line(c.idleTimeoutMs > 0
        ? t('dev.info.idleUdp', { seconds: c.idleTimeoutMs / 1000 })
        : t('dev.info.noIdleUdp')));
    } else {
      box.appendChild(line(t('dev.info.maxConnections', { n: c.maxConnections, behavior: tr('dev.overLimit', c.overLimit) })));
      box.appendChild(line(c.idleTimeoutMs > 0
        ? t('dev.info.idle', { seconds: c.idleTimeoutMs / 1000, behavior: tr('dev.idleBehavior', c.idleBehavior) })
        : t('dev.info.noIdle')));
    }
    if (c.startupQuietMs > 0) box.appendChild(line(t('dev.info.startupQuiet', { seconds: c.startupQuietMs / 1000 })));
    if (c.minCommandIntervalMs > 0) box.appendChild(line(t('dev.info.minInterval', { ms: c.minCommandIntervalMs })));
    box.appendChild(line(t('dev.info.notifications', { count: info.notificationCount })));

    box.appendChild(el('h3', 'def-sub', t('dev.info.commands', { count: info.commandCount })));
    const list = el('ul', 'patterns');
    for (const pattern of info.patterns) list.appendChild(el('li', 'mono', pattern));
    box.appendChild(list);
  }

  function pointerText(pointer) {
    return pointer === '' ? t('dev.def.root') : pointer;
  }

  function renderErrors() {
    const box = $('vd-def-errors');
    box.replaceChildren();
    if (D.errors === null) return;
    box.appendChild(el('p', 'error', t('dev.def.errors', { count: D.errors.total, file: D.errors.file ?? '' })));
    const list = el('ul', 'messages');
    for (const error of D.errors.items) {
      const item = el('li', '', `${tr('dev.defcode', error.code)}`);
      const reason = error.detail && typeof error.detail.reason === 'string' ? ` ${tr('dev.defreason', error.detail.reason)}` : '';
      if (reason) item.appendChild(el('span', '', reason));
      item.appendChild(el('div', 'muted small-text mono', t('dev.def.at', { pointer: pointerText(error.pointer) })));
      list.appendChild(item);
    }
    box.appendChild(list);
    if (D.errors.total > D.errors.items.length) {
      box.appendChild(el('p', 'muted', t('dev.def.more', { count: D.errors.total - D.errors.items.length })));
    }
  }

  // ---- status, state, connections -------------------------------------------------------------

  function renderStatus() {
    const running = D.server.running;
    $('vd-status').className = `badge ${running ? 'state-connected' : 'state-idle'}`;
    $('vd-status-icon').textContent = running ? '●' : '○';
    $('vd-status-text').textContent = running
      ? t(D.server.transport === 'udp' ? 'dev.status.runningUdp' : 'dev.status.running', { host: D.server.host, port: D.server.port })
      : t('dev.status.stopped');
  }

  function renderBanners() {
    const box = $('vd-banners');
    box.replaceChildren();
    if (D.server.running && D.server.lan) {
      const warn = el('div', 'banner warn');
      warn.appendChild(el('div', 'banner-text', t(D.server.transport === 'udp' ? 'dev.lanWarningUdp' : 'dev.lanWarning')));
      box.appendChild(warn);
    }
  }

  function renderVars() {
    const body = $('vd-vars');
    body.replaceChildren();
    const info = D.definition;
    const values = D.server.running ? D.server.variables : null;
    const names = info ? info.variables : [];
    $('vd-vars-none').hidden = names.length > 0 || info === null;
    for (const variable of names) {
      const row = el('tr');
      row.appendChild(el('th', 'mono', variable.name));
      const value = values && Object.hasOwn(values, variable.name) ? values[variable.name] : variable.initial;
      row.appendChild(el('td', 'mono value', String(value)));
      row.appendChild(el('td', 'muted small-text', values ? '' : t('dev.vars.initial')));
      body.appendChild(row);
    }
  }

  function renderConnections() {
    const box = $('vd-conns');
    box.replaceChildren();
    const conns = D.server.connections || [];
    const emptyBox = $('vd-conns-empty');
    emptyBox.hidden = conns.length > 0;
    emptyBox.textContent = t(D.server.transport === 'udp' ? 'dev.conns.emptyUdp' : 'dev.conns.empty');
    for (const conn of conns) {
      const card = el('div', 'conn');
      card.appendChild(el('div', 'conn-head', `#${conn.id}  ${conn.remote}`));
      card.appendChild(el('div', 'muted small-text', conn.lastMessageAt === null
        ? t('dev.conns.noCommand')
        : t('dev.conns.last', { time: window.WbLogic.formatClock(conn.lastMessageAt) })));
      let idleText;
      if (conn.silent) idleText = t('dev.conns.silent');
      else if (conn.idleInMs === null) idleText = t('dev.conns.noIdle');
      else idleText = t('dev.conns.idleIn', { seconds: Math.ceil(conn.idleInMs / 1000) });
      card.appendChild(el('div', conn.silent ? 'conn-state silent' : 'conn-state', idleText));
      box.appendChild(card);
    }
  }

  function renderFaults() {
    const faults = D.server.running ? D.server.faults : null;
    $('vd-fault-state').textContent = faults
      ? t('dev.faults.state', {
        drop: faults.dropNextReplies,
        delay: faults.extraDelayMs,
        mute: t(faults.muted ? 'dev.faults.on' : 'dev.faults.off'),
      })
      : '';
    if (faults) $('vd-mute').checked = faults.muted;
  }

  function updateControls() {
    const running = D.server.running;
    $('vd-start').disabled = running || D.definition === null;
    $('vd-stop').disabled = !running;
    for (const id of ['vd-load-file', 'vd-make-table', 'vd-host', 'vd-port']) $(id).disabled = running;
    // Choosing from the list needs a usable entry; reloading the list is always allowed.
    const noSample = !D.samples.items.some((sample) => sample.ok);
    $('vd-sample').disabled = running || noSample;
    $('vd-sample').title = running ? t('dev.definition.runningLocked') : $('vd-sample').title;
    for (const id of ['vd-drop-n', 'vd-drop-apply', 'vd-delay-ms', 'vd-delay-apply', 'vd-mute', 'vd-close-all']) $(id).disabled = !running;
    $('vd-load-file').title = running ? t('dev.definition.runningLocked') : '';
  }

  function renderAll() {
    renderSamples();
    renderDefinition();
    renderErrors();
    renderStatus();
    renderBanners();
    renderVars();
    renderConnections();
    renderFaults();
    updateControls();
  }

  // ---- actions --------------------------------------------------------------------------------

  function applyLoadResult(result) {
    if (result.ok) {
      D.definition = result.info;
      D.errors = null;
      renderAll();
      return;
    }
    if (result.code === 'cancelled') return;
    if (result.code === 'invalid_definition') {
      D.errors = { items: result.errors, total: result.totalErrors, file: result.fileName };
      renderErrors();
      showNotice(failText(result), true);
      return;
    }
    showNotice(failText(result), true);
  }

  // Choosing an entry loads it; the placeholder loads nothing.
  async function loadSample() {
    const id = $('vd-sample').value;
    if (id === '') return;
    applyLoadResult(await wb.deviceLoadSample({ id }));
    renderSamples(); // a failed choice must not stay shown as if it were loaded
  }

  async function refreshSamples() {
    let result;
    try {
      result = await wb.deviceRefreshSamples();
    } catch (error) {
      showNotice(failText({ code: 'internal_error' }), true);
      return;
    }
    if (result && result.samples) {
      D.samples = result.samples;
      renderSamples();
      updateControls();
      return;
    }
    // No list came back (for example an internal error): say so instead of leaving an old list as if it were current.
    showNotice(failText(result), true);
  }

  async function loadFile() {
    applyLoadResult(await wb.deviceLoadFile());
    renderSamples();
  }

  async function start() {
    const port = Number($('vd-port').value);
    const result = await wb.deviceStart({ host: $('vd-host').value, port });
    if (!result.ok && result.code !== 'cancelled') showNotice(failText(result), true);
  }

  async function stop() {
    const result = await wb.deviceStop();
    if (!result.ok) showNotice(failText(result), true);
  }

  async function setFault(faults) {
    const result = await wb.deviceSetFault(faults);
    if (!result.ok) showNotice(failText(result), true);
  }

  async function closeAll() {
    const result = await wb.deviceCloseAll();
    if (!result.ok) showNotice(failText(result), true);
    else showNotice(t('dev.faults.closed', { n: result.closed }));
  }

  // ---- events from the main process -------------------------------------------------------------

  function changesText(changes) {
    return changes.map((c) => `${c.var}: ${c.from} → ${c.to}`).join(', ');
  }

  function eventText(e) {
    switch (e.type) {
      case 'listening': return t('dev.event.listening', { host: e.host, port: e.port });
      case 'stopped': return t('dev.event.stopped');
      case 'connection_opened': return t('dev.event.connection_opened', { id: e.connectionId, remote: e.remote });
      case 'connection_closed': return t('dev.event.connection_closed', { id: e.connectionId, reason: tr('dev.closeReason', e.reason) });
      case 'refused': return t('dev.event.refused', { reason: tr('dev.refusedReason', e.reason) });
      case 'idle': return t('dev.event.idle', { id: e.connectionId, behavior: tr('dev.idleBehavior', e.behavior) });
      case 'ignored': return e.reason === 'empty' ? t('dev.event.ignoredEmpty') : t('dev.event.ignored', { id: e.connectionId });
      case 'send_error': return t('dev.event.send_error', { id: e.connectionId, errno: e.errno ?? '' });
      case 'dropped': return t('dev.event.dropped', { length: e.length ?? 0 });
      case 'muted': return t('dev.event.muted', { length: e.length ?? 0 });
      case 'omitted': return t('dev.event.omitted', { count: e.count });
      case 'server_error': return t('dev.event.server_error', { errno: e.errno ?? '' });
      case 'variables': return t('dev.event.variables', { changes: changesText(e.changes) });
      default: return null;
    }
  }

  function onMainEvent(message) {
    switch (message.channel) {
      case 'deviceLog':
        logView.appendLog(message.payload);
        break;
      case 'deviceEvent': {
        const text = eventText(message.payload);
        if (text) logView.appendSys(text);
        break;
      }
      case 'deviceDefinition':
        // A definition loaded by the main process itself (a draft from the relay).
        D.definition = message.payload;
        D.errors = null;
        renderAll();
        break;
      case 'deviceState':
        D.server = message.payload;
        renderStatus();
        renderBanners();
        renderVars();
        renderConnections();
        renderFaults();
        updateControls();
        break;
      default:
        break;
    }
  }

  // ---- wiring ---------------------------------------------------------------------------------

  function bind() {
    $('vd-sample').addEventListener('change', loadSample);
    $('vd-refresh-samples').addEventListener('click', refreshSamples);
    // The folder may have changed since the last look: scan again whenever this tab is opened.
    document.getElementById('tab-device').addEventListener('click', refreshSamples);
    $('vd-load-file').addEventListener('click', loadFile);
    $('vd-start').addEventListener('click', start);
    $('vd-stop').addEventListener('click', stop);
    $('vd-drop-apply').addEventListener('click', () => setFault({ dropNextReplies: Number($('vd-drop-n').value) }));
    $('vd-delay-apply').addEventListener('click', () => setFault({ extraDelayMs: Number($('vd-delay-ms').value) }));
    $('vd-mute').addEventListener('change', () => setFault({ muted: $('vd-mute').checked }));
    $('vd-close-all').addEventListener('click', closeAll);
    $('vd-log-clear').addEventListener('click', logView.clear);
  }

  async function start0() {
    bind();
    wb.onEvent(onMainEvent);
    C.onLocaleChange(renderAll);
    const state = await wb.deviceState();
    D.definition = state.definition;
    D.server = state.server;
    D.samples = state.samples;
    renderAll();
    // The first look at the samples folder.
    await refreshSamples();
  }

  // What the "make from a table" dialog (table.js) needs from this view: it loads its result through
  // the same path as every other load, and it must know whether the definition can be replaced now.
  window.WbDeviceView = Object.freeze({
    applyLoadResult,
    failText,
    refreshSamples,
    isRunning: () => D.server.running,
  });

  start0().catch((error) => {
    // Show why instead of leaving the tab silently empty.
    showNotice(`Virtual device view failed to start: ${error && error.message}`, true);
  });
}());
