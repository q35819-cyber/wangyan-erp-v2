'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');

// These authentication operations persist directly through an API node and do not
// enqueue background jobs. A transient Worker readiness loss must not block login.
// Keep this list explicit: new or unknown mutations still require a ready Worker.
const WORKER_INDEPENDENT_AUTH_POSTS = new Set([
  '/api/auth/login',
  '/api/auth/login/verify',
  '/api/auth/recovery/login'
]);

function positiveInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(name + ' 必须是 ' + min + ' 到 ' + max + ' 的整数。');
  }
  return parsed;
}

function probeEndpoint(host, port, pathname, timeoutMs = 1000) {
  return new Promise(resolve => {
    let finished = false;
    const done = result => { if (!finished) { finished = true; resolve(result); } };
    const request = http.get({ host, port, path: pathname, agent: false,
      headers: { Connection: 'close' }, timeout: timeoutMs }, response => {
      const ok = response.statusCode === 200;
      response.resume();
      response.once('end', () => done(ok));
      response.once('error', () => done(false));
    });
    request.once('timeout', () => { request.destroy(); done(false); });
    request.once('error', () => done(false));
  });
}

function sessionFingerprint(header) {
  const cookies = String(header || '').split(';');
  const target = cookies.map(value => value.trim())
    .find(value => /^(?:__Host-wyerp_session|wyerp_session)=/.test(value));
  if (!target || target.length > 4096) return '';
  return crypto.createHash('sha256').update(target).digest('hex');
}

function cleanHeaders(req, trustProxy) {
  const headers = { ...req.headers };
  const byConnection = String(headers.connection || '').split(',').map(value => value.trim().toLowerCase());
  for (const name of ['connection', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate',
    'upgrade', 'keep-alive', 'te', 'trailer', ...byConnection]) {
    if (name) delete headers[name];
  }
  const peer = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let clientIP = peer;
  if (trustProxy && (peer === '127.0.0.1' || peer === '::1')) {
    const forwarded = String(req.headers['x-forwarded-for'] || '');
    if (net.isIP(forwarded.trim())) clientIP = forwarded.trim();
  }
  headers['x-forwarded-for'] = clientIP;
  const forwardedProto = (trustProxy && (peer === '127.0.0.1' || peer === '::1'))
    ? String(req.headers['x-forwarded-proto'] || '').toLowerCase() : '';
  headers['x-forwarded-proto'] = forwardedProto === 'https' ? 'https' : 'http';
  delete headers['x-forwarded-host'];
  return headers;
}

