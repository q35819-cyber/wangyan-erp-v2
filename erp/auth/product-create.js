'use strict';
const { validateImportAttributes } = require('./product-attribute-validation');

const crypto = require('crypto');
const validator = require('../assets/product-create-validator');
const attributeFields = require('../assets/product-attribute-fields');
const combination = require('../assets/product-combination');
const productSyncMap = require('../assets/online-product-sync-map');
const productRecords = require('../assets/product-records');

const DRAFT_KEY = 'erp_product_drafts';
const LISTING_RECORD_KEY = 'erp_product_listing_records';
const SERVER_LIMIT = 50;
const DRAFT_RETENTION_MS = 72 * 60 * 60 * 1000;
const DRAFT_RETENTION_VERSION = 1;
const arr = value => Array.isArray(value) ? value : [];

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { publicCode: code, status });
}

function revision(draft) {
  const value = draft && typeof draft === 'object' && !Array.isArray(draft) ? { ...draft } : draft;
  // ozonCreate 是服务端任务状态、ownerUserId 是服务端盖的归属元数据，都不算用户内容，
  // 不能进入乐观锁哈希（否则服务端自己写入就会把下一次提交判成“草稿已被修改”）。
  if (value && typeof value === 'object') { delete value.ozonCreate; delete value.ownerUserId; delete value.draftRetention; }
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function text(value) { return String(value == null ? '' : value).trim(); }
function positiveInteger(value, label, maximum = 1000000) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw problem('invalid_product_measure', label + '必须为大于零的整数');
  }
  return number;
}

function publicImage(value, label) {
  const source = text(value);
  let url;
  try { url = new URL(source); } catch (_) { throw problem('invalid_product_image', label + '必须是公开HTTPS图片地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || source.length > 2048) {
    throw problem('invalid_product_image', label + '必须是公开HTTPS图片地址');
  }
  return source;
}

function normalizeValue(value) {
  const dictionary = Number(value && value.dictionary_value_id || 0);
  if (!Number.isSafeInteger(dictionary) || dictionary < 0) throw problem('invalid_product_attribute', '属性选项编号无效');
  const result = { dictionary_value_id: dictionary, value: text(value && value.value) };
  if (!result.dictionary_value_id && !result.value) return null;
  if (result.value.length > 6000) throw problem('invalid_product_attribute', '属性值过长');
  return result;
}

function normalizeAttribute(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('invalid_product_attribute', '商品属性格式无效');
  const id = Number(value.id || value.attribute_id), complex = Number(value.complex_id || value.complexId || value.attribute_complex_id || 0);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(complex) || complex < 0) throw problem('invalid_product_attribute', '商品属性编号无效');
  const sourceValues = Array.isArray(value.values) ? value.values : text(value.value) ? [{ value: value.value }] : [];
  const values = sourceValues.map(normalizeValue).filter(Boolean);
  return values.length ? { id, complex_id: complex, values } : null;
}

function rawAttributeKey(value) { return String(value && (value.id || value.attribute_id) || '') + ':' + Number(value && (value.complex_id || value.complexId || value.attribute_complex_id) || 0); }
function attributesFor(draft, variant) {
  const manual = new Set(arr(draft.manualVariantAttributes).map(text)), categoryPromoted = manual.has('field:category');
  const allowed = categoryPromoted && variant ? new Set(arr(variant.categoryAttributeKeys).map(text)) : null;
  const definitions = arr(draft.attributes).filter(source => !allowed || allowed.has(rawAttributeKey(source))).map(source => ({ ...source })), bindings = attributeFields.bindings(definitions), byKey = new Map();
  definitions.forEach((attribute, index) => {
    const binding = bindings[index]; if (!binding || !variant) return;
    let value = null;
    if (manual.has('field:title') && binding.area === 'field' && binding.key === 'title') value = variant.title;
    else if (manual.has('field:weight') && binding.area === 'field' && binding.key === 'weight') value = variant.weightG;
    else if (manual.has('field:dimensions') && binding.area === 'field' && binding.key === 'length') value = variant.packageLength;
    else if (manual.has('field:dimensions') && binding.area === 'field' && binding.key === 'width') value = variant.packageWidth;
    else if (manual.has('field:dimensions') && binding.area === 'field' && binding.key === 'height') value = variant.packageHeight;
    else if (manual.has('field:dimensions') && binding.area === 'dimensions') value = attributeFields.formatDimensions({ length: variant.packageLength, width: variant.packageWidth, height: variant.packageHeight });
    if (value != null && value !== '') attributeFields.setText(attribute, String(value));
  });
  const variantSources = arr(variant && variant.attributes).filter(source => !allowed || allowed.has(rawAttributeKey(source)));
  for (const source of definitions.concat(variantSources)) {
    const attribute = normalizeAttribute(source);
    if (!attribute || attribute.id === 8229) continue;
    byKey.set(attribute.id + ':' + attribute.complex_id, attribute);
  }
  const simple = [], groups = new Map();
  for (const attribute of byKey.values()) {
    if (!attribute.complex_id) simple.push(attribute);
    else {
      if (!groups.has(attribute.complex_id)) groups.set(attribute.complex_id, []);
      groups.get(attribute.complex_id).push(attribute);
    }
  }
  return { attributes: simple, complex_attributes: [...groups.values()].map(attributes => ({ attributes })) };
}

function normalizeRelistSource(value) {
  if (value == null || value === '') return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('invalid_relist_source', '下架重上来源商品信息无效');
  const source = {
    clientId: text(value.clientId),
    productId: text(value.productId),
    sku: text(value.sku).slice(0, 180),
    offerId: text(value.offerId).slice(0, 180)
  };
  if (!/^\d{1,18}$/.test(source.clientId) || !/^\d+$/.test(source.productId) || !Number.isSafeInteger(Number(source.productId)) || Number(source.productId) <= 0) {
    throw problem('invalid_relist_source', '下架重上来源缺少有效店铺或平台商品编号');
  }
  return source;
}

