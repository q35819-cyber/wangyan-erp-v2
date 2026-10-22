'use strict';

const childProcess = require('child_process');
const path = require('path');

function createManualOrderBackup(options = {}) {
  const baseDir = path.resolve(options.baseDir || path.join(__dirname, '..'));
  const script = path.resolve(options.script || path.join(baseDir, 'db', 'backup-if-needed.ps1'));
  const executable = options.executable || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
  const execFile = options.execFile || childProcess.execFile;
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  let running = null;
  let pending = false;

  function execute() {
    return new Promise((resolve, reject) => {
      execFile(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        cwd: baseDir,
        timeout: 15 * 60 * 1000,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    });
  }

  function launch() {
    pending = false;
    running = execute()
      .catch(error => { onError(error); return null; })
      .finally(() => {
        running = null;
        if (pending) launch();
      });
  }

  function request() {
    pending = true;
    const started = !running;
    if (started) launch();
    return { started, promise: running };
  }

  return { request, isRunning: () => Boolean(running) };
}

module.exports = { createManualOrderBackup };
