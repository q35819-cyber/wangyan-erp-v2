'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv = process.argv.slice(2)) {
  const out = { command: argv[0] || '' };
  for (const item of argv.slice(1)) {
    if (!item.startsWith('--')) continue;
    const index = item.indexOf('=');
    out[item.slice(2, index > 0 ? index : undefined)] = index > 0 ? item.slice(index + 1) : true;
  }
  return out;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function listenerPids(port, execFileSync = childProcess.execFileSync) {
  const output = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    encoding: 'utf8', windowsHide: true, timeout: 5000
  });
  const result = new Set();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || String(parts[0]).toUpperCase() !== 'TCP') continue;
    if (String(parts[3]).toUpperCase() !== 'LISTENING') continue;
    const local = String(parts[1] || '');
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0) result.add(pid);
  }
  return [...result];
}

function readState(stateFile) {
  const raw = fs.readFileSync(stateFile, 'utf8');
  const state = JSON.parse(raw);
  return state && typeof state === 'object' ? state : null;
}

function authoritativeStateFile(environment = process.env) {
  const localAppData = String(environment.LOCALAPPDATA || '').trim() ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.resolve(localAppData, 'WyerpERP', 'runtime-supervisor.json');
}

function samePath(left, right) {
  return typeof left === 'string' && typeof right === 'string' &&
    path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

// Windows command lines must be split into arguments, not substring matched:
// an attacker can otherwise include an expected ERP script as inert text.
function windowsArgv(commandLine) {
  if (typeof commandLine !== 'string' || !commandLine.trim()) return null;
  const result = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/.test(commandLine[index])) index++;
    if (index >= commandLine.length) break;
    let value = '', quoted = false;
    while (index < commandLine.length) {
      const character = commandLine[index];
      if (character === '\\') {
        let slashes = 0;
        while (commandLine[index] === '\\') { slashes++; index++; }
        if (commandLine[index] === '"') {
          value += '\\'.repeat(Math.floor(slashes / 2));
          if (slashes % 2) { value += '"'; index++; }
          else { quoted = !quoted; index++; }
        } else value += '\\'.repeat(slashes);
        continue;
      }
      if (character === '"') { quoted = !quoted; index++; continue; }
      if (!quoted && /\s/.test(character)) break;
      value += character;
      index++;
    }
    if (quoted || !value) return null;
    result.push(value);
    while (index < commandLine.length && /\s/.test(commandLine[index])) index++;
  }
  return result.length ? result : null;
}

function readWindowsProcessInfo(pids, execFileSync = childProcess.execFileSync) {
  if (!Array.isArray(pids) || !pids.length || !pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) {
    throw new Error('invalid process ids');
  }
  const identifiers = [...new Set(pids)];
  const filters = identifiers.map(pid => 'ProcessId=' + pid);
  // The only interpolated values are validated positive integer PIDs.
  const command = '$ErrorActionPreference="Stop";' +
    '$items=@(Get-CimInstance Win32_Process -Filter "' + filters.join(' OR ') + '" -ErrorAction Stop ' +
    '| Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,Name);' +
    // Windows PowerShell redirects Unicode console output in a legacy
    // codepage. Base64 of UTF-8 bytes protects Chinese directory names.
    '$json=ConvertTo-Json -InputObject $items -Compress -Depth 3;' +
    '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))';
  const output = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', command
  ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  const encoded = String(output || '').trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('invalid process identity encoding');
  }
  const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return rows;
}

function isNodeEntry(info, pid, script, { supervisor = false, childEntry } = {}) {
  if (!info || Number(info.ProcessId) !== pid ||
      String(info.Name || '').toLowerCase() !== 'node.exe' ||
      typeof info.ExecutablePath !== 'string' ||
      path.basename(info.ExecutablePath).toLowerCase() !== 'node.exe') return false;
  const args = windowsArgv(info.CommandLine);
  if (!args || !samePath(args[0], info.ExecutablePath)) return false;
  const supplied = args.slice(1);
  if (!supervisor) return supplied.length === 1 && samePath(supplied[0], script);
  if (supplied.length === 3 && /^--env-file-if-exists=.+/i.test(supplied[0])) supplied.shift();
  return supplied.length === 2 && samePath(supplied[0], script) && samePath(supplied[1], childEntry);
}

