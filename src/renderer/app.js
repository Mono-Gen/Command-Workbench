// Page logic. Runs in the sandboxed renderer: no Node access; the only way to reach the rest of
// the app is the fixed `window.workbench` bridge from preload.js.
// All text from devices is untrusted: DOM is built with textContent only, never innerHTML.
(function main() {
  'use strict';

  const wb = window.workbench;
  const L = window.WbLogic;
  const PREVIEW_DELAY_MS = 120;

  const $ = (id) => document.getElementById(id);

  // ---- state ------------------------------------------------------------------------------

  const S = {
    data: { schemaVersion: 1, devices: [] },
    load: { status: 'not_loaded', errors: [], leftoverTemps: [] },
    dataInfo: null,
    connection: 'idle',
    target: '',
    transport: 'tcp',
    selectedDevice: null,
    hints: [],
    periodic: { running: false, name: '', seconds: 0 },
    previewMessages: [],
    sendFailure: null,
    sending: false,
    editingDevice: null,
    editingCommand: null,
    suppressClosedLog: false,
  };

  // ---- shared helpers (common.js) ---------------------------------------------------------

  const C = window.WbCommon;
  const { el, t, fail, showNotice, renderCells } = C;

  // The composer's placeholder depends on the chosen input format, so it is set here, not in common.js.
  function applyStaticText() {
    C.applyStaticText();
    $('input').placeholder = t(`composer.placeholder.${$('mode').value}`);
  }

  // ---- status and controls ----------------------------------------------------------------

  const STATE_ICON = { idle: '○', connecting: '◌', connected: '●', closing: '◐', closed: '○' };

  function renderStatus() {
    const badge = $('status');
    badge.className = `badge state-${S.connection}`;
    $('status-icon').textContent = STATE_ICON[S.connection] ?? '○';
    // For UDP, "connected" only means "ready to send": say so instead of promising a connection.
    $('status-text').textContent = t(S.transport === 'udp' && S.connection === 'connected' ? 'state.udp.connected' : `state.${S.connection}`);
  }

  function updateControls() {
    const busy = ['connecting', 'connected', 'closing'].includes(S.connection);
    $('connect').disabled = busy;
    const udp = $('transport').value === 'udp';
    for (const node of document.querySelectorAll('.udp-only')) node.hidden = !udp;
    // Keepalive is a TCP feature; the transport cannot change while a connection is in use.
    $('keepalive').disabled = udp;
    $('transport').disabled = busy;
    $('local-port').disabled = busy;
    $('accept-any').disabled = busy;
    $('disconnect').disabled = !(S.connection === 'connecting' || S.connection === 'connected');
    const canSend = S.connection === 'connected' && !S.sending;
    $('send').disabled = !canSend;
    $('send').title = S.connection === 'connected' ? '' : t('err.not_connected');
    $('periodic-stop').hidden = !S.periodic.running;
    $('device-edit').disabled = S.selectedDevice === null;
    $('device-delete').disabled = S.selectedDevice === null;
  }

  // ---- banners ----------------------------------------------------------------------------

  function banner(kind, text) {
    const node = el('div', `banner ${kind}`);
    node.appendChild(el('div', 'banner-text', text));
    return node;
  }

  function renderBanners() {
    const container = $('banners');
    container.replaceChildren();
    const status = S.load.status;
    if (['corrupt', 'invalid', 'unsupported', 'too_large', 'read_error'].includes(status)) {
      container.appendChild(banner('error', t(`banner.load.${status}`, { code: S.load.code ?? '', errno: S.load.errno ?? '' })));
    }
    if (S.dataInfo && S.dataInfo.ok === false) {
      container.appendChild(banner('error', t('banner.load.read_error', { code: S.dataInfo.code, errno: '' })));
    }
    if (S.load.leftoverTemps && S.load.leftoverTemps.length > 0) {
      container.appendChild(banner('warn', t('banner.leftover', { count: S.load.leftoverTemps.length })));
    }
    // Where the commands are saved is a standing fact, not a warning: it lives in the status bar.
    $('statusbar').textContent = S.dataInfo && S.dataInfo.ok
      ? t('banner.dataDir', { path: `${S.dataInfo.dir} (${S.dataInfo.fileName})` })
      : '';
  }

  // ---- devices and commands ---------------------------------------------------------------

  function currentDevice() {
    return S.data.devices.find((d) => d.name === S.selectedDevice) ?? null;
  }

  function renderDevices() {
    const select = $('device-select');
    select.replaceChildren();
    for (const device of S.data.devices) {
      const option = el('option', '', device.name);
      option.value = device.name;
      select.appendChild(option);
    }
    if (!currentDevice()) {
      S.selectedDevice = S.data.devices.length > 0 ? S.data.devices[0].name : null;
    }
    if (S.selectedDevice !== null) select.value = S.selectedDevice;
    $('devices-none').hidden = S.data.devices.length > 0;
    select.hidden = S.data.devices.length === 0;
  }

  function fillTargetFromDevice() {
    const device = currentDevice();
    if (device) {
      $('host').value = device.host;
      $('port').value = String(device.port);
      $('transport').value = device.transport === 'udp' ? 'udp' : 'tcp';
      $('local-port').value = device.localPort === undefined ? '' : String(device.localPort);
      $('accept-any').checked = device.acceptAnySource === true;
      updateControls();
    }
  }

  function renderCommands() {
    const list = $('command-list');
    list.replaceChildren();
    const device = currentDevice();
    const commands = device ? device.commands : [];
    $('commands-empty').hidden = commands.length > 0 || device === null;

    for (const command of commands) {
      const item = el('li', 'command-item');
      const head = el('div', 'row');
      head.appendChild(el('span', 'name', command.name));
      item.appendChild(head);
      item.appendChild(el('div', 'text mono', command.text));

      const actions = el('div', 'actions');
      const send = el('button', 'small primary', t('commands.send'));
      send.type = 'button';
      send.disabled = S.connection !== 'connected' || S.sending;
      if (S.connection !== 'connected') send.title = t('err.not_connected');
      send.addEventListener('click', () => sendSaved(command));
      actions.appendChild(send);

      const repeat = el('button', 'small', t('commands.periodic'));
      repeat.type = 'button';
      repeat.disabled = S.connection !== 'connected' || S.periodic.running;
      repeat.addEventListener('click', () => startPeriodic(command));
      actions.appendChild(repeat);
      const edit = el('button', 'small', t('commands.edit'));
      edit.type = 'button';
      edit.addEventListener('click', () => openCommandDialog(command));
      actions.appendChild(edit);
      const remove = el('button', 'small', t('commands.delete'));
      remove.type = 'button';
      remove.addEventListener('click', () => deleteCommand(command));
      actions.appendChild(remove);
      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  async function commit(nextData) {
    if (nextData === null) {
      showNotice(t('err.unknown_command'), true);
      return { ok: false };
    }
    const result = await wb.saveData(nextData);
    if (result.ok) {
      S.data = result.data;
      renderDevices();
      renderCommands();
      updateControls();
    }
    return result;
  }

  // ---- device dialog ----------------------------------------------------------------------

  function openDeviceDialog(editing) {
    const device = editing ? currentDevice() : null;
    S.editingDevice = device ? device.name : null;
    $('device-name').value = device ? device.name : L.nextDefaultName('Device', S.data.devices.map((d) => d.name));
    $('device-host').value = device ? device.host : $('host').value;
    $('device-port').value = device ? String(device.port) : $('port').value;
    $('device-transport').value = device ? (device.transport === 'udp' ? 'udp' : 'tcp') : $('transport').value;
    $('device-local-port').value = device && device.localPort !== undefined ? String(device.localPort) : $('local-port').value;
    $('device-accept-any').checked = device ? device.acceptAnySource === true : $('accept-any').checked;
    updateDeviceDialog();
    $('device-error').textContent = '';
    $('device-dialog').showModal();
    $('device-name').select();
  }

  // The UDP settings of the device dialog are shown only for UDP.
  function updateDeviceDialog() {
    const udp = $('device-transport').value === 'udp';
    for (const node of document.querySelectorAll('.device-udp')) node.hidden = !udp;
  }

  async function submitDevice(event) {
    event.preventDefault();
    const device = { name: $('device-name').value, host: $('device-host').value.trim(), port: Number($('device-port').value) };
    if ($('device-transport').value === 'udp') {
      device.transport = 'udp';
      const localPort = $('device-local-port').value.trim();
      if (localPort !== '') device.localPort = Number(localPort);
      device.acceptAnySource = $('device-accept-any').checked;
    }
    const next = L.withDevice(S.data, S.editingDevice, device);
    const result = await commit(next);
    if (!result.ok) {
      $('device-error').textContent = fail(result);
      return;
    }
    S.selectedDevice = device.name;
    renderDevices();
    fillTargetFromDevice();
    renderCommands();
    $('device-dialog').close();
    showNotice(t('toast.saved'));
  }

  async function deleteDevice() {
    const device = currentDevice();
    if (!device || !window.confirm(t('devices.deleteConfirm', { name: device.name }))) return;
    const result = await commit(L.withoutDevice(S.data, device.name));
    if (!result.ok) showNotice(fail(result), true);
    else showNotice(t('toast.saved'));
  }

  // ---- command dialog ---------------------------------------------------------------------

  function openCommandDialog(existing, fromComposer) {
    if (!currentDevice()) {
      showNotice(t('commands.needDevice'), true);
      return;
    }
    S.editingCommand = existing ? existing.name : null;
    const device = currentDevice();
    $('command-name').value = existing ? existing.name : L.nextDefaultName('New command', device.commands.map((c) => c.name));
    $('command-text').value = existing ? existing.text : fromComposer.text;
    $('command-mode').value = existing ? existing.mode : fromComposer.mode;
    $('command-terminator').value = existing ? existing.appendTerminator : fromComposer.appendTerminator;
    $('command-expects-reply').checked = existing ? existing.expectsReply !== false : fromComposer.expectsReply;
    $('command-error').textContent = '';
    $('command-dialog').showModal();
    $('command-name').select();
  }

  async function submitCommand(event) {
    event.preventDefault();
    const device = currentDevice();
    const command = {
      name: $('command-name').value,
      text: $('command-text').value,
      mode: $('command-mode').value,
      appendTerminator: $('command-terminator').value,
      expectsReply: $('command-expects-reply').checked,
    };
    const result = await commit(L.withCommand(S.data, device.name, S.editingCommand, command));
    if (!result.ok) {
      $('command-error').textContent = fail(result);
      return;
    }
    $('command-dialog').close();
    showNotice(t('toast.saved'));
  }

  async function deleteCommand(command) {
    if (!window.confirm(t('commands.deleteConfirm', { name: command.name }))) return;
    const result = await commit(L.withoutCommand(S.data, S.selectedDevice, command.name));
    if (!result.ok) showNotice(fail(result), true);
  }

  // ---- log --------------------------------------------------------------------------------

  const logView = C.createLogView({ logId: 'log', emptyId: 'log-empty', truncatedId: 'log-truncated' });
  const { appendLog, appendSys } = logView;
  const clearLog = logView.clear;

  // ---- hints and periodic -----------------------------------------------------------------

  function renderHints() {
    const box = $('hints');
    box.replaceChildren();
    for (const hint of S.hints) {
      const card = el('div', `hint ${hint.confidence}`);
      card.appendChild(el('h4', '', t(`hint.${hint.id}.title`)));
      card.appendChild(el('p', '', t(`hint.${hint.id}.body`)));
      if (hint.confidence === 'low') card.appendChild(el('span', 'confidence', t('hints.low')));
      box.appendChild(card);
    }
    $('hints-empty').hidden = S.hints.length > 0;
  }

  function renderPeriodic() {
    $('periodic-status').textContent = S.periodic.running
      ? t('periodic.running', { name: S.periodic.name, seconds: S.periodic.seconds })
      : t('periodic.pick');
    updateControls();
  }

  async function startPeriodic(command) {
    const seconds = Number($('periodic-seconds').value);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) {
      showNotice(t('err.invalid_interval'), true);
      return;
    }
    const result = await wb.startPeriodic({ device: S.selectedDevice, command: command.name, intervalMs: seconds * 1000 });
    if (!result.ok && result.code !== 'cancelled') showNotice(fail(result), true);
  }

  // ---- composer ---------------------------------------------------------------------------

  const composerSpec = () => ({ text: $('input').value, mode: $('mode').value, appendTerminator: $('terminator').value });

  function renderComposeMessages() {
    const list = $('compose-messages');
    list.replaceChildren();
    for (const message of S.previewMessages) list.appendChild(el('li', message.level === 'warn' ? 'warn' : '', message.text));
    if (S.sendFailure) list.appendChild(el('li', '', S.sendFailure));
  }

  let previewTimer = null;
  let previewSeq = 0;

  async function updatePreview() {
    const seq = ++previewSeq;
    const spec = composerSpec();
    const box = $('preview');
    if (spec.text === '') {
      box.replaceChildren(el('span', 'muted', t('composer.preview.empty')));
      S.previewMessages = [];
      renderComposeMessages();
      return;
    }
    const result = await wb.parsePreview(spec);
    // A newer keystroke may have been handled while this one was waiting.
    if (seq !== previewSeq) return;

    box.replaceChildren();
    S.previewMessages = [];
    if (result.ok) {
      box.appendChild(renderCells(result.rows));
      box.appendChild(el('div', 'muted', t('composer.preview.bytes', { n: result.length })));
      for (const code of result.warnings) S.previewMessages.push({ level: 'warn', text: t(`warn.${code}`) });
      // Not an error: a device that takes UTF-8 gets it. The warning is for the common slip of
      // full-width letters or spaces copied from a manual, which look like ASCII but are not.
      if (spec.mode === 'text') {
        const found = L.findNonAscii(spec.text);
        if (found.total > 0) {
          const parts = found.items.map((item) => t(`warn.non_ascii.${item.kind}`, { position: item.position, char: item.char, code: item.code }));
          if (found.total > found.items.length) parts.push(t('warn.non_ascii.more', { count: found.total - found.items.length }));
          S.previewMessages.push({ level: 'warn', text: t('warn.non_ascii', { items: parts.join(', ') }) });
        }
      }
    } else if (Array.isArray(result.errors)) {
      for (const error of result.errors) S.previewMessages.push({ level: 'error', text: t(`parse.${error.code}`, { position: error.position }) });
    } else {
      S.previewMessages.push({ level: 'error', text: fail(result) });
    }
    renderComposeMessages();
  }

  function queuePreview() {
    S.sendFailure = null;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, PREVIEW_DELAY_MS);
  }

  async function sendDirect() {
    if (S.sending) return;
    const spec = { ...composerSpec(), expectsReply: $('expects-reply').checked };
    if (spec.text === '') {
      $('input').focus();
      return;
    }
    S.sending = true;
    updateControls();
    try {
      const result = await wb.sendDirect(spec);
      S.sendFailure = result.ok || result.code === 'cancelled' ? null : fail(result);
      renderComposeMessages();
    } finally {
      S.sending = false;
      updateControls();
    }
  }

  async function sendSaved(command) {
    // One send at a time from the page: a double click must not send twice.
    if (S.sending) return;
    S.sending = true;
    updateControls();
    renderCommands();
    try {
      const result = await wb.sendSaved({ device: S.selectedDevice, command: command.name });
      if (!result.ok && result.code !== 'cancelled') showNotice(fail(result), true);
    } finally {
      S.sending = false;
      updateControls();
      renderCommands();
    }
  }

  // ---- events from the main process -------------------------------------------------------

  function onConnectionEvent(event) {
    if (event.type === 'state') {
      S.connection = event.state;
      if (event.state === 'connecting') {
        S.suppressClosedLog = false;
        appendSys(t('log.sys.connecting', { target: S.target }));
      } else if (event.state === 'connected') {
        appendSys(t(S.transport === 'udp' ? 'log.sys.udp.ready' : 'log.sys.connected'));
      } else if (event.state === 'closed') {
        // A failed connect already logged its own line; do not add "disconnected" after it.
        if (S.suppressClosedLog) S.suppressClosedLog = false;
        else appendSys(t('log.sys.closed'));
      }
      renderStatus();
      updateControls();
      renderCommands();
    } else if (event.type === 'connect_fail') {
      S.suppressClosedLog = true;
      // A refused UDP target has its own explanation; other codes are shown as they are.
      const known = t(`conn.fail.${event.code}`);
      appendSys(known === `conn.fail.${event.code}` ? t('log.sys.failed', { code: event.code }) : `${t('log.sys.failed', { code: event.code })} ${known}`);
    } else if (event.type === 'recv_empty') {
      appendSys(t('log.sys.udp.empty'));
    } else if (event.type === 'send_error') {
      appendSys(t('log.sys.udp.sendError', { code: event.code }));
    } else if (event.type === 'socket_closed') {
      appendSys(t('log.sys.udp.lost', { code: event.code ?? '' }));
    } else if (event.type === 'recv_throttled') {
      appendSys(t('log.sys.tcp.throttled'));
    } else if (event.type === 'recv_flood') {
      appendSys(t('log.sys.udp.flood', { count: event.dropped }));
    }
  }

  function onPeriodic(payload) {
    if (payload.running) {
      S.periodic = { running: true, name: payload.command, seconds: payload.intervalMs / 1000 };
    } else {
      S.periodic = { running: false, name: '', seconds: 0 };
      showNotice(t(`periodic.stopped.${payload.reason}`), payload.reason === 'send_failed');
    }
    renderPeriodic();
    renderCommands();
  }

  function onMainEvent(message) {
    switch (message.channel) {
      case 'event': onConnectionEvent(message.payload); break;
      case 'log': appendLog(message.payload); break;
      case 'hints': S.hints = message.payload.hints; renderHints(); break;
      case 'periodic': onPeriodic(message.payload); break;
      default: break;
    }
  }

  // ---- wiring -----------------------------------------------------------------------------

  async function connect() {
    const host = $('host').value.trim();
    const port = Number($('port').value);
    S.target = `${host}:${port}`;
    S.transport = $('transport').value === 'udp' ? 'udp' : 'tcp';
    let request;
    if (S.transport === 'udp') {
      request = { transport: 'udp', host, port, acceptAnySource: $('accept-any').checked };
      const localPort = $('local-port').value.trim();
      if (localPort !== '') request.localPort = Number(localPort);
    } else {
      request = { host, port, keepAlive: { enabled: $('keepalive').checked } };
    }
    const result = await wb.connect(request);
    if (!result.ok) showNotice(fail(result), true);
  }

  function renderAll() {
    applyStaticText();
    renderStatus();
    renderBanners();
    renderDevices();
    renderCommands();
    renderHints();
    renderPeriodic();
    updateControls();
    updatePreview();
  }

  function bind() {
    $('connect').addEventListener('click', connect);
    $('transport').addEventListener('change', updateControls);
    $('device-transport').addEventListener('change', updateDeviceDialog);
    $('disconnect').addEventListener('click', () => wb.disconnect());
    $('keepalive').addEventListener('change', async () => {
      if (S.connection === 'connected') {
        const result = await wb.setKeepAlive({ enabled: $('keepalive').checked });
        if (!result.ok) showNotice(fail(result), true);
      }
    });
    $('locale').addEventListener('change', () => {
      C.setLocale($('locale').value);
      wb.setLocale(C.getLocale());
      renderAll();
    });

    $('device-select').addEventListener('change', () => {
      S.selectedDevice = $('device-select').value;
      fillTargetFromDevice();
      renderCommands();
      updateControls();
    });
    $('device-add').addEventListener('click', () => openDeviceDialog(false));
    $('device-edit').addEventListener('click', () => openDeviceDialog(true));
    $('device-delete').addEventListener('click', deleteDevice);
    $('device-form').addEventListener('submit', submitDevice);
    $('device-cancel').addEventListener('click', () => $('device-dialog').close());
    $('command-form').addEventListener('submit', submitCommand);
    $('command-cancel').addEventListener('click', () => $('command-dialog').close());

    $('log-clear').addEventListener('click', clearLog);
    $('periodic-stop').addEventListener('click', () => wb.stopPeriodic());

    for (const id of ['input', 'mode', 'terminator']) $(id).addEventListener('input', queuePreview);
    $('mode').addEventListener('change', () => { $('input').placeholder = t(`composer.placeholder.${$('mode').value}`); });
    $('input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        sendDirect();
      }
    });
    $('send').addEventListener('click', sendDirect);
    $('save-command').addEventListener('click', () => {
      const spec = { ...composerSpec(), expectsReply: $('expects-reply').checked };
      if (spec.text === '') {
        $('input').focus();
        return;
      }
      openCommandDialog(null, spec);
    });
  }

  async function start() {
    const locale = C.initLocale();
    $('locale').value = locale;
    bind();
    wb.onEvent(onMainEvent);
    await wb.setLocale(locale);

    const state = await wb.init();
    S.data = state.data;
    S.load = state.load;
    S.dataInfo = state.dataInfo;
    S.connection = state.connectionState;
    S.transport = state.transport === 'udp' ? 'udp' : 'tcp';
    $('port').value = '23';
    renderAll();
    fillTargetFromDevice();
  }

  start().catch((error) => {
    // The page cannot work without the bridge; show why instead of staying blank.
    document.body.textContent = `Failed to start: ${error && error.message}`;
  });
}());
