'use strict';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function favoriteKey(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  return text(item.sku != null ? item.sku : (item.skuId != null ? item.skuId : item.id)).toLowerCase();
}

function actorLabel(account) {
  if (!account) return '';
  if (account.isSystemAdmin) return '系统管理员';
  return text(account.profileFullName || account.email);
}

function stamp(previousPayload, incomingPayload, account, now) {
  if (!Array.isArray(incomingPayload)) return incomingPayload;
  const previous = Array.isArray(previousPayload) ? previousPayload : [];
  const previousByKey = new Map();
  for (const item of previous) {
    const key = favoriteKey(item);
    if (key) previousByKey.set(key, item);
  }
  const actor = actorLabel(account) || '未知账号';
  const userId = text(account && account.userId);
  const favoredAt = text(now) || new Date().toISOString();

  return incomingPayload.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const next = { ...item };
    delete next.favoritedByIdentity;
    const before = previousByKey.get(favoriteKey(next));
    if (before) {
      next.favoritedBy = text(before.favoritedBy);
      next.favoritedByUserId = text(before.favoritedByUserId);
      next.favoritedAt = text(before.favoritedAt);
      return next;
    }
    next.favoritedBy = actor;
    next.favoritedByUserId = userId;
    next.favoritedAt = favoredAt;
    return next;
  });
}

module.exports = { actorLabel, favoriteKey, stamp };
