'use strict';
const { validateImportAttributes } = require('./product-attribute-validation');

const crypto = require('crypto');
const { validateSupplierUrl } = require('./business-boundaries');
const detailData = require('../assets/product-detail-data');
const combination = require('../assets/product-combination');
const arr = value => Array.isArray(value) ? value : [];
const revision = item => crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');
function problem(code, message, status = 400) { return Object.assign(new Error(message), { publicCode: code, status }); }
function amount(value, label, required = false) {
  if (value != null && typeof value !== 'string' && typeof value !== 'number') throw problem('invalid_product_amount', label + '必须是金额文本或数字');
  const text = value == null ? '' : String(value).trim();
  if (!text && !required) return null;
  if (!/^(?:\d{1,14}(?:\.\d{1,2})?|\.\d{1,2})$/.test(text) || (required && Number(text) <= 0)) {
    throw problem('invalid_product_amount', label + '必须为有效的非负金额，最多两位小数；售价必须大于零');
  }
  return text;
}
function httpsResourceUrl(value, label) {
  const raw = String(value || '').trim(); if (!raw) return '';
  if (/^\/api\/private-objects\/(?:sku-images|combination-references)\/[0-9a-f-]{36}$/i.test(raw)) return raw;
  let url; try { url = new URL(raw); } catch (_) { throw problem('invalid_product_costs', label + '必须是HTTPS地址或系统私有图片地址'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || raw.length > 2048) throw problem('invalid_product_costs', label + '必须是HTTPS地址或系统私有图片地址');
  return raw;
}
const BUNDLE_KEYS = new Set(['id','collectionId','collection_id','sourceId','title','name','sourceUrl','url','srcUrl','purchase','srcPrice','domesticShipping','purchaseCostOverride','internationalShipping','referenceImage','reference_image','imageCandidates','images','selectedVariantIds','variantIds','selectedVariants','sourceSnapshot','createdAt','updatedAt','lastCombinedAt']);
const RELATION_KEYS = new Set(['id','relationId','parentRef','childRef','childCollectionRef','childCollectionId','quantity','createdAt','updatedAt','lastCombinedAt']);
const HISTORY_KEYS = new Set(['id','eventId','relationId','parentRef','childRef','childCollectionId','action','occurredAt','source','operatorUserId']);
function safePrivateTree(value, depth = 0) {
  if (depth > 12) throw problem('invalid_product_costs', '组合货源快照嵌套过深');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (['__proto__','prototype','constructor','apiKey','api_key','token','password','secret','permissions','tenantId','userId'].includes(key)) throw problem('invalid_product_costs', '组合货源快照包含不允许保存的字段');
    safePrivateTree(child, depth + 1);
  }
}
function sourceBundleList(value, hosts) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 200) throw problem('invalid_product_costs', '组合货源最多200组');
  if (value.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !BUNDLE_KEYS.has(key)))) throw problem('invalid_product_costs', '组合货源包含不支持字段');
  return combination.normalizeBundles(value).map((entry, index) => {
    const sourceUrl = entry.sourceUrl ? validateSupplierUrl(entry.sourceUrl, hosts) : '';
    const referenceImage = httpsResourceUrl(entry.referenceImage, '第' + (index + 1) + '组参考图');
    const imageCandidates = arr(entry.imageCandidates).slice(0, 60).map((url, imageIndex) => httpsResourceUrl(url, '第' + (index + 1) + '组第' + (imageIndex + 1) + '张候选图')).filter(Boolean);
    const snapshot = entry.sourceSnapshot == null ? null : entry.sourceSnapshot;
    if (snapshot != null && (typeof snapshot !== 'object' || Array.isArray(snapshot) || Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > 250000)) throw problem('invalid_product_costs', '组合货源快照格式不正确或过大');
    if (snapshot != null) safePrivateTree(snapshot);
    return { id: entry.id, collectionId: entry.collectionId, title: entry.title, sourceUrl, url: sourceUrl, purchase: amount(entry.purchase, '第' + (index + 1) + '组采购价'), domesticShipping: amount(entry.domesticShipping, '第' + (index + 1) + '组国内快递费'), purchaseCostOverride: amount(entry.purchaseCostOverride, '第' + (index + 1) + '组采购成本'), internationalShipping: amount(entry.internationalShipping, '第' + (index + 1) + '组国际运费'), referenceImage, imageCandidates, selectedVariantIds: combination.uniqueStrings(entry.selectedVariantIds || []), sourceSnapshot: snapshot, createdAt: entry.createdAt, updatedAt: entry.updatedAt, lastCombinedAt: entry.lastCombinedAt };
  });
}
function relationList(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 2000) throw problem('invalid_product_costs', '组合关系数量超过上限');
  if (value.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !RELATION_KEYS.has(key)))) throw problem('invalid_product_costs', '组合关系包含不支持字段');
  const graph = combination.validateGraph(value);
  if (!graph.ok) throw problem(graph.code === 'combination_cycle' ? 'combination_cycle' : 'invalid_combination_relation', graph.code === 'combination_cycle' ? '组合关系存在循环：' + graph.path.join(' → ') : '组合关系包含重复或无效关联', 409);
  return graph.relations;
}
function historyList(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 5000) throw problem('invalid_product_costs', '组合历史数量超过上限');
  if (value.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !HISTORY_KEYS.has(key)))) throw problem('invalid_product_costs', '组合历史包含不支持字段');
  return combination.normalizeHistory(value);
}
function costs(input, hosts) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('invalid_product_costs', '缺少货源与成本资料');
  const allowed = ['purchasePrice', 'srcPrice', 'domesticShipping', 'srcUrl', 'srcNote', 'collectionId', 'erpVariantRef', 'sourceBundleIds', 'sourceBundles', 'combinationRelations', 'combinationHistory', 'manualVariantAttributes', 'suppressedVariantAttributes'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw problem('invalid_product_costs', '成本命令不接受平台字段');
  for (const key of ['manualVariantAttributes','suppressedVariantAttributes']) if (Object.prototype.hasOwnProperty.call(input,key) && (!Array.isArray(input[key]) || input[key].length > 1000 || input[key].some(value => typeof value !== 'string' || value.length > 160))) throw problem('invalid_product_costs', '变体表列配置不正确');
  const result = { purchasePrice: amount(input.purchasePrice, '采购价'), srcPrice: amount(input.srcPrice, '货源价'),
    domesticShipping: amount(input.domesticShipping, '国内快递费'), srcUrl: validateSupplierUrl(input.srcUrl, hosts),
    srcNote: String(input.srcNote || '').slice(0, 1000) };
  if (Object.prototype.hasOwnProperty.call(input, 'collectionId')) { const id = String(input.collectionId || '').trim(); if (id && !/^[A-Za-z0-9._:-]{1,200}$/.test(id)) throw problem('invalid_product_costs', '采集箱关联编号不正确'); result.collectionId = id; }
  if (Object.prototype.hasOwnProperty.call(input, 'sourceBundles')) result.sourceBundles = sourceBundleList(input.sourceBundles, hosts);
  if (Object.prototype.hasOwnProperty.call(input, 'erpVariantRef')) { const ref = String(input.erpVariantRef || '').trim(); if (!/^erv_[A-Za-z0-9_-]{6,220}$/.test(ref)) throw problem('invalid_product_costs', 'SKU内部组合标识不正确'); result.erpVariantRef = ref; }
  if (Object.prototype.hasOwnProperty.call(input, 'sourceBundleIds')) { if (!Array.isArray(input.sourceBundleIds) || input.sourceBundleIds.length > 200 || input.sourceBundleIds.some(value => typeof value !== 'string' || !value.trim() || value.length > 240)) throw problem('invalid_product_costs', 'SKU组合关联格式不正确'); result.sourceBundleIds = combination.uniqueStrings(input.sourceBundleIds); }
  if (Object.prototype.hasOwnProperty.call(input, 'combinationRelations')) result.combinationRelations = relationList(input.combinationRelations);
  if (Object.prototype.hasOwnProperty.call(input, 'combinationHistory')) result.combinationHistory = historyList(input.combinationHistory);
  if (Object.prototype.hasOwnProperty.call(input, 'manualVariantAttributes')) result.manualVariantAttributes = input.manualVariantAttributes.slice();
  if (Object.prototype.hasOwnProperty.call(input, 'suppressedVariantAttributes')) result.suppressedVariantAttributes = input.suppressedVariantAttributes.slice();
  return result;
}
function attribute(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.values)) throw problem('invalid_product_attribute', '属性值必须是数组');
  const id = Number(a.id), complex = Number(a.complex_id || a.complexId || 0);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(complex) || complex < 0) throw problem('invalid_product_attribute', '属性编号无效');
  return { id, complex_id: complex, values: arr(a.values).map(v => {
    const dictionary = Number(v.dictionary_value_id || 0);
    if (!Number.isSafeInteger(dictionary) || dictionary < 0) throw problem('invalid_product_attribute', '属性选项编号无效');
    return { dictionary_value_id: dictionary, value: String(v.value == null ? '' : v.value) };
  }) };
}
function changes(input) {
  const allowed = ['name', 'barcode', 'weight', 'depth', 'width', 'height', 'price', 'old_price', 'min_price', 'attributes'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(k => !allowed.includes(k))) {
    throw problem('invalid_product_changes', '商品更新仅接受可编辑的平台字段，不接受成本、店铺、货号或平台编号');
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'attributes') {
      if (!Array.isArray(value)) throw problem('invalid_product_attribute', '属性必须是数组');
      out.attributes = value.map(attribute);
      if (out.attributes.some(a => a.id === 9024)) throw problem('product_attribute_readonly', '卖家代码由平台货号确定，不能作为普通属性修改');
      continue;
    }
    if (['weight', 'depth', 'width', 'height'].includes(key)) {
      if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0 || Number(value) > 1000000) throw problem('invalid_product_measure', '包装重量和尺寸必须为大于零的整数（克/毫米）');
      out[key] = Number(value);
    } else if (['price', 'old_price', 'min_price'].includes(key)) out[key] = amount(value, key === 'price' ? '销售价' : key === 'old_price' ? '划线价' : '最低价', key === 'price' || key === 'min_price') || '0';
    else { out[key] = String(value == null ? '' : value).trim(); if (key === 'name' && (!out[key] || out[key].length > 500)) throw problem('invalid_product_name', '商品标题必须为 1–500 个字符'); }
  }
  return out;
}
function find(data, id) {
  return arr(data && (data.items || data.result && data.result.items || data.result)).find(x => String(x.id || x.product_id) === String(id));
}
function buildImport(info, details, price, patch, imageUrls) {
  if (!info || !details || !price || !info.offer_id || info.offer_id !== details.offer_id) throw problem('product_snapshot_incomplete', '平台资料未完整加载或货号已变更，未提交修改', 409);
  const currentPrice = price.price || {};
  const item = { offer_id: info.offer_id, description_category_id: Number(details.description_category_id || info.description_category_id), type_id: Number(details.type_id || info.type_id),
    name: info.name, barcode: details.barcode || arr(info.barcodes).join(';'),
    depth: Number(detailData.measure(details.depth, details.dimension_unit, 'dimension')), width: Number(detailData.measure(details.width, details.dimension_unit, 'dimension')),
    height: Number(detailData.measure(details.height, details.dimension_unit, 'dimension')), weight: Number(detailData.measure(details.weight, details.weight_unit, 'weight')),
    dimension_unit: 'mm', weight_unit: 'g', price: String(currentPrice.price || info.price || ''), old_price: String(currentPrice.old_price || info.old_price || '0'),
    currency_code: 'CNY', vat: currentPrice.vat == null ? info.vat : String(currentPrice.vat),
    images: detailData.images(info.images), primary_image: detailData.images(info.primary_image)[0] || '', color_image: detailData.images(info.color_image)[0] || '' };
  if (Array.isArray(imageUrls) && imageUrls.length) {
    if (imageUrls.length > 15) throw problem('ozon_image_limit_reached', 'Ozon 当前图片接口单个商品最多接收15张图片，请删除多余图片后再确定编辑', 409);
    if (imageUrls.some(url => !/^https:\/\//i.test(String(url || '')))) throw problem('sku_image_publish_url_invalid', '待提交 Ozon 的图片地址无效，请重新保存图片后再试', 409);
    item.primary_image = String(imageUrls[0]);
    item.images = imageUrls.slice(1).map(String);
  }
  // Keep unedited media/complex groups from Ozon, never from the browser's cached rows.
  const allAttributes = arr(details.attributes).map(attribute);
  item.attributes = allAttributes.filter(a => !a.complex_id);
  const explicitGroups = arr(details.complex_attributes).filter(group => Array.isArray(group.attributes)).map(group => ({ ...group, attributes: group.attributes.map(attribute) }));
  const explicitKeys = new Set(explicitGroups.flatMap(group => group.attributes.map(a => a.id + ':' + a.complex_id)));
  const complex = allAttributes.filter(a => a.complex_id && !explicitKeys.has(a.id + ':' + a.complex_id)).concat(arr(details.complex_attributes).filter(group => !Array.isArray(group.attributes) && group.id).map(attribute));
  const groups = new Map();
  for (const a of complex) { if (!groups.has(a.complex_id)) groups.set(a.complex_id, []); groups.get(a.complex_id).push(a); }
  item.complex_attributes = explicitGroups.concat([...groups.values()].map(attributes => ({ attributes })));
  if (details.pdf_list !== undefined) item.pdf_list = arr(details.pdf_list).map((pdf, index) => ({ index, name: String(pdf.name || ''), src_url: String(pdf.file_name || pdf.src_url || '') }));
  if (info.geo_names !== undefined) item.geo_names = info.geo_names;
  const byKey = a => a.id + ':' + a.complex_id;
  for (const a of patch.attributes || []) {
    if (a.complex_id) throw problem('complex_attribute_edit_unsupported', '当前表单暂不支持修改复合媒体属性；原有视频会保留');
    const index = item.attributes.findIndex(x => byKey(x) === byKey(a));
    if (index < 0) item.attributes.push(a); else item.attributes[index] = a;
  }
  for (const [key, value] of Object.entries(patch)) if (key !== 'attributes' && key !== 'min_price') item[key] = value;
  if (!item.currency_code || item.vat == null || !item.description_category_id || !item.type_id || !item.price || !item.name || !item.images.length && !item.primary_image) {
    throw problem('product_snapshot_incomplete', '平台币种、税率、类目、图片或价格信息不完整，未提交修改', 409);
  }
  changes({ weight: item.weight, depth: item.depth, width: item.width, height: item.height, price: item.price, old_price: item.old_price });
  if (Number(item.old_price) !== 0 && Number(item.old_price) < Number(item.price)) throw problem('invalid_product_amount', '划线价不能低于售价，可填 0 表示不设划线价');
  return { items: [item] };
}
function priceTierUpdatePayload(target, patch, price) {
  if (!patch || patch.min_price == null) return null;
  const current = price && price.price || {};
  const sale = String(patch.price != null ? patch.price : current.price || '').trim();
  const oldPrice = String(patch.old_price != null ? patch.old_price : current.old_price || '0').trim();
  const minPrice = String(patch.min_price).trim();
  const saleNumber = Number(sale), oldNumber = Number(oldPrice), minNumber = Number(minPrice);
  if (!(saleNumber > 0 && minNumber > 0 && minNumber < saleNumber && minNumber * 2 >= saleNumber && (oldNumber === 0 || oldNumber > saleNumber))) {
    throw problem('invalid_product_amount', '最低价、销售价或划线价不符合平台要求', 409);
  }
  return {
    product_id: Number(target.productId),
    price: sale,
    old_price: oldPrice,
    min_price: minPrice,
    currency_code: 'CNY'
  };
}

function priceTierUpdateFailure(response) {
  const rows = arr(response && response.result);
  const failed = rows.find(row => !row || row.updated !== true);
  if (!failed) return '';
  return arr(failed.errors).map(error => String(error && (error.message || error.code) || '').trim()).filter(Boolean).join('；') || 'Ozon未确认三价更新';
}

function projectConfirmed(local, info, details, price) {
  const p = price.price || {};
  const next = detailData.refresh(local, { ...info, min_price: p.min_price || info.min_price, price: p.price || info.price, old_price: p.old_price || info.old_price }, details);
  next.offer_id = info.offer_id; next.article = info.offer_id;
  next.weight = require('../assets/online-product-format').weight(next.weightG, 'g');
  next.weightValue = next.weightG; next.weightUnit = 'g';
  next.platformSyncedAt = new Date().toISOString();
  return next;
}
function reflected(patch, info, details, price) {
  const actual = { name: info.name, barcode: details.barcode || arr(info.barcodes).join(';'),
    weight: Number(detailData.measure(details.weight, details.weight_unit, 'weight')),
    depth: Number(detailData.measure(details.depth, details.dimension_unit, 'dimension')),
    width: Number(detailData.measure(details.width, details.dimension_unit, 'dimension')),
    height: Number(detailData.measure(details.height, details.dimension_unit, 'dimension')),
    price: price.price && price.price.price, old_price: price.price && price.price.old_price, min_price: price.price && price.price.min_price };
  return Object.entries(patch || {}).every(([key, value]) => {
    if (key === 'attributes') return value.every(a => {
      const live = arr(details.attributes).find(x => Number(x.id) === a.id && Number(x.complex_id || 0) === a.complex_id);
      const canonical = values => arr(values).map(v => Number(v.dictionary_value_id) > 0 ? 'id:' + v.dictionary_value_id : 'text:' + String(v.value == null ? '' : v.value)).sort();
      return JSON.stringify(canonical(live && live.values)) === JSON.stringify(canonical(a.values));
    });
    return ['price', 'old_price', 'min_price', 'weight', 'depth', 'width', 'height'].includes(key) ? Number(value) === Number(actual[key]) : String(value) === String(actual[key]);
  });
}
function liveImageCount(info) {
  const urls = [];
  const append = value => { for (const url of detailData.images(value)) if (url && !urls.includes(url)) urls.push(url); };
  append(info && info.primary_image);
  append(info && info.images);
  return urls.length;
}
function differences(patch, info, details, price) {
  const missing = [];
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === 'attributes') {
      for (const a of value) if (!reflected({ attributes: [a] }, info, details, price)) missing.push('属性 ' + a.id);
    } else if (!reflected({ [key]: value }, info, details, price)) missing.push(key);
  }
  return missing;
}
const active = state => state && ['queued', 'preparing', 'submitting', 'pending', 'unknown'].includes(state.phase);