function validateRelistSourceDraft(draft, sourceItem, clientId) {
  const source = normalizeRelistSource(draft && draft.relistSource);
  if (!source) return null;
  if (text(clientId || draft.shop) !== source.clientId || text(draft.shop) !== source.clientId) {
    throw problem('relist_shop_mismatch', '下架重上只能重新上架到原商品所属店铺', 409);
  }
  const variants = arr(draft.variants);
  if (variants.some(variant => text(variant && variant.sku))) throw problem('relist_old_sku_present', '下架重上草稿不能复用原 Ozon SKU', 409);
  if (source.offerId && variants.some(variant => text(variant && variant.offerId) === source.offerId)) throw problem('relist_old_offer_present', '下架重上必须按规则生成新货号，不能复用原货号', 409);
  const hasSellerCode = arr(draft.attributes).concat(...variants.map(variant => arr(variant && variant.attributes))).some(attribute => String(attribute && (attribute.id || attribute.attribute_id) || '') === '9024');
  if (hasSellerCode) throw problem('relist_old_offer_present', '下架重上不能携带旧卖家代码属性，请使用新货号', 409);
  if (sourceItem) {
    const row = productRecords.normalize(sourceItem);
    if (!productRecords.isDelisted(row)) throw problem('relist_source_not_delisted', '原商品当前不是可重新上架的已下架状态，请刷新下架重上页面', 409);
    if (row.relistedAt) throw problem('product_already_relisted', '原下架商品已经完成过重新上架，不能重复创建；如需再次处理请先核对新商品状态', 409);
    if (source.sku && row.sku && source.sku !== row.sku) throw problem('relist_source_changed', '原商品 SKU 已变化，请刷新后重新发起下架重上', 409);
    if (source.offerId && row.offerId && source.offerId !== row.offerId) throw problem('relist_source_changed', '原商品货号已变化，请刷新后重新发起下架重上', 409);
  }
  return source;
}

function normalizeDraft(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft) || draft.mode !== 'create' || !/^draft_[\w-]+$/.test(text(draft.draftId))) {
    throw problem('invalid_product_draft', '新增商品草稿编号或模式无效');
  }
  const earlyOffers = new Set();
  validateRelistSourceDraft(draft, null, draft.shop);
  for (const variant of arr(draft.variants)) {
    const offer = text(variant && variant.offerId);
    if (offer && earlyOffers.has(offer)) throw problem('duplicate_product_offer_id', '同一新增草稿中的货号不能重复');
    if (offer) earlyOffers.add(offer);
  }
  const variantRefs = new Set();
  for (const variant of arr(draft.variants)) {
    const ref = text(variant && variant.erpVariantRef);
    if (ref && (!/^erv_[A-Za-z0-9_-]{6,220}$/.test(ref) || variantRefs.has(ref))) throw problem('invalid_product_draft', 'SKU内部组合标识重复或格式不正确');
    if (ref) variantRefs.add(ref);
    if (variant && variant.sourceBundleIds !== undefined && (!Array.isArray(variant.sourceBundleIds) || variant.sourceBundleIds.length > 200 || variant.sourceBundleIds.some(value => typeof value !== 'string' || !value.trim() || value.length > 240))) throw problem('invalid_product_draft', 'SKU组合关联格式不正确');
  }
  const collectionId = text(draft.collectionId);
  if (collectionId && !/^[A-Za-z0-9._:-]{1,200}$/.test(collectionId)) throw problem('invalid_product_draft', '采集箱来源编号不正确，请从采集箱重新进入新增商品。');
  const aliases = collectionId && arr(draft.variants).length === 1 && text(draft.variants[0] && draft.variants[0].erpVariantRef) ? [{ collectionId, variantRef: text(draft.variants[0].erpVariantRef) }] : [];
  const graph = combination.validateGraph(draft.combinationRelations || [], aliases);
  if (!graph.ok) throw problem(graph.code === 'combination_cycle' ? 'combination_cycle' : 'invalid_combination_relation', graph.code === 'combination_cycle' ? '组合关系存在循环：' + graph.path.join(' → ') : '组合关系包含重复或无效关联', 409);
  const validation = validator.validate(draft, { attributes: arr(draft.attributes), bindings: attributeFields.bindings(arr(draft.attributes)) });
  if (validation) throw problem('invalid_product_draft', validation.message);
  if (text(draft.title).length > 500) throw problem('invalid_product_name', '商品标题最多500个字符');
  if (!arr(draft.variants).length || arr(draft.variants).length > 100) throw problem('invalid_product_variants', '每次新增商品必须包含1至100个变体');
  const offers = new Set();
  for (const variant of draft.variants) {
    const offer = text(variant && variant.offerId);
    if (!offer || offer.length > 50 || /[\u0000-\u001f\u007f]/.test(offer)) throw problem('invalid_product_offer_id', '货号必须为1至50个可见字符');
    if (offers.has(offer)) throw problem('duplicate_product_offer_id', '同一新增草稿中的货号不能重复');
    offers.add(offer);
  }
  return draft;
}

