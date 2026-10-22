'use strict';

const edit = require('./product-edit');

const DEFAULT_INTERVAL_MS = 1000;
const FIRST_POLL_MS = 3000;
const SECOND_POLL_MS = 5000;
const LATER_POLL_MS = 10000;
const EDIT_CONFIRM_TIMEOUT_MS = 60 * 1000;

// PostgreSQL owns both the work and the task-center receipt. No browser lifetime,
// cookie, or in-memory job is required to finish an accepted edit.
function createProductEditQueue({ store, callFor, imagePublisher, shopScheduler, intervalMs = DEFAULT_INTERVAL_MS, maxPendingMs = EDIT_CONFIRM_TIMEOUT_MS, now = () => Date.now(), onError = () => {} }) {
  let timer, running = null, stopped = false;
  async function processJob(job) {
    const execute = () => store.withProductEditLock(job.tenant_id, job.state.queueId, async () => {
      const account = await store.productEditActor(job.tenant_id, job.state.actorUserId);
      if (!account) return;
      const target = { clientId: String(job.shop_external_id), productId: String(job.product_id) };
      const current = await store.getEditableProduct(account, target), state = current.item.ozonEdit;
      if (!state || state.queueId !== job.state.queueId || !['queued','preparing','submitting','pending'].includes(state.phase)) return;
      async function update(fields) {
        return store.mutateEditableProduct(account, target, null, item => !item.ozonEdit || item.ozonEdit.queueId !== state.queueId ? item :
          { ...item, ozonEdit: { ...item.ozonEdit, ...fields, lastCheckedAt: new Date().toISOString() } });
      }
      // A crashed process might have dispatched this write. Never dispatch it twice.
      if (state.phase === 'submitting') {
        await update({ phase: 'unknown', message: '服务在提交期间中断，Ozon结果不确定；已停止重发，请核对后处理' }); return;
      }
      const allowed = await store.listAllowedShops(account);
      if (!account.enabled || !store.hasPermission(account, 'products.write') || allowed !== null && !allowed.some(s => String(s.externalShopId) === target.clientId)) {
        await update({ phase: state.phase === 'pending' ? 'unknown' : 'failed', message: '操作账号、租户或店铺授权已失效；任务停止，未重发平台请求' }); return;
      }
      const currentTime = now();
      if (state.phase === 'pending') {
        const deadline = Date.parse(state.confirmDeadlineAt || state.platformSubmittedAt || state.updatedAt) + (state.confirmDeadlineAt ? 0 : maxPendingMs);
        if (Number.isFinite(deadline) && currentTime >= deadline) {
          const detail = Array.isArray(state.lastMismatchFields) && state.lastMismatchFields.length ? '平台回读仍未生效：' + state.lastMismatchFields.join('、') : state.lastPollError ? '最后一次查询异常：' + state.lastPollError : '约1分钟内仍未回读到修改后的平台数据';
          await update({ phase: 'failed', failureCode: 'ozon_edit_confirm_timeout', failedAt: new Date(currentTime).toISOString(), message: 'Ozon修改确认超时：' + detail });
          return;
        }
        const nextCheck = Date.parse(state.nextCheckAt || '');
        if (Number.isFinite(nextCheck) && currentTime < nextCheck) return;
      }
      try {
        const result = await edit.execute({ store, account, target, input: state.phase === 'pending' ? { action: 'status' } : { action: 'runQueued', queueId: state.queueId }, call: callFor(account, target), imagePublisher });
        const nextState = result && result.item && result.item.ozonEdit;
        if (state.phase === 'pending' && nextState && nextState.phase === 'pending') {
          const attempt = Number(state.pollAttempt || 0) + 1;
          const delay = attempt === 1 ? SECOND_POLL_MS : LATER_POLL_MS;
          await update({ pollAttempt: attempt, nextCheckAt: new Date(currentTime + delay).toISOString(), lastPollError: '' });
        } else await update({});
      } catch (error) {
        if (state.phase === 'pending') {
          const attempt = Number(state.pollAttempt || 0) + 1;
          const delay = attempt === 1 ? SECOND_POLL_MS : LATER_POLL_MS;
          await update({ pollAttempt: attempt, nextCheckAt: new Date(currentTime + delay).toISOString(), lastPollError: String(error.publicCode || error.message || '暂时不可用').slice(0, 240), message: '暂未取得处理结果，服务端将按计划继续查询' });
        } else await update({ message: '暂未取得处理结果，服务端将继续查询：' + (error.publicCode || '暂时不可用') });
      }
    });
    await (shopScheduler ? shopScheduler.run(job.shop_external_id, execute) : execute());
  }
  function tick() {
    if (stopped || running) return running || Promise.resolve();
    running = (async () => {
      const jobs = await store.listProductEditJobs();
      for (const job of jobs) {
        if (stopped) break;
        try { await processJob(job); } catch (error) { onError(error); }
      }
    })().catch(onError).finally(() => { running = null; });
    return running;
  }
  return {
    tick,
    start() { stopped = false; timer = setInterval(tick, intervalMs); timer.unref(); tick(); },
    async stop() { stopped = true; clearInterval(timer); if (running) await running; }
  };
}
module.exports = { createProductEditQueue, DEFAULT_INTERVAL_MS, FIRST_POLL_MS, SECOND_POLL_MS, LATER_POLL_MS, EDIT_CONFIRM_TIMEOUT_MS };
