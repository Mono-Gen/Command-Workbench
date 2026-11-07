// Main process entry point: creates the window and wires the pieces together.
// The rules for talking to a device live in service.js; this file only connects Electron to it.
const {
  app, BrowserWindow, Menu, dialog, ipcMain, protocol, session,
} = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { createConnection } = require('./connection');
const { createUdpEndpoint } = require('./udp-endpoint');
const { createCommandStore, resolveDataDir, DEFAULT_FILE_NAME } = require('./storage');
const { createService } = require('./service');
const { createDeviceServer } = require('./device-server');
const { createDeviceUdpServer } = require('./device-udp-server');
const { createDeviceService } = require('./device-service');
const { createSampleStore } = require('./sample-store');
const { SCHEME: APP_SCHEME, PAGE_URL: APP_PAGE_URL, createAppProtocolHandler } = require('./app-protocol');
const { createRelay } = require('./relay');
const { createUdpRelay } = require('./relay-udp');
const { createRelayService } = require('./relay-service');
const { createRecorder } = require('../core/recording');
const { saveTextAtomic } = require('./save-text');
const { createIpcHandlers, registerIpc } = require('./ipc');
const { readRegularFileLimited } = require('./read-limited');
const { confirmDialogText } = require('./messages');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
// The page is served as app://bundle/index.html (not file://): see app-protocol.js.
const PAGE_URL = APP_PAGE_URL;
// The bundled samples (used when there is no samples folder next to the program).
const SAMPLES_DIR = path.join(__dirname, '..', 'samples');
const MAX_DEFINITION_BYTES = 1024 * 1024;

let mainWindow = null;
let service = null;
// The "samples" folder next to the program (null when the data folder is unusable).
let definitionsDir = null;
let deviceService = null;
let relayService = null;
let locale = 'ja';

// Used when the data folder cannot be determined: the app still starts, shows why, and refuses
// to save (it never writes to a guessed location).
function unavailableStore(code) {
  return {
    load: async () => ({ status: 'read_error', code, leftoverTemps: [] }),
    save: async () => ({ ok: false, code: 'blocked_by_unreadable_file' }),
  };
}

function createStoreForApp() {
  const resolved = resolveDataDir({
    env: process.env,
    isPackaged: app.isPackaged,
    exeDir: path.dirname(app.getPath('exe')),
    // Development data stays inside the local-only scratch folder, never in a tracked path.
    devDir: path.join(app.getAppPath(), '.scratch', 'dev-data'),
  });
  if (!resolved.ok) {
    return { store: unavailableStore(resolved.code), dataInfo: { ok: false, code: resolved.code } };
  }
  if (resolved.source === 'development') {
    fs.mkdirSync(resolved.dir, { recursive: true });
  }
  return {
    store: createCommandStore({ fs: fsp, dir: resolved.dir }),
    dataInfo: { ok: true, dir: resolved.dir, source: resolved.source, fileName: DEFAULT_FILE_NAME },
  };
}

function emitToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('wb:event', { channel, payload });
  }
}

// The confirmation is a native dialog owned by the main process, so the page cannot skip it.
async function confirmSend(info) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const text = confirmDialogText(locale, info);
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: text.title,
    message: text.message,
    detail: `${text.reasonLines.join('\n')}\n\n${text.detail}`,
    buttons: [text.confirmLabel, text.cancelLabel],
    // The safe answer is the default and what Esc does.
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

// Lets the user pick a definition file in a native dialog. The page only gets the file NAME back
// (through the service); the path stays in the main process.
async function chooseDefinitionFile() {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, code: 'cancelled' };
  // Start in the "samples" folder next to the program when there is one (the dialog is only a starting point).
  const options = { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] };
  if (definitionsDir !== null && fs.existsSync(definitionsDir)) options.defaultPath = definitionsDir;
  const picked = await dialog.showOpenDialog(mainWindow, options);
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, code: 'cancelled' };
  const file = picked.filePaths[0];
  // One open handle: checked (regular file, size) and read within the limit, so the file cannot be
  // swapped for something else between the check and the read.
  const read = await readRegularFileLimited(fsp, file, MAX_DEFINITION_BYTES);
  return read.ok ? { ok: true, fileName: path.basename(file), text: read.text } : read;
}

// Saving and loading for the relay role: the user picks the place in a native dialog, and the path
// never leaves the main process (the page only gets the file NAME back).
const FILE_TITLES = { recording: 'recording.json', draft: 'device-definition.json' };

