'use strict';

const create = require('./product-create');

const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_PENDING_LIMIT_MS = 60 * 60 * 1000;
const DEFAULT_VERIFICATION_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_VERIFICATION_RETRY_DELAY_MS = 60 * 60 * 1000;

function createProductCreateQueue({ store, callFor, shopScheduler, intervalMs = DEFAULT_INTERVAL_MS, maxPendingMs = DEFAULT_PENDING_LIMIT_MS, verificationWindowMs = DEFAULT_VERIFICATION_WINDOW_MS, verificationRetryDelayMs = DEFAULT_VERIFICATION_RETRY_DELAY_MS, now = () => Date.now(), onError = () => {} }) {
  let timer, running = null, stopped = false;
  async function processJob(job) {
    const execute = () => store.withProductCreateLock(job.tenant_id, job.draft_id, job.state.queueId, async () => {
      const account = await store.productEditActor(job.tenant_id, job.state.actorUserId);
      if (!account) return;
      const current = await store.getProductCreateDraft(account, job.draft_id), state = current.item.ozonCreate;
      if (!state || state.queueId !== job.state.queueId || !['queued', 'preparing', 'submitting', 'pending', 'verifying'].includes(state.phase)) return;
      const update = fields => store.mutateProductCreateDraft(account, job.draft_id, null, draft => !draft.ozonCreate || draft.ozonCreate.queueId !== state.queueId ? draft :
        ({ ...draft, ozonCreate: { ...draft.ozonCreate, ...fields, lastCheckedAt: new Date(now()).toISOString() } }));
      if (state.phase === 'submitting') {
        await update({ phase: 'unknown', message: '服务在提交期间中断，Ozon结果不确定；已停止重发，请核对后处理' });
        return;
      }
      const allowed = await store.listAllowedShops(account);
      if (!account.enabled || !store.hasPermission(account, 'products.write') || allowed !== null && !allowed.some(shop => String(shop.externalShopId) === String(state.clientId))) {
        await update({ phase: ['pending','verifying'].includes(state.phase) ? 'unknown' : 'failed', message: '操作账号、租户或店铺授权已失效；任务停止，未重发平台请求' });
        return;
      }
      const currentTime = now();
      if (state.phase === 'pending' && currentTime - Date.parse(state.updatedAt) > maxPendingMs) {
        await update({ phase: 'unknown', message: 'Ozon创建任务超过1小时仍未确认结果；已停止自动处理，禁止重复提交，请核对平台状态' });
        return;
      }
      let finalVerificationRetry = false;
      if (state.phase === 'verifying') {
        const retryAt = Date.parse(state.verificationRetryAt || '');
        if (Number.isFinite(retryAt)) {
          if (currentTime < retryAt) return;
          finalVerificationRetry = true;
        } else if (currentTime - Date.parse(state.verificationStartedAt || state.updatedAt) > verificationWindowMs) {
          await update({
            verificationFirstFailedAt: new Date(currentTime).toISOString(),
            verificationRetryAt: new Date(currentTime + verificationRetryDelayMs).toISOString(),
            message: '首次平台确认已持续1小时仍未成功，已暂停查询，将在1小时后自动复核一次'
          });
          return;
        }
      }
      try {
        const result = await create.execute({
          store, account, draftId: job.draft_id,
          action: ['pending','verifying'].includes(state.phase) ? 'status' : 'runQueued',
          call: callFor(account, { clientId: String(state.clientId), draftId: job.draft_id })
        });
        const nextState = result && result.item && result.item.ozonCreate;
        if (finalVerificationRetry && nextState && nextState.phase === 'verifying') {
          const reason = String(nextState.verificationLastReason || state.verificationLastReason || 'Ozon仍未返回可查询的商品详情').slice(0, 300);
          await update({
            phase: 'failed', verificationFinalRetryAt: new Date(currentTime).toISOString(),
            message: 'Ozon商品确认失败：首次确认1小时未成功，等待1小时后的最终复核仍失败。原因：' + reason
          });
          return;
        }
        await update({});
      } catch (error) {
        if (finalVerificationRetry) {
          await update({
            phase: 'failed', verificationFinalRetryAt: new Date(currentTime).toISOString(),
            message: 'Ozon商品确认失败：首次确认1小时未成功，等待1小时后的最终复核仍无法读取商品详情。请在Ozon卖家后台核对商品状态'
          });
          return;
        }
        await update({ message: state.phase === 'verifying'
          ? 'Ozon商品确认暂时失败，服务端将在30秒后继续查询'
          : '暂未取得新增结果，服务端将在30秒后继续查询' });
      }
    });
    await (shopScheduler ? shopScheduler.run(job.state.clientId, execute) : execute());
  }
  function tick() {
    if (stopped || running) return running || Promise.resolve();
    running = (async () => {
      const jobs = await store.listProductCreateJobs();
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

module.exports = { createProductCreateQueue, DEFAULT_INTERVAL_MS, DEFAULT_PENDING_LIMIT_MS, DEFAULT_VERIFICATION_WINDOW_MS, DEFAULT_VERIFICATION_RETRY_DELAY_MS };