function buildImport(input) {
  const draft = normalizeDraft(input);
  const manual = new Set(arr(draft.manualVariantAttributes).map(text)), categoryPromoted = manual.has('field:category');
  const descriptionCategoryId = categoryPromoted ? null : positiveInteger(draft.descriptionCategoryId, '类目编号', Number.MAX_SAFE_INTEGER);
  const typeId = categoryPromoted ? null : positiveInteger(draft.typeId, '类型编号', Number.MAX_SAFE_INTEGER);
  const variants = arr(draft.variants);
  const items = variants.map((variant, index) => {
    const images = [...new Set(arr(variant.images).concat(variant.image || []).map((url, imageIndex) => publicImage(url, `第${index + 1}行第${imageIndex + 1}张图片`)))].slice(0, 30);
    if (!images.length) throw problem('invalid_product_image', `第${index + 1}行至少需要一张公开HTTPS图片`);
    const mapped = attributesFor(draft, variant);
    const variantCategoryId = positiveInteger(categoryPromoted ? variant.descriptionCategoryId : descriptionCategoryId, `第${index + 1}行类目编号`, Number.MAX_SAFE_INTEGER);
    const variantTypeId = positiveInteger(categoryPromoted ? variant.typeId : typeId, `第${index + 1}行类型编号`, Number.MAX_SAFE_INTEGER);
    const variantTitle = text(variant.title || draft.title);
    const variantWeight = positiveInteger(variant.weightG || draft.weightG, `第${index + 1}行包装重量`);
    const variantDepth = positiveInteger(variant.packageLength || draft.dimensions && draft.dimensions.length, `第${index + 1}行包装长度`);
    const variantWidth = positiveInteger(variant.packageWidth || draft.dimensions && draft.dimensions.width, `第${index + 1}行包装宽度`);
    const variantHeight = positiveInteger(variant.packageHeight || draft.dimensions && draft.dimensions.height, `第${index + 1}行包装高度`);
    if (!variantTitle || variantTitle.length > 500) throw problem('invalid_product_name', `第${index + 1}行商品标题必须为1至500个字符`);
    const minPrice = text(variant.lowest), price = text(variant.sale), oldPrice = text(variant.old);
    const minMoney = validator.money(minPrice), priceMoney = validator.money(price), oldMoney = validator.money(oldPrice);
    if (minMoney == null || minMoney <= 0n || priceMoney == null || priceMoney <= minMoney || oldMoney == null || oldMoney <= priceMoney || minMoney * 2n < priceMoney) {
      throw problem('invalid_product_amount', '第' + (index + 1) + '行最低价、销售价或划线价无效');
    }
    const item = {
      description_category_id: variantCategoryId,
      type_id: variantTypeId,
      offer_id: text(variant.offerId),
      name: variantTitle,
      price,
      old_price: oldPrice,
      currency_code: 'CNY',
      depth: variantDepth,
      width: variantWidth,
      height: variantHeight,
      dimension_unit: 'mm',
      weight: variantWeight,
      weight_unit: 'g',
      primary_image: images[0],
      images: images.slice(1),
      color_image: draft.autoColorSample ? images[0] : '',
      attributes: mapped.attributes,
      complex_attributes: mapped.complex_attributes
    };
    const barcode = text(variant.barcode || (variants.length === 1 ? draft.barcode : ''));
    if (barcode) item.barcode = barcode;
    return item;
  });
  return { items };
}

function active(state) {
  return Boolean(state && ['queued', 'preparing', 'submitting', 'pending', 'verifying', 'unknown'].includes(state.phase));
}

