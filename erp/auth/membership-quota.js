'use strict';

const BUSINESS_TIMEZONE = 'Asia/Shanghai';

function text(value) {
  return value == null ? '' : String(value).trim();
}

function activeIdentityCount(payload, kind) {
  const values = Array.isArray(payload) ? payload : [];
  const set = new Set();
  values.forEach(item => {
    if (!item || typeof item !== 'object' || item.archived) return;
    let identity = '';
    if (kind === 'shops') identity = text(item.clientId || item.externalShopId || item.id || item.name).toLowerCase();
    if (kind === 'favorites') identity = text(item.sku).toLowerCase();
    if (identity) set.add(identity);
  });
  return set.size;
}

function numericLimit(value) {
  return Math.max(0, Number(value) || 0);
}

function collectionEntries(payload) {
  return (Array.isArray(payload) ? payload : []).filter(item => item && typeof item === 'object');
}

function collectionEntryIdentity(item, index) {
  const id = text(item && item.id);
  return id ? 'id:' + id : 'row:' + index;
}

function collectionEntryCount(payload) {
  return collectionEntries(payload).length;
}

function collectionIdentitySet(payload) {
  return new Set(collectionEntries(payload).map(collectionEntryIdentity));
}

function collectionLimitError(limit, usage) {
  const error = new Error(`当前会员方案采集箱最多保留 ${limit} 个商品，当前已保留 ${usage} 个。请先清理不再需要的采集商品，或升级会员方案后再继续采集。`);
  error.publicCode = 'membership_collection_box_limit';
  error.status = 409;
  error.limit = limit;
  error.usage = usage;
  return error;
}

async function enforceCollectionBox(store, account, currentPayload, nextPayload, client) {
  if (account && account.isSystemAdmin === true) return;
  const queryable = client || store.pool;
  const benefits = await store.activeMembershipBenefits(queryable, account.tenantId);
  const limit = numericLimit(benefits && benefits.collectionBoxLimit);
  const currentCount = collectionEntryCount(currentPayload);
  const nextCount = collectionEntryCount(nextPayload);
  const currentIds = collectionIdentitySet(currentPayload);
  const nextIds = collectionIdentitySet(nextPayload);
  const addsIdentity = [...nextIds].some(identity => !currentIds.has(identity));
  if (addsIdentity && currentCount >= limit) throw collectionLimitError(limit, currentCount);
  if (nextCount > limit && (nextCount > currentCount || addsIdentity)) throw collectionLimitError(limit, currentCount);
}

async function withCollectionBoxGate(store, account, nextPayload, writer) {
  if (account && account.isSystemAdmin === true) return writer();
  const client = await store.pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('wyerp_collection_box_quota'), hashtext($1::text))`, [String(account.tenantId)]);
    const current = await store.getDocument(account, 'erp_collected_products');
    await enforceCollectionBox(store, account, current && current.payload, nextPayload, client);
    return await writer();
  } finally {
    try { await client.query(`SELECT pg_advisory_unlock(hashtext('wyerp_collection_box_quota'), hashtext($1::text))`, [String(account.tenantId)]); } catch (_) {}
    client.release();
  }
}

function quota(key, label, unit, usage, limit) {
  usage = Math.max(0, Number(usage) || 0);
  const unlimited = limit === null;
  const normalizedLimit = unlimited ? null : numericLimit(limit);
  return {
    key,
    label,
    unit,
    usage,
    limit: normalizedLimit,
    unlimited,
    remaining: unlimited ? null : Math.max(0, normalizedLimit - usage),
    overLimit: !unlimited && usage > normalizedLimit
  };
}

async function snapshot(store, account) {
  if (!store || !store.pool || !account || !account.tenantId) throw new Error('会员额度读取参数不完整');

  const [benefits, shopsDocument, favoritesDocument, collectionDocument, counters] = await Promise.all([
    store.activeMembershipBenefits(store.pool, account.tenantId),
    store.getDocument(account, 'erp_shops_data'),
    store.getDocument(account, 'erp_favorite_products'),
    store.getDocument(account, 'erp_collected_products'),
    store.pool.query(
      "SELECT " +
      "(now() AT TIME ZONE 'Asia/Shanghai')::date::text AS business_date," +
      "(SELECT count(*)::integer FROM membership_daily_sku_usage WHERE tenant_id=$1 AND business_date=(now() AT TIME ZONE 'Asia/Shanghai')::date) AS daily_sku_usage," +
      "(SELECT count(*)::integer FROM tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.member_type='member' AND m.status='active' AND u.is_system_admin=false) AS child_account_usage",
      [account.tenantId]
    )
  ]);

  const row = counters.rows[0] || {};
  const systemAdmin = account.isSystemAdmin === true;
  const dailyHasLimit = Object.prototype.hasOwnProperty.call(benefits || {}, 'dailySkuLimit');
  const dailyRaw = dailyHasLimit ? benefits.dailySkuLimit : 0;

  return {
    businessDate: row.business_date || null,
    timezone: BUSINESS_TIMEZONE,
    shops: quota(
      'shops',
      '店铺数量',
      '个',
      activeIdentityCount(shopsDocument && shopsDocument.payload, 'shops'),
      systemAdmin ? null : numericLimit(benefits && benefits.shopLimit)
    ),
    dailySku: quota(
      'dailySku',
      '今日上架 SKU',
      '个',
      row.daily_sku_usage,
      systemAdmin || (dailyHasLimit && dailyRaw === null) ? null : numericLimit(dailyRaw)
    ),
    favorites: quota(
      'favorites',
      '收藏商品',
      '个',
      activeIdentityCount(favoritesDocument && favoritesDocument.payload, 'favorites'),
      systemAdmin ? null : numericLimit(benefits && benefits.favoriteLimit)
    ),
    collectionBox: quota(
      'collectionBox',
      '采集箱商品',
      '个商品',
      collectionEntryCount(collectionDocument && collectionDocument.payload),
      systemAdmin ? null : numericLimit(benefits && benefits.collectionBoxLimit)
    ),
    childAccounts: quota(
      'childAccounts',
      '启用子账号',
      '个',
      row.child_account_usage,
      numericLimit(benefits && benefits.childAccountLimit)
    )
  };
}

module.exports = {
  BUSINESS_TIMEZONE,
  activeIdentityCount,
  numericLimit,
  quota,
  collectionEntries,
  collectionEntryCount,
  collectionIdentitySet,
  collectionLimitError,
  enforceCollectionBox,
  withCollectionBoxGate,
  snapshot
};
