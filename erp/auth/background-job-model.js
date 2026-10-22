'use strict';
const clientOrderSync = require('./client-order-sync');

const JOB_TYPES = new Set([
  'bug_email',
  'category_attributes',
  'orders_sync',
  'products_sync',
  'shops_sync',
  'sku_image_ai',
  'sku_image_ai_batch',
  'product_video_compose'
]);

const SECRET_KEY = /(api[_-]?key|authorization|cookie|password|secret|token)/i;

function text(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function containsSecret(value, seen = new Set(), path = []) {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return true;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => containsSecret(item, seen, [...path, '*']));
  return Object.entries(value).some(([key, item]) => {
    const itemPath = [...path, key];
    const safeDiagnosticToken = itemPath.slice(-4).join('.') === 'diagnostic.unitDecisions.*.modelToken';
    return !safeDiagnosticToken && SECRET_KEY.test(key) || containsSecret(item, seen, itemPath);
  });
}

function skuImageDiagnostic(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const response = source.response && typeof source.response === 'object' ? source.response : {};
  const validation = source.validation && typeof source.validation === 'object' ? source.validation : {};
  const rendered = source.rendered && typeof source.rendered === 'object' ? source.rendered : {};
  const providerHttp = source.providerHttp && typeof source.providerHttp === 'object' ? source.providerHttp : {};
  const textCall = source.textCall && typeof source.textCall === 'object' ? source.textCall : {};
  const imagePost = source.imagePost && typeof source.imagePost === 'object' ? source.imagePost : {};
  const polling = source.polling && typeof source.polling === 'object' ? source.polling : {};
  const delivery = source.delivery && typeof source.delivery === 'object' ? source.delivery : {};
  const resultDns = source.resultDns && typeof source.resultDns === 'object' ? source.resultDns : {};
  const billing = source.billing && typeof source.billing === 'object' ? source.billing : {};
  const fieldNames = [...REQUIRED_SKU_IMAGE_FIELDS, ...OPTIONAL_SKU_IMAGE_FIELDS];
  const fieldNumbers = {};
  for (const field of fieldNames) fieldNumbers[field] = (Array.isArray(source.fieldNumbers?.[field]) ? source.fieldNumbers[field] : []).map(item => text(item, 40)).filter(Boolean).slice(0, 20);
  const unitDecisions = (Array.isArray(source.unitDecisions) ? source.unitDecisions : []).map(item => ({ field: text(item?.field, 60), modelToken: text(item?.modelToken, 40), numberValue: text(item?.numberValue, 40), strictUnit: item?.strictUnit === true, action: text(item?.action, 60), reason: text(item?.reason, 120) })).filter(item => item.field && item.modelToken && item.action).slice(0, 20);
  const billingResult = name => {
    const item = billing[name] && typeof billing[name] === 'object' ? billing[name] : {};
    const wallet = field => item[field] !== null && item[field] !== undefined && item[field] !== '' && Number.isSafeInteger(Number(item[field])) ? Number(item[field]) : null;
    return { state: text(item.state, 30) || 'not_started', keyHash: text(item.keyHash, 64), replayed: item.replayed === true, errorCode: text(item.errorCode, 120), balanceBefore: wallet('balanceBefore'), frozenBefore: wallet('frozenBefore'), balanceAfter: wallet('balanceAfter'), frozenAfter: wallet('frozenAfter') };
  };
  const count = (item, max = 1000000) => Math.max(0, Math.min(max, Math.floor(Number(item) || 0)));
  const pollTrace = (Array.isArray(polling.trace) ? polling.trace : []).map(item => ({
    at: text(item?.at, 40), httpStatus: Math.max(0, Math.min(999, Math.floor(Number(item?.httpStatus) || 0))), requestId: text(item?.requestId, 180) || 'unavailable', state: text(item?.state, 30) || 'unknown', progress: Math.max(0, Math.min(100, Math.floor(Number(item?.progress) || 0))), errorCode: text(item?.errorCode, 120)
  })).slice(-96);
  return {
    taskId: text(source.taskId, 120), businessRef: text(source.businessRef, 160), tenantId: text(source.tenantId, 40), actorUserId: text(source.actorUserId, 40), startedAt: text(source.startedAt, 40), endedAt: text(source.endedAt, 40), firstErrorCode: text(source.firstErrorCode, 120),
    jobAttemptCount: count(source.jobAttemptCount, 100), retryCount: count(source.retryCount, 100), recoveryCount: count(source.recoveryCount, 100), textCallCount: count(source.textCallCount, 100), imageSubmitCount: count(source.imageSubmitCount, 100), pollCount: count(source.pollCount, 10000),
    textCall: { state: text(textCall.state, 30) || 'not_started', startedAt: text(textCall.startedAt, 40), endedAt: text(textCall.endedAt, 40), configurationId: text(textCall.configurationId, 64), protocol: text(textCall.protocol, 60), model: text(textCall.model, 120), errorCode: text(textCall.errorCode, 120) },
    providerHttp: { state: text(providerHttp.state, 30) || 'not_started', status: Math.max(0, Math.min(999, Math.floor(Number(providerHttp.status) || 0))), requestId: text(providerHttp.requestId, 180) || 'unavailable', errorCode: text(providerHttp.errorCode, 120) },
    response: { sha256: text(response.sha256, 64), chars: Math.max(0, Math.min(1000000, Math.floor(Number(response.chars) || 0))), jsonFields: (Array.isArray(response.jsonFields) ? response.jsonFields : []).map(item => ({ name: text(item?.name, 60), type: text(item?.type, 20) })).filter(item => item.name).slice(0, 20) },
    fieldNumbers,
    unitDecisions,
    validation: { stage: text(validation.stage, 60), field: text(validation.field, 60), invalidNumber: text(validation.invalidNumber, 40), errorCode: text(validation.errorCode, 120) },
    rendered: { sha256: text(rendered.sha256, 64), chars: Math.max(0, Math.min(1000000, Math.floor(Number(rendered.chars) || 0))) },
    imagePost: { state: text(imagePost.state, 30) || 'not_started', startedAt: text(imagePost.startedAt, 40), endedAt: text(imagePost.endedAt, 40), configurationId: text(imagePost.configurationId, 64), protocol: text(imagePost.protocol, 60), model: text(imagePost.model, 120), httpStatus: Math.max(0, Math.min(999, Math.floor(Number(imagePost.httpStatus) || 0))), providerRequestId: text(imagePost.providerRequestId, 180) || 'unavailable', providerTaskId: text(imagePost.providerTaskId, 180) || 'unavailable', responseState: text(imagePost.responseState, 40), hasResultUrl: imagePost.hasResultUrl === true, branch: text(imagePost.branch, 40), result: text(imagePost.result, 40), errorCode: text(imagePost.errorCode, 120), attemptCount: count(imagePost.attemptCount, 100) },
    polling: { state: text(polling.state, 30) || 'not_started', startedAt: text(polling.startedAt, 40), endedAt: text(polling.endedAt, 40), timedOutAt: text(polling.timedOutAt, 40), callCount: count(polling.callCount, 10000), finalState: text(polling.finalState, 40), trace: pollTrace },
    resultDns: { stage: text(resultDns.stage, 60), hostname: text(resultDns.hostname, 253), addressClasses: (Array.isArray(resultDns.addressClasses) ? resultDns.addressClasses : []).map(item => text(item, 40)).filter(Boolean).slice(0, 8) },
    delivery: { branch: text(delivery.branch, 40), downloadState: text(delivery.downloadState, 30) || 'not_started', storeState: text(delivery.storeState, 30) || 'not_started', candidateState: text(delivery.candidateState, 30) || 'not_started', settleState: text(delivery.settleState, 30) || 'not_started', errorCode: text(delivery.errorCode, 120) },
    billing: { amount: Math.max(0, Math.floor(Number(billing.amount) || 0)), unit: text(billing.unit, 20) || 'AI豆', freeze: billingResult('freeze'), release: billingResult('release'), settle: billingResult('settle') },
  };
}

function promptSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const objectKey = text(source.objectKey, 240), sha256 = text(source.sha256, 64), contentHash = text(source.contentHash, 64), type = text(source.type, 30), size = Math.max(0, Math.floor(Number(source.size) || 0)), chars = Math.max(0, Math.floor(Number(source.chars) || 0));
  if (!objectKey) return null;
  if (!/^\d+\/sku_image_prompt_snapshot\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/i.test(objectKey) || !/^[0-9a-f]{64}$/i.test(sha256) || !/^[0-9a-f]{64}$/i.test(contentHash) || !['template','selling_points','raw_response','final_prompt'].includes(type) || size < 1 || size > 30000 || chars < 1 || chars > 12000) throw Object.assign(new Error('提示词快照数据不完整，任务无法继续，请重新生成提示词后再试。'), { publicCode: 'background_job_prompt_snapshot_invalid' });
  return { objectKey, sha256, contentHash, type, size, chars, version: Math.max(1, Math.min(10, Math.floor(Number(source.version) || 1))), createdAt: text(source.createdAt, 40) };
}

function resultReference(value) {
  if (!value) return null;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const objectKey = text(source.objectKey, 240), sha256 = text(source.sha256, 64), urlHash = text(source.urlHash, 64), size = Math.max(0, Math.floor(Number(source.size) || 0));
  if (!/^\d+\/sku_image_result_reference\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/i.test(objectKey) || !/^[0-9a-f]{64}$/i.test(sha256) || !/^[0-9a-f]{64}$/i.test(urlHash) || size < 1 || size > 20000 || isNaN(new Date(source.expiresAt).getTime())) throw Object.assign(new Error('任务结果引用数据不完整，请重新发起一次任务。'), { publicCode: 'background_job_result_reference_invalid' });
  return { version: 1, objectKey, sha256, urlHash, size, createdAt: text(source.createdAt, 40), expiresAt: text(source.expiresAt, 40) };
}

