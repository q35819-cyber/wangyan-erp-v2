'use strict';

// 单机控制器只管理 API 进程。所有资源判断由调用方提供，避免在这里触碰业务数据库。
function createApiAutoscaler(options) {
  const min = options.min;
  const max = options.max;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 2 || max < min || max > 8) {
    throw new Error('API 自动扩缩容节点上下限无效。');
  }
  const now = options.now || Date.now;
  const upHoldMs = options.upHoldMs === undefined ? 30000 : options.upHoldMs;
  const downHoldMs = options.downHoldMs === undefined ? 180000 : options.downHoldMs;
  const cooldownMs = options.cooldownMs === undefined ? 120000 : options.cooldownMs;
  let desired = min;
  let highSince = null;
  let lowSince = null;
  let lastChange = -Infinity;
  let busy = false;

  async function tick() {
    if (busy) return { action: 'busy', desired };
    const time = now();
    const s = options.metrics();
    // 至少保留两个数据库就绪的 API。连接池或进程不健康时不尝试靠扩容掩盖故障。
    const healthy = s.readyApi >= Math.min(desired, min) && s.workerReady;
    if (!healthy || s.draining || !s.dbBudgetSafe) {
      highSince = lowSince = null;
      return { action: 'guard', desired };
    }
    // 慢请求可能是 PostgreSQL 等待或外部平台变慢，不能仅凭 p95 触发盲目扩容。
    const high = s.active >= s.readyApi * options.upActivePerNode;
    const low = s.active <= options.downActiveTotal && s.p95Ms < options.slowP95Ms &&
      s.requests < options.slowMinRequests;
    highSince = high ? (highSince === null ? time : highSince) : null;
    lowSince = low ? (lowSince === null ? time : lowSince) : null;
    if (time - lastChange < cooldownMs) return { action: 'cooldown', desired };

    if (desired < max && highSince !== null && time - highSince >= upHoldMs) {
      // 宿主机已过载/内存不足不应继续增加工作进程。
      if (!s.cpuKnown || s.cpuPercent > options.maxCpuPercent ||
          s.freeMemoryBytes < options.minFreeMemoryBytes || !s.allDesiredReady) {
        return { action: 'resource_guard', desired };
      }
      busy = true;
      try {
        await options.add(desired);
        desired += 1;
        lastChange = time;
        highSince = lowSince = null;
        return { action: 'up', desired };
      } finally { busy = false; }
    }

    if (desired > min && lowSince !== null && time - lowSince >= downHoldMs) {
      busy = true;
      try {
        // remove 返回 false 表示仍有在途请求，必须取消缩容并继续提供服务。
        if (!(await options.remove(desired - 1))) {
          lowSince = null;
          return { action: 'drain_deferred', desired };
        }
        desired -= 1;
        lastChange = time;
        highSince = lowSince = null;
        return { action: 'down', desired };
      } finally { busy = false; }
    }
    return { action: 'observe', desired };
  }

  return { tick, get desired() { return desired; } };
}

module.exports = { createApiAutoscaler };