function validTime(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function draftRetentionRefs(draft, combinationPayload) {
  const refs = new Set(), collectionIds = new Set();
  const addCollection = value => {
    const id = text(value);
    if (!id) return;
    collectionIds.add(id);
    refs.add('collection:' + id);
  };
  addCollection(draft && draft.collectionId);
  for (const bundle of arr(draft && draft.sourceBundles)) addCollection(bundle && bundle.collectionId);
  for (const variant of arr(draft && draft.variants)) {
    const ref = text(variant && variant.erpVariantRef).replace(/^variant:/, '');
    if (ref) refs.add('variant:' + ref);
  }
  const raw = combinationPayload && typeof combinationPayload === 'object' && !Array.isArray(combinationPayload) ? combinationPayload : {};
  for (const alias of combination.normalizeAliases(raw.aliases || raw.collectionVariantAliases || [])) {
    if (collectionIds.has(alias.collectionId)) refs.add('variant:' + alias.variantRef);
  }
  return { refs, collectionIds };
}

function combinationRetention(draft, combinationPayload) {
  const raw = combinationPayload && typeof combinationPayload === 'object' && !Array.isArray(combinationPayload) ? combinationPayload : {};
  const relations = combination.normalizeRelations(raw.relations || raw.combinationRelations || []);
  const history = combination.normalizeHistory(raw.history || raw.combinationHistory || []);
  const localRelations = combination.normalizeRelations(draft && draft.combinationRelations || []);
  const identity = draftRetentionRefs(draft, raw);
  const related = relation => Boolean(relation && (
    identity.refs.has(text(relation.parentRef)) ||
    identity.refs.has(text(relation.childRef)) ||
    identity.collectionIds.has(text(relation.childCollectionId))
  ));
  const protectedByGraph = relations.some(related);
  const localRelated = localRelations.filter(related);
  let releasedAt = 0;
  for (const event of history) {
    if (!event || event.action !== 'unlinked' || !related(event)) continue;
    releasedAt = Math.max(releasedAt, validTime(event.occurredAt));
  }
  const localLatestAt = localRelated.reduce((latest, relation) => Math.max(
    latest,
    validTime(relation.updatedAt),
    validTime(relation.lastCombinedAt),
    validTime(relation.createdAt)
  ), 0);
  // 草稿里的组合关系只是编辑快照。若全局组合历史已明确解除，且草稿快照不比解除事件更新，
  // 就必须以解除时间重新计 72 小时，不能被一份陈旧本地关系永久保护。
  const protectedByDraft = localRelated.length > 0 && (!releasedAt || localLatestAt > releasedAt);
  return {
    protected: protectedByGraph || protectedByDraft,
    reason: protectedByGraph ? 'combination' : protectedByDraft ? 'draft_combination' : '',
    releasedAt
  };
}

function retentionInfo(draft, combinationPayload, nowValue) {
  const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  const currentNow = Number.isFinite(now) ? now : Date.now();
  if (active(draft && draft.ozonCreate)) {
    return {
      version: DRAFT_RETENTION_VERSION,
      protected: true,
      reason: 'active_task',
      basisAt: '',
      expiresAt: '',
      releasedAt: ''
    };
  }
  const combinationState = combinationRetention(draft, combinationPayload);
  if (combinationState.protected) {
    return {
      version: DRAFT_RETENTION_VERSION,
      protected: true,
      reason: combinationState.reason,
      basisAt: '',
      expiresAt: '',
      releasedAt: combinationState.releasedAt ? new Date(combinationState.releasedAt).toISOString() : ''
    };
  }
  const savedAt = Math.max(
    validTime(draft && draft.updatedAt),
    validTime(draft && draft.savedAt),
    validTime(draft && draft.createdAt)
  );
  const basis = Math.max(savedAt || currentNow, combinationState.releasedAt || 0);
  return {
    version: DRAFT_RETENTION_VERSION,
    protected: false,
    reason: '',
    basisAt: new Date(basis).toISOString(),
    expiresAt: new Date(basis + DRAFT_RETENTION_MS).toISOString(),
    releasedAt: combinationState.releasedAt ? new Date(combinationState.releasedAt).toISOString() : ''
  };
}

function pruneDrafts(value, actorUserId, combinationPayload, nowValue) {
  if (!Array.isArray(value)) throw problem('invalid_product_drafts', '新增商品草稿内容不完整，请重新在批量新增页面提交一次。');
  const actor = Number(actorUserId) || 0;
  const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  const currentNow = Number.isFinite(now) ? now : Date.now();
  const removedIds = [], drafts = [];
  for (const raw of value) {
    if (!raw || !/^draft_[\w-]+$/.test(text(raw.draftId))) continue;
    const owner = Number(raw.ownerUserId) || 0;
    if (!actor || !owner || owner !== actor) {
      drafts.push(raw);
      continue;
    }
    const retention = retentionInfo(raw, combinationPayload, currentNow);
    const expiresAt = validTime(retention.expiresAt);
    if (!retention.protected && expiresAt && expiresAt <= currentNow) {
      removedIds.push(text(raw.draftId));
      continue;
    }
    drafts.push({ ...raw, draftRetention: retention });
  }
  return { drafts, removedIds };
}

function visibleDrafts(value, actorUserId) {
  const actor = Number(actorUserId) || 0;
  if (!actor) return [];
  return arr(value).filter(item => item && Number(item.ownerUserId) === actor);
}

function confirmedLocalFields(drafts) {
  const result = new Map();
  arr(drafts).slice().sort((left, right) =>
    (Date.parse(left && (left.updatedAt || left.savedAt) || '') || 0) -
    (Date.parse(right && (right.updatedAt || right.savedAt) || '') || 0)
  ).forEach(draft => {
    const state = draft && draft.ozonCreate;
    if (!draft || draft.mode !== 'create' || !state || state.phase !== 'confirmed') return;
    const clientId = text(state.clientId || draft.shop);
    if (!clientId) return;
    const singleVariantRef = arr(draft.variants).length === 1 ? text(draft.variants[0] && draft.variants[0].erpVariantRef) : '';
    arr(draft.variants).forEach(variant => {
      const offerId = text(variant && variant.offerId);
      if (!offerId) return;
      result.set(clientId + '\u0000' + offerId, {
        purchasePrice: text(variant.purchase),
        srcPrice: text(draft.srcPrice),
        domesticShipping: Object.prototype.hasOwnProperty.call(variant, 'domesticShipping')
          ? text(variant.domesticShipping) : text(draft.domesticShipping),
        srcUrl: text(draft.srcUrl),
        srcNote: text(draft.srcNote),
        ...(singleVariantRef && text(draft.collectionId) ? { collectionId: text(draft.collectionId), combinationAliasVariantRef: singleVariantRef } : {}),
        ...(text(variant.erpVariantRef) ? { erpVariantRef: text(variant.erpVariantRef) } : {}),
        ...(arr(variant.sourceBundleIds).length ? { sourceBundleIds: combination.uniqueStrings(variant.sourceBundleIds) } : {}),
        ...(arr(draft.sourceBundles).length ? { sourceBundles: combination.normalizeBundles(draft.sourceBundles) } : {}),
        ...(arr(draft.combinationRelations).length ? { combinationRelations: combination.normalizeRelations(draft.combinationRelations) } : {}),
        ...(arr(draft.combinationHistory).length ? { combinationHistory: combination.normalizeHistory(draft.combinationHistory) } : {}),
        ...(arr(draft.manualVariantAttributes).length ? { manualVariantAttributes: arr(draft.manualVariantAttributes).map(text).filter(Boolean) } : {}),
        ...(arr(draft.suppressedVariantAttributes).length ? { suppressedVariantAttributes: arr(draft.suppressedVariantAttributes).map(text).filter(Boolean) } : {})
      });
    });
  });
  return result;
}

function listingPhase(state, offerId) {
  if (!state) return '';
  const currentOffer = text(offerId);
  if (state.phase === 'failed') return arr(state.successfulOfferIds).map(text).includes(currentOffer) ? '新增成功' : '新增失败';
  if (state.phase === 'verifying' && arr(state.failedOfferIds).map(text).includes(currentOffer)) return '新增失败';
  return ({ queued: '已提交', preparing: '校验中', submitting: '提交中', pending: 'Ozon处理中', verifying: '平台确认中', confirmed: '新增成功', unknown: '结果待核对' })[state.phase] || '';
}

function listingProductId(state, offerId) {
  if (!state) return null;
  const successOffers = arr(state.successfulOfferIds).length ? arr(state.successfulOfferIds).map(text)
    : state.phase === 'confirmed' ? arr(state.offerIds).map(text) : [];
  const index = successOffers.indexOf(text(offerId));
  if (index < 0) return null;
  const value = Number(arr(state.productIds)[index]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function listingStateValue(state, offerId, field) {
  if (!state) return '';
  const successOffers = arr(state.successfulOfferIds).length ? arr(state.successfulOfferIds).map(text)
    : state.phase === 'confirmed' ? arr(state.offerIds).map(text) : [];
  const index = successOffers.indexOf(text(offerId));
  return index < 0 ? '' : text(arr(state[field])[index]);
}
function listingSku(state, offerId) { return listingStateValue(state, offerId, 'skus'); }

function mergeListingRecords(value, before, next, shopName) {
  const rows = arr(value).map(item => item && typeof item === 'object' ? { ...item } : item).filter(Boolean);
  if (!next || next.mode !== 'create') return rows;
  const state = next.ozonCreate;
  if (!state || !text(state.queueId) || !arr(state.offerIds).length) return rows;
  const offers = arr(state.offerIds).map(text).filter(Boolean);
  const variants = new Map(arr(next.variants).map(variant => [text(variant && variant.offerId), variant || {}]));
  const byKey = new Map(rows.map((row, index) => [text(row && row.queueId) + '\u0000' + text(row && row.offerId), index]));
  for (const offerId of offers) {
    const key = text(state.queueId) + '\u0000' + offerId;
    const existingIndex = byKey.has(key) ? byKey.get(key) : -1;
    const existing = existingIndex >= 0 ? rows[existingIndex] : null;
    const variant = variants.get(offerId) || {};
    const productId = listingProductId(state, offerId);
    const status = listingPhase(state, offerId);
    const snapshot = existing || {
      id: text(state.queueId) + ':' + offerId,
      source: 'product_create_submit',
      queueId: text(state.queueId), draftId: text(next.draftId), clientId: text(state.clientId || next.shop),
      shop: text(shopName || state.clientId || next.shop), actorUserId: state.actorUserId == null ? null : String(state.actorUserId),
      actorUsername: text(state.actorUsername), offerId, name: text(next.title),
      image: text(variant.image || arr(variant.images)[0]), category: text(next.category),
      submittedAt: text(state.enqueuedAt || state.updatedAt)
    };
    const updated = {
      ...snapshot,
      productId: productId || snapshot.productId || null,
      sku: listingSku(state, offerId) || snapshot.sku || '',
      name: listingStateValue(state, offerId, 'platformNames') || snapshot.name,
      image: listingStateValue(state, offerId, 'platformImages') || snapshot.image,
      platformStatus: listingStateValue(state, offerId, 'platformStatuses') || snapshot.platformStatus || '',
      platformCreatedAt: listingStateValue(state, offerId, 'platformCreatedAts') || snapshot.platformCreatedAt || '',
      platformUpdatedAt: listingStateValue(state, offerId, 'platformUpdatedAts') || snapshot.platformUpdatedAt || '',
      publishedAt: listingStateValue(state, offerId, 'platformCreatedAts') || snapshot.publishedAt || snapshot.submittedAt,
      status: status || snapshot.status || '已提交',
      message: text(state.message),
      updatedAt: text(state.updatedAt || snapshot.updatedAt || snapshot.submittedAt),
      completedAt: ['新增成功', '新增失败', '结果待核对'].includes(status) ? text(state.updatedAt || snapshot.completedAt) : snapshot.completedAt || ''
    };
    if (existingIndex >= 0) rows[existingIndex] = updated;
    else { byKey.set(key, rows.length); rows.push(updated); }
  }
  return rows;
}

function queueTask(draft) {
  const state = draft && draft.ozonCreate;
  if (!state || !state.queueId) return null;
  const labels = {
    queued: '已入队，等待服务端提交', preparing: '正在校验服务器草稿', submitting: '正在提交 Ozon',
    pending: 'Ozon 正在创建商品', verifying: 'Ozon 已完成导入，正在确认在线商品数据', confirmed: '新增成功，已回读在线商品数据', failed: '新增失败',
    unknown: '结果未确定，需要核对，禁止重复提交'
  };
  const running = ['queued', 'preparing', 'submitting', 'pending', 'verifying'].includes(state.phase);
  return {
    id: state.queueId, type: 'create', name: '新增商品：' + text(draft.title || draft.draftId),
    article: arr(draft.variants).map(item => text(item && item.offerId)).filter(Boolean).join(', ').slice(0, 180),
    sku: arr(state.skus).map(text).filter(Boolean).join(', ').slice(0, 180), startedAt: state.enqueuedAt,
    status: running ? 'running' : state.phase === 'confirmed' ? 'done' : 'failed',
    value: ({ queued: 0, preparing: 10, submitting: 35, pending: 70, verifying: 88, confirmed: 100 })[state.phase] || 0,
    label: labels[state.phase] || '等待核对', reason: running || state.phase === 'confirmed' ? '' : state.message || labels[state.phase]
  };
}

function resultItems(value) {
  if (Array.isArray(value && value.items)) return value.items;
  if (Array.isArray(value && value.result)) return value.result;
  if (Array.isArray(value && value.result && value.result.items)) return value.result.items;
  return [];
}

function matchPlatformRow(rows, productId, offerId) {
  return arr(rows).find(row => String(row && (row.id != null ? row.id : row.product_id)) === String(productId))
    || arr(rows).find(row => text(row && row.offer_id) === text(offerId)) || null;
}

function localProjection(draft, variant) {
  const output = {
    purchasePrice: text(variant && variant.purchase),
    srcPrice: text(draft && draft.srcPrice),
    domesticShipping: Object.prototype.hasOwnProperty.call(variant || {}, 'domesticShipping') ? text(variant.domesticShipping) : text(draft && draft.domesticShipping),
    srcUrl: text(draft && draft.srcUrl),
    srcNote: text(draft && draft.srcNote),
    erpVariantRef: text(variant && variant.erpVariantRef),
    sourceBundleIds: combination.uniqueStrings(variant && variant.sourceBundleIds),
    sourceBundles: combination.normalizeBundles(draft && draft.sourceBundles),
    combinationRelations: combination.normalizeRelations(draft && draft.combinationRelations),
    combinationHistory: combination.normalizeHistory(draft && draft.combinationHistory),
    manualVariantAttributes: arr(draft && draft.manualVariantAttributes).map(text).filter(Boolean),
    suppressedVariantAttributes: arr(draft && draft.suppressedVariantAttributes).map(text).filter(Boolean)
  };
  if (arr(draft && draft.variants).length === 1 && text(draft && draft.collectionId)) output.collectionId = text(draft.collectionId);
  return output;
}

function createPriceTierPayloads(draft, state) {
  const variants = new Map(arr(draft && draft.variants).map(variant => [text(variant && variant.offerId), variant || {}]));
  return arr(state && state.successfulOfferIds).map((offerId, index) => {
    const variant = variants.get(text(offerId)) || {};
    const minPrice = text(variant.lowest), price = text(variant.sale), oldPrice = text(variant.old);
    if (!minPrice) return null;
    const minMoney = validator.money(minPrice), priceMoney = validator.money(price), oldMoney = validator.money(oldPrice);
    if (minMoney == null || minMoney <= 0n || priceMoney == null || priceMoney <= minMoney || oldMoney == null || oldMoney <= priceMoney || minMoney * 2n < priceMoney) {
      throw problem('invalid_product_amount', '创建后的最低价、销售价或划线价不符合平台要求', 409);
    }
    const productId = Number(arr(state.productIds)[index]);
    if (!Number.isSafeInteger(productId) || productId <= 0) return null;
    return { product_id: productId, price, old_price: oldPrice, min_price: minPrice, currency_code: 'CNY' };
  }).filter(Boolean);
}

function priceUpdateFailure(response) {
  const rows = arr(response && response.result);
  const failed = rows.find(row => !row || row.updated !== true);
  if (!failed) return '';
  return arr(failed.errors).map(error => text(error && (error.message || error.code))).filter(Boolean).join('；') || 'Ozon未确认三价更新';
}

async function readCreatedOnlineProducts(draft, state, call) {
  const productIds = arr(state && state.productIds).map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  const offerIds = arr(state && state.successfulOfferIds).map(text).filter(Boolean);
  if (!productIds.length || productIds.length !== offerIds.length) return { ready: false, products: [] };
  const ids = productIds.map(String);
  const responses = await Promise.all([
    call('/v3/product/info/list', { product_id: ids }),
    call('/v5/product/info/prices', { filter: { product_id: ids, visibility: 'ALL' }, limit: 100 }),
    call('/v4/product/info/attributes', { filter: { product_id: ids, visibility: 'ALL' }, limit: 100 })
  ]);
  const infos = resultItems(responses[0]), prices = resultItems(responses[1]), attributes = resultItems(responses[2]);
  const infoRows = productIds.map((id, index) => matchPlatformRow(infos, id, offerIds[index]));
  if (infoRows.some(row => !row)) return { ready: false, reason: 'Ozon暂未返回可查询的商品详情', products: [] };
  if (infoRows.some(row => row.statuses && row.statuses.is_created === false)) return { ready: false, reason: 'Ozon返回商品尚未完成创建', products: [] };
  const variants = new Map(arr(draft && draft.variants).map(variant => [text(variant && variant.offerId), variant || {}]));
  const shopId = text(state.clientId || draft && draft.shop);
  const shop = { clientId: shopId, externalShopId: shopId, name: shopId };
  const products = productIds.map((productId, index) => {
    const offerId = offerIds[index], info = { ...infoRows[index] };
    const priceRow = matchPlatformRow(prices, productId, offerId), attributeRow = matchPlatformRow(attributes, productId, offerId);
    info._ozonPrice = priceRow && priceRow.price || {};
    info._ozonAttributes = attributeRow || null;
    const converted = productSyncMap.convert(shop, info, null, {}), variant = variants.get(offerId) || {};
    Object.assign(converted, localProjection(draft, variant), {
      id: productId,
      productId,
      clientId: shopId,
      article: offerId,
      offer_id: offerId,
      // Ozon product_id is not a SKU. Leave SKU blank until Ozon returns the real field.
      sku: text(info.sku),
      productCreateVerifiedAt: new Date().toISOString()
    });
    return converted;
  });
  return { ready: true, products };
}

// 保留策略：正在执行的创建任务永不淘汰；空闲草稿改为“按归属用户各保留 SERVER_LIMIT 条”，
// 这样同一租户下不同子账号不会互相挤掉对方的草稿（原来是全租户一条 50 的队，谁的都可能是别人的）。
// 归属只认服务端：优先用服务器已有副本里的 ownerUserId，没有就记成当前写入人；
// 前端传来的 ownerUserId 一律忽略，避免伪造归属绕过限额。
// ponytail: 上限仍是“用户数 × 50”条挤在同一份 tenant_documents 里；要真正无上限需拆成按用户文档键，属后续专项。
function draftOwner(item, actorUserId) {
  const serverOwner = Number(item && item.ownerUserId) || 0;
  if (serverOwner) return serverOwner;
  const actor = Number(actorUserId) || 0;
  return actor || null;
}

function limitDrafts(value, existing, actorUserId, options = {}) {
  if (!Array.isArray(value)) throw problem('invalid_product_drafts', '新增商品草稿内容不完整，请重新在批量新增页面提交一次。');
  const prior = new Map(arr(existing).filter(item => item && /^draft_[\w-]+$/.test(text(item.draftId))).map(item => [text(item.draftId), item]));
  const actor = Number(actorUserId) || 0;
  const incomingIds = new Set();
  const incoming = value.filter(item => item && /^draft_[\w-]+$/.test(text(item.draftId))).map(item => {
    const incomingId = text(item.draftId);
    if (incomingIds.has(incomingId)) throw problem('invalid_product_drafts', '草稿编号重复，请刷新页面后重新保存。');
    incomingIds.add(incomingId);
    const old = prior.get(incomingId);
    const oldOwner = Number(old && old.ownerUserId) || 0;
    if (old && actor && oldOwner && oldOwner !== actor) {
      prior.delete(text(item.draftId));
      return old;
    }
    const next = { ...item };
    delete next.draftRetention;
    if (old && old.ozonCreate) next.ozonCreate = old.ozonCreate;
    else delete next.ozonCreate;
    next.ownerUserId = draftOwner(old, actorUserId);
    if (!next.ownerUserId) delete next.ownerUserId;
    prior.delete(text(item.draftId));
    return next;
  });
  for (const old of prior.values()) {
    const oldOwner = Number(old.ownerUserId) || 0;
    // 当前账号提交的数组只代表当前账号能看到的草稿。
    // 其它账号以及无法确定归属的历史草稿必须原样保留，不能因本账号保存/清理而被顺手删除。
    if (!actor || !oldOwner || oldOwner !== actor || active(old.ozonCreate)) incoming.push(old);
  }
  const sorted = incoming.sort((left, right) => {
    const leftForeign = actor && Number(left.ownerUserId) && Number(left.ownerUserId) !== actor;
    const rightForeign = actor && Number(right.ownerUserId) && Number(right.ownerUserId) !== actor;
    if (leftForeign !== rightForeign) return Number(leftForeign) - Number(rightForeign);
    const activeOrder = Number(active(right.ozonCreate)) - Number(active(left.ozonCreate));
    if (activeOrder) return activeOrder;
    return (Date.parse(right.updatedAt || right.savedAt || '') || 0) - (Date.parse(left.updatedAt || left.savedAt || '') || 0);
  });
  let actorIdleCount = 0;
  const limited = [];
  for (const item of sorted) {
    const owner = Number(item.ownerUserId) || 0;
    const actorOwned = actor ? owner === actor : owner === 0;
    const activeDraft = Boolean(active(item.ozonCreate));
    const protectedDraft = actorOwned && retentionInfo(item, options.combinationPayload, options.now).protected;
    if (actorOwned && !activeDraft && !protectedDraft) {
      if (actorIdleCount >= SERVER_LIMIT) continue;
      actorIdleCount += 1;
    }
    limited.push(item);
  }
  return pruneDrafts(limited, actorUserId, options.combinationPayload, options.now).drafts;
}

async function enqueue({ store, account, clientId, draftId, idempotencyKey }) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw problem('idempotency_key_required', '缺少稳定提交编号');
  const current = await store.getProductCreateDraft(account, draftId);
  const body = buildImport(current.item);
  if (current.item.relistSource) {
    const source = normalizeRelistSource(current.item.relistSource);
    const found = await store.getEditableProduct(account, { clientId: source.clientId, productId: source.productId });
    validateRelistSourceDraft(current.item, found && found.item, clientId);
  }
  const collectionId = text(current.item.collectionId);
  if (collectionId) {
    const collectionDocument = await store.getDocument(account, 'erp_collected_products'), rows = collectionDocument && Array.isArray(collectionDocument.payload) ? collectionDocument.payload : [];
    const source = rows.find(row => text(row && row.id) === collectionId);
    if (!source) throw problem('collection_source_missing', '关联的采集箱来源记录不存在，请从采集箱重新进入新增商品。', 409);
    if (!text(source.sourceUrl) || text(source.sourceUrl) !== text(current.item.srcUrl)) throw problem('collection_source_mismatch', '采集箱来源与当前商品主货源不一致，请重新从正确的采集商品进入。', 409);
  }
  const draftVariants = arr(current.item.variants), draftParentRefs = draftVariants.map(variant => text(variant && variant.erpVariantRef)).filter(Boolean).map(ref => 'variant:' + ref);
  if (draftParentRefs.length) {
    const combinationStore = require('./product-combination-store'), document = await store.getDocument(account, combinationStore.DOCUMENT_KEY);
    const built = combinationStore.buildReplacement(document && document.payload, draftParentRefs, current.item.combinationRelations || [], account, '新增商品');
    const alias = text(current.item.collectionId) && draftVariants.length === 1 && text(draftVariants[0] && draftVariants[0].erpVariantRef) ? [{ collectionId: text(current.item.collectionId), variantRef: text(draftVariants[0].erpVariantRef) }] : [];
    combinationStore.replaceAliases(built.payload, alias);
  }
  if (active(current.item.ozonCreate)) throw problem('product_create_pending', '该新增草稿已有任务，请在任务中心查看结果', 409);
  if (current.item.ozonCreate && current.item.ozonCreate.phase === 'confirmed') throw problem('product_already_created', '该草稿已经创建成功，不能重复提交；请新建草稿', 409);
  const namespace = 'product-create-queue:' + clientId + ':' + draftId;
  const hash = revision({ clientId, draftId, body, actorUserId: account.userId });
  const claim = await store.claimIdempotency(account, namespace, idempotencyKey, hash);
  if (claim.state === 'conflict') throw problem('idempotency_key_conflict', '同一提交编号不能用于不同新增内容', 409);
  if (claim.state !== 'claimed') {
    const replay = await store.getProductCreateDraft(account, draftId);
    const queueId = claim.body && claim.body.queueId || replay.item.ozonCreate && replay.item.ozonCreate.queueId;
    if (!queueId) throw problem('product_enqueue_pending', '正在确认入队结果，请稍后重试', 409);
    return { ...replay, queueTaskId: queueId };
  }
  let saved;
  try {
    saved = await store.mutateProductCreateDraft(account, draftId, current.revision, draft => {
      if (active(draft.ozonCreate)) throw problem('product_create_pending', '该新增草稿已有任务，请在任务中心查看结果', 409);
      const now = new Date().toISOString();
      return { ...draft, ozonCreate: {
        key: idempotencyKey, queueId: 'product-create-' + crypto.randomUUID(), clientId: String(clientId),
        actorUserId: account.userId, actorUsername: account.username, phase: 'queued',
        offerIds: body.items.map(item => item.offer_id), body, enqueuedAt: now, updatedAt: now,
        message: '已加入任务中心，服务端将继续创建商品'
      } };
    }, { enforceRelistExclusive: Boolean(current.item.relistSource) });
  } catch (error) { await store.failIdempotency(account, namespace, idempotencyKey); throw error; }
  await store.completeIdempotency(account, namespace, idempotencyKey, 202, { queueId: saved.item.ozonCreate.queueId }).catch(() => {});
  return { ...saved, queueTaskId: saved.item.ozonCreate.queueId };
}

async function execute({ store, account, draftId, action, call }) {
  const get = () => store.getProductCreateDraft(account, draftId);
  const mutate = (fn, options) => store.mutateProductCreateDraft(account, draftId, null, fn, options);
  const current = await get(), state = current.item.ozonCreate;
  if (!state) return current;
  if (action === 'runQueued') {
    if (!['queued', 'preparing'].includes(state.phase)) return current;
    const body = state.body && Array.isArray(state.body.items) ? state.body : buildImport(current.item);
    await mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, phase: 'preparing', updatedAt: new Date().toISOString() } }));
    let dispatched = false;
    try {
      await validateImportAttributes(body, { call });
      await mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, phase: 'submitting', updatedAt: new Date().toISOString() } }));
      dispatched = true;
      const response = await call('/v3/product/import', body);
      const taskId = Number(response && response.result && response.result.task_id);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) throw problem('ozon_invalid_response', 'Ozon 未返回有效新增任务编号', 502);
      return mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, taskId, phase: 'pending', updatedAt: new Date().toISOString(), message: 'Ozon 已接收新增任务，等待处理结果' } }));
    } catch (error) {
      const phase = dispatched && !error.definiteRejection ? 'unknown' : 'failed';
      return mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, phase, updatedAt: new Date().toISOString(), message: phase === 'unknown' ? '提交结果不确定，禁止重复提交；请核对 Ozon 后处理' : text(error.message).slice(0, 500) } }));
    }
  }
  if (action === 'status') {
    if (state.phase === 'pending') {
      const response = await call('/v1/product/import/info', { task_id: state.taskId });
      const rows = arr(response && response.result && response.result.items);
      const byOffer = new Map(rows.map(row => [text(row.offer_id), row]));
      const selected = arr(state.offerIds).map(offerId => byOffer.get(text(offerId)));
      if (selected.some(row => !row || row.status === 'pending')) return current;
      const successful = selected.filter(row => row && row.status === 'imported' && !arr(row.errors).length);
      const failed = selected.filter(row => !row || row.status !== 'imported' || arr(row.errors).length);
      const productIds = successful.map(row => Number(row.product_id)).filter(id => Number.isSafeInteger(id) && id > 0);
      if (successful.length && productIds.length !== successful.length) return current;
      const failureMessage = failed.map(row => row
        ? text(row.offer_id) + '：' + (row.status === 'skipped' ? 'Ozon未创建（货号可能已存在或内容未变化）' : arr(row.errors).map(error => text(error.message || error.code)).filter(Boolean).join('；') || '平台处理失败')
        : 'Ozon未返回对应货号的处理结果').join('；').slice(0, 1000);
      if (!successful.length) {
        return mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, phase: 'failed', successfulOfferIds: [], productIds: [], updatedAt: new Date().toISOString(), message: failureMessage || 'Ozon 未创建任何商品' } }));
      }
      return mutate(draft => ({ ...draft, ozonCreate: {
        ...draft.ozonCreate,
        phase: 'verifying',
        successfulOfferIds: successful.map(row => text(row.offer_id)),
        failedOfferIds: failed.map(row => text(row && row.offer_id)).filter(Boolean),
        productIds,
        failedMessage: failureMessage,
        verificationStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        message: failed.length ? '部分货号已由 Ozon 创建，正在确认在线商品数据' : 'Ozon 已完成导入，正在确认在线商品数据'
      } }));
    }
    if (state.phase === 'verifying') {
      const tierPayloads = createPriceTierPayloads(current.item, state);
      if (tierPayloads.length && !state.priceTierAppliedAt) {
        if (state.priceTierDispatchStartedAt) {
          return mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, phase: 'unknown', updatedAt: new Date().toISOString(), message: '最低价/销售价/划线价提交结果不确定，已停止自动重发，请核对Ozon价格' } }));
        }
        const startedAt = new Date().toISOString();
        await mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, priceTierDispatchStartedAt: startedAt, updatedAt: startedAt, message: '商品已创建，正在写入最低价/销售价/划线价' } }));
        let tierResponse;
        try {
          tierResponse = await call('/v1/product/import/prices', { prices: tierPayloads });
        } catch (error) {
          const phase = error && error.definiteRejection ? 'failed' : 'unknown';
          return mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, phase, updatedAt: new Date().toISOString(), message: phase === 'failed' ? 'Ozon三价更新失败：' + text(error.message).slice(0, 400) : '三价提交结果不确定，已停止自动重发，请核对Ozon价格' } }));
        }
        const tierFailure = priceUpdateFailure(tierResponse);
        if (tierFailure) return mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, phase: 'failed', updatedAt: new Date().toISOString(), message: 'Ozon三价更新失败：' + tierFailure.slice(0, 400) } }));
        return mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, priceTierAppliedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: '最低价/销售价/划线价已提交，等待平台回读确认' } }));
      }
      const verified = await readCreatedOnlineProducts(current.item, state, call);
      if (!verified.ready) return mutate(draft => ({ ...draft, ozonCreate: { ...draft.ozonCreate, verificationLastReason: text(verified.reason || 'Ozon暂未返回可查询的商品详情').slice(0, 300), lastCheckedAt: new Date().toISOString(), updatedAt: draft.ozonCreate.updatedAt } }));
      const finalPhase = text(state.failedMessage) ? 'failed' : 'confirmed';
      return mutate(draft => ({ ...draft, ozonCreate: {
        ...draft.ozonCreate,
        phase: finalPhase,
        skus: verified.products.map(product => text(product && product.sku)),
        platformNames: verified.products.map(product => text(product && product.name)),
        platformImages: verified.products.map(product => text(product && (product.img || product.image))),
        platformStatuses: verified.products.map(product => text(product && product.status)),
        platformCreatedAts: verified.products.map(product => text(product && product.createdAt)),
        platformUpdatedAts: verified.products.map(product => text(product && product.updatedAt)),
        updatedAt: new Date().toISOString(),
        message: finalPhase === 'confirmed'
          ? '新增成功，已从 Ozon 回读在线商品数据'
          : text(draft.ozonCreate.failedMessage) || '部分货号新增失败；已成功货号已写入在线商品'
      } }), { confirmedProducts: verified.products });
    }
    return current;
  }
  throw problem('invalid_product_action', '不支持的新增商品操作');
}

module.exports = { DRAFT_KEY, LISTING_RECORD_KEY, SERVER_LIMIT, DRAFT_RETENTION_MS, problem, revision, normalizeDraft, normalizeRelistSource, validateRelistSourceDraft, buildImport, active, retentionInfo, pruneDrafts, visibleDrafts, confirmedLocalFields, mergeListingRecords, queueTask, limitDrafts, enqueue, execute };
