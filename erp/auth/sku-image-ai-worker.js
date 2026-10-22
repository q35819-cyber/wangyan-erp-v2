'use strict';

const crypto = require('node:crypto');
const skuImageAnalysisProof = require('./sku-image-analysis-proof');
const skuImageFinalPrompt = require('./sku-image-final-prompt');
const skuImagePolling = require('./sku-image-polling');
const skuImagePromptSnapshot = require('./sku-image-prompt-snapshot');
const skuImageResultReference = require('./sku-image-result-reference');

function shouldReleaseSkuImageAiBeans(job, error) {
  const code = String(error && (error.publicCode || error.message) || '');
  if (/recovery_required/i.test(code)) return false;
  if (error && error.retryable === false) return true;
  if (/version_conflict|prompt_changed|source_integrity_failed|channel_unavailable|provider_task_missing|provider_failed|image_result_not_found|authentication_failed|balance_insufficient|model_not_found|content_rejected|rate_limited|provider_rejected|image_generate_failed/i.test(code)) return true;
  return error && error.retryable === true && Number(job.attempts) >= Number(job.maxAttempts);
}

function requireSkuImagePromptReady(promptBody) {
  if (!String(promptBody || '').trim() || /待系统管理员或租户填写/.test(String(promptBody))) {
    throw Object.assign(new Error('AI生图提示词尚未配置，请先在AI配置中完成设置。'), { publicCode: 'sku_image_prompt_unconfigured', status: 409, retryable: false });
  }
}

function cleanError(error) {
  return String(error && error.message || '').replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=_-]+/gi, 'data:image/*;base64,[已隐藏]').replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]').replace(/api[_-]?key[=:]\s*[^,\s]+/gi, 'apiKey=[已隐藏]').slice(0, 240);
}

