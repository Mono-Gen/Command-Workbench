// Helpers shared by the controller view and the device view (loaded as a classic script before them).
// Text from devices is untrusted: DOM is built with textContent only, never innerHTML.
// This file owns the current language and the notice toast; each view owns its own state.
(function register(root) {
  'use strict';

  const L = root.WbLogic;
  const MAX_LOG_ROWS = 5000;
  const LOCALE_KEY = 'wb.locale';

  const $ = (id) => document.getElementById(id);

  // ---- language ---------------------------------------------------------------------------

  let locale = 'ja';
  const localeListeners = [];

  function t(key, params = {}) {
    const table = root.WB_I18N[locale] || {};
    const text = table[key] ?? root.WB_I18N.ja[key];
    if (text === undefined) return key;
    return text.replace(/\{(\w+)\}/g, (_, name) => (params[name] === undefined ? `{${name}}` : String(params[name])));
  }

  function loadLocale() {
    try {
      const saved = localStorage.getItem(LOCALE_KEY);
      if (saved === 'ja' || saved === 'en') return saved;
    } catch {
      // Storage can be unavailable; the language then simply is not remembered.
    }
    return (navigator.language || '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  }

  function saveLocale(value) {
    try {
      localStorage.setItem(LOCALE_KEY, value);
    } catch {
      // Not remembered; not an error worth interrupting the user for.
    }
  }

  // Applies the language at startup (remembered or from the OS) and returns it.
  function initLocale() {
    locale = loadLocale();
    return locale;
  }

  // Changes the language, remembers it, and lets each view redraw its own text.
  function setLocale(value) {
    locale = value === 'en' ? 'en' : 'ja';
    saveLocale(locale);
    applyStaticText();
    for (const listener of localeListeners) listener(locale);
  }

  function onLocaleChange(listener) {
    localeListeners.push(listener);
  }

  function applyStaticText() {
    document.documentElement.lang = locale;
    document.title = t('app.name');
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
    for (const node of document.querySelectorAll('[data-i18n-title]')) node.title = t(node.dataset.i18nTitle);
    for (const node of document.querySelectorAll('[data-i18n-aria-label]')) node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  }

  // ---- small DOM helpers ------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  let toastTimer = null;
  function showNotice(text, isError = false) {
    const toast = $('toast');
    toast.textContent = text;
    toast.className = isError ? 'toast error' : 'toast';
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, isError ? 10000 : 4000);
  }

  const fail = (result) => L.describeFailure(result, t);

  // ---- bytes and log ----------------------------------------------------------------------

  // One cell per byte: hex above, character below; CR/LF get their own class for coloring.
  function renderCells(rows) {
    const wrap = el('div', 'bytes');
    for (const row of rows) {
      for (const cell of row.cells) {
        const node = el('span', `cell ${cell.kind}`);
        node.appendChild(el('b', '', cell.hex));
        node.appendChild(el('i', '', cell.char));
        wrap.appendChild(node);
      }
    }
    return wrap;
  }

  // A log panel with a bounded number of rows. `ids` name the three elements it needs.
  function createLogView({ logId, emptyId, truncatedId }) {
    const entries = [];
    let rows = 0;
    let removedRows = 0;

    function push(node, rowCount) {
      const log = $(logId);
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.appendChild(node);
      entries.push({ node, rowCount });
      rows += rowCount;

      // Keep memory bounded: drop the oldest entries and say so.
      while (rows > MAX_LOG_ROWS && entries.length > 1) {
        const oldest = entries.shift();
        oldest.node.remove();
        rows -= oldest.rowCount;
        removedRows += oldest.rowCount;
      }
      const note = $(truncatedId);
      note.hidden = removedRows === 0;
      if (removedRows > 0) note.textContent = t('log.sys.truncated', { count: removedRows, max: MAX_LOG_ROWS });

      $(emptyId).hidden = true;
      if (atBottom) log.scrollTop = log.scrollHeight;
    }

    // entry: { dir: 'tx'|'rx', t, length, rows, text }
    function appendLog(entry) {
      const node = el('div', `log-entry ${entry.dir}`);
      const head = el('div', 'log-head');
      head.appendChild(el('span', 'time', L.formatClock(entry.t)));
      // `label` lets a view name the direction itself (the relay says who talks to whom).
      head.appendChild(el('span', `dir ${entry.dir}`, `${entry.dir === 'tx' ? '▶ ' : '◀ '}${entry.label ?? t(`log.${entry.dir}`)}`));
      head.appendChild(el('span', 'muted', t('log.bytes', { n: entry.length })));
      // Device traffic also says which connection it belongs to and how the device understood it.
      if (entry.connectionId) head.appendChild(el('span', 'muted', `#${entry.connectionId}`));
      if (entry.note) head.appendChild(el('span', 'muted', entry.note));
      // Only the start of a very large datagram is drawn; the real size is in the byte count.
      if (entry.shown !== undefined && entry.shown < entry.length) head.appendChild(el('span', 'muted', t('log.shownOnly', { n: entry.shown })));
      if (entry.outcome) {
        const key = `dev.outcome.${entry.outcome}`;
        const label = t(key);
        head.appendChild(el('span', `outcome ${entry.outcome}`, label === key ? entry.outcome : label));
      }
      node.appendChild(head);
      node.appendChild(renderCells(entry.rows));
      node.appendChild(el('div', 'textline', L.visibleControls(entry.text)));
      push(node, Math.max(entry.rows.length, 1));
    }

    function appendSys(text) {
      const node = el('div', 'log-entry sys');
      const head = el('div', 'log-head');
      head.appendChild(el('span', 'time', L.formatClock(Date.now())));
      head.appendChild(el('span', '', text));
      node.appendChild(head);
      push(node, 1);
    }

    function clear() {
      $(logId).replaceChildren();
      entries.length = 0;
      rows = 0;
      removedRows = 0;
      $(truncatedId).hidden = true;
      $(emptyId).hidden = false;
    }

    return { appendLog, appendSys, clear };
  }

  root.WbCommon = Object.freeze({
    $, t, el, fail, showNotice, renderCells, createLogView,
    initLocale, setLocale, onLocaleChange, applyStaticText, getLocale: () => locale,
  });
}(window));
