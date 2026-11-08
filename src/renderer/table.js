// The "make a definition from a table" dialog of the virtual device tab. Runs in the sandboxed
// renderer: it only sends the cells of the table to the main process, which builds and checks the
// definition. The page never builds a definition itself and never learns a file path.
// Text from the user is put into the page with textContent / value only.
(function tableDialog() {
  'use strict';

  const wb = window.workbench;
  const C = window.WbCommon;
  const L = window.WbLogic;
  const { $, el, t, fail, showNotice } = C;

  const MAX_ROWS = 500; // the same limit as the core; the main process reports it per row as well
  const PREVIEW_DELAY_MS = 150;

  const S = {
    errors: null, // the last list of problems, kept so a language change can draw it again
    ready: false, // the last preview was a valid definition
    busy: false, // a use / save call is on its way
    seq: 0, // only the newest preview answer is shown
    timer: null,
    defaultName: '',
    newNameTouched: false, // the user wrote the name of the new controller device themselves
    loadReport: null,
  };

  const rowsBody = () => $('tbl-rows');
  const rowElements = () => Array.from(rowsBody().children);
  const commandInput = (row) => row.querySelector('.cmd');
  const replyInput = (row) => row.querySelector('.rep');
  const isBlank = (row) => commandInput(row).value.trim() === '' && replyInput(row).value === '';

  // ---- the table of rows ----------------------------------------------------------------------

  function placeholders() {
    for (const row of rowElements()) {
      commandInput(row).placeholder = t('tbl.placeholder.command');
      replyInput(row).placeholder = t('tbl.placeholder.reply');
      commandInput(row).setAttribute('aria-label', t('tbl.col.command'));
      replyInput(row).setAttribute('aria-label', t('tbl.col.reply'));
    }
  }

  function renumber() {
    const rows = rowElements();
    rows.forEach((row, index) => {
      row.querySelector('.num').textContent = String(index + 1);
      const remove = row.querySelector('button');
      remove.textContent = t('tbl.row.remove');
      remove.setAttribute('aria-label', t('tbl.row.removeLabel', { row: index + 1 }));
      // The empty row at the end is the place to type the next command: there is nothing to remove.
      remove.disabled = index === rows.length - 1 && isBlank(row);
    });
  }

  function addRow(values = {}) {
    const row = el('tr');
    row.appendChild(el('td', 'num'));
    for (const [className, key] of [['cmd', 'command'], ['rep', 'reply']]) {
      const cell = el('td');
      const input = el('input', `${className} mono`);
      input.type = 'text';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.value = values[key] ?? '';
      input.setAttribute('aria-label', t(key === 'command' ? 'tbl.col.command' : 'tbl.col.reply'));
      cell.appendChild(input);
      row.appendChild(cell);
    }
    const removeCell = el('td');
    const remove = el('button', 'small', t('tbl.row.remove'));
    remove.type = 'button';
    removeCell.appendChild(remove);
    row.appendChild(removeCell);
    rowsBody().appendChild(row);
    renumber();
    placeholders();
    return row;
  }

  // The last row is always an empty one to type into, so the table grows as the user writes.
  function ensureBlankTail() {
    const rows = rowElements();
    if (rows.length === 0 || !isBlank(rows[rows.length - 1])) addRow();
  }

  function onRowsInput() {
    ensureBlankTail();
    renumber();
    schedulePreview();
  }

  function onRowsClick(event) {
    const button = event.target.closest('button');
    if (!button || !rowsBody().contains(button)) return;
    const row = button.closest('tr');
    row.remove();
    ensureBlankTail();
    renumber();
    schedulePreview();
  }

  // ---- reading the form -----------------------------------------------------------------------

  function readTable() {
    const udp = $('tbl-transport').value === 'udp';
    return {
      name: $('tbl-name').value,
      transport: $('tbl-transport').value,
      terminator: $('tbl-terminator').value,
      // A UDP exchange has no connection to greet: the field is disabled and not sent.
      greeting: udp ? '' : $('tbl-greeting').value,
      unknownReply: $('tbl-unknown').value,
      rows: rowElements().map((row) => ({ command: commandInput(row).value, reply: replyInput(row).value })),
    };
  }

  function syncTransport() {
    const udp = $('tbl-transport').value === 'udp';
    $('tbl-greeting').disabled = udp;
    $('tbl-greeting').placeholder = udp ? t('tbl.greeting.udp') : '';
  }

  // ---- problems -------------------------------------------------------------------------------

  function codeText(error) {
    if (error.source === 'table') {
      const first = error.detail && Number.isInteger(error.detail.firstRow) ? error.detail.firstRow + 1 : '';
      const key = `tbl.err.${error.code}`;
      const text = t(key, { first });
      return text === key ? error.code : text;
    }
    const key = `dev.defcode.${error.code}`;
    const text = t(key);
    return text === key ? error.code : text;
  }

  function whereText(where) {
    if (Number.isInteger(where.row)) return t('tbl.where.row', { row: where.row + 1 });
    const key = `tbl.where.${where.field}`;
    const text = t(key);
    return text === key ? String(where.field) : text;
  }

  function clearMarks() {
    for (const input of document.querySelectorAll('#table-dialog [aria-invalid]')) input.removeAttribute('aria-invalid');
  }

  // Marks the cells a problem is about (the list says it in words too: color is never the only sign).
  function markErrors(errors) {
    clearMarks();
    const fields = { name: 'tbl-name', greeting: 'tbl-greeting', unknownReply: 'tbl-unknown', transport: 'tbl-transport', terminator: 'tbl-terminator' };
    const rows = rowElements();
    for (const error of errors) {
      const { where } = error;
      if (Number.isInteger(where.row) && rows[where.row]) {
        const onlyCommand = error.code.startsWith('command_');
        const onlyReply = error.code.startsWith('reply_');
        if (!onlyReply) commandInput(rows[where.row]).setAttribute('aria-invalid', 'true');
        if (!onlyCommand && error.source !== 'table') replyInput(rows[where.row]).setAttribute('aria-invalid', 'true');
        if (onlyReply) replyInput(rows[where.row]).setAttribute('aria-invalid', 'true');
      } else if (fields[where.field]) {
        $(fields[where.field]).setAttribute('aria-invalid', 'true');
      }
    }
  }

  function renderErrors() {
    const box = $('tbl-errors');
    box.replaceChildren();
    if (S.errors === null) {
      clearMarks();
      return;
    }
    box.appendChild(el('h3', '', t('tbl.errors.title')));
    const list = el('ul', 'messages');
    for (const error of S.errors.items) {
      // An empty table is the starting point, not a mistake: it is shown quietly.
      const item = el('li', error.code === 'no_rows' ? 'warn' : '', `${whereText(error.where)}: ${codeText(error)}`);
      list.appendChild(item);
    }
    box.appendChild(list);
    if (S.errors.total > S.errors.items.length) {
      box.appendChild(el('p', 'muted small-text', t('dev.def.more', { count: S.errors.total - S.errors.items.length })));
    }
    markErrors(S.errors.items);
  }

  // ---- preview --------------------------------------------------------------------------------

  function updateButtons() {
    const running = window.WbDeviceView.isRunning();
    $('tbl-load').disabled = S.busy;
    $('tbl-use').disabled = S.busy || !S.ready || running;
    $('tbl-save').disabled = S.busy || !S.ready;
    $('tbl-import-go').disabled = S.busy || !S.ready;
    $('tbl-lock').textContent = running ? t('tbl.runningLocked') : '';
  }

  function loadReasonText(reason) {
    const key = `tbl.load.reason.${reason.code}`;
    const detail = reason.detail && typeof reason.detail === 'object' ? reason.detail : {};
    const where = Number.isInteger(detail.index)
      ? t('tbl.where.row', { row: detail.index + 1 })
      : t(`tbl.where.${detail.field ?? 'definition'}`);
    const text = t(key, {
      field: typeof detail.field === 'string' ? detail.field : '',
      row: Number.isInteger(detail.index) ? detail.index + 1 : '',
      where,
      value: detail.value === undefined ? '' : String(detail.value),
    });
    if (text !== key) return text;
    const tableKey = `tbl.err.${reason.code}`;
    const tableText = t(tableKey, { first: '' });
    return tableText === tableKey ? reason.code : tableText;
  }

  function renderLoadReport() {
    const box = $('tbl-load-note');
    box.replaceChildren();
    const report = S.loadReport;
    if (report === null) return;
    if (report.kind === 'pending') {
      box.appendChild(el('p', 'muted small-text', t('tbl.load.pending')));
      return;
    }
    if (report.kind === 'success') {
      box.appendChild(el('p', 'info-line', t('tbl.load.loaded', { file: report.fileName })));
      return;
    }
    if (report.kind === 'failure') {
      box.appendChild(el('p', 'error', window.WbDeviceView.failText(report.result)));
      return;
    }
    box.appendChild(el('p', 'error', t(report.kind === 'invalid' ? 'tbl.load.invalid' : 'tbl.load.rejected', { file: report.fileName })));
    const list = el('ul', 'messages');
    if (report.kind === 'invalid') {
      for (const error of report.items) {
        const key = `dev.defcode.${error.code}`;
        const message = t(key);
        const item = el('li', '', message === key ? error.code : message);
        item.appendChild(el('div', 'muted small-text mono', t('tbl.load.at', { pointer: error.pointer || '/' })));
        list.appendChild(item);
      }
    } else {
      for (const reason of report.items) list.appendChild(el('li', '', loadReasonText(reason)));
    }
    box.appendChild(list);
    if (report.total > report.items.length) {
      box.appendChild(el('p', 'muted small-text', t('dev.def.more', { count: report.total - report.items.length })));
    }
  }

  function applyLoadedTable(input) {
    $('tbl-name').value = input.name;
    $('tbl-transport').value = input.transport;
    $('tbl-terminator').value = input.terminator;
    $('tbl-greeting').value = input.greeting;
    $('tbl-unknown').value = input.unknownReply;
    rowsBody().replaceChildren();
    for (const row of input.rows) addRow(row);
    ensureBlankTail();
    syncTransport();
    populateTargets();
    schedulePreview();
  }

  async function loadDefinition() {
    if (S.busy) return;
    S.busy = true;
    S.loadReport = { kind: 'pending' };
    renderLoadReport();
    updateButtons();
    try {
      const result = await wb.deviceTableLoad();
      if (result.ok) {
        applyLoadedTable(result.input);
        S.loadReport = { kind: 'success', fileName: result.fileName };
      } else if (result.code === 'invalid_definition') {
        S.loadReport = {
          kind: 'invalid', fileName: result.fileName, items: result.errors, total: result.totalErrors,
        };
      } else if (result.code === 'definition_not_table') {
        S.loadReport = {
          kind: 'rejected', fileName: result.fileName, items: result.reasons, total: result.totalReasons,
        };
      } else if (result.code === 'cancelled') {
        S.loadReport = null;
      } else {
        S.loadReport = { kind: 'failure', result };
      }
    } catch (error) {
      S.loadReport = { kind: 'failure', result: { code: 'internal_error' } };
    } finally {
      S.busy = false;
      renderLoadReport();
      updateButtons();
    }
  }

  function showResult(result) {
    if (result.ok) {
      S.errors = null;
      S.ready = true;
      $('tbl-json').textContent = result.text;
    } else if (result.code === 'invalid_table') {
      S.errors = { items: result.errors, total: result.totalErrors };
      S.ready = false;
      $('tbl-json').textContent = t('tbl.json.invalid');
    } else {
      S.errors = null;
      S.ready = false;
      $('tbl-json').textContent = t('tbl.json.invalid');
      showNotice(window.WbDeviceView.failText(result), true);
    }
    renderErrors();
    renderLoadReport();
    updateButtons();
  }

  async function preview() {
    const seq = ++S.seq;
    let result;
    try {
      result = await wb.deviceTablePreview(readTable());
    } catch (error) {
      result = { ok: false, code: 'internal_error' };
    }
    if (seq !== S.seq) return; // a newer edit has its own answer on the way
    showResult(result);
  }

  function schedulePreview() {
    // Nothing is usable until the answer for THIS text arrives; an answer already on its way is for
    // older text and must not switch the buttons back on.
    S.seq += 1;
    S.ready = false;
    updateButtons();
    clearTimeout(S.timer);
    S.timer = setTimeout(preview, PREVIEW_DELAY_MS);
  }

  // ---- paste ----------------------------------------------------------------------------------

  function applyPaste() {
    const parsed = L.parseTablePaste($('tbl-paste').value);
    const note = $('tbl-paste-note');
    if (parsed.rows.length === 0) {
      note.textContent = t('tbl.paste.none');
      return;
    }
    // The empty row at the end is replaced by the pasted rows (a new empty one follows).
    const rows = rowElements();
    while (rows.length > 0 && isBlank(rows[rows.length - 1])) rows.pop().remove();
    if (rowElements().length + parsed.rows.length > MAX_ROWS) {
      note.textContent = t('tbl.paste.tooMany', { max: MAX_ROWS });
      ensureBlankTail();
      return;
    }
    for (const row of parsed.rows) addRow(row);
    ensureBlankTail();
    $('tbl-paste').value = '';
    note.textContent = t('tbl.paste.done', { count: parsed.rows.length })
      + (parsed.stripped > 0 ? ` ${t('tbl.paste.stripped', { count: parsed.stripped })}` : '');
    schedulePreview();
  }

  // ---- use and save ---------------------------------------------------------------------------

  async function run(call, onOk) {
    if (S.busy || !S.ready) return;
    S.busy = true;
    updateButtons();
    try {
      const result = await call(readTable());
      if (result.ok) {
        onOk(result);
      } else if (result.code === 'invalid_table') {
        showResult(result);
      } else if (result.code !== 'cancelled') {
        showNotice(window.WbDeviceView.failText(result), true);
      }
    } catch (error) {
      showNotice(window.WbDeviceView.failText({ code: 'internal_error' }), true);
    } finally {
      S.busy = false;
      updateButtons();
    }
  }

  const useDefinition = () => run(wb.deviceTableUse, (result) => {
    window.WbDeviceView.applyLoadResult(result);
    $('table-dialog').close();
    showNotice(t('tbl.used', { name: result.info.name }));
  });

  const saveDefinition = () => run(wb.deviceTableSave, (result) => {
    showNotice(t('tbl.saved', { file: result.fileName }));
    // A file saved into the definitions folder shows up in the list at once.
    window.WbDeviceView.refreshSamples();
  });

  // ---- add the commands to a saved controller device ------------------------------------------

  const importNote = (text) => { $('tbl-import-note').textContent = text; };

  // The saved devices of the controller view, plus "new device". Asked again whenever the section is
  // opened, because devices may have been added or removed since.
  function populateTargets() {
    const select = $('tbl-target');
    const previous = select.value;
    select.replaceChildren();
    for (const name of window.WbControllerView.deviceNames()) {
      const option = el('option', '', name);
      option.value = `existing:${name}`;
      select.appendChild(option);
    }
    const fresh = el('option', '', t('tbl.import.new'));
    fresh.value = 'new';
    select.appendChild(fresh);
    const values = Array.from(select.options, (option) => option.value);
    select.value = values.includes(previous) ? previous : values[0];
    syncTarget();
  }

  function syncTarget() {
    const isNew = $('tbl-target').value === 'new';
    $('tbl-new-fields').hidden = !isNew;
    if (!isNew) return;
    // Until the user writes a name of their own, the new device is named like the table.
    if (!S.newNameTouched) $('tbl-new-name').value = $('tbl-name').value;
    const port = window.WbDeviceView.runningPort();
    if ($('tbl-new-port').value === '' && port !== null) $('tbl-new-port').value = String(port);
  }

  async function importCommands() {
    if (S.busy || !S.ready) return;
    let target;
    let deviceName;
    if ($('tbl-target').value === 'new') {
      const port = Number($('tbl-new-port').value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        importNote(t('tbl.import.needPort'));
        return;
      }
      deviceName = $('tbl-new-name').value;
      target = { create: { name: deviceName, host: $('tbl-new-host').value, port } };
    } else {
      deviceName = $('tbl-target').value.slice('existing:'.length);
      target = { existing: deviceName };
    }
    S.busy = true;
    updateButtons();
    importNote('');
    try {
      const result = await wb.importTable({ table: readTable(), target });
      if (result.ok) {
        window.WbControllerView.applyData(result.data, deviceName);
        populateTargets();
        // A device that was just created is now one of the saved ones: a second press adds to it.
        $('tbl-target').value = `existing:${deviceName}`;
        syncTarget();
        let text = result.added > 0
          ? t('tbl.import.done', { device: deviceName, added: result.added })
          : t('tbl.import.none');
        if (result.skipped.length > 0) {
          const shown = result.skipped.slice(0, 5).join(', ');
          const more = result.skipped.length > 5 ? ', …' : '';
          text += ` ${t('tbl.import.skipped', { count: result.skipped.length, names: shown + more })}`;
        }
        importNote(text);
      } else if (result.code === 'invalid_table') {
        showResult(result);
        importNote(t('dev.err.invalid_table'));
      } else {
        importNote(fail(result));
      }
    } catch (error) {
      importNote(fail({ code: 'internal_error' }));
    } finally {
      S.busy = false;
      updateButtons();
    }
  }

  // ---- wiring ---------------------------------------------------------------------------------

  function open() {
    updateButtons();
    populateTargets();
    $('table-dialog').showModal();
    $('tbl-name').focus();
    schedulePreview();
  }

  function onLocaleChange() {
    // The default name follows the language until the user has written their own.
    const next = t('tbl.defaultName');
    if ($('tbl-name').value === S.defaultName) $('tbl-name').value = next;
    S.defaultName = next;
    populateTargets();
    syncTransport();
    placeholders();
    renumber();
    renderErrors();
    renderLoadReport();
    if (!S.ready) $('tbl-json').textContent = t('tbl.json.invalid');
    updateButtons();
  }

  function bind() {
    $('vd-make-table').addEventListener('click', open);
    $('tbl-close').addEventListener('click', () => $('table-dialog').close());
    $('tbl-load').addEventListener('click', loadDefinition);
    // Enter in a field must not submit the form (that would close the dialog).
    $('table-form').addEventListener('submit', (event) => event.preventDefault());
    for (const id of ['tbl-name', 'tbl-greeting', 'tbl-unknown', 'tbl-terminator']) $(id).addEventListener('input', schedulePreview);
    $('tbl-transport').addEventListener('change', () => { syncTransport(); schedulePreview(); });
    rowsBody().addEventListener('input', onRowsInput);
    rowsBody().addEventListener('click', onRowsClick);
    $('tbl-add-row').addEventListener('click', () => {
      const rows = rowElements();
      const blank = rows.length > 0 && isBlank(rows[rows.length - 1]) ? rows[rows.length - 1] : addRow();
      commandInput(blank).focus();
    });
    $('tbl-paste-apply').addEventListener('click', applyPaste);
    $('tbl-use').addEventListener('click', useDefinition);
    $('tbl-save').addEventListener('click', saveDefinition);
    $('tbl-target').addEventListener('change', syncTarget);
    $('tbl-new-name').addEventListener('input', () => { S.newNameTouched = true; });
    $('tbl-name').addEventListener('input', () => { if ($('tbl-target').value === 'new') syncTarget(); });
    $('tbl-import-go').addEventListener('click', importCommands);
    $('tbl-import').addEventListener('toggle', () => { if ($('tbl-import').open) populateTargets(); });
    C.onLocaleChange(onLocaleChange);
  }

  function init() {
    S.defaultName = t('tbl.defaultName');
    $('tbl-name').value = S.defaultName;
    addRow();
    syncTransport();
    $('tbl-json').textContent = t('tbl.json.invalid');
    bind();
  }

  init();
}());