function digest(value) { return crypto.createHash('sha256').update(String(value || '')).digest('hex'); }
function stableUuid(value) {
  const bytes = Buffer.from(digest(value).slice(0, 32), 'hex');
  bytes[6] = bytes[6] & 0x0f | 0x50;
  bytes[8] = bytes[8] & 0x3f | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function mergeDiagnostic(base, patch) {
  const next = { ...(base || {}), ...(patch || {}) };
  for (const key of ['textCall', 'providerHttp', 'response', 'fieldNumbers', 'validation', 'rendered', 'imagePost', 'polling', 'delivery', 'billing']) {
    if (base?.[key] || patch?.[key]) next[key] = { ...(base?.[key] || {}), ...(patch?.[key] || {}) };
  }
  return next;
}
function beanDiagnostic(result, key) {
  const event = result && result.event || {};
  const wallet = field => Number.isSafeInteger(Number(event[field])) ? Number(event[field]) : null;
  return { state: 'succeeded', keyHash: digest(key), replayed: result?.replayed === true, balanceBefore: wallet('balanceBefore'), frozenBefore: wallet('frozenBefore'), balanceAfter: wallet('balanceAfter'), frozenAfter: wallet('frozenAfter') };
}
function beanFailureDiagnostic(error, key, before, after) {
  const wallet = error?.beanWallet || { balanceBefore: before?.balanceBean ?? null, frozenBefore: before?.frozenBean ?? null, balanceAfter: after?.balanceBean ?? null, frozenAfter: after?.frozenBean ?? null };
  return { state: 'failed', keyHash: digest(key), replayed: false, errorCode: String(error && (error.publicCode || error.message) || 'ai_bean_operation_failed').slice(0, 120), ...wallet };
}
function pollTrace(polling, entry) { return [...(Array.isArray(polling?.trace) ? polling.trace : []), entry].slice(-96); }

function skuImageAiFailureText(error) {
  const code = String(error && (error.publicCode || error.message) || '');
  const detail = cleanError(error);
  if (/recovery_required/i.test(code)) return { label: '官方图片结果等待超时，待只读恢复', reason: '供应商任务可能仍在处理或提交结果无法确认；系统不会重复提交，后续只能按已保存任务号查询结果。' };
  if (/prompt_preparing|prompt_response|prompt_template_changed|prompt_number_changed|prompt_not_chinese|prompt_language_mismatch|prompt_placeholder/i.test(code)) return { label: '图片提示词整理失败，任务未提交', reason: cleanError(error) || '文字模型未能生成符合官方模板和已确认图片文案门禁的最终提示词；图片模型未调用。' };
  if (/prompt_unconfigured/i.test(code)) return { label: '图片提示词未配置，任务未提交', reason: '当前图片提示词仍是占位内容，请先在AI配置中填写并启用对应模板。' };
  if (/prompt_changed/i.test(code)) return { label: '图片提示词已变更，任务已停止', reason: '提交后生效模板发生变化，本次未继续生成；请重新解析卖点并发起重绘。' };
  if (/version_conflict/i.test(code)) return { label: '原图片已变更，本次结果未写入图片列表，请重新发起', reason: '原图片版本或内容已变化，为避免覆盖错误图片，本次任务已停止。' };
  if (/source_integrity_failed/i.test(code)) return { label: '原图读取校验失败，任务已停止', reason: '私有图片对象大小或哈希校验失败，未向官方通道提交；请重新上传或重新选择图片。' };
  if (/channel_unavailable/i.test(code)) return { label: '官方图片通道不可用，任务未提交', reason: '服务器未取得可用官方图片通道配置，本次冻结额度已按最终失败退回。' };
  if (/provider_task_missing/i.test(code)) return { label: '官方服务未返回任务号或候选图', reason: '官方服务响应缺少可追踪任务号或结果图，本次冻结额度已退回；请稍后重试。' };
  if (/image_result_not_found/i.test(code)) return { label: '官方图片结果不存在或已过期', reason: '供应商结果查询确认任务结果不存在或已过期；系统未重新提交，也未写入图片列表。' };
  if (/provider_failed|ai_image_generate_failed/i.test(code)) return { label: '官方图片生成失败', reason: '供应商返回终态失败' + (detail ? '：' + detail : '，本次冻结额度已退回。') };
  if (/ai_timeout/i.test(code)) return { label: '官方图片请求超时', reason: '请求超过120秒仍未返回；若未取得任务号，将按结果未知处理，禁止直接重试。' };
  if (/download|private_address_denied|store|candidate|complete|object/i.test(code)) return { label: '候选图保存失败', reason: '官方已返回结果，但下载、私有存储或图片列表写入失败' + (detail ? '：' + detail : '。') };
  return { label: 'AI图片生成失败', reason: 'AI图片任务失败' + (detail ? '：' + detail : '，请在任务中心查看详情。') };
}

function createSkuImageAiWorker(deps) {
  return async function runPersistedSkuImageAi(job, tools = {}) {
    const { authStore, privateObjectStore, aiPromptStore, aiConfigStore, aiConfig, credentialsKey, aiProvider, skuImageUpload, aiBeanStore, imageCostBean: legacyImageCostBean, submitTimeoutMs, pollTotalWaitMs, pollIntervalMs } = deps;
    const pollNotFoundGraceMs = deps.pollNotFoundGraceMs === undefined ? skuImagePolling.NOT_FOUND_GRACE_MS : Math.max(0, Number(deps.pollNotFoundGraceMs) || 0);
    const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs : Date.now;
    const wait = typeof deps.wait === 'function' ? deps.wait : ms => new Promise(resolve => setTimeout(resolve, ms));
    const actor = await authStore.backgroundJobActor(job);
    const billingActorUserId = String(actor && actor.userId || job.actorUserId || job.context && job.context.diagnostic && job.context.diagnostic.actorUserId || '').trim();
    const context = job.context || {}, startedAt = job.createdAt || new Date().toISOString();
    const snapshottedImageCost = Number(context.diagnostic?.billing?.amount);
    const imageCostBean = Number.isSafeInteger(snapshottedImageCost) && snapshottedImageCost > 0 ? snapshottedImageCost : Number(legacyImageCostBean);
    const capability = context.capability === 'image-translation' ? 'image-translation' : 'image-redraw';
    const billingChannel = context.billingChannel === 'own' ? 'own' : 'official';
    const billable = billingChannel === 'official';
    const name = context.taskName || `${capability === 'image-translation' ? 'AI图片翻译' : 'AI图片重绘'} · ${String(job.id).slice(-8)}`;
    const billingAttemptKey = context.billingAttemptKey || 'sku-image-ai:' + job.dedupeKey;
    const jobAttemptCount = Math.max(1, Number(job.attempts) || 1);
    const resumedPersistedPhase = jobAttemptCount > 1 && ['prompt_received', 'prompt_prepared', 'image_submitting', 'polling', 'result_received', 'result_downloading', 'candidate_stored', 'linked', 'settled'].includes(String(context.phase || ''));
    let diagnostic = mergeDiagnostic(context.diagnostic, {
      firstErrorCode: context.diagnostic?.firstErrorCode || context.diagnostic?.delivery?.errorCode || '',
      jobAttemptCount,
      retryCount: Math.max(Number(context.diagnostic?.retryCount) || 0, jobAttemptCount - 1),
      recoveryCount: Math.max(0, Number(context.diagnostic?.recoveryCount) || 0) + (resumedPersistedPhase ? 1 : 0),
      textCallCount: Math.max(0, Number(context.diagnostic?.textCallCount) || 0),
      imageSubmitCount: Math.max(0, Number(context.diagnostic?.imageSubmitCount) || 0),
      pollCount: Math.max(0, Number(context.diagnostic?.pollCount) || 0)
    });
    const checkpoint = async patch => { Object.assign(context, patch); if (patch.diagnostic) diagnostic = patch.diagnostic; return tools.checkpoint(patch); };
    const task = (value, label, reason) => authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: reason ? 'failed' : 'running', value, name, label, reason, article: context.productId, startedAt });
    const auditDiagnostic = (result, errorCode = '') => typeof authStore.recordAudit === 'function' ? authStore.recordAudit(actor, 'sku.image.ai.diagnostic', 'background_job', job.id, result, { errorCode, diagnostic }) : Promise.resolve();
    if (!actor || !actor.enabled || !authStore.hasPermission(actor, 'products.write')) {
      const error = Object.assign(new Error('当前账号无法登记为任务执行人，请重新登录后重试。'), { publicCode: 'background_job_actor_unavailable', retryable: false });
      const phase = String(context.phase || 'queued');
      const imageCallUnknown = !!context.providerTaskId || !!context.resultReference || Number(diagnostic.imageSubmitCount || 0) > 0
        || ['image_submitting', 'polling', 'result_received', 'result_downloading', 'candidate_stored', 'linked', 'settled'].includes(phase);
      if (billable && !imageCallUnknown && shouldReleaseSkuImageAiBeans(job, error)) {
        const releaseKey = billingAttemptKey + ':release';
        const released = await aiBeanStore.release(job.tenantId, { amount: imageCostBean, idempotencyKey: releaseKey, businessRef: job.id, reason: 'AI图片任务执行人不可用，失败退回', actorUserId: billingActorUserId });
        diagnostic = mergeDiagnostic(diagnostic, { endedAt: new Date().toISOString(), firstErrorCode: error.publicCode, billing: { ...(diagnostic.billing || {}), release: beanDiagnostic(released, releaseKey) } });
        await checkpoint({ diagnostic }).catch(() => {});
      }
      throw error;
    }
    const resolveImageConfiguration = () => billingChannel === 'own'
      ? aiConfigStore.available(actor, context.configurationId, [capability])
      : aiConfigStore.availableOfficial(actor, [capability]);
    let providerTaskId = context.providerTaskId, outcome = null, configuration, apiKey;
    try {
      if (billable && diagnostic.billing?.freeze?.state !== 'succeeded') {
        const freezeKey = billingAttemptKey + ':freeze';
        const before = typeof aiBeanStore.balance === 'function' ? await aiBeanStore.balance(actor.tenantId).catch(() => null) : null;
        try {
          const frozen = await aiBeanStore.freeze(actor.tenantId, { amount: imageCostBean, idempotencyKey: freezeKey, businessRef: job.id, reason: 'AI图片官方通道冻结', actorUserId: billingActorUserId });
          diagnostic = mergeDiagnostic(diagnostic, { billing: { ...(diagnostic.billing || {}), freeze: beanDiagnostic(frozen, freezeKey) } });
          await checkpoint({ diagnostic });
        } catch (error) {
          const after = typeof aiBeanStore.balance === 'function' ? await aiBeanStore.balance(actor.tenantId).catch(() => before) : before;
          diagnostic = mergeDiagnostic(diagnostic, { firstErrorCode: diagnostic.firstErrorCode || String(error.publicCode || 'ai_bean_freeze_failed'), billing: { ...(diagnostic.billing || {}), freeze: beanFailureDiagnostic(error, freezeKey, before, after) } });
          await checkpoint({ diagnostic }).catch(() => {});
          throw error;
        }
      }
      if (billingChannel === 'own') await authStore.requireAiEditEntitlement(actor);
      const scoped = { clientId: context.clientId, productId: context.productId, variantRef: context.variantRef, linkId: context.linkId || '', associationVersion: context.associationVersion == null ? null : Number(context.associationVersion), sourceKind: context.sourceKind || 'linked', sourceRef: context.sourceRef || '' };
      const deliveryPhase = ['candidate_stored', 'linked', 'settled'].includes(String(context.phase || ''));
      let source = null;
      if (!deliveryPhase) {
        if (scoped.sourceKind === 'platform_snapshot') {
          const temp = context.sourceObject || {};
          if (!temp.objectKey || !/^[a-f0-9]{64}$/i.test(String(temp.sha256 || '')) || Number(temp.sizeBytes) < 1 || !/^image\//.test(String(temp.mimeType || ''))) throw Object.assign(new Error('平台快照临时源图信息不完整，请重新发起AI任务。'), { publicCode: 'sku_image_ai_source_invalid', retryable: false });
          source = { private_object_key: String(temp.objectKey), sha256: String(temp.sha256), size_bytes: Number(temp.sizeBytes), mime_type: String(temp.mimeType) };
        } else source = await authStore.getSkuImageVersionSource(actor, scoped);
      }
      if (source && String(source.sha256) !== String(context.sourceHash)) throw Object.assign(new Error('该商品图片已变化，请刷新后重新编辑，避免使用错误原图。'), { publicCode: 'sku_image_version_conflict', retryable: false });
      if (!providerTaskId && !context.resultReference && !deliveryPhase) {
        const body = await privateObjectStore.readEncryptedBuffer(source.private_object_key);
        if (body.length !== Number(source.size_bytes) || crypto.createHash('sha256').update(body).digest('hex') !== source.sha256) throw Object.assign(new Error('原图完整性校验失败，请重新上传该图片。'), { publicCode: 'sku_image_source_integrity_failed', retryable: false });
        const referenceImages = [];
        if (capability === 'image-redraw') {
          for (const [index, reference] of (Array.isArray(context.referenceObjects) ? context.referenceObjects : []).slice(0, 7).entries()) {
            const objectKey = String(reference && reference.objectKey || ''), sha256 = String(reference && reference.sha256 || ''), sizeBytes = Number(reference && reference.sizeBytes), mimeType = String(reference && reference.mimeType || '');
            if (!objectKey || !/^[a-f0-9]{64}$/i.test(sha256) || !(sizeBytes > 0) || !/^image\//.test(mimeType)) throw Object.assign(new Error('第' + (index + 1) + '张组合参考图信息不完整，请重新发起AI重绘。'), { publicCode: 'sku_image_ai_reference_invalid', retryable: false });
            const referenceBody = await privateObjectStore.readEncryptedBuffer(objectKey);
            if (referenceBody.length !== sizeBytes || crypto.createHash('sha256').update(referenceBody).digest('hex') !== sha256) throw Object.assign(new Error('组合参考图完整性校验失败，请重新发起AI重绘。'), { publicCode: 'sku_image_ai_reference_integrity_failed', retryable: false });
            referenceImages.push('data:' + mimeType + ';base64,' + referenceBody.toString('base64'));
          }
        }
        let imagePrompt = '';
        if (capability === 'image-redraw') {
        const customizationAllowed = await authStore.canUseCustomConfigurations(actor);
        let forcedOfficialPrompt = null;
        if (!customizationAllowed) {
          forcedOfficialPrompt = await aiPromptStore.effective(actor, context.templateKey, { officialOnly: true });
          requireSkuImagePromptReady(forcedOfficialPrompt);
          if (digest(forcedOfficialPrompt) !== String(context.promptHash)) throw Object.assign(new Error('当前免费方案只能使用官方图片模板；该任务使用了自定义模板，请重新发起。'), { publicCode: 'membership_ai_template_official_only', status: 403, retryable: false });
        }
        let promptBody, sellingPoints;
        if (context.promptSnapshots?.template && context.promptSnapshots?.sellingPoints) {
          promptBody = (await skuImagePromptSnapshot.read(privateObjectStore, job.id, 'template', context.promptSnapshots.template)).content;
          sellingPoints = (await skuImagePromptSnapshot.read(privateObjectStore, job.id, 'selling_points', context.promptSnapshots.sellingPoints)).content;
        } else {
          promptBody = forcedOfficialPrompt || await aiPromptStore.effective(actor, context.templateKey);
          sellingPoints = context.sellingPoints;
        }
        requireSkuImagePromptReady(promptBody);
        if (skuImageAnalysisProof.digest(promptBody) !== String(context.promptHash)) throw Object.assign(new Error('提示词已被修改，请重新确认后再生成图片。'), { publicCode: 'sku_image_prompt_changed', retryable: false });
        const prepared = skuImageFinalPrompt.prepareInput(promptBody, sellingPoints, { imageTextLanguage: context.imageTextLanguage });
        imagePrompt = null;
        if (context.promptSnapshots?.finalPrompt) imagePrompt = (await skuImagePromptSnapshot.read(privateObjectStore, job.id, 'final_prompt', context.promptSnapshots.finalPrompt)).content;
        else if (context.finalPrompt) imagePrompt = context.finalPrompt;
        if (!imagePrompt) {
          let rawPrompt = null;
          if (context.promptSnapshots?.rawResponse) rawPrompt = (await skuImagePromptSnapshot.read(privateObjectStore, job.id, 'raw_response', context.promptSnapshots.rawResponse)).content;
          if (!rawPrompt && context.phase === 'prompt_preparing') throw Object.assign(new Error('提示词整理任务需恢复，请稍后重试或联系管理员处理。'), { publicCode: 'sku_image_prompt_preparing_recovery_required', retryable: false });
          if (!rawPrompt) {
            const textConfiguration = await aiConfigStore.availableOfficial(actor, ['selling-point-generation']);
            const textApiKey = aiConfig.decrypt(textConfiguration, credentialsKey);
            await task(15, '正在整理最终图片提示词');
            diagnostic = mergeDiagnostic(diagnostic, { textCallCount: diagnostic.textCallCount + 1, textCall: { state: 'started', startedAt: new Date().toISOString(), endedAt: '', configurationId: String(textConfiguration.id || 'unavailable'), protocol: String(textConfiguration.protocol || 'unavailable'), model: 'unavailable', errorCode: '' }, validation: { stage: 'text_call' } });
            await checkpoint({ phase: 'prompt_preparing', diagnostic });
            const providerDiagnostic = {};
            try {
              rawPrompt = await aiProvider.chat({ configuration: textConfiguration, apiKey: textApiKey, system: prepared.system, input: prepared.input, capabilities: ['selling-point-generation'], diagnostic: providerDiagnostic });
            } catch (error) {
              diagnostic = mergeDiagnostic(diagnostic, { textCall: { state: 'failed', endedAt: new Date().toISOString(), model: providerDiagnostic.actualModel || 'unavailable', errorCode: String(error.publicCode || error.message || 'ai_response_invalid') }, providerHttp: { state: providerDiagnostic.httpSucceeded ? 'succeeded' : 'failed', status: providerDiagnostic.httpStatus || 0, requestId: providerDiagnostic.providerRequestId || 'unavailable', errorCode: providerDiagnostic.errorCode || String(error.publicCode || error.message || 'ai_response_invalid') }, validation: { stage: 'text_provider', errorCode: String(error.publicCode || error.message || 'ai_response_invalid') } });
              await checkpoint({ diagnostic }).catch(() => {});
              throw error;
            }
            diagnostic = mergeDiagnostic(diagnostic, { textCall: { state: 'succeeded', endedAt: new Date().toISOString(), model: providerDiagnostic.actualModel || 'unavailable', errorCode: '' }, providerHttp: { state: 'succeeded', status: providerDiagnostic.httpStatus || 200, requestId: providerDiagnostic.providerRequestId || 'unavailable', errorCode: '' } });
            const rawResponse = await skuImagePromptSnapshot.save(privateObjectStore, actor.tenantId, job.id, 'raw_response', rawPrompt);
            const promptSnapshots = { ...(context.promptSnapshots || {}), rawResponse };
            await checkpoint({ phase: 'prompt_received', promptSnapshots, diagnostic });
          }
          try {
    const parsed = skuImageFinalPrompt.parseResponseDetailed(rawPrompt, promptBody, sellingPoints, { imageTextLanguage: context.imageTextLanguage });
            imagePrompt = parsed.prompt;
            diagnostic = mergeDiagnostic(diagnostic, parsed.diagnostic);
          } catch (error) {
            diagnostic = mergeDiagnostic(diagnostic, error.safeDiagnostic || {});
            diagnostic = mergeDiagnostic(diagnostic, { validation: { ...(diagnostic.validation || {}), errorCode: String(error.publicCode || error.message || 'sku_image_prompt_response_invalid') } });
            await checkpoint({ diagnostic }).catch(() => {});
            throw error;
          }
          const finalPromptSnapshot = await skuImagePromptSnapshot.save(privateObjectStore, actor.tenantId, job.id, 'final_prompt', imagePrompt);
          const promptSnapshots = { ...(context.promptSnapshots || {}), finalPrompt: finalPromptSnapshot };
          await checkpoint({ finalPrompt: null, finalPromptHash: skuImageAnalysisProof.digest(imagePrompt), promptSnapshots, phase: 'prompt_prepared', diagnostic });
        } else imagePrompt = skuImageFinalPrompt.validateFinalPrompt(imagePrompt);
        if (skuImageAnalysisProof.digest(imagePrompt) !== String(context.finalPromptHash || skuImageAnalysisProof.digest(imagePrompt))) throw Object.assign(new Error('提示词已被修改，请重新确认后再生成图片。'), { publicCode: 'sku_image_prompt_changed', retryable: false });
        }
        if (context.phase === 'image_submitting') {
          diagnostic = mergeDiagnostic(diagnostic, { imagePost: { state: 'unknown', endedAt: new Date().toISOString(), result: 'unknown', errorCode: 'sku_image_ai_recovery_required' } });
          await checkpoint({ diagnostic }).catch(() => {});
          throw Object.assign(new Error('AI生图任务状态需人工恢复，请稍后在任务中心重试或联系管理员。'), { publicCode: 'sku_image_ai_recovery_required', retryable: false });
        }
        configuration = await resolveImageConfiguration();
        apiKey = aiConfig.decrypt(configuration, credentialsKey);
        await task(20, billingChannel === 'own' ? '正在使用自己的密钥提交图片任务' : '正在提交官方图片任务');
        const imageStartedAt = new Date().toISOString();
        diagnostic = mergeDiagnostic(diagnostic, { imageSubmitCount: diagnostic.imageSubmitCount + 1, imagePost: { state: 'starting_unknown', startedAt: imageStartedAt, endedAt: '', configurationId: String(configuration.id || 'unavailable'), protocol: String(configuration.protocol || 'unavailable'), model: 'unavailable', httpStatus: 0, providerRequestId: 'unavailable', providerTaskId: 'unavailable', result: '', errorCode: '', attemptCount: Number(diagnostic.imagePost?.attemptCount || 0) + 1 }, validation: { stage: 'image_submit' } });
        await checkpoint({ phase: 'image_submitting', diagnostic });
        const imageProviderDiagnostic = {};
        let submitted;
        try {
          submitted = await aiProvider.submitImage({ configuration, apiKey, timeoutMs: submitTimeoutMs, input: { capability, image: `data:${source.mime_type};base64,${body.toString('base64')}`, referenceImages, prompt: imagePrompt, sourceLanguage: context.sourceLanguage, targetLanguage: context.targetLanguage }, diagnostic: imageProviderDiagnostic });
          if (!submitted.taskId && !submitted.resultUrl) throw Object.assign(new Error('AI图片服务没有返回可追踪任务号或候选图，本次任务已停止，请稍后重新发起。'), { publicCode: 'sku_image_ai_provider_task_missing', retryable: false });
        } catch (error) {
          const knownFailure = Number(imageProviderDiagnostic.httpStatus) > 0;
          diagnostic = mergeDiagnostic(diagnostic, { imagePost: { state: knownFailure ? 'failed' : 'unknown', endedAt: new Date().toISOString(), model: imageProviderDiagnostic.actualModel || 'unavailable', httpStatus: imageProviderDiagnostic.httpStatus || 0, providerRequestId: imageProviderDiagnostic.providerRequestId || 'unavailable', result: knownFailure ? 'failed' : 'unknown', errorCode: String(error.publicCode || error.message || 'sku_image_ai_provider_failed') } });
          await checkpoint({ diagnostic }).catch(() => {});
          throw error;
        }
        providerTaskId = submitted.taskId || null;
        const directResult = Boolean(submitted.resultUrl);
        diagnostic = mergeDiagnostic(diagnostic, { imagePost: { state: directResult ? 'succeeded' : 'submitted', endedAt: new Date().toISOString(), model: imageProviderDiagnostic.actualModel || submitted.model || 'unavailable', httpStatus: imageProviderDiagnostic.httpStatus || submitted.httpStatus || 200, providerRequestId: imageProviderDiagnostic.providerRequestId || String(providerTaskId || 'unavailable'), providerTaskId: String(providerTaskId || 'unavailable'), responseState: submitted.state || 'submitted', hasResultUrl: Boolean(submitted.resultUrl), branch: directResult ? 'direct_result' : 'poll_result', result: submitted.state || 'submitted', errorCode: '' } });
        outcome = directResult ? submitted : null;
        const resultReference = directResult ? await skuImageResultReference.save(privateObjectStore, actor.tenantId, job.id, providerTaskId, submitted.resultUrl) : null;
        await checkpoint({ providerTaskId, resultReference, phase: directResult ? 'result_received' : 'polling', diagnostic });
      }
      if (!outcome && context.resultReference && ['result_received', 'result_downloading'].includes(context.phase)) {
        const recovered = await skuImageResultReference.read(privateObjectStore, job.id, providerTaskId, context.resultReference);
        outcome = { state: 'succeeded', taskId: providerTaskId, resultUrl: recovered.resultUrl };
      }
      if (!outcome && ['result_received', 'result_downloading'].includes(context.phase)) throw Object.assign(new Error('AI生图任务状态需人工恢复，请稍后在任务中心重试或联系管理员。'), { publicCode: 'sku_image_ai_recovery_required', retryable: false });
      if (!outcome && !deliveryPhase) {
        configuration = configuration || await resolveImageConfiguration();
        apiKey = apiKey || aiConfig.decrypt(configuration, credentialsKey);
        const pollingStartedAt = nowMs();
        if (!diagnostic.polling?.startedAt) {
          diagnostic = mergeDiagnostic(diagnostic, { polling: { state: 'running', startedAt: new Date(pollingStartedAt).toISOString(), endedAt: '', timedOutAt: '', finalState: '', callCount: Number(diagnostic.polling?.callCount || 0), trace: diagnostic.polling?.trace || [] } });
          await checkpoint({ phase: 'polling', diagnostic });
        }
        while (true) {
        await task(60, '正在等待官方图片生成');
        const polledAt = new Date().toISOString(), pollDiagnostic = {};
        try {
          outcome = await aiProvider.pollImage({ configuration, apiKey, taskId: providerTaskId, diagnostic: pollDiagnostic });
          const trace = pollTrace(diagnostic.polling, { at: polledAt, httpStatus: pollDiagnostic.httpStatus || outcome.httpStatus || 200, requestId: pollDiagnostic.providerRequestId || 'unavailable', state: outcome.state || 'unknown', progress: Number(outcome.progress) || 0, errorCode: '' });
          diagnostic = mergeDiagnostic(diagnostic, { pollCount: diagnostic.pollCount + 1, polling: { state: outcome.state === 'succeeded' ? 'succeeded' : outcome.state === 'failed' ? 'failed' : 'running', endedAt: outcome.state === 'succeeded' || outcome.state === 'failed' ? new Date().toISOString() : '', finalState: outcome.state || 'unknown', callCount: Number(diagnostic.polling?.callCount || 0) + 1, trace } });
          if (outcome.state === 'succeeded' && outcome.resultUrl) {
            const resultReference = await skuImageResultReference.save(privateObjectStore, actor.tenantId, job.id, providerTaskId, outcome.resultUrl);
            await checkpoint({ phase: 'result_received', resultReference, diagnostic });
          } else await checkpoint({ phase: 'polling', diagnostic });
        } catch (error) {
          const errorCode = String(error.publicCode || error.message || 'ai_image_poll_failed');
          const propagating = errorCode === 'ai_image_result_not_found' && skuImagePolling.resultNotFoundIsPropagating(pollingStartedAt, nowMs(), pollNotFoundGraceMs);
          const trace = pollTrace(diagnostic.polling, { at: polledAt, httpStatus: pollDiagnostic.httpStatus || 0, requestId: pollDiagnostic.providerRequestId || 'unavailable', state: propagating ? 'propagating' : pollDiagnostic.httpStatus ? 'failed' : 'unknown', progress: 0, errorCode });
          diagnostic = mergeDiagnostic(diagnostic, { pollCount: diagnostic.pollCount + 1, polling: { state: propagating ? 'running' : pollDiagnostic.httpStatus ? 'failed' : 'unknown', endedAt: propagating ? '' : new Date().toISOString(), finalState: propagating ? 'propagating' : pollDiagnostic.httpStatus ? 'failed' : 'unknown', callCount: Number(diagnostic.polling?.callCount || 0) + 1, trace } });
          await checkpoint({ phase: 'polling', diagnostic }).catch(() => {});
          if (!propagating) throw error;
          const propagationWaitMs = skuImagePolling.nextWaitMs(pollingStartedAt, nowMs(), pollTotalWaitMs, pollIntervalMs);
          if (propagationWaitMs === null) break;
          await wait(propagationWaitMs);
          continue;
        }
        if (outcome.state === 'succeeded' || outcome.state === 'failed') break;
        const waitMs = skuImagePolling.nextWaitMs(pollingStartedAt, nowMs(), pollTotalWaitMs, pollIntervalMs);
        if (waitMs === null) {
          const timedOutAt = new Date().toISOString();
          diagnostic = mergeDiagnostic(diagnostic, { polling: { state: 'timed_out', endedAt: timedOutAt, timedOutAt, finalState: 'timed_out' } });
          await checkpoint({ phase: 'polling', diagnostic });
          break;
        }
        await wait(waitMs);
        }
      }
      if (!deliveryPhase && (!outcome || outcome.state !== 'succeeded')) throw Object.assign(new Error(outcome && outcome.state === 'failed' ? 'sku_image_ai_provider_failed' : 'sku_image_ai_recovery_required'), { publicCode: outcome && outcome.state === 'failed' ? 'sku_image_ai_provider_failed' : 'sku_image_ai_recovery_required', retryable: false });
      const deliveryBranch = diagnostic.imagePost?.branch === 'direct_result' ? 'direct_result' : 'poll_result';
      let candidateStored = context.candidateStored, candidate = context.linkedCandidate;
      if (!candidateStored) {
        await task(85, '正在下载并保存生成图片');
        diagnostic = mergeDiagnostic(diagnostic, { delivery: { branch: deliveryBranch, downloadState: 'running', storeState: 'not_started', candidateState: 'not_started', settleState: 'not_started', errorCode: '' } });
        await checkpoint({ phase: 'result_downloading', diagnostic });
        let downloaded, processed, stored;
        const resultDns = {};
        try {
          downloaded = await aiProvider.downloadImage(outcome.resultUrl, { diagnostic: resultDns });
          processed = await skuImageUpload.processImage({ body: downloaded.buffer, contentType: downloaded.mime, name: 'candidate.' + downloaded.extension });
          diagnostic = mergeDiagnostic(diagnostic, { resultDns, delivery: { downloadState: 'succeeded' } });
          await checkpoint({ diagnostic });
        } catch (error) {
          const code = String(error.publicCode || 'sku_image_download_failed');
          diagnostic = mergeDiagnostic(diagnostic, { firstErrorCode: diagnostic.firstErrorCode || code, resultDns: error.safeDiagnostic || resultDns, delivery: { downloadState: 'failed', errorCode: code } });
          await checkpoint({ diagnostic }).catch(() => {});
          throw error;
        }
        try {
          diagnostic = mergeDiagnostic(diagnostic, { delivery: { storeState: 'running' } });
          await checkpoint({ diagnostic });
          stored = await privateObjectStore.putEncryptedBuffer({ tenantId: actor.tenantId, kind: 'sku_image_candidate', body: processed.body });
          candidateStored = { objectKey: stored.objectKey, sha256: processed.sha256 || stored.sha256, mimeType: processed.mimeType, extension: processed.extension, sizeBytes: processed.sizeBytes || stored.size, width: processed.width, height: processed.height, candidateId: stableUuid(job.id + ':candidate'), resultLinkId: stableUuid(job.id + ':link') };
          diagnostic = mergeDiagnostic(diagnostic, { delivery: { storeState: 'succeeded' } });
          await checkpoint({ phase: 'candidate_stored', candidateStored, diagnostic });
        } catch (error) {
          const code = String(error.publicCode || 'sku_image_store_failed');
          diagnostic = mergeDiagnostic(diagnostic, { firstErrorCode: diagnostic.firstErrorCode || code, delivery: { storeState: 'failed', errorCode: code } });
          await checkpoint({ diagnostic }).catch(() => {});
          throw error;
        }
      }
      if (context.resultReference) {
        await skuImageResultReference.remove(privateObjectStore, context.resultReference);
        await checkpoint({ resultReference: null });
      }
      if (!candidate) {
        const completedAt = new Date().toISOString();
        try {
          configuration = configuration || await resolveImageConfiguration();
          diagnostic = mergeDiagnostic(diagnostic, { delivery: { candidateState: 'running' } });
          await checkpoint({ diagnostic });
          const recorded = await authStore.saveSkuImageCandidate(actor, { ...scoped, ...candidateStored, id: candidateStored.candidateId, capability, processingSummary: { capability, jobId: job.id, providerTaskId: providerTaskId ? crypto.createHash('sha256').update(String(providerTaskId)).digest('hex').slice(0, 16) : 'unavailable', model: configuration.model, promptHash: capability === 'image-redraw' ? context.finalPromptHash : '', sellingPointResultHash: capability === 'image-redraw' ? context.sellingPointResultHash : '', imageTextLanguage: capability === 'image-redraw' ? String(context.imageTextLanguage || '') : '', templateKey: capability === 'image-redraw' ? context.templateKey : '', sourceLanguage: capability === 'image-translation' ? context.sourceLanguage : '', targetLanguage: capability === 'image-translation' ? context.targetLanguage : '', billingChannel, completedAt } });
          candidate = { id: String(recorded.candidateId || candidateStored.candidateId), candidateId: String(recorded.candidateId || candidateStored.candidateId), linkId: String(scoped.linkId), url: recorded.url || `/api/private-objects/sku-images/${recorded.candidateId || candidateStored.candidateId}`, width: recorded.width || candidateStored.width, height: recorded.height || candidateStored.height, sourceType: 'ai_candidate', mainImageSorted: false };
          diagnostic = mergeDiagnostic(diagnostic, { delivery: { candidateState: 'succeeded' } });
          await checkpoint({ phase: 'linked', linkedCandidate: candidate, diagnostic });
        } catch (error) {
          const code = String(error.publicCode || 'sku_image_candidate_failed');
          diagnostic = mergeDiagnostic(diagnostic, { firstErrorCode: diagnostic.firstErrorCode || code, delivery: { candidateState: 'failed', errorCode: code } });
          await checkpoint({ diagnostic }).catch(() => {});
          throw error;
        }
      }
      const settleKey = billingAttemptKey + ':settle';
      if (context.phase !== 'settled') {
        if (!billable) {
          diagnostic = mergeDiagnostic(diagnostic, { endedAt: new Date().toISOString(), delivery: { settleState: 'not_applicable', errorCode: '' }, billing: { ...(diagnostic.billing || {}), settle: { state: 'not_applicable', keyHash: '', replayed: false, errorCode: '', balanceBefore: null, frozenBefore: null, balanceAfter: null, frozenAfter: null } } });
          await checkpoint({ phase: 'settled', diagnostic });
        } else {
          const settleBefore = typeof aiBeanStore.balance === 'function' ? await aiBeanStore.balance(actor.tenantId).catch(() => null) : null;
          let settled;
          try {
            diagnostic = mergeDiagnostic(diagnostic, { delivery: { settleState: 'running' } });
            await checkpoint({ diagnostic });
            settled = await aiBeanStore.settle(actor.tenantId, { amount: imageCostBean, idempotencyKey: settleKey, businessRef: job.id, reason: 'AI图片官方通道结算', actorUserId: billingActorUserId });
          } catch (error) {
            const code = String(error.publicCode || 'ai_bean_settle_failed');
            const settleAfter = typeof aiBeanStore.balance === 'function' ? await aiBeanStore.balance(actor.tenantId).catch(() => settleBefore) : settleBefore;
            diagnostic = mergeDiagnostic(diagnostic, { firstErrorCode: diagnostic.firstErrorCode || code, delivery: { settleState: 'failed', errorCode: code }, billing: { ...(diagnostic.billing || {}), settle: beanFailureDiagnostic(error, settleKey, settleBefore, settleAfter) } });
            await checkpoint({ diagnostic }).catch(() => {});
            throw error;
          }
          diagnostic = mergeDiagnostic(diagnostic, { endedAt: new Date().toISOString(), delivery: { settleState: 'succeeded', errorCode: '' }, billing: { ...(diagnostic.billing || {}), settle: beanDiagnostic(settled, settleKey) } });
          await checkpoint({ phase: 'settled', diagnostic });
        }
      }
      await auditDiagnostic('success');
      await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'done', value: 100, name, label: 'AI图片候选已生成，请到AI生图记录查看并采用', article: context.productId, startedAt });
      return candidate;
    } catch (error) {
      const handledError = /ai_timeout/i.test(String(error.publicCode || error.message)) && !providerTaskId ? Object.assign(new Error('AI生图任务状态需人工恢复，请稍后在任务中心重试或联系管理员。'), { publicCode: 'sku_image_ai_recovery_required', retryable: false }) : error;
      const currentErrorCode = String(handledError.publicCode || handledError.message || 'background_job_failed');
      const priorFirstErrorCode = diagnostic.firstErrorCode;
      diagnostic = mergeDiagnostic(diagnostic, { endedAt: new Date().toISOString(), firstErrorCode: diagnostic.firstErrorCode || currentErrorCode, validation: { ...(diagnostic.validation || {}), errorCode: currentErrorCode } });
      const failure = priorFirstErrorCode && priorFirstErrorCode !== currentErrorCode ? skuImageAiFailureText({ publicCode: priorFirstErrorCode, message: priorFirstErrorCode }) : skuImageAiFailureText(handledError);
      await checkpoint({ diagnostic }).catch(() => {});
      if (billable && diagnostic.billing?.freeze?.state === 'succeeded' && shouldReleaseSkuImageAiBeans(job, handledError)) {
        const releaseKey = billingAttemptKey + ':release';
        const releaseBefore = typeof aiBeanStore.balance === 'function' ? await aiBeanStore.balance(actor.tenantId).catch(() => null) : null;
        try {
          const released = await aiBeanStore.release(actor.tenantId, { amount: imageCostBean, idempotencyKey: releaseKey, businessRef: job.id, reason: 'AI图片任务最终失败退回', actorUserId: billingActorUserId });
          diagnostic = mergeDiagnostic(diagnostic, { billing: { ...(diagnostic.billing || {}), release: beanDiagnostic(released, releaseKey) } });
          await checkpoint({ diagnostic }).catch(() => {});
        } catch (releaseError) {
          const releaseAfter = typeof aiBeanStore.balance === 'function' ? await aiBeanStore.balance(actor.tenantId).catch(() => releaseBefore) : releaseBefore;
          diagnostic = mergeDiagnostic(diagnostic, { billing: { ...(diagnostic.billing || {}), release: beanFailureDiagnostic(releaseError, releaseKey, releaseBefore, releaseAfter) } });
          await checkpoint({ diagnostic }).catch(() => {});
        }
      }
      await auditDiagnostic('failed', String(handledError.publicCode || handledError.message || 'background_job_failed')).catch(() => {});
      await task(0, failure.label, failure.reason).catch(() => {});
      throw handledError;
    }
  };
}

module.exports = { createSkuImageAiWorker, shouldReleaseSkuImageAiBeans, requireSkuImagePromptReady, skuImageAiFailureText };