async function saveTextWithDialog({ kind, makeText }) {
  if (!mainWindow || mainWindow.isDestroyed() || !Object.hasOwn(FILE_TITLES, kind)) return { ok: false, code: 'cancelled' };
  const picked = await dialog.showSaveDialog(mainWindow, {
    defaultPath: FILE_TITLES[kind],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, code: 'cancelled' };
  // The content is made only now, after the place was chosen.
  const text = makeText();
  if (typeof text !== 'string') return { ok: false, code: 'empty' };
  const saved = await saveTextAtomic(fsp, picked.filePath, text);
  return saved.ok ? { ok: true, fileName: path.basename(picked.filePath) } : saved;
}

async function loadTextWithDialog({ maxBytes }) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, code: 'cancelled' };
  const picked = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { ok: false, code: 'cancelled' };
  const file = picked.filePaths[0];
  const read = await readRegularFileLimited(fsp, file, maxBytes);
  return read.ok ? { ok: true, fileName: path.basename(file), text: read.text } : read;
}

function hardenWebContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
}

function buildApp() {
  const { store, dataInfo } = createStoreForApp();
  const connection = createConnection({ onEvent: (event) => service.handleConnectionEvent(event) });
  const udpEndpoint = createUdpEndpoint({ onEvent: (event) => service.handleConnectionEvent(event) });
  service = createService({ connection, udp: udpEndpoint, store, emit: emitToRenderer, dataInfo });
  const deviceServer = createDeviceServer({ onEvent: (event) => deviceService.handleServerEvent(event) });
  // `samples/` next to the program (where the commands are saved); the bundled ones otherwise.
  definitionsDir = dataInfo.ok ? path.join(dataInfo.dir, 'samples') : null;
  const sampleStore = createSampleStore({
    fs: fsp,
    folderDir: definitionsDir,
    builtinDir: SAMPLES_DIR,
  });
  const deviceUdpServer = createDeviceUdpServer({ onEvent: (event) => deviceService.handleServerEvent(event) });
  deviceService = createDeviceService({
    server: deviceServer,
    udpServer: deviceUdpServer,
    chooseFile: chooseDefinitionFile,
    sampleStore,
    confirm: confirmSend,
    saveText: saveTextWithDialog,
    emit: emitToRenderer,
  });
  const recorder = createRecorder({ now: () => performance.now() });
  const relay = createRelay({ recorder, onEvent: (event) => relayService.handleRelayEvent(event) });
  const udpRelay = createUdpRelay({ recorder, onEvent: (event) => relayService.handleRelayEvent(event) });
  relayService = createRelayService({
    relay,
    udpRelay,
    recorder,
    deviceService,
    saveText: saveTextWithDialog,
    loadText: loadTextWithDialog,
    confirm: confirmSend,
    emit: emitToRenderer,
  });
  const handlers = createIpcHandlers({ service, deviceService, relayService, setLocale: (value) => { locale = value; } });
  registerIpc({ ipcMain, handlers, pageUrl: PAGE_URL });
}

// The scheme must be declared before the app is ready. "standard" and "secure" make the page an
// ordinary web origin, so Content-Security-Policy 'self' means exactly this program's own files.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

// Why: two instances could write the same command-list JSON at once.
// The lock must be requested before 'ready'; on failure, quit immediately.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => hardenWebContents(contents));

  app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, createAppProtocolHandler({ rendererDir: RENDERER_DIR, readFile: fsp.readFile }));
    // The page needs no permissions (camera, notifications, ...).
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));

    buildApp();
    mainWindow = new BrowserWindow({
      width: 1100,
      height: 720,
      minWidth: 820,
      minHeight: 520,
      // The window icon (the program file carries its own, set when it is built).
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        // Why: the renderer must not get Node access; it only sees what preload exposes.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The page is the only thing a packaged build shows; inspecting it is for development.
        devTools: !app.isPackaged,
      },
    });
    if (app.isPackaged) Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadURL(PAGE_URL);
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  });

  // Nothing may keep running in the background (timers, sockets) once the app is closing.
  app.on('before-quit', () => {
    if (service) service.shutdown();
    // The sockets are closed when the process exits; stopping first makes the listening port free
    // at once and clears the timers.
    if (deviceService) deviceService.shutdown().catch(() => {});
    if (relayService) relayService.shutdown().catch(() => {});
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
