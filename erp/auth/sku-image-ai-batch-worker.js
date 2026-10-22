'use strict';

const { retryOutcome } = require('./persistent-background-worker');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function createSkuImageAiBatchWorker({ store, runChild, leaseMs = 120000 }) {
  return async function runSkuImageAiBatch(parent, tools = {}) {
    const workerId = String(tools.workerId || '');
    await store.markSkuImageBatchStarted(parent.tenantId, parent.id);

    async function execute(child) {
      const heartbeat = setInterval(() => store.renewBackgroundJobLease(child.tenantId, child.id, workerId, leaseMs).catch(() => {}), Math.max(1000, Math.floor(leaseMs / 3)));
      heartbeat.unref?.();
      try {
        await runChild(child, { workerId, checkpoint: patch => store.checkpointBackgroundJob(child, workerId, patch) });
        await store.finishBackgroundJob(child.tenantId, child.id, workerId, { state: 'done' });
      } catch (error) {
        const outcome = retryOutcome(child, error);
        await store.finishBackgroundJob(child.tenantId, child.id, workerId, { ...outcome, error: String(error.publicCode || error.message || 'background_job_failed') });
        if (outcome.state === 'retry') await store.markBackgroundJobRetryVisible(child, outcome.delayMs);
        else await store.markSkuImageBatchChildFailed(child.tenantId, child.id);
      } finally { clearInterval(heartbeat); }
    }

    while (true) {
      await store.recoverExpiredBackgroundJobs();
      const children = await store.claimSkuImageBatchChildren(parent.tenantId, parent.id, workerId, leaseMs);
      if (children.length) {
        const results = await Promise.allSettled(children.map(execute));
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected) throw rejected.reason;
      }
      const states = await store.skuImageBatchChildStates(parent.tenantId, parent.id);
      const total = states.reduce((count, row) => count + Number(row.count), 0);
      if (!total) throw Object.assign(new Error('批量图片任务没有子任务。'), { publicCode: 'sku_image_batch_empty', retryable: false });
      if (states.every(row => ['done', 'failed', 'cancelled'].includes(row.state))) {
        await store.refreshSkuImageBatchParent(store.pool, parent.tenantId, parent.id);
        return;
      }
      const next = Math.min(...states.filter(row => row.state === 'retry').map(row => Math.max(0, new Date(row.next_available).getTime() - Date.now())), 1000);
      await pause(Math.max(250, Number.isFinite(next) ? next : 1000));
    }
  };
}

module.exports = { createSkuImageAiBatchWorker };
