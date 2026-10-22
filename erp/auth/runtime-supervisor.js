'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULTS = Object.freeze({
  startupGraceMs: 15000,
  probeIntervalMs: 2000,
  probeTimeoutMs: 1200,
  // 有界二次确认：延迟的 HTTP 200 不等于永久卡死。
  confirmTimeoutMs: 15000,
  failureThreshold: 3,
  restartWindowMs: 10 * 60 * 1000,
  maxRestartsPerWindow: 3,
  restartDelayMs: 500
});

function integer(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function configuration(environment = process.env) {
  const test = environment.NODE_ENV === 'test';
  const tune = (name, fallback, minimum, maximum) => test
    ? integer(environment[name], fallback, minimum, maximum)
    : fallback;
  return {
    host: '127.0.0.1',
    port: integer(environment.ERP_PORT, 8765, 1, 65535),
    startupGraceMs: tune('ERP_RUNTIME_SUPERVISOR_STARTUP_GRACE_MS', DEFAULTS.startupGraceMs, 50, 60000),
    probeIntervalMs: tune('ERP_RUNTIME_SUPERVISOR_PROBE_INTERVAL_MS', DEFAULTS.probeIntervalMs, 25, 60000),
    probeTimeoutMs: tune('ERP_RUNTIME_SUPERVISOR_PROBE_TIMEOUT_MS', DEFAULTS.probeTimeoutMs, 25, 30000),
    confirmTimeoutMs: tune('ERP_RUNTIME_SUPERVISOR_CONFIRM_TIMEOUT_MS', DEFAULTS.confirmTimeoutMs, 100, 30000),
    failureThreshold: tune('ERP_RUNTIME_SUPERVISOR_FAILURE_THRESHOLD', DEFAULTS.failureThreshold, 1, 20),
    restartWindowMs: tune('ERP_RUNTIME_SUPERVISOR_RESTART_WINDOW_MS', DEFAULTS.restartWindowMs, 1000, 60 * 60 * 1000),
    maxRestartsPerWindow: tune('ERP_RUNTIME_SUPERVISOR_MAX_RESTARTS', DEFAULTS.maxRestartsPerWindow, 1, 20),
    restartDelayMs: tune('ERP_RUNTIME_SUPERVISOR_RESTART_DELAY_MS', DEFAULTS.restartDelayMs, 0, 30000)
  };
}

function probeLive(config) {
  return new Promise(resolve => {
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      resolve(Boolean(ok));
    };
    const request = http.get({
      hostname: config.host,
      port: config.port,
      path: '/health/live',
      timeout: config.probeTimeoutMs,
      headers: { Connection: 'close' }
    }, response => {
      response.resume();
      response.once('end', () => finish(response.statusCode === 200));
      response.once('error', () => finish(false));
    });
    request.once('timeout', () => { request.destroy(); finish(false); });
    request.once('error', () => finish(false));
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function runtimeStateFile(environment = process.env) {
  const value = String(environment.ERP_RUNTIME_STATE_FILE || '').trim();
  return value ? path.resolve(value) : null;
}

function writeRuntimeState(stateFile, child, serverScript) {
  if (!stateFile || !child || !Number.isInteger(child.pid)) return;
  const payload = {
    version: 1,
    supervisorPid: process.pid,
    parentPid: process.ppid,
    serverPid: child.pid,
    supervisorScript: path.resolve(__filename),
    serverScript: path.resolve(serverScript),
    updatedAt: new Date().toISOString()
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
  fs.renameSync(temporary, stateFile);
}

async function terminateTree(child) {
  if (!child || child.exitCode !== null || !Number.isInteger(child.pid)) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = childProcess.spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
  } else {
    try { child.kill('SIGKILL'); } catch (_) {}
  }
  await Promise.race([
    new Promise(resolve => child.once('exit', () => resolve())),
    sleep(3000)
  ]);
}

function resolveServerScript(argv = process.argv, environment = process.env) {
  const requested = String(argv[2] || '').trim();
  const fallback = path.resolve(__dirname, '..', 'server.js');
  const clustered = path.resolve(__dirname, '..', 'cluster.js');
  if (!requested) return fallback;
  const resolved = path.resolve(requested);
  if (environment.NODE_ENV !== 'test' && resolved !== fallback && resolved !== clustered) {
    throw new Error('runtime supervisor refuses a non-standard server entry outside test mode');
  }
  return resolved;
}

async function runSupervisor(options = {}) {
  const environment = options.environment || process.env;
  const config = options.config || configuration(environment);
  const serverScript = options.serverScript || resolveServerScript(process.argv, environment);
  const stateFile = options.stateFile === undefined ? runtimeStateFile(environment) : options.stateFile;
  const spawn = options.spawn || childProcess.spawn;
  const probe = options.probe || probeLive;
  const now = options.now || Date.now;
  let child = null;
  let stopping = false;
  let restarting = false;
  let consecutiveFailures = 0;
  let generationStartedAt = 0;
  let lastTransientWarningAt = 0;
  const restarts = [];

  const startChild = () => {
    child = spawn(process.execPath, [serverScript], {
      cwd: path.dirname(serverScript),
      env: environment,
      stdio: 'inherit',
      windowsHide: false
    });
    generationStartedAt = now();
    consecutiveFailures = 0;
    writeRuntimeState(stateFile, child, serverScript);
    child.once('exit', (code, signal) => {
      if (stopping || restarting) return;
      stopping = true;
      const exitCode = Number.isInteger(code) ? code : (signal ? 1 : 0);
      process.exitCode = exitCode;
    });
    child.once('error', error => {
      if (stopping || restarting) return;
      stopping = true;
      console.error('[runtime-supervisor] 无法启动 ERP 子进程:', error.message);
      process.exitCode = 1;
    });
  };

  const restartFrozenChild = async () => {
    const timestamp = now();
    while (restarts.length && timestamp - restarts[0] > config.restartWindowMs) restarts.shift();
    if (restarts.length >= config.maxRestartsPerWindow) {
      stopping = true;
      await terminateTree(child);
      console.error('[runtime-supervisor] ERP 连续假死次数超过安全上限，已停止自动重启，请检查运行日志。');
      process.exitCode = 70;
      return;
    }
    restarts.push(timestamp);
    restarting = true;
    await terminateTree(child);
    if (stopping) return;
    if (config.restartDelayMs) await sleep(config.restartDelayMs);
    startChild();
    restarting = false;
    console.error('[runtime-supervisor] 检测到 ERP /health/live 连续无响应，已自动重启服务。');
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await terminateTree(child);
  };
  process.once('SIGINT', () => { stop().finally(() => process.exit(130)); });
  process.once('SIGTERM', () => { stop().finally(() => process.exit(143)); });

  startChild();
  while (!stopping) {
    await sleep(config.probeIntervalMs);
    if (stopping || !child || child.exitCode !== null) break;
    if (now() - generationStartedAt < config.startupGraceMs) continue;
    const healthy = await probe(config);
    if (healthy) {
      consecutiveFailures = 0;
      writeRuntimeState(stateFile, child, serverScript);
      continue;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures < config.failureThreshold) continue;
    // 连续快速探针失败还可能是暂时性事件循环延迟。销毁包含订单任务的进程树之前，
    // 再执行一次有界、独立的健康确认；永久假死仍按原重启上限处理。
    const recovered = await probe({ ...config, probeTimeoutMs: config.confirmTimeoutMs });
    if (stopping || !child || child.exitCode !== null) break;
    if (recovered) {
      consecutiveFailures = 0;
      writeRuntimeState(stateFile, child, serverScript);
      if (now() - lastTransientWarningAt > 60000) {
        console.warn('[runtime-supervisor] ERP 快速健康探针连续超时，但延长确认探针恢复；保留后台任务，未重启服务。');
        lastTransientWarningAt = now();
      }
      continue;
    }
    await restartFrozenChild();
  }
  if (child && child.exitCode === null && stopping && process.exitCode != null) await terminateTree(child);
  return process.exitCode || 0;
}

if (require.main === module) {
  runSupervisor().catch(error => {
    console.error('[runtime-supervisor] 运行失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULTS, configuration, probeLive, terminateTree, resolveServerScript, runSupervisor };