function candidateStored(value) {
  if (!value) return null;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const objectKey = text(source.objectKey, 240), sha256 = text(source.sha256, 64), candidateId = text(source.candidateId, 64), resultLinkId = text(source.resultLinkId, 64);
  const sizeBytes = Math.max(0, Math.floor(Number(source.sizeBytes) || 0)), width = Math.max(0, Math.floor(Number(source.width) || 0)), height = Math.max(0, Math.floor(Number(source.height) || 0));
  const mimeType = text(source.mimeType, 40), extension = text(source.extension, 12);
  if (!/^\d+\/sku_image_candidate\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/i.test(objectKey) || !/^[0-9a-f]{64}$/i.test(sha256) || !/^[0-9a-f-]{36}$/i.test(candidateId) || !/^[0-9a-f-]{36}$/i.test(resultLinkId) || !['image/png','image/jpeg','image/webp'].includes(mimeType) || !/^\.?[a-z0-9]{2,5}$/i.test(extension) || sizeBytes < 1 || width < 1 || height < 1) throw Object.assign(new Error('候选图片检查点数据不完整，任务无法继续，请重新发起一次。'), { publicCode: 'background_job_candidate_checkpoint_invalid' });
  return { objectKey, sha256, candidateId, resultLinkId, mimeType, extension, sizeBytes, width, height };
}

function linkedCandidate(value) {
  if (!value) return null;
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const candidateId = text(source.candidateId || source.id, 64), linkId = text(source.linkId, 64), url = text(source.url, 240);
  if (!/^[0-9a-f-]{36}$/i.test(candidateId) || !/^[0-9a-f-]{36}$/i.test(linkId) || !/^\/api\/private-objects\/sku-images\/[0-9a-f-]{36}$/i.test(url)) throw Object.assign(new Error('图片关联检查点数据不完整，任务无法继续，请重新发起一次。'), { publicCode: 'background_job_link_checkpoint_invalid' });
  return { id: candidateId, candidateId, linkId, url, width: Math.max(0, Math.floor(Number(source.width) || 0)), height: Math.max(0, Math.floor(Number(source.height) || 0)), sourceType: 'ai_candidate', mainImageSorted: source.mainImageSorted === true };
}

const REQUIRED_SKU_IMAGE_FIELDS = Object.freeze(['mainTitle', 'background', 'backgroundColor', 'accentColor', 'displayMode', 'secondaryStyle']);
const OPTIONAL_SKU_IMAGE_FIELDS = Object.freeze(['secondaryText', 'icons', 'colorMaterial']);