function validateSupervisedInstance({
  stateFile, port = 8765, now = Date.now, execFileSync = childProcess.execFileSync,
  trustedStateFile = authoritativeStateFile(), getProcessInfo = readWindowsProcessInfo,
  isProcessAlive = processExists
} = {}) {
  if (!stateFile || !samePath(stateFile, trustedStateFile)) {
    return { kind: 'unsafe', reason: 'runtime state path is not trusted' };
  }
  if (!stateFile || !fs.existsSync(stateFile)) return { kind: 'legacy_or_unknown' };
  try {
    if (fs.lstatSync(stateFile).isSymbolicLink() ||
        !samePath(fs.realpathSync(stateFile), fs.realpathSync(trustedStateFile))) {
      return { kind: 'unsafe', reason: 'runtime state link is not trusted' };
    }
  } catch (_) { return { kind: 'unsafe', reason: 'runtime state file cannot be verified' }; }
  let state;
  try { state = readState(stateFile); } catch (error) {
    return { kind: 'unsafe', reason: `runtime state unreadable: ${error.message}` };
  }
  let listeners;
  try { listeners = listenerPids(port, execFileSync); } catch (error) {
    return { kind: 'unsafe', reason: `listener inspection failed: ${error.message}` };
  }
  if (!listeners.length) return { kind: 'no_listener' };
  const expectedSupervisor = path.resolve(__dirname, 'runtime-supervisor.js');
  // Both entries are owned by this ERP runtime supervisor. In cluster mode
  // the port listener is cluster.js; its server.js children do not own 8765.
  const expectedServer = path.resolve(__dirname, '..', 'server.js');
  const expectedCluster = path.resolve(__dirname, '..', 'cluster.js');
  const supervisorPid = Number(state?.supervisorPid);
  const parentPid = Number(state?.parentPid);
  const serverPid = Number(state?.serverPid);
  if (state?.version !== 1 ||
      path.resolve(String(state?.supervisorScript || '')) !== expectedSupervisor ||
      ![expectedServer, expectedCluster].includes(path.resolve(String(state?.serverScript || '')))) {
    return { kind: 'unsafe', reason: 'runtime state paths do not match this project' };
  }
  if (![supervisorPid, parentPid, serverPid].every(pid => Number.isSafeInteger(pid) && pid > 0) ||
      new Set([supervisorPid, parentPid, serverPid]).size !== 3) {
    return { kind: 'unsafe', reason: 'runtime state pid is invalid' };
  }
  const updatedAt = Date.parse(String(state.updatedAt || ''));
  if (!Number.isFinite(updatedAt) || Math.abs(now() - updatedAt) > 15000) return { kind: 'unsafe', reason: 'runtime state heartbeat is stale' };
  if (listeners.length !== 1 || listeners[0] !== serverPid) return { kind: 'unsafe', reason: 'listener pid does not match runtime state' };
  if (!isProcessAlive(supervisorPid) || !isProcessAlive(serverPid) || !isProcessAlive(parentPid)) {
    return { kind: 'unsafe', reason: 'runtime state process is no longer alive' };
  }
  let processes;
  try { processes = getProcessInfo([supervisorPid, serverPid], execFileSync); } catch (error) {
    return { kind: 'unsafe', reason: 'runtime process identity inspection failed' };
  }
  if (!Array.isArray(processes) || processes.length !== 2) {
    return { kind: 'unsafe', reason: 'runtime process identity could not be verified' };
  }
  const supervisor = processes.find(info => Number(info.ProcessId) === supervisorPid);
  const server = processes.find(info => Number(info.ProcessId) === serverPid);
  if (!isNodeEntry(supervisor, supervisorPid, expectedSupervisor, { supervisor: true, childEntry: state.serverScript }) ||
      !isNodeEntry(server, serverPid, state.serverScript) ||
      Number(server?.ParentProcessId) !== supervisorPid ||
      Number(supervisor?.ParentProcessId) !== parentPid) {
    return { kind: 'unsafe', reason: 'runtime process command line or parent chain does not match ERP' };
  }
  return { kind: 'supervised', mode: path.resolve(state.serverScript) === expectedCluster ? 'cluster' : 'direct', stopPid: supervisorPid, serverPid, parentPid };
}

function stopSupervisedInstance(options = {}) {
  const result = validateSupervisedInstance(options);
  if (result.kind === 'no_listener') return { ...result, stopped: true };
  if (result.kind !== 'supervised') return result;
  // Re-read both the state and live Windows processes immediately before a
  // destructive operation, rejecting a changed PID or process identity.
  const confirmed = validateSupervisedInstance(options);
  if (confirmed.kind !== 'supervised' || confirmed.stopPid !== result.stopPid ||
      confirmed.serverPid !== result.serverPid || confirmed.parentPid !== result.parentPid) {
    return { kind: 'unsafe', reason: 'runtime process identity changed before stop' };
  }
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  execFileSync('taskkill.exe', ['/F', '/PID', String(result.stopPid), '/T'], {
    encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: 'pipe'
  });
  return { ...result, stopped: true };
}

function main() {
  const args = parseArgs();
  const stateFile = path.resolve(String(args.state || process.env.ERP_RUNTIME_STATE_FILE || ''));
  const port = Number(args.port || process.env.ERP_PORT || 8765);
  if (args.command !== 'stop') throw new Error('usage: runtime-instance-control.js stop --state=<file> [--port=8765]');
  const result = stopSupervisedInstance({ stateFile, port });
  if (result.kind === 'legacy_or_unknown') process.exitCode = 3;
  else if (result.kind === 'unsafe') { console.error(`[runtime-instance-control] ${result.reason}`); process.exitCode = 21; }
  else console.log(`[runtime-instance-control] ${result.kind === 'supervised' ? 'stopped verified supervisor' : 'no listener'}${result.stopPid ? ` pid=${result.stopPid}` : ''}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('[runtime-instance-control] failed:', error.message); process.exitCode = 22; }
}

module.exports = { parseArgs, processExists, listenerPids, readState, authoritativeStateFile, windowsArgv, readWindowsProcessInfo, validateSupervisedInstance, stopSupervisedInstance };
