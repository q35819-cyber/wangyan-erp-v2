'use strict';

const crypto = require('node:crypto');

function fail(code, text, status = 400) { return Object.assign(new Error(text || '本次操作未完成，请刷新页面后重新发起。'), { publicCode: code, status }); }
function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function taskName(taskId, capability) { return `${capability === 'image-translation' ? 'AI图片翻译' : 'AI图片重绘'} · ${String(taskId || '').slice(-8)}`; }
function initialDiagnostic(attemptKey, meta = {}) {
  return {
    taskId: String(meta.taskId || ''), businessRef: String(meta.taskId || ''), tenantId: String(meta.tenantId || ''), actorUserId: String(meta.actorUserId || ''), startedAt: new Date().toISOString(), endedAt: '',
    jobAttemptCount: 0, retryCount: 0, recoveryCount: 0, textCallCount: 0, imageSubmitCount: 0, pollCount: 0,
    textCall: { state: 'not_started' }, providerHttp: { state: 'not_started', requestId: 'unavailable' }, response: { sha256: '', chars: 0, jsonFields: [] }, fieldNumbers: {}, validation: {}, rendered: {},
    imagePost: { state: 'not_started', providerRequestId: 'unavailable', providerTaskId: 'unavailable', responseState: '', hasResultUrl: false, branch: '', attemptCount: 0 }, polling: { state: 'not_started', callCount: 0, trace: [] },
    delivery: { branch: '', downloadState: 'not_started', storeState: 'not_started', candidateState: 'not_started', settleState: 'not_started', errorCode: '' },
    billing: { amount: Number(meta.amount) || 0, unit: 'AI豆', freeze: { state: 'not_started', keyHash: digest(attemptKey + ':freeze') }, release: { state: 'not_started', keyHash: digest(attemptKey + ':release') }, settle: { state: 'not_started', keyHash: digest(attemptKey + ':settle') } }
  };
}
function billingResult(result, keyHash) {
  const event = result && result.event || {};
  const wallet = field => Number.isSafeInteger(Number(event[field])) ? Number(event[field]) : null;
  return { state: 'succeeded', keyHash, replayed: result?.replayed === true, balanceBefore: wallet('balanceBefore'), frozenBefore: wallet('frozenBefore'), balanceAfter: wallet('balanceAfter'), frozenAfter: wallet('frozenAfter') };
}