function normalizeContext(type, value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (containsSecret(source)) throw Object.assign(new Error('任务数据不允许包含密钥内容，请移除后重新提交。'), { publicCode: 'background_job_secret_forbidden' });
  if (type === 'bug_email') {
    const reportId = text(source.reportId, 120);
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(reportId)) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    return { reportId };
  }
  const clientId = text(source.clientId, 120);
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(clientId)) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
  if (type === 'sku_image_ai_batch') return { clientId };
  if (type === 'category_attributes') return { clientId, force: source.force === true };
  if (type === 'shops_sync') {
    const kind = text(source.kind, 20);
    if (!['limit', 'warehouse'].includes(kind)) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    return { clientId, kind };
  }
  if (type === 'products_sync') {
    const mode = source.mode === 'selected' ? 'selected' : 'all';
    const productIds = [...new Set((Array.isArray(source.productIds) ? source.productIds : []).map(item => text(item, 80)).filter(Boolean))].slice(0, 1000);
    if (mode === 'selected' && !productIds.length) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    const runId = text(source.runId, 120);
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(runId)) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    return { clientId, mode, productIds, runId };
  }
  if (type === 'orders_sync') {
    const mode = source.mode === 'selected' ? 'selected' : 'all';
    const postingNumbers = [...new Set((Array.isArray(source.postingNumbers) ? source.postingNumbers : []).map(item => text(item, 180)).filter(Boolean))].slice(0, 1000);
    if (mode === 'selected' && !postingNumbers.length) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    const runId = text(source.runId, 120);
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(runId)) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    const rangeEnd = text(source.rangeEnd, 30);
    if (mode === 'all' && isNaN(new Date(rangeEnd).getTime())) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    const since = text(source.since, 30);
    const sourceName = text(source.source, 40);
    if (sourceName !== 'manual_server_fallback' || mode === 'all' && (isNaN(new Date(since).getTime()) || new Date(since) >= new Date(rangeEnd))) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    const windowCount = mode === 'all' ? clientOrderSync.windowCountForRange(since, rangeEnd) : 1;
    return { source: sourceName, clientId, mode, postingNumbers, runId, rangeEnd, since, windowCount, windowIndex: Math.max(0, Math.min(windowCount - 1, Math.floor(Number(source.windowIndex) || 0))), offset: Math.max(0, Math.min(1000, Math.floor(Number(source.offset) || 0))) };
  }
  if (type === 'product_video_compose') {
    const productId = text(source.productId, 120), variantRef = text(source.variantRef, 180);
    const imageObjectIds = [...new Set((Array.isArray(source.imageObjectIds) ? source.imageObjectIds : []).map(item => text(item, 64)).filter(Boolean))];
    const rawSources = Array.isArray(source.imageSources) ? source.imageSources : [];
    const imageSources = rawSources.slice(0, 8).map(item => {
      const entry = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      const objectId = text(entry.objectId, 64), url = text(entry.url, 2048);
      if (objectId && /^[0-9a-f-]{36}$/i.test(objectId)) return { kind: 'object', objectId };
      if (/^https:\/\//i.test(url) || /^\/api\/private-objects\/sku-images\/[0-9a-f-]{36}(?:[?#].*)?$/i.test(url)) return { kind: 'url', url };
      throw Object.assign(new Error('视频合成图片来源不完整，请重新选择图片。'), { publicCode: 'background_job_context_invalid' });
    });
    const durationSeconds = Math.floor(Number(source.durationSeconds) || 0);
    const transition = source.transition === 'fade' ? 'fade' : 'cut';
    const motion = source.motion === true;
    const phase = text(source.phase, 24) || 'queued';
    const result = source.result && typeof source.result === 'object' && !Array.isArray(source.result) ? source.result : null;
    const sourceCount = imageSources.length || imageObjectIds.length;
    if (!/^(?:\d+|draft_[\w-]+|session_[\w-]+)$/.test(productId) || !/^[A-Za-z0-9._:-]{1,180}$/.test(variantRef) || sourceCount < 2 || sourceCount > 8 || imageObjectIds.some(id => !/^[0-9a-f-]{36}$/i.test(id)) || durationSeconds < 8 || durationSeconds > 20 || !['queued','processing','stored','failed'].includes(phase)) {
      throw Object.assign(new Error('视频合成任务参数不完整，请重新选择图片后再生成。'), { publicCode: 'background_job_context_invalid' });
    }
    let normalizedResult = null;
    if (result) {
      const videoId = text(result.videoId, 64), objectKey = text(result.objectKey, 240), sha256 = text(result.sha256, 64), sizeBytes = Math.max(0, Math.floor(Number(result.sizeBytes) || 0));
      const width = Math.max(2, Math.floor(Number(result.width) || 0)), height = Math.max(2, Math.floor(Number(result.height) || 0)), fps = Math.max(1, Math.floor(Number(result.fps) || 0));
      if (!/^[0-9a-f-]{36}$/i.test(videoId) || !/^\d+\/product_video_compose\/[0-9a-f]{2}\/[0-9a-f]{64}\.enc$/i.test(objectKey) || !/^[0-9a-f]{64}$/i.test(sha256) || sizeBytes < 1 || sizeBytes > 100 * 1024 * 1024 || width > 2160 || height > 2880 || fps > 60) {
        throw Object.assign(new Error('视频合成结果引用不完整，请重新生成。'), { publicCode: 'background_job_context_invalid' });
      }
      normalizedResult = { videoId, objectKey, sha256, sizeBytes, mimeType: 'video/mp4', durationSeconds, width, height, fps };
    }
    return { clientId, productId, variantRef, imageObjectIds, imageSources, durationSeconds, transition, motion, phase, result: normalizedResult };
  }
  if (type === 'sku_image_ai') {
    const productId = text(source.productId, 120), variantRef = text(source.variantRef, 180), linkId = text(source.linkId, 64);
    const associationVersion = Math.floor(Number(source.associationVersion));
    const capability = source.capability === 'image-translation' ? 'image-translation' : 'image-redraw';
    const billingChannel = source.billingChannel === 'own' ? 'own' : 'official';
    const sourceHash = text(source.sourceHash, 64), promptHash = text(source.promptHash, 64), finalPromptHash = text(source.finalPromptHash, 64), sellingPointResultHash = text(source.sellingPointResultHash, 64);
    const sellingPointsSource = source.sellingPointsSource === 'manual' ? 'manual' : 'ai';
    const sellingPointSourceHash = text(source.sellingPointSourceHash, 64) || sellingPointResultHash;
    const configurationId = text(source.configurationId, 64), templateKey = text(source.templateKey, 64), providerTaskId = text(source.providerTaskId, 180);
    const billingAttemptKey = text(source.billingAttemptKey, 160), taskName = text(source.taskName, 160);
    const sellingPoints = text(source.sellingPoints, 5000), finalPrompt = text(source.finalPrompt, 8000);
    const sourceLanguage = text(source.sourceLanguage, 12).toLowerCase(), targetLanguage = text(source.targetLanguage, 12).toLowerCase();
    const promptSnapshots = { template: promptSnapshot(source.promptSnapshots?.template), sellingPoints: promptSnapshot(source.promptSnapshots?.sellingPoints), rawResponse: promptSnapshot(source.promptSnapshots?.rawResponse), finalPrompt: promptSnapshot(source.promptSnapshots?.finalPrompt) };
    const hasSnapshotInput = promptSnapshots.template && promptSnapshots.sellingPoints;
    const commonInvalid = !/^(?:\d+|draft_[\w-]+)$/.test(productId) || !/^[A-Za-z0-9._:-]{1,180}$/.test(variantRef) || !/^[0-9a-f-]{36}$/i.test(linkId) || !Number.isInteger(associationVersion) || associationVersion < 1 || !/^[0-9a-f]{64}$/i.test(sourceHash) || !/^[0-9a-f-]{36}$/i.test(configurationId) || !/^sku-image-ai:[A-Za-z0-9._:-]{8,140}$/.test(billingAttemptKey) || !taskName;
    const redrawInvalid = capability === 'image-redraw' && (!/^[0-9a-f]{64}$/i.test(promptHash) || finalPromptHash && !/^[0-9a-f]{64}$/i.test(finalPromptHash) || finalPrompt && !finalPromptHash || !/^[0-9a-f]{64}$/i.test(sellingPointResultHash) || !/^[0-9a-f]{64}$/i.test(sellingPointSourceHash) || !['image-main','image-scene','image-selling','image-accessory','image-white-base','image-size'].includes(templateKey) || (!sellingPoints && !hasSnapshotInput));
    const translationInvalid = capability === 'image-translation' && (!['zh','en'].includes(sourceLanguage) || targetLanguage !== 'ru');
    if (commonInvalid || redrawInvalid || translationInvalid) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    return {
      clientId, productId, variantRef, linkId, associationVersion, capability, billingChannel, sourceHash, configurationId,
      sourceLanguage: capability === 'image-translation' ? sourceLanguage : '', targetLanguage: capability === 'image-translation' ? targetLanguage : '',
      promptHash: capability === 'image-redraw' ? promptHash : '', finalPrompt: capability === 'image-redraw' ? (finalPrompt || null) : null, finalPromptHash: capability === 'image-redraw' ? (finalPromptHash || null) : null,
      sellingPointResultHash: capability === 'image-redraw' ? sellingPointResultHash : '', sellingPoints: capability === 'image-redraw' ? (sellingPoints || null) : null,
      sellingPointsSource: capability === 'image-redraw' ? sellingPointsSource : '', sellingPointSourceHash: capability === 'image-redraw' ? sellingPointSourceHash : '',
      templateKey: capability === 'image-redraw' ? templateKey : '', billingAttemptKey, taskName,
      promptSnapshots: capability === 'image-redraw' ? promptSnapshots : { template: null, sellingPoints: null, rawResponse: null, finalPrompt: null },
      diagnostic: skuImageDiagnostic(source.diagnostic), providerTaskId: providerTaskId || null, resultReference: resultReference(source.resultReference), candidateStored: candidateStored(source.candidateStored), linkedCandidate: linkedCandidate(source.linkedCandidate), phase: text(source.phase, 24) || 'queued'
    };
  }
  return { clientId };
}