function createLoadBalancer(options = {}) {
  const inputs = options.upstreams || [];
  if (!Array.isArray(inputs) || inputs.length < 2 || inputs.length > 8) {
    throw new Error('集群负载均衡需要 2 到 8 个 API 节点。');
  }
  const nodes = inputs.map((input, index) => {
    const host = input.host || '127.0.0.1';
    if (host !== '127.0.0.1' && host !== '::1') throw new Error('API 子节点只允许使用回环地址。');
    const port = positiveInteger(input.port, undefined, 1, 65535, 'API 节点端口');
    return { host, port, index, alive: false, ready: false, active: 0, failures: 0, draining: false, lastAuthAt: 0 };
  });
  if (new Set(nodes.map(node => node.port)).size !== nodes.length) {
    throw new Error('API 节点端口不能重复。');
  }
  const maxInflight = positiveInteger(options.maxInflight, 160, 1, 10000, '集群并发上限');
  const maxPerNode = positiveInteger(options.maxPerNode, 80, 1, 10000, '节点并发上限');
  const probeIntervalMs = positiveInteger(options.probeIntervalMs, 2000, 50, 60000, '健康检查间隔');
  const probeTimeoutMs = positiveInteger(options.probeTimeoutMs, 1200, 25, 30000, '健康检查超时');
  const upstreamTimeoutMs = positiveInteger(options.upstreamTimeoutMs, 180000, 100, 600000, '业务请求超时');
  const affinity = new Map();
  const affinityTtlMs = 30 * 60 * 1000;
  let next = 0;
  let inflight = 0;
  let timer = null;
  let checking = false;
  let stopped = false;
  const samples = [];
  const agent = new http.Agent({ keepAlive: true, maxSockets: maxPerNode, maxFreeSockets: 8, timeout: 20000 });

  function chooseNode(req) {
    var eligible = nodes.filter(node => !node.draining && node.active < maxPerNode &&
      (node.ready || (mayReadWithoutWorker(req.method) && node.alive)));
    // 有数据库就绪节点优先使用；全部暂时PG未就绪时，读请求仍能路由到存活API返回页面。
    const readyNodes = eligible.filter(node => node.ready);
    const candidates = readyNodes.length ? readyNodes : eligible;
    if (!candidates.length) return null;
    // 登录、验证码与验证码校验在创建会话前也需要使用同一实例，
    // 避免原有进程内验证码/防爆破状态被请求轮询分散到不同节点。
    const pathname = String(req.url || '').split('?')[0];
    // 认证端点始终按可信源 IP 固定节点：伪造/随机 Cookie 不得绕开
    // 原有的进程内登录失败计数及图形验证码状态。
    const fingerprint = pathname.startsWith('/api/auth/')
      ? crypto.createHash('sha256').update('auth-ip:' + cleanHeaders(req, options.trustProxy === true)['x-forwarded-for']).digest('hex')
      : sessionFingerprint(req.headers.cookie);
    if (fingerprint) {
      const sticky = affinity.get(fingerprint);
      if (sticky && sticky.expires > Date.now()) {
        const existing = candidates.find(node => node.index === sticky.index);
        if (existing) return existing;
      }
    }
    const least = Math.min(...candidates.map(node => node.active));
    const tied = candidates.filter(node => node.active === least);
    const picked = tied[next++ % tied.length];
    if (fingerprint) {
      if (affinity.size >= 10000) {
        for (const [key, value] of affinity) {
          if (value.expires <= Date.now()) affinity.delete(key);
        }
        if (affinity.size >= 10000) affinity.delete(affinity.keys().next().value);
      }
      affinity.set(fingerprint, { index: picked.index, expires: Date.now() + affinityTtlMs });
    }
    return picked;
  }

  function reject(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'Retry-After': '1', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ error: 'cluster_unavailable', message }));
  }

  function healthResponse(res, ready) {
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable' }));
  }

  function apiAvailable() {
    // 严格业务就绪：由数据库健康检查确定，所有写请求必须有这种API节点。
    return !stopped && nodes.some(node => node.ready);
  }

  function readableApiAvailable() {
    // 静态页面和只读请求至少需要存活API，不能因数据库查询偶发慢就全部拒绝。
    return !stopped && nodes.some(node => node.alive || node.ready);
  }

  function workerAvailable() {
    return options.acceptRequests ? options.acceptRequests() : true;
  }

  function servesRequests() {
    // 集群整体 readiness 仍要求后台 Worker 就绪；不要把前台读取可用性冒报为完全就绪。
    return apiAvailable() && workerAvailable();
  }

  function mayReadWithoutWorker(method) {
    // 后台订单同步/Worker 短暂不可用不应阻断其他页面和只读查询。
    // 所有可能写入或入队的 HTTP 方法继续失败关闭，避免后台任务丢失。
    return method === 'GET' || method === 'HEAD';
  }

  const server = http.createServer((req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && pathname === '/health/live') {
      return healthResponse(res, true);
    }
    if (req.method === 'GET' && pathname === '/health/ready') {
      return healthResponse(res, servesRequests());
    }
    if (req.headers.upgrade) return reject(res, 426, '当前入口不支持协议升级，请使用普通 HTTP 请求。');
    const isRead = mayReadWithoutWorker(req.method);
    const isLogin = req.method === 'POST' && WORKER_INDEPENDENT_AUTH_POSTS.has(pathname);
    // Login still requires a DB-ready API; only the unrelated Worker gate is bypassed.
    if ((isRead && !readableApiAvailable()) ||
        (!isRead && !(isLogin ? apiAvailable() : servesRequests()))) {
      return reject(res, 503, '服务节点尚未就绪，请稍后重试。');
    }
    if (inflight >= maxInflight) return reject(res, 503, '服务器正在处理较多请求，请稍后重试。');
    const target = chooseNode(req);
    if (!target) return reject(res, 503, '当前没有可用的业务节点，请稍后重试。');
    if (pathname.startsWith('/api/auth/')) target.lastAuthAt = Date.now();
    inflight += 1;
    target.active += 1;
    const startedAt = Date.now();
    let released = false;
    let responded = false;
    const release = () => {
      if (released) return;
      released = true;
      inflight -= 1;
      target.active -= 1;
      const at = Date.now();
      samples.push({ at, ms: at - startedAt });
      if (samples.length > 5000) samples.splice(0, samples.length - 5000);
    };
    res.once('finish', release);
    res.once('close', release);
    const upstream = http.request({ host: target.host, port: target.port,
      method: req.method, path: req.url, headers: cleanHeaders(req, options.trustProxy === true),
      agent, timeout: upstreamTimeoutMs }, response => {
      responded = true;
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
      response.once('error', () => res.destroy());
    });
    upstream.once('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.once('error', () => {
      target.ready = false;
      target.alive = false;
      target.failures += 1;
      if (!res.headersSent && !responded) reject(res, 502, '业务节点连接中断，本次请求不会自动重发，请核对操作结果。');
      else if (!res.writableEnded) res.destroy();
    });
    req.once('aborted', () => upstream.destroy());
    req.once('error', () => upstream.destroy());
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });

  async function refreshHealth() {
    if (stopped || checking) return;
    checking = true;
    try {
      await Promise.all(nodes.map(async node => {
        // 进程存活不代表数据库就绪：隔离liveness与readiness，保留两个健康信号。
        const [alive, ready] = await Promise.all([
          probeEndpoint(node.host, node.port, '/health/live', probeTimeoutMs),
          probeEndpoint(node.host, node.port, '/health/ready', probeTimeoutMs)
        ]);
        node.alive = alive;
        node.ready = alive && ready;
      }));
    } finally {
      checking = false;
    }
  }

  function setDraining(index, value) {
    const node = nodes[index];
    if (!node) throw new Error('不存在的 API 节点索引。');
    node.draining = value === true;
  }

  function trafficSnapshot() {
    const cutoff = Date.now() - 60000;
    while (samples.length && samples[0].at < cutoff) samples.shift();
    const ordered = samples.map(sample => sample.ms).sort((a, b) => a - b);
    return { active: inflight, requests: ordered.length,
      p95Ms: ordered.length ? ordered[Math.ceil(ordered.length * 0.95) - 1] : 0 };
  }

  function startHealthChecks() {
    if (timer) return;
    refreshHealth().catch(() => {});
    timer = setInterval(() => refreshHealth().catch(() => {}), probeIntervalMs);
    timer.unref();
  }

  async function close() {
    stopped = true;
    clearInterval(timer);
    timer = null;
    await new Promise(resolve => server.close(() => resolve()));
    agent.destroy();
  }

  return { server, nodes, refreshHealth, startHealthChecks, close, setDraining, trafficSnapshot,
    snapshot: () => ({ active: inflight, nodes: nodes.map(({ index, port, alive, ready, active, failures, draining }) =>
      ({ index, port, alive, ready, active, failures, draining })) }) };
}

module.exports = { positiveInteger, probeEndpoint, sessionFingerprint, cleanHeaders, createLoadBalancer };