function queueTask(item) {
  const state = item.ozonEdit;
  if (!state || !state.queueId) return null;
  const labels = { queued: '已入队，等待服务端处理', preparing: '正在读取平台原资料', submitting: '正在提交 Ozon', pending: 'Ozon 处理中，等待回读确认', confirmed: '修改成功，已回读确认', failed: '修改失败', partial: '部分字段未生效', unknown: '结果未确定，需要核对，禁止重复提交' };
  const running = ['queued', 'preparing', 'submitting', 'pending'].includes(state.phase);
  return { id: state.queueId, type: 'edit', name: '商品编辑：' + String(item.name || item.article || item.id || ''), article: item.article || item.offer_id, sku: item.sku,
    startedAt: state.enqueuedAt, status: running ? 'running' : state.phase === 'confirmed' ? 'done' : 'failed',
    value: ({ queued: 0, preparing: 10, submitting: 35, pending: 65, confirmed: 100 })[state.phase] || 0,
    label: state.phase === 'confirmed' && !Object.keys(state.changes || {}).length && !state.imageSync ? '成本与货源已保存，未调用 Ozon' : labels[state.phase] || '等待核对', reason: running || state.phase === 'confirmed' ? '' : state.message || labels[state.phase] };
}

async function enqueue({ store, account, target, input, hosts, idempotencyKey, imagePublisher }) {
  const local = costs(input.costs, hosts);
  const patch = input.changes && Object.keys(input.changes).length ? changes(input.changes) : {};
  const current = await store.getEditableProduct(account, target);
  if (local.erpVariantRef) {
    const currentVariants = arr(current.item && current.item.variants), persistedRef = String(currentVariants[0] && currentVariants[0].erpVariantRef || current.item && current.item.erpVariantRef || '').trim();
    if (persistedRef && persistedRef !== local.erpVariantRef) throw problem('combination_variant_identity_conflict', '当前SKU内部组合标识已经固定，不能改成另一个标识；请刷新商品后重试。', 409);
    const persistedCollectionId = String(current.item && current.item.collectionId || '').trim();
    if (persistedCollectionId && local.collectionId && persistedCollectionId !== local.collectionId) throw problem('combination_collection_identity_conflict', '当前SKU已经绑定其它采集箱来源，不能自动改绑；请刷新商品后核对来源。', 409);
    if (!persistedCollectionId && local.collectionId) {
      const collectionDocument = await store.getDocument(account, 'erp_collected_products'), rows = collectionDocument && Array.isArray(collectionDocument.payload) ? collectionDocument.payload : [];
      const source = rows.find(row => String(row && row.id || '').trim() === local.collectionId), persistedUrl = String(current.item && (current.item.srcUrl || current.item.sourceUrl || current.item.supplierUrl) || '').trim();
      if (!source) throw problem('collection_source_missing', '关联的采集箱来源记录不存在，不能建立商品组合身份。', 409);
      if (!persistedUrl || String(source.sourceUrl || '').trim() !== persistedUrl) throw problem('collection_source_mismatch', '采集箱来源与商品已有主货源不一致，不能自动建立组合身份。', 409);
    }
    const combinationStore = require('./product-combination-store'), document = await store.getDocument(account, combinationStore.DOCUMENT_KEY), parentRef = 'variant:' + local.erpVariantRef;
    const built = combinationStore.buildReplacement(document && document.payload, [parentRef], local.combinationRelations || [], account, '商品编辑');
    combinationStore.replaceAliases(built.payload, local.collectionId ? [{ collectionId: local.collectionId, variantRef: local.erpVariantRef }] : []);
  }
  const requestedVariantRef = String(input.imageVariantRef || '').trim();
  if (requestedVariantRef && !/^[A-Za-z0-9._:-]{1,180}$/.test(requestedVariantRef)) throw problem('invalid_sku_image_variant', '图片规格标识不正确，请重新打开商品后再确定编辑', 400);
  const pendingImage = current.item && current.item.skuImageOzonPending;
  const variantRef = requestedVariantRef || String(pendingImage && pendingImage.variantRef || '').trim();
  let imageSync = null;
  if (variantRef) {
    const snapshot = await store.getSkuImageSyncSnapshot(account, { ...target, variantRef });
    if (!snapshot.items.length) throw problem('sku_image_sync_empty', '当前SKU没有可提交到 Ozon 的服务器图片，请重新打开图片编辑后保存', 409);
    if (snapshot.items.length > 15) throw problem('ozon_image_limit_reached', 'Ozon 当前图片接口单个商品最多接收15张图片，请删除多余图片后再确定编辑', 409);
    if (snapshot.hash !== String(current.item.ozonImageSyncHash || '')) imageSync = snapshot;
    if (imageSync) {
      if (typeof imagePublisher !== 'function') throw problem('sku_image_publish_unavailable', '图片发布通道未就绪，不能把图片提交到 Ozon', 503);
      await imagePublisher(imageSync.items);
    }
  }
  const hasPlatformWork = Boolean(Object.keys(patch).length || imageSync);
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw problem('idempotency_key_required', '缺少稳定提交编号');
  const namespace = 'product-edit-queue:' + target.clientId + ':' + target.productId;
  const claim = await store.claimIdempotency(account, namespace, idempotencyKey, revision({ target, patch, local, imageSync: imageSync && { variantRef: imageSync.variantRef, hash: imageSync.hash }, actor: account.userId }));
  if (claim.state === 'conflict') throw problem('idempotency_key_conflict', '同一提交编号不能用于不同内容', 409);
  if (claim.state !== 'claimed') {
    const replay = await store.getEditableProduct(account, target);
    const state = replay.item.ozonEdit;
    const queueId = claim.body && claim.body.queueId || state && state.key === idempotencyKey && state.queueId;
    if (!queueId) throw problem('product_enqueue_pending', '正在确认入队结果，请保留当前页面稍后重试', 409);
    return { ...replay, queueTaskId: queueId };
  }
  let saved;
  try {
    const combinationParentRefs = local.erpVariantRef ? ['variant:' + local.erpVariantRef] : [];
    const combinationAliases = local.collectionId && local.erpVariantRef ? [{ collectionId: local.collectionId, variantRef: local.erpVariantRef }] : [];
    saved = await store.mutateEditableProduct(account, target, input.revision, item => {
      if (active(item.ozonEdit)) throw problem('product_edit_pending', '已有商品编辑任务，请在任务中心查看结果', 409);
      const now = new Date().toISOString();
      return { ...item, ...local, editorDraft: hasPlatformWork ? item.editorDraft : undefined, variants: arr(item.variants).map((v, i) => i ? v : { ...v, purchase: local.purchasePrice, domesticShipping: local.domesticShipping, ...(local.erpVariantRef ? { erpVariantRef: local.erpVariantRef } : {}), ...(local.sourceBundleIds ? { sourceBundleIds: local.sourceBundleIds.slice() } : {}) }),
        ozonEdit: { key: idempotencyKey, queueId: 'product-edit-' + crypto.randomUUID(), actorUserId: account.userId, actorUsername: account.username,
          draftId: item.editorDraft && item.editorDraft.id,
          phase: hasPlatformWork ? 'queued' : 'confirmed', changes: patch, imageSync: imageSync || undefined, enqueuedAt: now, updatedAt: now,
          message: hasPlatformWork ? '已加入任务中心，服务端将继续提交商品与图片变更' : '成本与货源已保存，平台字段与图片均未改动，未调用 Ozon' } };
    }, combinationParentRefs.length ? { combinationReplacement: { parentRefs: combinationParentRefs, relations: local.combinationRelations || [], aliases: combinationAliases, source: '商品编辑' } } : {});
  } catch (error) { await store.failIdempotency(account, namespace, idempotencyKey); throw error; }
  await store.completeIdempotency(account, namespace, idempotencyKey, 202, { queueId: saved.item.ozonEdit.queueId }).catch(() => {});
  return { ...saved, queueTaskId: saved.item.ozonEdit.queueId };
}