function normalizeBackgroundJob(input) {
  const source = input && typeof input === 'object' ? input : {};
  const type = text(source.type, 40);
  if (!JOB_TYPES.has(type)) throw Object.assign(new Error('任务类型不受支持，请从页面重新发起对应任务。'), { publicCode: 'background_job_type_invalid' });
  const id = text(source.id, 120);
  const dedupeKey = text(source.dedupeKey, 180);
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id) || !dedupeKey) {
    throw Object.assign(new Error('任务身份标识不完整，无法登记，请重新发起一次。'), { publicCode: 'background_job_identity_invalid' });
  }
  const imageCapability = source.context?.capability === 'image-translation' ? 'image-translation' : 'image-redraw';
  const contextSource = type === 'sku_image_ai' ? { ...(source.context || {}), capability: imageCapability, billingAttemptKey: source.context?.billingAttemptKey || `sku-image-ai:${id}`, taskName: source.context?.taskName || `${imageCapability === 'image-translation' ? 'AI图片翻译' : 'AI图片重绘'} · ${id.slice(-8)}` } : source.context;
  const context = normalizeContext(type, contextSource);
  const contextText = JSON.stringify(context);
  if (Buffer.byteLength(contextText, 'utf8') > 65536) throw Object.assign(new Error('任务上下文超过允许大小，请减少图片数量后重新提交。'), { publicCode: 'background_job_context_too_large' });
  return {
    id,
    type,
    dedupeKey,
    context,
    maxAttempts: Math.max(1, Math.min(10, Math.floor(Number(source.maxAttempts) || 1))),
    initialState: 'queued',
    availableAt: source.availableAt instanceof Date && !isNaN(source.availableAt.getTime()) ? source.availableAt : new Date()
  };
}

function mapBackgroundJob(row) {
  if (!row) return null;
  return {
    tenantId: String(row.tenant_id),
    id: row.job_id,
    actorUserId: String(row.actor_user_id),
    type: row.job_type,
    dedupeKey: row.dedupe_key,
    state: row.state,
    context: row.context || {},
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = { JOB_TYPES, containsSecret, normalizeBackgroundJob, mapBackgroundJob };
