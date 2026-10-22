#!/usr/bin/env node
'use strict';

// 显式启动入口：node cluster.js。旧 node server.js / start.ps1 行为不变。
// Cluster owns one public loopback listener and one dedicated background worker.
// It never reads, migrates, deletes or updates the production database on startup itself.

const childProcess = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const { createLoadBalancer, positiveInteger, probeEndpoint } = require('./auth/load-balancer');
const { createApiAutoscaler } = require('./auth/api-autoscaler');

function clusterConfig(environment = process.env) {
  const enabled = environment.ERP_CLUSTER_AUTOSCALE_ENABLED === '1';
  const fixedNodes = positiveInteger(environment.ERP_CLUSTER_API_NODES, 2, 2, 4, 'API 节点数量');
  const apiNodes = enabled ? positiveInteger(environment.ERP_CLUSTER_AUTOSCALE_MIN, 2, 2, 4, '最少 API 节点') : fixedNodes;
  const maxApiNodes = enabled ? positiveInteger(environment.ERP_CLUSTER_AUTOSCALE_MAX, 3, apiNodes, 4, '最多 API 节点') : apiNodes;
  const frontPort = positiveInteger(environment.ERP_CLUSTER_PORT || environment.ERP_PORT, 8765, 1, 65535, '入口端口');
  const basePort = positiveInteger(environment.ERP_CLUSTER_BASE_PORT, 18765, 1024, 65535, '内部起始端口');
  // Worker 使用最大 API 配额之后的固定端口，扩容不得移动后台节点。
  const workerPort = basePort + maxApiNodes;
  if (workerPort > 65535 || (frontPort >= basePort && frontPort <= workerPort)) {
    throw new Error('入口端口与内部 API/Worker 端口重叠，或内部端口超过65535。');
  }
  const budget = positiveInteger(environment.ERP_CLUSTER_PG_BUDGET, 18, 10, 100, 'PostgreSQL 总连接预算');
  const reserved = positiveInteger(environment.ERP_CLUSTER_PG_RESERVED, 4, 1, 30, 'PostgreSQL 预留连接数');
  const workerPool = positiveInteger(environment.ERP_CLUSTER_WORKER_POOL, 4, 2, 30, 'Worker 连接池');
  const available = budget - reserved - workerPool;
  // 连接池按最大节点数预留，扩容时不得把同一连接预算再分配一次。
  const apiPool = Math.floor(available / maxApiNodes);
  if (apiPool < 2) throw new Error('PostgreSQL 预算不足：每个 API 节点至少需要2个连接，并须留出 Worker 和管理预留量。');
  const allocated = maxApiNodes * apiPool + workerPool;
  if (allocated + reserved > budget) throw new Error('PostgreSQL 连接预算检查失败。');
  return {
    apiNodes, maxApiNodes, autoscaleEnabled: enabled,
    frontPort, basePort, workerPort, budget, reserved, workerPool, apiPool, allocated,
    host: '127.0.0.1', internalPorts: Array.from({ length: maxApiNodes }, (_, i) => basePort + i),
    autoscaleIntervalMs: positiveInteger(environment.ERP_CLUSTER_AUTOSCALE_INTERVAL_MS, 5000, 1000, 60000, '伸缩检测间隔'),
    autoscaleMinFreeMb: positiveInteger(environment.ERP_CLUSTER_AUTOSCALE_MIN_FREE_MB, 1024, 256, 8192, '扩容内存余量'),
    autoscaleMaxCpu: positiveInteger(environment.ERP_CLUSTER_AUTOSCALE_MAX_CPU, 80, 20, 95, '扩容CPU上限'),
    autoscaleUpActive: positiveInteger(environment.ERP_CLUSTER_AUTOSCALE_UP_ACTIVE, 25, 1, 10000, '节点忙碌阈值'),
    maxInflight: positiveInteger(environment.ERP_CLUSTER_MAX_INFLIGHT, 160, 1, 10000, '全局请求上限'),
    maxPerNode: positiveInteger(environment.ERP_CLUSTER_MAX_PER_NODE, 80, 1, 10000, '节点请求上限'),
    trustProxy: environment.ERP_CLUSTER_TRUST_PROXY === '1'
  };
}