// Writes are never automatically repeated. Persist before dispatch; an uncertain
// transport outcome blocks further submits until an operator reconciles it.
async function execute({ store, account, target, input, call, hosts, idempotencyKey, imagePublisher }) {
  const get = () => store.getEditableProduct(account, target);
  const mutate = (expected, fn) => store.mutateEditableProduct(account, target, expected, fn);
  if (input.action === 'draft') {
    if (typeof input.revision !== 'string' || !input.revision) throw problem('product_version_required', '保存草稿需要当前商品版本');
    const draft = require('./product-draft').normalize(input.draft, account);
    const variantRef = String(input.imageVariantRef || '').trim();
    if (variantRef && !/^[A-Za-z0-9._:-]{1,180}$/.test(variantRef)) throw problem('invalid_sku_image_variant', '图片规格标识不正确，请重新打开商品后再保存', 400);
    let imagePending = null;
    if (variantRef) {
      const snapshot = await store.getSkuImageSyncSnapshot(account, { ...target, variantRef });
      if (!snapshot.items.length) throw problem('sku_image_sync_empty', '当前SKU没有可提交的服务器图片，请重新打开图片编辑后保存', 409);
      imagePending = { variantRef, hash: snapshot.hash, count: snapshot.items.length, updatedAt: new Date().toISOString() };
    }
    return store.mutateEditableProduct(account, target, input.revision, item => ({ ...item, editorDraft: draft, ...(imagePending ? { skuImageOzonPending: imagePending } : {}) }), { draftOnly: true });
  }
  if (input.action === 'costs') {
    const local = costs(input.costs, hosts);
    return mutate(input.revision, item => ({ ...item, ...local, variants: arr(item.variants).map((v, i) => i ? v : { ...v, purchase: local.purchasePrice, domesticShipping: local.domesticShipping, ...(local.erpVariantRef ? { erpVariantRef: local.erpVariantRef } : {}), ...(local.sourceBundleIds ? { sourceBundleIds: local.sourceBundleIds.slice() } : {}) }) }));
  }
  async function snapshot() {
    const id = Number(target.productId);
    const info = find(await call('/v3/product/info/list', { product_id: [String(id)] }), id);
    const details = find(await call('/v4/product/info/attributes', { filter: { product_id: [String(id)], visibility: 'ALL' }, limit: 100 }), id);
    const price = find(await call('/v5/product/info/prices', { filter: { product_id: [String(id)], visibility: 'ALL' }, limit: 100 }), id);
    if (!info || !details || !price) throw problem('product_snapshot_incomplete', 'Ozon 未返回完整的所选商品资料', 409);
    return { info, details, price };
  }
  if (input.action === 'submit' || input.action === 'runQueued') {
    const queued = input.action === 'runQueued' ? (await get()).item.ozonEdit : null;
    if (queued && (!['queued', 'preparing'].includes(queued.phase) || queued.queueId !== input.queueId)) return get();
    if (input.action === 'runQueued' && !queued) return get();
    const patchInput = queued ? queued.changes : input.changes;
    const patch = patchInput && Object.keys(patchInput).length ? changes(patchInput) : {};
    const imageSync = queued ? queued.imageSync : input.imageSync || null;
    if (!Object.keys(patch).length && !imageSync) throw problem('invalid_product_changes', '没有需要提交到 Ozon 的商品或图片变更');
    if (queued) idempotencyKey = queued.key;
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw problem('idempotency_key_required', '缺少稳定提交编号');
    const namespace = 'product-edit:' + target.clientId + ':' + target.productId;
    const claim = queued ? { state: 'claimed' } : await store.claimIdempotency(account, namespace, idempotencyKey, revision({ target, patch, imageSync: imageSync && { variantRef: imageSync.variantRef, hash: imageSync.hash } }));
    if (claim.state === 'conflict') throw problem('idempotency_key_conflict', '同一提交编号不能用于不同内容', 409);
    if (claim.state !== 'claimed') return get();
    let reserved = false, dispatched = false;
    try {
      await mutate(queued ? null : input.revision, item => {
        if (queued ? !item.ozonEdit || item.ozonEdit.queueId !== queued.queueId || !['queued','preparing'].includes(item.ozonEdit.phase) : active(item.ozonEdit)) throw problem('product_edit_pending', '已有平台更新待确认，请查询结果，不要重复提交', 409);
        return { ...item, ozonEdit: { ...(queued || {}), key: idempotencyKey, phase: 'preparing', changes: patch, imageSync: imageSync || undefined, updatedAt: new Date().toISOString() } };
      });
      reserved = true;
      const { info, details, price } = await snapshot();
      if (imageSync && typeof imagePublisher !== 'function') throw problem('sku_image_publish_unavailable', '图片发布通道未就绪，不能把图片提交到 Ozon', 503);
      const imageUrls = imageSync ? await imagePublisher(imageSync.items) : null;
      const body = buildImport(info, details, price, patch, imageUrls);
      if (Object.keys(patch).length) await validateImportAttributes(body, { call });
      await mutate(null, item => ({ ...item, ozonEdit: { ...item.ozonEdit, phase: 'submitting', offerId: info.offer_id } }));
      dispatched = true;
      const response = await call('/v3/product/import', body);
      const taskId = response && response.result && response.result.task_id;
      if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) <= 0) throw problem('ozon_invalid_response', 'Ozon 未返回有效任务编号', 502);
      const submittedAt = new Date().toISOString();
      const saved = await mutate(null, item => ({ ...item, ozonEdit: { ...item.ozonEdit, taskId: Number(taskId), phase: 'pending', platformSubmittedAt: submittedAt, pollAttempt: 0, nextCheckAt: new Date(Date.parse(submittedAt) + 3000).toISOString(), confirmDeadlineAt: new Date(Date.parse(submittedAt) + 60000).toISOString() } }));
      await store.completeIdempotency(account, namespace, idempotencyKey, 200, { taskId });
      return saved;
    } catch (error) {
      if (!reserved) { await store.failIdempotency(account, namespace, idempotencyKey); throw error; }
      const phase = dispatched && !error.definiteRejection ? 'unknown' : 'failed';
      const saved = await mutate(null, item => ({ ...item, ozonEdit: { ...item.ozonEdit, phase, message: phase === 'unknown' ? '提交结果不确定，禁止重复提交；请核对 Ozon 后处理' : String(error.message).slice(0, 300) } }));
      await store.completeIdempotency(account, namespace, idempotencyKey, 200, { phase });
      return saved;
    }
  }
  if (input.action === 'status') {
    const current = await get(), state = current.item.ozonEdit;
    if (!state || !['pending', 'partial'].includes(state.phase)) return current;
    const result = await call('/v1/product/import/info', { task_id: state.taskId });
    const row = arr(result && result.result && result.result.items).find(x => x.offer_id === state.offerId && (!x.product_id || String(x.product_id) === target.productId));
    if (!row || row.status === 'pending') return current;
    const failed = row.status === 'failed' || arr(row.errors).length > 0;
    if (!failed && !['imported', 'skipped'].includes(row.status)) return current;
    const live = failed ? null : await snapshot();
    if (live && state.changes && state.changes.min_price != null && !state.priceTierAppliedAt) {
      if (state.priceTierDispatchStartedAt) {
        return mutate(null, item => ({ ...item, ozonEdit: { ...state, phase: 'unknown', updatedAt: new Date().toISOString(), message: '最低价/销售价/划线价提交结果不确定，已停止自动重发，请核对Ozon价格' } }));
      }
      const tierPayload = priceTierUpdatePayload(target, state.changes, live.price);
      const startedAt = new Date().toISOString();
      await mutate(null, item => ({ ...item, ozonEdit: { ...state, priceTierDispatchStartedAt: startedAt, message: '商品字段已处理，正在写入最低价/销售价/划线价' } }));
      let tierResponse;
      try {
        tierResponse = await call('/v1/product/import/prices', { prices: [tierPayload] });
      } catch (error) {
        const phase = error && error.definiteRejection ? 'failed' : 'unknown';
        return mutate(null, item => ({ ...item, ozonEdit: { ...state, priceTierDispatchStartedAt: startedAt, phase, updatedAt: new Date().toISOString(), message: phase === 'failed' ? 'Ozon三价更新失败：' + String(error.message || '').slice(0, 300) : '三价提交结果不确定，已停止自动重发，请核对Ozon价格' } }));
      }
      const tierFailure = priceTierUpdateFailure(tierResponse);
      if (tierFailure) return mutate(null, item => ({ ...item, ozonEdit: { ...state, priceTierDispatchStartedAt: startedAt, phase: 'failed', updatedAt: new Date().toISOString(), message: 'Ozon三价更新失败：' + tierFailure.slice(0, 300) } }));
      return mutate(null, item => ({ ...item, ozonEdit: { ...state, priceTierDispatchStartedAt: startedAt, priceTierAppliedAt: new Date().toISOString(), pollAttempt: 0, nextCheckAt: new Date(Date.now() + 3000).toISOString(), message: '最低价/销售价/划线价已提交，等待平台回读确认' } }));
    }
    const mismatch = live ? differences(state.changes, live.info, live.details, live.price) : [];
    if (live && state.imageSync && liveImageCount(live.info) !== Number(state.imageSync.items && state.imageSync.items.length || 0)) mismatch.push('图片数量');
    // Imported is not proof every requested field took effect. Allow a bounded
    // propagation window, then persist the actual values and name discrepancies.
    if (mismatch.length && Date.now() - Date.parse(state.platformSubmittedAt || state.updatedAt) < 60000) {
      return mutate(null, item => ({ ...item, ozonEdit: { ...state, lastMismatchFields: mismatch, message: '等待 Ozon 回读生效：' + mismatch.join('、') } }));
    }
    return mutate(null, item => {
      if (!item.ozonEdit || item.ozonEdit.key !== state.key || !['pending', 'partial'].includes(item.ozonEdit.phase)) return item;
      const next = failed ? item : projectConfirmed(item, live.info, live.details, live.price);
      if (!failed && !mismatch.length && state.draftId && next.editorDraft && next.editorDraft.id === state.draftId) delete next.editorDraft;
      if (!failed && !mismatch.length && state.imageSync) {
        next.ozonImageSyncHash = state.imageSync.hash;
        if (next.skuImageOzonPending && next.skuImageOzonPending.variantRef === state.imageSync.variantRef) delete next.skuImageOzonPending;
      }
      return { ...next, ozonEdit: { ...state, phase: failed ? 'failed' : mismatch.length ? 'partial' : 'confirmed', mismatchedFields: mismatch, message: failed ? arr(row.errors).map(e => String(e.message || e.code || '平台处理失败')).join('；').slice(0, 500) : mismatch.length ? 'Ozon 已完成处理，但回读未与提交一致：' + mismatch.join('、') + '；已保存平台实际值，请重新打开后编辑' : state.imageSync ? 'Ozon 已完成商品与图片处理，已回读平台资料（展示仍受审核与平台缓存影响）' : 'Ozon 已完成处理，已回读平台资料（展示仍受审核与平台缓存影响）', updatedAt: new Date().toISOString() } };
    });
  }
  throw problem('invalid_product_action', '不支持的商品编辑操作');
}
module.exports = { revision, problem, amount, costs, changes, buildImport, projectConfirmed, reflected, differences, liveImageCount, execute, active, enqueue, queueTask };
