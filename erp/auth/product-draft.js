'use strict';
const crypto = require('node:crypto');
const combination = require('../assets/product-combination');
const FIELDS = ['title','brand','weight','length','width','height','barcode','hashtags','description','richContent','sourceUrl','sourcePrice','sourceNote'];
function invalid(message) { return Object.assign(new Error(message), { publicCode: 'invalid_product_draft', status: 400 }); }
function record(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function normalize(input, account) {
  if (!record(input) || input.version !== 1) throw invalid('草稿格式或版本不正确');
  const allowed = ['version','fields','attributes','variants','dirtyFields','sharedDirty','hashtagsEdited','variantStructureEdited','moreAttributesOpen','autoColorSample','autoVariantRecognition','manualVariantAttributes','suppressedVariantAttributes','sourceBundles','combinationRelations','combinationHistory','categoryVersion','packageDimensionSources','contentRiskChecks','promotionState'];
  if (input.promotionState !== undefined) {
    const state = input.promotionState;
    const snapshot = value => record(value) && record(value.attribute) && Object.keys(value).every(key => ['attribute', 'fieldValue'].includes(key)) && (value.fieldValue === undefined || (typeof value.fieldValue === 'string' && value.fieldValue.length <= 10000));
    const barcodeSnapshot = value => snapshot(value) && Object.keys(value.attribute).length === 0 && typeof value.fieldValue === 'string';
    if (!record(state) || state.schemaVersion !== 1 || Object.keys(state).some(key => !['schemaVersion', 'attributes'].includes(key)) || !record(state.attributes) || Object.keys(state.attributes).length > 1000 || Object.entries(state.attributes).some(([key, entry]) => (key !== 'field:barcode' && !/^\d{1,20}:\d{1,20}$/.test(key)) || !record(entry) || Object.keys(entry).some(name => !['original', 'variantValues'].includes(name)) || !(key === 'field:barcode' ? barcodeSnapshot(entry.original) : snapshot(entry.original)) || !record(entry.variantValues) || Object.keys(entry.variantValues).length > 100 || Object.entries(entry.variantValues).some(([ref, value]) => !/^erv_[A-Za-z0-9_-]{6,220}$/.test(ref) || !(key === 'field:barcode' ? barcodeSnapshot(value) : snapshot(value))))) throw invalid('属性变体列恢复快照格式不正确，请重新打开商品后保存。');
  }
  if (input.contentRiskChecks !== undefined) {
    const review = input.contentRiskChecks;
    const validMessage = item => record(item) && typeof item.code === 'string' && item.code.length <= 100 && typeof item.message === 'string' && item.message.length <= 1000;
    if (!record(review) || review.schemaVersion !== 1 || !record(review.fields) || Object.keys(review).some(key => !['schemaVersion', 'fields'].includes(key)) || Object.entries(review.fields).some(([key, check]) => !['title','summary','sellingPoints','richTitle','richDescription'].includes(key) || !record(check) || !['passed','warning','failed','pending'].includes(check.status) || !['pair','translation','ru'].includes(check.scope) || typeof check.message !== 'string' || check.message.length > 1000 || !Array.isArray(check.warnings) || check.warnings.length > 30 || check.warnings.some(item => !validMessage(item)) || (check.failure != null && !validMessage(check.failure)) || ['contentHash','factsHash','rulesHash','checkHash'].some(name => check[name] != null && !/^[a-f0-9]{64}$/.test(check[name])))) throw invalid('商品内容核对记录格式不正确，请重新核对后保存。');
  }
  if (input.packageDimensionSources !== undefined && (!record(input.packageDimensionSources) || Object.entries(input.packageDimensionSources).some(([key, value]) => !['length', 'width', 'height'].includes(key) || !['fallback', 'manual', 'unknown'].includes(value)))) throw invalid('包装尺寸来源标记不正确，请重新打开商品后保存。');
  for (const key of ['manualVariantAttributes','suppressedVariantAttributes']) if (input[key] !== undefined && (!Array.isArray(input[key]) || input[key].length > 1000 || input[key].some(value => typeof value !== 'string' || value.length > 160))) throw invalid('草稿变体属性列状态不正确');
  const bundleKeys = new Set(['id','collectionId','collection_id','sourceId','title','name','sourceUrl','url','srcUrl','purchase','srcPrice','domesticShipping','purchaseCostOverride','internationalShipping','referenceImage','reference_image','imageCandidates','images','selectedVariantIds','variantIds','selectedVariants','sourceSnapshot','createdAt','updatedAt','lastCombinedAt']);
  const relationKeys = new Set(['id','relationId','parentRef','childRef','childCollectionRef','childCollectionId','quantity','createdAt','updatedAt','lastCombinedAt']);
  const historyKeys = new Set(['id','eventId','relationId','parentRef','childRef','childCollectionId','action','occurredAt','source','operatorUserId']);
  if (input.sourceBundles !== undefined && (!Array.isArray(input.sourceBundles) || input.sourceBundles.length > 200 || input.sourceBundles.some(bundle => !record(bundle) || Object.keys(bundle).some(key => !bundleKeys.has(key))))) throw invalid('组合货源草稿格式不正确');
  if (input.combinationRelations !== undefined && (!Array.isArray(input.combinationRelations) || input.combinationRelations.length > 2000 || input.combinationRelations.some(relation => !record(relation) || Object.keys(relation).some(key => !relationKeys.has(key))))) throw invalid('组合关系草稿格式不正确');
  if (input.combinationHistory !== undefined && (!Array.isArray(input.combinationHistory) || input.combinationHistory.length > 5000 || input.combinationHistory.some(event => !record(event) || Object.keys(event).some(key => !historyKeys.has(key))))) throw invalid('组合历史草稿格式不正确');
  if (input.autoVariantRecognition !== undefined && typeof input.autoVariantRecognition !== 'boolean') throw invalid('自动识别状态不正确');
  if (Object.keys(input).some(k => !allowed.includes(k))) throw invalid('草稿包含不支持的字段');
  if (!record(input.fields) || Object.keys(input.fields).some(k => !FIELDS.includes(k)) || FIELDS.some(k => typeof input.fields[k] !== 'string')) throw invalid('草稿缺少整页表单文本');
  if (!Array.isArray(input.attributes) || input.attributes.length > 1000 || !Array.isArray(input.variants) || input.variants.length < 1 || input.variants.length > 100) throw invalid('草稿属性或变体数量不正确');
  if (input.attributes.some(a => !record(a)) || input.variants.some(v => !record(v))) throw invalid('草稿属性或变体格式不正确');
  const variantRefs = new Set();
  for (const variant of input.variants) {
    const ref = String(variant.erpVariantRef || '').trim();
    if (ref && (!/^erv_[A-Za-z0-9_-]{6,220}$/.test(ref) || variantRefs.has(ref))) throw invalid('SKU内部组合标识重复或格式不正确');
    if (ref) variantRefs.add(ref);
    if (variant.sourceBundleIds !== undefined && (!Array.isArray(variant.sourceBundleIds) || variant.sourceBundleIds.length > 200 || variant.sourceBundleIds.some(value => typeof value !== 'string' || !value.trim() || value.length > 240))) throw invalid('SKU组合关联格式不正确');
  }
  const graph = combination.validateGraph(input.combinationRelations || []);
  if (!graph.ok) throw invalid(graph.code === 'combination_cycle' ? '组合关系存在循环：' + graph.path.join(' → ') : '组合关系包含重复或无效关联');
  if (['hashtagsEdited','variantStructureEdited','moreAttributesOpen','autoColorSample'].some(k => typeof input[k] !== 'boolean') || typeof input.categoryVersion !== 'string') throw invalid('草稿页面状态不正确');
  for (const key of ['dirtyFields','sharedDirty']) {
    if (!record(input[key]) || Object.keys(input[key]).length > 3000 || Object.entries(input[key]).some(([k,v]) => !/^(?:field:[\w-]+|attribute:\d+:\d+|variant:\d+:[\w-]+|variant:[\w-]+|dimensions:[\w-]+)$/.test(k) || typeof v !== 'boolean')) throw invalid('草稿编辑标记不正确');
  }
  function safeTree(value, depth = 0) {
    if (depth > 18) throw invalid('草稿嵌套过深');
    if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) {
      if (['__proto__','prototype','constructor','apiKey','api_key','token','password','secret','permissions','isSystemAdmin','ozonEdit','tenantId','userId'].includes(k)) throw invalid('草稿包含非商品字段');
      safeTree(v, depth + 1);
    }
  }
  safeTree(input);
  input = { ...input, sourceBundles: combination.normalizeBundles(input.sourceBundles || []), combinationRelations: graph.relations, combinationHistory: combination.normalizeHistory(input.combinationHistory || []) };
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json, 'utf8') > 1500000) throw invalid('草稿过大，请减少内容后重试');
  // Keep incomplete/invalid numeric and JSON inputs as text. Validation belongs
  // to explicit enqueue, never to a draft or to platform-authoritative columns.
  return { ...JSON.parse(json), id: crypto.randomUUID(), savedAt: new Date().toISOString(), savedBy: String(account.userId) };
}
module.exports = { normalize, FIELDS };