async function startCluster(options = {}) {
  const environment = options.environment || process.env;
  const config = options.config || clusterConfig(environment);
  const createChild = options.spawn || childProcess.spawn;
  const serverPath = path.resolve(__dirname, 'server.js');
  let stopping = false;
  let workerReady = false;
  const children = new Map();
  const restartTimes = new Map();
  const timers = new Set();
  let workerProbeTimer = null;
  let autoscaleTimer = null;
  let autoscaler = null;
  let desiredApiNodes = config.apiNodes;
  let previousCpuTotals = null;
  const balancer = createLoadBalancer({
    upstreams: config.internalPorts.map(port => ({ port })),
    maxInflight: config.maxInflight, maxPerNode: config.maxPerNode,
    trustProxy: config.trustProxy,
    acceptRequests: () => workerReady
  });
  // 未启动的扩容槽位不可路由，即使端口意外被其它本机进程占用也不得接流量。
  balancer.nodes.forEach((node, index) => {
    if (index >= config.apiNodes) balancer.setDraining(index, true);
  });

  function schedule(action, timeoutMs) {
    const timer = setTimeout(() => { timers.delete(timer); if (!stopping) action(); }, timeoutMs);
    timers.add(timer);
    return timer;
  }

  function spawnNode(role, index, port, poolSize) {
    if (stopping) return;
    const name = role + '-' + index;
    const env = { ...environment, ERP_NODE_ROLE: role, ERP_HOST: '127.0.0.1',
      ERP_PORT: String(port), PGPOOL_MAX: String(poolSize), ERP_TRUST_PROXY: '1',
      ERP_CLUSTER_ENTRY_PORT: String(config.frontPort) };
    delete env.ERP_RUNTIME_STATE_FILE;
    const child = createChild(process.execPath, [serverPath], {
      cwd: __dirname, env, stdio: 'inherit', windowsHide: true
    });
    children.set(name, child);
    child.once('error', error => {
      console.error('[cluster] ' + name + ' 启动失败: ' + error.message);
    });
    child.once('exit', (code, signal) => {
      if (children.get(name) !== child) return;
      children.delete(name);
      if (role === 'worker') workerReady = false;
      else {
        balancer.nodes[index].ready = false;
        balancer.nodes[index].alive = false;
      }
      if (stopping || (role === 'api' && index >= desiredApiNodes)) return;
      const now = Date.now();
      const history = (restartTimes.get(name) || []).filter(value => now - value < 10 * 60 * 1000);
      if (history.length >= 3) {
        console.error('[cluster] ' + name + ' 10分钟内连续重启达到上限，停止自动恢复。退出=' + (signal || code));
        return;
      }
      history.push(now);
      restartTimes.set(name, history);
      console.warn('[cluster] ' + name + ' 进程退出，安全重新启动。退出=' + (signal || code));
      schedule(() => spawnNode(role, index, port, poolSize), 1000 * history.length);
    });
  }

  async function probeWorker() {
    if (stopping || !children.has('worker-0')) {
      workerReady = false;
      return;
    }
    workerReady = await probeEndpoint('127.0.0.1', config.workerPort, '/health/ready', 1200);
  }

  function hostCpuPercent() {
    // Windows 的 os.loadavg() 恒为零；采样 os.cpus() 的时间差。
    const cpus = os.cpus();
    const total = cpus.reduce((sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0), 0);
    const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);
    const previous = previousCpuTotals;
    previousCpuTotals = { total, idle };
    if (!previous || total <= previous.total) return null;
    return Math.max(0, Math.min(100, 100 * (1 - (idle - previous.idle) / (total - previous.total))));
  }

  async function removeApiNode(index) {
    balancer.setDraining(index, true);
    const node = balancer.nodes[index];
    // 验证码与登录限流含进程内状态，近期接过认证请求的节点禁止被主动缩容。
    if (node.lastAuthAt && Date.now() - node.lastAuthAt < 30 * 60 * 1000) {
      balancer.setDraining(index, false);
      return false;
    }
    const deadline = Date.now() + 15000;
    while (node.active > 0 && Date.now() < deadline && !stopping) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (node.active > 0 || stopping) {
      balancer.setDraining(index, false);
      console.warn('[autoscale] 缩容推迟：节点仍有未完成请求，保持接入。');
      return false;
    }
    desiredApiNodes = index;
    node.ready = false;
    node.alive = false;
    const child = children.get('api-' + index);
    if (child && child.exitCode === null) {
      try {
        if (!child.kill('SIGTERM')) throw new Error('操作系统未接受进程结束信号');
      } catch (error) {
        // 停止失败必须恢复原路由和期望数，不能把仍在运行的节点算作已缩容。
        desiredApiNodes = index + 1;
        balancer.setDraining(index, false);
        console.error('[autoscale] API 节点停止失败，已取消缩容:', error.message);
        return false;
      }
    }
    console.log('[autoscale] 安全缩容到 ' + desiredApiNodes + ' 个 API 节点。');
    return true;
  }

  function startAutoscale() {
    if (!config.autoscaleEnabled) return;
    autoscaler = createApiAutoscaler({
      min: config.apiNodes, max: config.maxApiNodes,
      // 以下参数仅允许程序化合成测试注入；真实启动入口不设置它们。
      now: options.autoscaleClock,
      upHoldMs: options.autoscaleHoldMs?.up,
      downHoldMs: options.autoscaleHoldMs?.down,
      cooldownMs: options.autoscaleHoldMs?.cooldown,
      upActivePerNode: config.autoscaleUpActive, downActiveTotal: 2,
      slowP95Ms: 1200, slowMinRequests: 25,
      minFreeMemoryBytes: config.autoscaleMinFreeMb * 1024 * 1024,
      maxCpuPercent: config.autoscaleMaxCpu,
      metrics: options.autoscaleMetrics || (() => {
        const traffic = balancer.trafficSnapshot();
        const readyApi = balancer.nodes.slice(0, desiredApiNodes).filter(node => node.ready && !node.draining).length;
        const cpuPercent = hostCpuPercent();
        return { ...traffic, readyApi, allDesiredReady: readyApi === desiredApiNodes,
          // 只统计当前已启动API的排空状态；预留但未启动的槽位必须持续draining以禁止路由，
          // 不能因该槽位被保留而把整个集群误判为正在缩容。
          workerReady, draining: balancer.nodes.slice(0, desiredApiNodes).some(node => node.draining),
          dbBudgetSafe: config.allocated + config.reserved <= config.budget,
          freeMemoryBytes: os.freemem(), cpuKnown: cpuPercent !== null, cpuPercent };
      }),
      add: async index => {
        spawnNode('api', index, config.internalPorts[index], config.apiPool);
        balancer.setDraining(index, false);
        desiredApiNodes = index + 1;
        console.log('[autoscale] 扩容到 ' + desiredApiNodes + ' 个 API 节点，等待就绪探测。');
      },
      remove: removeApiNode
    });
    autoscaleTimer = setInterval(() => {
      autoscaler.tick().catch(error => console.error('[autoscale] 自动伸缩失败:', error.message));
    }, config.autoscaleIntervalMs);
    autoscaleTimer.unref();
  }

  const listen = () => new Promise((resolve, reject) => {
    balancer.server.once('error', reject);
    balancer.server.listen(config.frontPort, config.host, () => {
      balancer.server.removeListener('error', reject);
      resolve();
    });
  });
  await listen();
  try {
    for (let i = 0; i < config.apiNodes; i += 1) {
      spawnNode('api', i, config.internalPorts[i], config.apiPool);
    }
    spawnNode('worker', 0, config.workerPort, config.workerPool);
    balancer.startHealthChecks();
    await probeWorker();
    workerProbeTimer = setInterval(() => probeWorker().catch(() => { workerReady = false; }), 2000);
    workerProbeTimer.unref();
    startAutoscale();
    console.log('[cluster] ERP 集群入口 http://' + config.host + ':' + config.frontPort
      + '，API 节点 ' + config.apiNodes + '，独立后台节点 1；PG连接预算 '
      + config.allocated + ' + 预留 ' + config.reserved + ' <= ' + config.budget);
  } catch (error) {
    await stop();
    throw error;
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    workerReady = false;
    clearInterval(workerProbeTimer);
    clearInterval(autoscaleTimer);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const child of children.values()) {
      if (child.exitCode === null) {
        try { child.kill('SIGTERM'); } catch (_) {}
      }
    }
    const killer = setTimeout(() => {
      for (const child of children.values()) {
        if (child.exitCode === null) {
          try { child.kill('SIGKILL'); } catch (_) {}
        }
      }
      balancer.server.closeAllConnections();
    }, 10000);
    killer.unref();
    try { await balancer.close(); } finally { clearTimeout(killer); }
  }

  if (options.handleSignals !== false) {
    process.once('SIGINT', () => stop().then(() => { process.exitCode = 130; }));
    process.once('SIGTERM', () => stop().then(() => { process.exitCode = 143; }));
  }
  return { config, balancer, children, stop, probeWorker, workerReady: () => workerReady,
    autoscaler: () => autoscaler, desiredApiNodes: () => desiredApiNodes };
}

if (require.main === module) {
  startCluster().catch(error => {
    console.error('[cluster] ERP 集群启动失败:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { clusterConfig, startCluster };
