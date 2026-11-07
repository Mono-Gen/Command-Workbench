// Preload script: the only bridge between the page and the main process.
// Policy: expose a fixed set of named functions, never a generic invoke(channel, ...), so a
// compromised page cannot reach arbitrary IPC channels. Raw IPC event objects are not passed on.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (arg) => ipcRenderer.invoke(`wb:${name}`, arg);

contextBridge.exposeInMainWorld('workbench', Object.freeze({
  init: call('init'),
  saveData: call('saveData'),
  parsePreview: call('parsePreview'),
  connect: call('connect'),
  disconnect: call('disconnect'),
  setReadOnly: call('setReadOnly'),
  setKeepAlive: call('setKeepAlive'),
  sendSaved: call('sendSaved'),
  sendDirect: call('sendDirect'),
  startPeriodic: call('startPeriodic'),
  stopPeriodic: call('stopPeriodic'),
  setLocale: call('setLocale'),

  // Device role (the virtual device tab).
  deviceState: call('deviceState'),
  deviceLoadFile: call('deviceLoadFile'),
  deviceLoadSample: call('deviceLoadSample'),
  deviceRefreshSamples: call('deviceRefreshSamples'),
  deviceStart: call('deviceStart'),
  deviceStop: call('deviceStop'),
  deviceSetFault: call('deviceSetFault'),
  deviceCloseAll: call('deviceCloseAll'),

  // Relay role (the relay tab).
  relayState: call('relayState'),
  relayStart: call('relayStart'),
  relayStop: call('relayStop'),
  relayClearRecording: call('relayClearRecording'),
  relaySaveRecording: call('relaySaveRecording'),
  relayLoadRecording: call('relayLoadRecording'),
  relayDraft: call('relayDraft'),
  relaySaveDraft: call('relaySaveDraft'),
  relayUseDraft: call('relayUseDraft'),

  // Subscribes to events pushed by the main process. Returns a function that unsubscribes.
  onEvent(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function');
    }
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('wb:event', listener);
    return () => ipcRenderer.removeListener('wb:event', listener);
  },
}));
