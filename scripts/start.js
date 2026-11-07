// Development launcher.
// Why: some hosts (e.g. a VS Code extension environment) set ELECTRON_RUN_AS_NODE=1.
// With it set, Electron runs as plain Node: no window opens and it exits with code 0.
// So we start Electron in a child process with that variable removed.
const { spawn } = require('node:child_process');
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
