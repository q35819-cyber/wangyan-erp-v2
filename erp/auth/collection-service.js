'use strict';

const contract = require('../assets/collection-contract');
const DOCUMENT_KEY = 'erp_collected_products';

function problem(code, message, status = 400) {
  return Object.assign(new Error(message), { publicCode: code, status });
}
function listPayload(document) {
  const payload = document && document.payload;
  if (payload == null) return [];
  if (!Array.isArray(payload) || payload.length > 10000) throw problem('collection_document_invalid', '采集箱数据格式不正确，请刷新后重试。', 409);
  return payload;
}
function collectorLabel(account) {
  if (!account) return '';
  if (account.isSystemAdmin) return '系统管理员';
  return String(account.profileFullName || account.email || '').trim();
}
function sourceIdentity(item) {
  const standard = contract.fromStoredRecord(item);
  return standard && standard.identity ? standard.identity : null;
}
function sourceChanged(previous, next) {
  if (!previous) return true;
  if (!next || !next.standardSource) return true;
  try {
    const before = previous.standardSource || sourceIdentity(previous);
    return !before || contract.semanticFingerprint(before) !== contract.semanticFingerprint(next.standardSource);
  } catch (_) { return true; }
}
async function list({ store, account }) {
  const document = await store.getDocument(account, DOCUMENT_KEY);
  return { items: listPayload(document), version: document ? Number(document.version) : 0, updatedAt: document && document.updatedAt || null };
}
async function get({ store, account, id }) {
  const current = await list({ store, account });
  const item = current.items.find(row => String(row && row.id || '') === String(id || '')) || null;
  return Object.assign({}, current, { item });
}
async function upsert({ store, account, payload, withQuota, now, operationSource }) {
  if (!store || !account || !account.tenantId || !account.userId) throw problem('collection_context_invalid', '采集箱写入上下文不完整。');
  const standard = contract.normalizeCapture(payload, { capturedAt: now ? new Date(now).toISOString() : new Date().toISOString() });
  const id = standard.identity.recordId;
  const capturedAt = now ? new Date(now).toISOString() : new Date().toISOString();
  const displayIdentity = typeof store.accountDisplayIdentity === 'function' ? await store.accountDisplayIdentity(account) : { profileFullName: '', email: '', isSystemAdmin: account.isSystemAdmin === true };
  const actorAccount = { ...account, profileFullName: displayIdentity.profileFullName || '', email: displayIdentity.email || '' };
  let lastConflict;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await store.getDocument(account, DOCUMENT_KEY);
    const current = listPayload(document);
    const index = current.findIndex(item => String(item && item.id || '') === id);
    const previous = index >= 0 ? current[index] : null;
    const item = contract.toCompatibilityRecord(standard, previous, capturedAt);
    delete item.collectedByIdentity;
    if (previous) {
      item.collectedBy = String(previous.collectedBy || '');
      item.collectedByUserId = String(previous.collectedByUserId || '');
      item.collectedAt = String(previous.collectedAt || '');
    } else {
      item.collectedBy = collectorLabel(actorAccount) || '历史未记录';
      item.collectedByUserId = String(account.userId);
      item.collectedAt = capturedAt;
    }
    item.collectionSchemaVersion = contract.SCHEMA_VERSION;
    item.sourceChangedAt = sourceChanged(previous, item) ? capturedAt : String(previous && previous.sourceChangedAt || '');
    item.sourceOperation = String(operationSource || 'collector').slice(0, 40);
    const next = current.slice();
    if (index >= 0) next[index] = item;
    else next.unshift(item);
    try {
      const writer = () => store.putDocument(account, DOCUMENT_KEY, next, document ? Number(document.version) : 0);
      const saved = typeof withQuota === 'function' ? await withQuota(next, writer) : await writer();
      await store.recordAudit(account, 'collection.source.upsert', 'collection_source', id, 'success', {
        sourcePlatform: standard.identity.sourcePlatform,
        sourceItemId: standard.identity.sourceItemId,
        created: index < 0,
        schemaVersion: standard.schemaVersion
      }).catch(() => {});
      return { ok: true, id, created: index < 0, item, version: Number(saved.version), updatedAt: saved.updatedAt };
    } catch (error) {
      if (error && error.publicCode === 'document_version_conflict' && attempt < 2) { lastConflict = error; continue; }
      throw error;
    }
  }
  throw lastConflict || problem('collection_write_conflict', '采集箱刚被其他操作更新，请重新采集。', 409);
}
function positive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function packageModes(variants) {
  const varies = field => {
    const known = variants.map(item => positive(item && item[field])).filter(value => value != null);
    return known.length >= 2 && new Set(known.map(String)).size > 1;
  };
  return { weight: varies('weightG'), dimensions: varies('lengthMm') || varies('widthMm') || varies('heightMm') };
}
function sourceVariantRows(item) {
  const standard = contract.fromStoredRecord(item), variants = standard && Array.isArray(standard.variants) ? standard.variants : [];
  return variants.map(row => ({ sourceVariantId: String(row && row.sourceVariantId || '').trim(), label: String(row && row.label || '').trim() }));
}
function normalizePackageFacts(item, payload, account, now) {
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const product = input.product && typeof input.product === 'object' && !Array.isArray(input.product) ? input.product : {};
  const incoming = Array.isArray(input.variants) ? input.variants.slice(0, 1000) : [];
  const sourceVariants = sourceVariantRows(item), matched = [];
  for (const row of incoming) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const sourceVariantId = String(row.sourceVariantId || row.sku || '').trim();
    const label = String(row.sourceSpecText || row.label || row.name || '').trim();
    let source = sourceVariantId ? sourceVariants.find(candidate => candidate.sourceVariantId && candidate.sourceVariantId === sourceVariantId) : null;
    if (!source && label) {
      const sameLabel = sourceVariants.filter(candidate => candidate.label && candidate.label === label);
      if (sameLabel.length === 1) source = sameLabel[0];
    }
    if (!source) continue;
    matched.push({
      sourceVariantId: source.sourceVariantId,
      label: source.label,
      weightG: positive(row.weightG),
      lengthMm: positive(row.packageLength != null ? row.packageLength : row.lengthMm),
      widthMm: positive(row.packageWidth != null ? row.packageWidth : row.widthMm),
      heightMm: positive(row.packageHeight != null ? row.packageHeight : row.heightMm)
    });
  }
  const modes = packageModes(matched);
  const previous = item && item.verifiedPackage && typeof item.verifiedPackage === 'object' ? item.verifiedPackage : {};
  const previousProduct = previous.product && typeof previous.product === 'object' ? previous.product : {};
  const nextProduct = {
    weightG: positive(product.weightG) || positive(previousProduct.weightG),
    lengthMm: positive(product.lengthMm != null ? product.lengthMm : product.length) || positive(previousProduct.lengthMm),
    widthMm: positive(product.widthMm != null ? product.widthMm : product.width) || positive(previousProduct.widthMm),
    heightMm: positive(product.heightMm != null ? product.heightMm : product.height) || positive(previousProduct.heightMm)
  };
  return {
    version: 1,
    provenance: 'product_create_user_confirmed',
    updatedAt: now,
    updatedByUserId: Number(account && account.userId) || null,
    modes,
    product: nextProduct,
    variants: matched.map(row => ({
      sourceVariantId: row.sourceVariantId,
      label: row.label,
      ...(modes.weight ? { weightG: row.weightG } : {}),
      ...(modes.dimensions ? { lengthMm: row.lengthMm, widthMm: row.widthMm, heightMm: row.heightMm } : {})
    }))
  };
}
async function backwritePackageFacts({ store, account, payload, now }) {
  if (!store || !account || !account.tenantId || !account.userId) throw problem('collection_context_invalid', '采集箱回写上下文不完整。');
  const input = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const collectionId = String(input.collectionId || '').trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(collectionId)) throw problem('collection_id_invalid', '采集箱来源编号不正确，请从采集箱重新进入新增商品。');
  let lastConflict;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await store.getDocument(account, DOCUMENT_KEY);
    const current = listPayload(document), index = current.findIndex(item => String(item && item.id || '') === collectionId);
    if (index < 0) throw problem('collection_source_missing', '关联的采集箱来源记录不存在，请从采集箱重新进入新增商品。', 404);
    const previous = current[index], sourceUrl = String(input.sourceUrl || '').trim(), storedUrl = String(previous && previous.sourceUrl || '').trim();
    if (sourceUrl && storedUrl && sourceUrl !== storedUrl) throw problem('collection_source_mismatch', '采集箱来源与当前新增商品主货源不一致，请重新从正确的采集商品进入。', 409);
    const updatedAt = now ? new Date(now).toISOString() : new Date().toISOString();
    const verifiedPackage = normalizePackageFacts(previous, input, account, updatedAt);
    const item = { ...previous, verifiedPackage, updatedAt }, next = current.slice(); next[index] = item;
    try {
      const saved = await store.putDocument(account, DOCUMENT_KEY, next, document ? Number(document.version) : 0);
      await store.recordAudit(account, 'collection.package_facts.backwrite', 'collection_source', collectionId, 'success', {
        productFields: Object.values(verifiedPackage.product).filter(value => value != null).length,
        variantRows: verifiedPackage.variants.length,
        variantWeight: verifiedPackage.modes.weight,
        variantDimensions: verifiedPackage.modes.dimensions
      }).catch(() => {});
      return { ok: true, id: collectionId, item, version: Number(saved.version), updatedAt: saved.updatedAt };
    } catch (error) {
      if (error && error.publicCode === 'document_version_conflict' && attempt < 2) { lastConflict = error; continue; }
      throw error;
    }
  }
  throw lastConflict || problem('collection_write_conflict', '采集箱刚被其他操作更新，请重新保存商品。', 409);
}

async function refresh(options) {
  return upsert(Object.assign({}, options, { operationSource: 'refresh' }));
}

module.exports = { DOCUMENT_KEY, list, get, upsert, refresh, sourceIdentity, backwritePackageFacts, normalizePackageFacts, packageModes };
