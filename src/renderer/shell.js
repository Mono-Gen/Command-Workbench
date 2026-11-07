// The tab bar that switches between the controller, virtual device and relay views.
// Each view owns its own state; this file only shows one and hides the other.
(function shell() {
  'use strict';

  const TAB_KEY = 'wb.tab';
  const VIEWS = [
    { name: 'controller', tab: 'tab-controller', view: 'view-controller' },
    { name: 'device', tab: 'tab-device', view: 'view-device' },
    { name: 'relay', tab: 'tab-relay', view: 'view-relay' },
  ];
  const $ = (id) => document.getElementById(id);

  function loadTab() {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (VIEWS.some((v) => v.name === saved)) return saved;
    } catch {
      // Storage can be unavailable; the first tab is used.
    }
    return 'controller';
  }

  function saveTab(name) {
    try {
      localStorage.setItem(TAB_KEY, name);
    } catch {
      // Not remembered; not worth interrupting the user.
    }
  }

  function select(name) {
    for (const v of VIEWS) {
      const active = v.name === name;
      $(v.tab).setAttribute('aria-selected', String(active));
      $(v.tab).tabIndex = active ? 0 : -1;
      $(v.view).hidden = !active;
    }
    saveTab(name);
  }

  for (const [index, v] of VIEWS.entries()) {
    $(v.tab).addEventListener('click', () => select(v.name));
    // Arrow keys move between tabs, as in a standard tab list.
    $(v.tab).addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const next = VIEWS[(index + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length];
      select(next.name);
      $(next.tab).focus();
    });
  }

  select(loadTab());
}());