function createSkuImageAiEnqueuer({ authStore, aiBeanStore, imageCostBean, createJobId }) {
  async function currentImageCostBean() {
    const value = typeof imageCostBean === 'function' ? await imageCostBean() : imageCostBean;
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw fail('ai_pricing_invalid', 'AI生图价格配置无效，请联系系统管理员检查价格设置。', 503);
    return amount;
  }
  async function enqueueSkuImageAi({ account, idempotencyKey, requestHash, fingerprint, context, snapshotFactory }) {
    const namespace = 'sku_image.ai.enqueue';
    const claim = await authStore.claimIdempotency(account, namespace, idempotencyKey, requestHash);
    if (claim.state === 'replay') return { response: claim.body, replayed: true };
    if (claim.state === 'conflict') throw fail('idempotency_conflict', '本次图片请求与上一条未完成的请求内容不一致，请刷新页面后重新发起一次生图。', 409);
    if (claim.state === 'processing' || claim.state === 'recovery_required') throw fail('idempotency_in_progress', '上一次图片请求仍在处理中，系统不会重复提交或重复扣费，请稍等片刻或刷新任务列表查看进度。', 409);
    let taskId = createJobId(), client, freezeFailure = null;
    const billable = context.billingChannel !== 'own';
    const effectiveImageCostBean = billable ? await currentImageCostBean() : 0;
    const billingAmount = effectiveImageCostBean;
    try {
      client = await authStore.pool.connect();
      await client.query('BEGIN');
      let queued;
      for (let retry = 0; retry < 3; retry += 1) {
        if (retry > 0) taskId = createJobId();
        const attemptKey = 'sku-image-ai:' + taskId;
        const name = taskName(taskId, context.capability);
        try {
          queued = await authStore.enqueueBackgroundJob(account, {
            id: taskId, type: 'sku_image_ai', dedupeKey: fingerprint,
            context: { ...context, billingAttemptKey: attemptKey, taskName: name, diagnostic: initialDiagnostic(attemptKey, { taskId, tenantId: account.tenantId, actorUserId: account.userId, amount: billingAmount }) },
            maxAttempts: 3, initialState: 'queued', task: { name, label: '已进入服务器队列', article: context.productId }
          }, client);
          if (!queued.duplicate) {
            let diagnostic = queued.job.context.diagnostic;
            if (billable) {
              const keyHash = digest(attemptKey + ':freeze');
              const before = typeof aiBeanStore.balanceOn === 'function' ? await aiBeanStore.balanceOn(client, account.tenantId) : null;
              let frozen;
              try {
                frozen = await aiBeanStore.freezeOn(client, account.tenantId, { amount: effectiveImageCostBean, idempotencyKey: attemptKey + ':freeze', businessRef: taskId, reason: 'AI图片官方通道冻结', actorUserId: account.userId });
              } catch (error) {
                const endedAt = new Date().toISOString();
                const after = typeof aiBeanStore.balanceOn === 'function' ? await aiBeanStore.balanceOn(client, account.tenantId).catch(() => before) : before;
                const wallet = error.beanWallet || { balanceBefore: before?.balanceBean ?? null, frozenBefore: before?.frozenBean ?? null, balanceAfter: after?.balanceBean ?? null, frozenAfter: after?.frozenBean ?? null };
                freezeFailure = { taskId, businessRef: taskId, tenantId: String(account.tenantId), actorUserId: String(account.userId), amount: effectiveImageCostBean, unit: 'AI豆', state: 'failed', keyHash, errorCode: String(error.publicCode || error.message || 'ai_bean_freeze_failed').slice(0, 120), startedAt: queued.job.context.diagnostic.startedAt, endedAt, ...wallet };
                error.safeDiagnostic = { billing: { freeze: freezeFailure } };
                throw error;
              }
              diagnostic = { ...diagnostic, billing: { ...diagnostic.billing, freeze: billingResult(frozen, keyHash) } };
            } else if (!billable) {
              diagnostic = { ...diagnostic, billing: { ...diagnostic.billing, amount: 0, freeze: { state: 'not_applicable', keyHash: '', replayed: false, errorCode: '', balanceBefore: null, frozenBefore: null, balanceAfter: null, frozenAfter: null } } };
            }
            const promptSnapshots = typeof snapshotFactory === 'function' ? await snapshotFactory(taskId) : null;
            const patch = { diagnostic };
            if (context.capability === 'image-redraw') patch.sellingPoints = null;
            if (promptSnapshots) patch.promptSnapshots = promptSnapshots;
            queued.job = await authStore.patchQueuedBackgroundJob(account, taskId, patch, client);
          }
          break;
        } catch (error) {
          if (error.publicCode !== 'background_job_id_conflict' || retry === 2) throw error;
        }
      }
      await client.query('COMMIT');
      const response = { taskId: queued.job.id, state: queued.job.state, duplicate: queued.duplicate };
      await authStore.checkpointIdempotency(account, namespace, idempotencyKey, response);
      await authStore.completeIdempotency(account, namespace, idempotencyKey, 202, response);
      return { response, replayed: false };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      if (freezeFailure && typeof authStore.recordAudit === 'function') {
        await authStore.recordAudit(account, 'sku.image.ai.billing.freeze', 'background_job', taskId, 'failed', freezeFailure).catch(() => {});
      }
      await authStore.failIdempotency(account, namespace, idempotencyKey).catch(() => {});
      throw error;
    } finally { if (client) client.release(); }
  }

  enqueueSkuImageAi.enqueueBatch = async function enqueueSkuImageAiBatch({ account, idempotencyKey, requestHash, parentTask, items }) {
    const namespace = 'sku_image.ai.batch.enqueue';
    const claim = await authStore.claimIdempotency(account, namespace, idempotencyKey, requestHash);
    if (claim.state === 'replay') return { response: claim.body, replayed: true };
    if (claim.state === 'conflict') throw fail('idempotency_conflict', '本次批量图片请求与上一条未完成的请求内容不一致，请刷新页面后重新提交。', 409);
    if (claim.state === 'processing' || claim.state === 'recovery_required') throw fail('idempotency_in_progress', '上一次批量图片请求仍在处理中，请稍候片刻再查看任务中心。', 409);
    const parent = parentTask && typeof parentTask === 'object' ? parentTask : {};
    const children = Array.isArray(items) ? items : [];
    if (!/^sync-sku-ai-[A-Za-z0-9-]{6,100}$/.test(String(parent.id || '')) || !children.length || children.length > 1380) throw fail('sku_image_batch_invalid', '批量重绘任务内容不完整，请刷新页面后重新提交。');
    const effectiveImageCostBean = await currentImageCostBean();
    let client;
    try {
      client = await authStore.pool.connect();
      await client.query('BEGIN');
      await authStore.upsertSyncTask(account, { id: parent.id, type: 'sync', status: 'running', value: 0, name: 'AI图片批量重绘', label: '已进入服务器队列，等待执行', article: parent.article, sku: parent.sku, startedAt: new Date() }, client);
      const taskIds = [];
      for (const item of children) {
        const source = item && typeof item === 'object' ? item : {};
        let taskId = createJobId(), queued;
        for (let retry = 0; retry < 3; retry += 1) {
          if (retry) taskId = createJobId();
          const attemptKey = 'sku-image-ai:' + taskId;
          const name = String(source.name || taskName(taskId, source.context && source.context.capability)).slice(0, 160);
          try {
            queued = await authStore.enqueueBackgroundJob(account, { id: taskId, type: 'sku_image_ai', dedupeKey: String(source.fingerprint || ''), context: { ...(source.context || {}), billingAttemptKey: attemptKey, taskName: name, diagnostic: initialDiagnostic(attemptKey, { taskId, tenantId: account.tenantId, actorUserId: account.userId, amount: source.context?.billingChannel !== 'own' ? effectiveImageCostBean : 0 }) }, maxAttempts: 3, initialState: 'queued', task: { name, label: '等待父任务启动', article: source.context && source.context.productId, sku: source.context && source.context.variantRef, parentTaskId: parent.id } }, client);
            if (queued.duplicate) throw fail('sku_image_batch_duplicate', '批量中存在仍在处理的相同图片任务，请刷新任务中心后重新提交。', 409);
            let diagnostic = queued.job.context.diagnostic;
            if (source.context?.billingChannel !== 'own') {
              const keyHash = digest(attemptKey + ':freeze');
              const frozen = await aiBeanStore.freezeOn(client, account.tenantId, { amount: effectiveImageCostBean, idempotencyKey: attemptKey + ':freeze', businessRef: taskId, reason: 'AI图片官方通道冻结', actorUserId: account.userId });
              diagnostic = { ...diagnostic, billing: { ...diagnostic.billing, freeze: billingResult(frozen, keyHash) } };
            } else {
              diagnostic = { ...diagnostic, billing: { ...diagnostic.billing, amount: 0, freeze: { state: 'not_applicable', keyHash: '', replayed: false, errorCode: '', balanceBefore: null, frozenBefore: null, balanceAfter: null, frozenAfter: null } } };
            }
            const promptSnapshots = typeof source.snapshotFactory === 'function' ? await source.snapshotFactory(taskId) : null;
            const patch = { diagnostic };
            if (source.context?.capability === 'image-redraw') patch.sellingPoints = null;
            if (promptSnapshots) patch.promptSnapshots = promptSnapshots;
            await authStore.patchQueuedBackgroundJob(account, taskId, patch, client);
            taskIds.push(taskId);
            break;
          } catch (error) {
            if (error.publicCode !== 'background_job_id_conflict' || retry === 2) throw error;
          }
        }
      }
      await authStore.enqueueBackgroundJob(account, { id: parent.id, type: 'sku_image_ai_batch', dedupeKey: parent.id, context: { clientId: children[0].context.clientId }, maxAttempts: 10 }, client);
      const response = { taskId: String(parent.id), taskIds, state: 'queued' };
      await authStore.checkpointIdempotency(account, namespace, idempotencyKey, response);
      await client.query('COMMIT');
      await authStore.completeIdempotency(account, namespace, idempotencyKey, 202, response);
      return { response, replayed: false };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      await authStore.failIdempotency(account, namespace, idempotencyKey).catch(() => {});
      throw error;
    } finally { if (client) client.release(); }
  };
  return enqueueSkuImageAi;
}

module.exports = { createSkuImageAiEnqueuer, initialDiagnostic, taskName };
