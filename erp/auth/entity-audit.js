'use strict';

const AUDITED_KEYS = new Set(['erp_online_products', 'erp_orders_data', 'erp_shops_data']);
const AUDIT_FIELDS = new Set(['changeLog', 'lastOperator', 'lastOperatorIdentity', 'lastOperation', 'lastOperatedAt', 'lastOperatorUserId']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function cleanEntity(entity) {
  const output = {};
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return output;
  for (const [key, value] of Object.entries(entity)) {
    if (!AUDIT_FIELDS.has(key)) output[key] = clone(value);
  }
  return output;
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function identity(key, entity) {
  if (!entity || typeof entity !== 'object') return '';
  if (key === 'erp_orders_data') return String(entity.posting || entity.posting_number || '').trim();
  if (key === 'erp_shops_data') return String(entity.clientId || entity.externalShopId || entity.id || entity.name || '').trim();
  const productId = entity.id || entity.productId || entity.sku || entity.article || entity.offer_id;
  const shopId = entity.clientId || entity.shopId || entity.shop || '';
  return productId == null ? '' : String(shopId) + '::' + String(productId);
}

function isArchived(entity) {
  return Boolean(entity && (entity.archived || /归档|archiv/i.test(String(entity.status || ''))));
}

function changedFields(previous, current) {
  const names = new Set([...Object.keys(previous || {}), ...Object.keys(current || {})]);
  return [...names].filter(name => stable(previous && previous[name]) !== stable(current && current[name])).slice(0, 30);
}

function displayOperator(account, source) {
  const isSystemAdmin = Boolean(account && account.isSystemAdmin);
  if (isSystemAdmin) return source === 'sync' ? '系统同步' : '系统管理员';
  const profileFullName = String(account && account.profileFullName || '').trim();
  const email = String(account && account.email || '').trim();
  return profileFullName || email || '历史未记录';
}

function applyEntityAudit(key, previousPayload, incomingPayload, account, now = new Date().toISOString(), options = {}) {
  if (!AUDITED_KEYS.has(key) || !Array.isArray(incomingPayload)) return incomingPayload;
  const isSync = options.source === 'sync';
  const previous = Array.isArray(previousPayload) ? previousPayload : [];
  const previousById = new Map();
  for (const entity of previous) {
    const id = identity(key, entity);
    if (id) previousById.set(id, entity);
  }

  return incomingPayload.map(entity => {
    const current = cleanEntity(entity);
    const id = identity(key, current);
    const before = id ? previousById.get(id) : null;
    const oldHistory = before && Array.isArray(before.changeLog) ? clone(before.changeLog).slice(-10) : [];
    let action = '';
    let fields = [];

    if (!before) {
      if (isSync) action = '同步';
      else if (key !== 'erp_orders_data') action = '新增';
    } else {
      const oldClean = cleanEntity(before);
      fields = changedFields(oldClean, current);
      if (fields.length) {
        action = isSync ? '同步'
          : !isArchived(oldClean) && isArchived(current) ? '归档'
            : isArchived(oldClean) && !isArchived(current) ? '恢复'
              : '修改';
      }
    }

    if (!action) {
      if (!before) return current;
      return Object.assign(current, {
        changeLog: oldHistory,
        lastOperator: before.lastOperator || '',
        lastOperatorUserId: before.lastOperatorUserId || '',
        lastOperation: before.lastOperation || '',
        lastOperatedAt: before.lastOperatedAt || ''
      });
    }

    const entry = {
      action,
      username: displayOperator(account, options.source),
      userId: String(account && account.userId || ''),
      operatedAt: now,
      changedFields: fields
    };
    const history = oldHistory.concat(entry).slice(-10);
    return Object.assign(current, {
      changeLog: history,
      lastOperator: entry.username,
      lastOperatorUserId: entry.userId,
      lastOperation: entry.action,
      lastOperatedAt: entry.operatedAt
    });
  });
}

function filterEntityAuditVisibility(key, payload, account) {
  if (!AUDITED_KEYS.has(key) || !Array.isArray(payload)) return payload;
  if (account && (account.isSystemAdmin || account.memberType === 'owner')) return payload;
  const viewerUserId = String(account && account.userId || '');
  const viewerUsername = String(account && account.username || '').toLowerCase();

  return payload.map(entity => {
    if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return entity;
    const safe = clone(entity);
    const visibleHistory = (Array.isArray(safe.changeLog) ? safe.changeLog : []).filter(entry => {
      const entryUserId = String(entry && entry.userId || '');
      const entryUsername = String(entry && entry.username || '').toLowerCase();
      return (viewerUserId && entryUserId === viewerUserId) || (!entryUserId && viewerUsername && entryUsername === viewerUsername);
    }).slice(-10);
    if (!visibleHistory.length) {
      delete safe.changeLog;
      delete safe.lastOperator;
      delete safe.lastOperatorUserId;
      delete safe.lastOperation;
      delete safe.lastOperatedAt;
      return safe;
    }
    const latest = visibleHistory[visibleHistory.length - 1];
    safe.changeLog = visibleHistory;
    safe.lastOperator = latest.username || '';
    safe.lastOperatorUserId = latest.userId || '';
    safe.lastOperation = latest.action || '';
    safe.lastOperatedAt = latest.operatedAt || '';
    return safe;
  });
}

module.exports = { AUDITED_KEYS, applyEntityAudit, filterEntityAuditVisibility, identity, cleanEntity, changedFields, displayOperator };
