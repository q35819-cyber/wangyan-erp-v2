'use strict';

const crypto = require('crypto');
const { deferBackgroundClaim } = require('./pool-pressure');

function createClientOrderUploadWorker(options = {}) {
  const store = options.store;
  const pollMs = Math.max(250, Math.min(30000, Number(options.pollMs) || 1000));
  const leaseMs = Math.max(5000, Math.min(300000, Number(options.leaseMs) || 120000));
  const workerId = String(options.workerId || ('client-order-' + crypto.randomUUID())).slice(0, 120);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const onFinalFailure = typeof options.onFinalFailure === 'function' ? options.onFinalFailure : async () => {};
  let timer = null, stopped = true, running = false, consecutiveDeferrals = 0, poolPressureDeferrals = 0;
  function schedule(delay = pollMs) {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; tick().catch(onError); }, delay);
    if (timer.unref) timer.unref();
  }
  async function tick() {
    if (stopped || running) return false;
    running = true;
    try {
      if (deferBackgroundClaim(store && store.pool, consecutiveDeferrals)) {
        consecutiveDeferrals += 1;
        poolPressureDeferrals += 1;
        return false;
      }
      consecutiveDeferrals = 0;
      const batch = await store.claimClientOrderUploadBatch(workerId, leaseMs);
      if (!batch) return false;
      try {
        await store.applyClientOrderUploadBatch(batch, workerId);
      } catch (error) {
        const failure = await store.failClientOrderUploadBatch(batch, workerId, error);
        if (failure && failure.final === true) await onFinalFailure(error, failure);
        onError(error);
      }
      return true;
    } catch (error) {
      if (error && error.code === '42P01') stopped = true;
      else onError(error);
      return false;
    } finally { running = false; schedule(); }
  }
  function start() { if (stopped) { stopped = false; schedule(0); } }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }
  return { start, stop, tick, workerId, state: () => ({ stopped, running, poolPressureDeferrals }) };
}

module.exports = { createClientOrderUploadWorker };
