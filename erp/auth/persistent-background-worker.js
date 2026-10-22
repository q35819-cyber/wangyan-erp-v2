'use strict';

const crypto = require('crypto');
const { deferBackgroundClaim } = require('./pool-pressure');

function retryOutcome(job, error) {
  if (job.type === 'bug_email') return { state: 'unknown', delayMs: 0 };
  const code = String(error && (error.publicCode || error.message) || '');
    const deterministic = /actor_unavailable|scope_denied|credentials_not_found|permission|context_invalid|input_invalid|handler_missing|version_conflict|prompt_changed|recovery_required|channel_unavailable|provider_task_missing/i.test(code);
  const attempts = Math.max(0, Number(job.attempts) || 0);
  const maximum = Math.max(0, Number(job.maxAttempts) || 0);
  if (error && error.retryable === false || deterministic || attempts >= maximum) return { state: 'failed', delayMs: 0 };
  const requested = Math.max(0, Number(error && error.retryAfterMs) || 0);
  return { state: 'retry', delayMs: Math.min(30000, requested || 1000 * Math.pow(2, Math.max(0, attempts - 1))) };
}

function backgroundFailureText(error) {
  if (!error) return 'background_job_failed';
  const values = [error.externalMessage, error.upstreamMessage, error.providerMessage, error.rawMessage, error.message, error.publicCode];
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text) return text.slice(0, 1500);
  }
  return 'background_job_failed';
}

function createPersistentBackgroundWorker(options = {}) {
  const store = options.store;
  const handlers = options.handlers || {};
  const pollMs = Math.max(250, Math.min(30000, Number(options.pollMs) || 1000));
  const leaseMs = Math.max(5000, Math.min(900000, Number(options.leaseMs) || 120000));
  const concurrency = Math.max(1, Math.min(16, Math.floor(Number(options.concurrency) || 1)));
  const workerId = String(options.workerId || ('worker-' + crypto.randomUUID())).slice(0, 120);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  let timer = null, running = false, stopped = true, schemaAvailable = null, completed = 0, failed = 0, retried = 0;
  let consecutiveDeferrals = 0, poolPressureDeferrals = 0;
  function schedule(delay = pollMs) {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; tick().catch(error => onError(error)); }, delay);
    if (timer.unref) timer.unref();
  }
  async function processJob(job) {
    const handler = handlers[job.type];
    if (typeof handler !== 'function') {
      await store.finishBackgroundJob(job.tenantId, job.id, workerId, { state: 'failed', error: 'background_job_handler_missing' });
      failed += 1;
      return;
    }
    let handlerError = null;
    let heartbeat = null;
    if (typeof store.renewBackgroundJobLease === 'function') {
      heartbeat = setInterval(() => {
        store.renewBackgroundJobLease(job.tenantId, job.id, workerId, leaseMs).then(renewed => {
          if (!renewed) onError(new Error('任务执行权已被其他工作进程取走，本进程停止继续处理。'), job);
        }).catch(error => onError(error, job));
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      if (heartbeat.unref) heartbeat.unref();
    }
    try { await handler(job, { workerId, checkpoint: typeof store.checkpointBackgroundJob === 'function' ? patch => store.checkpointBackgroundJob(job, workerId, patch) : async () => null }); }
    catch (error) { handlerError = error; }
    finally { if (heartbeat) clearInterval(heartbeat); }
    if (handlerError) {
      const outcome = retryOutcome(job, handlerError);
      await store.finishBackgroundJob(job.tenantId, job.id, workerId, { ...outcome, error: backgroundFailureText(handlerError) });
      if (outcome.state === 'retry') {
        retried += 1;
        if (typeof store.markBackgroundJobRetryVisible === 'function') await store.markBackgroundJobRetryVisible(job, outcome.delayMs).catch(error => onError(error, job));
      } else failed += 1;
      onError(handlerError, job);
    } else {
      await store.finishBackgroundJob(job.tenantId, job.id, workerId, { state: 'done' });
      completed += 1;
    }
  }
  async function tick() {
    if (stopped || running) return;
    running = true;
    try {
      if (deferBackgroundClaim(store && store.pool, consecutiveDeferrals)) {
        consecutiveDeferrals += 1;
        poolPressureDeferrals += 1;
        return;
      }
      consecutiveDeferrals = 0;
      if (typeof store.recoverExpiredBackgroundJobs === 'function') await store.recoverExpiredBackgroundJobs();
      const jobs = await store.claimBackgroundJobs(workerId, concurrency, leaseMs);
      schemaAvailable = true;
      await Promise.all(jobs.map(processJob));
    } catch (error) {
      if (error && error.code === '42P01') { schemaAvailable = false; stopped = true; }
      else onError(error);
    } finally { running = false; schedule(); }
  }
  function start() { if (stopped) { stopped = false; schedule(0); } }
  function stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; }
  function state() { return { running, enabled: !stopped, schemaAvailable, completed, failed, retried, ...(poolPressureDeferrals ? { poolPressureDeferrals } : {}) }; }
  return { start, stop, tick, state, workerId };
}

module.exports = { retryOutcome, createPersistentBackgroundWorker };
