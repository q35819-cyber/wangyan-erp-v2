'use strict';

const crypto = require('crypto');
const orderMappings = require('../assets/order-mappings');
const { Pool } = require('pg');
const { createDatabaseConfig } = require('../db/config');
const { stringifyLargeCategoryDocument } = require('./large-document-json');
const { hashPassword, verifyPassword } = require('./password');
const {
  RELATIONAL_BUSINESS_KEYS, FINANCIAL_RECORD_KEYS, FINANCE_SETTING_KEYS,
  rowsForPayload, payloadFromRows, normalizePlatformPayload, validateSupplierUrl, supplierHosts
} = require('./business-boundaries');
const { normalizeBackgroundJob, mapBackgroundJob, containsSecret } = require('./background-job-model');
const { WELCOME_GIFT_BEAN, welcomeGiftIdempotencyKey, mutateOn, agentRewardBean, MAX_BEAN_CODE_AMOUNT, creditMembershipOn } = require('./ai-bean-store');
const clientOrderSync = require('./client-order-sync');
const orderOperations = require('../assets/order-operations');
const orderManualExcel = require('./order-manual-excel');
const productSourceLink = require('../assets/product-source-link');

const ACTIVATION_BEAN_AMOUNTS = new Set([1000, 2000, 5000, 10000, 50000]);
const MEMBERSHIP_REWARD_ACTIVITY = Object.freeze({
  version: 'membership-first-paid-beans-2026-09-20',
  firstPaidLifetime: true,
  firstPaidBeans: Object.freeze({ month: 1000, quarter: 3000, year: 12000 }),
  renewalBeans: Object.freeze({ month: 300, quarter: 900, year: 3600 })
});

const REFERRAL_SIGNUP_REWARD_BEAN = 1000;
const REFERRAL_FIRST_PAID_REWARD_BEAN = 3000;
const REFERRAL_CODE_RE = /^WY[A-F0-9]{10}$/;
function normalizeReferralCode(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}
function referralEmailHash(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
}
function newReferralCode() {
  return 'WY' + crypto.randomBytes(5).toString('hex').toUpperCase();
}

// mem15（#44，2026-09-21 用户直令“按15+15天的改”）：注册段与完善资料段按客户空间累计最多 30 天。
// 天数的权威值在 membership_plan_versions（trial 已发布版 duration_days 与 benefits.profileBonusDays），这里只登记合计上限。
const TRIAL_TOTAL_CAP_DAYS = 30;
const TRIAL_SOURCE_TYPES = ['registration_trial', 'profile_trial'];

// 没有关联后台任务的旧同步记录，不能无限期显示为“进行中”。
// 新任务一律由 background_jobs 管理；这里只兜底历史孤立记录，留足正常前台请求的等待时间。
const ORPHAN_SYNC_TASK_STALE_MINUTES = 15;

function bilingualExternalFailureText(rawValue, chineseFallback) {
  const raw = String(rawValue || '').replace(/\s+/g, ' ').trim().slice(0, 900);
  const fallback = String(chineseFallback || '外部接口返回错误，请稍后重试；若持续失败请联系系统管理员。').trim();
  if (!raw) return fallback;
  if (/[\u3400-\u9fff]/.test(raw)) return raw;
  const lower = raw.toLowerCase();
  let chinese = fallback;
  if (/429|too many|rate.?limit|слишком много запросов/.test(lower)) chinese = '外部接口请求过于频繁，平台正在限流，请稍后重试。';
  else if (/401|unauthorized|authentication|invalid.*token|не авторизован|авторизац/.test(lower)) chinese = '外部接口身份验证失败，请检查登录状态、授权或接口凭证。';
  else if (/403|forbidden|access denied|api access disabled|доступ запрещ/.test(lower)) chinese = '外部接口拒绝访问，请检查接口权限、店铺授权或平台侧 API 状态。';
  else if (/404|not found|не найден/.test(lower)) chinese = '外部接口没有找到请求的资源或数据，请检查请求目标是否仍然有效。';
  else if (/409|conflict|version mismatch|конфликт/.test(lower)) chinese = '外部接口返回数据冲突，请刷新后重新发起任务。';
  else if (/timeout|timed out|etimedout|request timeout|истекло время/.test(lower)) chinese = '外部接口请求超时，请检查网络后重试。';
  else if (/failed to fetch|network|offline|econn|socket|dns|сеть|соединен/.test(lower)) chinese = '无法连接外部接口，请检查网络或平台服务状态。';
  else if (/bad json|unexpected token|parse|invalid response|malformed|некоррект.*ответ/.test(lower)) chinese = '外部接口返回的数据格式异常，系统暂时无法解析。';
  else if (/credential|api.?key|secret|token expired|ключ api/.test(lower)) chinese = '外部接口凭证缺失、无效或已过期，请检查配置。';
  else if (/5\d\d|internal server|service unavailable|bad gateway|gateway timeout|внутренняя ошибка/.test(lower)) chinese = '外部平台服务暂时异常，请稍后重试。';
  else if (/разница между текущей ценой и ценой до скидки слишком маленькая/i.test(raw)) chinese = 'Ozon 拒绝操作：当前售价与折前价的差额太小，请调整价格后重试。';
  else if (/[\u0400-\u04ff]/.test(raw)) chinese = '外部平台返回俄文错误，当前系统未匹配到更具体的业务说明，请结合下方原始报错排查。';
  else chinese = fallback;
  return (`中文说明：${chinese}\n原始报错：${raw}`).slice(0, 1450);
}

function isFreshOrphanRunningSyncTask(task) {
  if (!task || task.status !== 'running' || task.endedAt) return false;
  const updatedAt = new Date(task.updatedAt || 0).getTime();
  return Number.isFinite(updatedAt) && updatedAt >= Date.now() - ORPHAN_SYNC_TASK_STALE_MINUTES * 60 * 1000;
}

function projectSyncTaskStatus(task, job) {
  if (job) {
    if (['queued', 'running', 'retry'].includes(job.state)) return 'running';
    return job.state === 'done' ? 'done' : 'failed';
  }
  if (task.status === 'done') return 'done';
  if (task.status === 'running' && isFreshOrphanRunningSyncTask(task)) return 'running';
  return 'failed';
}

function maskLoginAccount(value) {
  const account = String(value || '').trim();
  const at = account.indexOf('@');
  if (at > 0) return `${account.slice(0, 1)}***${account.slice(at)}`;
  if (/^\+?\d{7,20}$/.test(account)) return `${account.slice(0, 3)}****${account.slice(-4)}`;
  return account.length > 1 ? `${account.slice(0, 1)}***${account.slice(-1)}` : '***';
}

// 邮箱验证码期限与限流：验证码只存摘要，10 分钟有效、60 秒可重发、每小时 5 次、单码最多试 5 次。
const EMAIL_CODE_VALID_MINUTES = 10;
const EMAIL_CODE_RESEND_SECONDS = 60;
const EMAIL_CODE_HOURLY_LIMIT = 5;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
// 头像写入私有对象目录，连续替换会留下不可达对象，因此按人限制最小更换间隔。
const AVATAR_MIN_CHANGE_SECONDS = 10;

function emailCodeHash(userId, email, code) {
  return crypto.createHash('sha256').update(`${userId}:${String(email).toLowerCase()}:${code}`).digest('hex');
}

function normalizeAuthEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 240 ? email : '';
}

function authEmailChallengeHash(purpose, userId, email, code) {
  return crypto.createHash('sha256')
    .update(`auth-email:${String(purpose || '')}:${String(userId || 0)}:${normalizeAuthEmail(email)}:${String(code || '')}`)
    .digest('hex');
}

// 完善资料赠送的“每人一次”只保存邮箱摘要，不落明文邮箱；摘要带用途前缀，避免与验证码等其它摘要互相碰撞。
function trialEmailHash(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return normalized ? crypto.createHash('sha256').update(`profile-trial:${normalized}`).digest('hex') : null;
}

// 本次保存是否顺带触发完善资料赠送，必须由服务端在响应里说明，页面不得用天数差自行推断。
function withTrialBonusGrant(profile, grant) {
  if (!profile || !grant || grant.granted !== true) return profile;
  profile.trialBonus = {
    ...(profile.trialBonus || {}), justGranted: true, grantedDays: grant.grantedDays,
    message: `已赠送 ${grant.grantedDays} 天免费体验（${grant.state === 'active' ? '立即生效' : '排队接续当前权益'}）`
  };
  return profile;
}

function profileLetter(value) {
  const name = String(value || '').trim();
  return name ? name.slice(0, 1).toUpperCase() : '研';
}

// 头像只走这一个受鉴权入口，URL 带内容摘要做缓存穿透；图片字节不进数据库，也不走公开静态路径。
function profileAvatarUrl(userId, sha256) {
  return '/api/auth/profile/avatar?user=' + encodeURIComponent(String(userId)) + '&v=' + String(sha256 || '').slice(0, 16);
}

// 公司名称格式（2026-09-21 用户直令“公司名称也要格式符合，至少是中文的”）：必须含中文字符，只允许中英文、数字与常见括号标点。
// 只在与当前名称不一致（真的要改名）时校验，历史遗留的非规范名称不会把整张基础信息面板锁死。
const PROFILE_HAN_RE = /[\u4e00-\u9fff]/;
const PROFILE_TENANT_NAME_RE = /^[\u4e00-\u9fffA-Za-z0-9（）()《》【】·．.、，,&+_\- ]{2,160}$/;

function assertTenantNameFormat(value) {
  if (PROFILE_TENANT_NAME_RE.test(value) && PROFILE_HAN_RE.test(value)) return;
  throw Object.assign(new Error('公司名称需为2至160个字符且至少包含一个中文字符，只能使用中文字符、字母、数字和常见括号标点，请修改后再保存。'), { publicCode: 'profile_tenant_name_invalid' });
}

function activationAuditMetadata(input, extra = {}) {
  const idempotencyKey = String(input.idempotencyKey || '');
  const rawBenefitType = String(input.benefitType || '');
  const targetTenantId = String(input.targetTenantId || '');
  return {
    requestId: String(input.requestId || '').slice(0, 128) || null,
    idempotencyKeyHash: idempotencyKey ? crypto.createHash('sha256').update(idempotencyKey).digest('hex') : null,
    targetTenantId: /^\d+$/.test(targetTenantId) ? targetTenantId : null,
    benefitType: rawBenefitType === 'bean_recharge' ? 'ai_beans' : rawBenefitType || null,
    planCode: rawBenefitType === 'bean_recharge' ? null : String(input.planCode || '') || null,
    beanAmount: rawBenefitType === 'bean_recharge' && Number.isFinite(Number(input.beanAmount)) ? Number(input.beanAmount) : null,
    mode: String(input.mode || input.fulfillmentType || '').slice(0, 40) || null,
    paymentId: /^\d+$/.test(String(input.paymentId || '')) ? String(input.paymentId) : null,
    expectedPriceMinor: Number.isSafeInteger(Number(input.expectedPriceMinor)) ? Number(input.expectedPriceMinor) : null,
    codeMask: String(input.codeMask || '') || null,
    reason: String(input.reason || '').slice(0, 500),
    ...extra
  };
}

function auditPersistenceError(cause) {
  const error = Object.assign(new Error('价值流程审计持久化失败'), { publicCode: 'audit_persistence_failed', cause });
  console.error('激活码审计持久化失败:', cause && cause.message || cause);
  return error;
}

const ORDER_MANUAL_LEDGER_KEY = 'erp_dev_manual_backup';
const MEMBERSHIP_REWARD_BEANS = Object.freeze({
  first: Object.freeze({ month: 1000, quarter: 3000, year: 12000 }),
  subsequent: Object.freeze({ month: 300, quarter: 900, year: 3600 })
});
function membershipRewardAmount(planCode, hasPaidHistory) {
  const amount = MEMBERSHIP_REWARD_BEANS[hasPaidHistory ? 'subsequent' : 'first'][planCode];
  if (!Number.isSafeInteger(amount)) throw new Error('会员赠豆档位配置不正确，请联系系统管理员核查。');
  return amount;
}

async function saveOrderManualLedger(client, account, orders) {
  const snapshot = orderOperations.createManualOrderSnapshot(orders);
  await client.query(
    `INSERT INTO tenant_documents (tenant_id,document_key,payload,updated_by_user_id)
     VALUES ($1,$2,$3::jsonb,$4)
     ON CONFLICT (tenant_id,document_key) DO UPDATE SET
       payload=EXCLUDED.payload,version=tenant_documents.version+1,
       updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
    [account.tenantId, ORDER_MANUAL_LEDGER_KEY, JSON.stringify(snapshot), account.userId]
  );
  return snapshot;
}

async function reconcileOrderManualData(client, tenantId, incoming, currentRows) {
  const target = Array.isArray(incoming) ? incoming : [];
  const [ledgerResult, productsResult] = await Promise.all([
    client.query(`SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2`, [tenantId, ORDER_MANUAL_LEDGER_KEY]),
    client.query(`SELECT payload FROM business_products WHERE tenant_id=$1 ORDER BY position,record_key`, [tenantId])
  ]);
  const ledger = ledgerResult.rowCount ? orderOperations.normalizeManualOrderSnapshot(ledgerResult.rows[0].payload) : [];
  orderOperations.preserveManualOrderData(target, ledger);
  // Shared source/cost fields are maintained by exact full SKU in online products.
  // Non-empty product values correct both missing and mismatched client values.
  productSourceLink.repairOrderSources(target, productsResult.rows.map(row => row.payload), true);
  // Compatibility for manual edits saved before the durable ledger existed.
  // Blank placeholders from an automatic payload are intentionally ignored here.
  orderOperations.preserveMeaningfulManualOrderData(target, currentRows);
  // Seller v6 WHD CNY/settlement/return enrichment is server-authoritative. A
  // stale client snapshot must not erase it, while a complete new v6 snapshot
  // remains free to update or clear prior Seller facts.
  orderOperations.preserveAuthoritativeWhdData(target, currentRows);
  // 单件订单直接使用已保存到订单商品行的采购价 + 国内运费；空国内运费按包邮0。
  // 多件/组合订单不在同步入库阶段推断运费口径。
  target.forEach(order => { orderOperations.ensureSingleQuantityPurchaseCost(order); });
  // Performance API 的 CPO 订单归属是服务端权威补充字段，后续 Seller 订单同步不得把它覆盖掉。
  const currentByPosting = new Map((Array.isArray(currentRows) ? currentRows : []).map(order => [String(order && (order.posting || order.posting_number) || ''), order]));
  target.forEach(order => {
    const current = currentByPosting.get(String(order && (order.posting || order.posting_number) || ''));
    if (!current || !current.finance) return;
    const fields = ['performanceCpoItems', 'performanceCpoRub', 'performanceCpoUpdatedAt', 'performanceCpoSource', 'orderRubPerCny', 'orderCnyPerRub', 'orderRateDate', 'orderRateEffectiveDate', 'orderRateSource', 'orderRateLockedAt'];
    // Seller 应计费用页 unit_summary.profit 是接口实际净收入；服务器 API 同步拿不到时不得覆盖。
    const incomingNetIncome = order.finance && order.finance.ozonNetIncomeRub;
    const currentNetIncome = current.finance.ozonNetIncomeRub != null ? current.finance.ozonNetIncomeRub : current.finance.ozonProfitRub;
    const currentNetSource = String(current.finance.ozonNetIncomeRubSource || current.finance.sellerPayoutRubSource || current.finance.settlementSource || '');
    if (incomingNetIncome == null && currentNetIncome != null && /accruals_details|unit_summary_profit|accrual_by_day/.test(currentNetSource)) {
      fields.push('ozonNetIncomeRub', 'ozonNetIncomeRubSource', 'ozonProfitRub');
    }
    if (!order.finance || typeof order.finance !== 'object') order.finance = {};
    fields.forEach(field => {
      if (!Object.prototype.hasOwnProperty.call(current.finance, field)) return;
      const serialized = JSON.stringify(current.finance[field]);
      order.finance[field] = serialized === undefined ? current.finance[field] : JSON.parse(serialized);
    });
  });
  return target;
}

// Only lock historical orders which this sync batch can overwrite. Locking the
// entire shop for each batch grows with the lifetime of the shop, not with the
// bounded (<=100 orders) batch. The migration already indexes
// (tenant_id, posting_number); the shop predicate protects shop-local facts.
// Legacy records without a posting identifier retain the original safe path.
async function currentOrderPayloadsForSync(client, tenantId, clientId, incoming) {
  const postings = (incoming || []).map(order => String(order && (order.posting || order.posting_number) || '').trim());
  const query = postings.length && postings.every(Boolean)
    ? [`SELECT payload FROM business_orders WHERE tenant_id=$1 AND shop_external_id=$2 AND posting_number=ANY($3::text[]) FOR UPDATE`,
       [tenantId, clientId, Array.from(new Set(postings))]]
    : [`SELECT payload FROM business_orders WHERE tenant_id=$1 AND shop_external_id=$2 FOR UPDATE`,
       [tenantId, clientId]];
  const current = await client.query(query[0], query[1]);
  return current.rows.map(row => row.payload);
}

function tokenHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function displayUsername(username, isSystemAdmin) {
  return isSystemAdmin ? '系统管理员' : username;
}

function auditEventRow(row) {
  const actorId = row.actor_user_id == null || String(row.actor_user_id).trim() === '' ? null : String(row.actor_user_id);
  // Only a retained actor ID plus a failed users join proves a deleted account.
  const deleted = actorId !== null && row.actor_user_exists === false;
  // SQL joins the stored legacy admin metadata to the real unique admin account.
  const admin = !deleted && row.actor_is_system_admin === true &&
    String(row.actor_username || '').trim().toLowerCase() === 'admin';
  const historical = !actorId && !admin;
  const actorUsername = admin ? '系统管理员' : deleted ? '已删除账号' :
    historical ? '历史未记录' : String(row.actor_username || '').trim();
  const fullName = deleted || historical ? '' : String(row.actor_profile_full_name || '').trim();
  const email = deleted || historical ? '' : String(row.actor_email || '').trim();
  return {
    id: row.id, action: row.action, resourceType: row.resource_type,
    resourceId: row.resource_id, result: row.result, metadata: row.metadata || {},
    actorUserId: actorId, actorUsername, actorProfileFullName: fullName,
    actorEmail: email, actorIsSystemAdmin: admin,
    actorLabel: admin ? '系统管理员' : deleted ? '已删除账号' :
      historical ? '历史未记录' : (fullName || email || '历史未记录'),
    createdAt: row.created_at
  };
}

function membershipPlan(row) {
  if (!row) return null;
  return {
    id: String(row.plan_id || row.id), code: row.plan_code, version: Number(row.version_no), name: row.name,
    currency: row.currency, priceMinor: Number(row.price_minor), durationDays: Number(row.duration_days),
    rank: Number(row.benefit_rank), benefits: row.benefits || {}, validFrom: row.valid_from, validUntil: row.valid_until
  };
}

function membershipPeriod(row) {
  return {
    id: String(row.period_id || row.id), state: row.state, sourceType: row.source_type, sourceRef: row.source_ref,
    startsAt: row.starts_at, endsAt: row.ends_at, remainingSeconds: row.remaining_seconds == null ? null : Number(row.remaining_seconds),
    plan: membershipPlan(row)
  };
}

function agentPlanPriceMinor(planCode, monthlyEquivalents) {
  if (planCode === 'quarter') return 60000;
  if (planCode === 'year') return 200000;
  const value = Number(monthlyEquivalents) || 0;
  if (value >= 40) return 16000;
  if (value >= 30) return 18500;
  if (value >= 20) return 21000;
  if (value >= 10) return 23500;
  return 26000;
}

const AGENT_DEPOSIT_REQUIRED_MINOR = 100000;

function postgresDateOnly(value) {
  if (!(value instanceof Date)) return String(value).slice(0, 10);
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
}

function agentSalesFacts(row) {
  return {
    monthStart: postgresDateOnly(row.month_start),
    validCustomerOrders: Number(row.valid_customer_orders) || 0,
    validSelfOrders: Number(row.valid_self_orders) || 0,
    monthlyEquivalents: Number(row.monthly_equivalents) || 0,
    monthPlanPriceMinor: Number(row.month_plan_price_minor) || 26000,
    settledAt: row.settled_at || null,
    metadata: row.metadata || {}
  };
}

function nullableAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  // Keep decimal text intact for NUMERIC; Number('') and Number(null) are zero.
  // Exclude JS-only numeric forms (hex, booleans, arrays) before the SQL cast.
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  return Number.isFinite(Number(text)) ? text : null;
}

const PRODUCT_LOCAL_FIELDS = ['purchasePrice', 'srcPrice', 'domesticShipping', 'srcUrl', 'sourceUrl', 'supplierUrl', 'srcNote', 'collectionId', 'erpVariantRef', 'sourceBundleIds', 'sourceBundles', 'combinationRelations', 'combinationHistory', 'manualVariantAttributes', 'suppressedVariantAttributes'];
const PRODUCT_LOCAL_MANUAL_FIELDS = ['purchasePrice', 'srcPrice', 'domesticShipping', 'srcUrl', 'srcNote', 'collectionId', 'erpVariantRef', 'sourceBundleIds', 'sourceBundles', 'combinationRelations', 'combinationHistory', 'manualVariantAttributes', 'suppressedVariantAttributes'];

function productSyncIdentity(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
  const clientId = String(item.clientId || item.shopId || '').trim();
  const productId = String(item.id || item.productId || item.sku || item.article || item.offer_id || '').trim();
  return clientId && productId ? clientId + '\u0000' + productId : '';
}

function mergePersistedProductLocalFields(preferred, fallback) {
  const next = { ...(preferred || {}) }, older = fallback && typeof fallback === 'object' ? fallback : {};
  for (const field of PRODUCT_LOCAL_FIELDS) {
    if ((!Object.prototype.hasOwnProperty.call(next, field) || next[field] == null || next[field] === '') && Object.prototype.hasOwnProperty.call(older, field)) next[field] = older[field];
  }
  const manual = { ...(older._manual && typeof older._manual === 'object' ? older._manual : {}), ...(next._manual && typeof next._manual === 'object' ? next._manual : {}) };
  if (Object.keys(manual).length) next._manual = manual;
  if ((!Array.isArray(next.variants) || !next.variants.length) && Array.isArray(older.variants)) next.variants = older.variants;
  return next;
}

function productRowIdentity(row) {
  const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
  const shopId = String(row && row.shop_external_id || payload.clientId || payload.externalShopId || payload.shopId || '').trim();
  const productId = String(payload.id || payload.productId || row && row.platform_record_id || '').trim();
  return shopId && productId ? shopId + '\u0000' + productId : '';
}

function preserveProductLocalFieldsForSync(input, persisted) {
  if (!Array.isArray(input)) return input;
  const existing = new Map();
  (Array.isArray(persisted) ? persisted : []).forEach(item => {
    const identity = productSyncIdentity(item);
    if (!identity) return;
    if (!existing.has(identity)) existing.set(identity, item);
    else existing.set(identity, mergePersistedProductLocalFields(existing.get(identity), item));
  });
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const next = { ...item };
    const before = existing.get(productSyncIdentity(item));
    PRODUCT_LOCAL_FIELDS.forEach(field => { delete next[field]; });
    const manual = { ...(next._manual && typeof next._manual === 'object' ? next._manual : {}) };
    PRODUCT_LOCAL_MANUAL_FIELDS.forEach(field => { delete manual[field]; });
    if (before) {
      for (const field of ['purchasePrice', 'srcPrice', 'domesticShipping', 'srcNote', 'collectionId', 'erpVariantRef', 'sourceBundleIds', 'sourceBundles', 'combinationRelations', 'combinationHistory', 'manualVariantAttributes', 'suppressedVariantAttributes']) {
        if (Object.prototype.hasOwnProperty.call(before, field)) next[field] = before[field];
      }
      const sourceUrl = before.srcUrl || before.sourceUrl || before.supplierUrl || '';
      if (sourceUrl) next.srcUrl = sourceUrl;
      const oldManual = before._manual && typeof before._manual === 'object' ? before._manual : {};
      PRODUCT_LOCAL_MANUAL_FIELDS.forEach(field => { if (oldManual[field]) manual[field] = true; });
    }
    if (before && Array.isArray(next.variants)) {
      const oldVariants = Array.isArray(before.variants) ? before.variants : [];
      next.variants = next.variants.map((variant, index) => {
        if (!variant || typeof variant !== 'object' || Array.isArray(variant)) return variant;
        const identity = String(variant.offerId || variant.offer_id || variant.article || variant.sku || variant.id || '').trim();
        const old = oldVariants.find(candidate => identity && String(candidate && (candidate.offerId || candidate.offer_id || candidate.article || candidate.sku || candidate.id) || '').trim() === identity) || oldVariants[index] || (next.variants.length === 1 ? before : null);
        if (!old) return variant;
        const kept = { ...variant };
        if (old.erpVariantRef) kept.erpVariantRef = old.erpVariantRef;
        if (Array.isArray(old.sourceBundleIds)) kept.sourceBundleIds = old.sourceBundleIds.slice();
        return kept;
      });
    }
    if (Object.keys(manual).length) next._manual = manual;
    else delete next._manual;
    return next;
  });
}

function confirmedCreateCombinationReplacement(rows, localFields) {
  const parents = new Set(), relations = new Map(), aliases = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const item = row && row.payload && typeof row.payload === 'object' ? row.payload : row;
    if (!item || typeof item !== 'object') continue;
    const clientId = String(item.clientId || item.shopId || '').trim();
    const offerId = String(item.offer_id || item.article || item.offerId || '').trim();
    const local = localFields instanceof Map ? localFields.get(clientId + '\u0000' + offerId) : null;
    const ref = String(local && local.erpVariantRef || '').trim();
    if (!/^erv_[A-Za-z0-9_-]{6,220}$/.test(ref)) continue;
    const collectionId = String(local && local.collectionId || '').trim(), aliasRef = String(local && local.combinationAliasVariantRef || '').trim();
    if (collectionId && aliasRef === ref) aliases.set(collectionId, { collectionId, variantRef: ref });
    const parentRef = 'variant:' + ref;
    parents.add(parentRef);
    const normalized = require('../assets/product-combination').normalizeRelations(local.combinationRelations || []);
    for (const relation of normalized) {
      if (relation.parentRef !== parentRef) continue;
      relations.set(relation.parentRef + '\u0000' + relation.childRef, relation);
    }
  }
  return { parentRefs: [...parents], relations: [...relations.values()], aliases: [...aliases.values()] };
}

function normalizeAccount(row) {
  if (!row) return null;
  const isSystemAdmin = row.is_system_admin === true && String(row.username || '').trim().toLowerCase() === 'admin';
  return {
    userId: String(row.user_id),
    tenantId: String(row.tenant_id),
    username: row.username,
    displayName: row.display_name || row.username,
    memberType: row.member_type,
    isSystemAdmin,
    shopScopeMode: row.shop_scope_mode,
    permissions: isSystemAdmin || row.member_type === 'owner' ? ['*'] : (row.permissions || [])
  };
}

function applySystemOrderReasonMappings(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return order;
  if (order.cancel && typeof order.cancel === 'object') {
    const source = String(order.cancel.why || '').trim();
    order.cancel.whyZh = source ? orderMappings.cancelReasonZh(source) : '';
  }
  const returnSource = String(order.returnReason || order.returnInfo && order.returnInfo.reason || '').trim();
  if (returnSource) {
    order.returnReason = returnSource;
    order.returnReasonZh = orderMappings.cancelReasonZh(returnSource);
  } else if (order.returnInfo && typeof order.returnInfo === 'object') order.returnReasonZh = '暂无原因';
  if (order.returnInfo && typeof order.returnInfo === 'object') {
    const mappedStatus = orderMappings.returnStatusZh(order.returnInfo.status || order.returnInfo.statusName || '');
    if (mappedStatus) order.ret = mappedStatus;
  }
  return order;
}

function deriveSystemOrderReasonMappings(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return order;
  const derived = { ...order };
  if (order.cancel && typeof order.cancel === 'object' && !Array.isArray(order.cancel)) derived.cancel = { ...order.cancel };
  return applySystemOrderReasonMappings(derived);
}

class PostgresAuthStore {
  constructor(options = {}) {
    this.pool = options.pool || new Pool(createDatabaseConfig({ pool: true }));
    this.ownsPool = !options.pool;
    this.sessionAbsoluteMs = options.sessionAbsoluteMs;
    this.sessionIdleMs = options.sessionIdleMs;
    this.csrfSecret = options.csrfSecret || process.env.ERP_CSRF_SECRET || crypto.randomBytes(32).toString('hex');
  }

  csrfToken(sessionToken) {
    return crypto.createHmac('sha256', this.csrfSecret).update(String(sessionToken)).digest('hex');
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async healthcheck() {
    await this.pool.query('SELECT 1');
  }

  async getSystemExchangeRate(currencyPair, rateDate) {
    const result = await this.pool.query(
      `SELECT currency_pair,rate_date::text AS rate_date,effective_date::text AS effective_date,rate::text AS rate,source,fetch_status,last_error,fetched_at
       FROM system_exchange_rates WHERE currency_pair=$1 AND rate_date=$2::date LIMIT 1`,
      [currencyPair, rateDate]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { currencyPair: row.currency_pair, rateDate: row.rate_date, effectiveDate: row.effective_date, rate: row.rate == null ? null : Number(row.rate), source: row.source, fetchStatus: row.fetch_status, lastError: row.last_error, fetchedAt: row.fetched_at };
  }

  async getLatestSuccessfulExchangeRate(currencyPair) {
    const result = await this.pool.query(
      `SELECT currency_pair,rate_date::text AS rate_date,effective_date::text AS effective_date,rate::text AS rate,source,fetch_status,last_error,fetched_at
       FROM system_exchange_rates
       WHERE currency_pair=$1 AND fetch_status='success' AND rate IS NOT NULL
       ORDER BY rate_date DESC,fetched_at DESC LIMIT 1`,
      [currencyPair]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { currencyPair: row.currency_pair, rateDate: row.rate_date, effectiveDate: row.effective_date, rate: Number(row.rate), source: row.source, fetchStatus: row.fetch_status, lastError: row.last_error, fetchedAt: row.fetched_at };
  }

  async saveSystemExchangeRateSuccess(currencyPair, rateDate, rate, source, effectiveDate) {
    const result = await this.pool.query(
      `INSERT INTO system_exchange_rates(currency_pair,rate_date,effective_date,rate,source,fetch_status,last_error,fetched_at)
       VALUES($1,$2::date,$3::date,$4,$5,'success',NULL,now())
       ON CONFLICT(currency_pair,rate_date) DO UPDATE SET
         effective_date=EXCLUDED.effective_date,rate=EXCLUDED.rate,source=EXCLUDED.source,fetch_status='success',last_error=NULL,fetched_at=now(),updated_at=now()
       RETURNING currency_pair,rate_date::text AS rate_date,effective_date::text AS effective_date,rate::text AS rate,source,fetch_status,last_error,fetched_at`,
      [currencyPair, rateDate, effectiveDate, rate, source]
    );
    const row = result.rows[0];
    return { currencyPair: row.currency_pair, rateDate: row.rate_date, effectiveDate: row.effective_date, rate: Number(row.rate), source: row.source, fetchStatus: row.fetch_status, lastError: row.last_error, fetchedAt: row.fetched_at };
  }

  async saveSystemExchangeRateFailure(currencyPair, rateDate, errorText) {
    await this.pool.query(
      `INSERT INTO system_exchange_rates(currency_pair,rate_date,effective_date,rate,source,fetch_status,last_error,fetched_at)
       VALUES($1,$2::date,NULL,NULL,'bank_of_russia','failed',$3,now())
       ON CONFLICT(currency_pair,rate_date) DO UPDATE SET
         source=CASE WHEN system_exchange_rates.fetch_status='success' THEN system_exchange_rates.source ELSE EXCLUDED.source END,
         fetch_status=CASE WHEN system_exchange_rates.fetch_status='success' THEN 'success' ELSE 'failed' END,
         last_error=CASE WHEN system_exchange_rates.fetch_status='success' THEN system_exchange_rates.last_error ELSE EXCLUDED.last_error END,
         fetched_at=CASE WHEN system_exchange_rates.fetch_status='success' THEN system_exchange_rates.fetched_at ELSE now() END,
         updated_at=now()`,
      [currencyPair, rateDate, String(errorText || '').slice(0, 500)]
    );
  }

  // 试用方案权威口径（G-1）：只认已发布的最高版本，新注册与完善资料赠送都读它，页面文案不得自行推算。
  async publishedTrialPlan(clientOrPool) {
    const result = await clientOrPool.query(
      `SELECT id,duration_days,(benefits->>'profileBonusDays')::integer AS profile_bonus_days
       FROM membership_plan_versions
       WHERE plan_code='trial' AND status='published' AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())
       ORDER BY version_no DESC LIMIT 1`
    );
    if (!result.rowCount) return null;
    const durationDays = Number(result.rows[0].duration_days);
    const bonusDays = Number(result.rows[0].profile_bonus_days);
    return {
      planVersionId: String(result.rows[0].id),
      durationDays,
      bonusDays: bonusDays > 0 ? bonusDays : durationDays
    };
  }

  // 试用段唯一写入口（G-3）：注册段与完善资料段共用，按客户空间累计发放天数校验 30 天上限；
  // 当前已有同级或更高权益在计时时排队接续，不覆盖、不清零（会员时间叠加规则 3.3）。
  async grantTrialPeriod(client, input) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-periods:'||$1,0))", [String(input.tenantId)]);
    if (input.idempotencyLockKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('trial-grant:'||$1,0))", [String(input.idempotencyLockKey)]);
    }
    const claimed = await client.query(`SELECT 1 FROM membership_trial_claims WHERE tenant_id=$1 AND claim_type=$2`, [input.tenantId, input.claimType]);
    if (claimed.rowCount) return { granted: false, reason: 'already_claimed' };
    const used = await client.query(
      `SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (ends_at - starts_at)))),0)::bigint AS seconds
       FROM membership_periods WHERE tenant_id=$1 AND source_type = ANY($2)`,
      [input.tenantId, TRIAL_SOURCE_TYPES]
    );
    const grantedDays = Math.min(input.requestedDays, Math.max(0, Math.floor(TRIAL_TOTAL_CAP_DAYS - Number(used.rows[0].seconds) / 86400)));
    if (grantedDays <= 0) return { granted: false, reason: 'trial_cap_reached' };
    const queuedBehind = await client.query(
      `SELECT GREATEST(now(), COALESCE(MAX(p.ends_at), now())) AS starts_at
       FROM membership_periods p JOIN membership_plan_versions v ON v.id=p.plan_version_id
       WHERE p.tenant_id=$1 AND p.state='active' AND p.starts_at<=now()
         AND (p.ends_at IS NULL OR p.ends_at>now()) AND v.benefit_rank>=0`,
      [input.tenantId]
    );
    const startsAt = queuedBehind.rows[0].starts_at;
    const state = new Date(startsAt).getTime() > Date.now() ? 'queued' : 'active';
    const period = await client.query(
      `INSERT INTO membership_periods(tenant_id,plan_version_id,source_type,source_ref,state,starts_at,ends_at,created_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$6::timestamptz+make_interval(days=>$7),$8)
       RETURNING id::text AS id,starts_at,ends_at`,
      [input.tenantId, input.planVersionId, input.sourceType, input.sourceRef, state, startsAt, grantedDays, input.userId]
    );
    await client.query(
      `INSERT INTO membership_trial_claims(tenant_id,claim_type,verified_email_hash,period_id) VALUES($1,$2,$3,$4)`,
      [input.tenantId, input.claimType, input.verifiedEmailHash || null, period.rows[0].id]
    );
    const usedSeconds = Number(used.rows[0].seconds);
    const days = seconds => Math.round((seconds / 86400) * 100) / 100;
    const metadata = {
      grantedDays, requestedDays: input.requestedDays, capDays: TRIAL_TOTAL_CAP_DAYS,
      // 赠送前后的试用累计天数与幂等键摘要必须同流水落库，事后要能核对"这次到底补了多少"。
      trialDaysBefore: days(usedSeconds), trialDaysAfter: days(usedSeconds + grantedDays * 86400),
      idempotencyKeyDigest: crypto.createHash('sha256')
        .update(String(input.idempotencyLockKey || `${input.tenantId}:${input.claimType}`)).digest('hex').slice(0, 16),
      operatorUserId: String(input.userId || ''), claimType: input.claimType, sourceType: input.sourceType,
      periodState: state === 'active' ? '立即生效' : '排队接续', ...(input.metadata || {})
    };
    if (grantedDays < input.requestedDays) metadata.cappedReason = `注册与完善资料赠送合计最多 ${TRIAL_TOTAL_CAP_DAYS} 天，本次只补到上限`;
    await client.query(
      `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,next_state,metadata)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
      [input.tenantId, period.rows[0].id, input.userId, input.eventType, state, JSON.stringify(metadata)]
    );
    await this.writeAudit(client, { tenantId: input.tenantId, userId: input.userId },
      `membership.trial.${input.claimType}`, 'membership_period', period.rows[0].id, 'success', {
        grantedDays, capDays: TRIAL_TOTAL_CAP_DAYS, trialDaysBefore: metadata.trialDaysBefore,
        trialDaysAfter: metadata.trialDaysAfter, idempotencyKeyDigest: metadata.idempotencyKeyDigest,
        periodState: metadata.periodState, triggeredBy: input.triggeredBy || null
      });
    return {
      granted: true, grantedDays, state, periodId: period.rows[0].id,
      startsAt: period.rows[0].starts_at, endsAt: period.rows[0].ends_at,
      capped: grantedDays < input.requestedDays
    };
  }

  async usernameExists(username) {
    const result = await this.pool.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
    return result.rowCount > 0;
  }

  async emailLoginStates(email) {
    const normalized = normalizeAuthEmail(email);
    if (!normalized) return [];
    const result = await this.pool.query(
      `SELECT u.id AS user_id, u.username, u.password_hash, u.status AS user_status, u.is_system_admin,
              up.email, up.email_verified_at,
              tm.tenant_id, tm.member_type, tm.status AS member_status, tm.display_name, tm.shop_scope_mode, tm.created_at,
              t.name AS tenant_name, t.status AS tenant_status, usp.block_type, usp.auto_unfreeze_at,
              COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
         FROM users u
         JOIN user_profiles up ON up.user_id = u.id
         JOIN tenant_members tm ON tm.user_id = u.id
         JOIN tenants t ON t.id = tm.tenant_id
         LEFT JOIN user_security_profiles usp ON usp.tenant_id = tm.tenant_id AND usp.user_id = tm.user_id
         LEFT JOIN member_roles mr ON mr.tenant_id = tm.tenant_id AND mr.user_id = tm.user_id
         LEFT JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
        WHERE u.is_system_admin = false
          AND up.email_verified_at IS NOT NULL
          AND lower(up.email) = lower($1)
          AND tm.status <> 'removed'
        GROUP BY u.id, up.email, up.email_verified_at, tm.tenant_id, tm.member_type, tm.status,
                 tm.display_name, tm.shop_scope_mode, tm.created_at, t.name, t.status, usp.block_type, usp.auto_unfreeze_at
        ORDER BY tm.created_at ASC`,
      [normalized]
    );
    return result.rows.map(row => ({
      row,
      email: normalized,
      account: normalizeAccount(row),
      tenantName: String(row.tenant_name || ''),
      blockType: String(row.block_type || 'none'),
      autoUnfreezeAt: row.auto_unfreeze_at || null,
      memberStatus: String(row.member_status || ''),
      userStatus: String(row.user_status || ''),
      tenantStatus: String(row.tenant_status || '')
    }));
  }

  emailTenantChoices(states) {
    return (Array.isArray(states) ? states : []).map(state => ({
      tenantId: state.account.tenantId,
      tenantName: state.tenantName || state.account.displayName || ('企业 ' + state.account.tenantId),
      memberType: state.account.memberType,
      displayName: state.account.displayName
    }));
  }

  async emailLoginState(email, tenantId) {
    const states = await this.emailLoginStates(email);
    if (!states.length) return null;
    if (tenantId != null && String(tenantId).trim()) {
      return states.find(state => String(state.account.tenantId) === String(tenantId)) || null;
    }
    if (states.length === 1) return states[0];
    return {
      tenantSelectionRequired: true,
      email: states[0].email,
      userId: states[0].account.userId,
      row: states[0].row,
      tenants: this.emailTenantChoices(states)
    };
  }

  async verifyEmailCredentials(email, password, tenantId) {
    const states = await this.emailLoginStates(email);
    const identityRow = states[0] && states[0].row;
    const valid = identityRow
      ? await verifyPassword(password, identityRow.password_hash)
      : await verifyPassword(password, 'scrypt-v1$00000000000000000000000000000000$' + '00'.repeat(64));
    if (!states.length || !valid) return null;
    if (tenantId == null || !String(tenantId).trim()) {
      if (states.length > 1) {
        return {
          tenantSelectionRequired: true,
          email: states[0].email,
          userId: states[0].account.userId,
          tenants: this.emailTenantChoices(states)
        };
      }
    }
    const state = tenantId == null || !String(tenantId).trim()
      ? states[0]
      : states.find(item => String(item.account.tenantId) === String(tenantId));
    if (!state) throw Object.assign(new Error('请选择正确的企业后继续登录。'), { publicCode: 'tenant_selection_invalid' });
    if (state.userStatus !== 'active' || state.tenantStatus !== 'active') return null;
    if (state.blockType === 'banned') {
      throw Object.assign(new Error('账号已被系统管理员停用，请联系系统管理员。'), { publicCode: 'account_banned', blockType: state.blockType });
    }
    if (state.blockType === 'manual_frozen') {
      throw Object.assign(new Error('账号已被系统管理员冻结，请联系系统管理员解冻。'), { publicCode: 'account_frozen', blockType: state.blockType });
    }
    if (state.memberStatus !== 'active' && state.blockType !== 'auto_frozen') return null;
    return state;
  }

  async emailIdentity(email) {
    const states = await this.emailLoginStates(email);
    if (!states.length) return null;
    return {
      email: states[0].email,
      userId: states[0].account.userId,
      tenants: this.emailTenantChoices(states),
      states
    };
  }

  async accountForEmailRecovery(email, tenantId) {
    const states = await this.emailLoginStates(email);
    if (!states.length) return null;
    if ((tenantId == null || !String(tenantId).trim()) && states.length > 1) {
      return {
        tenantSelectionRequired: true,
        email: states[0].email,
        userId: states[0].account.userId,
        tenants: this.emailTenantChoices(states)
      };
    }
    const state = tenantId == null || !String(tenantId).trim()
      ? states[0]
      : states.find(item => String(item.account.tenantId) === String(tenantId));
    if (!state || state.userStatus !== 'active' || state.tenantStatus !== 'active') return null;
    if (state.blockType === 'banned') {
      throw Object.assign(new Error('账号已被系统管理员停用，请联系系统管理员。'), { publicCode: 'account_banned', blockType: state.blockType });
    }
    if (state.blockType === 'manual_frozen') {
      throw Object.assign(new Error('账号已被系统管理员冻结，请联系系统管理员解冻。'), { publicCode: 'account_frozen', blockType: state.blockType });
    }
    if (state.memberStatus !== 'active' && state.blockType !== 'auto_frozen') return null;
    return state;
  }

  async isTrustedLoginDevice(userId, deviceHash) {
    if (!/^[a-f0-9]{64}$/.test(String(deviceHash || ''))) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM user_login_devices
        WHERE user_id=$1 AND device_hash=$2 AND revoked_at IS NULL
        LIMIT 1`,
      [userId, deviceHash]
    );
    return result.rowCount > 0;
  }

  async hasTrustedLoginDevice(userId) {
    const result = await this.pool.query(
      `SELECT 1 FROM user_login_devices
        WHERE user_id=$1 AND revoked_at IS NULL
        LIMIT 1`,
      [userId]
    );
    return result.rowCount > 0;
  }

  async trustLoginDevice(account, deviceHash, ipAddress) {
    if (!account || !/^[a-f0-9]{64}$/.test(String(deviceHash || ''))) return false;
    const ip = /^[0-9a-fA-F.:]{1,80}$/.test(String(ipAddress || '')) ? String(ipAddress) : null;
    await this.pool.query(
      `INSERT INTO user_login_devices(user_id,device_hash,last_ip)
       VALUES($1,$2,$3)
       ON CONFLICT(user_id,device_hash) DO UPDATE
         SET last_verified_at=now(),last_ip=EXCLUDED.last_ip,revoked_at=NULL,revoke_reason=NULL`,
      [account.userId, deviceHash, ip]
    );
    return true;
  }

  async issueAuthEmailChallenge(input, sendCode) {
    const purpose = String(input && input.purpose || '');
    if (!['register', 'login_step_up', 'password_recovery'].includes(purpose)) {
      throw Object.assign(new Error('邮箱验证用途无效，请刷新页面后重试。'), { publicCode: 'email_challenge_purpose_invalid' });
    }
    const email = normalizeAuthEmail(input && input.email);
    if (!email) throw Object.assign(new Error('邮箱格式不正确，请填写完整邮箱地址。'), { publicCode: 'invalid_email' });
    const userId = input && input.userId ? String(input.userId) : null;
    const client = await this.pool.connect();
    let rowId = null;
    let code = null;
    let expiresAt = null;
    try {
      await client.query('BEGIN');
      if (purpose === 'register') {
        const taken = await client.query(
          `SELECT 1 FROM user_profiles up JOIN users u ON u.id=up.user_id
            WHERE u.is_system_admin=false AND lower(up.email)=lower($1) LIMIT 1`,
          [email]
        );
        if (taken.rowCount) throw Object.assign(new Error('该邮箱已注册，请直接登录。'), { publicCode: 'email_already_registered' });
      } else {
        if (!userId) throw Object.assign(new Error('未找到可验证的账号。'), { publicCode: 'email_account_missing' });
        const owns = await client.query(
          `SELECT 1 FROM user_profiles up JOIN users u ON u.id=up.user_id
            WHERE up.user_id=$1 AND u.is_system_admin=false
              AND up.email_verified_at IS NOT NULL AND lower(up.email)=lower($2) LIMIT 1`,
          [userId, email]
        );
        if (!owns.rowCount) throw Object.assign(new Error('未找到可验证的账号。'), { publicCode: 'email_account_missing' });
      }
      const recent = await client.query(
        `SELECT count(*)::int AS total,
                max(created_at) FILTER (WHERE consumed_at IS NULL) AS last_at
           FROM auth_email_challenges
          WHERE lower(email)=lower($1) AND purpose=$2 AND created_at>now()-interval '1 hour'`,
        [email, purpose]
      );
      const lastAt = recent.rows[0].last_at;
      if (lastAt && Date.now() - new Date(lastAt).getTime() < EMAIL_CODE_RESEND_SECONDS * 1000) {
        throw Object.assign(new Error('验证码发送过于频繁，请稍后再试。'), {
          publicCode: 'email_code_too_frequent',
          retryAfterSeconds: EMAIL_CODE_RESEND_SECONDS - Math.floor((Date.now() - new Date(lastAt).getTime()) / 1000)
        });
      }
      if (recent.rows[0].total >= EMAIL_CODE_HOURLY_LIMIT) {
        throw Object.assign(new Error('本小时邮箱验证码发送次数已用完，请稍后再试。'), { publicCode: 'email_code_hourly_limit' });
      }
      code = process.env.NODE_ENV === 'test' && process.env.ERP_EMAIL_CODE_TEST_MODE === '1'
        ? '888888'
        : String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const inserted = await client.query(
        `INSERT INTO auth_email_challenges
           (purpose,email,user_id,code_hash,expires_at,created_ip,created_device_hash)
         VALUES($1,$2,$3,$4,now()+make_interval(mins=>$5),$6,$7)
         RETURNING id,expires_at`,
        [
          purpose, email, userId,
          authEmailChallengeHash(purpose, userId, email, code),
          EMAIL_CODE_VALID_MINUTES,
          /^[0-9a-fA-F.:]{1,80}$/.test(String(input.createdIp || '')) ? String(input.createdIp) : null,
          /^[a-f0-9]{64}$/.test(String(input.deviceHash || '')) ? String(input.deviceHash) : null
        ]
      );
      rowId = inserted.rows[0].id;
      expiresAt = inserted.rows[0].expires_at;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }

    let sent;
    try { sent = await sendCode(email, code, EMAIL_CODE_VALID_MINUTES, purpose); }
    catch (cause) { sent = { sent: false, reason: 'send_exception' }; }
    if (!sent || sent.sent !== true) {
      await this.pool.query('DELETE FROM auth_email_challenges WHERE id=$1', [rowId]).catch(() => {});
      throw Object.assign(new Error('邮箱验证码发送失败，请稍后重试；仍未收到请联系管理员。'), {
        publicCode: 'email_code_send_failed',
        sendReason: sent && sent.reason || 'send_failed'
      });
    }
    return { email, emailMask: maskLoginAccount(email), expiresAt: expiresAt.toISOString() };
  }

  async consumeAuthEmailChallenge(client, input) {
    const purpose = String(input && input.purpose || '');
    const email = normalizeAuthEmail(input && input.email);
    const userId = input && input.userId ? String(input.userId) : null;
    const code = String(input && input.code || '').trim();
    if (!['register', 'login_step_up', 'password_recovery'].includes(purpose) || !email || !/^\d{6}$/.test(code)) {
      throw Object.assign(new Error('邮箱验证码格式不正确，请输入邮件中的6位验证码。'), { publicCode: 'email_code_invalid' });
    }
    const pending = await client.query(
      `SELECT id,code_hash,attempts,expires_at
         FROM auth_email_challenges
        WHERE purpose=$1 AND lower(email)=lower($2)
          AND user_id IS NOT DISTINCT FROM $3::bigint
          AND consumed_at IS NULL
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [purpose, email, userId]
    );
    if (!pending.rowCount) throw Object.assign(new Error('请先获取邮箱验证码。'), { publicCode: 'email_code_missing' });
    const row = pending.rows[0];
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw Object.assign(new Error('邮箱验证码已过期，请重新获取。'), { publicCode: 'email_code_expired' });
    }
    if (Number(row.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) {
      throw Object.assign(new Error('验证码错误次数已达上限，请重新获取。'), { publicCode: 'email_code_attempts_exceeded' });
    }
    if (row.code_hash !== authEmailChallengeHash(purpose, userId, email, code)) {
      await client.query('UPDATE auth_email_challenges SET attempts=attempts+1 WHERE id=$1', [row.id]);
      throw Object.assign(new Error('邮箱验证码不正确，请核对后重试。'), { publicCode: 'email_code_invalid' });
    }
    await client.query(
      input && input.consume === false
        ? 'UPDATE auth_email_challenges SET verified_at=COALESCE(verified_at,now()) WHERE id=$1'
        : 'UPDATE auth_email_challenges SET verified_at=COALESCE(verified_at,now()),consumed_at=now() WHERE id=$1',
      [row.id]
    );
    return { id: String(row.id), email };
  }

  async verifyAuthEmailChallenge(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await this.consumeAuthEmailChallenge(client, input);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async ensureReferralCodeOn(client, userId, tenantId) {
    const existing = await client.query(
      'SELECT code FROM referral_codes WHERE inviter_user_id=$1 AND inviter_tenant_id=$2',
      [userId, tenantId]
    );
    if (existing.rowCount) return existing.rows[0].code;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const code = newReferralCode();
      try {
        const inserted = await client.query(
          `INSERT INTO referral_codes(inviter_user_id,inviter_tenant_id,code)
           VALUES($1,$2,$3)
           ON CONFLICT (inviter_user_id,inviter_tenant_id) DO NOTHING
           RETURNING code`,
          [userId, tenantId, code]
        );
        if (inserted.rowCount) return inserted.rows[0].code;
        const raced = await client.query(
          'SELECT code FROM referral_codes WHERE inviter_user_id=$1 AND inviter_tenant_id=$2',
          [userId, tenantId]
        );
        if (raced.rowCount) return raced.rows[0].code;
      } catch (error) {
        if (error.code !== '23505') throw error;
      }
    }
    throw Object.assign(new Error('邀请码生成失败，请稍后重试。'), { publicCode: 'referral_code_generation_failed' });
  }

  async referralInviterOn(client, rawCode, inviteeEmail = '') {
    const code = normalizeReferralCode(rawCode);
    if (!code) return null;
    if (!REFERRAL_CODE_RE.test(code)) {
      throw Object.assign(new Error('邀请码格式不正确，请核对后重试；也可以清空邀请码继续注册。'), { publicCode: 'referral_code_invalid' });
    }
    const result = await client.query(
      `SELECT rc.code,rc.inviter_user_id::text,rc.inviter_tenant_id::text,
              u.status AS user_status,u.is_system_admin,t.status AS tenant_status,
              tm.member_type,tm.status AS member_status,lower(COALESCE(up.email,'')) AS inviter_email,
              a.status AS agent_status
         FROM referral_codes rc
         JOIN users u ON u.id=rc.inviter_user_id
         JOIN tenants t ON t.id=rc.inviter_tenant_id
         JOIN tenant_members tm ON tm.tenant_id=rc.inviter_tenant_id AND tm.user_id=rc.inviter_user_id
         LEFT JOIN user_profiles up ON up.user_id=rc.inviter_user_id
         LEFT JOIN agents a ON a.tenant_id=rc.inviter_tenant_id
        WHERE rc.code=$1`,
      [code]
    );
    const row = result.rows[0];
    if (!row || row.is_system_admin === true || row.user_status !== 'active' || row.tenant_status !== 'active'
        || row.member_type !== 'owner' || row.member_status !== 'active' || (row.agent_status && row.agent_status !== 'active')) {
      throw Object.assign(new Error('邀请码无效或当前不可用，请核对后重试；也可以清空邀请码继续注册。'), { publicCode: 'referral_code_unavailable' });
    }
    if (inviteeEmail && row.inviter_email && row.inviter_email === String(inviteeEmail).trim().toLowerCase()) {
      throw Object.assign(new Error('不能使用自己的邀请码注册新账号。'), { publicCode: 'referral_self_invite_forbidden' });
    }
    return {
      code: row.code,
      inviterUserId: row.inviter_user_id,
      inviterTenantId: row.inviter_tenant_id,
      kind: row.agent_status === 'active' ? 'agent' : 'ordinary'
    };
  }

  async getReferralProgram(account) {
    if (!account || account.isSystemAdmin || account.memberType !== 'owner') {
      return { eligible: false, reason: account && account.isSystemAdmin ? 'system_admin' : 'subaccount', signupRewardBean: REFERRAL_SIGNUP_REWARD_BEAN, paidRewardBean: REFERRAL_FIRST_PAID_REWARD_BEAN };
    }
    const result = await this.pool.query(
      `SELECT rc.code,
              EXISTS(SELECT 1 FROM agents a WHERE a.tenant_id=$1) AS has_agent_record,
              (SELECT count(*)::integer FROM user_referrals r WHERE r.inviter_tenant_id=$1 AND r.inviter_user_id=$2) AS invited_count,
              (SELECT count(*)::integer FROM user_referrals r WHERE r.inviter_tenant_id=$1 AND r.inviter_user_id=$2 AND r.paid_reward_event_id IS NOT NULL) AS paid_reward_count
         FROM referral_codes rc
        WHERE rc.inviter_tenant_id=$1 AND rc.inviter_user_id=$2`,
      [account.tenantId, account.userId]
    );
    if (!result.rowCount) {
      return { eligible: false, reason: 'code_unavailable', signupRewardBean: REFERRAL_SIGNUP_REWARD_BEAN, paidRewardBean: REFERRAL_FIRST_PAID_REWARD_BEAN };
    }
    const row = result.rows[0];
    if (row.has_agent_record === true) {
      return { eligible: false, reason: 'agent', signupRewardBean: REFERRAL_SIGNUP_REWARD_BEAN, paidRewardBean: REFERRAL_FIRST_PAID_REWARD_BEAN };
    }
    return {
      eligible: true, code: row.code,
      signupRewardBean: REFERRAL_SIGNUP_REWARD_BEAN,
      paidRewardBean: REFERRAL_FIRST_PAID_REWARD_BEAN,
      invitedCount: Number(row.invited_count || 0),
      paidRewardCount: Number(row.paid_reward_count || 0)
    };
  }

  async grantReferralPaidRewardForClient(client, input) {
    const inviteeTenantId = String(input && input.inviteeTenantId || '');
    const periodId = String(input && input.periodId || '');
    if (!/^\d+$/.test(inviteeTenantId) || !/^\d+$/.test(periodId)) return { status: 'not_applicable' };
    const referralResult = await client.query(
      `SELECT r.*,u.status AS inviter_user_status,u.is_system_admin,
              tm.member_type AS inviter_member_type,tm.status AS inviter_member_status,
              t.status AS inviter_tenant_status,
              EXISTS(SELECT 1 FROM agents a WHERE a.tenant_id=r.inviter_tenant_id) AS inviter_is_agent,
              EXISTS(SELECT 1 FROM agents a WHERE a.tenant_id=r.invitee_tenant_id) AS invitee_is_agent
         FROM user_referrals r
         JOIN users u ON u.id=r.inviter_user_id
         JOIN tenants t ON t.id=r.inviter_tenant_id
         JOIN tenant_members tm ON tm.tenant_id=r.inviter_tenant_id AND tm.user_id=r.inviter_user_id
        WHERE r.invitee_tenant_id=$1
        FOR UPDATE OF r`,
      [inviteeTenantId]
    );
    if (!referralResult.rowCount) return { status: 'not_referred' };
    const referral = referralResult.rows[0];
    if (referral.paid_reward_event_id) return { status: referral.paid_reward_reversal_event_id ? 'already_reversed' : 'already_rewarded' };
    const firstPaid = await client.query(
      `SELECT period_id::text
         FROM membership_events
        WHERE tenant_id=$1 AND event_type='payment_entitlement_confirmed'
        ORDER BY id ASC LIMIT 1`,
      [inviteeTenantId]
    );
    if (!firstPaid.rowCount || String(firstPaid.rows[0].period_id) !== periodId) return { status: 'not_first_paid_membership' };
    if (referral.is_system_admin === true || referral.inviter_user_status !== 'active'
        || referral.inviter_tenant_status !== 'active' || referral.inviter_member_type !== 'owner'
        || referral.inviter_member_status !== 'active' || referral.inviter_is_agent === true || referral.invitee_is_agent === true) {
      return { status: 'participant_ineligible' };
    }
    const reward = await mutateOn(client, referral.inviter_tenant_id, {
      eventType: 'referral_paid_reward', direction: 'credit', amount: REFERRAL_FIRST_PAID_REWARD_BEAN,
      idempotencyKey: `referral-paid:${referral.id}`,
      businessRef: `referral:${referral.id}:first-paid`,
      reason: `邀请用户首次成功购买付费会员，奖励 ${REFERRAL_FIRST_PAID_REWARD_BEAN} AI豆`,
      actorUserId: input.actorUserId || null,
      apply: current => ({ balance: current.balance + REFERRAL_FIRST_PAID_REWARD_BEAN, frozen: current.frozen })
    });
    const activationCodeId = /^\d+$/.test(String(input.activationCodeId || '')) ? String(input.activationCodeId) : null;
    await client.query(
      `UPDATE user_referrals
          SET first_paid_period_id=$2,first_paid_activation_code_id=$3,
              paid_reward_event_id=$4,paid_rewarded_at=clock_timestamp()
        WHERE id=$1 AND paid_reward_event_id IS NULL`,
      [referral.id, periodId, activationCodeId, reward.event.id]
    );
    await this.insertUserNotification(client, {
      tenantId: referral.inviter_tenant_id, userId: referral.inviter_user_id,
      category: 'ai.beans.referral', title: '邀请奖励AI豆到账',
      body: `你邀请的用户首次成功购买付费会员，${REFERRAL_FIRST_PAID_REWARD_BEAN} AI豆已到账，当前AI豆余额 ${Number(reward.event.balanceAfter)} 豆。`,
      resourceType: 'user_referral', resourceId: String(referral.id),
      dedupeKey: `referral:${referral.id}:paid-reward`
    });
    return { status: 'rewarded', referralId: String(referral.id), beanEventId: String(reward.event.id), balanceAfter: Number(reward.event.balanceAfter) };
  }

  async reverseReferralPaidRewardForClient(client, input) {
    const periodId = String(input && input.periodId || '');
    const activationCodeId = String(input && input.activationCodeId || '');
    if (!/^\d+$/.test(periodId) && !/^\d+$/.test(activationCodeId)) return { status: 'not_applicable' };
    const values = [];
    const clauses = [];
    if (/^\d+$/.test(periodId)) { values.push(periodId); clauses.push(`first_paid_period_id=$${values.length}`); }
    if (/^\d+$/.test(activationCodeId)) { values.push(activationCodeId); clauses.push(`first_paid_activation_code_id=$${values.length}`); }
    const found = await client.query(
      `SELECT * FROM user_referrals
        WHERE paid_reward_event_id IS NOT NULL
          AND paid_reward_reversal_event_id IS NULL
          AND (${clauses.join(' OR ')})
        ORDER BY id LIMIT 1 FOR UPDATE`,
      values
    );
    if (!found.rowCount) return { status: 'not_found' };
    const referral = found.rows[0];
    const reversal = await mutateOn(client, referral.inviter_tenant_id, {
      eventType: 'referral_reward_reversal', direction: 'debit', amount: REFERRAL_FIRST_PAID_REWARD_BEAN,
      idempotencyKey: `referral-paid-reversal:${referral.id}`,
      businessRef: `referral:${referral.id}:first-paid`,
      reason: `被邀请用户的首次付费会员已${String(input.trigger || '撤销')}，扣回邀请奖励 ${REFERRAL_FIRST_PAID_REWARD_BEAN} AI豆`,
      actorUserId: input.actorUserId || null,
      apply: current => {
        if (current.balance < REFERRAL_FIRST_PAID_REWARD_BEAN) {
          throw Object.assign(new Error(`邀请奖励扣回需要 ${REFERRAL_FIRST_PAID_REWARD_BEAN} AI豆，但当前可用余额不足；本次退款/撤销已暂停，请先补足AI豆后重试。`), { publicCode: 'referral_reward_reversal_insufficient' });
        }
        return { balance: current.balance - REFERRAL_FIRST_PAID_REWARD_BEAN, frozen: current.frozen };
      }
    });
    await client.query(
      `UPDATE user_referrals
          SET paid_reward_reversal_event_id=$2,paid_reward_reversed_at=clock_timestamp()
        WHERE id=$1 AND paid_reward_reversal_event_id IS NULL`,
      [referral.id, reversal.event.id]
    );
    await this.insertUserNotification(client, {
      tenantId: referral.inviter_tenant_id, userId: referral.inviter_user_id,
      category: 'ai.beans.referral_reversal', title: '邀请奖励AI豆已扣回',
      body: `被邀请用户的首次付费会员已${String(input.trigger || '撤销')}，此前发放的 ${REFERRAL_FIRST_PAID_REWARD_BEAN} AI豆邀请奖励已扣回，当前AI豆余额 ${Number(reversal.event.balanceAfter)} 豆。`,
      resourceType: 'user_referral', resourceId: String(referral.id),
      dedupeKey: `referral:${referral.id}:paid-reversal`
    });
    return { status: 'reversed', referralId: String(referral.id), beanEventId: String(reversal.event.id), balanceAfter: Number(reversal.event.balanceAfter) };
  }

  async agentReferralSummaryOn(client, agent, monthStart = '') {
    if (!agent || agent.status !== 'active') {
      return { eligible: false, code: '', validInvitedCount: 0, groupCreditCount: 0, paidCreditCount: 0, earnedCreditCount: 0, usedCreditCount: 0, remainingCreditCount: 0, currentMonthUsed: 0, usedOtherCredits: 0, availableForMonth: 0 };
    }
    const code = await this.ensureReferralCodeOn(client, agent.owner_user_id, agent.tenant_id);
    const earned = await client.query(
      `SELECT count(*)::integer AS valid_invited_count,
              count(*) FILTER (WHERE ar.paid_credit_granted_at IS NOT NULL AND ar.paid_credit_reversed_at IS NULL)::integer AS paid_credit_count
         FROM agent_referrals ar
         JOIN users iu ON iu.id=ar.invitee_user_id
         JOIN tenants it ON it.id=ar.invitee_tenant_id
         JOIN tenant_members itm ON itm.tenant_id=ar.invitee_tenant_id AND itm.user_id=ar.invitee_user_id
         JOIN user_profiles iup ON iup.user_id=ar.invitee_user_id
         LEFT JOIN agents ia ON ia.tenant_id=ar.invitee_tenant_id
        WHERE ar.inviter_tenant_id=$1 AND ar.inviter_user_id=$2
          AND iu.status='active' AND iu.is_system_admin=false AND it.status='active'
          AND itm.member_type='owner' AND itm.status='active' AND iup.email_verified_at IS NOT NULL
          AND ia.tenant_id IS NULL`,
      [agent.tenant_id, agent.owner_user_id]
    );
    const validInvitedCount = Number(earned.rows[0]?.valid_invited_count) || 0;
    const paidCreditCount = Number(earned.rows[0]?.paid_credit_count) || 0;
    const groupCreditCount = Math.floor(validInvitedCount / 3);
    const earnedCreditCount = groupCreditCount + paidCreditCount;
    const usage = await client.query(
      `SELECT COALESCE(sum(CASE WHEN COALESCE(metadata->>'agentReferralCreditUsed','') ~ '^\\d+$'
                    THEN (metadata->>'agentReferralCreditUsed')::integer ELSE 0 END),0)::integer AS used_total,
              COALESCE(sum(CASE WHEN month_start=$2::date AND COALESCE(metadata->>'agentReferralCreditUsed','') ~ '^\\d+$'
                    THEN (metadata->>'agentReferralCreditUsed')::integer ELSE 0 END),0)::integer AS used_current
         FROM agent_monthly_stats WHERE tenant_id=$1`,
      [agent.tenant_id, monthStart || '0001-01-01']
    );
    const usedCreditCount = Math.max(0, Number(usage.rows[0]?.used_total) || 0);
    const currentMonthUsed = monthStart ? Math.max(0, Number(usage.rows[0]?.used_current) || 0) : 0;
    const usedOtherCredits = Math.max(0, usedCreditCount - currentMonthUsed);
    return {
      eligible: true, code, validInvitedCount, groupCreditCount, paidCreditCount, earnedCreditCount, usedCreditCount,
      remainingCreditCount: Math.max(0, earnedCreditCount - usedCreditCount),
      currentMonthUsed, usedOtherCredits, availableForMonth: Math.max(0, earnedCreditCount - usedOtherCredits)
    };
  }

  async grantAgentReferralPaidCreditForClient(client, input) {
    const inviteeTenantId = String(input && input.inviteeTenantId || '');
    const sourceKind = String(input && input.sourceKind || '');
    const sourceId = String(input && input.sourceId || '');
    if (!/^\d+$/.test(inviteeTenantId) || !['membership', 'bean_recharge'].includes(sourceKind) || !/^\d+$/.test(sourceId)) {
      return { status: 'not_applicable' };
    }
    const found = await client.query(
      `SELECT ar.*,a.status AS inviter_agent_status,ia.tenant_id IS NOT NULL AS invitee_has_agent
         FROM agent_referrals ar
         JOIN agents a ON a.tenant_id=ar.inviter_tenant_id AND a.owner_user_id=ar.inviter_user_id
         LEFT JOIN agents ia ON ia.tenant_id=ar.invitee_tenant_id
        WHERE ar.invitee_tenant_id=$1
        ORDER BY ar.id LIMIT 1 FOR UPDATE OF ar`,
      [inviteeTenantId]
    );
    if (!found.rowCount) return { status: 'not_found' };
    const referral = found.rows[0];
    if (referral.inviter_agent_status !== 'active' || referral.invitee_has_agent === true) return { status: 'not_eligible' };
    if (referral.paid_credit_granted_at && !referral.paid_credit_reversed_at) return { status: 'already_credited', referralId: String(referral.id) };
    let validSource = false;
    if (sourceKind === 'membership') {
      const source = await client.query(
        `SELECT 1 FROM membership_periods p
          WHERE p.tenant_id=$1 AND p.id=$2 AND p.state<>'revoked'
            AND (p.source_type='direct_payment' OR EXISTS (
              SELECT 1 FROM membership_events me
               WHERE me.tenant_id=p.tenant_id AND me.period_id=p.id AND me.event_type='payment_entitlement_confirmed'
            )) LIMIT 1`,
        [inviteeTenantId, sourceId]
      );
      validSource = source.rowCount === 1;
    } else {
      const source = await client.query(
        `SELECT 1 FROM activation_codes
          WHERE id=$2 AND redeemed_tenant_id=$1 AND benefit_type='bean_recharge'
            AND state='paid' AND payment_confirmed_at IS NOT NULL
            AND (issuance_type IN ('agent','agent_delegated')
              OR (issuance_type='platform_direct' AND fulfillment_type='paid' AND platform_payment_id IS NOT NULL))
          LIMIT 1`,
        [inviteeTenantId, sourceId]
      );
      validSource = source.rowCount === 1;
    }
    if (!validSource) return { status: 'source_not_confirmed' };
    const previousState = {
      referralId: String(referral.id), active: Boolean(referral.paid_credit_granted_at && !referral.paid_credit_reversed_at),
      sourceKind: referral.paid_credit_source_kind || null, sourceId: referral.paid_credit_source_id && String(referral.paid_credit_source_id)
    };
    await client.query(
      `UPDATE agent_referrals
          SET paid_credit_source_kind=$2,paid_credit_source_id=$3,paid_credit_granted_at=clock_timestamp(),paid_credit_reversed_at=NULL
        WHERE id=$1`,
      [referral.id, sourceKind, sourceId]
    );
    await client.query(
      `INSERT INTO agent_qualification_events(tenant_id,actor_user_id,event_type,reason,previous_state,next_state)
       VALUES($1,$2,'referral_credit_earned','被邀请普通用户完成首次有效付费会员或AI豆充值，增加1个资格任务抵扣额度',$3::jsonb,$4::jsonb)`,
      [referral.inviter_tenant_id, input.actorUserId || null, JSON.stringify(previousState), JSON.stringify({
        referralId: String(referral.id), active: true, sourceKind, sourceId
      })]
    );
    await this.insertUserNotification(client, {
      tenantId: referral.inviter_tenant_id, userId: referral.inviter_user_id, category: 'agent.qualification',
      title: '代理邀请资格抵扣 +1',
      body: '你邀请的普通用户已完成首次有效付费，新增1个代理资格任务抵扣额度。真实客户付费底线仍需满足。',
      resourceType: 'agent_referral', resourceId: String(referral.id),
      dedupeKey: `agent-referral:${referral.id}:paid-credit:${sourceKind}:${sourceId}`
    });
    return { status: 'credited', referralId: String(referral.id), sourceKind, sourceId };
  }

  async reverseAgentReferralPaidCreditForClient(client, input) {
    const sourceKind = String(input && input.sourceKind || '');
    const sourceId = String(input && input.sourceId || '');
    if (!['membership', 'bean_recharge'].includes(sourceKind) || !/^\d+$/.test(sourceId)) return { status: 'not_applicable' };
    const found = await client.query(
      `SELECT * FROM agent_referrals
        WHERE paid_credit_source_kind=$1 AND paid_credit_source_id=$2
          AND paid_credit_granted_at IS NOT NULL AND paid_credit_reversed_at IS NULL
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [sourceKind, sourceId]
    );
    if (!found.rowCount) return { status: 'not_found' };
    const referral = found.rows[0];
    await client.query('UPDATE agent_referrals SET paid_credit_reversed_at=clock_timestamp() WHERE id=$1 AND paid_credit_reversed_at IS NULL', [referral.id]);
    await client.query(
      `INSERT INTO agent_qualification_events(tenant_id,actor_user_id,event_type,reason,previous_state,next_state)
       VALUES($1,$2,'referral_credit_reversed',$3,$4::jsonb,$5::jsonb)`,
      [referral.inviter_tenant_id, input.actorUserId || null,
        `被邀请用户的有效付费已${String(input.trigger || '撤销')}，对应代理资格抵扣额度已撤回`,
        JSON.stringify({ referralId: String(referral.id), active: true, sourceKind, sourceId }),
        JSON.stringify({ referralId: String(referral.id), active: false, sourceKind, sourceId })]
    );
    await this.insertUserNotification(client, {
      tenantId: referral.inviter_tenant_id, userId: referral.inviter_user_id, category: 'agent.qualification',
      title: '代理邀请资格抵扣已撤回',
      body: `你邀请用户对应的有效付费已${String(input.trigger || '撤销')}，相关资格任务抵扣已撤回；系统会按最新事实重新核对资格。`,
      resourceType: 'agent_referral', resourceId: String(referral.id),
      dedupeKey: `agent-referral:${referral.id}:paid-credit-reversed:${sourceKind}:${sourceId}`
    });
    return { status: 'reversed', referralId: String(referral.id), sourceKind, sourceId };
  }

  async registerOwner({ username, password, tenantName, email, emailCode, inviteCode }) {
    const verifiedEmail = normalizeAuthEmail(email);
    const effectiveUsername = verifiedEmail ? 'email_' + crypto.createHash('sha256').update(verifiedEmail).digest('hex').slice(0, 24) : String(username || '').trim();
    if (!effectiveUsername) throw Object.assign(new Error('请填写邮箱地址。'), { publicCode: 'invalid_email' });
    if (effectiveUsername.toLowerCase() === 'admin') throw Object.assign(new Error('admin 是系统管理员保留账号，不能注册为普通用户。'), { publicCode: 'reserved_admin_username' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let registrationChallenge = null;
      if (verifiedEmail) {
        const taken = await client.query(
          `SELECT 1 FROM user_profiles up JOIN users u ON u.id=up.user_id
            WHERE u.is_system_admin=false AND lower(up.email)=lower($1) LIMIT 1`,
          [verifiedEmail]
        );
        if (taken.rowCount) throw Object.assign(new Error('该邮箱已注册，请直接登录。'), { publicCode: 'email_already_registered' });
        registrationChallenge = await this.consumeAuthEmailChallenge(client, {
          purpose: 'register', email: verifiedEmail, userId: null, code: emailCode
        });
        if (inviteCode && (await client.query(
          `SELECT 1 FROM user_referrals WHERE invitee_email_hash=$1
           UNION ALL SELECT 1 FROM agent_referrals WHERE invitee_email_hash=$1 LIMIT 1`,
          [referralEmailHash(verifiedEmail)]
        )).rowCount) {
          throw Object.assign(new Error('该邮箱已经绑定过邀请关系，不能通过重新注册更换邀请人。'), { publicCode: 'referral_identity_already_bound' });
        }
      }
      const inviter = await this.referralInviterOn(client, inviteCode, verifiedEmail);
      const passwordHash = await hashPassword(password);
      const userResult = await client.query(
        `INSERT INTO users (username, password_hash, password_algorithm)
         VALUES ($1, $2, 'scrypt-v1') RETURNING id, username`,
        [effectiveUsername, passwordHash]
      );
      const user = userResult.rows[0];
      if (verifiedEmail) {
        await client.query(
          `INSERT INTO user_profiles(user_id,email,email_verified_at)
           VALUES($1,$2,now())
           ON CONFLICT(user_id) DO UPDATE
             SET email=EXCLUDED.email,email_verified_at=now(),updated_at=now()`,
          [user.id, verifiedEmail]
        );
        if (registrationChallenge) await client.query('UPDATE auth_email_challenges SET user_id=$2 WHERE id=$1', [registrationChallenge.id, user.id]);
      }
      const slug = `tenant-${user.id}-${crypto.randomBytes(4).toString('hex')}`;
      const tenantResult = await client.query(
        'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, name',
        [slug, tenantName || `${verifiedEmail || effectiveUsername}的企业`]
      );
      const tenant = tenantResult.rows[0];
      await client.query(
        `INSERT INTO tenant_members
           (tenant_id, user_id, member_type, status, shop_scope_mode, display_name, created_by_user_id, joined_at)
         VALUES ($1, $2, 'owner', 'active', 'all', $3, $2, now())`,
        [tenant.id, user.id, verifiedEmail || effectiveUsername]
      );
      const roleResult = await client.query(
        `INSERT INTO roles (tenant_id, code, name, is_system)
         VALUES ($1, 'owner', '所有者', true) RETURNING id`,
        [tenant.id]
      );
      await client.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
         SELECT $1, $2, code FROM permissions`,
        [tenant.id, roleResult.rows[0].id]
      );
      await client.query(
        `INSERT INTO member_roles (tenant_id, user_id, role_id, granted_by_user_id)
         VALUES ($1, $2, $3, $2)`,
        [tenant.id, user.id, roleResult.rows[0].id]
      );
      const ownReferralCode = await this.ensureReferralCodeOn(client, user.id, tenant.id);
      const trial = await this.publishedTrialPlan(client);
      if (!trial) throw Object.assign(new Error('免费体验方案尚未发布，暂时无法注册，请联系管理员发布试用方案。'), { publicCode: 'registration_trial_plan_missing' });
      const registrationGrant = await this.grantTrialPeriod(client, {
        tenantId: tenant.id, userId: user.id, claimType: 'registration',
        sourceType: 'registration_trial', sourceRef: 'registration',
        planVersionId: trial.planVersionId, requestedDays: trial.durationDays,
        eventType: 'registration_trial_granted'
      });
      if (!registrationGrant.granted) throw Object.assign(new Error('注册赠送天数写入失败，本次注册已整体回滚，请稍后重新注册。'), { publicCode: 'registration_trial_grant_failed' });
      // 新租户注册赠送 AI 豆（与注册同事务；账户/流水键天然幂等，每个新租户只送一次）
      await client.query('INSERT INTO ai_bean_accounts(tenant_id,balance_bean) VALUES ($1,$2)', [tenant.id, WELCOME_GIFT_BEAN]);
      const welcomeBeanEvent = await client.query(
        `INSERT INTO ai_bean_events
           (tenant_id,event_type,direction,amount_bean,balance_after,frozen_after,idempotency_key,business_ref,reason,actor_user_id)
         VALUES ($1,'welcome_gift','credit',$2,$2,0,$3,'registration',$4,$5)
         RETURNING id::text,balance_after`,
        [tenant.id, WELCOME_GIFT_BEAN, welcomeGiftIdempotencyKey(tenant.id),
          '新租户注册赠送 ' + WELCOME_GIFT_BEAN + ' AI豆（1元=100豆，AI图片处理10豆/张，文字翻译免费）', user.id]
      );
      await this.insertUserNotification(client, {
        tenantId: tenant.id, userId: user.id, category: 'ai.beans.gift', title: 'AI豆赠送到账',
        body: `注册赠送 ${WELCOME_GIFT_BEAN} AI豆已到账，当前AI豆余额 ${Number(welcomeBeanEvent.rows[0].balance_after)} 豆。`,
        resourceType: 'ai_bean_event', resourceId: welcomeBeanEvent.rows[0].id,
        dedupeKey: `ai-bean:welcome-gift:${tenant.id}:${user.id}`
      });
      let referralReward = null;
      let agentReferral = null;
      if (inviter) {
        if (String(inviter.inviterUserId) === String(user.id) || String(inviter.inviterTenantId) === String(tenant.id)) {
          throw Object.assign(new Error('不能使用自己的邀请码注册新账号。'), { publicCode: 'referral_self_invite_forbidden' });
        }
        if (inviter.kind === 'agent') {
          const referralRow = await client.query(
            `INSERT INTO agent_referrals
               (inviter_user_id,inviter_tenant_id,invitee_user_id,invitee_tenant_id,invitee_email_hash,referral_code)
             VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
            [inviter.inviterUserId, inviter.inviterTenantId, user.id, tenant.id, referralEmailHash(verifiedEmail), inviter.code]
          );
          agentReferral = { referralId: referralRow.rows[0].id };
          await this.insertUserNotification(client, {
            tenantId: inviter.inviterTenantId, userId: inviter.inviterUserId, category: 'agent.qualification', title: '代理邀请注册成功',
            body: '一位普通用户已通过你的代理邀请码完成邮箱验证注册；每满3个有效邀请可获得1个资格任务抵扣。',
            resourceType: 'agent_referral', resourceId: referralRow.rows[0].id,
            dedupeKey: `agent-referral:${referralRow.rows[0].id}:signup-inviter`
          });
        } else {
          const signupReward = await mutateOn(client, tenant.id, {
            eventType: 'referral_signup_reward', direction: 'credit', amount: REFERRAL_SIGNUP_REWARD_BEAN,
            idempotencyKey: `referral-signup:${user.id}`,
            businessRef: `referral-signup:${user.id}`,
            reason: `通过普通用户邀请码完成邮箱验证注册，额外赠送 ${REFERRAL_SIGNUP_REWARD_BEAN} AI豆`,
            actorUserId: user.id,
            apply: current => ({ balance: current.balance + REFERRAL_SIGNUP_REWARD_BEAN, frozen: current.frozen })
          });
          const referralRow = await client.query(
            `INSERT INTO user_referrals
               (inviter_user_id,inviter_tenant_id,invitee_user_id,invitee_tenant_id,invitee_email_hash,referral_code,signup_reward_event_id)
             VALUES($1,$2,$3,$4,$5,$6,$7)
             RETURNING id::text`,
            [inviter.inviterUserId, inviter.inviterTenantId, user.id, tenant.id, referralEmailHash(verifiedEmail), inviter.code, signupReward.event.id]
          );
          referralReward = {
            referralId: referralRow.rows[0].id,
            signupRewardBean: REFERRAL_SIGNUP_REWARD_BEAN,
            balanceAfter: Number(signupReward.event.balanceAfter)
          };
          await this.insertUserNotification(client, {
            tenantId: tenant.id, userId: user.id, category: 'ai.beans.referral', title: '邀请注册奖励到账',
            body: `你已通过邀请码完成注册，额外赠送 ${REFERRAL_SIGNUP_REWARD_BEAN} AI豆已到账，当前AI豆余额 ${Number(signupReward.event.balanceAfter)} 豆。`,
            resourceType: 'user_referral', resourceId: referralRow.rows[0].id,
            dedupeKey: `referral:${referralRow.rows[0].id}:signup-invitee`
          });
          await this.insertUserNotification(client, {
            tenantId: inviter.inviterTenantId, userId: inviter.inviterUserId,
            category: 'ai.beans.referral', title: '邀请注册成功',
            body: `一位新用户已通过你的邀请码完成邮箱验证注册。对方首次成功购买付费会员后，你将获得 ${REFERRAL_FIRST_PAID_REWARD_BEAN} AI豆奖励。`,
            resourceType: 'user_referral', resourceId: referralRow.rows[0].id,
            dedupeKey: `referral:${referralRow.rows[0].id}:signup-inviter`
          });
        }
      }
      await client.query('COMMIT');
      return {
        userId: String(user.id), tenantId: String(tenant.id), username: user.username, email: verifiedEmail || '',
        referralCode: ownReferralCode, referralReward, agentReferral
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (error.code === '23505' && !error.publicCode) error.publicCode = verifiedEmail ? 'email_already_registered' : 'username_exists';
      throw error;
    } finally {
      client.release();
    }
  }

  async verifyCredentials(username, password) {
    const result = await this.pool.query(
      `SELECT u.id AS user_id, u.username, u.password_hash, u.status AS user_status, u.is_system_admin,
              tm.tenant_id, tm.member_type, tm.status AS member_status, tm.display_name, tm.shop_scope_mode,
              t.status AS tenant_status, usp.block_type, usp.auto_unfreeze_at,
              COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM users u
       JOIN tenant_members tm ON tm.user_id = u.id
       JOIN tenants t ON t.id = tm.tenant_id
       LEFT JOIN user_security_profiles usp ON usp.tenant_id = tm.tenant_id AND usp.user_id = tm.user_id
       LEFT JOIN member_roles mr ON mr.tenant_id = tm.tenant_id AND mr.user_id = tm.user_id
       LEFT JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
       WHERE lower(u.username) = lower($1)
       GROUP BY u.id, tm.tenant_id, tm.member_type, tm.status, tm.display_name, tm.shop_scope_mode, tm.created_at, t.status, usp.block_type, usp.auto_unfreeze_at
       ORDER BY tm.created_at ASC
       LIMIT 1`,
      [username]
    );
    const row = result.rows[0];
    const valid = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, 'scrypt-v1$00000000000000000000000000000000$' + '00'.repeat(64));
    if (!row || !valid || row.user_status !== 'active' || row.member_status !== 'active' || row.tenant_status !== 'active') return null;
    if (row.is_system_admin === true) {
      if (String(row.username || '').trim().toLowerCase() !== 'admin') return null;
      const home = await this.systemAdminHomeAccount();
      return String(home.userId) === String(row.user_id) ? home : null;
    }
    return normalizeAccount(row);
  }

  async createSession(account, context = {}) {
    // ip/deviceId 只允许来自服务端请求上下文（server.js 登录路由）；非法格式一律按 NULL，前端自报值无入口。
    const ipAddress = /^[0-9a-fA-F.:]{1,64}$/.test(String(context.ipAddress || '')) ? String(context.ipAddress) : null;
    const deviceId = /^[a-f0-9]{64}$/.test(String(context.deviceId || '')) ? String(context.deviceId) : null;
    const token = createToken();
    const csrfToken = this.csrfToken(token);
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [account.userId]);
      const revoked = await client.query(
        `UPDATE sessions SET revoked_at=now(),revoke_reason='replaced_by_new_login'
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [account.userId]
      );
      const result = await client.query(
        `INSERT INTO sessions
           (user_id, tenant_id, token_hash, csrf_token_hash, idle_expires_at, absolute_expires_at, ip_address, device_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [account.userId, account.tenantId, tokenHash(token), tokenHash(csrfToken), new Date(now + this.sessionIdleMs), new Date(now + this.sessionAbsoluteMs), ipAddress, deviceId]
      );
      await client.query('COMMIT');
      return { token, csrfToken, sessionId: String(result.rows[0].id), replacedSessions: revoked.rowCount };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async authenticate(token) {
    if (!token) return null;
    const result = await this.pool.query(
      `SELECT s.id AS session_id, s.csrf_token_hash, s.last_seen_at, s.absolute_expires_at,
              u.id AS user_id, u.username, u.is_system_admin, tm.tenant_id, tm.member_type, tm.display_name, tm.shop_scope_mode,
              COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN tenant_members tm ON tm.tenant_id = s.tenant_id AND tm.user_id = s.user_id AND tm.status = 'active'
       JOIN tenants t ON t.id = tm.tenant_id AND t.status = 'active'
       LEFT JOIN member_roles mr ON mr.tenant_id = tm.tenant_id AND mr.user_id = tm.user_id
       LEFT JOIN role_permissions rp ON rp.tenant_id = mr.tenant_id AND rp.role_id = mr.role_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL
         AND s.idle_expires_at > now() AND s.absolute_expires_at > now()
       GROUP BY s.id, u.id, tm.tenant_id, tm.member_type, tm.display_name, tm.shop_scope_mode`,
      [tokenHash(token)]
    );
    const row = result.rows[0];
    if (!row) return null;
    const csrfToken = this.csrfToken(token);
    const currentCsrfHash = tokenHash(csrfToken);
    if (currentCsrfHash.length !== row.csrf_token_hash.length || !crypto.timingSafeEqual(currentCsrfHash, row.csrf_token_hash)) {
      await this.pool.query(
        "UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, 'csrf_secret_rotated') WHERE id = $1",
        [row.session_id]
      );
      return null;
    }
    if (row.is_system_admin === true) {
      if (String(row.username || '').trim().toLowerCase() !== 'admin') {
        await this.pool.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='system_admin_identity_invalid' WHERE id=$1", [row.session_id]);
        return null;
      }
      let home;
      try { home = await this.systemAdminHomeAccount(); }
      catch (_) {
        await this.pool.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='system_admin_home_invalid' WHERE id=$1", [row.session_id]);
        return null;
      }
      if (String(home.tenantId) !== String(row.tenant_id) || String(home.userId) !== String(row.user_id)) {
        await this.pool.query("UPDATE sessions SET revoked_at=COALESCE(revoked_at,now()),revoke_reason='system_admin_scope_invalid' WHERE id=$1", [row.session_id]);
        return null;
      }
    }
    if (Date.now() - new Date(row.last_seen_at).getTime() >= 60000) {
      const idleExpiry = new Date(Math.min(Date.now() + this.sessionIdleMs, new Date(row.absolute_expires_at).getTime()));
      await this.pool.query('UPDATE sessions SET last_seen_at = now(), idle_expires_at = $2 WHERE id = $1', [row.session_id, idleExpiry]);
    }
    return { ...normalizeAccount(row), sessionId: String(row.session_id), csrfToken: csrfToken, csrfTokenHash: row.csrf_token_hash };
  }

  verifyCsrf(account, supplied) {
    if (!account || !supplied) return false;
    const actual = tokenHash(supplied);
    const expected = account.csrfTokenHash;
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async revokeSession(sessionId, reason = 'logout') {
    if (!sessionId) return;
    await this.pool.query(
      'UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, $2) WHERE id = $1',
      [sessionId, reason]
    );
  }

  async changePassword(account, currentPassword, newPassword) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await client.query(
        `SELECT password_hash FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`,
        [account.userId]
      );
      if (!user.rowCount || !await verifyPassword(currentPassword, user.rows[0].password_hash)) {
        const error = new Error('当前密码不正确，请重新输入后再保存。');
        error.publicCode = 'current_password_invalid';
        throw error;
      }
      const passwordHash = await hashPassword(newPassword);
      await client.query(
        `UPDATE users SET password_hash = $2, password_algorithm = 'scrypt-v1', updated_at = now() WHERE id = $1`,
        [account.userId, passwordHash]
      );
      await client.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'password_changed'
         WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [account.userId, account.sessionId]
      );
      await this.writeAudit(client, account, 'auth.password.change', 'user', String(account.userId), 'success');
      await client.query('COMMIT');
      return { ok: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  // 基础信息属于“人”：客户主账号可改自己的；唯一 admin 只在“系统管理”租户作为 owner 维护自己的资料，不依赖客户成员关系；子账号一律拒绝。
  async assertProfileEditable(client, account) {
    const membership = await client.query(
      `SELECT member_type FROM tenant_members WHERE tenant_id = $1 AND user_id = $2 AND status <> 'removed'`,
      [account.tenantId, account.userId]
    );
    if (!membership.rowCount) throw Object.assign(new Error('登录状态已失效，请重新登录后再修改资料。'), { publicCode: 'profile_account_missing' });
    if (membership.rows[0].member_type !== 'owner' && account.isSystemAdmin !== true) {
      throw Object.assign(new Error('只有客户空间主账号可以完善基础资料或修改空间名称。'), { publicCode: 'profile_owner_only' });
    }
    return membership.rows[0].member_type === 'owner';
  }

  // 完善判定只看这张表：user_profiles 的姓名由面板真实写入，邮箱必须通过验证才落库（见迁移 042）。
  async profileCompletionFacts(clientOrPool, userId) {
    const result = await clientOrPool.query(
      `SELECT TRIM(COALESCE(full_name,'')) AS full_name, TRIM(COALESCE(email,'')) AS email, email_verified_at
       FROM user_profiles WHERE user_id=$1`, [userId]
    );
    const row = result.rows[0] || { full_name: '', email: '', email_verified_at: null };
    return { fullName: row.full_name, verifiedEmail: row.email_verified_at && row.email ? row.email.toLowerCase() : '' };
  }

  async accountDisplayIdentity(account) {
    if (!account || !account.userId) return { profileFullName: '', email: '', isSystemAdmin: false };
    if (account.isSystemAdmin === true) return { profileFullName: '', email: '', isSystemAdmin: true };
    const facts = await this.profileCompletionFacts(this.pool, account.userId);
    return { profileFullName: facts.fullName || '', email: facts.verifiedEmail || '', isSystemAdmin: false };
  }

  async displayIdentitiesByUserId(tenantId, userIds) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(value => String(value || '').trim()).filter(value => /^\d+$/.test(value)))];
    if (!ids.length) return {};
    const result = await this.pool.query(
      `SELECT u.id::text AS user_id, u.is_system_admin,
              COALESCE(up.full_name, '') AS profile_full_name,
              CASE WHEN up.email_verified_at IS NOT NULL THEN COALESCE(up.email, '') ELSE '' END AS email
         FROM users u
         LEFT JOIN user_profiles up ON up.user_id=u.id
        WHERE u.id = ANY($1::bigint[])
          AND (u.is_system_admin=true OR EXISTS (
                SELECT 1 FROM tenant_members tm
                 WHERE tm.tenant_id=$2 AND tm.user_id=u.id AND tm.status<>'removed'
              ))`,
      [ids, tenantId]
    );
    const output = {};
    for (const row of result.rows) output[String(row.user_id)] = {
      profileFullName: String(row.profile_full_name || '').trim(),
      email: String(row.email || '').trim().toLowerCase(),
      isSystemAdmin: row.is_system_admin === true
    };
    return output;
  }

  // 完善资料赠送状态（G-2/G-3）。完成判据只认 user_profiles 的真实姓名与已验证邮箱：
  // tenant_members.display_name 在注册时就被预填成用户名，getProfile 又会回落到它，用它判断会把所有新账号误判成已完善。
  // 口径差异已登记在开发计划 3.2——本轮手机号只有正则格式校验、没有短信验证，经用户裁决以“已验证邮箱”代替“已验证手机号”。
  async trialBonusState(clientOrPool, { tenantId, userId, isOwner }) {
    const trial = await this.publishedTrialPlan(clientOrPool);
    const profile = await this.profileCompletionFacts(clientOrPool, userId);
    const facts = await clientOrPool.query(
      `SELECT EXISTS(SELECT 1 FROM membership_trial_claims WHERE tenant_id=$1 AND claim_type='profile_complete') AS tenant_claimed,
              EXISTS(SELECT 1 FROM membership_trial_claims
                      WHERE claim_type='profile_complete' AND verified_email_hash=$2 AND tenant_id<>$1) AS email_claimed_elsewhere,
              (SELECT COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (ends_at - starts_at)))),0)::bigint
                 FROM membership_periods WHERE tenant_id=$1 AND source_type = ANY($3)) AS trial_seconds`,
      [tenantId, trialEmailHash(profile.verifiedEmail), TRIAL_SOURCE_TYPES]
    );
    const usedDays = Number(facts.rows[0].trial_seconds) / 86400;
    const claimed = facts.rows[0].tenant_claimed === true;
    const completed = isOwner === true && profile.fullName.length > 0 && Boolean(profile.verifiedEmail);
    const grantableDays = Math.max(0, Math.min(trial ? trial.bonusDays : 0, Math.floor(TRIAL_TOTAL_CAP_DAYS - usedDays)));
    let reason = 'claimable';
    if (!trial) reason = 'plan_unavailable';
    else if (isOwner !== true) reason = 'owner_only';
    else if (claimed) reason = 'claimed';
    else if (facts.rows[0].email_claimed_elsewhere === true) reason = 'email_claimed_elsewhere';
    else if (!completed) reason = 'profile_incomplete';
    else if (grantableDays <= 0) reason = 'trial_cap_reached';
    const messages = {
      claimable: `可领取 ${grantableDays} 天`,
      claimed: '已领取',
      owner_only: '仅客户空间主账号可领取',
      email_claimed_elsewhere: '该邮箱已在其他客户空间领取过完善资料赠送',
      profile_incomplete: '填写真实姓名并完成邮箱验证后可领取',
      trial_cap_reached: `注册与完善资料赠送合计最多 ${TRIAL_TOTAL_CAP_DAYS} 天，已达上限`,
      plan_unavailable: '试用方案尚未发布'
    };
    return {
      claimed, completed, claimable: reason === 'claimable', reason,
      bonusDays: trial ? trial.bonusDays : null, grantableDays,
      usedDays: Math.round(usedDays * 100) / 100, capDays: TRIAL_TOTAL_CAP_DAYS,
      planVersionId: trial ? trial.planVersionId : null, message: messages[reason]
    };
  }

  // 完善资料赠送发放：由基础信息保存与邮箱验证两条入口在同一事务内尝试，同一客户空间与同一邮箱合计只领一次。
  async grantProfileTrialBonus(client, account, isOwner, triggeredBy) {
    const state = await this.trialBonusState(client, { tenantId: account.tenantId, userId: account.userId, isOwner });
    if (!state.claimable) return { granted: false, reason: state.reason };
    const { verifiedEmail } = await this.profileCompletionFacts(client, account.userId);
    const emailHash = trialEmailHash(verifiedEmail);
    const grant = await this.grantTrialPeriod(client, {
      tenantId: account.tenantId, userId: account.userId, claimType: 'profile_complete',
      sourceType: 'profile_trial', sourceRef: 'profile_complete',
      planVersionId: state.planVersionId, requestedDays: state.bonusDays,
      verifiedEmailHash: emailHash, idempotencyLockKey: `email:${emailHash}`,
      eventType: 'profile_trial_granted', metadata: { triggeredBy, completedWith: '真实姓名+已验证邮箱' }
    });
    return { ...grant, grantedDays: grant.grantedDays || 0 };
  }

  // 通知只负责告知，不能把已提交的会员权益带回去：事务提交后再写，失败留中文日志与告警，不重试成重复赠送。
  async notifyProfileTrialBonus(account, grant) {
    if (!grant || grant.granted !== true) return;
    try {
      await this.insertUserNotification(this.pool, {
        tenantId: account.tenantId, userId: account.userId, category: 'membership.trial',
        title: '完善基础信息赠送已到账',
        body: `已按真实姓名与已验证邮箱完成完善判定，赠送 ${grant.grantedDays} 天免费体验（${grant.state === 'active' ? '立即生效' : '排队接续当前权益'}）。注册与完善资料赠送合计最多 ${TRIAL_TOTAL_CAP_DAYS} 天。`,
        resourceType: 'membership_period', resourceId: String(grant.periodId),
        dedupeKey: `trial:profile-complete:${account.tenantId}:${account.userId}`
      });
    } catch (error) {
      console.error('完善资料赠送通知写入失败（不影响已发放的会员权益）:', error.message);
    }
  }

  async getProfile(account) {
    const result = await this.pool.query(
      `SELECT u.username, u.is_system_admin, tm.member_type, tm.display_name, t.name AS tenant_name,
              COALESCE(up.full_name, '') AS full_name, COALESCE(up.phone, '') AS phone,
              COALESCE(up.email, '') AS email, up.email_verified_at,
              COALESCE(up.gender, '') AS gender, COALESCE(up.signature, '') AS signature,
              COALESCE(up.avatar_object_key, '') AS avatar_key, COALESCE(up.avatar_sha256, '') AS avatar_sha256,
              COALESCE(owner_tm.display_name, owner_u.username) AS owner_display_name,
              COALESCE(owner_up.avatar_object_key, '') AS owner_avatar_key,
              COALESCE(owner_up.avatar_sha256, '') AS owner_avatar_sha256,
              owner_tm.user_id AS owner_user_id,
              pending.email AS pending_email
         FROM users u
         JOIN tenant_members tm ON tm.user_id = u.id AND tm.tenant_id = $2 AND tm.status <> 'removed'
         JOIN tenants t ON t.id = tm.tenant_id
         LEFT JOIN user_profiles up ON up.user_id = u.id
         LEFT JOIN tenant_members owner_tm ON owner_tm.tenant_id = tm.tenant_id AND owner_tm.member_type = 'owner' AND owner_tm.status <> 'removed'
         LEFT JOIN users owner_u ON owner_u.id = owner_tm.user_id
         LEFT JOIN user_profiles owner_up ON owner_up.user_id = owner_tm.user_id
         LEFT JOIN LATERAL (
           SELECT v.email FROM user_email_verifications v
            WHERE v.user_id = u.id AND v.verified_at IS NULL AND v.expires_at > now()
            ORDER BY v.id DESC LIMIT 1
         ) pending ON TRUE
        WHERE u.id = $1`,
      [account.userId, account.tenantId]
    );
    if (!result.rowCount) throw Object.assign(new Error('登录状态已失效，请重新登录后再修改资料。'), { publicCode: 'profile_account_missing' });
    const row = result.rows[0];
    const isOwner = row.member_type === 'owner';
    const isSystemAdmin = row.is_system_admin === true;
    const fullName = row.full_name || row.display_name || row.username;
    return {
      username: row.username,
      isSystemAdmin,
      memberType: row.member_type,
      tenantName: row.tenant_name,
      canEdit: isOwner || isSystemAdmin,
      canRenameTenant: isOwner,
      fullName,
      profileFullName: row.full_name,
      phone: row.phone,
      email: row.email,
      emailVerifiedAt: row.email_verified_at ? row.email_verified_at.toISOString() : '',
      pendingEmail: row.pending_email || '',
      gender: row.gender,
      signature: row.signature,
      // 子账号默认显示主账号头像；主账号与系统管理员显示自己的头像字符。
      avatarLetter: profileLetter(isOwner || isSystemAdmin ? fullName : row.owner_display_name || row.username),
      // 头像图片与头像字符同源：URL 由服务端给出并带内容摘要做缓存穿透，前端不得自行拼接或推断可见性。
      avatarUrl: row.avatar_key ? profileAvatarUrl(account.userId, row.avatar_sha256) : '',
      displayAvatarUrl: (isOwner || isSystemAdmin)
        ? (row.avatar_key ? profileAvatarUrl(account.userId, row.avatar_sha256) : '')
        : (row.owner_avatar_key ? profileAvatarUrl(row.owner_user_id, row.owner_avatar_sha256) : ''),
      ownerDisplayName: row.owner_display_name || '',
      // 完善资料赠送状态由服务端判定，页面只读取展示，不得自行推算天数（G-5 同源口径）。
      trialBonus: await this.trialBonusState(this.pool, {
        tenantId: account.tenantId, userId: account.userId, isOwner
      })
    };
  }

  async updateProfile(account, input) {
    const client = await this.pool.connect();
    let trialBonusGrant;
    try {
      await client.query('BEGIN');
      const isOwner = await this.assertProfileEditable(client, account);
      if (!isOwner && input.tenantName) {
        throw Object.assign(new Error('只有客户空间主账号可以修改公司名称。'), { publicCode: 'profile_tenant_rename_owner_only' });
      }
      await client.query(
        `INSERT INTO user_profiles (user_id, full_name, phone, gender, signature)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE
           SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, gender = EXCLUDED.gender,
               signature = EXCLUDED.signature, updated_at = now()`,
        [account.userId, input.fullName, input.phone, input.gender, input.signature]
      );
      if (isOwner) {
        // 本空间显示名与基础信息姓名保持一致，供身份卡、子账号列表等既有界面复用。
        await client.query(
          `UPDATE tenant_members SET display_name = $3, updated_at = now()
            WHERE tenant_id = $1 AND user_id = $2 AND status <> 'removed' AND display_name IS DISTINCT FROM $3`,
          [account.tenantId, account.userId, input.fullName]
        );
      }
      let tenantNameChanged = false;
      if (input.tenantName) {
        const current = await client.query(`SELECT name FROM tenants WHERE id = $1 FOR UPDATE`, [account.tenantId]);
        tenantNameChanged = String(current.rows[0] ? current.rows[0].name : '') !== input.tenantName;
        if (tenantNameChanged) {
          assertTenantNameFormat(input.tenantName);
          await client.query(`UPDATE tenants SET name = $2, updated_at = now() WHERE id = $1`, [account.tenantId, input.tenantName]);
        }
      }
      trialBonusGrant = await this.grantProfileTrialBonus(client, account, isOwner, 'profile.update');
      await this.writeAudit(client, account, 'profile.update', 'user', String(account.userId), 'success', {
        phoneFilled: Boolean(input.phone), gender: input.gender || '', signatureLength: String(input.signature || '').length,
        tenantNameChanged, trialBonus: trialBonusGrant.granted ? `granted:${trialBonusGrant.grantedDays}d` : trialBonusGrant.reason
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    // 提交后必须先归还事务客户端，再向连接池取连接做通知与回读；单连接池下带着事务连接再取会自锁。
    await this.notifyProfileTrialBonus(account, trialBonusGrant);
    return withTrialBonusGrant(await this.getProfile(account), trialBonusGrant);
  }

  // 保存头像引用：图片字节已经由私有对象存储落盘，这里只登记摘要与类型，并沿用基础信息的可编辑判定。
  async updateProfileAvatar(account, file) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.assertProfileEditable(client, account);
      const current = await client.query(
        'SELECT avatar_updated_at FROM user_profiles WHERE user_id = $1 FOR UPDATE',
        [account.userId]
      );
      const lastAt = current.rows[0] && current.rows[0].avatar_updated_at;
      if (lastAt && Date.now() - new Date(lastAt).getTime() < AVATAR_MIN_CHANGE_SECONDS * 1000) {
        throw Object.assign(new Error('头像更换过于频繁，请稍后再试。'), {
          publicCode: 'avatar_too_frequent',
          retryAfterSeconds: AVATAR_MIN_CHANGE_SECONDS - Math.floor((Date.now() - new Date(lastAt).getTime()) / 1000)
        });
      }
      await client.query(
        `INSERT INTO user_profiles (user_id, avatar_object_key, avatar_content_type, avatar_sha256, avatar_updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE
           SET avatar_object_key = EXCLUDED.avatar_object_key, avatar_content_type = EXCLUDED.avatar_content_type,
               avatar_sha256 = EXCLUDED.avatar_sha256, avatar_updated_at = now(), updated_at = now()`,
        [account.userId, file.objectKey, file.contentType, file.sha256]
      );
      await this.writeAudit(client, account, 'profile.avatar.update', 'user', String(account.userId), 'success', {
        contentType: file.contentType, sizeBytes: Number(file.size) || 0, sha256Prefix: String(file.sha256 || '').slice(0, 12)
      });
      await client.query('COMMIT');
      return this.getProfile(account);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  // 头像读取鉴权：只能读自己的，或本空间主账号的（子账号顶栏默认显示主账号头像）。其余一律按不存在处理，不泄露跨空间账号。
  async getProfileAvatar(account, targetUserId) {
    const result = await this.pool.query(
      `SELECT up.user_id, up.avatar_object_key, up.avatar_content_type, up.avatar_sha256,
              (up.user_id = $2::bigint) AS is_self,
              EXISTS (
                SELECT 1 FROM tenant_members mine
                  JOIN tenant_members owner ON owner.tenant_id = mine.tenant_id
                    AND owner.member_type = 'owner' AND owner.status <> 'removed'
                 WHERE mine.user_id = $2::bigint AND mine.status <> 'removed' AND owner.user_id = up.user_id
              ) AS owns_requester_tenant
         FROM user_profiles up
        WHERE up.user_id = $1::bigint AND up.avatar_object_key <> ''`,
      [targetUserId, account.userId]
    );
    const row = result.rows[0];
    if (!row || (row.is_self !== true && row.owns_requester_tenant !== true)) return null;
    return {
      userId: String(row.user_id), objectKey: row.avatar_object_key,
      contentType: row.avatar_content_type, sha256: row.avatar_sha256
    };
  }

  async assertProfileEmailAvailable(client, account, email) {
    // 唯一系统管理员不使用邮箱登录：管理员邮箱仅用于资料/通知，不参与普通用户邮箱唯一性。
    // 普通账号之间仍必须唯一，但重复检查需要忽略系统管理员的资料邮箱。
    if (account.isSystemAdmin === true) return;
    const taken = await client.query(
      `SELECT 1
         FROM user_profiles up
         JOIN users u ON u.id = up.user_id
        WHERE up.user_id <> $1
          AND u.is_system_admin = false
          AND lower(up.email) = lower($2)
        LIMIT 1`,
      [account.userId, email]
    );
    if (taken.rowCount) {
      throw Object.assign(new Error('该邮箱已被其他普通账号使用，请换一个邮箱再验证。'), { publicCode: 'email_already_used' });
    }
  }

  async requestEmailVerification(account, email, sendCode) {
    const client = await this.pool.connect();
    let rowId = null;
    let issued = null;
    let code = null;
    try {
      await client.query('BEGIN');
      await this.assertProfileEditable(client, account);
      const recent = await client.query(
        `SELECT count(*)::int AS total, max(created_at) AS last_at FROM user_email_verifications WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
        [account.userId]
      );
      const lastAt = recent.rows[0].last_at;
      if (lastAt && Date.now() - new Date(lastAt).getTime() < EMAIL_CODE_RESEND_SECONDS * 1000) {
        throw Object.assign(new Error('验证码发送过于频繁，请稍后再试。'), {
          publicCode: 'email_code_too_frequent',
          retryAfterSeconds: EMAIL_CODE_RESEND_SECONDS - Math.floor((Date.now() - new Date(lastAt).getTime()) / 1000)
        });
      }
      if (recent.rows[0].total >= EMAIL_CODE_HOURLY_LIMIT) {
        throw Object.assign(new Error('本小时邮箱验证码发送次数已用完，请稍后再试。'), { publicCode: 'email_code_hourly_limit' });
      }
      await this.assertProfileEmailAvailable(client, account, email);
      code = process.env.NODE_ENV === 'test' && process.env.ERP_EMAIL_CODE_TEST_MODE === '1'
        ? '888888'
        : String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const inserted = await client.query(
        `INSERT INTO user_email_verifications (user_id, email, code_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING id, expires_at`,
        [account.userId, email, emailCodeHash(account.userId, email, code), EMAIL_CODE_VALID_MINUTES]
      );
      rowId = inserted.rows[0].id;
      issued = { email, expiresAt: inserted.rows[0].expires_at.toISOString() };
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
    // 验证码发送是外部动作，必须在事务提交并归还连接之后再回读连接池，单连接池下带着事务连接再取会自锁。
    let sent = null;
    try {
      sent = await sendCode(issued.email, code, EMAIL_CODE_VALID_MINUTES);
    } catch (cause) {
      console.error('邮箱验证码邮件发送异常:', cause.message);
      sent = { sent: false, reason: 'send_exception' };
    }
    if (!sent || sent.sent !== true) {
      await this.pool.query(`DELETE FROM user_email_verifications WHERE id = $1`, [rowId]).catch(() => {});
      throw Object.assign(new Error('邮箱验证码发送失败，请稍后重试；仍未收到请联系管理员。'), { publicCode: 'email_code_send_failed', sendReason: (sent && sent.reason) || 'send_failed' });
    }
    await this.recordAudit(account, 'profile.email.code', 'user', String(account.userId), 'success', {
      emailMask: maskLoginAccount(issued.email), expiresAt: issued.expiresAt
    });
    return issued;
  }

  async confirmEmailVerification(account, email, code) {
    const client = await this.pool.connect();
    let emailGrant;
    try {
      await client.query('BEGIN');
      const isOwner = await this.assertProfileEditable(client, account);
      const pending = await client.query(
        `SELECT id, code_hash, attempts, expires_at FROM user_email_verifications
          WHERE user_id = $1 AND lower(email) = lower($2) AND verified_at IS NULL
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [account.userId, email]
      );
      if (!pending.rowCount) throw Object.assign(new Error('请先填写邮箱地址，再获取验证码。'), { publicCode: 'email_code_missing' });
      const row = pending.rows[0];
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        throw Object.assign(new Error('邮箱验证码已过期，请重新获取后再提交。'), { publicCode: 'email_code_expired' });
      }
      if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
        throw Object.assign(new Error('验证码错误次数已达上限，请重新获取验证码。'), { publicCode: 'email_code_attempts_exceeded' });
      }
      if (row.code_hash !== emailCodeHash(account.userId, email, code)) {
        await client.query(`UPDATE user_email_verifications SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
        await client.query('COMMIT');
        throw Object.assign(new Error('邮箱验证码不正确，请核对邮箱中的6位验证码后重新输入。'), { publicCode: 'email_code_invalid' });
      }
      await this.assertProfileEmailAvailable(client, account, email);
      await client.query(
        `INSERT INTO user_profiles (user_id, email, email_verified_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, email_verified_at = now(), updated_at = now()`,
        [account.userId, email.toLowerCase()]
      );
      await client.query(`UPDATE user_email_verifications SET verified_at = now() WHERE id = $1`, [row.id]);
      await client.query(
        `UPDATE user_email_verifications SET expires_at = least(expires_at, now())
          WHERE user_id = $1 AND id <> $2 AND verified_at IS NULL`,
        [account.userId, row.id]
      );
      emailGrant = await this.grantProfileTrialBonus(client, account, isOwner, 'profile.email.verify');
      await this.writeAudit(client, account, 'profile.email.verify', 'user', String(account.userId), 'success', {
        emailMask: maskLoginAccount(email), trialBonus: emailGrant.granted ? `granted:${emailGrant.grantedDays}d` : emailGrant.reason
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    // 与基础信息保存同一口径：先归还事务客户端，再写通知与回读，避免单连接池自锁。
    await this.notifyProfileTrialBonus(account, emailGrant);
    return withTrialBonusGrant(await this.getProfile(account), emailGrant);
  }

  async revokeAllUserSessions(account, reason = 'logout_all') {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = COALESCE(revoke_reason, $2)
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [account.userId, reason]
      );
      await this.writeAudit(client, account, 'auth.sessions.revoke_all', 'user', String(account.userId), 'success', { count: result.rowCount });
      await client.query('COMMIT');
      return result.rowCount;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async cleanupExpiredSessions() {
    await this.pool.query(
      `DELETE FROM sessions WHERE absolute_expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days'`
    );
  }

  async listMembershipPlans() {
    const result = await this.pool.query(
      `SELECT id,plan_code,version_no,name,currency,price_minor,duration_days,benefit_rank,benefits,valid_from,valid_until
       FROM membership_plan_versions
       WHERE status='published' AND public_visible=true AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())
       ORDER BY benefit_rank,plan_code`
    );
    return result.rows.map(row => ({ ...membershipPlan(row), activity: MEMBERSHIP_REWARD_ACTIVITY }));
  }

  async membershipSettings() {
    const result = await this.pool.query(
      `SELECT public_launch_enabled,charging_enabled,membership_charging_enabled,activation_codes_enabled,
              automatic_agent_penalties_enabled,agent_self_application_enabled
       FROM billing_settings WHERE singleton=true`
    );
    const row = result.rows[0] || {};
    return {
      publicLaunchEnabled: row.public_launch_enabled === true,
      chargingEnabled: row.charging_enabled === true && row.membership_charging_enabled === true,
      activationCodesEnabled: row.activation_codes_enabled === true,
      automaticAgentPenaltiesEnabled: row.automatic_agent_penalties_enabled === true,
      agentSelfApplicationEnabled: row.agent_self_application_enabled === true
    };
  }

  async getAgentApplicationReadiness(account) {
    if (!account || account.memberType !== 'owner') {
      throw Object.assign(new Error('只有客户空间主账号可以执行该操作，请用主账号登录后重试。'), { publicCode: 'tenant_owner_required' });
    }
    const result = await this.pool.query(
      `SELECT s.agent_self_application_enabled,a.status AS agent_status,a.source AS agent_source
       FROM billing_settings s
       LEFT JOIN agents a ON a.tenant_id=$1 AND a.owner_user_id=$2
       WHERE s.singleton=true`,
      [account.tenantId, account.userId]
    );
    const row = result.rows[0] || {};
    const existingAgent = row.agent_status ? { status: row.agent_status, source: row.agent_source } : null;
    const featureEnabled = row.agent_self_application_enabled === true;
    return {
      featureEnabled,
      canApply: false,
      existingAgent,
      blockers: existingAgent
        ? ['existing_agent']
        : [
            ...(featureEnabled ? [] : ['feature_disabled']),
            'contract_pending_legal_review',
            'document_intake_unavailable',
            'admin_review_unavailable'
          ],
      gates: {
        serverSwitch: featureEnabled,
        legalContract: false,
        privateDocumentIntake: false,
        adminReview: false
      }
    };
  }

  async getMembershipCurrent(account) {
    await this.reconcileMembershipPeriods(account.tenantId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const decisionAt = (await client.query('SELECT now() AS decision_at')).rows[0].decision_at;
      const [activeResult, periodResult, agentResult, trialResult, paidHistoryResult] = [
        await client.query(
          `SELECT candidates.*,bool_or(source_type='partner' AND ends_at IS NULL) OVER () AS has_partner FROM (
            SELECT p.id AS period_id,p.state,p.source_type,p.source_ref,p.starts_at,p.ends_at,p.remaining_seconds,
                   v.id AS plan_id,v.plan_code,v.version_no,v.name,v.currency,v.price_minor,v.duration_days,v.benefit_rank,v.benefits,v.valid_from,v.valid_until,
                   COALESCE(c.state IN ('used_temporary','payment_review') AND NOT EXISTS (
                     SELECT 1 FROM membership_events e
                     WHERE e.tenant_id=p.tenant_id AND e.period_id=p.id AND e.event_type='payment_entitlement_confirmed'
                   ),false) AS is_temporary
            FROM membership_periods p JOIN membership_plan_versions v ON v.id=p.plan_version_id
            LEFT JOIN activation_codes c ON p.source_type='activation_code' AND p.source_ref=c.id::text
            WHERE p.tenant_id=$1 AND p.state='active' AND p.starts_at<=now() AND (p.ends_at IS NULL OR p.ends_at>now())
            UNION ALL
            SELECT NULL,'active','agent',a.tenant_id::text,a.qualified_at,a.expires_at,NULL,
                   v.id,v.plan_code,v.version_no,v.name,v.currency,v.price_minor,v.duration_days,v.benefit_rank,v.benefits,v.valid_from,v.valid_until,false
            FROM agents a JOIN membership_plan_versions v ON v.plan_code='month' AND v.status='published'
            WHERE a.tenant_id=$1 AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>now())
            ) candidates ORDER BY benefit_rank DESC,(source_type='partner' AND ends_at IS NULL) DESC,
              is_temporary ASC,starts_at DESC,period_id DESC NULLS LAST LIMIT 1`, [account.tenantId]
        ),
        await client.query(
          `SELECT p.id AS period_id,p.state,p.source_type,p.source_ref,p.starts_at,p.ends_at,p.remaining_seconds,
                  v.id AS plan_id,v.plan_code,v.version_no,v.name,v.currency,v.price_minor,v.duration_days,v.benefit_rank,v.benefits,v.valid_from,v.valid_until
           FROM membership_periods p JOIN membership_plan_versions v ON v.id=p.plan_version_id
           WHERE p.tenant_id=$1 ORDER BY p.starts_at,p.id LIMIT 100`, [account.tenantId]
        ),
        await client.query(
          `SELECT status,source,deposit_mode,credit_score,qualified_at,expires_at,application_blocked_until
           FROM agents WHERE tenant_id=$1`, [account.tenantId]
        ),
        await client.query(
          `SELECT claim_type,claimed_at FROM membership_trial_claims WHERE tenant_id=$1 ORDER BY claimed_at`, [account.tenantId]
        ),
        await client.query(
          `SELECT 1 FROM membership_events WHERE tenant_id=$1 AND event_type='payment_entitlement_confirmed' LIMIT 1`, [account.tenantId]
        )
      ];
      await client.query('COMMIT');
      const active = activeResult.rowCount ? membershipPeriod(activeResult.rows[0]) : null;
      const agent = agentResult.rows[0] || null;
      const activeAgent = Boolean(agent && agent.status === 'active' && (!agent.expires_at || agent.expires_at > decisionAt));
      const partner = activeResult.rows[0]?.has_partner === true;
      const owner = account.memberType === 'owner';
      const remainingDays = active && active.endsAt ? Math.max(0, Math.ceil((new Date(active.endsAt).getTime() - decisionAt.getTime()) / 86400000)) : null;
      let label = '尚未开通会员';
      if (owner && partner) label = '合作商永久会员';
      else if (owner && activeAgent) label = '代理商会员 · ' + (active && active.plan ? active.plan.name : '月卡权益');
      else if (active && active.plan) label = active.plan.name;
      if (!owner) label = '子账号 · ' + label;
      return {
        status: active || activeAgent ? 'active' : 'inactive', label,
        memberType: account.memberType, isOwner: owner, isSystemAdmin: account.isSystemAdmin === true,
        isAgent: owner && activeAgent, isPartner: owner && partner, activePlan: active && active.plan, remainingDays,
        hasPaidMembershipHistory: paidHistoryResult.rowCount > 0,
        periods: periodResult.rows.map(membershipPeriod),
        trialClaims: trialResult.rows.map(row => ({ type: row.claim_type, claimedAt: row.claimed_at })),
        agent: owner && agent ? {
          status: agent.status, source: agent.source, depositMode: agent.deposit_mode, creditScore: Number(agent.credit_score),
          qualifiedAt: agent.qualified_at, expiresAt: agent.expires_at, applicationBlockedUntil: agent.application_blocked_until
        } : null
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async activeMembershipBenefits(clientOrPool, tenantId) {
    const result = await clientOrPool.query(
      `SELECT benefits FROM (
         SELECT v.benefits,v.benefit_rank
         FROM membership_periods p JOIN membership_plan_versions v ON v.id=p.plan_version_id
         WHERE p.tenant_id=$1 AND p.state='active' AND p.starts_at<=now() AND (p.ends_at IS NULL OR p.ends_at>now())
         UNION ALL
         SELECT v.benefits,v.benefit_rank
         FROM agents a JOIN membership_plan_versions v ON v.plan_code='month' AND v.status='published'
         WHERE a.tenant_id=$1 AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at>now())
       ) active_entitlements ORDER BY benefit_rank DESC LIMIT 1`,
      [tenantId]
    );
    return result.rows[0]?.benefits || {};
  }

  async canUseCustomConfigurations(account) {
    // 2026-09-22 用户确认：免费/体验用户可使用官方AI服务与官方模板，
    // 但只有付费会员、有效代理商/合作商和系统管理员可以配置自己的AI服务或物流模板。
    if (account && account.isSystemAdmin === true) return true;
    if (!account || !account.tenantId) return false;
    const benefits = await this.activeMembershipBenefits(this.pool, account.tenantId);
    return benefits.aiEdit === true;
  }

  async requireAiEditEntitlement(account) {
    // 兼容旧调用名：现在只代表“自定义AI服务/自己的密钥”权限，不再拦官方AI。
    if (await this.canUseCustomConfigurations(account)) return true;
    const error = new Error('免费用户可以使用官方AI服务和官方模板；配置或使用自己的AI服务需要付费会员。');
    error.publicCode = 'membership_ai_edit_required';
    error.status = 403;
    throw error;
  }

  async requireLogisticsCustomizationEntitlement(account) {
    if (await this.canUseCustomConfigurations(account)) return true;
    const error = new Error('免费用户可以使用官方物流模板；配置自己的物流模板需要付费会员。');
    error.publicCode = 'membership_logistics_config_required';
    error.status = 403;
    throw error;
  }



  entitlementIdentity(key, item) {
    if (!item || typeof item !== 'object' || item.archived) return '';
    if (key === 'erp_shops_data') {
      return String(item.clientId || item.externalShopId || item.id || item.name || '').trim().toLowerCase();
    }
    if (key === 'erp_favorite_products') return String(item.sku || '').trim().toLowerCase();
    return '';
  }

  async enforceDocumentEntitlement(client, account, key, currentPayload, nextPayload) {
    const benefitKey = key === 'erp_shops_data' ? 'shopLimit' : key === 'erp_favorite_products' ? 'favoriteLimit' : '';
    if (!benefitKey) return;
    // 系统管理员默认拥有最高会员权限，不受店铺与收藏数量限制（用户 2026-09-14 规则）。
    if (account && account.isSystemAdmin === true) return;
    const benefits = await this.activeMembershipBenefits(client, account.tenantId);
    const limit = Math.max(0, Number(benefits[benefitKey] || 0));
    const identities = payload => new Set((Array.isArray(payload) ? payload : []).map(item => this.entitlementIdentity(key, item)).filter(Boolean));
    const current = identities(currentPayload), next = identities(nextPayload);
    const addsIdentity = [...next].some(identity => !current.has(identity));
    if (next.size > limit && (next.size > current.size || addsIdentity)) {
      const publicCode = key === 'erp_shops_data' ? 'membership_shop_limit' : 'membership_favorite_limit';
      const error = new Error(publicCode === 'membership_shop_limit'
        ? `当前会员方案最多绑定 ${limit} 个Ozon店铺，已保留 ${current.size} 个。请先解绑不用的店铺，或升级会员方案后再新增。`
        : `当前会员方案最多收藏 ${limit} 个商品，已收藏 ${current.size} 个。请先清理不再跟卖的收藏，或升级会员方案后再收藏。`);
      error.publicCode = publicCode;
      error.status = 409;
      error.limit = limit;
      error.usage = current.size;
      throw error;
    }
  }

  async updateProductCreateQuota(client, account, before, next) {
    const previous = before && before.ozonCreate;
    const state = next && next.ozonCreate;
    if (!state || !state.queueId) return;
    if ((!previous || previous.queueId !== state.queueId) && state.phase === 'queued') {
      const offerIds = [...new Set((Array.isArray(state.offerIds) ? state.offerIds : []).map(value => String(value || '').trim()).filter(Boolean))];
      // 系统管理员默认拥有最高会员权限：每日上品数量视为不限，但仍照常记录用量与冲突检查。
      const benefits = account && account.isSystemAdmin === true ? { dailySkuLimit: null } : await this.activeMembershipBenefits(client, account.tenantId);
      const hasLimit = Object.prototype.hasOwnProperty.call(benefits, 'dailySkuLimit');
      const rawLimit = hasLimit ? benefits.dailySkuLimit : 0;
      const limit = hasLimit && rawLimit === null ? null : Math.max(0, Number(rawLimit) || 0);
      const day = (await client.query("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date AS business_date")).rows[0].business_date;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-sku-quota:'||$1||':'||$2::text,0))", [String(account.tenantId), day]);
      const existing = await client.query(
        `SELECT offer_id,queue_id FROM membership_daily_sku_usage
         WHERE tenant_id=$1 AND business_date=$2 AND offer_id=ANY($3::varchar[])`,
        [account.tenantId, day, offerIds]
      );
      const conflict = existing.rows.find(row => row.queue_id !== state.queueId);
      if (conflict) {
        const error = new Error(`货号 ${conflict.offer_id} 今天已有新增任务或成功记录，不能重复占用名额`);
        error.publicCode = 'product_daily_sku_duplicate'; error.status = 409; error.offerId = conflict.offer_id;
        throw error;
      }
      const usage = Number((await client.query(
        `SELECT count(*)::integer AS count FROM membership_daily_sku_usage WHERE tenant_id=$1 AND business_date=$2`,
        [account.tenantId, day]
      )).rows[0].count);
      const additions = offerIds.filter(offerId => !existing.rows.some(row => row.offer_id === offerId));
      if (limit !== null && usage + additions.length > limit) {
        const error = new Error(`当前会员每日最多新增 ${limit} 个 SKU，今天已占用 ${usage} 个，本次需要 ${additions.length} 个`);
        error.publicCode = 'membership_daily_sku_limit'; error.status = 409;
        error.limit = limit; error.usage = usage; error.requested = additions.length;
        throw error;
      }
      for (const offerId of additions) await client.query(
        `INSERT INTO membership_daily_sku_usage(tenant_id,business_date,offer_id,queue_id,actor_user_id)
         VALUES($1,$2,$3,$4,$5)`,
        [account.tenantId, day, offerId, state.queueId, account.userId]
      );
      return;
    }
    if (previous && previous.queueId === state.queueId && state.phase === 'confirmed' && previous.phase !== 'confirmed') {
      await client.query(
        `UPDATE membership_daily_sku_usage SET state='confirmed',confirmed_at=now()
         WHERE tenant_id=$1 AND queue_id=$2 AND state='reserved'`,
        [account.tenantId, state.queueId]
      );
      return;
    }
    if (previous && previous.queueId === state.queueId && state.phase === 'failed' && previous.phase !== 'failed') {
      const successful = [...new Set((Array.isArray(state.successfulOfferIds) ? state.successfulOfferIds : []).map(String))];
      if (successful.length) await client.query(
        `UPDATE membership_daily_sku_usage SET state='confirmed',confirmed_at=now()
         WHERE tenant_id=$1 AND queue_id=$2 AND offer_id=ANY($3::varchar[]) AND state='reserved'`,
        [account.tenantId, state.queueId, successful]
      );
      await client.query(
        `DELETE FROM membership_daily_sku_usage WHERE tenant_id=$1 AND queue_id=$2 AND state='reserved'`,
        [account.tenantId, state.queueId]
      );
    }
  }

  async reconcilePaymentReviewRemindersForClient(client, tenantId, decisionAt) {
    const result = await client.query(
      `SELECT c.id::text,c.code_mask,c.tenant_id::text AS agent_tenant_id,c.redeemed_tenant_id::text AS customer_tenant_id,
              c.requested_by_user_id::text AS agent_owner_user_id,c.bound_user_id::text AS customer_user_id,c.used_at,
              EXISTS (
                SELECT 1 FROM payment_evidence e
                WHERE e.tenant_id=c.tenant_id AND e.activation_code_id=c.id
                  AND e.submitted_at<=c.used_at+interval '72 hours'
                  AND e.review_state IN ('pending','needs_review','matched')
              ) AS has_pending_evidence
       FROM activation_codes c
       WHERE c.redeemed_tenant_id=$1 AND c.issuance_type IN ('agent','agent_delegated')
         AND c.payment_confirmed_at IS NULL AND c.used_at IS NOT NULL
         AND c.state IN ('used_temporary','payment_review','frozen')
         AND $2>=c.used_at+interval '24 hours'
       ORDER BY c.id FOR UPDATE OF c`,
      [tenantId, decisionAt]
    );
    let inserted = 0;
    for (const code of result.rows) {
      const elapsedHours = Math.max(0, (decisionAt.getTime() - new Date(code.used_at).getTime()) / 3600000);
      const milestones = [24];
      if (code.has_pending_evidence === true && elapsedHours >= 72) milestones.push(72);
      if (code.has_pending_evidence === true && elapsedHours >= 96) milestones.push(96);
      if (code.has_pending_evidence === true && elapsedHours >= 120) milestones.push(120);
      for (const hours of milestones) {
        let title; let body;
        if (hours === 24) {
          title = '代理商会员付款待确认提醒';
          body = `${code.code_mask} 已激活超过24小时，仍未确认付款。请尽快补充或核对付款材料；本次临时权益按72/120小时规则处理。`;
        } else if (hours === 72) {
          title = '代理商会员付款审核提醒（72小时）';
          body = `${code.code_mask} 已激活72小时且有效付款材料仍待审核，临时权益已按规则保护，最迟不超过激活后120小时；管理员审核延迟本身不扣代理商信用。`;
        } else if (hours === 96) {
          title = '代理商会员付款审核提醒（96小时）';
          body = `${code.code_mask} 的付款材料仍待审核，距离120小时临时权益保护上限约24小时；管理员审核延迟本身不认定未付款或扣信用。`;
        } else {
          title = '代理商会员临时权益已到期';
          body = `${code.code_mask} 已达到激活后120小时仍待审核，本代码临时权益已到期；付款状态继续待审核，管理员确认后正式会员仍从确认时间起算。`;
        }
        const recipients = [
          { tenantId: code.customer_tenant_id, userId: code.customer_user_id },
          { tenantId: code.agent_tenant_id, userId: code.agent_owner_user_id }
        ];
        for (const recipient of recipients) {
          const notification = await this.insertUserNotification(client, {
            ...recipient, category: 'payment.review', title, body,
            resourceType: 'activation_code', resourceId: String(code.id),
            dedupeKey: `payment-review:${code.id}:${hours}h:${recipient.userId}`
          });
          if (notification) inserted += 1;
        }
        await this.notifySystemAdministrators(client, {
          codeId: code.id, stage: `payment-review-${hours}h`, title, body
        });
      }
    }
    return inserted;
  }

  async reconcileMembershipPeriodsForClient(client, tenantId, decisionAt, actorUserId = null) {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-periods:'||$1,0))", [String(tenantId)]);
    const result = await client.query(
      `SELECT p.id::text,p.state,p.source_type,p.starts_at,p.ends_at,p.remaining_seconds,
              v.benefit_rank,c.state AS activation_state,c.used_at,
              EXISTS (
                SELECT 1 FROM membership_events me
                WHERE me.tenant_id=p.tenant_id AND me.period_id=p.id AND me.event_type='payment_entitlement_confirmed'
              ) AS entitlement_confirmed,
              CASE WHEN c.used_at IS NOT NULL AND EXISTS (
                SELECT 1 FROM payment_evidence e
                WHERE e.tenant_id=c.tenant_id AND e.activation_code_id=c.id
                  AND e.submitted_at<=c.used_at+interval '72 hours'
                  AND e.review_state IN ('pending','needs_review','matched')
              ) THEN c.used_at+interval '120 hours' END AS pending_protection_end
       FROM membership_periods p
       JOIN membership_plan_versions v ON v.id=p.plan_version_id
       LEFT JOIN activation_codes c ON p.source_type='activation_code' AND p.source_ref=c.id::text
       WHERE p.tenant_id=$1 AND p.state IN ('active','paused','queued')
       ORDER BY v.benefit_rank DESC,p.starts_at,p.id FOR UPDATE OF p`,
      [tenantId]
    );
    const periods = result.rows.map(row => ({ ...row, benefit_rank: Number(row.benefit_rank) }));
    let transitions = 0;
    const transition = async (period, state, eventType, fields = {}) => {
      const previous = period.state;
      const startsAt = Object.prototype.hasOwnProperty.call(fields, 'startsAt') ? fields.startsAt : period.starts_at;
      const endsAt = Object.prototype.hasOwnProperty.call(fields, 'endsAt') ? fields.endsAt : period.ends_at;
      const remaining = Object.prototype.hasOwnProperty.call(fields, 'remainingSeconds') ? fields.remainingSeconds : period.remaining_seconds;
      await client.query(
        `UPDATE membership_periods SET state=$3,starts_at=$4,ends_at=$5,remaining_seconds=$6,updated_at=$7
         WHERE tenant_id=$1 AND id=$2`,
        [tenantId, period.id, state, startsAt, endsAt, remaining, decisionAt]
      );
      await client.query(
        `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,previous_state,next_state,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [tenantId, period.id, actorUserId, eventType, previous, state, JSON.stringify(fields.metadata || {})]
      );
      period.state = state;
      period.starts_at = startsAt;
      period.ends_at = endsAt;
      period.remaining_seconds = remaining;
      transitions += 1;
    };
    const isTemporary = period => period.source_type === 'activation_code'
      && ['used_temporary', 'payment_review'].includes(period.activation_state)
      && period.entitlement_confirmed !== true;
    for (const period of periods.filter(item => item.state === 'active')) {
      if (period.source_type === 'activation_code' && period.activation_state === 'frozen') {
        await transition(period, 'frozen', 'temporary_entitlement_frozen');
      } else if (isTemporary(period) && period.pending_protection_end
          && new Date(period.pending_protection_end) > decisionAt
          && new Date(period.pending_protection_end) > new Date(period.ends_at)) {
        await transition(period, 'active', 'temporary_entitlement_extended', {
          endsAt: period.pending_protection_end,
          metadata: { reason: 'payment_evidence_pending', maximumHoursFromActivation: 120 }
        });
      } else if (period.ends_at && new Date(period.ends_at) <= decisionAt) {
        const temporaryBaseEnd = isTemporary(period) && period.used_at
          ? new Date(period.used_at).getTime() + 72 * 3600000
          : null;
        const freezes = temporaryBaseEnd != null && !period.pending_protection_end
          && new Date(period.ends_at).getTime() <= temporaryBaseEnd;
        await transition(period, freezes ? 'frozen' : 'expired',
          freezes ? 'temporary_entitlement_frozen' : 'membership_period_expired');
      }
    }
    const agent = await client.query(
      `SELECT 1 FROM agents WHERE tenant_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at>$2) LIMIT 1`,
      [tenantId, decisionAt]
    );
    const activePeriods = () => periods.filter(item => item.state === 'active'
      && new Date(item.starts_at) <= decisionAt && (!item.ends_at || new Date(item.ends_at) > decisionAt));
    const currentRank = () => Math.max(agent.rowCount ? 1 : -1, ...activePeriods().map(item => item.benefit_rank));
    for (const period of activePeriods()) {
      if (isTemporary(period) || period.source_type === 'partner' || period.benefit_rank >= currentRank()) continue;
      const remaining = period.ends_at
        ? Math.max(0, Math.floor((new Date(period.ends_at).getTime() - decisionAt.getTime()) / 1000))
        : null;
      if (remaining === 0) await transition(period, 'expired', 'membership_period_expired');
      else await transition(period, 'paused', 'membership_entitlement_paused', {
        remainingSeconds: remaining,
        metadata: { reason: 'higher_entitlement_active' }
      });
    }
    const resumable = periods.filter(period => {
      if (period.state === 'paused') return period.benefit_rank > currentRank() || currentRank() < 0;
      return period.state === 'queued' && new Date(period.starts_at) <= decisionAt
        && (period.benefit_rank > currentRank() || currentRank() < 0);
    }).sort((left, right) => right.benefit_rank - left.benefit_rank
      || new Date(left.starts_at) - new Date(right.starts_at) || Number(left.id) - Number(right.id));
    if (resumable.length) {
      const period = resumable[0];
      const remaining = Number(period.remaining_seconds)
        || Math.max(0, Math.floor((new Date(period.ends_at).getTime() - new Date(period.starts_at).getTime()) / 1000));
      if (remaining > 0) {
        const endsAt = new Date(decisionAt.getTime() + remaining * 1000);
        await transition(period, 'active', period.state === 'paused' ? 'membership_entitlement_resumed' : 'membership_queue_activated', {
          startsAt: decisionAt, endsAt, remainingSeconds: null
        });
        for (const lower of activePeriods()) {
          if (lower.id === period.id || isTemporary(lower) || lower.source_type === 'partner'
              || lower.benefit_rank >= period.benefit_rank) continue;
          const lowerRemaining = lower.ends_at
            ? Math.max(0, Math.floor((new Date(lower.ends_at).getTime() - decisionAt.getTime()) / 1000))
            : null;
          if (lowerRemaining > 0) await transition(lower, 'paused', 'membership_entitlement_paused', {
            remainingSeconds: lowerRemaining,
            metadata: { reason: 'higher_entitlement_resumed', higherPeriodId: period.id }
          });
        }
      }
    }
    await this.reconcilePaymentReviewRemindersForClient(client, tenantId, decisionAt);
    return transitions;
  }

  async reconcileMembershipPeriods(tenantId = null) {
    const tenants = tenantId == null
      ? (await this.pool.query(
          `SELECT DISTINCT tenant_id FROM membership_periods WHERE state IN ('active','paused','queued') ORDER BY tenant_id`
        )).rows.map(row => row.tenant_id)
      : [tenantId];
    let transitions = 0;
    let firstError = null;
    for (const targetTenantId of tenants) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const decisionAt = (await client.query('SELECT clock_timestamp() AS value')).rows[0].value;
        transitions += await this.reconcileMembershipPeriodsForClient(client, targetTenantId, decisionAt);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        firstError = firstError || error;
      } finally { client.release(); }
    }
    if (firstError) throw firstError;
    return transitions;
  }

  async listMembershipDevices(account) {
    const result = await this.pool.query(
      `SELECT id,created_at,last_seen_at,idle_expires_at,absolute_expires_at,revoked_at,revoke_reason,ip_address,device_id
       FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`, [account.userId]
    );
    return result.rows.map(row => ({
      id: String(row.id), current: String(row.id) === String(account.sessionId), createdAt: row.created_at,
      lastSeenAt: row.last_seen_at, idleExpiresAt: row.idle_expires_at, absoluteExpiresAt: row.absolute_expires_at,
      revokedAt: row.revoked_at, revokeReason: row.revoke_reason || '',
      ipAddress: row.ip_address || '', deviceId: row.device_id || ''
    }));
  }

  async listMembershipActivationRecords(account) {
    const [result, trialResult] = await Promise.all([
      this.pool.query(
        `SELECT c.id,c.code_mask,c.state,c.used_at,c.payment_confirmed_at,c.benefit_type,c.bean_amount,
                CASE WHEN c.benefit_type='bean_recharge' THEN 'AI豆充值·' || c.bean_amount || '豆' ELSE v.name END AS plan_name,
                p.id AS period_id,p.ends_at AS benefit_expires_at
         FROM activation_codes c LEFT JOIN membership_plan_versions v ON v.id=c.plan_version_id
         LEFT JOIN membership_periods p ON p.tenant_id=c.redeemed_tenant_id
           AND ((p.source_type IN ('direct_payment','manual') AND p.source_ref=('system-activation-code:' || c.id::text))
             OR (p.source_type='activation_code' AND p.source_ref=c.id::text))
         WHERE c.redeemed_tenant_id=$1 ORDER BY c.used_at DESC NULLS LAST,c.id DESC LIMIT 100`, [account.tenantId]
      ),
      // 注册赠送与完善资料赠送也是"到账记录"，按用户口径并入同一列表：只有真实发放过的段才出行，未发放不得伪造。
      this.pool.query(
        `SELECT p.id::text,p.source_type,p.starts_at,p.ends_at
         FROM membership_periods p
         WHERE p.tenant_id=$1 AND p.source_type = ANY($2) ORDER BY p.starts_at DESC LIMIT 2`,
        [account.tenantId, TRIAL_SOURCE_TYPES]
      )
    ]);
    const rows = result.rows.map(row => ({
      id: String(row.id), codeMask: row.code_mask, planName: row.plan_name, state: row.state,
      benefitType: row.benefit_type, beanAmount: row.bean_amount == null ? null : Number(row.bean_amount),
      benefitExpiresAt: row.benefit_type === 'membership' && row.period_id ? row.benefit_expires_at : null,
      usedAt: row.used_at, paymentConfirmedAt: row.payment_confirmed_at
    }));
    const trialLabels = { registration_trial: '注册', profile_trial: '完善资料' };
    for (const period of trialResult.rows) {
      rows.push({
        id: `trial:${period.id}`, codeMask: trialLabels[period.source_type] || '免费体验',
        planName: '免费会员', state: 'used', benefitType: 'membership', beanAmount: null,
        benefitExpiresAt: period.ends_at, usedAt: period.starts_at, paymentConfirmedAt: null
      });
    }
    rows.sort((a, b) => new Date(b.usedAt || 0).getTime() - new Date(a.usedAt || 0).getTime());
    return rows.slice(0, 100);
  }

  async refreshAgentSalesMonth(client, tenantId, monthStart, decisionAt) {
    const factsResult = await client.query(
      `WITH bounds AS (
         SELECT ($2::date::timestamp AT TIME ZONE 'Asia/Shanghai') AS starts_at,
                (($2::date+interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai') AS ends_at
       )
       SELECT
         count(*) FILTER (WHERE c.purpose='customer' AND c.state='paid' AND c.payment_confirmed_at IS NOT NULL)::integer AS valid_customer_orders,
         LEAST(1,count(*) FILTER (WHERE c.purpose='self' AND c.state='paid' AND c.payment_confirmed_at IS NOT NULL))::integer AS valid_self_orders,
         COALESCE(sum(CASE WHEN c.purpose='customer' AND c.state='paid' AND c.payment_confirmed_at IS NOT NULL
           THEN CASE v.plan_code WHEN 'quarter' THEN 3 WHEN 'year' THEN 12 ELSE 1 END ELSE 0 END),0)::integer AS monthly_equivalents,
         count(*) FILTER (WHERE c.state IN ('used_temporary','payment_review','frozen') AND EXISTS (
           SELECT 1 FROM payment_evidence e WHERE e.tenant_id=c.tenant_id AND e.activation_code_id=c.id
             AND e.review_state IN ('pending','needs_review','matched')
         ))::integer AS pending_review_orders
       FROM activation_codes c JOIN membership_plan_versions v ON v.id=c.plan_version_id CROSS JOIN bounds b
       WHERE c.tenant_id=$1 AND c.issuance_type IN ('agent','agent_delegated')
         AND c.used_at>=b.starts_at AND c.used_at<b.ends_at`,
      [tenantId, monthStart]
    );
    const facts = factsResult.rows[0];
    const existingResult = await client.query(
      `SELECT * FROM agent_monthly_stats WHERE tenant_id=$1 AND month_start=$2::date FOR UPDATE`, [tenantId, monthStart]
    );
    const existing = existingResult.rows[0] || null;
    const before = existing ? agentSalesFacts(existing) : null;
    const changedAfterSettlement = Boolean(existing && existing.settled_at && (
      Number(existing.valid_customer_orders) !== Number(facts.valid_customer_orders)
      || Number(existing.valid_self_orders) !== Number(facts.valid_self_orders)
      || Number(existing.monthly_equivalents) !== Number(facts.monthly_equivalents)
    ));
    const metadata = Object.assign({}, existing && existing.metadata || {}, {
      businessTimezone: 'Asia/Shanghai', pendingReviewOrders: Number(facts.pending_review_orders) || 0,
      salesSource: 'paid_activation_codes', selfOrdersExcludedFromPriceTier: true, refreshedAt: decisionAt.toISOString()
    });
    if (changedAfterSettlement) {
      metadata.lastCorrectionAt = decisionAt.toISOString();
      metadata.correctionCount = (Number(metadata.correctionCount) || 0) + 1;
    }
    const stored = await client.query(
      `INSERT INTO agent_monthly_stats
         (tenant_id,month_start,valid_customer_orders,valid_self_orders,monthly_equivalents,month_plan_price_minor,metadata)
       VALUES($1,$2::date,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT(tenant_id,month_start) DO UPDATE SET
         valid_customer_orders=EXCLUDED.valid_customer_orders,valid_self_orders=EXCLUDED.valid_self_orders,
         monthly_equivalents=EXCLUDED.monthly_equivalents,metadata=EXCLUDED.metadata
       RETURNING *`,
      [tenantId, monthStart, facts.valid_customer_orders, facts.valid_self_orders, facts.monthly_equivalents,
        existing ? existing.month_plan_price_minor : 26000, JSON.stringify(metadata)]
    );
    const current = agentSalesFacts(stored.rows[0]);
    if (changedAfterSettlement) {
      await client.query(
        `INSERT INTO agent_qualification_events(tenant_id,event_type,reason,previous_state,next_state)
         VALUES($1,'monthly_sales_corrected','结算后销量事实发生变化，仅影响尚未锁定的后续价格周期',$2::jsonb,$3::jsonb)`,
        [tenantId, JSON.stringify(before), JSON.stringify(current)]
      );
    }
    return current;
  }

  async lockAgentMonthlyPrice(client, tenantId, cycleMonth, decisionAt) {
    const previousMonth = (await client.query(`SELECT ($1::date-interval '1 month')::date AS value`, [cycleMonth])).rows[0].value;
    const previous = await this.refreshAgentSalesMonth(client, tenantId, previousMonth, decisionAt);
    let cycle = await this.refreshAgentSalesMonth(client, tenantId, cycleMonth, decisionAt);
    if (!cycle.metadata.priceLockedAt) {
      const price = agentPlanPriceMinor('month', previous.monthlyEquivalents);
      const metadata = Object.assign({}, cycle.metadata, {
        priceLockedAt: decisionAt.toISOString(), priceBasisMonth: previous.monthStart,
        priceBasisMonthlyEquivalents: previous.monthlyEquivalents
      });
      const updated = await client.query(
        `UPDATE agent_monthly_stats SET month_plan_price_minor=$3,metadata=$4::jsonb
         WHERE tenant_id=$1 AND month_start=$2::date RETURNING *`,
        [tenantId, cycleMonth, price, JSON.stringify(metadata)]
      );
      cycle = agentSalesFacts(updated.rows[0]);
    }
    return cycle;
  }

  async evaluateAgentQualification(client, agent, monthStats, decisionAt, automaticActionsEnabled) {
    const firstQualifiedAt = agent.first_qualified_at || agent.qualified_at;
    if (!firstQualifiedAt) return { state: 'not_started', automaticActionsEnabled };
    const timing = (await client.query(
      `SELECT $1::timestamptz+interval '45 days' AS first_deadline,
              (date_trunc('month',($1::timestamptz+interval '60 days') AT TIME ZONE 'Asia/Shanghai')+interval '1 month')::date AS first_month`,
      [firstQualifiedAt]
    )).rows[0];
    const firstDeadline = new Date(timing.first_deadline);
    const firstMonth = postgresDateOnly(timing.first_month);
    if (decisionAt < firstDeadline) return { state: 'newcomer_monitoring', deadlineAt: firstDeadline, automaticActionsEnabled };
    const firstFacts = (await client.query(
      `SELECT count(*) FILTER (WHERE c.state='paid' AND c.payment_confirmed_at IS NOT NULL)::integer AS paid_orders,
              count(*) FILTER (WHERE c.state IN ('used_temporary','payment_review','frozen') AND EXISTS (
                SELECT 1 FROM payment_evidence e WHERE e.tenant_id=c.tenant_id AND e.activation_code_id=c.id
                  AND e.review_state IN ('pending','needs_review','matched'))
              )::integer AS pending_orders
       FROM activation_codes c WHERE c.tenant_id=$1 AND c.issuance_type IN ('agent','agent_delegated')
         AND c.used_at>=$2 AND c.used_at<$3`,
      [agent.tenant_id, firstQualifiedAt, firstDeadline]
    )).rows[0];
    if (Number(firstFacts.paid_orders) < 1) {
      if (Number(firstFacts.pending_orders) > 0) return { state: 'pending_review_protected', scope: 'first_45_days', automaticActionsEnabled };
      return this.applyAgentPerformanceOutcome(client, agent, monthStats, decisionAt, 'first_order_shortfall', automaticActionsEnabled);
    }
    if (String(monthStats.monthStart) < firstMonth) return { state: 'transition', firstMonthlyAssessment: firstMonth, automaticActionsEnabled };
    const creditFacts = await this.agentReferralSummaryOn(client, agent, monthStats.monthStart);
    const actualTasks = monthStats.validCustomerOrders + monthStats.validSelfOrders;
    const missingTasks = monthStats.validCustomerOrders >= 1 ? Math.max(0, 2 - actualTasks) : 0;
    const creditUsed = Math.min(missingTasks, creditFacts.availableForMonth);
    const referralCredit = {
      earnedCreditCount: creditFacts.earnedCreditCount, usedOtherCredits: creditFacts.usedOtherCredits,
      used: creditUsed, remainingAfter: Math.max(0, creditFacts.earnedCreditCount - creditFacts.usedOtherCredits - creditUsed)
    };
    const met = monthStats.validCustomerOrders >= 1 && actualTasks + creditUsed >= 2;
    if (met) {
      const outcome = await this.applyAgentPerformanceOutcome(client, agent, monthStats, decisionAt, 'met', automaticActionsEnabled);
      return Object.assign({}, outcome, { referralCredit });
    }
    if (Number(monthStats.metadata.pendingReviewOrders) > 0) {
      return { state: 'pending_review_protected', scope: monthStats.monthStart, automaticActionsEnabled, referralCredit };
    }
    const priorState = monthStats.metadata.qualificationState;
    let graceEndsAt = monthStats.metadata.graceEndsAt ? new Date(monthStats.metadata.graceEndsAt) : null;
    if ((priorState === 'met' || monthStats.metadata.qualificationMetOnce === true) && !graceEndsAt) {
      graceEndsAt = new Date(decisionAt.getTime() + 7 * 86400000);
    }
    if (graceEndsAt && graceEndsAt > decisionAt) {
      return { state: 'shortfall_grace', scope: monthStats.monthStart, graceEndsAt, automaticActionsEnabled, referralCredit };
    }
    const outcome = await this.applyAgentPerformanceOutcome(client, agent, monthStats, decisionAt, 'monthly_shortfall', automaticActionsEnabled);
    return Object.assign({}, outcome, { referralCredit });
  }

  async applyAgentPerformanceOutcome(client, agent, monthStats, decisionAt, outcome, automaticActionsEnabled) {
    if (outcome === 'met' && agent.status === 'cancelled') {
      const priorCancellation = await client.query(
        `SELECT 1 FROM agent_qualification_events WHERE tenant_id=$1 AND event_type='performance_cancelled'
           AND next_state->>'monthStart'=$2 ORDER BY id DESC LIMIT 1`, [agent.tenant_id, monthStats.monthStart]
      );
      if (priorCancellation.rowCount) {
        await client.query(`UPDATE agents SET status='active',application_blocked_until=NULL,updated_at=$2 WHERE tenant_id=$1`, [agent.tenant_id, decisionAt]);
        await client.query(
          `INSERT INTO agent_qualification_events(tenant_id,event_type,reason,previous_state,next_state)
           VALUES($1,'performance_restored_after_correction','迟确认或更正后恢复错误取消的原资格时间线',$2::jsonb,$3::jsonb)`,
          [agent.tenant_id, JSON.stringify({ status: 'cancelled', monthStart: monthStats.monthStart }), JSON.stringify({ status: 'active', monthStart: monthStats.monthStart })]
        );
        return { state: 'restored_after_correction', scope: monthStats.monthStart, automaticActionsEnabled };
      }
    }
    if (outcome === 'met') return { state: 'met', scope: monthStats.monthStart, automaticActionsEnabled };
    if (!automaticActionsEnabled || agent.status !== 'active') return { state: outcome, scope: monthStats.monthStart, automaticActionsEnabled };
    const blockedUntil = new Date(decisionAt.getTime() + 30 * 86400000);
    await client.query(
      `UPDATE agents SET status='cancelled',application_blocked_until=$2,updated_at=$3 WHERE tenant_id=$1 AND status='active'`,
      [agent.tenant_id, blockedUntil, decisionAt]
    );
    await client.query(
      `INSERT INTO agent_qualification_events(tenant_id,event_type,reason,previous_state,next_state)
       VALUES($1,'performance_cancelled','未达到已确认的代理商业绩要求',$2::jsonb,$3::jsonb)`,
      [agent.tenant_id, JSON.stringify({ status: agent.status }), JSON.stringify({ status: 'cancelled', monthStart: monthStats.monthStart, applicationBlockedUntil: blockedUntil.toISOString() })]
    );
    await this.insertUserNotification(client, {
      tenantId: agent.tenant_id, userId: agent.owner_user_id, category: 'agent.qualification', title: '代理商资格已取消',
      body: '本期业绩未达到规则要求，30天后可按保留的信用记录重新申请。', resourceType: 'agent', resourceId: String(agent.tenant_id),
      dedupeKey: `agent:${agent.tenant_id}:performance-cancelled:${monthStats.monthStart}`
    });
    return { state: 'cancelled', scope: monthStats.monthStart, applicationBlockedUntil: blockedUntil, automaticActionsEnabled };
  }

  async reconcileAgentSalesForClient(client, agent, decisionAt, automaticActionsEnabled) {
    const calendar = (await client.query(
      `SELECT date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date AS current_month,
              (date_trunc('month',$1::timestamptz AT TIME ZONE 'Asia/Shanghai')-interval '1 month')::date AS previous_month,
              extract(day FROM $1::timestamptz AT TIME ZONE 'Asia/Shanghai')::integer AS current_day`, [decisionAt]
    )).rows[0];
    const current = await this.refreshAgentSalesMonth(client, agent.tenant_id, calendar.current_month, decisionAt);
    const previous = await this.refreshAgentSalesMonth(client, agent.tenant_id, calendar.previous_month, decisionAt);
    const cycleMonth = calendar.current_day >= 4 ? calendar.current_month : calendar.previous_month;
    if (calendar.current_day >= 4) {
      await client.query(
        `UPDATE agent_monthly_stats SET settled_at=COALESCE(settled_at,$3)
         WHERE tenant_id=$1 AND month_start=$2::date`, [agent.tenant_id, calendar.previous_month, decisionAt]
      );
      previous.settledAt = previous.settledAt || decisionAt;
    }
    const cycle = await this.lockAgentMonthlyPrice(client, agent.tenant_id, cycleMonth, decisionAt);
    let qualification = { state: 'settlement_pending', scope: previous.monthStart, automaticActionsEnabled };
    if (calendar.current_day >= 4) qualification = await this.evaluateAgentQualification(client, agent, previous, decisionAt, automaticActionsEnabled);
    const qualificationMet = ['met', 'restored_after_correction'].includes(qualification.state);
    const preserveGrace = ['shortfall_grace', 'pending_review_protected'].includes(qualification.state);
    const previousCreditUsed = Math.max(0, Number(previous.metadata.agentReferralCreditUsed) || 0);
    const nextCreditUsed = qualification.referralCredit ? Math.max(0, Number(qualification.referralCredit.used) || 0) : previousCreditUsed;
    const qualificationMetadata = Object.assign({}, previous.metadata, {
      qualificationState: qualification.state, qualificationCheckedAt: decisionAt.toISOString(),
      qualificationMetOnce: qualificationMet || previous.metadata.qualificationMetOnce === true,
      graceEndsAt: qualification.graceEndsAt ? new Date(qualification.graceEndsAt).toISOString() : preserveGrace ? previous.metadata.graceEndsAt || null : null,
      agentReferralCreditUsed: nextCreditUsed,
      agentReferralCreditEarnedSnapshot: qualification.referralCredit ? Number(qualification.referralCredit.earnedCreditCount) || 0 : Number(previous.metadata.agentReferralCreditEarnedSnapshot) || 0,
      agentReferralCreditRemainingSnapshot: qualification.referralCredit ? Number(qualification.referralCredit.remainingAfter) || 0 : Number(previous.metadata.agentReferralCreditRemainingSnapshot) || 0
    });
    const qualificationStored = await client.query(
      `UPDATE agent_monthly_stats SET metadata=$3::jsonb WHERE tenant_id=$1 AND month_start=$2::date`,
      [agent.tenant_id, calendar.previous_month, JSON.stringify(qualificationMetadata)]
    );
    if (qualificationStored.rowCount !== 1) throw new Error('代理商月度考核结果写入失败，本次操作已回滚，请稍后重试。');
    if (qualification.referralCredit && previousCreditUsed !== nextCreditUsed) {
      await client.query(
        `INSERT INTO agent_qualification_events(tenant_id,event_type,reason,previous_state,next_state)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb)`,
        [agent.tenant_id, previousCreditUsed === 0 && nextCreditUsed > 0 ? 'referral_credit_applied' : 'referral_credit_usage_corrected',
          nextCreditUsed > previousCreditUsed ? '本期代理资格任务缺口自动使用邀请抵扣额度' : '邀请/付费事实更正后重新计算本期抵扣使用量',
          JSON.stringify({ monthStart: previous.monthStart, used: previousCreditUsed }),
          JSON.stringify({ monthStart: previous.monthStart, used: nextCreditUsed, earned: qualification.referralCredit.earnedCreditCount, remaining: qualification.referralCredit.remainingAfter })]
      );
    }
    return { current, previous, cycle, qualification };
  }

  async reconcileAgentMonthlySales() {
    const agents = await this.pool.query(
      `SELECT a.* FROM agents a WHERE a.status='active' OR (a.status='cancelled' AND EXISTS (
         SELECT 1 FROM agent_qualification_events e WHERE e.tenant_id=a.tenant_id AND e.event_type='performance_cancelled'))
       ORDER BY a.tenant_id`
    );
    let processed = 0; let firstError = null;
    for (const agent of agents.rows) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const locked = (await client.query(`SELECT * FROM agents WHERE tenant_id=$1 FOR UPDATE`, [agent.tenant_id])).rows[0];
        const settings = (await client.query(`SELECT automatic_agent_penalties_enabled FROM billing_settings WHERE singleton=true`)).rows[0] || {};
        const decisionAt = (await client.query(`SELECT clock_timestamp() AS value`)).rows[0].value;
        await this.reconcileAgentSalesForClient(client, locked, decisionAt, settings.automatic_agent_penalties_enabled === true);
        await client.query('COMMIT'); processed += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {}); firstError = firstError || error;
      } finally { client.release(); }
    }
    if (firstError) throw firstError;
    return processed;
  }

  async agentFinancialSummary(client, tenantId) {
    const result = await client.query(
      `SELECT
         COALESCE(sum(CASE WHEN account_type='payable' AND direction='debit' THEN amount_minor
                           WHEN account_type='payable' AND direction='credit' THEN -amount_minor ELSE 0 END),0)::bigint AS payable_minor,
         COALESCE(sum(CASE WHEN account_type='deposit' AND direction='credit' THEN amount_minor
                           WHEN account_type='deposit' AND direction='debit' THEN -amount_minor ELSE 0 END),0)::bigint AS deposit_balance_minor
       FROM agent_financial_events WHERE tenant_id=$1`,
      [tenantId]
    );
    const row = result.rows[0] || {};
    return {
      payableMinor: Number(row.payable_minor) || 0,
      depositBalanceMinor: Number(row.deposit_balance_minor) || 0,
      depositRequiredMinor: AGENT_DEPOSIT_REQUIRED_MINOR
    };
  }

  async reconcileAgentDefaultBatchesForClient(client, agent, decisionAt) {
    const candidates = await client.query(
      `SELECT c.id::text,c.state,c.used_at,c.locked_agent_price_minor
       FROM activation_codes c
       WHERE c.tenant_id=$1 AND c.issuance_type IN ('agent','agent_delegated') AND c.used_at IS NOT NULL
         AND c.state IN ('used_temporary','payment_review','frozen')
         AND c.used_at+$2::interval<=$3
         AND NOT EXISTS (
           SELECT 1 FROM payment_evidence e
           WHERE e.tenant_id=c.tenant_id AND e.activation_code_id=c.id AND e.evidence_kind='agent_to_platform'
             AND e.submitted_at<=c.used_at+interval '72 hours'
             AND (
               (e.review_state IN ('pending','needs_review','matched') AND $3<c.used_at+interval '120 hours')
               OR (e.review_state='rejected' AND e.reviewed_at IS NOT NULL
                   AND $3<LEAST(c.used_at+interval '120 hours',e.reviewed_at+interval '24 hours'))
             )
         )
       ORDER BY c.used_at,c.id FOR UPDATE OF c`,
      [agent.tenant_id, '72 hours', decisionAt]
    );
    const existing = await client.query(
      `SELECT activation_code_id::text,metadata FROM activation_code_events
       WHERE tenant_id=$1 AND event_type='payment_default_batch_assigned'
       ORDER BY id`,
      [agent.tenant_id]
    );
    const assignmentByCode = new Map();
    const batches = new Map();
    for (const row of existing.rows) {
      const metadata = row.metadata || {};
      if (!metadata.batchId || !metadata.anchorAt || !metadata.endsAt) continue;
      assignmentByCode.set(row.activation_code_id, metadata.batchId);
      if (!batches.has(metadata.batchId)) batches.set(metadata.batchId, metadata);
    }
    let assignedCount = 0;
    for (const code of candidates.rows) {
      if (assignmentByCode.has(code.id)) continue;
      const usedAt = new Date(code.used_at);
      let batch = Array.from(batches.values()).find(item => usedAt >= new Date(item.anchorAt) && usedAt < new Date(item.endsAt));
      if (!batch) {
        batch = {
          batchId: `default-${agent.tenant_id}-${code.id}`,
          anchorCodeId: code.id,
          anchorAt: usedAt.toISOString(),
          endsAt: new Date(usedAt.getTime() + 24 * 3600000).toISOString()
        };
        batches.set(batch.batchId, batch);
      }
      await client.query(
        `INSERT INTO activation_code_events(tenant_id,activation_code_id,event_type,previous_state,next_state,metadata)
         VALUES($1,$2,'payment_default_batch_assigned',$3,$3,$4::jsonb)`,
        [agent.tenant_id, code.id, code.state, JSON.stringify(batch)]
      );
      assignmentByCode.set(code.id, batch.batchId);
      assignedCount += 1;
    }
    const pending = await client.query(
      `SELECT e.metadata->>'batchId' AS batch_id,min(e.created_at) AS recorded_at,count(DISTINCT e.activation_code_id)::integer AS code_count
       FROM activation_code_events e
       WHERE e.tenant_id=$1 AND e.event_type='payment_default_batch_assigned'
         AND NOT EXISTS (
           SELECT 1 FROM agent_credit_events c
           WHERE c.tenant_id=e.tenant_id AND c.event_type='default' AND c.cycle_key=e.metadata->>'batchId'
         )
       GROUP BY e.metadata->>'batchId' ORDER BY min(e.created_at)`,
      [agent.tenant_id]
    );
    return {
      assignedCount,
      pendingBatches: pending.rows.map(row => ({ batchId: row.batch_id, codeCount: Number(row.code_count), recordedAt: row.recorded_at }))
    };
  }

  async enforceAgentDepositDeadline(client, agent, decisionAt, automaticActionsEnabled) {
    if (!automaticActionsEnabled || agent.deposit_mode !== 'required' || !['pending', 'suspended'].includes(agent.status)) return null;
    const financial = await this.agentFinancialSummary(client, agent.tenant_id);
    if (financial.depositBalanceMinor >= financial.depositRequiredMinor) return null;
    const requirement = await client.query(
      `SELECT id,next_state->>'depositDeadline' AS deposit_deadline FROM agent_qualification_events
       WHERE tenant_id=$1 AND event_type='deposit_required' ORDER BY id DESC LIMIT 1`, [agent.tenant_id]
    );
    if (!requirement.rowCount || !requirement.rows[0].deposit_deadline
        || new Date(requirement.rows[0].deposit_deadline) > decisionAt) return null;
    const alreadyApplied = await client.query(
      `SELECT 1 FROM agent_qualification_events WHERE tenant_id=$1 AND event_type='deposit_deadline_cancelled'
       AND next_state->>'requirementEventId'=$2 LIMIT 1`, [agent.tenant_id, String(requirement.rows[0].id)]
    );
    if (alreadyApplied.rowCount) return null;
    const blockedUntil = new Date(decisionAt.getTime() + 30 * 86400000);
    await client.query(
      `UPDATE agents SET status='cancelled',application_blocked_until=$2,updated_at=$3
       WHERE tenant_id=$1 AND status IN ('pending','suspended')`, [agent.tenant_id, blockedUntil, decisionAt]
    );
    await client.query(
      `INSERT INTO agent_qualification_events(tenant_id,event_type,reason,previous_state,next_state)
       VALUES($1,'deposit_deadline_cancelled','7天内未确认或补足1000元保证金',$2::jsonb,$3::jsonb)`,
      [agent.tenant_id, JSON.stringify({ status: agent.status, depositBalanceMinor: financial.depositBalanceMinor }),
        JSON.stringify({ status: 'cancelled', requirementEventId: String(requirement.rows[0].id), applicationBlockedUntil: blockedUntil.toISOString() })]
    );
    await this.insertUserNotification(client, {
      tenantId: agent.tenant_id, userId: agent.owner_user_id, category: 'agent.deposit', title: '代理商资格已取消',
      body: '保证金未在7天内确认或补足；30天后可按保留的信用记录重新申请。', resourceType: 'agent', resourceId: String(agent.tenant_id),
      dedupeKey: `agent:${agent.tenant_id}:deposit-deadline:${requirement.rows[0].id}`
    });
    return { status: 'cancelled', applicationBlockedUntil: blockedUntil };
  }

  async reconcileAgentDefaultBatches() {
    const agents = await this.pool.query(`SELECT * FROM agents WHERE status IN ('active','pending','suspended') ORDER BY tenant_id`);
    let processed = 0; let firstError = null;
    for (const agent of agents.rows) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const locked = (await client.query(`SELECT * FROM agents WHERE tenant_id=$1 FOR UPDATE`, [agent.tenant_id])).rows[0];
        const settings = (await client.query(`SELECT automatic_agent_penalties_enabled FROM billing_settings WHERE singleton=true`)).rows[0] || {};
        const decisionAt = (await client.query(`SELECT clock_timestamp() AS value`)).rows[0].value;
        await this.reconcileAgentDefaultBatchesForClient(client, locked, decisionAt);
        await this.enforceAgentDepositDeadline(client, locked, decisionAt, settings.automatic_agent_penalties_enabled === true);
        await client.query('COMMIT'); processed += 1;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {}); firstError = firstError || error;
      } finally { client.release(); }
    }
    if (firstError) throw firstError;
    return processed;
  }

  async getAgentOverview(account) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `SELECT * FROM agents WHERE tenant_id=$1 AND owner_user_id=$2 FOR UPDATE`, [account.tenantId, account.userId]
      );
      const row = result.rows[0];
      if (!row) throw Object.assign(new Error('只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。'), { publicCode: 'agent_owner_required' });
      const settings = (await client.query(`SELECT automatic_agent_penalties_enabled FROM billing_settings WHERE singleton=true`)).rows[0] || {};
      const decisionAt = (await client.query(`SELECT clock_timestamp() AS value`)).rows[0].value;
      const sales = await this.reconcileAgentSalesForClient(client, row, decisionAt, settings.automatic_agent_penalties_enabled === true);
      const financial = await this.agentFinancialSummary(client, row.tenant_id);
      const referral = await this.agentReferralSummaryOn(client, row);
      await client.query('COMMIT');
      return {
        status: sales.qualification.state === 'cancelled' ? 'cancelled' : row.status,
        source: row.source, depositMode: row.deposit_mode, creditScore: Number(row.credit_score),
        qualifiedAt: row.qualified_at, expiresAt: row.expires_at,
        applicationBlockedUntil: sales.qualification.applicationBlockedUntil || row.application_blocked_until,
        previousMonthEquivalents: sales.previous.monthlyEquivalents, currentMonthCodes: sales.current.validCustomerOrders + sales.current.validSelfOrders,
        sales: {
          currentMonth: sales.current, previousMonth: sales.previous, qualification: sales.qualification,
          priceCycleMonth: sales.cycle.monthStart
        },
        financial, referral,
        prices: { month: sales.cycle.monthPlanPriceMinor, quarter: agentPlanPriceMinor('quarter'), year: agentPlanPriceMinor('year') }
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  async listAgentActivationCodes(account) {
    const result = await this.pool.query(
      `SELECT c.id,c.code_mask,c.purpose,c.state,c.locked_agent_price_minor,c.requested_at,c.expires_at,c.used_at,c.payment_confirmed_at,
              c.benefit_type,c.bean_amount,
              (SELECT e.amount_bean FROM ai_bean_events e WHERE e.tenant_id=c.tenant_id AND e.event_type='agent_reward' AND e.business_ref=('activation_code:'||c.id::text) ORDER BY e.id LIMIT 1) AS reward_bean,
              c.state='issued' AND c.requested_at>=now()-interval '24 hours' AND c.expires_at>now() AS can_void,
              v.plan_code,v.name AS plan_name
       FROM activation_codes c
       JOIN agents a ON a.tenant_id=c.tenant_id
       LEFT JOIN membership_plan_versions v ON v.id=c.plan_version_id
       WHERE c.tenant_id=$1 AND c.issuance_type IN ('agent','agent_delegated') AND a.owner_user_id=$2
       ORDER BY c.requested_at DESC,c.id DESC LIMIT 100`,
      [account.tenantId, account.userId]
    );
    return result.rows.map(row => ({
      id: String(row.id), codeMask: row.code_mask,
      benefitType: row.benefit_type === 'bean_recharge' ? 'ai_beans' : 'membership',
      beanAmount: row.bean_amount == null ? null : Number(row.bean_amount), rewardBean: row.reward_bean == null ? null : Number(row.reward_bean),
      planCode: row.plan_code, planName: row.benefit_type === 'bean_recharge' ? `AI豆充值·${Number(row.bean_amount)}豆` : row.plan_name,
      purpose: row.purpose, state: row.state, lockedAgentPriceMinor: Number(row.locked_agent_price_minor),
      requestedAt: row.requested_at, expiresAt: row.expires_at, usedAt: row.used_at,
      paymentConfirmedAt: row.payment_confirmed_at, canVoid: row.can_void === true
    }));
  }

  async requestAgentActivationCode(account, input) {
    const client = await this.pool.connect();
    const delegated = input.issuanceType === 'agent_delegated';
    const agentTenantId = delegated ? input.agentTenantId : account.tenantId;
    const namespace = delegated ? 'system-agent-activation-code-request' : 'agent-activation-code-request';
    const beanMode = input.benefitType === 'bean_recharge';
    const beanAmount = Number(input.beanAmount);
    let targetOwner = null;
    let lockedPriceMinor = null;
    let failureStage = 'request_started';
    const requestStartedAt = new Date().toISOString();
    try {
      await client.query('BEGIN');
      failureStage = 'request_validation';
      if (!['membership', 'bean_recharge'].includes(String(input.benefitType || ''))) {
        throw Object.assign(new Error('请选择会员激活码或AI豆充值码。'), { publicCode: 'agent_activation_benefit_not_supported' });
      }
      if (beanMode) {
        if (delegated) throw Object.assign(new Error('管理员代发只支持会员激活码，AI豆充值码请由代理商本人在代理商中心生成。'), { publicCode: 'bean_code_delegated_unsupported' });
        if (!ACTIVATION_BEAN_AMOUNTS.has(beanAmount)) {
          throw Object.assign(new Error('代理商AI豆充值码仅支持1000、2000、5000、10000或50000豆。'), { publicCode: 'bean_amount_invalid', beanMax: MAX_BEAN_CODE_AMOUNT });
        }
        lockedPriceMinor = beanAmount;
      }
      if (delegated) {
        if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
        const reviewer = await client.query(
          "SELECT password_hash FROM users WHERE id=$1 AND status='active' AND is_system_admin=true FOR UPDATE", [account.userId]
        );
        if (!reviewer.rowCount || !await verifyPassword(input.password, reviewer.rows[0].password_hash)) {
          throw Object.assign(new Error('密码校验未通过，请输入当前登录密码后再执行该操作。'), { publicCode: 'reauthentication_failed' });
        }
      }
      const agentResult = await client.query(
        `SELECT *
         FROM agents
         WHERE tenant_id=$1 AND ($2::boolean OR owner_user_id=$3) FOR UPDATE`,
        [agentTenantId, delegated, account.userId]
      );
      const agent = agentResult.rows[0];
      const decisionAt = (await client.query('SELECT clock_timestamp() AS decision_at')).rows[0].decision_at;
      if (!agent || agent.status !== 'active' || (agent.expires_at && agent.expires_at <= decisionAt)) {
        throw Object.assign(new Error('只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。'), { publicCode: 'agent_owner_required' });
      }
      failureStage = 'idempotency_claim';
      if (delegated) {
        const target = await client.query(
          `SELECT t.id::text AS tenant_id,tm.user_id::text AS owner_user_id,u.username
           FROM tenants t JOIN tenant_members tm ON tm.tenant_id=t.id AND tm.member_type='owner' AND tm.status='active'
           JOIN users u ON u.id=tm.user_id AND u.status='active'
           WHERE t.id=$1 AND t.status='active' FOR SHARE OF t,tm,u`,
          [input.targetTenantId]
        );
        if (!target.rowCount) throw Object.assign(new Error('该客户空间还没有主账号，请先确认空间归属后再操作。'), { publicCode: 'tenant_owner_missing' });
        targetOwner = target.rows[0];
      }
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,$2,$3,$4,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [agentTenantId, namespace, input.idempotencyKey, input.requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(
          `SELECT status,request_hash,response_code,response_body FROM idempotency_records
           WHERE tenant_id=$1 AND namespace=$2 AND idempotency_key=$3 FOR UPDATE`,
          [agentTenantId, namespace, input.idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== input.requestHash) {
          throw Object.assign(new Error('该请求编号已用于其他操作，请刷新页面后重新提交。'), { publicCode: 'idempotency_key_conflict' });
        }
        if (row.status === 'completed') {
          await client.query('COMMIT');
          return { replayed: true, statusCode: row.response_code, response: row.response_body };
        }
        throw Object.assign(new Error('相同操作正在处理中，请稍候片刻再查看结果。'), { publicCode: 'idempotency_request_in_progress' });
      }
      const settings = await client.query('SELECT activation_codes_enabled,automatic_agent_penalties_enabled FROM billing_settings WHERE singleton=true');
      if (!settings.rows[0] || settings.rows[0].activation_codes_enabled !== true) {
        throw Object.assign(new Error('激活码功能尚未开启，请联系系统管理员在计费设置中打开后再试。'), { publicCode: 'activation_codes_disabled' });
      }
      failureStage = 'target_account_resolution';
      if (!delegated) {
        if (input.purpose === 'self') {
          targetOwner = {
            tenant_id: String(account.tenantId), owner_user_id: String(account.userId), username: account.username
          };
        } else {
          const userResult = await client.query(
            `SELECT id::text,username,status,is_system_admin
             FROM users WHERE lower(username)=lower($1) FOR SHARE`, [input.customerAccount]
          );
          const targetUser = userResult.rows[0];
          if (!targetUser) throw Object.assign(new Error('未找到该客户登录账号，请核对客户注册时填写的邮箱或手机号后重新输入。'), { publicCode: 'customer_account_not_found' });
          if (targetUser.is_system_admin === true) {
            throw Object.assign(new Error('系统管理员账号不能作为代理商客户，请选择普通客户账号。'), { publicCode: 'customer_account_system_admin' });
          }
          if (targetUser.status !== 'active') {
            throw Object.assign(new Error('该客户账号已被停用，无法接收激活码，请联系系统管理员恢复后再试。'), { publicCode: 'customer_account_disabled' });
          }
          const memberships = await client.query(
            `SELECT tm.tenant_id::text,tm.member_type,tm.status,t.status AS tenant_status
             FROM tenant_members tm JOIN tenants t ON t.id=tm.tenant_id
             WHERE tm.user_id=$1 ORDER BY tm.tenant_id FOR SHARE OF tm,t`, [targetUser.id]
          );
          const activeOwners = memberships.rows.filter(row => row.member_type === 'owner'
            && row.status === 'active' && row.tenant_status === 'active');
          if (activeOwners.length > 1) {
            throw Object.assign(new Error('该账号对应多个活动客户空间，请先让客户在登录页选定空间或联系系统管理员合并后再发码。'), { publicCode: 'customer_account_ambiguous' });
          }
          const activeOwner = activeOwners[0];
          if (!activeOwner) {
            const activeChild = memberships.rows.some(row => row.member_type !== 'owner'
              && row.status === 'active' && row.tenant_status === 'active');
            if (activeChild) throw Object.assign(new Error('子账号不能接收代理商会员激活码，请填写该客户空间主账号的登录邮箱或手机号。'), { publicCode: 'customer_account_owner_required' });
            throw Object.assign(new Error('该客户账号或其客户空间已停用，无法接收激活码，请先联系系统管理员恢复。'), { publicCode: 'customer_account_disabled' });
          }
          targetOwner = {
            tenant_id: activeOwner.tenant_id, owner_user_id: targetUser.id, username: targetUser.username
          };
          const targetAgent = await client.query('SELECT status FROM agents WHERE tenant_id=$1 LIMIT 1', [targetOwner.tenant_id]);
          if (targetAgent.rowCount) {
            throw Object.assign(new Error('代理商之间不允许相互发激活码；如果是给自己使用，请选择“本人使用”。'), { publicCode: 'agent_to_agent_activation_forbidden' });
          }
        }
      }
      const sales = await this.reconcileAgentSalesForClient(
        client, agent, decisionAt,
        settings.rows[0].automatic_agent_penalties_enabled === true
      );
      if (sales.qualification.state === 'cancelled') {
        throw Object.assign(new Error('只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。'), { publicCode: 'agent_owner_required' });
      }
      // 2026-09-21 用户直令：代理商（含管理员代发）在发放会员激活码之前必须先完善本空间主账号基础资料。
      // 判据只取真实姓名与已验证邮箱本身，不能取"是否已领取完善资料赠送天数"——正式付费且从未走免费体验的代理商没有该记录，用它会永久卡死发码。
      const agentOwner = await client.query(
        `SELECT tm.user_id::text FROM tenant_members tm
         WHERE tm.tenant_id=$1 AND tm.member_type='owner' AND tm.status='active' LIMIT 1`, [agentTenantId]
      );
      const agentFacts = agentOwner.rows[0]
        ? await this.profileCompletionFacts(client, agentOwner.rows[0].user_id)
        : { fullName: '', verifiedEmail: '' };
      if (!agentFacts.fullName || !agentFacts.verifiedEmail) {
        throw Object.assign(new Error('请先完善基础资料（真实姓名和已验证邮箱）后再为客户生成激活码。'), { publicCode: 'agent_profile_required' });
      }
      const financial = await this.agentFinancialSummary(client, agentTenantId);
      const bypassedRestrictions = [];
      const enforce = (condition, code, text, details = {}) => {
        if (!condition) return;
        if (delegated && input.overrideRestrictions === true) bypassedRestrictions.push(code);
        else throw Object.assign(new Error(text), { publicCode: code, ...details });
      };
      if (agent.deposit_mode === 'required' && financial.depositBalanceMinor < financial.depositRequiredMinor) {
        enforce(true, 'agent_deposit_required', '代理商保证金余额不足，请先缴纳保证金后再为客户生成激活码。', {
          depositBalanceMinor: financial.depositBalanceMinor,
          depositRequiredMinor: financial.depositRequiredMinor
        });
      }
      enforce(agent.application_blocked_until && agent.application_blocked_until > decisionAt, 'agent_code_requests_blocked',
        '代理商激活码申请已被暂停，请先结清逾期款项并联系系统管理员恢复后再试。');
      let plan = null;
      failureStage = 'plan_and_quota_validation';
      if (!beanMode) {
        const planResult = await client.query(
          `SELECT id,plan_code,name FROM membership_plan_versions
           WHERE plan_code=$1 AND status='published' AND valid_from<=$2 AND (valid_until IS NULL OR valid_until>$2)
           ORDER BY version_no DESC LIMIT 1`,
          [input.planCode, decisionAt]
        );
        if (!planResult.rowCount) throw Object.assign(new Error('该会员方案当前不可用，请选择已发布的方案或联系管理员发布方案。'), { publicCode: 'membership_plan_unavailable' });
        plan = planResult.rows[0];
        // 会员码发放统计：JOIN membership_plan_versions 天然排除 plan_version_id 为空的 AI 豆码，豆码不占首付款/逾期/方案额度。
        const stateResult = await client.query(
          `SELECT
             count(*) FILTER (WHERE v.plan_code=$2 AND c.requested_at>=$3::timestamptz-interval '24 hours')::integer AS plan_window_count,
             count(*) FILTER (WHERE c.state IN ('issued','used_temporary','payment_review','frozen'))::integer AS unfinished_count,
             bool_or(c.payment_confirmed_at IS NOT NULL) AS has_confirmed_payment,
             bool_or(c.used_at<=$3::timestamptz-interval '24 hours' AND c.payment_confirmed_at IS NULL
               AND c.state IN ('used_temporary','payment_review','frozen')) AS has_overdue_payment
           FROM activation_codes c JOIN membership_plan_versions v ON v.id=c.plan_version_id
           WHERE c.tenant_id=$1 AND c.issuance_type IN ('agent','agent_delegated')`,
          [agentTenantId, input.planCode, decisionAt]
        );
        const state = stateResult.rows[0];
        const quota = input.planCode === 'month' ? 3 : 1;
        enforce(Number(state.plan_window_count) >= quota, 'agent_activation_code_quota_exceeded',
          `该会员方案24小时内最多申请 ${quota} 张激活码，本次已达上限，请明天再申请或联系系统管理员调整。`, { quota });
        enforce(state.has_overdue_payment === true, 'agent_payment_overdue',
          '存在逾期未结算的激活码付款，请先完成付款确认后再申请新码。');
        enforce(state.has_confirmed_payment !== true && Number(state.unfinished_count) >= 1, 'agent_first_payment_required',
          '首张激活码尚未完成付款确认，请先由系统管理员确认首笔付款后再申请新码。');
        lockedPriceMinor = input.planCode === 'month' ? sales.cycle.monthPlanPriceMinor : agentPlanPriceMinor(input.planCode);
        failureStage = 'price_determined';
        if (delegated && Number(input.expectedPriceMinor) !== Number(lockedPriceMinor)) {
          throw Object.assign(new Error('代理商价格已变动，请按页面显示的最新价格重新提交。'), {
            publicCode: 'system_activation_price_changed', expectedAmountMinor: Number(lockedPriceMinor)
          });
        }
      }
      failureStage = 'activation_code_insert';
      const created = await client.query(
        `INSERT INTO activation_codes
           (tenant_id,requested_by_user_id,plan_version_id,code_digest,code_mask,purpose,state,locked_agent_price_minor,
            bound_user_id,requested_at,expires_at,issuance_type,target_tenant_id,administrative_reason,restrictions_overridden,
            benefit_type,bean_amount)
         VALUES($1,$2,$3,$4,$5,$6,'issued',$7,$8,$9,$9::timestamptz+interval '24 hours',$10,$11,$12,$13,$14,$15)
         RETURNING id,requested_at,expires_at`,
        [agentTenantId, account.userId, beanMode ? null : plan.id, input.codeDigest, input.codeMask, input.purpose,
          lockedPriceMinor, targetOwner.owner_user_id, decisionAt,
          'agent_delegated', targetOwner.tenant_id,
          delegated ? input.reason : '代理商按客户账号绑定', bypassedRestrictions.length > 0,
          beanMode ? 'bean_recharge' : 'membership', beanMode ? beanAmount : null]
      );
      const code = created.rows[0];
      await client.query(
        `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,next_state,metadata)
         VALUES($1,$2,$3,'issued','issued',$4::jsonb)`,
        [agentTenantId, code.id, account.userId, JSON.stringify({
          planCode: beanMode ? null : input.planCode, purpose: input.purpose, lockedPriceMinor,
          issuanceType: delegated ? 'agent_delegated' : 'agent', storageIssuanceType: 'agent_delegated',
          targetTenantId: targetOwner.tenant_id,
          targetUserId: targetOwner.owner_user_id, targetAccountMasked: maskLoginAccount(targetOwner.username),
          restrictionsOverridden: bypassedRestrictions,
          benefitType: beanMode ? 'bean_recharge' : 'membership', beanAmount: beanMode ? beanAmount : null
        })]
      );
      let rewardBean = 0;
      if (beanMode && input.purpose === 'customer') {
        rewardBean = agentRewardBean(beanAmount);
        if (rewardBean > 0) {
          const rewardResult = await mutateOn(client, agentTenantId, {
            eventType: 'agent_reward', direction: 'credit', amount: rewardBean,
            idempotencyKey: `bean-reward:${code.id}`,
            businessRef: `activation_code:${code.id}`,
            reason: `发放AI豆充值码 ${input.codeMask}（${beanAmount}豆）奖励 ${rewardBean}豆`,
            actorUserId: account.userId,
            apply: current => ({ balance: current.balance + rewardBean, frozen: current.frozen })
          });
          await this.insertUserNotification(client, {
            tenantId: agentTenantId, userId: agent.owner_user_id, category: 'ai.beans.reward', title: '代理返佣AI豆到账',
            body: `${input.codeMask} 对应客户AI豆码已生成，本次代理奖励 ${rewardBean} AI豆已到账，当前AI豆余额 ${Number(rewardResult.event.balanceAfter)} 豆。`,
            resourceType: 'ai_bean_event', resourceId: String(rewardResult.event.id),
            dedupeKey: `ai-bean:agent-reward:${code.id}:${agent.owner_user_id}`
          });
          await client.query(
            `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,next_state,metadata)
             VALUES($1,$2,$3,'bean_reward_granted','issued',$4::jsonb)`,
            [agentTenantId, code.id, account.userId, JSON.stringify({ beanAmount, rewardBean, rule: 'floor(bean*30/100)' })]
          );
        }
      }
      await this.insertUserNotification(client, {
        tenantId: agentTenantId, userId: agent.owner_user_id, category: 'agent.activation',
        title: beanMode ? 'AI豆充值激活码已生成' : '激活码已生成',
        body: beanMode
          ? input.purpose === 'self'
            ? `${input.codeMask} 为本人使用的AI豆充值码（${beanAmount}豆），已生成，请在24小时内使用；本人使用不额外发放代理奖励。`
            : `${input.codeMask} 为AI豆充值码（${beanAmount}豆），已生成，请在24小时内交给客户使用，客户核销后豆直接入账。本次代理奖励 ${rewardBean} 豆（按购买豆数30%取整数）已入您的AI豆余额。`
          : delegated
          ? `${input.codeMask} 已由系统管理员代为生成并绑定指定客户，请在24小时内完成使用和后续结算。`
          : `${input.codeMask} 已生成并绑定${input.purpose === 'self' ? '当前代理商主账号' : '指定客户主账号'}，请在24小时内完成使用。完整激活码只在本次响应显示。`,
        resourceType: 'activation_code', resourceId: String(code.id), dedupeKey: `activation:${code.id}:issued`
      });
      if (!beanMode) await this.notifySystemAdministrators(client, {
        codeId: code.id, stage: 'requested', title: '代理商会员激活码申请待核对',
        body: `${input.codeMask} 已由代理商申请，当前尚未激活，仅供管理员核对。`
      });
      await this.writeAudit(client, { ...account, tenantId: agentTenantId },
        delegated ? 'system.activation_code.agent_delegated' : 'agent.activation_code.request',
        'activation_code', String(code.id), 'success', activationAuditMetadata(input, {
        codeMask: input.codeMask, planCode: beanMode ? null : input.planCode, purpose: input.purpose, lockedPriceMinor,
        benefitType: beanMode ? 'bean_recharge' : 'membership', beanAmount: beanMode ? beanAmount : null, rewardBean,
        targetTenantId: targetOwner.tenant_id, targetUserId: targetOwner.owner_user_id,
        targetAccountMasked: maskLoginAccount(targetOwner.username), reason: delegated ? input.reason : '代理商按客户账号绑定',
        restrictionsOverridden: bypassedRestrictions, overrideReason: bypassedRestrictions.length ? input.overrideReason : null,
        actorUserId: String(account.userId), valueMinor: lockedPriceMinor, valueCurrency: 'CNY',
        lockedAgentPriceMinor: lockedPriceMinor, paymentResponsibility: 'agent', valueDetermined: true,
        priceUnavailableStage: null,
        stageStatus: 'issued', retryCount: 0, recoveryCount: 0, providerTaskId: null,
        availableBalanceBefore: null, frozenBalanceBefore: null, availableBalanceAfter: null, frozenBalanceAfter: null,
        startedAt: requestStartedAt, completedAt: decisionAt, previousState: null, nextState: 'issued'
      }));
      if (bypassedRestrictions.length) {
        await this.writeAudit(client, { ...account, tenantId: agentTenantId },
          'system.activation_code.restrictions_override', 'activation_code', String(code.id), 'success', {
            targetTenantId: targetOwner.tenant_id, reason: input.overrideReason,
            bypassedRestrictions, lockedPriceMinor
          });
      }
      const response = {
        item: {
          id: String(code.id), codeMask: input.codeMask,
          planCode: beanMode ? null : input.planCode,
          planName: beanMode ? `AI豆充值·${beanAmount}豆` : plan.name,
          benefitType: beanMode ? 'bean_recharge' : 'membership',
          beanAmount: beanMode ? beanAmount : null, rewardBean: beanMode ? rewardBean : null,
          purpose: input.purpose, state: 'issued', issuanceType: delegated ? 'agent_delegated' : 'agent',
          targetTenantId: targetOwner.tenant_id, targetOwnerUserId: targetOwner.owner_user_id,
          targetAccountMasked: maskLoginAccount(targetOwner.username),
          lockedAgentPriceMinor: lockedPriceMinor, paymentResponsibility: 'agent', restrictionsOverridden: bypassedRestrictions,
          requestedAt: code.requested_at, expiresAt: code.expires_at
        },
        oneTimeCodeUnavailable: true
      };
      const completed = await client.query(
        `UPDATE idempotency_records SET status='completed',response_code=201,response_body=$4::jsonb,
           resource_type='activation_code',resource_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND namespace=$6 AND idempotency_key=$2
           AND request_hash=$5 AND status='processing'`,
        [agentTenantId, input.idempotencyKey, String(code.id), JSON.stringify(response), input.requestHash, namespace]
      );
      if (completed.rowCount !== 1) throw new Error('激活码申请结果写回失败，本次申请已回滚，请稍后重试。');
      await client.query('COMMIT');
      return { replayed: false, statusCode: 201, response };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (!delegated) {
        try {
          await this.recordAgentActivationFailure(account, {
            ...input,
            targetTenantId: targetOwner && targetOwner.tenant_id,
            targetUserId: targetOwner && targetOwner.owner_user_id,
            targetAccountMasked: targetOwner ? maskLoginAccount(targetOwner.username) : maskLoginAccount(input.customerAccount),
            lockedPriceMinor, priceUnavailableStage: lockedPriceMinor == null ? failureStage : null,
            startedAt: requestStartedAt
          }, error);
        } catch (auditError) { throw auditPersistenceError(auditError); }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAgentActivationFailure(account, input, error) {
    const failedAt = new Date().toISOString();
    const valueDetermined = Number.isSafeInteger(input.lockedPriceMinor) && input.lockedPriceMinor >= 0;
    const valueMinor = valueDetermined ? input.lockedPriceMinor : null;
    await this.writeAudit(this.pool, account, 'agent.activation_code.request', 'activation_code', 'pending', 'failed',
      activationAuditMetadata(input, {
        actorUserId: String(account.userId), targetUserId: input.targetUserId ? String(input.targetUserId) : null,
        targetAccountMasked: String(input.targetAccountMasked || maskLoginAccount(input.customerAccount)),
        purpose: String(input.purpose || '') || null,
        errorCode: error.publicCode || 'agent_activation_code_request_failed',
        reason: String(error.publicReason || error.message || '代理商激活码申请失败').slice(0, 500),
        valueMinor, lockedAgentPriceMinor: valueMinor, valueCurrency: 'CNY',
        paymentResponsibility: 'agent', valueDetermined,
        priceUnavailableStage: valueDetermined ? null : String(input.priceUnavailableStage || 'request_validation'),
        stageStatus: 'failed', retryCount: 0, recoveryCount: 0, providerTaskId: null,
        availableBalanceBefore: null, frozenBalanceBefore: null, availableBalanceAfter: null, frozenBalanceAfter: null,
        previousState: null, nextState: null, startedAt: String(input.startedAt || failedAt), completedAt: failedAt, failedAt
      })
    );
  }

  async voidAgentActivationCode(account, codeId, idempotencyKey, requestHash) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const agent = await client.query(
        `SELECT status,expires_at FROM agents WHERE tenant_id=$1 AND owner_user_id=$2 FOR UPDATE`,
        [account.tenantId, account.userId]
      );
      const decisionAt = (await client.query('SELECT clock_timestamp() AS decision_at')).rows[0].decision_at;
      if (!agent.rowCount || agent.rows[0].status !== 'active' || (agent.rows[0].expires_at && agent.rows[0].expires_at <= decisionAt)) {
        throw Object.assign(new Error('只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。'), { publicCode: 'agent_owner_required' });
      }
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,'agent-activation-code-void',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [account.tenantId, idempotencyKey, requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(
          `SELECT status,request_hash,response_code,response_body FROM idempotency_records
           WHERE tenant_id=$1 AND namespace='agent-activation-code-void' AND idempotency_key=$2 FOR UPDATE`,
          [account.tenantId, idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) throw Object.assign(new Error('该请求编号已用于其他操作，请刷新页面后重新提交。'), { publicCode: 'idempotency_key_conflict' });
        if (row.status === 'completed') {
          await client.query('COMMIT');
          return { replayed: true, statusCode: row.response_code, response: row.response_body };
        }
        throw Object.assign(new Error('相同操作正在处理中，请稍候片刻再查看结果。'), { publicCode: 'idempotency_request_in_progress' });
      }
      const found = await client.query(
        `SELECT id,code_mask,state,requested_at,expires_at,benefit_type,bean_amount FROM activation_codes
         WHERE tenant_id=$1 AND id=$2 AND issuance_type IN ('agent','agent_delegated') FOR UPDATE`,
        [account.tenantId, codeId]
      );
      if (!found.rowCount) throw Object.assign(new Error('未找到该激活码，或它不属于当前代理商，请核对激活码编号。'), { publicCode: 'activation_code_not_found' });
      const code = found.rows[0];
      if (code.state !== 'issued') throw Object.assign(new Error('只有尚未使用的激活码可以作废，已激活或已过期的不能作废。'), { publicCode: 'activation_code_cannot_void' });
      const updated = await client.query(
        `UPDATE activation_codes SET state='voided',updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND state='issued' AND requested_at>=clock_timestamp()-interval '24 hours' AND expires_at>clock_timestamp()
         RETURNING updated_at`,
        [account.tenantId, codeId]
      );
      if (!updated.rowCount) throw Object.assign(new Error('激活码已超过申请后24小时的作废期限，无法再作废。'), { publicCode: 'activation_code_void_window_expired' });
      await client.query(
        `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state)
         VALUES($1,$2,$3,'voided_by_agent','issued','voided')`,
        [account.tenantId, codeId, account.userId]
      );
      let rewardRecovery = null;
      if (code.benefit_type === 'bean_recharge') {
        rewardRecovery = await this.reclaimBeanRewardForClient(client, {
          agentTenantId: account.tenantId, codeId, codeMask: code.code_mask,
          actorUserId: account.userId, trigger: 'voided', nextState: 'voided'
        });
      }
      await this.writeAudit(client, account, 'agent.activation_code.void', 'activation_code', String(codeId), 'success', { codeMask: code.code_mask, rewardRecovery });
      const response = { item: { id: String(codeId), codeMask: code.code_mask, state: 'voided', updatedAt: updated.rows[0].updated_at } };
      const completed = await client.query(
        `UPDATE idempotency_records SET status='completed',response_code=200,response_body=$4::jsonb,
           resource_type='activation_code',resource_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND namespace='agent-activation-code-void' AND idempotency_key=$2
           AND request_hash=$5 AND status='processing'`,
        [account.tenantId, idempotencyKey, String(codeId), JSON.stringify(response), requestHash]
      );
      if (completed.rowCount !== 1) throw new Error('激活码作废结果写回失败，本次操作已回滚，请稍后重试。');
      await client.query('COMMIT');
      return { replayed: false, statusCode: 200, response };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  // 豆码作废/过期扣回：有代理商30%奖励流水则同事务扣回同额AI豆；余额不足时冻结代理商资格并记 needs_review，禁止抹掉负债。
  async reclaimBeanRewardForClient(client, input) {
    const agentTenantId = String(input.agentTenantId);
    const codeId = String(input.codeId);
    const businessRef = `activation_code:${codeId}`;
    const granted = await client.query(
      `SELECT id::text,amount_bean FROM ai_bean_events
       WHERE tenant_id=$1 AND event_type='agent_reward' AND business_ref=$2
       ORDER BY id LIMIT 1`,
      [agentTenantId, businessRef]
    );
    if (!granted.rowCount) return { status: 'no_reward', codeId };
    const rewardBean = Number(granted.rows[0].amount_bean);
    const accountRow = await client.query(
      'SELECT balance_bean,frozen_bean FROM ai_bean_accounts WHERE tenant_id=$1 FOR UPDATE', [agentTenantId]
    );
    const balance = accountRow.rowCount ? Number(accountRow.rows[0].balance_bean) : 0;
    const frozen = accountRow.rowCount ? Number(accountRow.rows[0].frozen_bean) : 0;
    const owner = await client.query('SELECT owner_user_id::text AS user_id,status FROM agents WHERE tenant_id=$1 FOR UPDATE', [agentTenantId]);
    if (balance >= rewardBean) {
      const reversalResult = await mutateOn(client, agentTenantId, {
        eventType: 'agent_reward_reversal', direction: 'debit', amount: rewardBean,
        idempotencyKey: `bean-reward-reversal:${codeId}`, businessRef,
        reason: `${input.trigger === 'expired' ? 'AI豆充值码过期未核销' : 'AI豆充值码作废'}，扣回代理奖励 ${rewardBean}豆（码 ${input.codeMask}）`,
        actorUserId: input.actorUserId || null,
        apply: current => ({ balance: current.balance - rewardBean, frozen: current.frozen })
      });
      await client.query(
        `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata)
         VALUES($1,$2,$3,'bean_reward_recovered','issued',$4,$5::jsonb)`,
        [agentTenantId, codeId, input.actorUserId || null, input.nextState, JSON.stringify({
          recoveredBean: rewardBean, rewardEventId: granted.rows[0].id, trigger: input.trigger, rule: 'floor(bean*30/100)'
        })]
      );
      if (owner.rowCount) {
        await this.insertUserNotification(client, {
          tenantId: agentTenantId, userId: owner.rows[0].user_id, category: 'ai.beans.reward_reversal', title: '代理奖励AI豆已扣回',
          body: `激活码 ${input.codeMask} 已${input.trigger === 'expired' ? '过期未使用' : '作废'}，此前发放的代理奖励 ${rewardBean} AI豆已扣回，当前AI豆余额 ${balance - rewardBean} 豆。`,
          resourceType: 'ai_bean_event', resourceId: String(reversalResult.event.id),
          dedupeKey: `ai-bean:agent-reward-reversal:${codeId}:${owner.rows[0].user_id}`
        });
      }
      return { status: 'recovered', codeId, rewardBean, balanceAfter: balance - rewardBean };
    }
    if (owner.rowCount && owner.rows[0].status === 'active') {
      await client.query(
        `UPDATE agents SET status='suspended',updated_at=clock_timestamp() WHERE tenant_id=$1 AND status='active'`,
        [agentTenantId]
      );
      await client.query(
        `INSERT INTO agent_qualification_events(tenant_id,actor_user_id,event_type,reason,previous_state,next_state)
         VALUES($1,$2,'bean_reward_recovery_needs_review',$3,$4::jsonb,$5::jsonb)`,
        [agentTenantId, input.actorUserId || null,
          `豆码 ${input.codeMask} 作废/过期需扣回返佣 ${rewardBean}豆，当前余额 ${balance}豆不足，欠 ${rewardBean - balance}豆，资格已冻结待人工复核。`,
          JSON.stringify({ status: 'active' }), JSON.stringify({ status: 'suspended', outstandingRewardBean: rewardBean - balance })]
      );
    }
    await client.query(
      `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata)
       VALUES($1,$2,$3,'bean_reward_recovery_failed','issued',$4,$5::jsonb)`,
      [agentTenantId, codeId, input.actorUserId || null, input.nextState, JSON.stringify({
        dueBean: rewardBean, balanceBean: balance, frozenBean: frozen, outstandingBean: rewardBean - balance, trigger: input.trigger
      })]
    );
    if (owner.rowCount) {
      await this.insertUserNotification(client, {
        tenantId: agentTenantId, userId: owner.rows[0].user_id, category: 'agent.reward',
        title: 'AI豆返佣扣回待人工复核',
        body: `激活码 ${input.codeMask} 已${input.trigger === 'expired' ? '过期未使用' : '作废'}，应扣回代理奖励 ${rewardBean}豆，但当前AI豆余额仅 ${balance}豆。代理商资格已冻结，负债 ${rewardBean - balance}豆待人工复核，请勿视为已结清。`,
        resourceType: 'activation_code', resourceId: codeId, dedupeKey: `activation:${codeId}:reward-recovery-failed`
      });
    }
    return { status: 'needs_review', codeId, rewardBean, balanceBean: balance, outstandingBean: rewardBean - balance };
  }

  async requestSystemPlatformActivationCode(account, input) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const beanMode = input.benefitType === 'bean_recharge';
    const beanAmount = Number(input.beanAmount);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (beanMode && !ACTIVATION_BEAN_AMOUNTS.has(beanAmount)) {
        throw Object.assign(new Error('AI豆仅支持1000、2000、5000、10000或50000豆'), { publicCode: 'bean_amount_invalid', publicReason: 'AI豆仅支持1000、2000、5000、10000或50000豆', beanMax: MAX_BEAN_CODE_AMOUNT });
      }
      const target = await client.query(
        `SELECT t.id::text AS tenant_id,t.name AS tenant_name,tm.user_id::text AS owner_user_id,u.username
         FROM tenants t JOIN tenant_members tm ON tm.tenant_id=t.id AND tm.member_type='owner' AND tm.status='active'
         JOIN users u ON u.id=tm.user_id AND u.status='active'
         WHERE t.id=$1 AND t.status='active' FOR SHARE OF t,tm,u`,
        [input.targetTenantId]
      );
      if (!target.rowCount) throw Object.assign(new Error('目标客户不存在或没有有效主账号'), { publicCode: 'tenant_owner_missing', publicReason: '目标客户不存在或没有有效主账号' });
      const owner = target.rows[0];
      const decisionAt = (await client.query('SELECT clock_timestamp() AS decision_at')).rows[0].decision_at;
      const settings = (await client.query(
        `SELECT activation_codes_enabled FROM billing_settings WHERE singleton=true`
      )).rows[0] || {};
      if (settings.activation_codes_enabled !== true) {
        throw Object.assign(new Error('激活码功能尚未开放'), { publicCode: 'activation_codes_disabled', publicReason: '激活码功能尚未开放' });
      }
      let plan = null;
      let valueMinor = 0;
      let valueCurrency = 'CNY';
      if (beanMode) {
        valueMinor = beanAmount;
      } else {
        const planResult = await client.query(
          `SELECT id,plan_code,name,currency,price_minor,duration_days FROM membership_plan_versions
           WHERE plan_code=$1 AND status='published' AND valid_from<=$2 AND (valid_until IS NULL OR valid_until>$2)
           ORDER BY version_no DESC LIMIT 1`, [input.planCode, decisionAt]
        );
        if (!planResult.rowCount) throw Object.assign(new Error('当前会员方案不可用'), { publicCode: 'membership_plan_unavailable', publicReason: '当前会员方案不可用' });
        plan = planResult.rows[0];
        valueMinor = Number(plan.price_minor);
        valueCurrency = plan.currency;
      }
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,'system-platform-activation-code-request',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [input.targetTenantId, input.idempotencyKey, input.requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(
          `SELECT status,request_hash,response_code,response_body FROM idempotency_records
           WHERE tenant_id=$1 AND namespace='system-platform-activation-code-request' AND idempotency_key=$2 FOR UPDATE`,
          [input.targetTenantId, input.idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== input.requestHash) {
          throw Object.assign(new Error('该幂等键已用于其他请求'), { publicCode: 'idempotency_key_conflict', publicReason: '该幂等键已用于其他请求' });
        }
        if (row.status === 'completed') {
          await client.query('COMMIT');
          return { replayed: true, statusCode: row.response_code, response: row.response_body };
        }
        throw Object.assign(new Error('同一幂等请求正在处理'), { publicCode: 'idempotency_request_in_progress', publicReason: '同一幂等请求正在处理' });
      }
      const created = await client.query(
        `INSERT INTO activation_codes
           (tenant_id,requested_by_user_id,plan_version_id,code_digest,code_mask,purpose,state,locked_agent_price_minor,
            bound_user_id,requested_at,expires_at,payment_confirmed_at,issuance_type,target_tenant_id,fulfillment_type,
            platform_payment_id,administrative_reason,benefit_type,bean_amount)
         VALUES($1,$2,$3,$4,$5,'customer','issued',$6,$7,$8,$8::timestamptz+interval '24 hours',$9,
                'platform_direct',$1,$10,$11,$12,$13,$14)
         RETURNING id,requested_at,expires_at`,
        [input.targetTenantId, account.userId, beanMode ? null : plan.id, input.codeDigest, input.codeMask,
          valueMinor, owner.owner_user_id, decisionAt,
          null, 'gift', null, input.reason,
          beanMode ? 'bean_recharge' : 'membership', beanMode ? beanAmount : null]
      );
      const code = created.rows[0];
      await client.query(
        `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,next_state,metadata)
         VALUES($1,$2,$3,'issued_by_system','issued',$4::jsonb)`,
        [input.targetTenantId, code.id, account.userId, JSON.stringify({
          planCode: beanMode ? null : plan.plan_code, issuanceType: 'platform_direct', fulfillmentType: 'gift',
          platformPaymentId: null, reason: input.reason, valueMinor, valueCurrency, collectionState: 'not_collected',
          benefitType: beanMode ? 'bean_recharge' : 'membership', beanAmount: beanMode ? beanAmount : null
        })]
      );
      await this.writeAudit(client, { ...account, tenantId: input.targetTenantId },
        'system.activation_code.admin_direct', 'activation_code', String(code.id), 'success', {
          ...activationAuditMetadata(input, {
            codeMask: input.codeMask, planCode: beanMode ? null : plan.plan_code, planVersionId: beanMode ? null : String(plan.id),
            fulfillmentType: 'gift', platformPaymentId: null, valueMinor, valueCurrency, collectionState: 'not_collected',
            targetOwnerUserId: owner.owner_user_id,
            previousState: null, nextState: 'issued', requestedAt: code.requested_at, expiresAt: code.expires_at
          })
        }
      );
      const response = { item: {
        id: String(code.id), codeMask: input.codeMask, planCode: beanMode ? null : plan.plan_code,
        planName: beanMode ? `AI豆充值·${beanAmount}豆` : plan.name,
        benefitType: beanMode ? 'bean_recharge' : 'membership', beanAmount: beanMode ? beanAmount : null,
        state: 'issued', issuanceType: 'platform_direct', fulfillmentType: 'gift',
        targetTenantId: owner.tenant_id, targetTenantName: owner.tenant_name, targetOwnerUsername: owner.username,
        lockedPriceMinor: valueMinor, valueSnapshot: { amountMinor: valueMinor, currency: valueCurrency, collectionState: 'not_collected' },
        paymentResponsibility: 'not_collected',
        requestedAt: code.requested_at, expiresAt: code.expires_at
      }, oneTimeCodeUnavailable: true };
      const completed = await client.query(
        `UPDATE idempotency_records SET status='completed',response_code=201,response_body=$4::jsonb,
           resource_type='activation_code',resource_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND namespace='system-platform-activation-code-request' AND idempotency_key=$2
           AND request_hash=$5 AND status='processing'`,
        [input.targetTenantId, input.idempotencyKey, String(code.id), JSON.stringify(response), input.requestHash]
      );
      if (completed.rowCount !== 1) throw new Error('平台激活码生成结果写回失败，本次操作已回滚，请稍后重试。');
      await client.query('COMMIT');
      return { replayed: false, statusCode: 201, response };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      // 失败交易已回滚，故单独提交脱敏失败审计；绝不带入完整激活码或管理员密码。
      try { await this.recordSystemActivationFailure(account, input, error); }
      catch (auditError) { throw auditPersistenceError(auditError); }
      throw error;
    } finally { client.release(); }
  }

  async insertUserNotification(clientOrPool, input) {
    const tenantId = String(input && input.tenantId || '');
    const userId = String(input && input.userId || '');
    const category = String(input && input.category || '').trim().slice(0, 40);
    const title = String(input && input.title || '').trim().slice(0, 160);
    const body = String(input && input.body || '').trim().slice(0, 1000);
    const resourceType = String(input && input.resourceType || '').trim().slice(0, 60) || null;
    const resourceId = String(input && input.resourceId || '').trim().slice(0, 160) || null;
    const dedupeKey = String(input && input.dedupeKey || '').trim().slice(0, 160);
    if (!/^\d+$/.test(tenantId) || !/^\d+$/.test(userId) || !/^[a-z][a-z0-9_.-]{0,39}$/.test(category) || !title || !body || !dedupeKey) {
      throw Object.assign(new Error('通知收件人或内容不完整，无法写入，请重新提交。'), { publicCode: 'user_notification_invalid' });
    }
    const result = await clientOrPool.query(
      `INSERT INTO user_notifications
         (tenant_id,user_id,category,title,body,resource_type,resource_id,dedupe_key)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8
       WHERE EXISTS (
         SELECT 1 FROM tenant_members
         WHERE tenant_id=$1 AND user_id=$2 AND status='active'
       )
       ON CONFLICT (tenant_id,user_id,dedupe_key) DO NOTHING
       RETURNING id::text,tenant_id::text,user_id::text,category,title,body,resource_type,resource_id,read_at,created_at`,
      [tenantId, userId, category, title, body, resourceType, resourceId, dedupeKey]
    );
    return result.rows[0] || null;
  }

  async notifySystemAdministrators(client, input) {
    const recipients = await client.query(
      `SELECT DISTINCT tm.tenant_id::text,u.id::text
       FROM users u JOIN tenant_members tm ON tm.user_id=u.id AND tm.status='active'
       WHERE u.is_system_admin=true AND u.status='active'`
    );
    for (const recipient of recipients.rows) await this.insertUserNotification(client, {
      tenantId: recipient.tenant_id, userId: recipient.id, category: 'agent.activation',
      title: input.title, body: input.body, resourceType: 'activation_code', resourceId: String(input.codeId),
      dedupeKey: `agent-activation:${input.codeId}:${input.stage}`
    });
  }

  async notifyMembershipRewardActivityLogin(account) {
    try {
      const notification = await this.insertUserNotification(this.pool, {
        tenantId: account.tenantId, userId: account.userId, category: 'membership.activity',
        title: '付费会员赠送AI豆活动',
        body: '客户空间首次正式付费会员按月卡1000、季卡3000、年卡12000豆赠送；之后每笔正式开通、续费或升级按月卡300、季卡900、年卡3600豆赠送。',
        resourceType: 'membership_activity', resourceId: MEMBERSHIP_REWARD_ACTIVITY.version,
        dedupeKey: `membership-activity:${MEMBERSHIP_REWARD_ACTIVITY.version}:first-login`
      });
      if (notification) await this.writeAudit(this.pool, account, 'membership.activity_notification', 'membership_activity', MEMBERSHIP_REWARD_ACTIVITY.version, 'success', {
        activityVersion: MEMBERSHIP_REWARD_ACTIVITY.version, stage: 'first_login_notification', notificationId: notification.id
      });
    } catch (error) {
      try {
        await this.writeAudit(this.pool, account, 'membership.activity_notification', 'membership_activity', MEMBERSHIP_REWARD_ACTIVITY.version, 'failed', {
          activityVersion: MEMBERSHIP_REWARD_ACTIVITY.version, stage: 'first_login_notification',
          errorCode: String(error.publicCode || error.code || 'membership_activity_notification_failed').slice(0, 80)
        });
      } catch (diagnosticError) {
        console.error('会员活动首次登录通知失败诊断写入失败:', diagnosticError.message);
      }
    }
  }

  async listUserNotifications(account, limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    const [items, unread] = await Promise.all([
      this.pool.query(
        `SELECT id::text,category,title,body,resource_type,resource_id,read_at,created_at
         FROM user_notifications
         WHERE tenant_id=$1 AND user_id=$2
         ORDER BY created_at DESC,id DESC LIMIT $3`,
        [account.tenantId, account.userId, safeLimit]
      ),
      this.pool.query(
        `SELECT count(*)::integer AS count FROM user_notifications
         WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL`,
        [account.tenantId, account.userId]
      )
    ]);
    return {
      items: items.rows.map(row => ({
        id: row.id, category: row.category, title: row.title, body: row.body,
        resourceType: row.resource_type || '', resourceId: row.resource_id || '',
        readAt: row.read_at, createdAt: row.created_at
      })),
      unreadCount: Number(unread.rows[0].count) || 0
    };
  }

  async markUserNotificationRead(account, notificationId) {
    const result = await this.pool.query(
      `UPDATE user_notifications SET read_at=COALESCE(read_at,clock_timestamp())
       WHERE tenant_id=$1 AND user_id=$2 AND id=$3
       RETURNING id::text,read_at`,
      [account.tenantId, account.userId, notificationId]
    );
    return result.rows[0] ? { id: result.rows[0].id, readAt: result.rows[0].read_at } : null;
  }

  async markAllUserNotificationsRead(account) {
    const result = await this.pool.query(
      `UPDATE user_notifications SET read_at=clock_timestamp()
       WHERE tenant_id=$1 AND user_id=$2 AND read_at IS NULL
       RETURNING id::text,read_at`,
      [account.tenantId, account.userId]
    );
    const readAt = result.rows.length ? result.rows[0].read_at : new Date();
    return { updatedCount: result.rowCount, readAt };
  }

  async paymentEvidenceUploadTarget(account, activationCodeId, evidenceKind) {
    const result = await this.pool.query(
      `SELECT c.tenant_id::text,c.id::text,c.code_mask,c.state,c.requested_by_user_id::text,
              c.redeemed_tenant_id::text,c.bound_user_id::text,a.owner_user_id::text AS agent_owner_user_id
       FROM activation_codes c JOIN agents a ON a.tenant_id=c.tenant_id
       WHERE c.id=$1 AND c.state IN ('used_temporary','payment_review','frozen')
         AND (($2='agent_to_platform' AND c.tenant_id=$3 AND a.owner_user_id=$4
               AND a.status='active' AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp()))
           OR ($2='customer_to_agent' AND c.redeemed_tenant_id=$3 AND c.bound_user_id=$4))`,
      [activationCodeId, evidenceKind, account.tenantId, account.userId]
    );
    if (!result.rowCount) throw Object.assign(new Error('没有查看该付款凭证的范围权限，请联系管理员授权。'), { publicCode: 'payment_evidence_scope_denied' });
    return result.rows[0];
  }

  async hasPaymentEvidenceHash(tenantId, sha256) {
    const result = await this.pool.query(
      'SELECT 1 FROM membership_private_objects WHERE tenant_id=$1 AND sha256=$2 LIMIT 1',
      [tenantId, sha256]
    );
    return result.rowCount > 0;
  }

  async savePaymentEvidence(account, input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const codeResult = await client.query(
        `SELECT c.tenant_id::text,c.id::text,c.code_mask,c.state,c.requested_by_user_id::text,
                c.redeemed_tenant_id::text,c.bound_user_id::text,a.owner_user_id::text AS agent_owner_user_id,
                (a.status='active' AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp())) AS agent_is_active
         FROM activation_codes c JOIN agents a ON a.tenant_id=c.tenant_id
         WHERE c.id=$1 FOR UPDATE OF c`,
        [input.activationCodeId]
      );
      const code = codeResult.rows[0];
      const permitted = code && ['used_temporary', 'payment_review', 'frozen'].includes(code.state) && (
        (input.evidenceKind === 'agent_to_platform' && code.tenant_id === String(account.tenantId) && code.agent_owner_user_id === String(account.userId)
          && code.agent_is_active === true) ||
        (input.evidenceKind === 'customer_to_agent' && code.redeemed_tenant_id === String(account.tenantId) && code.bound_user_id === String(account.userId))
      );
      if (!permitted) throw Object.assign(new Error('没有查看该付款凭证的范围权限，请联系管理员授权。'), { publicCode: 'payment_evidence_scope_denied' });
      const duplicate = await client.query(
        `SELECT 1 FROM membership_private_objects
         WHERE tenant_id=$1 AND sha256=$2 LIMIT 1`,
        [code.tenant_id, input.sha256]
      );
      if (duplicate.rowCount) throw Object.assign(new Error('这张付款凭证已上传过，请勿重复提交。'), { publicCode: 'payment_evidence_duplicate' });
      const object = await client.query(
        `INSERT INTO membership_private_objects
           (tenant_id,object_key,object_kind,original_name,media_type,size_bytes,sha256,uploaded_by_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (object_key) DO NOTHING
         RETURNING id::text`,
        [code.tenant_id, input.objectKey,
          input.evidenceKind === 'agent_to_platform' ? 'payment_evidence' : 'customer_payment_evidence',
          input.originalName, input.mediaType, input.size, input.sha256, account.userId]
      );
      if (!object.rowCount) throw Object.assign(new Error('这张付款凭证已上传过，请勿重复提交。'), { publicCode: 'payment_evidence_duplicate' });
      const evidence = await client.query(
        `INSERT INTO payment_evidence
           (tenant_id,activation_code_id,evidence_kind,private_object_id,review_state,ocr_state)
         VALUES($1,$2,$3,$4,'pending','not_started')
         RETURNING id::text,review_state,submitted_at`,
        [code.tenant_id, code.id, input.evidenceKind, object.rows[0].id]
      );
      await client.query(
        `UPDATE activation_codes SET state='payment_review',updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2 AND state='used_temporary'`,
        [code.tenant_id, code.id]
      );
      await client.query(
        `INSERT INTO activation_code_events
           (tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata)
         VALUES($1,$2,$3,'payment_evidence_submitted',$4,'payment_review',$5::jsonb)`,
        [code.tenant_id, code.id, account.userId, code.state,
          JSON.stringify({ evidenceId: evidence.rows[0].id, evidenceKind: input.evidenceKind })]
      );
      const recipientId = input.evidenceKind === 'agent_to_platform' ? code.requested_by_user_id : code.agent_owner_user_id;
      await this.insertUserNotification(client, {
        tenantId: code.tenant_id, userId: recipientId, category: 'payment.evidence',
        title: input.evidenceKind === 'agent_to_platform' ? '付款凭证已提交' : '客户付款凭证待核对',
        body: `${code.code_mask} 的付款凭证已安全提交，当前等待系统管理员人工审核。`,
        resourceType: 'payment_evidence', resourceId: evidence.rows[0].id,
        dedupeKey: `payment-evidence:${evidence.rows[0].id}:submitted:${recipientId}`
      });
      await this.writeAudit(client, account, 'payment.evidence.submit', 'payment_evidence', evidence.rows[0].id, 'success', {
        evidenceTenantId: code.tenant_id, activationCodeId: code.id,
        evidenceKind: input.evidenceKind, mediaType: input.mediaType, size: input.size
      });
      await client.query('COMMIT');
      return { id: evidence.rows[0].id, codeMask: code.code_mask, evidenceKind: input.evidenceKind, reviewState: evidence.rows[0].review_state, submittedAt: evidence.rows[0].submitted_at };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async getPaymentEvidenceObject(account, evidenceId) {
    const result = await this.pool.query(
      `SELECT e.id::text,e.tenant_id::text,e.evidence_kind,e.review_state,o.object_key,o.original_name,o.media_type,o.size_bytes,o.sha256,
              o.uploaded_by_user_id::text,a.owner_user_id::text AS agent_owner_user_id
       FROM payment_evidence e
       JOIN membership_private_objects o ON o.tenant_id=e.tenant_id AND o.id=e.private_object_id
       JOIN activation_codes c ON c.tenant_id=e.tenant_id AND c.id=e.activation_code_id
       JOIN agents a ON a.tenant_id=e.tenant_id
       WHERE e.id=$1 AND (
         $2::boolean
         OR (a.owner_user_id=$3 AND a.status='active'
             AND (a.expires_at IS NULL OR a.expires_at > clock_timestamp())
             AND EXISTS (SELECT 1 FROM tenant_members tm
                         WHERE tm.tenant_id=e.tenant_id AND tm.user_id=$3 AND tm.member_type='owner' AND tm.status='active'))
         OR (e.evidence_kind='customer_to_agent' AND o.uploaded_by_user_id=$3 AND c.bound_user_id=$3
             AND EXISTS (SELECT 1 FROM tenant_members tm
                         WHERE tm.tenant_id=c.redeemed_tenant_id AND tm.user_id=$3 AND tm.member_type='owner' AND tm.status='active'))
       )`,
      [evidenceId, account.isSystemAdmin === true, account.userId]
    );
    return result.rows[0] || null;
  }

  async listPaymentEvidenceForAdmin(account, limit = 100) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
    const result = await this.pool.query(
      `SELECT e.id::text,e.evidence_kind,e.review_state,e.ocr_state,e.submitted_at,e.reviewed_at,e.review_reason,
              c.id::text AS activation_code_id,c.code_mask,c.state AS activation_state,c.locked_agent_price_minor,
              v.plan_code,v.name AS plan_name,v.duration_days,
              t.name AS agent_tenant_name,rt.name AS customer_tenant_name,
              o.media_type,o.size_bytes
       FROM payment_evidence e
       JOIN activation_codes c ON c.tenant_id=e.tenant_id AND c.id=e.activation_code_id
       JOIN membership_plan_versions v ON v.id=c.plan_version_id
       JOIN tenants t ON t.id=e.tenant_id
       LEFT JOIN tenants rt ON rt.id=c.redeemed_tenant_id
       JOIN membership_private_objects o ON o.tenant_id=e.tenant_id AND o.id=e.private_object_id
       ORDER BY (e.review_state IN ('pending','needs_review','matched')) DESC,e.submitted_at,e.id
       LIMIT $1`,
      [safeLimit]
    );
    return result.rows.map(row => ({
      id: row.id, evidenceKind: row.evidence_kind, reviewState: row.review_state, ocrState: row.ocr_state,
      submittedAt: row.submitted_at, reviewedAt: row.reviewed_at, reviewReason: row.review_reason,
      activationCodeId: row.activation_code_id, codeMask: row.code_mask, activationState: row.activation_state,
      lockedAgentPriceMinor: Number(row.locked_agent_price_minor), planCode: row.plan_code, planName: row.plan_name,
      durationDays: Number(row.duration_days), agentTenantName: row.agent_tenant_name,
      customerTenantName: row.customer_tenant_name || '', mediaType: row.media_type, size: Number(row.size_bytes),
      objectUrl: `/api/private-objects/payment-evidence/${row.id}`
    }));
  }

  async listSystemMembershipCampaigns(account) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const result = await this.pool.query(
      `SELECT c.id::text,c.campaign_code,c.name,c.calendar_year,c.campaign_type,c.state,c.starts_at,c.ends_at,c.bonus_days,
              c.confirmed_by_user_id::text,c.created_at,c.updated_at,
              (SELECT count(*)::integer FROM membership_campaign_awards a WHERE a.campaign_id=c.id AND a.state='awarded') AS award_count
       FROM membership_campaigns c
       ORDER BY c.calendar_year DESC,c.starts_at DESC,c.id DESC`
    );
    return result.rows.map(row => ({
      id: row.id, campaignCode: row.campaign_code, name: row.name, calendarYear: Number(row.calendar_year),
      campaignType: row.campaign_type, state: row.state, startsAt: row.starts_at, endsAt: row.ends_at,
      bonusDays: row.bonus_days || {}, confirmedByUserId: row.confirmed_by_user_id || null,
      awardCount: Number(row.award_count) || 0, createdAt: row.created_at, updatedAt: row.updated_at
    }));
  }

  async saveSystemMembershipCampaignDraft(account, input) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM membership_campaigns WHERE calendar_year=$1 AND campaign_type=$2 FOR UPDATE', [input.calendarYear, input.campaignType]);
      let row;
      if (existing.rowCount) {
        if (existing.rows[0].state !== 'draft') throw Object.assign(new Error('该年度同类型活动已不是草稿，不能直接改写。'), { publicCode: 'membership_campaign_not_editable', status: 409 });
        row = (await client.query(
          `UPDATE membership_campaigns
           SET name=$3,starts_at=$4,ends_at=$5,bonus_days=$6::jsonb,updated_at=clock_timestamp()
           WHERE calendar_year=$1 AND campaign_type=$2
           RETURNING *`,
          [input.calendarYear, input.campaignType, input.name, input.startsAt, input.endsAt, JSON.stringify({ month: 7, quarter: 15, year: 30 })]
        )).rows[0];
      } else {
        const code = `manual-${input.calendarYear}-${input.campaignType}`;
        row = (await client.query(
          `INSERT INTO membership_campaigns
             (campaign_code,name,calendar_year,campaign_type,state,starts_at,ends_at,bonus_days)
           VALUES($1,$2,$3,$4,'draft',$5,$6,$7::jsonb)
           RETURNING *`,
          [code, input.name, input.calendarYear, input.campaignType, input.startsAt, input.endsAt, JSON.stringify({ month: 7, quarter: 15, year: 30 })]
        )).rows[0];
      }
      await this.writeAudit(client, account, 'system.membership_campaign.save', 'membership_campaign', row.id, 'success', { calendarYear: row.calendar_year, campaignType: row.campaign_type, state: row.state });
      await client.query('COMMIT');
      return { id: String(row.id), campaignCode: row.campaign_code, state: row.state };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  async publishSystemMembershipCampaign(account, campaignId) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM membership_campaigns WHERE id=$1 FOR UPDATE', [campaignId]);
      if (!current.rowCount) throw Object.assign(new Error('未找到该会员活动，请刷新列表后重试。'), { publicCode: 'membership_campaign_not_found', status: 404 });
      const row = current.rows[0];
      if (row.state === 'published' && row.confirmed_by_user_id) { await client.query('COMMIT'); return { id: String(row.id), state: 'published', replayed: true }; }
      if (row.state !== 'draft') throw Object.assign(new Error('只有草稿活动可以发布。'), { publicCode: 'membership_campaign_not_publishable', status: 409 });
      const overlap = await client.query(
        `SELECT id FROM membership_campaigns
         WHERE id<>$1 AND state='published' AND confirmed_by_user_id IS NOT NULL
           AND starts_at<$3::timestamptz AND ends_at>$2::timestamptz
         LIMIT 1`,
        [campaignId, row.starts_at, row.ends_at]
      );
      if (overlap.rowCount) throw Object.assign(new Error('该活动时间与已发布活动重叠，请先调整起止时间。'), { publicCode: 'membership_campaign_overlap', status: 409 });
      const published = (await client.query(
        `UPDATE membership_campaigns SET state='published',confirmed_by_user_id=$2,updated_at=clock_timestamp()
         WHERE id=$1 RETURNING *`,
        [campaignId, account.userId]
      )).rows[0];
      await this.writeAudit(client, account, 'system.membership_campaign.publish', 'membership_campaign', published.id, 'success', { calendarYear: published.calendar_year, campaignType: published.campaign_type });
      await client.query('COMMIT');
      return { id: String(published.id), state: published.state };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  async cancelSystemMembershipCampaign(account, campaignId) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query('SELECT * FROM membership_campaigns WHERE id=$1 FOR UPDATE', [campaignId]);
      if (!current.rowCount) throw Object.assign(new Error('未找到该会员活动，请刷新列表后重试。'), { publicCode: 'membership_campaign_not_found', status: 404 });
      const row = current.rows[0];
      if (row.state === 'cancelled') { await client.query('COMMIT'); return { id: String(row.id), state: 'cancelled', replayed: true }; }
      if (!['draft', 'published'].includes(row.state)) throw Object.assign(new Error('当前活动状态不能取消。'), { publicCode: 'membership_campaign_not_cancellable', status: 409 });
      const awards = await client.query('SELECT 1 FROM membership_campaign_awards WHERE campaign_id=$1 LIMIT 1', [campaignId]);
      if (awards.rowCount) throw Object.assign(new Error('该活动已经发放过会员赠送，为保护历史权益不能直接取消。'), { publicCode: 'membership_campaign_has_awards', status: 409 });
      const cancelled = (await client.query("UPDATE membership_campaigns SET state='cancelled',updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [campaignId])).rows[0];
      await this.writeAudit(client, account, 'system.membership_campaign.cancel', 'membership_campaign', cancelled.id, 'success', { calendarYear: cancelled.calendar_year, campaignType: cancelled.campaign_type });
      await client.query('COMMIT');
      return { id: String(cancelled.id), state: cancelled.state };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  async applyHolidayCampaignAwardForClient(client, input) {
    const campaigns = await client.query(
      `SELECT c.id::text,c.campaign_code,c.name,c.calendar_year,c.campaign_type,c.bonus_days,
              v.plan_code,v.benefit_rank
       FROM membership_campaigns c
       JOIN membership_plan_versions v ON v.id=$1
       WHERE c.state='published' AND c.confirmed_by_user_id IS NOT NULL
         AND $2::timestamptz>=c.starts_at AND $2::timestamptz<c.ends_at
       ORDER BY c.id`,
      [input.planVersionId, input.usedAt]
    );
    if (!campaigns.rowCount) return { state: 'not_applicable', awardedDays: 0, addedDays: 0 };
    if (campaigns.rowCount > 1) {
      throw Object.assign(new Error('该时间段已存在其他会员活动，请先调整活动起止日期。'), { publicCode: 'membership_campaign_overlap' });
    }
    const campaign = campaigns.rows[0];
    const expectedDays = { month: 7, quarter: 15, year: 30 }[campaign.plan_code];
    const awardedDays = Number(campaign.bonus_days && campaign.bonus_days[campaign.plan_code]);
    if (!expectedDays || awardedDays !== expectedDays) {
      throw Object.assign(new Error('请填写大于0的赠送AI豆数量，再保存会员活动。'), { publicCode: 'membership_campaign_bonus_invalid' });
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('membership-campaign-award:'||$1||':'||$2,0))`,
      [String(input.tenantId), campaign.id]
    );
    const existing = await client.query(
      `SELECT a.awarded_days,a.state,a.period_id::text,v.benefit_rank,p.state AS period_state,p.ends_at
       FROM membership_campaign_awards a
       JOIN membership_plan_versions v ON v.id=a.plan_version_id
       JOIN membership_periods p ON p.tenant_id=a.tenant_id AND p.id=a.period_id
       WHERE a.tenant_id=$1 AND a.campaign_id=$2 FOR UPDATE OF a,p`,
      [input.tenantId, campaign.id]
    );
    if (existing.rowCount) {
      const prior = existing.rows[0];
      if (prior.state === 'reversed' || Number(prior.benefit_rank) >= Number(campaign.benefit_rank)
          || awardedDays <= Number(prior.awarded_days)) {
        return { state: prior.state === 'reversed' ? 'reversed' : 'already_awarded', campaignCode: campaign.campaign_code,
          awardedDays: Number(prior.awarded_days), addedDays: 0, periodId: prior.period_id };
      }
      const addedDays = awardedDays - Number(prior.awarded_days);
      await client.query(
        `UPDATE membership_periods
         SET starts_at=starts_at+$3::integer*interval '1 day',ends_at=ends_at+$3::integer*interval '1 day',updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id<>$2 AND state='queued' AND starts_at>=$4::timestamptz`,
        [input.tenantId, prior.period_id, addedDays, prior.ends_at]
      );
      await client.query(
        `UPDATE membership_periods SET plan_version_id=$3,ends_at=ends_at+$4::integer*interval '1 day',
             remaining_seconds=CASE WHEN remaining_seconds IS NULL THEN NULL ELSE remaining_seconds+$4::integer*86400 END,
             updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND id=$2`,
        [input.tenantId, prior.period_id, input.planVersionId, addedDays]
      );
      await client.query(
        `UPDATE membership_campaign_awards SET plan_version_id=$3,awarded_days=$4,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND campaign_id=$2`,
        [input.tenantId, campaign.id, input.planVersionId, awardedDays]
      );
      await client.query(
        `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,previous_state,next_state,metadata)
         VALUES($1,$2,$3,'holiday_bonus_topped_up',$4,$4,$5::jsonb)`,
        [input.tenantId, prior.period_id, input.actorUserId, prior.period_state,
          JSON.stringify({ campaignCode: campaign.campaign_code, planCode: campaign.plan_code, awardedDays, addedDays })]
      );
      await this.insertUserNotification(client, {
        tenantId: input.tenantId, userId: input.recipientUserId, category: 'membership.campaign', title: '节假日会员赠送已补足',
        body: `${campaign.name}已按本活动最高购买方案补足${addedDays}天，当前累计赠送${awardedDays}天。`,
        resourceType: 'membership_campaign', resourceId: campaign.id,
        dedupeKey: `membership-campaign:${campaign.id}:award:${awardedDays}`
      });
      return { state: 'topped_up', campaignCode: campaign.campaign_code, awardedDays, addedDays, periodId: prior.period_id };
    }
    const trigger = await client.query(
      `SELECT id::text,ends_at FROM membership_periods WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [input.tenantId, input.triggeringPeriodId]
    );
    if (!trigger.rowCount || !trigger.rows[0].ends_at) throw new Error('找不到本次活动对应的会员生效区间，无法计算赠豆，请先核对付费记录。');
    const startsAt = trigger.rows[0].ends_at;
    await client.query(
      `UPDATE membership_periods
       SET starts_at=starts_at+$3::integer*interval '1 day',ends_at=ends_at+$3::integer*interval '1 day',updated_at=clock_timestamp()
       WHERE tenant_id=$1 AND id<>$2 AND state='queued' AND starts_at>=$4::timestamptz`,
      [input.tenantId, input.triggeringPeriodId, awardedDays, startsAt]
    );
    const period = await client.query(
      `INSERT INTO membership_periods
         (tenant_id,plan_version_id,source_type,source_ref,state,starts_at,ends_at,remaining_seconds,created_by_user_id)
       VALUES($1,$2,'holiday_bonus',$3,'queued',$4::timestamptz,$4::timestamptz+$5::integer*interval '1 day',$5::integer*86400,$6)
       RETURNING id::text`,
      [input.tenantId, input.planVersionId, `campaign:${campaign.id}`, startsAt, awardedDays, input.actorUserId]
    );
    await client.query(
      `INSERT INTO membership_campaign_awards
         (tenant_id,campaign_id,plan_version_id,payment_reference,awarded_days,period_id,state)
       VALUES($1,$2,$3,$4,$5,$6,'awarded')`,
      [input.tenantId, campaign.id, input.planVersionId,
        input.paymentReference || `payment-evidence:${input.paymentEvidenceId}`, awardedDays, period.rows[0].id]
    );
    await client.query(
      `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,next_state,metadata)
       VALUES($1,$2,$3,'holiday_bonus_awarded','queued',$4::jsonb)`,
      [input.tenantId, period.rows[0].id, input.actorUserId,
        JSON.stringify({ campaignCode: campaign.campaign_code, planCode: campaign.plan_code, awardedDays })]
    );
    await this.insertUserNotification(client, {
      tenantId: input.tenantId, userId: input.recipientUserId, category: 'membership.campaign', title: '节假日会员赠送已发放',
      body: `${campaign.name}已赠送${awardedDays}天会员时间，并接续在本次付费会员之后。`,
      resourceType: 'membership_campaign', resourceId: campaign.id,
      dedupeKey: `membership-campaign:${campaign.id}:award:${awardedDays}`
    });
    return { state: 'awarded', campaignCode: campaign.campaign_code, awardedDays, addedDays: awardedDays, periodId: period.rows[0].id };
  }

  async reviewPaymentEvidence(account, input) {
    const client = await this.pool.connect();
    let rewardAttempt = null;
    try {
      await client.query('BEGIN');
      const reviewer = await client.query('SELECT password_hash FROM users WHERE id=$1 AND status=\'active\' AND is_system_admin=true FOR UPDATE', [account.userId]);
      if (!reviewer.rowCount || !await verifyPassword(input.password, reviewer.rows[0].password_hash)) {
        throw Object.assign(new Error('密码校验未通过，请输入当前登录密码后再执行该操作。'), { publicCode: 'reauthentication_failed' });
      }
      const result = await client.query(
        `SELECT e.*,c.code_mask,c.state AS activation_state,c.locked_agent_price_minor,c.redeemed_tenant_id::text,
                c.bound_user_id::text,c.requested_by_user_id::text,c.used_at,c.payment_confirmed_at,c.plan_version_id,
                a.owner_user_id::text AS agent_owner_user_id,v.plan_code,v.name AS plan_name,v.duration_days,v.benefit_rank,
                p.id::text AS period_id,p.state AS period_state
         FROM payment_evidence e
         JOIN activation_codes c ON c.tenant_id=e.tenant_id AND c.id=e.activation_code_id
         JOIN agents a ON a.tenant_id=e.tenant_id
         JOIN membership_plan_versions v ON v.id=c.plan_version_id
         JOIN membership_periods p ON p.tenant_id=c.redeemed_tenant_id AND p.source_type='activation_code' AND p.source_ref=c.id::text
         WHERE e.id=$1 FOR UPDATE OF e,c,p,a`,
        [input.evidenceId]
      );
      if (!result.rowCount) throw Object.assign(new Error('未找到这张付款凭证，请刷新列表后重试。'), { publicCode: 'payment_evidence_not_found' });
      const evidence = result.rows[0];
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,'system-payment-evidence-review',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [evidence.tenant_id, input.idempotencyKey, input.requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(
          `SELECT status,request_hash,response_code,response_body FROM idempotency_records
           WHERE tenant_id=$1 AND namespace='system-payment-evidence-review' AND idempotency_key=$2 FOR UPDATE`,
          [evidence.tenant_id, input.idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== input.requestHash) {
          throw Object.assign(new Error('该请求编号已用于其他操作，请刷新页面后重新提交。'), { publicCode: 'idempotency_key_conflict' });
        }
        if (row.status === 'completed') {
          const reward = await client.query(
            `SELECT e.* FROM ai_bean_events e JOIN activation_codes c ON c.redeemed_tenant_id=e.tenant_id
             WHERE c.id=$1 AND e.event_type='membership_reward' AND e.business_ref=('activation_code:'||c.id::text) LIMIT 1`,
            [evidence.activation_code_id]
          );
          if (reward.rowCount) {
            const e = reward.rows[0];
            await this.writeAudit(client, { ...account, tenantId: e.tenant_id }, 'membership.reward', 'activation_code', String(evidence.activation_code_id), 'success', {
              requestId: input.idempotencyKey, businessRef: e.business_ref, amountBean: Number(e.amount_bean), unit: 'AI豆',
              idempotencyKeyHash: crypto.createHash('sha256').update(`membership-reward:${evidence.activation_code_id}`).digest('hex'),
              providerTaskId: null, providerState: '不可用', retryCount: 0, recoveryCount: 0,
              availableBalanceBefore: Number(e.balance_after) - Number(e.amount_bean), availableBalanceAfter: Number(e.balance_after),
              frozenBalanceBefore: Number(e.frozen_after), frozenBalanceAfter: Number(e.frozen_after),
              stageStatus: 'replayed', startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
            });
          }
          await client.query('COMMIT');
          return { replayed: true, statusCode: row.response_code, response: row.response_body };
        }
        throw Object.assign(new Error('相同操作正在处理中，请稍候片刻再查看结果。'), { publicCode: 'idempotency_request_in_progress' });
      }
      if (!['pending', 'needs_review', 'matched'].includes(evidence.review_state)) {
        throw Object.assign(new Error('这张付款凭证已经审核过，不能重复审核。'), { publicCode: 'payment_evidence_already_reviewed' });
      }
      const viewed = await client.query(
        `SELECT 1 FROM audit_events ae
         WHERE ae.tenant_id=$3 AND ae.actor_user_id=$1
           AND action='payment.evidence.read' AND resource_type='payment_evidence' AND resource_id=$2
           AND created_at >= clock_timestamp()-interval '10 minutes' LIMIT 1`,
        [account.userId, input.evidenceId, account.tenantId]
      );
      if (!viewed.rowCount) throw Object.assign(new Error('请先在页面上查看这张付款原图，再提交审核结论。'), { publicCode: 'payment_evidence_must_be_viewed' });
      const decisionAt = (await client.query('SELECT clock_timestamp() AS decision_at')).rows[0].decision_at;
      const verifiedFields = input.action === 'confirm' ? {
        transactionId: input.transactionId, amountMinor: input.amountMinor, currency: input.currency,
        payer: input.payer, payee: input.payee, paidAt: input.paidAt
      } : {};
      if (input.action === 'confirm') {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('payment-evidence-transaction:'||lower($1),0))", [input.transactionId]);
        const duplicateTransaction = await client.query(
          `SELECT 1 FROM payment_evidence
           WHERE id<>$1 AND review_state='confirmed'
             AND lower(ocr_fields->'administratorVerified'->>'transactionId')=lower($2) LIMIT 1`,
          [input.evidenceId, input.transactionId]
        );
        if (duplicateTransaction.rowCount) {
          throw Object.assign(new Error('该交易号已登记过，请勿重复提交同一笔付款。'), { publicCode: 'payment_transaction_duplicate' });
        }
      }
      await client.query(
        `UPDATE payment_evidence
         SET review_state=$3::varchar,reviewed_by_user_id=$2,reviewed_at=$4,review_reason=$5,
             ocr_fields=CASE WHEN $3::varchar='confirmed' THEN jsonb_set(ocr_fields,'{administratorVerified}',$6::jsonb,true) ELSE ocr_fields END
         WHERE id=$1`,
        [input.evidenceId, account.userId, input.action === 'confirm' ? 'confirmed' : 'rejected', decisionAt, input.reason, JSON.stringify(verifiedFields)]
      );

      let membershipState = evidence.period_state;
      let holidayCampaign = null;
      if (input.action === 'confirm') {
        const entitlementAlreadyConfirmed = await client.query(
          `SELECT 1 FROM membership_events WHERE tenant_id=$1 AND period_id=$2 AND event_type='payment_entitlement_confirmed' LIMIT 1`,
          [evidence.redeemed_tenant_id, evidence.period_id]
        );
        if (!entitlementAlreadyConfirmed.rowCount) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-first-paid:'||$1,0))", [String(evidence.redeemed_tenant_id)]);
          const historical = await client.query(
            `SELECT 1 FROM membership_events WHERE tenant_id=$1 AND event_type='payment_entitlement_confirmed' LIMIT 1`,
            [evidence.redeemed_tenant_id]
          );
          const rewardType = historical.rowCount ? 'subsequent' : 'first';
          const rewardBeans = membershipRewardAmount(evidence.plan_code, Boolean(historical.rowCount));
          rewardAttempt = {
            tenantId: evidence.redeemed_tenant_id, codeId: String(evidence.activation_code_id),
            businessRef: `activation_code:${evidence.activation_code_id}`, amountBean: rewardBeans, rewardType,
            startedAt: new Date().toISOString(),
            idempotencyKeyHash: crypto.createHash('sha256').update(`membership-reward:${evidence.activation_code_id}`).digest('hex')
          };
          const competing = await client.query(
            `SELECT p.id::text,p.source_type,p.state,p.starts_at,p.ends_at,p.remaining_seconds,v.benefit_rank
             FROM membership_periods p JOIN membership_plan_versions v ON v.id=p.plan_version_id
             WHERE p.tenant_id=$1 AND p.id<>$2 AND p.state IN ('active','paused','queued')
               AND (p.state IN ('paused','queued') OR p.ends_at IS NULL OR p.ends_at>$3)
             ORDER BY v.benefit_rank DESC,p.ends_at NULLS LAST,p.id FOR UPDATE OF p`,
            [evidence.redeemed_tenant_id, evidence.period_id, decisionAt]
          );
          if (competing.rows.some(period => period.source_type === 'partner')) {
            throw Object.assign(new Error('合作商采购单需先退款再重做，请先处理退款记录。'), { publicCode: 'partner_purchase_refund_required' });
          }
          const durationSeconds = Number(evidence.duration_days) * 86400;
          const sameOrHigher = competing.rows.filter(period => Number(period.benefit_rank) >= Number(evidence.benefit_rank));
          if (sameOrHigher.length) {
            const finiteEnds = sameOrHigher.map(period => period.ends_at && new Date(period.ends_at).getTime()).filter(Number.isFinite);
            const queueAt = new Date(Math.max(decisionAt.getTime(), ...finiteEnds));
            const queueEnd = new Date(queueAt.getTime() + durationSeconds * 1000);
            await client.query(
              `UPDATE membership_periods SET state='queued',starts_at=$3,ends_at=$4,remaining_seconds=$5,updated_at=$3
               WHERE tenant_id=$1 AND id=$2`,
              [evidence.redeemed_tenant_id, evidence.period_id, queueAt, queueEnd, durationSeconds]
            );
            membershipState = 'queued';
          } else {
            const formalEnd = new Date(decisionAt.getTime() + durationSeconds * 1000);
            await client.query(
              `UPDATE membership_periods SET state='active',starts_at=$3,ends_at=$4,remaining_seconds=NULL,updated_at=$3
               WHERE tenant_id=$1 AND id=$2`,
              [evidence.redeemed_tenant_id, evidence.period_id, decisionAt, formalEnd]
            );
            let resumeAt = formalEnd;
            for (const period of competing.rows) {
              const remaining = period.state === 'active'
                ? period.ends_at && Math.max(0, Math.floor((new Date(period.ends_at).getTime() - decisionAt.getTime()) / 1000))
                : Number(period.remaining_seconds) || period.ends_at && Math.max(0,
                  Math.floor((new Date(period.ends_at).getTime() - new Date(period.starts_at).getTime()) / 1000));
              if (!remaining) continue;
              const resumeEnd = new Date(resumeAt.getTime() + remaining * 1000);
              await client.query(
                `UPDATE membership_periods
                 SET plan_version_id=CASE WHEN source_type IN ('registration_trial','profile_trial') THEN $3 ELSE plan_version_id END,
                     state='queued',starts_at=$4,ends_at=$5,remaining_seconds=$6,updated_at=$7
                 WHERE tenant_id=$1 AND id=$2`,
                [evidence.redeemed_tenant_id, period.id, evidence.plan_version_id, resumeAt, resumeEnd, remaining, decisionAt]
              );
              resumeAt = resumeEnd;
            }
            membershipState = 'active';
          }
          await client.query(
            `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,previous_state,next_state,metadata)
             VALUES($1,$2,$3,'payment_entitlement_confirmed',$4,$5,$6::jsonb)`,
            [evidence.redeemed_tenant_id, evidence.period_id, account.userId, evidence.period_state, membershipState,
              JSON.stringify({ evidenceId: String(evidence.id), evidenceKind: evidence.evidence_kind, confirmedAt: decisionAt.toISOString() })]
          );
          const beans = await creditMembershipOn(client, evidence.redeemed_tenant_id, {
            amount: rewardBeans, idempotencyKey: `membership-reward:${evidence.activation_code_id}`,
            businessRef: rewardAttempt.businessRef, actorUserId: account.userId,
            reason: `${historical.rowCount ? '后续' : '首次'}正式会员赠送${rewardBeans}豆`
          });
          if (beans.replayed) throw new Error('会员赠豆流水已存在但权益状态未同步，请联系系统管理员核查。');
          rewardAttempt.wallet = beans.event;
          await client.query(
            `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,previous_state,next_state,metadata)
             VALUES($1,$2,$3,'membership_reward_granted',$4,$4,$5::jsonb)`,
            [evidence.redeemed_tenant_id, evidence.period_id, account.userId, membershipState,
              JSON.stringify({ activationCodeId: rewardAttempt.codeId, rewardType, rewardBeans, beanEventId: beans.event.id })]
          );
          await this.writeAudit(client, { ...account, tenantId: evidence.redeemed_tenant_id }, 'membership.reward', 'activation_code', rewardAttempt.codeId, 'success', {
            requestId: input.idempotencyKey, businessRef: rewardAttempt.businessRef, amountBean: rewardBeans, unit: 'AI豆',
            rewardType, idempotencyKeyHash: rewardAttempt.idempotencyKeyHash,
            providerTaskId: null, providerState: '不可用', retryCount: 0, recoveryCount: 0,
            availableBalanceBefore: beans.event.balanceBefore, availableBalanceAfter: beans.event.balanceAfter,
            frozenBalanceBefore: beans.event.frozenBefore, frozenBalanceAfter: beans.event.frozenAfter,
            stageStatus: 'committed_with_payment_review', startedAt: rewardAttempt.startedAt, completedAt: new Date().toISOString()
          });
          holidayCampaign = await this.applyHolidayCampaignAwardForClient(client, {
            tenantId: evidence.redeemed_tenant_id, planVersionId: evidence.plan_version_id,
            triggeringPeriodId: evidence.period_id, paymentEvidenceId: evidence.id,
            usedAt: evidence.used_at, actorUserId: account.userId, recipientUserId: evidence.bound_user_id
          });
        }
        await client.query(
          `INSERT INTO agent_financial_events
             (tenant_id,activation_code_id,event_type,account_type,direction,currency,amount_minor,idempotency_key,reason,actor_user_id)
           VALUES($1,$2,'amount_due','payable','debit','CNY',$3,$4,$5,$6)
           ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
          [evidence.tenant_id, evidence.activation_code_id, evidence.locked_agent_price_minor,
            `activation:${evidence.activation_code_id}:amount-due`, '激活码应付平台代理价', account.userId]
        );
        if (evidence.evidence_kind === 'agent_to_platform') {
          if (Number(input.amountMinor) !== Number(evidence.locked_agent_price_minor)) {
            throw Object.assign(new Error('实际到账金额与应付代理价不一致，请核对后再确认付款。'), { publicCode: 'payment_amount_mismatch', expectedAmountMinor: Number(evidence.locked_agent_price_minor) });
          }
          await client.query(
            `INSERT INTO agent_financial_events
               (tenant_id,activation_code_id,event_type,account_type,direction,currency,amount_minor,idempotency_key,reason,actor_user_id)
             VALUES($1,$2,'payment','payable','credit',$3,$4,$5,$6,$7)
             ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
            [evidence.tenant_id, evidence.activation_code_id, input.currency, input.amountMinor,
              `payment-evidence:${evidence.id}:payment`, input.reason, account.userId]
          );
          await client.query(
            `UPDATE activation_codes SET state='paid',payment_confirmed_at=COALESCE(payment_confirmed_at,$3),updated_at=$3 WHERE tenant_id=$1 AND id=$2`,
            [evidence.tenant_id, evidence.activation_code_id, decisionAt]
          );
          const salesAgent = (await client.query(`SELECT * FROM agents WHERE tenant_id=$1`, [evidence.tenant_id])).rows[0];
          const salesSettings = (await client.query(`SELECT automatic_agent_penalties_enabled FROM billing_settings WHERE singleton=true`)).rows[0] || {};
          await this.reconcileAgentSalesForClient(
            client, salesAgent, decisionAt, salesSettings.automatic_agent_penalties_enabled === true
          );
          const financial = await this.agentFinancialSummary(client, evidence.tenant_id);
          if (salesAgent.status === 'suspended' && salesAgent.deposit_mode === 'required'
              && financial.depositBalanceMinor >= financial.depositRequiredMinor && financial.payableMinor <= 0) {
            await client.query(`UPDATE agents SET status='active',updated_at=$2 WHERE tenant_id=$1 AND status='suspended'`, [evidence.tenant_id, decisionAt]);
          }
        } else {
          await client.query(
            `UPDATE activation_codes SET customer_declared_price_minor=$3,updated_at=$4 WHERE tenant_id=$1 AND id=$2`,
            [evidence.tenant_id, evidence.activation_code_id, input.amountMinor, decisionAt]
          );
        }
      } else {
        const protectionEnd = new Date(Math.min(new Date(evidence.used_at).getTime() + 120 * 3600000, decisionAt.getTime() + 24 * 3600000));
        await client.query(
          `UPDATE membership_periods SET state=CASE WHEN $3>clock_timestamp() THEN 'active' ELSE 'frozen' END,
                  ends_at=$3,updated_at=clock_timestamp()
           WHERE tenant_id=$1 AND id=$2`,
          [evidence.redeemed_tenant_id, evidence.period_id, protectionEnd]
        );
        membershipState = protectionEnd > decisionAt ? 'active' : 'frozen';
      }

      await client.query(
        `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [evidence.tenant_id, evidence.activation_code_id, account.userId,
          input.action === 'confirm' ? 'payment_evidence_confirmed' : 'payment_evidence_rejected',
          evidence.activation_state, evidence.evidence_kind === 'agent_to_platform' && input.action === 'confirm' ? 'paid' : evidence.activation_state,
          JSON.stringify({ evidenceId: String(evidence.id), evidenceKind: evidence.evidence_kind, membershipState })]
      );
      const customerTitle = input.action === 'confirm' ? '付款材料已人工确认' : '付款材料需要补充';
      const customerBody = input.action === 'confirm'
        ? `${evidence.code_mask} 的付款材料已由管理员人工核对，会员权益已按规则处理。`
        : `${evidence.code_mask} 的付款材料未通过，请在24小时内补充；临时权益最迟不超过激活后120小时。`;
      await this.insertUserNotification(client, {
        tenantId: evidence.redeemed_tenant_id, userId: evidence.bound_user_id, category: 'payment.review',
        title: customerTitle, body: customerBody, resourceType: 'payment_evidence', resourceId: String(evidence.id),
        dedupeKey: `payment-evidence:${evidence.id}:${input.action}:customer`
      });
      await this.insertUserNotification(client, {
        tenantId: evidence.tenant_id, userId: evidence.agent_owner_user_id, category: 'payment.review',
        title: customerTitle, body: customerBody, resourceType: 'payment_evidence', resourceId: String(evidence.id),
        dedupeKey: `payment-evidence:${evidence.id}:${input.action}:agent`
      });
      await this.writeAudit(client, account, `payment.evidence.${input.action}`, 'payment_evidence', String(evidence.id), 'success', {
        evidenceTenantId: String(evidence.tenant_id), activationCodeId: String(evidence.activation_code_id),
        evidenceKind: evidence.evidence_kind, membershipState
      });
      const response = { item: {
        id: String(evidence.id), reviewState: input.action === 'confirm' ? 'confirmed' : 'rejected',
        activationState: evidence.evidence_kind === 'agent_to_platform' && input.action === 'confirm' ? 'paid' : evidence.activation_state,
        membershipState, holidayCampaign, reviewedAt: decisionAt
      } };
      const completed = await client.query(
        `UPDATE idempotency_records SET status='completed',response_code=200,response_body=$4::jsonb,
           resource_type='payment_evidence',resource_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND namespace='system-payment-evidence-review' AND idempotency_key=$2
           AND request_hash=$5 AND status='processing'`,
        [evidence.tenant_id, input.idempotencyKey, String(evidence.id), JSON.stringify(response), input.requestHash]
      );
      if (completed.rowCount !== 1) throw new Error('付款凭证审核结果写回失败，本次审核已回滚，请稍后重试。');
      await client.query('COMMIT');
      return { replayed: false, statusCode: 200, response };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (rewardAttempt) {
        const wallet = await this.pool.query('SELECT balance_bean,frozen_bean FROM ai_bean_accounts WHERE tenant_id=$1', [rewardAttempt.tenantId]);
        const available = rewardAttempt.wallet ? rewardAttempt.wallet.balanceBefore
          : wallet.rowCount ? Number(wallet.rows[0].balance_bean) : 0;
        const frozen = rewardAttempt.wallet ? rewardAttempt.wallet.frozenBefore
          : wallet.rowCount ? Number(wallet.rows[0].frozen_bean) : 0;
        await this.writeAudit(this.pool, { ...account, tenantId: rewardAttempt.tenantId }, 'membership.reward', 'activation_code', rewardAttempt.codeId, 'failed', {
          requestId: input.idempotencyKey, businessRef: rewardAttempt.businessRef, amountBean: rewardAttempt.amountBean, unit: 'AI豆',
          rewardType: rewardAttempt.rewardType, idempotencyKeyHash: rewardAttempt.idempotencyKeyHash,
          providerTaskId: null, providerState: '不可用', retryCount: 0, recoveryCount: 0,
          availableBalanceBefore: available, availableBalanceAfter: available,
          frozenBalanceBefore: frozen, frozenBalanceAfter: frozen,
          stageStatus: 'rolled_back', errorCode: error.publicCode || 'membership_reward_failed',
          startedAt: rewardAttempt.startedAt, completedAt: new Date().toISOString()
        });
      }
      throw error;
    } finally { client.release(); }
  }

  async activateSystemDirectCodeForClient(client, account, code, decisionAt) {
    await this.reconcileMembershipPeriodsForClient(client, account.tenantId, decisionAt, account.userId);
    const competing = await client.query(
      `SELECT p.id::text,p.source_type,p.state,p.starts_at,p.ends_at,p.remaining_seconds,v.benefit_rank
       FROM membership_periods p JOIN membership_plan_versions v ON v.id=p.plan_version_id
       WHERE p.tenant_id=$1 AND p.state IN ('active','paused','queued')
         AND (p.state IN ('paused','queued') OR p.ends_at IS NULL OR p.ends_at>$2)
       ORDER BY CASE p.state WHEN 'active' THEN 0 ELSE 1 END,p.starts_at,p.id FOR UPDATE OF p`,
      [account.tenantId, decisionAt]
    );
    const durationSeconds = Number(code.duration_days) * 86400;
    const sameOrHigher = competing.rows.filter(period => Number(period.benefit_rank) >= Number(code.benefit_rank));
    let state = 'active'; let startsAt = decisionAt;
    if (sameOrHigher.length) {
      const ends = sameOrHigher.map(period => period.ends_at && new Date(period.ends_at).getTime());
      if (ends.some(value => !Number.isFinite(value))) {
        throw Object.assign(new Error('该客户空间已有正在生效的会员权益，不能重复激活永久权益。'), { publicCode: 'membership_permanent_entitlement_conflict' });
      }
      startsAt = new Date(Math.max(decisionAt.getTime(), ...ends)); state = 'queued';
    }
    const endsAt = new Date(startsAt.getTime() + durationSeconds * 1000);
    const period = await client.query(
      `INSERT INTO membership_periods
         (tenant_id,plan_version_id,source_type,source_ref,state,starts_at,ends_at,remaining_seconds,created_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id::text,starts_at,ends_at`,
      [account.tenantId, code.plan_version_id, code.fulfillment_type === 'paid' ? 'direct_payment' : 'manual',
        `system-activation-code:${code.id}`, state, startsAt, endsAt, state === 'queued' ? durationSeconds : null, account.userId]
    );
    if (state === 'active') {
      let resumeAt = endsAt;
      for (const existing of competing.rows) {
        const remaining = existing.state === 'active'
          ? existing.ends_at && Math.max(0, Math.floor((new Date(existing.ends_at).getTime() - decisionAt.getTime()) / 1000))
          : Number(existing.remaining_seconds) || (existing.ends_at && Math.max(0,
            Math.floor((new Date(existing.ends_at).getTime() - new Date(existing.starts_at).getTime()) / 1000)));
        if (!remaining) continue;
        const resumeEnd = new Date(resumeAt.getTime() + remaining * 1000);
        await client.query(
          `UPDATE membership_periods
           SET plan_version_id=CASE WHEN source_type IN ('registration_trial','profile_trial') THEN $3 ELSE plan_version_id END,
               state='queued',starts_at=$4,ends_at=$5,remaining_seconds=$6,updated_at=$7
           WHERE tenant_id=$1 AND id=$2`,
          [account.tenantId, existing.id, code.plan_version_id, resumeAt, resumeEnd, remaining, decisionAt]
        );
        resumeAt = resumeEnd;
      }
    }
    await client.query(
      `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,next_state,metadata)
       VALUES($1,$2,$3,'system_direct_entitlement_activated',$4,$5::jsonb)`,
      [account.tenantId, period.rows[0].id, account.userId, state, JSON.stringify({
        activationCodeId: String(code.id), fulfillmentType: code.fulfillment_type,
        platformPaymentId: code.platform_payment_id && String(code.platform_payment_id)
      })]
    );
    const holidayCampaign = code.fulfillment_type === 'paid'
      ? await this.applyHolidayCampaignAwardForClient(client, {
        tenantId: account.tenantId, planVersionId: code.plan_version_id, triggeringPeriodId: period.rows[0].id,
        paymentReference: `platform-payment:${code.platform_payment_id}`, usedAt: decisionAt,
        actorUserId: account.userId, recipientUserId: account.userId
      }) : null;
    return { period: period.rows[0], state, holidayCampaign };
  }

  async activateMembershipCode(account, codeDigest, idempotencyKey, requestHash, warning) {
    const client = await this.pool.connect();
    let failureContext = null;
    try {
      await client.query('BEGIN');
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,'membership-activate',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [account.tenantId, idempotencyKey, requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(
          `SELECT status,request_hash,response_code,response_body FROM idempotency_records
           WHERE tenant_id=$1 AND namespace='membership-activate' AND idempotency_key=$2 FOR UPDATE`,
          [account.tenantId, idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== requestHash) {
          throw Object.assign(new Error('该请求编号已用于其他操作，请刷新页面后重新提交。'), { publicCode: 'idempotency_key_conflict' });
        }
        if (row.status === 'completed') {
          await client.query('COMMIT');
          return { replayed: true, statusCode: row.response_code, response: row.response_body };
        }
        if (row.status === 'processing') {
          throw Object.assign(new Error('相同操作正在处理中，请稍候片刻再查看结果。'), { publicCode: 'idempotency_request_in_progress' });
        }
        await client.query(
          `UPDATE idempotency_records SET status='processing',response_code=NULL,response_body=NULL,updated_at=now(),expires_at=now()+interval '7 days'
           WHERE tenant_id=$1 AND namespace='membership-activate' AND idempotency_key=$2`,
          [account.tenantId, idempotencyKey]
        );
      }
      const result = await client.query(
        `SELECT c.*,v.plan_code,v.version_no,v.name,v.currency,v.duration_days,v.benefit_rank,v.benefits
         FROM activation_codes c LEFT JOIN membership_plan_versions v ON v.id=c.plan_version_id
         WHERE c.code_digest=$1 FOR UPDATE OF c`,
        [codeDigest]
      );
      if (!result.rowCount) throw Object.assign(new Error('激活码格式不正确，请核对后重新输入（不含空格与多余字符）。'), { publicCode: 'activation_code_invalid' });
      const code = result.rows[0];
      failureContext = {
        id: String(code.id), codeMask: code.code_mask, targetTenantId: code.target_tenant_id && String(code.target_tenant_id),
        benefitType: code.benefit_type === 'bean_recharge' ? 'ai_beans' : 'membership',
        beanAmount: code.bean_amount == null ? null : Number(code.bean_amount), planCode: code.plan_code || null, state: code.state,
        valueMinor: Number(code.locked_agent_price_minor), valueCurrency: code.currency || 'CNY'
      };
      // now() is fixed at BEGIN, so take database time after acquiring the code lock.
      const decisionAt = (await client.query('SELECT clock_timestamp() AS decision_at')).rows[0].decision_at;
      if (code.state !== 'issued') throw Object.assign(new Error('该激活码已被使用或已不可用，请换一个再试。'), { publicCode: 'activation_code_unavailable' });
      if (code.expires_at <= decisionAt) throw Object.assign(new Error('该激活码已超过有效期，请向代理商或管理员重新申请。'), { publicCode: 'activation_code_expired' });
      if (code.bound_user_id && (String(code.bound_user_id) !== String(account.userId)
          || code.target_tenant_id && String(code.target_tenant_id) !== String(account.tenantId))) {
        throw Object.assign(new Error('该激活码已绑定其他主账号，不能在当前账号下使用。'), { publicCode: 'activation_code_binding_mismatch' });
      }
      if (['agent', 'agent_delegated'].includes(code.issuance_type) && code.purpose === 'customer') {
        const targetAgent = await client.query('SELECT 1 FROM agents WHERE tenant_id=$1 LIMIT 1', [account.tenantId]);
        if (targetAgent.rowCount) {
          throw Object.assign(new Error('代理商之间不允许相互使用激活码；请联系原发码代理商作废该码。'), { publicCode: 'agent_to_agent_activation_forbidden' });
        }
      }
      if (code.benefit_type === 'bean_recharge') {
        // AI豆充值码唯一核销入口：豆直接入当前客户租户账本，不创建会员周期。
        const redeemAmount = Number(code.bean_amount);
        if (!Number.isSafeInteger(redeemAmount) || redeemAmount < 1) throw Object.assign(new Error('激活码格式不正确，请核对后重新输入（不含空格与多余字符）。'), { publicCode: 'activation_code_invalid' });
        const credited = await mutateOn(client, account.tenantId, {
          eventType: 'recharge', direction: 'credit', amount: redeemAmount,
          idempotencyKey: `bean-redeem:${code.id}`, businessRef: `activation_code:${code.id}`,
          reason: `激活码 ${code.code_mask} 核销充值 ${redeemAmount}豆`,
          actorUserId: account.userId,
          apply: current => ({ balance: current.balance + redeemAmount, frozen: current.frozen })
        });
        const balanceAfter = Number(credited.event.balanceAfter);
        await client.query(
          `UPDATE activation_codes
           SET state='paid',bound_user_id=$2,redeemed_tenant_id=$3,used_at=$4,
               payment_confirmed_at=COALESCE(payment_confirmed_at,$4),updated_at=$4
           WHERE id=$1`,
          [code.id, account.userId, account.tenantId, decisionAt]
        );
        await client.query(
          `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata)
           VALUES($1,$2,$3,'bean_redeemed','issued','paid',$4::jsonb)`,
          [code.tenant_id, code.id, account.userId, JSON.stringify({
            redeemedTenantId: String(account.tenantId), beanAmount: redeemAmount, balanceAfter, beanIdempotencyKey: `bean-redeem:${code.id}`
          })]
        );
        await this.grantAgentReferralPaidCreditForClient(client, {
          inviteeTenantId: account.tenantId, sourceKind: 'bean_recharge', sourceId: code.id, actorUserId: account.userId
        });
        await this.insertUserNotification(client, {
          tenantId: account.tenantId, userId: account.userId, category: 'membership.activation',
          title: 'AI豆充值已到账',
          body: `${code.code_mask} 已核销，${redeemAmount}豆已入账，当前AI豆余额 ${balanceAfter}豆。`,
          resourceType: 'activation_code', resourceId: String(code.id), dedupeKey: `activation:${code.id}:customer`
        });
        if (['agent', 'agent_delegated'].includes(code.issuance_type)) {
          const issuerAgent = await client.query(`SELECT owner_user_id::text FROM agents WHERE tenant_id=$1`, [code.tenant_id]);
          if (issuerAgent.rowCount) {
            await this.insertUserNotification(client, {
              tenantId: code.tenant_id, userId: issuerAgent.rows[0].owner_user_id, category: 'agent.activation',
              title: '客户已使用AI豆充值码',
              body: `${code.code_mask}（${redeemAmount}豆）已被客户核销，豆款已入客户账本。`,
              resourceType: 'activation_code', resourceId: String(code.id), dedupeKey: `activation:${code.id}:agent`
            });
          }
        }
        const response = { membership: null, warning: null, beans: {
          codeMask: code.code_mask, addedBean: redeemAmount, balanceAfter
        } };
        await this.writeAudit(client, account, 'membership.activation.redeem', 'activation_code', String(code.id), 'success', {
          codeMask: code.code_mask, benefitType: 'ai_beans', beanAmount: redeemAmount, previousState: 'issued', nextState: 'paid',
          valueMinor: Number(code.locked_agent_price_minor), valueCurrency: 'CNY', collectionState: 'not_collected',
          idempotencyKeyHash: crypto.createHash('sha256').update(idempotencyKey).digest('hex'), beanEventId: String(credited.event.id || ''), redeemedAt: decisionAt
        });
        const completed = await client.query(
          `UPDATE idempotency_records SET status='completed',response_code=200,response_body=$4::jsonb,updated_at=now()
           WHERE tenant_id=$1 AND namespace='membership-activate' AND idempotency_key=$2 AND request_hash=$3 AND status='processing'`,
          [account.tenantId, idempotencyKey, requestHash, JSON.stringify(response)]
        );
        if (completed.rowCount !== 1) throw new Error('会员激活结果写回失败，本次激活已回滚，请稍后重试。');
        await client.query('COMMIT');
        return { replayed: false, statusCode: 200, response };
      }
      if (code.issuance_type === 'platform_direct') {
        const activated = await this.activateSystemDirectCodeForClient(client, account, code, decisionAt);
        const finalState = code.fulfillment_type === 'gift' ? 'granted' : 'paid';
        await client.query(
          `UPDATE activation_codes SET state=$2,bound_user_id=$3,redeemed_tenant_id=$4,used_at=$5,updated_at=$5 WHERE id=$1`,
          [code.id, finalState, account.userId, account.tenantId, decisionAt]
        );
        await client.query(
          `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata)
           VALUES($1,$2,$3,'activated','issued',$4,$5::jsonb)`,
          [code.tenant_id, code.id, account.userId, finalState, JSON.stringify({
            redeemedTenantId: String(account.tenantId), periodId: String(activated.period.id),
            issuanceType: 'platform_direct', fulfillmentType: code.fulfillment_type
          })]
        );
        if (code.fulfillment_type === 'paid') await this.grantAgentReferralPaidCreditForClient(client, {
          inviteeTenantId: account.tenantId, sourceKind: 'membership', sourceId: activated.period.id, actorUserId: account.userId
        });
        await this.insertUserNotification(client, {
          tenantId: account.tenantId, userId: account.userId, category: 'membership.activation',
          title: code.fulfillment_type === 'gift' ? '赠送会员已激活' : '平台直发会员已激活',
          body: `${code.code_mask} 已激活${code.name}，权益状态为${activated.state === 'active' ? '立即生效' : '排队接续'}。`,
          resourceType: 'activation_code', resourceId: String(code.id), dedupeKey: `activation:${code.id}:customer`
        });
        const membership = {
          state: finalState, codeMask: code.code_mask, startsAt: activated.period.starts_at,
          endsAt: activated.period.ends_at, queueState: activated.state,
          plan: membershipPlan({ ...code, plan_id: code.plan_version_id }), holidayCampaign: activated.holidayCampaign
        };
        const response = { membership, warning: null };
        await this.writeAudit(client, account, 'membership.activation.redeem', 'activation_code', String(code.id), 'success', {
          codeMask: code.code_mask, benefitType: 'membership', planCode: code.plan_code, previousState: 'issued', nextState: finalState,
          valueMinor: Number(code.locked_agent_price_minor), valueCurrency: code.currency, collectionState: 'not_collected',
          idempotencyKeyHash: crypto.createHash('sha256').update(idempotencyKey).digest('hex'), membershipPeriodId: String(activated.period.id), redeemedAt: decisionAt
        });
        const completed = await client.query(
          `UPDATE idempotency_records SET status='completed',response_code=200,response_body=$4::jsonb,updated_at=now()
           WHERE tenant_id=$1 AND namespace='membership-activate' AND idempotency_key=$2 AND request_hash=$3 AND status='processing'`,
          [account.tenantId, idempotencyKey, requestHash, JSON.stringify(response)]
        );
        if (completed.rowCount !== 1) throw new Error('会员激活结果写回失败，本次激活已回滚，请稍后重试。');
        await client.query('COMMIT');
        return { replayed: false, statusCode: 200, response };
      }
      await this.reconcileMembershipPeriodsForClient(client, account.tenantId, decisionAt, account.userId);
      const lowerPeriods = await client.query(
        `SELECT p.id::text,p.ends_at
         FROM membership_periods p
         JOIN membership_plan_versions v ON v.id=p.plan_version_id
         LEFT JOIN activation_codes c ON p.source_type='activation_code' AND p.source_ref=c.id::text
         WHERE p.tenant_id=$1 AND p.state='active' AND v.benefit_rank<$2
           AND p.source_type<>'partner'
           AND NOT (p.source_type='activation_code' AND c.state IN ('used_temporary','payment_review') AND NOT EXISTS (
             SELECT 1 FROM membership_events me
             WHERE me.tenant_id=p.tenant_id AND me.period_id=p.id AND me.event_type='payment_entitlement_confirmed'
           ))
           AND (p.ends_at IS NULL OR p.ends_at>$3)
         ORDER BY v.benefit_rank DESC,p.id FOR UPDATE OF p`,
        [account.tenantId, code.benefit_rank, decisionAt]
      );
      const period = await client.query(
        `INSERT INTO membership_periods
           (tenant_id,plan_version_id,source_type,source_ref,state,starts_at,ends_at,created_by_user_id)
         VALUES($1,$2,'activation_code',$3,'active',$5,$5::timestamptz+interval '72 hours',$4) RETURNING id,starts_at,ends_at`,
        [account.tenantId, code.plan_version_id, String(code.id), account.userId, decisionAt]
      );
      for (const lower of lowerPeriods.rows) {
        const remaining = lower.ends_at
          ? Math.max(0, Math.floor((new Date(lower.ends_at).getTime() - decisionAt.getTime()) / 1000))
          : null;
        if (!remaining) continue;
        await client.query(
          `UPDATE membership_periods SET state='paused',remaining_seconds=$3,updated_at=$4
           WHERE tenant_id=$1 AND id=$2`,
          [account.tenantId, lower.id, remaining, decisionAt]
        );
        await client.query(
          `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,previous_state,next_state,metadata)
           VALUES($1,$2,$3,'membership_entitlement_paused','active','paused',$4::jsonb)`,
          [account.tenantId, lower.id, account.userId, JSON.stringify({
            reason: 'higher_temporary_entitlement', temporaryPeriodId: String(period.rows[0].id)
          })]
        );
      }
      await client.query(
        `UPDATE activation_codes
         SET state='used_temporary',bound_user_id=$2,redeemed_tenant_id=$3,used_at=$4,updated_at=$4
         WHERE id=$1`,
        [code.id, account.userId, account.tenantId, decisionAt]
      );
      await client.query(
        `INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata)
         VALUES($1,$2,$3,'activated','issued','used_temporary',$4::jsonb)`,
        [code.tenant_id, code.id, account.userId, JSON.stringify({ redeemedTenantId: String(account.tenantId), periodId: String(period.rows[0].id) })]
      );
      await client.query(
        `INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,next_state,metadata)
         VALUES($1,$2,$3,'activation_temporary_granted','active',$4::jsonb)`,
        [account.tenantId, period.rows[0].id, account.userId, JSON.stringify({ activationCodeId: String(code.id) })]
      );
      await this.insertUserNotification(client, {
        tenantId: account.tenantId, userId: account.userId, category: 'membership.activation',
        title: '临时会员已激活',
        body: `${code.code_mask} 已激活${code.name}，临时权益有效至付款审核完成或当前临时期限结束。`,
        resourceType: 'activation_code', resourceId: String(code.id), dedupeKey: `activation:${code.id}:customer`
      });
      const issuerAgent = await client.query(`SELECT owner_user_id::text FROM agents WHERE tenant_id=$1`, [code.tenant_id]);
      if (issuerAgent.rowCount) {
        await this.insertUserNotification(client, {
          tenantId: code.tenant_id, userId: issuerAgent.rows[0].owner_user_id, category: 'agent.activation',
          title: '客户已使用激活码',
          body: `${code.code_mask} 已被客户使用，请按付款流程及时完成平台结算。`,
          resourceType: 'activation_code', resourceId: String(code.id), dedupeKey: `activation:${code.id}:agent`
        });
      }
      if (code.issuance_type === 'agent' || code.issuance_type === 'agent_delegated') await this.notifySystemAdministrators(client, {
        codeId: code.id, stage: 'activated-pending-payment', title: '代理商会员激活码待确认付款',
        body: `${code.code_mask} 已被客户激活，当前为72小时临时权益，等待系统管理员确认代理商付款。`
      });
      const membership = {
        state: 'used_temporary', codeMask: code.code_mask, temporaryEndsAt: period.rows[0].ends_at,
        plan: membershipPlan({ ...code, plan_id: code.plan_version_id })
      };
      const response = { membership, warning };
      await this.writeAudit(client, account, 'membership.activation.redeem', 'activation_code', String(code.id), 'success', {
        codeMask: code.code_mask, benefitType: 'membership', planCode: code.plan_code, previousState: 'issued', nextState: 'used_temporary',
        idempotencyKeyHash: crypto.createHash('sha256').update(idempotencyKey).digest('hex'), membershipPeriodId: String(period.rows[0].id), redeemedAt: decisionAt
      });
      const completed = await client.query(
        `UPDATE idempotency_records SET status='completed',response_code=200,response_body=$4::jsonb,updated_at=now()
         WHERE tenant_id=$1 AND namespace='membership-activate' AND idempotency_key=$2 AND request_hash=$3 AND status='processing'`,
        [account.tenantId, idempotencyKey, requestHash, JSON.stringify(response)]
      );
      if (completed.rowCount !== 1) throw new Error('会员激活结果写回失败，本次激活已回滚，请稍后重试。');
      await client.query('COMMIT');
      return { replayed: false, statusCode: 200, response };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (!failureContext) {
        try {
          const found = await this.pool.query(
            `SELECT c.id::text,c.code_mask,c.target_tenant_id::text,c.benefit_type,c.bean_amount,c.state,
                    c.locked_agent_price_minor,v.plan_code,v.currency
             FROM activation_codes c LEFT JOIN membership_plan_versions v ON v.id=c.plan_version_id WHERE c.code_digest=$1`, [codeDigest]
          );
          const code = found.rows[0];
          if (code) failureContext = {
            id: code.id, codeMask: code.code_mask, targetTenantId: code.target_tenant_id,
            benefitType: code.benefit_type === 'bean_recharge' ? 'ai_beans' : 'membership', beanAmount: code.bean_amount == null ? null : Number(code.bean_amount),
            planCode: code.plan_code || null, state: code.state, valueMinor: Number(code.locked_agent_price_minor),
            valueCurrency: code.currency || 'CNY'
          };
        } catch (lookupError) { console.error('读取激活码失败审计上下文失败:', lookupError.message); }
      }
      try {
        await this.writeAudit(this.pool, account, 'membership.activation.redeem', 'activation_code', failureContext?.id || 'unknown', 'failed', {
          attemptedTenantId: String(account.tenantId), targetTenantId: failureContext?.targetTenantId || null,
          codeMask: failureContext?.codeMask || null, benefitType: failureContext?.benefitType || 'unknown',
          beanAmount: failureContext?.beanAmount ?? null, planCode: failureContext?.planCode || null,
          valueMinor: failureContext?.valueMinor ?? null, valueCurrency: failureContext?.valueCurrency || null,
          previousState: failureContext?.state || 'unknown', nextState: failureContext?.state || 'unknown',
          idempotencyKeyHash: crypto.createHash('sha256').update(String(idempotencyKey || '')).digest('hex'),
          errorCode: error.publicCode || 'membership_activation_failed', reason: String(error.message || '激活码兑换失败').slice(0, 500), failedAt: new Date().toISOString()
        });
      } catch (auditError) { throw auditPersistenceError(auditError); }
      throw error;
    } finally { client.release(); }
  }

  async expireUnusedActivationCodes() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `WITH expired AS (
           UPDATE activation_codes SET state='expired',updated_at=clock_timestamp()
           WHERE state='issued' AND expires_at<=now()
           RETURNING tenant_id,id,requested_by_user_id,bound_user_id,issuance_type,code_mask,benefit_type,bean_amount,locked_agent_price_minor
         ), events AS (
           INSERT INTO activation_code_events(tenant_id,activation_code_id,event_type,previous_state,next_state)
           SELECT tenant_id,id,'expired_automatically','issued','expired' FROM expired
           RETURNING activation_code_id
         ), notices AS (
           INSERT INTO user_notifications
             (tenant_id,user_id,category,title,body,resource_type,resource_id,dedupe_key)
           SELECT e.tenant_id,
                  CASE WHEN e.issuance_type='platform_direct' THEN e.bound_user_id ELSE COALESCE(a.owner_user_id,e.requested_by_user_id) END,
                  CASE WHEN e.issuance_type='platform_direct' THEN 'membership.activation' ELSE 'agent.activation' END,
                  '激活码已自动过期',e.code_mask || ' 在24小时内未使用，现已自动作废。',
                  'activation_code',e.id::text,'activation:' || e.id::text || ':expired'
           FROM expired e LEFT JOIN agents a ON a.tenant_id=e.tenant_id
           WHERE CASE WHEN e.issuance_type='platform_direct' THEN e.bound_user_id ELSE COALESCE(a.owner_user_id,e.requested_by_user_id) END IS NOT NULL
           ON CONFLICT (tenant_id,user_id,dedupe_key) DO NOTHING
           RETURNING id
         )
         SELECT tenant_id,id,code_mask,benefit_type,bean_amount,locked_agent_price_minor FROM expired ORDER BY id`
      );
      for (const row of result.rows) {
        await client.query(
          `INSERT INTO audit_events(tenant_id,actor_user_id,action,resource_type,resource_id,result,metadata)
           VALUES($1,NULL,'activation_code.expire','activation_code',$2,'success',$3::jsonb)`,
          [row.tenant_id, String(row.id), JSON.stringify({ codeMask: row.code_mask, benefitType: row.benefit_type === 'bean_recharge' ? 'ai_beans' : 'membership', beanAmount: row.bean_amount == null ? null : Number(row.bean_amount), valueMinor: Number(row.locked_agent_price_minor), valueCurrency: 'CNY', collectionState: 'not_collected', previousState: 'issued', nextState: 'expired' })]
        );
        if (row.benefit_type !== 'bean_recharge') continue;
        await this.reclaimBeanRewardForClient(client, {
          agentTenantId: String(row.tenant_id), codeId: String(row.id), codeMask: row.code_mask,
          actorUserId: null, trigger: 'expired', nextState: 'expired'
        });
      }
      await client.query('COMMIT');
      return Number(result.rowCount) || 0;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }




  async claimIdempotency(account, namespace, key, requestHash, continuationTaskId = '', resource = null) {
    const leasedSkuImageAi = namespace === 'sku_image.ai';
    const expiryColumn = leasedSkuImageAi ? ', expires_at' : '';
    const expiryValue = leasedSkuImageAi ? ", now() + interval '2 minutes'" : '';
    const retryExpiry = leasedSkuImageAi ? '2 minutes' : '7 days';
    const resourceType = typeof resource?.type === 'string' && resource.type.length <= 80 ? resource.type : '';
    const resourceId = typeof resource?.id === 'string' && resource.id.length <= 160 ? resource.id : '';
    const resourceColumns = resourceType && resourceId ? ', resource_type, resource_id' : '';
    const resourceValues = resourceColumns ? ', $5, $6' : '';
    const resourceParams = resourceColumns ? [account.tenantId, namespace, key, requestHash, resourceType, resourceId] : [account.tenantId, namespace, key, requestHash];
    const inserted = await this.pool.query(
      `INSERT INTO idempotency_records (tenant_id, namespace, idempotency_key, request_hash, status${expiryColumn}${resourceColumns})
       VALUES ($1, $2, $3, $4, 'processing'${expiryValue}${resourceValues})
       ON CONFLICT DO NOTHING
       RETURNING status, request_hash, response_code, response_body`,
      resourceParams
    );
    if (inserted.rowCount) return { state: 'claimed' };
    let existing = await this.pool.query(
      `SELECT status, request_hash, response_code, response_body, expires_at
       FROM idempotency_records
       WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3`,
      [account.tenantId, namespace, key]
    );
    const row = existing.rows[0];
    if (!row || row.request_hash !== requestHash) return { state: 'conflict' };
    if (row.status === 'completed') {
      // 异步 SKU 图片任务的 202 不是终态：只允许同一已记录任务号把记录原子地重新认领为轮询中。
      // 其它命名空间不传 continuationTaskId，仍保持普通完成态重放语义。
      if (continuationTaskId && row.response_body?.state === 'pending') {
        if (String(row.response_body.taskId || '') !== String(continuationTaskId)) return { state: 'conflict' };
        existing = await this.pool.query(
          `UPDATE idempotency_records
           SET status = 'processing', updated_at = now(), expires_at = now() + interval '2 minutes'
           WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3 AND request_hash = $4
             AND status = 'completed' AND response_code = 202
             AND response_body->>'state' = 'pending' AND response_body->>'taskId' = $5
           RETURNING status`,
          [account.tenantId, namespace, key, requestHash, String(continuationTaskId)]
        );
        if (existing.rowCount) return { state: 'claimed', continuation: true };
        return { state: 'processing' };
      }
      return { state: 'replay', statusCode: row.response_code, body: row.response_body };
    }
    if (row.status === 'processing' && leasedSkuImageAi && new Date(row.expires_at).getTime() <= Date.now()) {
      const storedTaskId = String(row.response_body?.taskId || '');
      if (!storedTaskId) return { state: 'recovery_required' };
      if (storedTaskId !== String(continuationTaskId || '')) return { state: 'conflict' };
      existing = await this.pool.query(
        `UPDATE idempotency_records
         SET expires_at = now() + interval '2 minutes', updated_at = now()
         WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3 AND request_hash = $4
           AND status = 'processing' AND expires_at <= now() AND response_body->>'taskId' = $5
         RETURNING status`,
        [account.tenantId, namespace, key, requestHash, storedTaskId]
      );
      if (existing.rowCount) return { state: 'claimed', continuation: true, recovered: true };
      return { state: 'processing' };
    }
    if (row.status === 'failed') {
      existing = await this.pool.query(
        `UPDATE idempotency_records
         SET status = 'processing', response_code = NULL, response_body = NULL, updated_at = now(), expires_at = now() + interval '${retryExpiry}'
         WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3 AND request_hash = $4 AND status = 'failed'
         RETURNING status`,
        [account.tenantId, namespace, key, requestHash]
      );
      if (existing.rowCount) return { state: 'claimed' };
    }
    return { state: 'processing' };
  }

  async recordSystemActivationFailure(account, input, error) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    await this.writeAudit(this.pool, account, 'system.activation_code.request', 'activation_code', 'pending', 'failed',
      activationAuditMetadata(input, {
        errorCode: error.publicCode || 'system_activation_code_request_failed',
        reason: String(error.publicReason || error.message || '管理员激活码申请失败').slice(0, 500),
        actorUserId: String(account.userId), previousState: null, nextState: null, failedAt: new Date().toISOString()
      })
    );
  }

  async listSystemActivationCodes(account, filters = {}) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    if (typeof filters === 'string') filters = { targetTenantId: filters };
    const { targetTenantId = '', benefitType = '', status = '', planCode = '', beanAmount = null, page = 1, pageSize = 10 } = filters;
    const params = [];
    const where = ["c.issuance_type='platform_direct'"];
    if (/^\d+$/.test(String(targetTenantId))) { params.push(String(targetTenantId)); where.push(`c.target_tenant_id=$${params.length}`); }
    if (benefitType) { params.push(benefitType === 'ai_beans' ? 'bean_recharge' : benefitType); where.push(`c.benefit_type=$${params.length}`); }
    if (status === 'activated') where.push("c.state NOT IN ('issued','expired','voided')");
    else if (status) { params.push(status); where.push(`c.state=$${params.length}`); }
    if (planCode) { params.push(planCode); where.push(`v.plan_code=$${params.length}`); }
    if (beanAmount != null) { params.push(beanAmount); where.push(`c.bean_amount=$${params.length}`); }
    const condition = where.join(' AND ');
    const count = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM activation_codes c
       LEFT JOIN membership_plan_versions v ON v.id=c.plan_version_id
       WHERE ${condition}`,
      params
    );
    const dataParams = [...params, pageSize, (page - 1) * pageSize];
    const result = await this.pool.query(
      `SELECT c.id::text,c.tenant_id::text AS secret_tenant_id,c.code_digest AS secret_digest,c.code_mask,c.state,c.benefit_type,c.bean_amount,c.requested_at,c.expires_at,c.used_at,c.updated_at,
              c.target_tenant_id::text,c.requested_by_user_id::text,c.bound_user_id::text,c.redeemed_tenant_id::text,
              v.plan_code,v.version_no,v.name AS plan_name,p.id::text AS period_id,p.ends_at AS benefit_expires_at,
              (SELECT e.id::text FROM ai_bean_events e
               WHERE e.tenant_id=c.redeemed_tenant_id AND e.business_ref=('activation_code:' || c.id::text)
                 AND e.event_type='recharge' ORDER BY e.id LIMIT 1) AS bean_event_id,
              t.name AS target_tenant_name,u.username AS target_owner_username
       FROM activation_codes c
       LEFT JOIN membership_plan_versions v ON v.id=c.plan_version_id
       LEFT JOIN membership_periods p ON p.tenant_id=c.target_tenant_id
         AND p.source_type IN ('direct_payment','manual')
         AND p.source_ref=('system-activation-code:' || c.id::text)
       LEFT JOIN tenants t ON t.id=c.target_tenant_id LEFT JOIN users u ON u.id=c.bound_user_id
       WHERE ${condition} ORDER BY c.requested_at DESC,c.id DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`, dataParams
    );
    const items = result.rows.map(row => ({
      id: row.id, applicationId: row.id, codeMask: row.code_mask,
      adminSecretRef: { tenantId: row.secret_tenant_id, digest: row.secret_digest }, targetTenantId: row.target_tenant_id,
      targetTenantName: row.target_tenant_name, targetOwnerUsername: row.target_owner_username,
      benefitType: row.benefit_type === 'bean_recharge' ? 'ai_beans' : 'membership',
      plan: row.benefit_type === 'bean_recharge' ? null : { code: row.plan_code, version: Number(row.version_no), name: row.plan_name },
      beanAmount: row.bean_amount == null ? null : Number(row.bean_amount), requestedAt: row.requested_at,
      expiresAt: row.expires_at,
      benefitExpiresAt: row.benefit_type === 'membership' && row.period_id ? row.benefit_expires_at : null,
      activatedAt: row.used_at, state: row.state,
      businessState: row.state === 'issued' ? '已申请' : row.state === 'expired' ? '已过期' : row.state === 'voided' ? '已作废' : '已激活',
      benefitResult: row.benefit_type === 'bean_recharge'
        ? { beanEventId: row.bean_event_id } : { membershipPeriodId: row.period_id }
    }));
    const total = Number(count.rows[0]?.total || 0);
    return { items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
  }

  async listSystemAgentActivationCodes(account, status = '') {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const values = [];
    let condition = "c.issuance_type IN ('agent','agent_delegated')";
    if (status) {
      values.push(status);
      condition += ` AND CASE WHEN c.state='issued' THEN 'unactivated'
        WHEN c.payment_confirmed_at IS NOT NULL THEN 'confirmed'
        WHEN c.state IN ('used_temporary','payment_review','frozen') THEN 'pending_payment'
        WHEN c.state='expired' THEN 'expired' WHEN c.state='voided' THEN 'voided' ELSE 'other' END=$${values.length}`;
    }
    const result = await this.pool.query(
      `SELECT c.id::text,c.tenant_id::text AS secret_tenant_id,c.code_digest AS secret_digest,c.code_mask,c.state,c.purpose,c.locked_agent_price_minor,c.requested_at,c.expires_at,c.used_at,c.payment_confirmed_at,
              c.benefit_type,c.bean_amount,
              (SELECT e.amount_bean FROM ai_bean_events e WHERE e.tenant_id=c.tenant_id AND e.event_type='agent_reward' AND e.business_ref=('activation_code:'||c.id::text) ORDER BY e.id LIMIT 1) AS reward_bean,
              a.owner_user_id::text AS agent_owner_user_id,au.username AS agent_username,
              c.redeemed_tenant_id::text,cu.username AS customer_username,v.plan_code,v.name AS plan_name,p.ends_at AS benefit_expires_at
       FROM activation_codes c JOIN agents a ON a.tenant_id=c.tenant_id JOIN users au ON au.id=a.owner_user_id
       LEFT JOIN membership_plan_versions v ON v.id=c.plan_version_id
       LEFT JOIN users cu ON cu.id=c.bound_user_id
       LEFT JOIN membership_periods p ON p.tenant_id=c.redeemed_tenant_id AND p.source_type='activation_code' AND p.source_ref=c.id::text
       WHERE ${condition} ORDER BY (c.state IN ('used_temporary','payment_review','frozen') AND c.payment_confirmed_at IS NULL) DESC,c.requested_at DESC,c.id DESC`, values
    );
    return { items: result.rows.map(row => {
      const beanMode = row.benefit_type === 'bean_recharge';
      const businessState = row.state === 'issued' ? '未激活' : row.state === 'expired' ? '已过期' : row.state === 'voided' ? '已作废'
        : beanMode && row.state === 'paid' ? '已核销'
        : row.payment_confirmed_at ? '已确认付款'
        : ['used_temporary', 'payment_review', 'frozen'].includes(row.state) ? '已激活待确认付款' : row.state;
      return {
        id: row.id, codeMask: row.code_mask, adminSecretRef: { tenantId: row.secret_tenant_id, digest: row.secret_digest }, state: row.state, businessState,
        benefitType: beanMode ? 'ai_beans' : 'membership', beanAmount: row.bean_amount == null ? null : Number(row.bean_amount), rewardBean: row.reward_bean == null ? null : Number(row.reward_bean), purpose: row.purpose,
        canConfirmPayment: !beanMode && businessState === '已激活待确认付款',
        agent: { userId: row.agent_owner_user_id, account: row.agent_username },
        customerAccount: row.customer_username || null,
        plan: beanMode ? null : { code: row.plan_code, name: row.plan_name }, lockedAgentPriceMinor: Number(row.locked_agent_price_minor),
        requestedAt: row.requested_at, expiresAt: row.expires_at, activatedAt: row.used_at,
        paymentConfirmedAt: row.payment_confirmed_at, benefitExpiresAt: row.benefit_expires_at
      };
    }) };
  }

  async confirmSystemAgentActivationPayment(account, codeId, input) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const client = await this.pool.connect();
    let code;
    try {
      await client.query('BEGIN');
      const found = await client.query(
        `SELECT c.*,v.plan_code,v.name,v.duration_days,p.id::text AS period_id,p.state AS period_state,p.ends_at AS temporary_ends_at,
                a.owner_user_id::text AS agent_owner_user_id
         FROM activation_codes c JOIN membership_plan_versions v ON v.id=c.plan_version_id JOIN agents a ON a.tenant_id=c.tenant_id
         LEFT JOIN membership_periods p ON p.tenant_id=c.redeemed_tenant_id AND p.source_type='activation_code' AND p.source_ref=c.id::text
         WHERE c.id=$1 AND c.issuance_type IN ('agent','agent_delegated') AND c.benefit_type='membership' FOR UPDATE OF c,a`, [codeId]
      );
      if (!found.rowCount) throw Object.assign(new Error('未找到这笔代理商激活码记录，请刷新列表后重试。'), { publicCode: 'agent_activation_code_not_found' });
      code = found.rows[0];
      if (code.payment_confirmed_at) {
        await client.query('COMMIT');
        return { replayed: true, statusCode: 200, response: { item: { id: String(code.id), codeMask: code.code_mask, state: 'paid', paymentConfirmedAt: code.payment_confirmed_at } } };
      }
      if (!['used_temporary','payment_review','frozen'].includes(code.state)) throw Object.assign(new Error('这笔代理商激活码不是待确认付款状态，无需重复确认。'), { publicCode: 'agent_activation_payment_not_pending' });
      if (!code.period_id) throw Object.assign(new Error('这笔代理商激活码的临时会员记录缺失，请刷新页面后联系系统管理员核对。'), { publicCode: 'agent_activation_period_missing' });
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,'system-agent-activation-payment-confirm',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [code.redeemed_tenant_id, input.idempotencyKey, input.requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(`SELECT status,request_hash,response_code,response_body FROM idempotency_records WHERE tenant_id=$1 AND namespace='system-agent-activation-payment-confirm' AND idempotency_key=$2 FOR UPDATE`, [code.redeemed_tenant_id, input.idempotencyKey]);
        const row = existing.rows[0];
        if (!row || row.request_hash !== input.requestHash) throw Object.assign(new Error('该请求编号已用于其他操作，请刷新页面后重新提交。'), { publicCode: 'idempotency_key_conflict' });
        if (row.status === 'completed') { await client.query('COMMIT'); return { replayed: true, statusCode: row.response_code, response: row.response_body }; }
        throw Object.assign(new Error('相同操作正在处理中，请稍候片刻再查看结果。'), { publicCode: 'idempotency_request_in_progress' });
      }
      const decisionAt = (await client.query('SELECT clock_timestamp() AS value')).rows[0].value;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('membership-first-paid:'||$1,0))", [String(code.redeemed_tenant_id)]);
      const historical = await client.query(
        `SELECT 1 FROM membership_events e JOIN membership_periods p ON p.tenant_id=e.tenant_id AND p.id=e.period_id
         WHERE e.tenant_id=$1 AND e.event_type='payment_entitlement_confirmed' LIMIT 1`, [code.redeemed_tenant_id]
      );
      const rewardBeans = Number((historical.rowCount ? MEMBERSHIP_REWARD_ACTIVITY.renewalBeans : MEMBERSHIP_REWARD_ACTIVITY.firstPaidBeans)[code.plan_code]);
      if (!Number.isSafeInteger(rewardBeans) || rewardBeans < 1) throw new Error('会员赠豆档位配置不正确，请联系系统管理员修正活动方案。');
      const formalEnd = new Date(new Date(decisionAt).getTime() + Number(code.duration_days) * 86400000);
      await client.query(`UPDATE membership_periods SET state='active',starts_at=$3,ends_at=$4,remaining_seconds=NULL,updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [code.redeemed_tenant_id, code.period_id, decisionAt, formalEnd]);
      await client.query(`UPDATE activation_codes SET state='paid',payment_confirmed_at=$2,updated_at=$2 WHERE id=$1`, [code.id, decisionAt]);
      const beans = await mutateOn(client, code.redeemed_tenant_id, {
        eventType: 'membership_reward', direction: 'credit', amount: rewardBeans, idempotencyKey: `membership-reward:${code.id}`,
        businessRef: `activation_code:${code.id}`, reason: `${code.code_mask} ${historical.rowCount ? '后续' : '首开'}正式会员赠送 ${rewardBeans}豆`, actorUserId: account.userId,
        apply: current => ({ balance: current.balance + rewardBeans, frozen: current.frozen })
      });
      await this.insertUserNotification(client, {
        tenantId: code.redeemed_tenant_id, userId: code.bound_user_id, category: 'ai.beans.gift', title: 'AI豆赠送到账',
        body: `${historical.rowCount ? '续费/升级会员' : '首次正式会员'}赠送 ${rewardBeans} AI豆已到账，当前AI豆余额 ${Number(beans.event.balanceAfter)} 豆。`,
        resourceType: 'ai_bean_event', resourceId: String(beans.event.id),
        dedupeKey: `ai-bean:membership-reward:${code.id}:${code.bound_user_id}`
      });
      await client.query(`INSERT INTO membership_events(tenant_id,period_id,actor_user_id,event_type,previous_state,next_state,metadata) VALUES($1,$2,$3,'payment_entitlement_confirmed',$4,'active',$5::jsonb),($1,$2,$3,'membership_reward_granted','active','active',$6::jsonb)`,
        [code.redeemed_tenant_id, code.period_id, account.userId, code.period_state,
          JSON.stringify({ activationCodeId: String(code.id), confirmedAt: decisionAt, temporaryEndsAt: code.temporary_ends_at }),
          JSON.stringify({ activationCodeId: String(code.id), rewardType: historical.rowCount ? 'subsequent' : 'first_paid_lifetime', rewardBeans, beanEventId: String(beans.event.id) })]);
      await this.grantReferralPaidRewardForClient(client, {
        inviteeTenantId: code.redeemed_tenant_id,
        periodId: code.period_id,
        activationCodeId: code.id,
        actorUserId: account.userId
      });
      await this.grantAgentReferralPaidCreditForClient(client, {
        inviteeTenantId: code.redeemed_tenant_id, sourceKind: 'membership', sourceId: code.period_id, actorUserId: account.userId
      });
      await client.query(`INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata) VALUES($1,$2,$3,'payment_confirmed_by_system',$4,'paid',$5::jsonb)`,
        [code.tenant_id, code.id, account.userId, code.state, JSON.stringify({ confirmedAt: decisionAt, rewardBeans, rewardType: historical.rowCount ? 'subsequent' : 'first_paid_lifetime' })]);
      await client.query(`INSERT INTO agent_financial_events(tenant_id,activation_code_id,event_type,account_type,direction,currency,amount_minor,idempotency_key,reason,actor_user_id) VALUES
        ($1,$2,'amount_due','payable','debit','CNY',$3,$4,'代理商会员码应付结算', $5),
        ($1,$2,'payment','payable','credit','CNY',$3,$6,'系统管理员人工确认付款', $5) ON CONFLICT (tenant_id,idempotency_key) DO NOTHING`,
        [code.tenant_id, code.id, code.locked_agent_price_minor, `activation:${code.id}:amount-due`, account.userId, `activation:${code.id}:manual-payment`]);
      const body = `${code.code_mask} 已确认付款，正式${code.name}从确认时间起计算，并已按${historical.rowCount ? '后续' : '首开'}规则赠送${rewardBeans}AI豆。`;
      for (const recipient of [{ tenantId: code.redeemed_tenant_id, userId: code.bound_user_id }, { tenantId: code.tenant_id, userId: code.agent_owner_user_id }]) await this.insertUserNotification(client, {
        ...recipient, category: 'membership.payment', title: '代理商会员付款已确认', body, resourceType: 'activation_code', resourceId: String(code.id), dedupeKey: `activation:${code.id}:payment-confirmed:${recipient.userId}`
      });
      await this.writeAudit(client, { ...account, tenantId: code.redeemed_tenant_id }, 'agent.activation_code.payment_confirm', 'activation_code', String(code.id), 'success', {
        requestId: input.requestId || null, idempotencyKeyHash: crypto.createHash('sha256').update(input.idempotencyKey).digest('hex'), codeMask: code.code_mask,
        planCode: code.plan_code, valueMinor: Number(code.locked_agent_price_minor), valueCurrency: 'CNY', rewardType: historical.rowCount ? 'subsequent' : 'first_paid_lifetime', rewardBeans,
        balanceBefore: beans.event.balanceBefore, balanceAfter: beans.event.balanceAfter, frozenBefore: beans.event.frozenBefore, frozenAfter: beans.event.frozenAfter,
        administratorUserId: String(account.userId), previousState: code.state, nextState: 'paid', stageStatus: 'confirmed', startedAt: decisionAt, completedAt: decisionAt
      });
      const response = { item: { id: String(code.id), codeMask: code.code_mask, state: 'paid', paymentConfirmedAt: decisionAt, benefitExpiresAt: formalEnd, reward: { type: historical.rowCount ? 'subsequent' : 'first_paid_lifetime', beans: rewardBeans, balanceAfter: beans.event.balanceAfter } } };
      const completed = await client.query(`UPDATE idempotency_records SET status='completed',response_code=200,response_body=$4::jsonb,resource_type='activation_code',resource_id=$3,updated_at=now() WHERE tenant_id=$1 AND namespace='system-agent-activation-payment-confirm' AND idempotency_key=$2 AND request_hash=$5 AND status='processing'`, [code.redeemed_tenant_id, input.idempotencyKey, String(code.id), JSON.stringify(response), input.requestHash]);
      if (completed.rowCount !== 1) throw new Error('激活码付款确认结果写回失败，本次确认已回滚，请稍后重试。');
      await client.query('COMMIT'); return { replayed: false, statusCode: 200, response };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      try { await this.writeAudit(this.pool, account, 'agent.activation_code.payment_confirm', 'activation_code', String(codeId), 'failed', { codeMask: code?.code_mask || null, errorCode: error.publicCode || 'agent_activation_payment_confirm_failed', stageStatus: 'failed', administratorUserId: String(account.userId), idempotencyKeyHash: crypto.createHash('sha256').update(String(input.idempotencyKey || '')).digest('hex') }); }
      catch (auditError) { throw auditPersistenceError(auditError); }
      throw error;
    } finally { client.release(); }
  }

  async voidSystemActivationCode(account, codeId, input) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const client = await this.pool.connect();
    let code = null;
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT c.*,v.plan_code FROM activation_codes c LEFT JOIN membership_plan_versions v ON v.id=c.plan_version_id WHERE c.id=$1 AND c.issuance_type='platform_direct' FOR UPDATE OF c`, [codeId]);
      if (!found.rowCount) throw Object.assign(new Error('未找到该激活码，或它不属于当前代理商，请核对激活码编号。'), { publicCode: 'activation_code_not_found' });
      code = found.rows[0];
      const scopeTenantId = String(code.target_tenant_id);
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,'system-activation-code-void',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [scopeTenantId, input.idempotencyKey, input.requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(`SELECT status,request_hash,response_code,response_body FROM idempotency_records WHERE tenant_id=$1 AND namespace='system-activation-code-void' AND idempotency_key=$2 FOR UPDATE`, [scopeTenantId, input.idempotencyKey]);
        const row = existing.rows[0];
        if (!row || row.request_hash !== input.requestHash) throw Object.assign(new Error('该请求编号已用于其他操作，请刷新页面后重新提交。'), { publicCode: 'idempotency_key_conflict' });
        if (row.status === 'completed') { await client.query('COMMIT'); return { replayed: true, statusCode: row.response_code, response: row.response_body }; }
        throw Object.assign(new Error('相同操作正在处理中，请稍候片刻再查看结果。'), { publicCode: 'idempotency_request_in_progress' });
      }
      const decisionAt = (await client.query('SELECT clock_timestamp() AS value')).rows[0].value;
      if (code.state !== 'issued' || code.expires_at <= decisionAt) throw Object.assign(new Error('只有尚未使用的激活码可以作废，已激活或已过期的不能作废。'), { publicCode: 'activation_code_cannot_void' });
      await client.query(`UPDATE activation_codes SET state='voided',updated_at=$2 WHERE id=$1`, [code.id, decisionAt]);
      await client.query(`INSERT INTO activation_code_events(tenant_id,activation_code_id,actor_user_id,event_type,previous_state,next_state,metadata) VALUES($1,$2,$3,'voided_by_system','issued','voided',$4::jsonb)`,
        [code.tenant_id, code.id, account.userId, JSON.stringify(activationAuditMetadata({ ...input, targetTenantId: code.target_tenant_id, benefitType: code.benefit_type, beanAmount: code.bean_amount, planCode: code.plan_code, codeMask: code.code_mask }, { valueMinor: Number(code.locked_agent_price_minor), valueCurrency: 'CNY', collectionState: 'not_collected', previousState: 'issued', nextState: 'voided', changedAt: decisionAt }))]);
      await this.writeAudit(client, { ...account, tenantId: code.target_tenant_id }, 'system.activation_code.void', 'activation_code', String(code.id), 'success', activationAuditMetadata({ ...input, targetTenantId: code.target_tenant_id, benefitType: code.benefit_type, beanAmount: code.bean_amount, planCode: code.plan_code, codeMask: code.code_mask }, { valueMinor: Number(code.locked_agent_price_minor), valueCurrency: 'CNY', collectionState: 'not_collected', previousState: 'issued', nextState: 'voided', changedAt: decisionAt }));
      const response = { item: { id: String(code.id), codeMask: code.code_mask, state: 'voided', businessState: '已作废', voidedAt: decisionAt } };
      await client.query(`UPDATE idempotency_records SET status='completed',response_code=200,response_body=$4::jsonb,resource_type='activation_code',resource_id=$3,updated_at=now() WHERE tenant_id=$1 AND namespace='system-activation-code-void' AND idempotency_key=$2 AND request_hash=$5 AND status='processing'`, [scopeTenantId, input.idempotencyKey, String(code.id), JSON.stringify(response), input.requestHash]);
      await client.query('COMMIT'); return { replayed: false, statusCode: 200, response };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      try {
        await this.writeAudit(this.pool, account, 'system.activation_code.void', 'activation_code', String(codeId), 'failed', activationAuditMetadata({
          ...input, targetTenantId: code?.target_tenant_id, benefitType: code?.benefit_type, beanAmount: code?.bean_amount,
          planCode: code?.plan_code, codeMask: code?.code_mask
        }, { errorCode: error.publicCode || 'system_activation_code_void_failed', reason: String(error.message || '管理员作废激活码失败').slice(0, 500), previousState: code?.state || 'unknown', nextState: code?.state || 'unknown' }));
      } catch (auditError) { throw auditPersistenceError(auditError); }
      throw error;
    } finally { client.release(); }
  }

  skuRedrawAttemptResourceId(account, input) {
    return crypto.createHash('sha256').update(JSON.stringify({
      v: 1, actorUserId: String(account.userId), clientId: String(input.clientId), productId: String(input.productId),
      variantRef: String(input.variantRef)
    })).digest('hex');
  }

  async claimSkuRedrawSellingPointsAttempt(account, key, requestHash, input) {
    return this.claimIdempotency(account, 'sku_redraw.selling_points', key, requestHash, '', {
      type: 'sku_redraw_attempt', id: this.skuRedrawAttemptResourceId(account, input)
    });
  }

  async getSkuRedrawSellingPointsAttempt(account, input) {
    const resourceId = this.skuRedrawAttemptResourceId(account, input);
    const result = await this.pool.query(
      `SELECT idempotency_key,status,response_code,response_body,created_at,updated_at
       FROM idempotency_records
       WHERE tenant_id=$1 AND namespace='sku_redraw.selling_points'
         AND resource_type='sku_redraw_attempt' AND resource_id=$2
         AND ($3::text IS NULL OR idempotency_key=$3)
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      [account.tenantId, resourceId, input.attemptKey || null]
    );
    return result.rowCount ? result.rows[0] : null;
  }

  async completeIdempotency(account, namespace, key, statusCode, body) {
    const pendingLease = namespace === 'sku_image.ai' && Number(statusCode) === 202 && body?.state === 'pending';
    const completionExpiry = pendingLease ? '2 minutes' : '7 days';
    await this.pool.query(
      `UPDATE idempotency_records
       SET status = 'completed', response_code = $4, response_body = $5::jsonb, updated_at = now(), expires_at = now() + interval '${completionExpiry}'
       WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3 AND status = 'processing'`,
      [account.tenantId, namespace, key, statusCode, JSON.stringify(body == null ? null : body)]
    );
  }

  // 供应商已返回异步任务号但尚未写入 202 响应时先持久化检查点；崩溃恢复只能轮询该任务，绝不盲目重提。
  async checkpointIdempotency(account, namespace, key, body) {
    await this.pool.query(
      `UPDATE idempotency_records
       SET response_body = $4::jsonb, updated_at = now(), expires_at = now() + interval '2 minutes'
       WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3 AND status = 'processing'`,
      [account.tenantId, namespace, key, JSON.stringify(body == null ? null : body)]
    );
  }

  async failIdempotency(account, namespace, key) {
    await this.pool.query(
      `UPDATE idempotency_records SET status = 'failed', updated_at = now()
       WHERE tenant_id = $1 AND namespace = $2 AND idempotency_key = $3 AND status = 'processing'`,
      [account.tenantId, namespace, key]
    );
  }

  hasPermission(account, permission) {
    return Boolean(account && (account.isSystemAdmin || account.memberType === 'owner' || account.permissions.includes('*') || account.permissions.includes(permission)));
  }

  async ensureSystemAdminTenantMembership(_clientOrPool, _account) {
    // 唯一 admin 仅保留系统管理租户的 owner 关系；跨租户操作不创建客户成员。
  }

  async systemAdminHomeAccount() {
    const result = await this.pool.query(
      `SELECT u.id::text AS user_id,u.username,u.status AS user_status,u.is_system_admin,
              tm.tenant_id::text AS tenant_id,tm.member_type,tm.status AS member_status,
              tm.display_name,tm.shop_scope_mode,t.name AS tenant_name,t.status AS tenant_status
       FROM users u JOIN tenant_members tm ON tm.user_id=u.id
       JOIN tenants t ON t.id=tm.tenant_id
       WHERE lower(u.username)='admin'
       ORDER BY tm.created_at,tm.tenant_id
       LIMIT 2`
    );
    const row = result.rows[0];
    const valid = result.rowCount === 1 && row && row.user_status === 'active' && row.is_system_admin === true
      && row.member_type === 'owner' && row.member_status === 'active' && row.shop_scope_mode === 'all'
      && row.tenant_name === '系统管理' && row.tenant_status === 'active';
    if (!valid) throw Object.assign(new Error('系统管理员主账号配置不唯一，请检查唯一 admin 与系统管理租户。'), { publicCode: 'system_admin_home_invalid' });
    return { userId: row.user_id, tenantId: row.tenant_id, username: row.username, displayName: row.display_name || row.username, memberType: 'owner', isSystemAdmin: true, shopScopeMode: 'all', permissions: ['*'] };
  }

  async getRelationalDocument(account, key) {
    const versionResult = await this.pool.query(
      `SELECT version, payload_shape, updated_at FROM business_data_versions WHERE tenant_id = $1 AND document_key = $2`,
      [account.tenantId, key]
    );
    if (!versionResult.rowCount) return null;
    const version = versionResult.rows[0];
    let payload;
    if (key === 'erp_orders_data') {
      const result = await this.pool.query(`SELECT record_key, payload FROM business_orders WHERE tenant_id = $1 ORDER BY position, record_key`, [account.tenantId]);
      payload = result.rows.map(row => deriveSystemOrderReasonMappings(row.payload));
    } else if (key === 'erp_online_products') {
      const result = await this.pool.query(`SELECT record_key, payload FROM business_products WHERE tenant_id = $1 ORDER BY position, record_key`, [account.tenantId]);
      payload = result.rows.map(row => row.payload);
    } else if (FINANCIAL_RECORD_KEYS.has(key)) {
      const result = await this.pool.query(`SELECT record_key, payload FROM financial_records WHERE tenant_id = $1 AND document_key = $2 ORDER BY position, record_key`, [account.tenantId, key]);
      payload = payloadFromRows(version.payload_shape, result.rows);
    } else if (FINANCE_SETTING_KEYS.has(key)) {
      const result = await this.pool.query(`SELECT value AS payload FROM finance_settings WHERE tenant_id = $1 AND setting_key = $2`, [account.tenantId, key]);
      payload = result.rowCount ? result.rows[0].payload : null;
    } else if (key === 'erp_bug_reports') {
      const unrestricted = Boolean(account.isSystemAdmin || account.memberType === 'owner');
      const result = await this.pool.query(
        `SELECT br.report_id, br.payload, br.created_at, u.username,
                COALESCE((SELECT jsonb_agg(jsonb_build_object(
                  'id', ba.attachment_id::text, 'name', ba.original_name, 'type', ba.media_type, 'size', ba.size_bytes,
                  'url', '/api/bug-attachments/' || br.report_id || '/' || ba.stored_name
                ) ORDER BY ba.created_at, ba.attachment_id) FROM bug_attachments ba
                WHERE ba.tenant_id = br.tenant_id AND ba.report_id = br.report_id), '[]'::jsonb) AS attachments
         FROM bug_reports br JOIN users u ON u.id = br.created_by_user_id
         WHERE br.tenant_id = $1 AND ($2::boolean OR br.created_by_user_id = $3)
         ORDER BY br.created_at DESC, br.report_id`,
        [account.tenantId, unrestricted, account.userId]
      );
      payload = result.rows.map(row => ({ ...row.payload, id: row.report_id, createdBy: row.username, createdAt: row.created_at, attachments: row.attachments }));
    }
    return { payload, version: Number(version.version), updatedAt: version.updated_at };
  }

  async editableProductLegacyNames(account, target) {
    const productShops = require('../assets/product-shops');
    const document = await this.getDocument(account, 'erp_shops_data');
    const shops = productShops.list(document && document.payload);
    const shop = productShops.resolve(shops, { clientId: target.clientId });
    if (!shop) return [];
    return [...new Set([shop.name, shop.shopName, target.clientId].filter(Boolean).map(String))]
      .filter(name => productShops.resolve(shops, { shop: name }) === shop);
  }

  async getEditableProduct(account, target) {
    const { revision, problem } = require('./product-edit');
    const allowedShops = await this.listAllowedShops(account);
    if (allowedShops !== null && !allowedShops.some(shop => String(shop.externalShopId) === String(target.clientId))) {
      throw problem('shop_scope_denied', '当前账号没有该店铺权限', 403);
    }
    const legacyNames = await this.editableProductLegacyNames(account, target);
    const result = await this.pool.query(
      `SELECT payload FROM business_products WHERE tenant_id=$1
       AND (shop_external_id=$2 OR (COALESCE(shop_external_id,'')=''
         AND COALESCE(payload->>'clientId','')='' AND COALESCE(payload->>'externalShopId','')=''
         AND COALESCE(payload->>'shopId','')='' AND payload->>'shop'=ANY($4::text[])))
       AND COALESCE(payload->>'id', payload->>'productId')=$3`,
      [account.tenantId, target.clientId, target.productId, legacyNames]);
    if (result.rowCount !== 1) throw problem('product_not_found', '未找到当前店铺的商品', 404);
    return { item: result.rows[0].payload, revision: revision(result.rows[0].payload) };
  }

  async mutateEditableProduct(account, target, expectedRevision, transform, options = {}) {
    const { revision, problem } = require('./product-edit');
    const legacyNames = await this.editableProductLegacyNames(account, target);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      // Same lock order as existing collection writers; never delete omitted rows.
      await client.query(`SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_online_products' FOR UPDATE`, [account.tenantId]);
      const result = await client.query(
        `SELECT record_key, payload FROM business_products WHERE tenant_id=$1
         AND (shop_external_id=$2 OR (COALESCE(shop_external_id,'')=''
           AND COALESCE(payload->>'clientId','')='' AND COALESCE(payload->>'externalShopId','')=''
           AND COALESCE(payload->>'shopId','')='' AND payload->>'shop'=ANY($4::text[])))
         AND COALESCE(payload->>'id', payload->>'productId')=$3 FOR UPDATE`, [account.tenantId, target.clientId, target.productId, legacyNames]);
      if (result.rowCount !== 1) throw problem('product_not_found', '未找到当前店铺的商品', 404);
      const row = result.rows[0];
      if (expectedRevision !== null && expectedRevision !== revision(row.payload)) throw problem('product_version_conflict', '商品已被其他操作修改，请重新打开后编辑', 409);
      let combinationUpdate = null;
      if (options.combinationReplacement && Array.isArray(options.combinationReplacement.parentRefs) && options.combinationReplacement.parentRefs.length) {
        const combinationStore = require('./product-combination-store');
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('product-combination:'||$1,0))", [String(account.tenantId)]);
        const currentCombination = await client.query(`SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2 FOR UPDATE`, [account.tenantId, combinationStore.DOCUMENT_KEY]);
        const payload = currentCombination.rowCount ? currentCombination.rows[0].payload : null;
        combinationUpdate = combinationStore.buildReplacement(payload, options.combinationReplacement.parentRefs, options.combinationReplacement.relations || [], account, options.combinationReplacement.source || '商品编辑');
        if (Array.isArray(options.combinationReplacement.aliases) && options.combinationReplacement.aliases.length) {
          const aliasUpdate = combinationStore.replaceAliases(combinationUpdate.payload, options.combinationReplacement.aliases);
          combinationUpdate.payload = aliasUpdate.payload;
          combinationUpdate.aliasChanged = aliasUpdate.changed;
        }
      }
      const next = { ...transform(row.payload), clientId: target.clientId };
      const saved = await client.query(
        `UPDATE business_products SET shop_external_id=$2, payload=$4::jsonb, offer_id=$5, updated_by_user_id=$6, updated_at=now()
         WHERE tenant_id=$1 AND record_key=$3 RETURNING payload`,
        [account.tenantId, target.clientId, row.record_key, JSON.stringify(next), String(next.offer_id || next.article || ''), account.userId]);
      if (!options.draftOnly) await client.query(
        `INSERT INTO product_costs (tenant_id, product_record_key, purchase_amount, source_amount, domestic_shipping_amount, supplier_url, supplier_note, updated_by_user_id)
         VALUES ($1,$2,$3::numeric,$4::numeric,$5::numeric,$6,$7,$8)
         ON CONFLICT (tenant_id, product_record_key) DO UPDATE SET purchase_amount=EXCLUDED.purchase_amount,
         source_amount=EXCLUDED.source_amount, domestic_shipping_amount=EXCLUDED.domestic_shipping_amount,
         supplier_url=EXCLUDED.supplier_url, supplier_note=EXCLUDED.supplier_note, updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`,
        [account.tenantId, row.record_key, nullableAmount(next.purchasePrice), nullableAmount(next.srcPrice), nullableAmount(next.domesticShipping), next.srcUrl || null, next.srcNote || null, account.userId]);
      if (combinationUpdate && (combinationUpdate.events.length || combinationUpdate.aliasChanged)) await client.query(
        `INSERT INTO tenant_documents(tenant_id,document_key,payload,updated_by_user_id)
         VALUES($1,$2,$3::jsonb,$4)
         ON CONFLICT(tenant_id,document_key) DO UPDATE SET payload=EXCLUDED.payload,version=tenant_documents.version+1,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
        [account.tenantId, require('./product-combination-store').DOCUMENT_KEY, JSON.stringify(combinationUpdate.payload), account.userId]
      );
      await client.query(`UPDATE business_data_versions SET version=version+1, updated_by_user_id=$2, updated_at=now() WHERE tenant_id=$1 AND document_key='erp_online_products'`, [account.tenantId, account.userId]);
      await this.writeAudit(client, account, options.draftOnly ? 'product.draft' : 'product.edit', 'product', row.record_key, next.ozonEdit && next.ozonEdit.phase === 'failed' ? 'failed' : 'success', { phase: options.draftOnly ? 'draft' : next.ozonEdit && next.ozonEdit.phase || 'local', failureCode: next.ozonEdit && next.ozonEdit.failureCode || '', failureReason: next.ozonEdit && next.ozonEdit.phase === 'failed' ? String(next.ozonEdit.message || '').slice(0, 500) : '' });
      if (next.ozonEdit && next.ozonEdit.queueId && JSON.stringify(next.ozonEdit) !== JSON.stringify(row.payload.ozonEdit)) {
        await this.upsertSyncTask({ ...account, userId: next.ozonEdit.actorUserId, username: next.ozonEdit.actorUsername }, require('./product-edit').queueTask(next), client);
      }
      await client.query('COMMIT');
      return { item: saved.rows[0].payload, revision: revision(saved.rows[0].payload) };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async listProductListingRecords(account) {
    const create = require('./product-create');
    const document = await this.getDocument(account, create.LISTING_RECORD_KEY);
    // 上架记录只承认“新增商品提交”链路生成的记录；历史或异常来源即使误入内部文档也不对业务页面暴露。
    let rows = Array.isArray(document && document.payload)
      ? document.payload.filter(row => row && row.source === 'product_create_submit').map(row => ({ ...row })) : [];
    const allowed = await this.listAllowedShops(account);
    if (allowed !== null) {
      const allowedIds = new Set(allowed.map(shop => String(shop.externalShopId || '')));
      rows = rows.filter(row => allowedIds.has(String(row && row.clientId || '')));
    }
    const identities = await this.displayIdentitiesByUserId(account.tenantId, rows.map(row => row && row.actorUserId));
    rows = rows.map(row => {
      const identity = identities[String(row && row.actorUserId || '')] || {};
      return {
        ...row,
        actorProfileFullName: String(identity.profileFullName || ''),
        actorEmail: String(identity.email || ''),
        actorIsSystemAdmin: identity.isSystemAdmin === true
      };
    });
    return rows.sort((left, right) => (Date.parse(right && (right.submittedAt || right.updatedAt) || '') || 0) - (Date.parse(left && (left.submittedAt || left.updatedAt) || '') || 0));
  }

  async syncProductListingRecordsForCreate(client, account, before, next) {
    const create = require('./product-create');
    const previousState = before && before.ozonCreate;
    const nextState = next && next.ozonCreate;
    if (!nextState || !nextState.queueId || JSON.stringify(previousState) === JSON.stringify(nextState)) return;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('product-listing-records:'||$1,0))", [String(account.tenantId)]);
    const current = await client.query(
      `SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2 FOR UPDATE`,
      [account.tenantId, create.LISTING_RECORD_KEY]
    );
    const shop = await client.query(
      `SELECT name FROM shops WHERE tenant_id=$1 AND external_shop_id=$2 LIMIT 1`,
      [account.tenantId, String(nextState.clientId || next.shop || '')]
    );
    const existingRaw = current.rowCount && Array.isArray(current.rows[0].payload) ? current.rows[0].payload : [];
    // 合法的新增商品状态推进同时清理历史异常来源，确保内部文档也只保留新增商品提交记录。
    const existing = existingRaw.filter(row => row && row.source === 'product_create_submit');
    const merged = create.mergeListingRecords(existing, before, next, shop.rows[0] && shop.rows[0].name);
    if (JSON.stringify(existing) === JSON.stringify(merged)) return;
    await client.query(
      `INSERT INTO tenant_documents(tenant_id,document_key,payload,updated_by_user_id)
       VALUES($1,$2,$3::jsonb,$4)
       ON CONFLICT(tenant_id,document_key) DO UPDATE SET
         payload=EXCLUDED.payload,version=tenant_documents.version+1,
         updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
      [account.tenantId, create.LISTING_RECORD_KEY, JSON.stringify(merged), nextState.actorUserId || account.userId]
    );
  }

  async syncConfirmedProductsForCreate(client, account, draft, products) {
    if (!Array.isArray(products) || !products.length) return { count: 0 };
    const clientId = String(draft && draft.ozonCreate && draft.ozonCreate.clientId || draft && draft.shop || '').trim();
    if (!clientId) throw Object.assign(new Error('新增商品缺少店铺编号，无法写入在线商品列表。'), { publicCode: 'product_create_shop_missing' });
    const shop = await client.query('SELECT name FROM shops WHERE tenant_id=$1 AND external_shop_id=$2 LIMIT 1', [account.tenantId, clientId]);
    const shopName = String(shop.rows[0] && shop.rows[0].name || clientId);
    await client.query(
      `INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id)
       VALUES ($1,'erp_online_products',1,'array',$2) ON CONFLICT (tenant_id,document_key) DO NOTHING`,
      [account.tenantId, account.userId]
    );
    await client.query(`SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_online_products' FOR UPDATE`, [account.tenantId]);
    const existingPosition = await client.query(`SELECT COALESCE(MAX(position),-1)::int AS max_position FROM business_products WHERE tenant_id=$1`, [account.tenantId]);
    let nextPosition = Number(existingPosition.rows[0] && existingPosition.rows[0].max_position || -1) + 1;
    const allowedHosts = supplierHosts(process.env.ERP_SUPPLIER_HOST_ALLOWLIST);
    const prepared = products.map(item => ({ ...item, clientId, shop: shopName }));
    const normalized = rowsForPayload('erp_online_products', normalizePlatformPayload('erp_online_products', prepared, allowedHosts));
    for (const row of normalized.rows) {
      const item = row.payload || {};
      const productId = String(item.id || item.productId || '').trim();
      if (!/^\d+$/.test(productId)) continue;
      const recordKey = clientId + '::' + productId;
      const current = await client.query(
        `SELECT position,payload FROM business_products WHERE tenant_id=$1 AND record_key=$2 FOR UPDATE`,
        [account.tenantId, recordKey]
      );
      const position = current.rowCount ? Number(current.rows[0].position) : nextPosition++;
      const currentPayload = current.rowCount && current.rows[0].payload && typeof current.rows[0].payload === 'object' ? current.rows[0].payload : {};
      const merged = { ...currentPayload, ...item, clientId, shop: shopName };
      if (currentPayload.ozonEdit) merged.ozonEdit = currentPayload.ozonEdit;
      if (currentPayload.editorDraft) merged.editorDraft = currentPayload.editorDraft;
      merged._manual = {
        ...(currentPayload._manual || {}),
        ...(item._manual || {}),
        purchasePrice: true, srcPrice: true, domesticShipping: true, srcUrl: true, srcNote: true,
        collectionId: true, erpVariantRef: true, sourceBundleIds: true, sourceBundles: true,
        combinationRelations: true, combinationHistory: true, manualVariantAttributes: true, suppressedVariantAttributes: true
      };
      await client.query(
        `INSERT INTO business_products
           (tenant_id,record_key,position,offer_id,shop_external_id,platform_source,platform_record_id,payload,updated_by_user_id)
         VALUES ($1,$2,$3,$4,$5,'ozon',$6,$7::jsonb,$8)
         ON CONFLICT (tenant_id,record_key) DO UPDATE SET
           offer_id=EXCLUDED.offer_id,shop_external_id=EXCLUDED.shop_external_id,platform_source='ozon',
           platform_record_id=EXCLUDED.platform_record_id,payload=EXCLUDED.payload,
           updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
        [account.tenantId, recordKey, position,
          String(merged.offer_id || merged.article || '').slice(0, 180) || null,
          clientId, String(merged.platformRecordId || recordKey), JSON.stringify(merged), account.userId]
      );
      await client.query(
        `INSERT INTO product_costs
           (tenant_id,product_record_key,purchase_amount,source_amount,domestic_shipping_amount,supplier_url,supplier_note,updated_by_user_id)
         VALUES ($1,$2,$3::numeric,$4::numeric,$5::numeric,$6,$7,$8)
         ON CONFLICT (tenant_id,product_record_key) DO UPDATE SET
           purchase_amount=EXCLUDED.purchase_amount,source_amount=EXCLUDED.source_amount,
           domestic_shipping_amount=EXCLUDED.domestic_shipping_amount,supplier_url=EXCLUDED.supplier_url,
           supplier_note=EXCLUDED.supplier_note,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
        [account.tenantId, recordKey, nullableAmount(merged.purchasePrice), nullableAmount(merged.srcPrice), nullableAmount(merged.domesticShipping),
          String(merged.srcUrl || merged.sourceUrl || '') || null, String(merged.srcNote || '').slice(0, 1000) || null, account.userId]
      );
    }
    const saved = await client.query(
      `UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now()
       WHERE tenant_id=$1 AND document_key='erp_online_products' RETURNING version,updated_at`,
      [account.tenantId, account.userId]
    );
    await this.writeAudit(client, account, 'product.create.online.confirmed', 'product_draft', String(draft && draft.draftId || ''), 'success', { count: normalized.rows.length });
    return { count: normalized.rows.length, version: Number(saved.rows[0] && saved.rows[0].version || 0), updatedAt: saved.rows[0] && saved.rows[0].updated_at || null };
  }

  async markRelistSourceConfirmed(client, account, draft, products) {
    const create = require('./product-create');
    const productRecords = require('../assets/product-records');
    const source = create.normalizeRelistSource(draft && draft.relistSource);
    if (!source || !draft.ozonCreate || draft.ozonCreate.phase !== 'confirmed') return { changed: false };
    const result = await client.query(
      `SELECT record_key,payload FROM business_products WHERE tenant_id=$1
       AND (shop_external_id=$2 OR payload->>'clientId'=$2 OR payload->>'externalShopId'=$2 OR payload->>'shopId'=$2)
       AND COALESCE(payload->>'id',payload->>'productId')=$3 FOR UPDATE`,
      [account.tenantId, source.clientId, source.productId]
    );
    if (result.rowCount !== 1) throw create.problem('relist_source_not_found', '原下架商品已不存在或店铺归属发生变化，无法确认重新上架结果', 409);
    const row = result.rows[0], current = row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (current.relistedAt) {
      if (String(current.relistDraftId || '') === String(draft.draftId || '')) return { changed: false };
      throw create.problem('product_already_relisted', '原下架商品已经被另一重上任务处理，请刷新页面核对', 409);
    }
    if (!productRecords.isDelisted(productRecords.normalize(current))) throw create.problem('relist_source_not_delisted', '原商品已不再处于可重上的已下架状态，请刷新页面核对', 409);
    const confirmedAt = String(draft.ozonCreate.updatedAt || new Date().toISOString());
    const next = {
      ...current, relistedAt: confirmedAt, relistDraftId: String(draft.draftId || ''),
      relistedProductIds: (products || []).map(item => Number(item && (item.id || item.productId))).filter(Number.isSafeInteger),
      relistedOfferIds: (products || []).map(item => String(item && (item.offerId || item.offer_id || item.article) || '')).filter(Boolean),
      relistedSkus: (products || []).map(item => String(item && item.sku || '')).filter(Boolean)
    };
    await client.query(
      `UPDATE business_products SET payload=$4::jsonb,updated_by_user_id=$5,updated_at=now()
       WHERE tenant_id=$1 AND record_key=$2 AND COALESCE(payload->>'id',payload->>'productId')=$3`,
      [account.tenantId, row.record_key, source.productId, JSON.stringify(next), account.userId]
    );
    await this.writeAudit(client, account, 'product.relist.confirmed', 'product', row.record_key, 'success', {
      sourceProductId: source.productId, newProductIds: next.relistedProductIds, draftId: next.relistDraftId
    });
    return { changed: true, relistedAt: confirmedAt };
  }

  async getProductCreateDraftDocument(account) {
    const create = require('./product-create');
    const combinationStore = require('./product-combination-store');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      const current = await client.query(
        `SELECT payload,version,updated_at FROM tenant_documents
          WHERE tenant_id=$1 AND document_key=$2 FOR UPDATE`,
        [account.tenantId, create.DRAFT_KEY]
      );
      if (!current.rowCount) {
        await client.query('COMMIT');
        return { payload: [], version: 0, updatedAt: null, removedDraftIds: [] };
      }
      const graphResult = await client.query(
        `SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2`,
        [account.tenantId, combinationStore.DOCUMENT_KEY]
      );
      const graphPayload = graphResult.rowCount ? graphResult.rows[0].payload : null;
      const existing = Array.isArray(current.rows[0].payload) ? current.rows[0].payload : [];
      const retained = create.pruneDrafts(existing, account.userId, graphPayload, Date.now());
      const changed = JSON.stringify(existing) !== JSON.stringify(retained.drafts);
      let version = Number(current.rows[0].version), updatedAt = current.rows[0].updated_at;
      if (changed) {
        const saved = await client.query(
          `UPDATE tenant_documents
              SET payload=$3::jsonb,version=version+1,updated_by_user_id=$4,updated_at=now()
            WHERE tenant_id=$1 AND document_key=$2
            RETURNING version,updated_at`,
          [account.tenantId, create.DRAFT_KEY, JSON.stringify(retained.drafts), account.userId]
        );
        version = Number(saved.rows[0].version);
        updatedAt = saved.rows[0].updated_at;
        if (retained.removedIds.length) {
          await this.writeAudit(client, account, 'product.draft.retention_cleanup', 'tenant_document', create.DRAFT_KEY, 'success', {
            removedDraftIds: retained.removedIds,
            retentionHours: create.DRAFT_RETENTION_MS / 3600000
          });
        }
      }
      await client.query('COMMIT');
      return {
        payload: create.visibleDrafts(retained.drafts, account.userId),
        version,
        updatedAt,
        removedDraftIds: retained.removedIds
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async getProductCreateDraft(account, draftId) {
    const create = require('./product-create');
    const document = await this.getProductCreateDraftDocument(account);
    const item = Array.isArray(document && document.payload)
      ? document.payload.find(draft => draft && String(draft.draftId) === String(draftId) && draft.mode === 'create') : null;
    if (!item) throw create.problem('product_draft_not_found', '没有找到当前账号的新增商品草稿，草稿可能已过期清理。', 404);
    return { item, revision: create.revision(item) };
  }

  async mutateProductCreateDraft(account, draftId, expectedRevision, transform, options = {}) {
    const create = require('./product-create');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      const current = await client.query(
        `SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2 FOR UPDATE`,
        [account.tenantId, create.DRAFT_KEY]
      );
      const drafts = current.rowCount && Array.isArray(current.rows[0].payload) ? current.rows[0].payload : [];
      const index = drafts.findIndex(draft => draft && String(draft.draftId) === String(draftId) && draft.mode === 'create');
      if (index < 0) throw create.problem('product_draft_not_found', '没有找到当前新增商品草稿', 404);
      const before = drafts[index];
      if (Number(before.ownerUserId) !== Number(account.userId)) {
        throw create.problem('product_draft_not_found', '没有找到当前账号的新增商品草稿', 404);
      }
      if (options.enforceRelistExclusive && before.relistSource) {
        const source = create.normalizeRelistSource(before.relistSource);
        const conflict = drafts.some((draft, offset) => {
          if (offset === index || !draft || !draft.relistSource) return false;
          let other;
          try { other = create.normalizeRelistSource(draft.relistSource); } catch (_) { return false; }
          if (!other || other.clientId !== source.clientId || other.productId !== source.productId) return false;
          return create.active(draft.ozonCreate) || draft.ozonCreate && draft.ozonCreate.phase === 'confirmed';
        });
        if (conflict) throw create.problem('product_relist_pending', '该下架商品已有重新上架任务，不能重复提交', 409);
      }
      if (expectedRevision !== null && expectedRevision !== create.revision(before)) {
        throw create.problem('product_draft_version_conflict', '新增草稿已被其他操作修改，请重新打开后提交', 409);
      }
      const next = await transform(JSON.parse(JSON.stringify(before)));
      if (!next || next.mode !== 'create' || String(next.draftId) !== String(draftId)) {
        throw create.problem('invalid_product_draft', '新增任务不能更换草稿编号或模式');
      }
      await this.updateProductCreateQuota(client, account, before, next);
      await this.syncProductListingRecordsForCreate(client, account, before, next);
      if (Array.isArray(options.confirmedProducts) && options.confirmedProducts.length) {
        await this.syncConfirmedProductsForCreate(client, account, next, options.confirmedProducts);
        if (next.ozonCreate && next.ozonCreate.phase === 'confirmed' && next.relistSource) await this.markRelistSourceConfirmed(client, account, next, options.confirmedProducts);
      }
      const changed = drafts.slice(); changed[index] = next;
      const combinationStore = require('./product-combination-store');
      const combinationDocument = await client.query(
        `SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2`,
        [account.tenantId, combinationStore.DOCUMENT_KEY]
      );
      // This mutation is the server-authoritative create-state writer. Passing the
      // pre-mutation list as `existing` would intentionally restore its old
      // ozonCreate value and silently discard the transition we just made.
      const limited = create.limitDrafts(changed, changed, account.userId, {
        combinationPayload: combinationDocument.rowCount ? combinationDocument.rows[0].payload : null
      });
      const saved = await client.query(
        `UPDATE tenant_documents SET payload=$3::jsonb, version=version+1, updated_by_user_id=$4, updated_at=now()
         WHERE tenant_id=$1 AND document_key=$2 RETURNING version, updated_at`,
        [account.tenantId, create.DRAFT_KEY, JSON.stringify(limited), account.userId]
      );
      if (!saved.rowCount) throw create.problem('product_draft_not_found', '新增草稿服务器副本不存在', 404);
      await this.writeAudit(client, account, 'product.create.state', 'product_draft', String(draftId), 'success', {
        phase: next.ozonCreate && next.ozonCreate.phase || 'draft'
      });
      if (next.ozonCreate && next.ozonCreate.queueId && JSON.stringify(next.ozonCreate) !== JSON.stringify(before.ozonCreate)) {
        await this.upsertSyncTask({ ...account, userId: next.ozonCreate.actorUserId, username: next.ozonCreate.actorUsername }, create.queueTask(next), client);
      }
      await client.query('COMMIT');
      return { item: next, revision: create.revision(next), version: Number(saved.rows[0].version), updatedAt: saved.rows[0].updated_at };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async replaceBusinessRows(account, key, payload, expectedVersion, allowedHosts, options = {}) {
    if (!['erp_orders_data', 'erp_online_products', ...FINANCIAL_RECORD_KEYS].includes(key)) {
      throw Object.assign(new Error('该行数据标识不受支持，请刷新页面后重试。'), { publicCode: 'unsupported_business_row_key' });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      const versionResult = await client.query(
        `SELECT version FROM business_data_versions WHERE tenant_id = $1 AND document_key = $2 FOR UPDATE`,
        [account.tenantId, key]
      );
      const currentVersion = versionResult.rowCount ? Number(versionResult.rows[0].version) : 0;
      if (Number.isInteger(expectedVersion) && expectedVersion >= 0 && currentVersion !== expectedVersion) {
        throw Object.assign(new Error('文档版本已被他人更新，请刷新页面后重新编辑。'), { publicCode: 'document_version_conflict' });
      }

      let normalizedInput = payload;
      if (key === 'erp_orders_data') {
        const existingOrders = await client.query(
          `SELECT payload FROM business_orders WHERE tenant_id=$1 ORDER BY position,record_key FOR UPDATE`,
          [account.tenantId]
        );
        if (options.source === 'sync') {
          normalizedInput = await reconcileOrderManualData(
            client, account.tenantId, payload, existingOrders.rows.map(row => row.payload)
          );
        }
      }
      if (key === 'erp_online_products' && options.source === 'sync') {
        const existingProducts = await client.query(
          `SELECT payload FROM business_products WHERE tenant_id=$1 ORDER BY position, record_key FOR UPDATE`,
          [account.tenantId]
        );
        normalizedInput = preserveProductLocalFieldsForSync(payload, existingProducts.rows.map(row => row.payload));
      }
      const normalizedPayload = normalizePlatformPayload(key, normalizedInput, allowedHosts);
      if (key === 'erp_orders_data' && options.source !== 'sync') {
        await saveOrderManualLedger(client, account, normalizedPayload);
      }
      const normalized = rowsForPayload(key, normalizedPayload);
      if (normalized.rows.length > 10000) {
        throw Object.assign(new Error('数据行数已超过允许上限，请删除不再需要的记录后再保存。'), { publicCode: 'business_row_limit_exceeded' });
      }

      if (key === 'erp_online_products') {
        // Ozon remains authoritative for platform fields. When a newly created
        // offer first appears in a refresh, merge only the ERP-local source and
        // cost fields from its confirmed server draft.
        const draftDocument = await client.query(
          `SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key='erp_product_drafts'`,
          [account.tenantId]
        );
        const create = require('./product-create');
        const localFields = create.confirmedLocalFields(draftDocument.rowCount ? draftDocument.rows[0].payload : []);
        for (const row of normalized.rows) {
          const item = row.payload || {};
          const clientId = String(item.clientId || item.shopId || '').trim();
          const offerId = String(item.offer_id || item.article || '').trim();
          const local = localFields.get(clientId + '\u0000' + offerId);
          if (!local) continue;
          const { combinationAliasVariantRef, ...persistedLocal } = local;
          Object.assign(item, persistedLocal, {
            srcUrl: local.srcUrl ? validateSupplierUrl(local.srcUrl, allowedHosts) : '',
            _manual: { ...(item._manual || {}), purchasePrice: true, srcPrice: true, domesticShipping: true, srcUrl: true, srcNote: true, collectionId: true, erpVariantRef: true, sourceBundleIds: true, sourceBundles: true, combinationRelations: true, combinationHistory: true, manualVariantAttributes: true, suppressedVariantAttributes: true }
          });
        }
        const combinationReplacement = confirmedCreateCombinationReplacement(normalized.rows, localFields);
        if (combinationReplacement.parentRefs.length) {
          const combinationStore = require('./product-combination-store');
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('product-combination:'||$1,0))", [String(account.tenantId)]);
          const currentCombination = await client.query(`SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2 FOR UPDATE`, [account.tenantId, combinationStore.DOCUMENT_KEY]);
          const currentPayload = currentCombination.rowCount ? currentCombination.rows[0].payload : null;
          const built = combinationStore.buildReplacement(currentPayload, combinationReplacement.parentRefs, combinationReplacement.relations, account, '新增商品');
          const aliasUpdate = combinationStore.replaceAliases(built.payload, combinationReplacement.aliases || []);
          built.payload = aliasUpdate.payload;
          if (built.events.length || aliasUpdate.changed) await client.query(
            `INSERT INTO tenant_documents(tenant_id,document_key,payload,updated_by_user_id)
             VALUES($1,$2,$3::jsonb,$4)
             ON CONFLICT(tenant_id,document_key) DO UPDATE SET payload=EXCLUDED.payload,version=tenant_documents.version+1,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
            [account.tenantId, combinationStore.DOCUMENT_KEY, JSON.stringify(built.payload), account.userId]
          );
        }
        // ozonEdit is server-owned recovery state. A collection refresh may
        // update platform fields, but cannot forge or erase an active job.
        const jobs = await client.query(
          `SELECT record_key, shop_external_id, COALESCE(payload->>'id',payload->>'productId') AS product_id, payload->'ozonEdit' AS state, payload->'editorDraft' AS draft FROM business_products
           WHERE tenant_id=$1 AND (payload ? 'ozonEdit' OR payload ? 'editorDraft') FOR UPDATE`, [account.tenantId]);
        const incoming = new Map(normalized.rows.map(row => [row.recordKey, row]));
        for (const job of jobs.rows) {
          const sameProduct = normalized.rows.filter(row => String(row.payload.clientId || row.payload.shopId || '') === job.shop_external_id && String(row.payload.id || row.payload.productId || '') === job.product_id);
          const row = incoming.get(job.record_key) || (sameProduct.length === 1 ? sameProduct[0] : null), state = job.state;
          if (row) row.recordKey = job.record_key;
          if (!row && state && ['queued', 'preparing', 'submitting', 'pending', 'unknown'].includes(state.phase)) {
            throw Object.assign(new Error('该商品还有未完成的编辑任务，请等待其结束后再操作。'), { publicCode: 'product_edit_pending' });
          }
          if (row && state) row.payload.ozonEdit = state;
          if (!row && job.draft) throw Object.assign(new Error('该商品草稿尚未确认，请先完成草稿再执行本操作。'), { publicCode: 'product_draft_pending' });
          if (row && job.draft) row.payload.editorDraft = job.draft;
        }
      }

      const retainedKeys = normalized.rows.map(row => row.recordKey);
      if (key === 'erp_orders_data') {
        for (const row of normalized.rows) {
          const item = row.payload || {};
          await client.query(
            `INSERT INTO business_orders
               (tenant_id, record_key, position, posting_number, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id)
             VALUES ($1, $2, $3, $4, $5, 'ozon', $6, $7::jsonb, $8)
             ON CONFLICT (tenant_id, record_key) DO UPDATE SET
               position=EXCLUDED.position, posting_number=EXCLUDED.posting_number, shop_external_id=EXCLUDED.shop_external_id,
               platform_source='ozon', platform_record_id=EXCLUDED.platform_record_id, payload=EXCLUDED.payload,
               updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`,
            [account.tenantId, row.recordKey, row.position,
              String(item.posting || item.posting_number || '').slice(0, 180) || null,
              String(item.clientId || item.shopId || '').slice(0, 120) || null,
              String(item.platformRecordId), JSON.stringify(item), account.userId]
          );
        }
        await client.query(
          `DELETE FROM business_orders WHERE tenant_id=$1 AND NOT (record_key = ANY($2::varchar[]))`,
          [account.tenantId, retainedKeys]
        );
      } else if (key === 'erp_online_products') {
        for (const row of normalized.rows) {
          const item = row.payload || {};
          await client.query(
            `INSERT INTO business_products
               (tenant_id, record_key, position, offer_id, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id)
             VALUES ($1, $2, $3, $4, $5, 'ozon', $6, $7::jsonb, $8)
             ON CONFLICT (tenant_id, record_key) DO UPDATE SET
               position=EXCLUDED.position, offer_id=EXCLUDED.offer_id, shop_external_id=EXCLUDED.shop_external_id,
               platform_source='ozon', platform_record_id=EXCLUDED.platform_record_id, payload=EXCLUDED.payload,
               updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`,
            [account.tenantId, row.recordKey, row.position,
              String(item.offer_id || item.article || item.sku || '').slice(0, 180) || null,
              String(item.clientId || item.shopId || '').slice(0, 120) || null,
              String(item.platformRecordId), JSON.stringify(item), account.userId]
          );
          await client.query(
            `INSERT INTO product_costs
               (tenant_id, product_record_key, purchase_amount, source_amount, domestic_shipping_amount, supplier_url, supplier_note, updated_by_user_id)
             VALUES ($1,$2,$3::numeric,$4::numeric,$5::numeric,$6,$7,$8)
             ON CONFLICT (tenant_id, product_record_key) DO UPDATE SET
               purchase_amount=EXCLUDED.purchase_amount, source_amount=EXCLUDED.source_amount,
               domestic_shipping_amount=EXCLUDED.domestic_shipping_amount, supplier_url=EXCLUDED.supplier_url,
               supplier_note=EXCLUDED.supplier_note, updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`,
            [account.tenantId, row.recordKey, nullableAmount(item.purchasePrice), nullableAmount(item.srcPrice), nullableAmount(item.domesticShipping),
              String(item.srcUrl || item.sourceUrl || '') || null, String(item.srcNote || '').slice(0, 1000) || null, account.userId]
          );
        }
        await client.query(
          `DELETE FROM business_products WHERE tenant_id=$1 AND NOT (record_key = ANY($2::varchar[]))`,
          [account.tenantId, retainedKeys]
        );
      } else {
        for (const row of normalized.rows) {
          const item = row.payload;
          await client.query(
            `INSERT INTO financial_records
               (tenant_id, document_key, record_key, position, order_record_key, platform_source, platform_record_id, payload, updated_by_user_id)
             VALUES ($1,$2,$3,$4,$5,'ozon',$6,$7::jsonb,$8)
             ON CONFLICT (tenant_id, document_key, record_key) DO UPDATE SET
               position=EXCLUDED.position, order_record_key=EXCLUDED.order_record_key, platform_source='ozon',
               platform_record_id=EXCLUDED.platform_record_id, payload=EXCLUDED.payload,
               updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()`,
            [account.tenantId, key, row.recordKey, row.position,
              String(item && (item.posting || item.posting_number) || '').slice(0, 240) || null,
              String(item && item.platformRecordId || row.recordKey), JSON.stringify(item), account.userId]
          );
        }
        await client.query(
          `DELETE FROM financial_records WHERE tenant_id=$1 AND document_key=$2 AND NOT (record_key = ANY($3::varchar[]))`,
          [account.tenantId, key, retainedKeys]
        );
      }

      const saved = await client.query(
        `INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id)
         VALUES ($1,$2,1,$3,$4)
         ON CONFLICT (tenant_id, document_key) DO UPDATE SET version=business_data_versions.version+1,
           payload_shape=EXCLUDED.payload_shape, updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=now()
         RETURNING version, updated_at`,
        [account.tenantId, key, normalized.shape, account.userId]
      );
      await this.writeAudit(client, account, 'business.rows.replace', 'business_collection', key, 'success', {
        retainedRows: retainedKeys.length, platformSource: 'ozon'
      });
      await client.query('COMMIT');
      return { payload: normalizedPayload, version: Number(saved.rows[0].version), updatedAt: saved.rows[0].updated_at };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async putRelationalDocument(account, key, payload, expectedVersion) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      const currentResult = await client.query(
        `SELECT version FROM business_data_versions WHERE tenant_id = $1 AND document_key = $2 FOR UPDATE`,
        [account.tenantId, key]
      );
      const currentVersion = currentResult.rowCount ? Number(currentResult.rows[0].version) : 0;
      if (Number.isInteger(expectedVersion) && expectedVersion >= 0 && currentVersion !== expectedVersion) {
        const error = new Error('文档版本已被他人更新，请刷新页面后重新编辑。'); error.publicCode = 'document_version_conflict'; throw error;
      }
      const normalized = rowsForPayload(key, payload);
      if (key === 'erp_orders_data') {
        const rows = normalized.rows.map(row => ({
          record_key: row.recordKey, position: row.position,
          posting_number: String(row.payload && (row.payload.posting || row.payload.posting_number) || '').slice(0, 180) || null,
          shop_external_id: String(row.payload && (row.payload.clientId || row.payload.shopId) || '').slice(0, 120) || null,
          platform_record_id: String(row.payload && row.payload.platformRecordId || row.recordKey), payload: row.payload
        }));
        await client.query(`DELETE FROM business_orders WHERE tenant_id = $1`, [account.tenantId]);
        if (rows.length) await client.query(
          `INSERT INTO business_orders (tenant_id, record_key, position, posting_number, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id)
           SELECT $1, x.record_key, x.position, x.posting_number, x.shop_external_id, 'ozon', x.platform_record_id, x.payload, $3
           FROM jsonb_to_recordset($2::jsonb) AS x(record_key text, position integer, posting_number text, shop_external_id text, platform_record_id text, payload jsonb)`,
          [account.tenantId, JSON.stringify(rows), account.userId]
        );
      } else if (key === 'erp_online_products') {
        const rows = normalized.rows.map(row => ({
          record_key: row.recordKey, position: row.position,
          offer_id: String(row.payload && (row.payload.offer_id || row.payload.article || row.payload.sku) || '').slice(0, 180) || null,
          shop_external_id: String(row.payload && (row.payload.clientId || row.payload.shopId) || '').slice(0, 120) || null,
          platform_record_id: String(row.payload && row.payload.platformRecordId || row.recordKey), payload: row.payload,
          purchase_amount: nullableAmount(row.payload && row.payload.purchasePrice), source_amount: nullableAmount(row.payload && row.payload.srcPrice),
          domestic_shipping_amount: nullableAmount(row.payload && row.payload.domesticShipping),
          supplier_url: String(row.payload && (row.payload.srcUrl || row.payload.sourceUrl) || '') || null,
          supplier_note: String(row.payload && row.payload.srcNote || '').slice(0, 1000) || null
        }));
        await client.query(`DELETE FROM business_products WHERE tenant_id = $1`, [account.tenantId]);
        if (rows.length) {
          await client.query(
            `INSERT INTO business_products (tenant_id, record_key, position, offer_id, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id)
             SELECT $1, x.record_key, x.position, x.offer_id, x.shop_external_id, 'ozon', x.platform_record_id, x.payload, $3
             FROM jsonb_to_recordset($2::jsonb) AS x(record_key text, position integer, offer_id text, shop_external_id text, platform_record_id text, payload jsonb)`,
            [account.tenantId, JSON.stringify(rows), account.userId]
          );
          await client.query(
            `INSERT INTO product_costs (tenant_id, product_record_key, purchase_amount, source_amount, domestic_shipping_amount, supplier_url, supplier_note, updated_by_user_id)
             SELECT $1, x.record_key, x.purchase_amount::numeric, x.source_amount::numeric, x.domestic_shipping_amount::numeric, x.supplier_url, x.supplier_note, $3
             FROM jsonb_to_recordset($2::jsonb) AS x(record_key text, purchase_amount text, source_amount text, domestic_shipping_amount text, supplier_url text, supplier_note text)`,
            [account.tenantId, JSON.stringify(rows), account.userId]
          );
        }
      } else if (FINANCIAL_RECORD_KEYS.has(key)) {
        const rows = normalized.rows.map(row => ({
          record_key: row.recordKey, position: row.position,
          order_record_key: String(row.payload && (row.payload.posting || row.payload.posting_number) || '').slice(0, 240) || null,
          platform_record_id: String(row.payload && row.payload.platformRecordId || row.recordKey), payload: row.payload
        }));
        await client.query(`DELETE FROM financial_records WHERE tenant_id = $1 AND document_key = $2`, [account.tenantId, key]);
        if (rows.length) await client.query(
          `INSERT INTO financial_records (tenant_id, document_key, record_key, position, order_record_key, platform_source, platform_record_id, payload, updated_by_user_id)
           SELECT $1, $2, x.record_key, x.position, x.order_record_key, 'ozon', x.platform_record_id, x.payload, $4
           FROM jsonb_to_recordset($3::jsonb) AS x(record_key text, position integer, order_record_key text, platform_record_id text, payload jsonb)`,
          [account.tenantId, key, JSON.stringify(rows), account.userId]
        );
      } else if (FINANCE_SETTING_KEYS.has(key)) {
        await client.query(
          `INSERT INTO finance_settings (tenant_id, setting_key, value, updated_by_user_id) VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (tenant_id, setting_key) DO UPDATE SET value = EXCLUDED.value, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
          [account.tenantId, key, JSON.stringify(payload), account.userId]
        );
      } else if (key === 'erp_bug_reports') {
        if (!Array.isArray(payload)) throw Object.assign(new Error('报错内容不完整，请填写标题和具体现象后再提交。'), { publicCode: 'invalid_bug_reports' });
        const unrestricted = Boolean(account.isSystemAdmin || account.memberType === 'owner');
        const retained = [];
        for (const input of payload.slice(0, 500)) {
          const reportId = String(input && input.id || '').trim();
          if (!/^BUG-[A-Z0-9-]{6,80}$/.test(reportId)) continue;
          const existing = await client.query(`SELECT created_by_user_id::text FROM bug_reports WHERE tenant_id = $1 AND report_id = $2 FOR UPDATE`, [account.tenantId, reportId]);
          if (existing.rowCount && !unrestricted && String(existing.rows[0].created_by_user_id) !== String(account.userId)) continue;
          const reportPayload = { ...(input || {}) };
          delete reportPayload.id; delete reportPayload.createdBy; delete reportPayload.attachments;
          const createdAt = Number.isNaN(Date.parse(input.createdAt || '')) ? new Date() : new Date(input.createdAt);
          await client.query(
            `INSERT INTO bug_reports (tenant_id, report_id, created_by_user_id, title, severity, payload, created_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             ON CONFLICT (tenant_id, report_id) DO UPDATE SET title = EXCLUDED.title, severity = EXCLUDED.severity,
               payload = EXCLUDED.payload, updated_at = now()`,
            [account.tenantId, reportId, existing.rowCount ? existing.rows[0].created_by_user_id : account.userId,
              String(input.title || '').slice(0, 120) || '未命名反馈', ['high', 'medium', 'low'].includes(input.severity) ? input.severity : 'medium', JSON.stringify(reportPayload), createdAt]
          );
          retained.push(reportId);
        }
        await client.query(
          `DELETE FROM bug_reports WHERE tenant_id = $1 AND ($2::boolean OR created_by_user_id = $3) AND NOT (report_id = ANY($4::varchar[]))`,
          [account.tenantId, unrestricted, account.userId, retained]
        );
      }
      const saved = await client.query(
        `INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id)
         VALUES ($1, $2, 1, $3, $4)
         ON CONFLICT (tenant_id, document_key) DO UPDATE SET version = business_data_versions.version + 1,
           payload_shape = EXCLUDED.payload_shape, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
         RETURNING version, updated_at`,
        [account.tenantId, key, normalized.shape, account.userId]
      );
      await client.query('COMMIT');
      return { version: Number(saved.rows[0].version), updatedAt: saved.rows[0].updated_at };
    } catch (error) {
      await client.query('ROLLBACK'); throw error;
    } finally { client.release(); }
  }

  async deleteRelationalDocument(account, key) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (key === 'erp_orders_data') await client.query(`DELETE FROM business_orders WHERE tenant_id = $1`, [account.tenantId]);
      else if (key === 'erp_online_products') await client.query(`DELETE FROM business_products WHERE tenant_id = $1`, [account.tenantId]);
      else if (FINANCIAL_RECORD_KEYS.has(key)) await client.query(`DELETE FROM financial_records WHERE tenant_id = $1 AND document_key = $2`, [account.tenantId, key]);
      else if (FINANCE_SETTING_KEYS.has(key)) await client.query(`DELETE FROM finance_settings WHERE tenant_id = $1 AND setting_key = $2`, [account.tenantId, key]);
      else if (key === 'erp_bug_reports') {
        const unrestricted = Boolean(account.isSystemAdmin || account.memberType === 'owner');
        await client.query(`DELETE FROM bug_reports WHERE tenant_id = $1 AND ($2::boolean OR created_by_user_id = $3)`, [account.tenantId, unrestricted, account.userId]);
        const result = await client.query(
          `UPDATE business_data_versions SET version = version + 1, updated_by_user_id = $3, updated_at = now()
           WHERE tenant_id = $1 AND document_key = $2`,
          [account.tenantId, key, account.userId]
        );
        await client.query('COMMIT'); return result.rowCount > 0;
      }
      const result = await client.query(`DELETE FROM business_data_versions WHERE tenant_id = $1 AND document_key = $2`, [account.tenantId, key]);
      await client.query('COMMIT'); return result.rowCount > 0;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async canAccessBugReport(account, reportId) {
    const unrestricted = Boolean(account.isSystemAdmin || account.memberType === 'owner');
    const result = await this.pool.query(
      `SELECT 1 FROM bug_reports WHERE tenant_id = $1 AND report_id = $2 AND ($3::boolean OR created_by_user_id = $4)`,
      [account.tenantId, reportId, unrestricted, account.userId]
    );
    return result.rowCount > 0;
  }

  async addBugAttachment(account, reportId, attachment) {
    const unrestricted = Boolean(account.isSystemAdmin || account.memberType === 'owner');
    const result = await this.pool.query(
      `INSERT INTO bug_attachments (tenant_id, report_id, attachment_id, created_by_user_id, original_name, stored_name, media_type, size_bytes, object_id, sha256)
       SELECT br.tenant_id, br.report_id, $5::uuid, $4, $6, $7, $8, $9, $10::uuid, $11
       FROM bug_reports br WHERE br.tenant_id = $1 AND br.report_id = $2 AND ($3::boolean OR br.created_by_user_id = $4)
       RETURNING attachment_id`,
      [account.tenantId, reportId, unrestricted, account.userId, attachment.id, attachment.name, attachment.storedName, attachment.type, attachment.size,
        attachment.objectId || null, attachment.sha256 || null]
    );
    if (!result.rowCount) throw Object.assign(new Error('没有权限查看或修改这条报错记录。'), { publicCode: 'bug_report_forbidden' });
  }

  async canAccessBugAttachment(account, reportId, storedName) {
    const unrestricted = Boolean(account.isSystemAdmin || account.memberType === 'owner');
    const result = await this.pool.query(
      `SELECT 1 FROM bug_attachments ba JOIN bug_reports br ON br.tenant_id = ba.tenant_id AND br.report_id = ba.report_id
       WHERE ba.tenant_id = $1 AND ba.report_id = $2 AND ba.stored_name = $3 AND ($4::boolean OR br.created_by_user_id = $5)`,
      [account.tenantId, reportId, storedName, unrestricted, account.userId]
    );
    return result.rowCount > 0;
  }

  async countBugAttachments(account, reportId) {
    const unrestricted = Boolean(account.isSystemAdmin || account.memberType === 'owner');
    const result = await this.pool.query(
      `SELECT count(*)::integer AS total FROM bug_attachments ba
       JOIN bug_reports br ON br.tenant_id=ba.tenant_id AND br.report_id=ba.report_id
       WHERE ba.tenant_id=$1 AND ba.report_id=$2 AND ($3::boolean OR br.created_by_user_id=$4)`,
      [account.tenantId, reportId, unrestricted, account.userId]
    );
    return result.rowCount ? Number(result.rows[0].total) : 0;
  }

  async getBugAttachmentObject(account, reportId, storedName) {
    const unrestricted = Boolean(account.isSystemAdmin || account.memberType === 'owner');
    const result = await this.pool.query(
      `SELECT po.object_key, po.sha256, po.size_bytes
       FROM bug_attachments ba
       JOIN bug_reports br ON br.tenant_id=ba.tenant_id AND br.report_id=ba.report_id
       JOIN private_objects po ON po.object_id=ba.object_id
       WHERE ba.tenant_id=$1 AND ba.report_id=$2 AND ba.stored_name=$3
         AND ($4::boolean OR br.created_by_user_id=$5)`,
      [account.tenantId, reportId, storedName, unrestricted, account.userId]
    );
    return result.rows[0] || null;
  }

  async getPrivateObjectBySource(account, kind, sourceRelativePath) {
    const result = await this.pool.query(
      `SELECT object_key, sha256, size_bytes FROM private_objects
       WHERE tenant_id=$1 AND object_kind=$2 AND source_relative_path=$3
       ORDER BY migrated_at DESC LIMIT 1`,
      [account.tenantId, kind, sourceRelativePath]
    );
    return result.rows[0] || null;
  }

  async getTenantCutoverRun(account) {
    const result = await this.pool.query(
      `SELECT run_id::text FROM tenant_data_cutovers WHERE tenant_id=$1`,
      [account.tenantId]
    );
    return result.rowCount ? result.rows[0].run_id : null;
  }

  async addLivePrivateObject(account, object) {
    if (!await this.getTenantCutoverRun(account)) {
      throw Object.assign(new Error('数据迁移尚未正式切换完成，暂时不能执行该操作。'), { publicCode: 'migration_not_cutover' });
    }
    const objectId = crypto.randomUUID();
    const result = await this.pool.query(
      `WITH inserted AS (
         INSERT INTO private_objects
           (object_id,migration_run_id,tenant_id,object_kind,object_key,storage_backend,size_bytes,sha256,media_type,source_relative_path,created_at,metadata,object_origin)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10::jsonb,'live')
         ON CONFLICT (tenant_id,object_kind,sha256,source_relative_path) DO NOTHING
         RETURNING object_id::text,object_key,sha256,size_bytes
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT object_id::text,object_key,sha256,size_bytes FROM private_objects
       WHERE tenant_id=$2 AND object_kind=$3 AND sha256=$7 AND source_relative_path=$9
       LIMIT 1`,
      [objectId, account.tenantId, object.kind, object.objectKey, object.backend, object.size, object.sha256,
        object.mediaType || 'application/octet-stream', object.sourceRelativePath, JSON.stringify(object.metadata || {})]
    );
    let row = result.rows[0];
    if (!row) {
      const existing = await this.pool.query(
        `SELECT object_id::text,object_key,sha256,size_bytes FROM private_objects
         WHERE tenant_id=$1 AND object_kind=$2 AND sha256=$3 AND source_relative_path=$4`,
        [account.tenantId, object.kind, object.sha256, object.sourceRelativePath]
      );
      row = existing.rows[0];
    }
    if (!row) throw new Error('私有对象登记写入失败，文件未能保存，请稍后重试。');
    return { objectId: row.object_id, objectKey: row.object_key, sha256: row.sha256, size: Number(row.size_bytes) };
  }

  async sourceBoundaryCommand(account, input, sourceLink, allowedHosts) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const orderResult = await client.query(
        `SELECT record_key, payload FROM business_orders WHERE tenant_id = $1 ORDER BY position, record_key FOR UPDATE`,
        [account.tenantId]
      );
      const productResult = await client.query(
        `SELECT record_key, payload FROM business_products WHERE tenant_id = $1 ORDER BY position, record_key FOR UPDATE`,
        [account.tenantId]
      );
      let orders = orderResult.rows.map(row => row.payload);
      let products = productResult.rows.map(row => row.payload);
      let result;
      if (input.action === 'repair-all') {
        result = sourceLink.repairAllSources(orders, products);
      } else if (input.action === 'update-product-source') {
        const clientId = String(input.clientId || '');
        const productId = String(input.productId || '');
        const sku = String(input.sku || '');
        const product = products.find(item =>
          (!clientId || String(item && (item.clientId || item.shopId || item.shop) || '') === clientId) &&
          ((!productId && !sku) || String(item && (item.id || item.productId || item.article || item.offer_id) || '') === productId || String(item && item.sku || '') === sku)
        );
        if (!product) throw Object.assign(new Error('未找到该商品，请刷新商品列表后重试。'), { publicCode: 'product_not_found' });
        const profile = normalizePlatformPayload('erp_collected_products', input.profile || {}, allowedHosts);
        ['purchasePrice', 'srcUrl', 'srcPrice', 'srcNote', 'domesticShipping'].forEach(field => { product[field] = profile[field] == null ? '' : profile[field]; });
        product._manual = { ...(product._manual || {}), purchasePrice: true, srcUrl: true, srcPrice: true, srcNote: true, domesticShipping: true };
        result = { linkedOrders: sourceLink.applyProductToOrders(orders, product), productRecordId: product.platformRecordId };
      } else throw Object.assign(new Error('该数据操作暂不支持，请从页面入口重新发起。'), { publicCode: 'unsupported_business_command' });
      orders = normalizePlatformPayload('erp_orders_data', orders, allowedHosts);
      products = normalizePlatformPayload('erp_online_products', products, allowedHosts);
      // Keep the persisted keys: migrated rows deliberately have collision-safe
      // legacy suffixes which cannot be reconstructed from the JSON payload.
      const orderRows = orders.map((payload, index) => ({ record_key: orderResult.rows[index].record_key, payload }));
      const productRows = products.map((payload, index) => ({ record_key: productResult.rows[index].record_key, payload }));
      if (orderRows.length) await client.query(
        `UPDATE business_orders target SET payload = x.payload, platform_record_id = x.payload->>'platformRecordId', updated_by_user_id = $3, updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS x(record_key text, payload jsonb)
         WHERE target.tenant_id = $1 AND target.record_key = x.record_key`,
        [account.tenantId, JSON.stringify(orderRows), account.userId]
      );
      if (productRows.length) await client.query(
        `UPDATE business_products target SET payload = x.payload, platform_record_id = x.payload->>'platformRecordId', updated_by_user_id = $3, updated_at = now()
         FROM jsonb_to_recordset($2::jsonb) AS x(record_key text, payload jsonb)
         WHERE target.tenant_id = $1 AND target.record_key = x.record_key`,
        [account.tenantId, JSON.stringify(productRows), account.userId]
      );
      await client.query(
        `UPDATE product_costs costs SET
           purchase_amount = CASE WHEN NULLIF(product.payload->>'purchasePrice','') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (product.payload->>'purchasePrice')::numeric ELSE NULL END,
           source_amount = CASE WHEN NULLIF(product.payload->>'srcPrice','') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (product.payload->>'srcPrice')::numeric ELSE NULL END,
           domestic_shipping_amount = CASE WHEN NULLIF(product.payload->>'domesticShipping','') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' THEN (product.payload->>'domesticShipping')::numeric ELSE NULL END,
           supplier_url = NULLIF(product.payload->>'srcUrl',''), supplier_note = NULLIF(product.payload->>'srcNote',''),
           updated_by_user_id = $2, updated_at = now()
         FROM business_products product
         WHERE costs.tenant_id = $1 AND product.tenant_id = costs.tenant_id AND product.record_key = costs.product_record_key`,
        [account.tenantId, account.userId]
      );
      const versions = await client.query(
        `UPDATE business_data_versions SET version = version + 1, updated_by_user_id = $2, updated_at = now()
         WHERE tenant_id = $1 AND document_key = ANY($3::varchar[]) RETURNING document_key, version`,
        [account.tenantId, account.userId, ['erp_orders_data', 'erp_online_products']]
      );
      await this.writeAudit(client, account, 'business.source.command', 'business_transaction', input.action, 'success', result);
      await client.query('COMMIT');
      const versionMap = Object.fromEntries(versions.rows.map(row => [row.document_key, Number(row.version)]));
      return { ok: true, result, orders, products, versions: versionMap };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async updateFinanceSettingsTransaction(account, input) {
    const settings = {
      erp_rate: input && Object.prototype.hasOwnProperty.call(input, 'rate') ? input.rate : null,
      erp_fee_manual: input && Object.prototype.hasOwnProperty.call(input, 'manualFee') ? input.manualFee : null
    };
    for (const value of Object.values(settings)) {
      if (typeof value !== 'string' && typeof value !== 'number') {
        throw Object.assign(new Error('财务口径设置不正确，请选择结算方式与费率来源后再保存。'), { publicCode: 'invalid_finance_setting' });
      }
      if (!Number.isFinite(Number(value)) || Number(value) < 0) {
        throw Object.assign(new Error('财务口径设置不正确，请选择结算方式与费率来源后再保存。'), { publicCode: 'invalid_finance_setting' });
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      for (const [key, value] of Object.entries(settings)) {
        await client.query(
          `INSERT INTO finance_settings (tenant_id, setting_key, value, updated_by_user_id)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (tenant_id, setting_key) DO UPDATE SET value = EXCLUDED.value,
             updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
          [account.tenantId, key, JSON.stringify(String(value)), account.userId]
        );
      }
      const versions = await client.query(
        `INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id)
         SELECT $1, key, 1, 'scalar', $3 FROM unnest($2::varchar[]) AS key
         ON CONFLICT (tenant_id, document_key) DO UPDATE SET version = business_data_versions.version + 1,
           payload_shape = 'scalar', updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()
         RETURNING document_key, version`,
        [account.tenantId, Object.keys(settings), account.userId]
      );
      await this.writeAudit(client, account, 'finance.settings.update', 'finance_settings', 'statistics', 'success');
      await client.query('COMMIT');
      return {
        ok: true,
        settings,
        versions: Object.fromEntries(versions.rows.map(row => [row.document_key, Number(row.version)]))
      };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async clearBusinessPageTransaction(account, page) {
    const keys = page === 'orders'
      ? ['erp_orders_data', 'erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1']
      : page === 'online-products' ? ['erp_online_products'] : null;
    if (!keys) throw Object.assign(new Error('该页面数据暂不支持，请返回工作台重新进入。'), { publicCode: 'unsupported_page' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      if (page === 'orders') {
        await client.query(
          `INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id)
           VALUES ($1,'erp_orders_data',1,'array',$2) ON CONFLICT (tenant_id,document_key) DO NOTHING`,
          [account.tenantId, account.userId]
        );
        await client.query(
          `SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data' FOR UPDATE`,
          [account.tenantId]
        );
        const currentOrders = await client.query(
          `SELECT payload FROM business_orders WHERE tenant_id=$1 ORDER BY position,record_key FOR UPDATE`,
          [account.tenantId]
        );
        if (currentOrders.rowCount) {
          await saveOrderManualLedger(client, account, currentOrders.rows.map(row => row.payload));
        }
        await client.query(`DELETE FROM business_orders WHERE tenant_id = $1`, [account.tenantId]);
        await client.query(`DELETE FROM financial_records WHERE tenant_id = $1 AND document_key = ANY($2::varchar[])`, [account.tenantId, keys.slice(1)]);
      } else await client.query(`DELETE FROM business_products WHERE tenant_id = $1`, [account.tenantId]);
      await client.query(
        `INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id)
         SELECT $1, key, 1, CASE WHEN key IN ('erp_orders_data','erp_online_products') THEN 'array' ELSE 'object' END, $3
         FROM unnest($2::varchar[]) AS key
         ON CONFLICT (tenant_id, document_key) DO UPDATE SET version = business_data_versions.version + 1,
           payload_shape = EXCLUDED.payload_shape, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
        [account.tenantId, keys, account.userId]
      );
      await this.writeAudit(client, account, 'system.page_data.clear', 'page', page, 'success', {
        preservedDocument: page === 'orders' ? 'erp_dev_manual_backup' : 'erp_online_product_manual'
      });
      await client.query('COMMIT'); return { ok: true, page };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async exportOrderManualData(account) {
    const result = await this.pool.query(`SELECT payload FROM business_orders WHERE tenant_id=$1 ORDER BY position,record_key`, [account.tenantId]);
    return result.rows.map(row => row.payload);
  }

  async importOrderManualData(account, imported, allowedHosts) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT record_key,payload FROM business_orders WHERE tenant_id=$1 ORDER BY position,record_key FOR UPDATE`, [account.tenantId]);
      const current = result.rows.map(row => row.payload);
      const currentByPosting = new Map(current.map(order => [String(order && order.posting || ''), order]));
      for (const order of imported) if (allowedHosts !== null) {
        const currentOrder = currentByPosting.get(String(order && order.posting || ''));
        if (!currentOrder || orderManualExcel.versionOf(currentOrder) !== order.version) throw Object.assign(new Error(`货件“${order && order.posting || ''}”已变化，请重新导出后再导入。`), { publicCode: 'manual_excel_version_conflict' });
      }
      await client.query(`INSERT INTO tenant_documents (tenant_id,document_key,payload,updated_by_user_id) VALUES ($1,'erp_dev_manual_import_backup',$2::jsonb,$3)
        ON CONFLICT (tenant_id,document_key) DO UPDATE SET payload=EXCLUDED.payload,version=tenant_documents.version+1,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`, [account.tenantId, JSON.stringify(orderManualExcel.manualSnapshot(current)), account.userId]);
      for (const order of imported) {
        for (const item of order.items || []) if (item.src && allowedHosts) item.src = validateSupplierUrl(item.src, allowedHosts);
        for (const group of order.combine || []) if (group && group.src && allowedHosts) group.src = validateSupplierUrl(group.src, allowedHosts);
      }
      const before = current.map(order => JSON.stringify(order));
      orderManualExcel.applyImport(current, imported);
      let updatedOrders = 0;
      for (let index = 0; index < current.length; index += 1) {
        if (before[index] === JSON.stringify(current[index])) continue;
        updatedOrders += 1;
        await client.query(`UPDATE business_orders SET payload=$3::jsonb,updated_by_user_id=$4,updated_at=now() WHERE tenant_id=$1 AND record_key=$2`, [account.tenantId, result.rows[index].record_key, JSON.stringify(current[index]), account.userId]);
      }
      await saveOrderManualLedger(client, account, current);
      await this.writeAudit(client, account, 'order.manual_data.import', 'tenant_document', ORDER_MANUAL_LEDGER_KEY, 'success', { importedOrders: imported.length, updatedOrders, format: 'xlsx' });
      await client.query('COMMIT');
      return { ok: true, importedOrders: imported.length, updatedOrders };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async restoreOrderManualData(account) {
    const backup = await this.getDocument(account, 'erp_dev_manual_import_backup');
    if (!backup || !Array.isArray(backup.payload)) throw Object.assign(new Error('没有可恢复的导入前备份。'), { publicCode: 'manual_excel_backup_missing' });
    const result = await this.importOrderManualData(account, backup.payload, null);
    await this.recordAudit(account, 'order.manual_data.restore', 'tenant_document', 'erp_dev_manual_import_backup', 'success', { restoredOrders: result.updatedOrders, format: 'xlsx' });
    return result;
  }

  async getDocument(account, key) {
    if (RELATIONAL_BUSINESS_KEYS.has(key)) return this.getRelationalDocument(account, key);
    const result = await this.pool.query(
      `SELECT payload, version, updated_at FROM tenant_documents
       WHERE tenant_id = $1 AND document_key = $2`,
      [account.tenantId, key]
    );
    if (!result.rowCount) return null;
    return { payload: result.rows[0].payload, version: Number(result.rows[0].version), updatedAt: result.rows[0].updated_at };
  }

  async putDocument(account, key, payload, expectedVersion) {
    if (RELATIONAL_BUSINESS_KEYS.has(key)) return this.putRelationalDocument(account, key, payload, expectedVersion);
    if (key === require('./product-create').LISTING_RECORD_KEY) {
      const error = new Error('上架记录只能由新增商品提交任务写入，其他方式不允许修改。');
      error.publicCode = 'product_listing_record_write_forbidden';
      error.status = 403;
      throw error;
    }
    if (key === 'erp_shops_data' || key === 'erp_favorite_products') {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await this.ensureSystemAdminTenantMembership(client, account);
        await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [account.tenantId]);
        const current = await client.query(
          `SELECT payload,version FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2 FOR UPDATE`,
          [account.tenantId, key]
        );
        await this.enforceDocumentEntitlement(client, account, key, current.rows[0]?.payload, payload);
        let saved;
        if (Number.isInteger(expectedVersion) && expectedVersion >= 0) {
          if (expectedVersion === 0) saved = await client.query(
            `INSERT INTO tenant_documents(tenant_id,document_key,payload,updated_by_user_id)
             VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(tenant_id,document_key) DO NOTHING RETURNING version,updated_at`,
            [account.tenantId, key, JSON.stringify(payload), account.userId]
          );
          else saved = await client.query(
            `UPDATE tenant_documents SET payload=$3::jsonb,version=version+1,updated_by_user_id=$4,updated_at=now()
             WHERE tenant_id=$1 AND document_key=$2 AND version=$5 RETURNING version,updated_at`,
            [account.tenantId, key, JSON.stringify(payload), account.userId, expectedVersion]
          );
          if (!saved.rowCount) {
            const error = new Error('文档版本已被他人更新，请刷新页面后重新编辑。'); error.publicCode = 'document_version_conflict'; throw error;
          }
        } else saved = await client.query(
          `INSERT INTO tenant_documents(tenant_id,document_key,payload,updated_by_user_id)
           VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(tenant_id,document_key) DO UPDATE SET
             payload=EXCLUDED.payload,version=tenant_documents.version+1,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()
           RETURNING version,updated_at`,
          [account.tenantId, key, JSON.stringify(payload), account.userId]
        );
        if (key === 'erp_shops_data') await this.syncShopsForClient(client, account, payload);
        await client.query('COMMIT');
        return { version: Number(saved.rows[0].version), updatedAt: saved.rows[0].updated_at };
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    }
    await this.ensureSystemAdminTenantMembership(this.pool, account);
    let result;
    if (Number.isInteger(expectedVersion) && expectedVersion >= 0) {
      if (expectedVersion === 0) {
        result = await this.pool.query(
          `INSERT INTO tenant_documents (tenant_id, document_key, payload, updated_by_user_id)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (tenant_id, document_key) DO NOTHING
           RETURNING version, updated_at`,
          [account.tenantId, key, JSON.stringify(payload), account.userId]
        );
      } else {
        result = await this.pool.query(
          `UPDATE tenant_documents
           SET payload = $3::jsonb, version = version + 1, updated_by_user_id = $4, updated_at = now()
           WHERE tenant_id = $1 AND document_key = $2 AND version = $5
           RETURNING version, updated_at`,
          [account.tenantId, key, JSON.stringify(payload), account.userId, expectedVersion]
        );
      }
      if (!result.rowCount) {
        const error = new Error('文档版本已被他人更新，请刷新页面后重新编辑。');
        error.publicCode = 'document_version_conflict';
        throw error;
      }
    } else result = await this.pool.query(
      `INSERT INTO tenant_documents (tenant_id, document_key, payload, updated_by_user_id)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (tenant_id, document_key) DO UPDATE
       SET payload = EXCLUDED.payload,
           version = tenant_documents.version + 1,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = now()
       RETURNING version, updated_at`,
      [account.tenantId, key, JSON.stringify(payload), account.userId]
    );
    return { version: Number(result.rows[0].version), updatedAt: result.rows[0].updated_at };
  }

  async mutateTenantDocumentWithAudit(account, key, mutate, audit = {}) {
    if (RELATIONAL_BUSINESS_KEYS.has(key) || typeof mutate !== 'function') throw new Error('该业务数据的修改方式不受支持，请刷新页面后重试。');
    if (key === require('./product-create').LISTING_RECORD_KEY) {
      const error = new Error('上架记录只能由新增商品提交任务写入，其他方式不允许修改。');
      error.publicCode = 'product_listing_record_write_forbidden'; error.status = 403; throw error;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(
        `INSERT INTO tenant_documents (tenant_id, document_key, payload, updated_by_user_id)
         VALUES ($1, $2, '{}'::jsonb, $3)
         ON CONFLICT (tenant_id, document_key) DO NOTHING`,
        [account.tenantId, key, account.userId]
      );
      const current = await client.query(
        `SELECT payload, version FROM tenant_documents
         WHERE tenant_id = $1 AND document_key = $2
         FOR UPDATE`,
        [account.tenantId, key]
      );
      const existingPayload = current.rowCount ? current.rows[0].payload : null;
      const outcome = await mutate(existingPayload, current.rowCount ? Number(current.rows[0].version) : 0);
      const nextPayload = outcome && Object.prototype.hasOwnProperty.call(outcome, 'payload') ? outcome.payload : outcome;
      if (!nextPayload || typeof nextPayload !== 'object') throw new Error('该业务数据内容格式不正确，请重新提交。');
      const saved = await client.query(
        `INSERT INTO tenant_documents (tenant_id, document_key, payload, updated_by_user_id)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (tenant_id, document_key) DO UPDATE
         SET payload = EXCLUDED.payload,
             version = tenant_documents.version + 1,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = now()
         RETURNING version, updated_at`,
        [account.tenantId, key, JSON.stringify(nextPayload), account.userId]
      );
      const auditMetadata = typeof audit.metadata === 'function' ? audit.metadata(outcome) : (audit.metadata || {});
      await this.writeAudit(
        client,
        account,
        String(audit.action || 'tenant.document.mutate'),
        String(audit.resourceType || 'tenant_document'),
        String(audit.resourceId || key),
        'success',
        auditMetadata
      );
      await client.query('COMMIT');
      return {
        version: Number(saved.rows[0].version),
        updatedAt: saved.rows[0].updated_at,
        value: outcome && Object.prototype.hasOwnProperty.call(outcome, 'value') ? outcome.value : null
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async mergeOrderFeeCache(account, key, input = {}) {
    if (!/^erp_order_fee_cache_[a-f0-9]{16}$/.test(String(key || ''))) throw new Error('订单费用缓存标识不合法，本次未写入缓存。');
    const types = Array.isArray(input.types) ? input.types : [];
    const patch = input.cachePatch && typeof input.cachePatch === 'object' ? input.cachePatch : {};
    const newRealization = input.realizationBonus && typeof input.realizationBonus === 'object' ? input.realizationBonus : null;
    return this.mutateTenantDocumentWithAudit(account, key, payload => {
      const current = payload && typeof payload === 'object' ? payload : {};
      const currentRealization = current.realizationBonus && typeof current.realizationBonus === 'object' ? current.realizationBonus : {};
      const mergedRealization = newRealization ? { ...currentRealization, ...newRealization } : currentRealization;
      const result = { types: types.length ? types : (Array.isArray(current.types) ? current.types : []), cache: { ...(current.cache && typeof current.cache === 'object' ? current.cache : {}), ...patch } };
      if (Object.keys(mergedRealization).length) result.realizationBonus = mergedRealization;
      return { payload: result };
    }, { action: 'order.fee_cache.merge', resourceType: 'order_cache', resourceId: key, metadata: { entries: Object.keys(patch).length } });
  }

  async replaceOrderAcquiringCache(account, key, input = {}) {
    if (!/^erp_order_acquiring_cache_[a-f0-9]{16}$/.test(String(key || ''))) throw new Error('收单业务费缓存标识不合法，本次未写入缓存。');
    const payload = {
      cache: input.cache && typeof input.cache === 'object' ? input.cache : {},
      whd: input.whd && typeof input.whd === 'object' ? input.whd : {},
      operations: input.operations && typeof input.operations === 'object' ? input.operations : {},
      types: Array.isArray(input.types) ? input.types : [],
      refreshedAt: String(input.refreshedAt || '')
    };
    return this.mutateTenantDocumentWithAudit(account, key, () => ({ payload }), { action: 'order.acquiring_cache.replace', resourceType: 'order_cache', resourceId: key, metadata: { entries: Object.keys(payload.cache).length, whdEntries: Object.keys(payload.whd).length } });
  }

  async putLargeDocument(account, key, payload, statementTimeoutMs = 180000, preparedJson = null) {
    // Keep 100+ MB catalog serialization out of the PG pool/transaction.
    // The caller may reuse the same serialized snapshot for its local copy.
    const serialized = preparedJson === null
      ? (key === 'erp_category_attributes' ? await stringifyLargeCategoryDocument(payload) : JSON.stringify(payload))
      : preparedJson;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('statement_timeout', $1, true)`, [String(Math.max(30000, Number(statementTimeoutMs) || 180000))]);
      await this.ensureSystemAdminTenantMembership(client, account);
      const result = await client.query(
        `INSERT INTO tenant_documents (tenant_id, document_key, payload, updated_by_user_id)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (tenant_id, document_key) DO UPDATE
         SET payload = EXCLUDED.payload,
             version = tenant_documents.version + 1,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = now()
         RETURNING version, updated_at`,
        [account.tenantId, key, serialized, account.userId]
      );
      await client.query('COMMIT');
      return { version: Number(result.rows[0].version), updatedAt: result.rows[0].updated_at };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async putUserScopedDocuments(account, userIds, keyPrefix, payload) {
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(value => String(value)).filter(value => /^\d+$/.test(value)))];
    if (!ids.length) return 0;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO tenant_documents (tenant_id, document_key, payload, updated_by_user_id)
         SELECT tm.tenant_id, $3 || tm.user_id::text, $4::jsonb, $5
         FROM tenant_members tm
         WHERE tm.tenant_id = $1 AND tm.user_id = ANY($2::bigint[]) AND tm.member_type <> 'owner' AND tm.status <> 'removed'
         ON CONFLICT (tenant_id, document_key) DO UPDATE
         SET payload = EXCLUDED.payload, version = tenant_documents.version + 1,
             updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
        [account.tenantId, ids, String(keyPrefix), JSON.stringify(payload), account.userId]
      );
      await client.query('COMMIT');
      return result.rowCount;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async deleteDocument(account, key) {
    if (RELATIONAL_BUSINESS_KEYS.has(key)) return this.deleteRelationalDocument(account, key);
    const result = await this.pool.query(
      `DELETE FROM tenant_documents WHERE tenant_id = $1 AND document_key = $2`,
      [account.tenantId, key]
    );
    return result.rowCount > 0;
  }

  async patchQueuedBackgroundJob(account, jobId, patch, transaction) {
    if (!transaction) throw Object.assign(new Error('任务写入必须在同一事务内完成，请重新发起一次。'), { publicCode: 'background_job_transaction_required' });
    const current = await transaction.query(
      `SELECT context FROM background_jobs WHERE tenant_id=$1 AND job_id=$2 AND actor_user_id=$3 AND state='queued' FOR UPDATE`,
      [account.tenantId, String(jobId), account.userId]
    );
    if (!current.rowCount) throw Object.assign(new Error('该任务尚未进入排队状态，暂时不能执行此操作。'), { publicCode: 'background_job_not_queued' });
    const next = { ...(current.rows[0].context || {}), ...(patch && typeof patch === 'object' ? patch : {}) };
    if (containsSecret(next) || Buffer.byteLength(JSON.stringify(next), 'utf8') > 65536) throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    const result = await transaction.query(
      `UPDATE background_jobs SET context=$4::jsonb,updated_at=now() WHERE tenant_id=$1 AND job_id=$2 AND actor_user_id=$3 AND state='queued' RETURNING *`,
      [account.tenantId, String(jobId), account.userId, JSON.stringify(next)]
    );
    return mapBackgroundJob(result.rows[0]);
  }

  async enqueueBackgroundJob(account, input, transaction = null) {
    const job = normalizeBackgroundJob(input);
    if (job.type === 'orders_sync' && job.context.source !== 'manual_server_fallback') {
      throw clientOrderSync.publicError('client_sync_auto_paused', 409, '自动订单处理已暂停，请从订单页面手动发起同步。');
    }
    const queuedTask = input && input.task && typeof input.task === 'object' ? { ...input.task, id: job.id, status: 'running', value: 0, startedAt: job.availableAt } : null;
    const client = transaction || await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('wyerp_background_enqueue'), hashtext($1::text))`, [account.tenantId]);
      const existing = await client.query(
        `SELECT * FROM background_jobs
         WHERE tenant_id=$1 AND (job_id=$2 OR (job_type=$3 AND dedupe_key=$4
           AND state IN ('queued','running','retry')))
         ORDER BY CASE WHEN job_id=$2 THEN 0 ELSE 1 END, created_at LIMIT 1`,
        [account.tenantId, job.id, job.type, job.dedupeKey]
      );
      if (existing.rowCount) {
        const current = mapBackgroundJob(existing.rows[0]);
        if (current.id === job.id && (!['queued', 'running', 'retry'].includes(current.state) || current.type !== job.type || current.dedupeKey !== job.dedupeKey)) {
          throw Object.assign(new Error('相同任务编号已存在但内容不同，请勿重复提交同一批任务。'), { publicCode: 'background_job_id_conflict' });
        }
        const differentProducts = job.type === 'products_sync' && (
          current.context.mode !== job.context.mode ||
          job.context.mode === 'selected' && JSON.stringify([...(current.context.productIds || [])].sort()) !== JSON.stringify([...job.context.productIds].sort())
        );
        if (current.type !== job.type || current.dedupeKey !== job.dedupeKey || queuedTask && (current.actorUserId !== String(account.userId) || differentProducts)) {
          throw Object.assign(new Error('相同任务编号已属于其他店铺或任务类型，请更换任务编号后重新提交。'), { publicCode: 'background_job_scope_conflict' });
        }
        // The existing worker owns its original task and parent; a duplicate must not create an orphan task.
        if (!transaction) await client.query('COMMIT');
        return { job: current, duplicate: true };
      }
      const active = await client.query(
        `SELECT count(*)::int AS count FROM background_jobs
         WHERE tenant_id=$1 AND state IN ('queued','running','retry')
           AND (job_type<>'orders_sync' OR context->>'source'='manual_server_fallback')`,
        [account.tenantId]
      );
      // 父任务在同一事务内最后登记；登记前的全部子任务仍须容纳在本次批量上限内。
      const admissionLimit = ['sku_image_ai', 'sku_image_ai_batch'].includes(job.type) ? 2000 : 500;
      if (Number(active.rows[0].count) >= admissionLimit) {
        throw Object.assign(new Error('后台任务队列已满，请稍后再提交。'), { publicCode: 'background_job_queue_full' });
      }
      const inserted = await client.query(
        `INSERT INTO background_jobs
          (tenant_id, job_id, actor_user_id, job_type, dedupe_key, context, max_attempts, available_at, state)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [account.tenantId, job.id, account.userId, job.type, job.dedupeKey,
          JSON.stringify(job.context), job.maxAttempts, job.availableAt, job.initialState]
      );
      const result = inserted.rowCount ? inserted : await client.query(
        `SELECT * FROM background_jobs
         WHERE tenant_id=$1 AND (job_id=$2 OR (job_type=$3 AND dedupe_key=$4
           AND state IN ('queued','running','retry')))
         ORDER BY CASE WHEN job_id=$2 THEN 0 ELSE 1 END, created_at LIMIT 1`,
        [account.tenantId, job.id, job.type, job.dedupeKey]
      );
      if (queuedTask && inserted.rowCount) await this.upsertSyncTask(account, queuedTask, client);
      if (!transaction) await client.query('COMMIT');
      return { job: mapBackgroundJob(result.rows[0]), duplicate: !inserted.rowCount };
    } catch (error) {
      if (!transaction) await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { if (!transaction) client.release(); }
  }


  async cancelBackgroundJob(account, jobId, expectedType) {
    const id = String(jobId || '').trim().slice(0, 120);
    const type = String(expectedType || '').trim().slice(0, 40);
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(id) || !type) throw Object.assign(new Error('只有排队中或正在执行的任务可以取消，已完成或已失败的任务不能取消。'), { publicCode: 'background_job_cancel_invalid' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      const result = await client.query(
        `UPDATE background_jobs
         SET state='cancelled', ended_at=now(), lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
         WHERE tenant_id=$1 AND job_id=$2 AND actor_user_id=$3 AND job_type=$4
           AND state IN ('queued','retry')
         RETURNING *`,
        [account.tenantId, id, account.userId, type]
      );
      await client.query('COMMIT');
      return mapBackgroundJob(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async claimBackgroundJobs(workerId, limit = 1, leaseMs = 60000) {
    const owner = String(workerId || '').trim().slice(0, 120);
    if (!owner) throw new Error('后台任务领取凭据无效，请重新领取任务。');
    const count = Math.max(1, Math.min(20, Math.floor(Number(limit) || 1)));
    const lease = Math.max(5000, Math.min(900000, Math.floor(Number(leaseMs) || 60000)));
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT tenant_id, job_id
         FROM background_jobs
         WHERE ((state IN ('queued','retry') AND available_at <= now())
             OR (state='running' AND lease_expires_at < now()))
           AND (attempts < max_attempts OR (job_type='sku_image_ai' AND context ? 'providerTaskId'))
           AND (job_type<>'orders_sync' OR context->>'source'='manual_server_fallback')
           AND NOT EXISTS (
             SELECT 1 FROM sync_tasks child JOIN background_jobs parent
               ON parent.tenant_id=child.tenant_id AND parent.job_id=child.parent_task_id
              WHERE child.tenant_id=background_jobs.tenant_id AND child.task_id=background_jobs.job_id
                AND parent.job_type='sku_image_ai_batch' AND parent.state IN ('queued','running','retry')
           )
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE background_jobs job
       SET state='running', lease_owner=$2,
           lease_expires_at=now() + ($3 * interval '1 millisecond'),
           attempts=job.attempts + 1, started_at=COALESCE(job.started_at,now()),
           updated_at=now(), ended_at=NULL
       FROM candidates
       WHERE job.tenant_id=candidates.tenant_id AND job.job_id=candidates.job_id
       RETURNING job.*`,
      [count, owner, lease]
    );
    return result.rows.map(mapBackgroundJob);
  }

  async claimSkuImageBatchChildren(tenantId, parentId, workerId, leaseMs = 120000) {
    const lease = Math.max(5000, Math.min(900000, Number(leaseMs) || 120000));
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT job.tenant_id,job.job_id FROM background_jobs job
         JOIN sync_tasks task ON task.tenant_id=job.tenant_id AND task.task_id=job.job_id
         WHERE job.tenant_id=$1 AND task.parent_task_id=$2 AND job.job_type='sku_image_ai'
           AND job.state IN ('queued','retry') AND job.available_at<=now()
           AND (job.attempts<job.max_attempts OR job.context ? 'providerTaskId')
         FOR UPDATE OF job SKIP LOCKED
       ) UPDATE background_jobs job SET state='running',lease_owner=$3,
           lease_expires_at=now()+($4*interval '1 millisecond'),attempts=job.attempts+1,
           started_at=COALESCE(job.started_at,now()),updated_at=now(),ended_at=NULL
         FROM candidates WHERE job.tenant_id=candidates.tenant_id AND job.job_id=candidates.job_id
         RETURNING job.*`, [tenantId, parentId, workerId, lease]);
    return result.rows.map(mapBackgroundJob);
  }

  async skuImageBatchChildStates(tenantId, parentId) {
    const result = await this.pool.query(
      `SELECT state,count(*)::integer AS count,min(available_at) AS next_available
         FROM background_jobs job JOIN sync_tasks task
           ON task.tenant_id=job.tenant_id AND task.task_id=job.job_id
        WHERE job.tenant_id=$1 AND task.parent_task_id=$2 AND job.job_type='sku_image_ai'
        GROUP BY state`, [tenantId, parentId]);
    return result.rows;
  }

  async markSkuImageBatchStarted(tenantId, parentId) {
    await this.pool.query(
      `UPDATE sync_tasks SET status='running',progress_label='正在执行图片子任务',updated_at=now()
        WHERE tenant_id=$1 AND task_id=$2 AND status='running'`, [tenantId, parentId]);
  }

  async markSkuImageBatchChildFailed(tenantId, childId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE sync_tasks SET status='failed',progress_label='图片生成失败，请查看处理详情',
           failure_reason='后台处理未能完成，请查看处理详情',ended_at=now(),updated_at=now()
          WHERE tenant_id=$1 AND task_id=$2 RETURNING parent_task_id`,
        [tenantId, childId]);
      if (result.rows[0]?.parent_task_id) await this.refreshSkuImageBatchParent(client, tenantId, result.rows[0].parent_task_id);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async renewBackgroundJobLease(tenantId, jobId, workerId, leaseMs = 60000) {
    const lease = Math.max(5000, Math.min(900000, Math.floor(Number(leaseMs) || 60000)));
    const result = await this.pool.query(
      `UPDATE background_jobs
       SET lease_expires_at=now()+($4*interval '1 millisecond'), updated_at=now()
       WHERE tenant_id=$1 AND job_id=$2 AND state='running' AND lease_owner=$3
       RETURNING job_id`,
      [tenantId, jobId, String(workerId || '').slice(0, 120), lease]
    );
    return result.rowCount === 1;
  }

  async recoverExpiredBackgroundJobs() {
    const client = await this.pool.connect();
    try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE background_jobs
       SET state=CASE WHEN job_type='bug_email' THEN 'unknown' WHEN attempts < max_attempts OR (job_type='sku_image_ai' AND context ? 'providerTaskId') THEN 'retry' ELSE 'failed' END,
           available_at=CASE WHEN job_type<>'bug_email' AND (attempts < max_attempts OR (job_type='sku_image_ai' AND context ? 'providerTaskId')) THEN now() ELSE available_at END,
           last_error=CASE WHEN job_type='bug_email' THEN 'worker_lease_expired_delivery_unknown' ELSE 'worker_lease_expired' END,
           lease_owner=NULL, lease_expires_at=NULL,
           ended_at=CASE WHEN job_type<>'bug_email' AND (attempts < max_attempts OR (job_type='sku_image_ai' AND context ? 'providerTaskId')) THEN NULL ELSE now() END,
           updated_at=now()
       WHERE state='running' AND lease_expires_at < now()
         AND (job_type<>'orders_sync' OR context->>'source'='manual_server_fallback')
       RETURNING tenant_id,job_id,job_type,state`);
    for (const row of result.rows.filter(item => ['sku_image_ai','product_video_compose'].includes(item.job_type) && item.state === 'failed')) {
      const task = await client.query(
        `UPDATE sync_tasks SET status='failed', progress_label='后台处理超时，请查看失败原因',
           failure_reason='后台处理超时，任务未能完成', ended_at=now(), updated_at=now()
         WHERE tenant_id=$1 AND task_id=$2
         RETURNING parent_task_id`, [row.tenant_id, row.job_id]);
      if (row.job_type === 'sku_image_ai' && task.rows[0]?.parent_task_id) await this.refreshSkuImageBatchParent(client, row.tenant_id, task.rows[0].parent_task_id);
    }
    await client.query('COMMIT');
    return result.rows.reduce((summary, row) => {
      summary[row.state] = (summary[row.state] || 0) + 1;
      return summary;
    }, {});
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async checkpointBackgroundJob(job, workerId, patch) {
    const next = { ...(job && job.context || {}), ...(patch && typeof patch === 'object' ? patch : {}) };
    if (containsSecret(next) || Buffer.byteLength(JSON.stringify(next), 'utf8') > 65536) {
      throw Object.assign(new Error('任务上下文数据不完整，无法排队执行，请重新发起一次。'), { publicCode: 'background_job_context_invalid' });
    }
    const result = await this.pool.query(
      `UPDATE background_jobs SET context=$4::jsonb, updated_at=now()
       WHERE tenant_id=$1 AND job_id=$2 AND state='running' AND lease_owner=$3
       RETURNING *`,
      [job.tenantId, job.id, String(workerId || '').slice(0, 120), JSON.stringify(next)]
    );
    if (!result.rowCount) throw Object.assign(new Error('任务执行权已被其他工作进程取走，本进程停止继续处理。'), { publicCode: 'background_job_lease_lost' });
    return mapBackgroundJob(result.rows[0]);
  }

  async getSkuImageAiPromptTask(account, jobId) {
    const id = String(jobId || '').trim().slice(0, 120);
    if (!/^sku-image-ai-[A-Za-z0-9-]{8,110}$/.test(id)) throw Object.assign(new Error('AI生图任务参数不完整，请重新发起一次重绘。'), { publicCode: 'sku_image_ai_task_invalid', status: 400 });
    const values = [account.tenantId, id];
    let actor = '';
    if (!account.isSystemAdmin) { values.push(account.userId); actor = ' AND actor_user_id=$3'; }
    const result = await this.pool.query(`SELECT * FROM background_jobs WHERE tenant_id=$1 AND job_id=$2 AND job_type='sku_image_ai'${actor}`, values);
    if (!result.rowCount) throw Object.assign(new Error('未找到这个AI生图任务，请刷新任务中心后重试。'), { publicCode: 'sku_image_ai_task_not_found', status: 404 });
    return mapBackgroundJob(result.rows[0]);
  }

  async getProductVideoComposeTask(account, jobId) {
    const id = String(jobId || '').trim().slice(0, 120);
    if (!/^product-video-compose-[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('视频合成任务编号不正确，请刷新商品页面后重试。'), { publicCode: 'product_video_task_invalid', status: 400 });
    const values = [account.tenantId, id];
    let actor = '';
    if (!account.isSystemAdmin) { values.push(account.userId); actor = ' AND actor_user_id=$3'; }
    const result = await this.pool.query(`SELECT * FROM background_jobs WHERE tenant_id=$1 AND job_id=$2 AND job_type='product_video_compose'${actor}`, values);
    if (!result.rowCount) throw Object.assign(new Error('未找到这个视频合成任务，请刷新商品页面后重试。'), { publicCode: 'product_video_task_not_found', status: 404 });
    return mapBackgroundJob(result.rows[0]);
  }

  async mergeOrderSyncBatch(account, clientId, orders, runId, allowedHosts) {
    clientId = String(clientId || '').trim();
    runId = String(runId || '').trim();
    if (!clientId || !/^[A-Za-z0-9._:-]{8,120}$/.test(runId) || !Array.isArray(orders) || !orders.length || orders.length > 100) {
      throw Object.assign(new Error('订单同步批次数据不完整，已拒收，请重新发起一次同步。'), { publicCode: 'order_sync_batch_invalid' });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(
        `INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id)
         VALUES ($1,'erp_orders_data',1,'array',$2) ON CONFLICT (tenant_id,document_key) DO NOTHING`,
        [account.tenantId, account.userId]
      );
      await client.query(`SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data' FOR UPDATE`, [account.tenantId]);
      const scoped = orders.map(item => ({ ...item, clientId }));
      const current = await currentOrderPayloadsForSync(client, account.tenantId, clientId, scoped);
      await reconcileOrderManualData(client, account.tenantId, scoped, current);
      const platformPayload = normalizePlatformPayload('erp_orders_data', scoped, allowedHosts);
      const normalized = rowsForPayload('erp_orders_data', platformPayload.map(item => ({ ...item, _syncRunId: runId })));
      const upsertRowsByKey = new Map();
      normalized.rows.forEach(row => {
        const item = row.payload || {};
        // The former sequential UPSERT allowed a repeated posting in the same
        // batch to replace its earlier occurrence. PostgreSQL rejects two
        // conflicts with one target row in a single INSERT, so retain the last
        // occurrence to preserve the old winner without retrying the batch.
        upsertRowsByKey.set(row.recordKey, { record_key: row.recordKey, position: row.position,
          posting_number: String(item.posting || item.posting_number || '').slice(0, 180) || null,
          platform_record_id: String(item.platformRecordId), payload: item });
      });
      const upsertRows = Array.from(upsertRowsByKey.values());
      // Reuse the client-order writer's bulk upsert instead of up to 100
      // sequential SQL round trips while holding a tenant version lock.
      if (upsertRows.length) await client.query(
        `INSERT INTO business_orders (tenant_id,record_key,position,posting_number,shop_external_id,platform_source,platform_record_id,payload,updated_by_user_id)
         SELECT $1,row.record_key,row.position,row.posting_number,$2,'ozon',row.platform_record_id,row.payload,$3
         FROM jsonb_to_recordset($4::jsonb) AS row(record_key text,position integer,posting_number text,platform_record_id text,payload jsonb)
         ON CONFLICT (tenant_id,record_key) DO UPDATE SET posting_number=EXCLUDED.posting_number,shop_external_id=EXCLUDED.shop_external_id,
           platform_source='ozon',platform_record_id=EXCLUDED.platform_record_id,payload=EXCLUDED.payload,
           updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
        [account.tenantId, clientId, account.userId, JSON.stringify(upsertRows)]
      );
      const saved = await client.query(
        `UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now()
         WHERE tenant_id=$1 AND document_key='erp_orders_data' RETURNING version,updated_at`,
        [account.tenantId, account.userId]
      );
      await client.query('COMMIT');
      return { count: normalized.rows.length, version: Number(saved.rows[0].version), updatedAt: saved.rows[0].updated_at };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async applyOrderExchangeRateBatch(account, clientId, patches) {
    clientId = String(clientId || '').trim();
    if (!clientId || !Array.isArray(patches) || !patches.length || patches.length > 100) {
      throw Object.assign(new Error('订单历史汇率批次数据不完整，已拒收。'), { publicCode: 'order_exchange_rate_batch_invalid' });
    }
    const normalized = patches.map(item => {
      const posting = String(item && item.posting || '').trim();
      const rubPerCny = Number(item && item.rubPerCny);
      const cnyPerRub = Number(item && item.cnyPerRub);
      const rateDate = String(item && item.rateDate || '').slice(0, 10);
      const effectiveDate = String(item && item.effectiveDate || '').slice(0, 10);
      const source = String(item && item.source || '').trim();
      if (!posting || !(rubPerCny > 0) || !(cnyPerRub > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(rateDate) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) || effectiveDate > rateDate || source !== 'bank_of_russia') {
        throw Object.assign(new Error('订单历史汇率记录不合法，已拒收。'), { publicCode: 'order_exchange_rate_patch_invalid' });
      }
      return {
        posting,
        rubPerCny: Math.round(rubPerCny * 10000) / 10000,
        cnyPerRub: Math.round(cnyPerRub * 100000000) / 100000000,
        rateDate,
        effectiveDate,
        source
      };
    });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(
        "INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id) " +
        "VALUES ($1,'erp_orders_data',1,'array',$2) ON CONFLICT (tenant_id,document_key) DO NOTHING",
        [account.tenantId, account.userId]
      );
      await client.query("SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data' FOR UPDATE", [account.tenantId]);
      let updated = 0;
      const lockedAt = new Date().toISOString();
      for (const item of normalized) {
        const financePatch = {
          orderRubPerCny: item.rubPerCny,
          orderCnyPerRub: item.cnyPerRub,
          orderRateDate: item.rateDate,
          orderRateEffectiveDate: item.effectiveDate,
          orderRateSource: item.source,
          orderRateLockedAt: lockedAt
        };
        const result = await client.query(
          "UPDATE business_orders SET payload=jsonb_set(payload,'{finance}',COALESCE(payload->'finance','{}'::jsonb) || $4::jsonb,true), " +
          "updated_by_user_id=$5,updated_at=now() WHERE tenant_id=$1 AND shop_external_id=$2 AND posting_number=$3",
          [account.tenantId, clientId, item.posting, JSON.stringify(financePatch), account.userId]
        );
        updated += result.rowCount;
      }
      let version = null, savedAt = null;
      if (updated) {
        const saved = await client.query(
          "UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now() " +
          "WHERE tenant_id=$1 AND document_key='erp_orders_data' RETURNING version,updated_at",
          [account.tenantId, account.userId]
        );
        version = Number(saved.rows[0].version);
        savedAt = saved.rows[0].updated_at;
        await this.writeAudit(client, account, 'order.exchange_rate_lock', 'shop', clientId, 'success', { updated, requested: normalized.length, source: 'bank_of_russia' });
      }
      await client.query('COMMIT');
      return { count: updated, requested: normalized.length, version, updatedAt: savedAt };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async applyOrderNetIncomeBatch(account, clientId, patches) {
    clientId = String(clientId || '').trim();
    if (!clientId || !Array.isArray(patches) || !patches.length || patches.length > 100) {
      throw Object.assign(new Error('订单净收入同步批次数据不完整，已拒收。'), { publicCode: 'order_net_income_batch_invalid' });
    }
    const normalized = patches.map(item => {
      const posting = String(item && item.posting || '').trim();
      const value = Number(item && item.value);
      const source = String(item && item.source || '').trim();
      const accrualDate = String(item && item.accrualDate || '').slice(0, 10);
      const accrualCount = Math.max(0, Number(item && item.accrualCount) || 0);
      if (!posting || !Number.isFinite(value) || source !== 'ozon_finance_accrual_by_day_total_amount' || !/^\d{4}-\d{2}-\d{2}$/.test(accrualDate)) {
        throw Object.assign(new Error('订单净收入同步记录不合法，已拒收。'), { publicCode: 'order_net_income_patch_invalid' });
      }
      return { posting, value: Math.round(value * 100) / 100, source, accrualDate, accrualCount };
    });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(
        "INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id) " +
        "VALUES ($1,'erp_orders_data',1,'array',$2) ON CONFLICT (tenant_id,document_key) DO NOTHING",
        [account.tenantId, account.userId]
      );
      await client.query("SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data' FOR UPDATE", [account.tenantId]);
      let updated = 0;
      const updatedAt = new Date().toISOString();
      for (const item of normalized) {
        const financePatch = {
          ozonNetIncomeRub: item.value,
          ozonNetIncomeRubSource: item.source,
          ozonNetIncomeAccrualDate: item.accrualDate,
          ozonNetIncomeAccrualCount: item.accrualCount,
          ozonNetIncomeUpdatedAt: updatedAt
        };
        const result = await client.query(
          "UPDATE business_orders SET payload=jsonb_set(payload,'{finance}',COALESCE(payload->'finance','{}'::jsonb) || $4::jsonb,true), " +
          "updated_by_user_id=$5,updated_at=now() WHERE tenant_id=$1 AND shop_external_id=$2 AND posting_number=$3",
          [account.tenantId, clientId, item.posting, JSON.stringify(financePatch), account.userId]
        );
        updated += result.rowCount;
      }
      let version = null, savedAt = null;
      if (updated) {
        const saved = await client.query(
          "UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now() " +
          "WHERE tenant_id=$1 AND document_key='erp_orders_data' RETURNING version,updated_at",
          [account.tenantId, account.userId]
        );
        version = Number(saved.rows[0].version);
        savedAt = saved.rows[0].updated_at;
        await this.writeAudit(client, account, 'order.net_income_sync', 'shop', clientId, 'success', { updated, requested: normalized.length, source: 'ozon_finance_accrual_by_day_total_amount' });
      }
      await client.query('COMMIT');
      return { count: updated, requested: normalized.length, version, updatedAt: savedAt };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async finalizeOrderSync(account, clientId, runId) {
    clientId = String(clientId || '').trim();
    runId = String(runId || '').trim();
    if (!clientId || !/^[A-Za-z0-9._:-]{8,120}$/.test(runId)) throw Object.assign(new Error('订单同步收尾数据不完整，请先确认本页数据全部提交后再收尾。'), { publicCode: 'order_sync_finalize_invalid' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(`SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data' FOR UPDATE`, [account.tenantId]);
      const cleaned = await client.query(
        `UPDATE business_orders SET payload=payload-'_syncRunId',updated_at=now(),updated_by_user_id=$4
         WHERE tenant_id=$1 AND shop_external_id=$2 AND payload->>'_syncRunId'=$3`,
        [account.tenantId, clientId, runId, account.userId]
      );
      const saved = await client.query(
        `UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now()
         WHERE tenant_id=$1 AND document_key='erp_orders_data' RETURNING version,updated_at`,
        [account.tenantId, account.userId]
      );
      await this.writeAudit(client, account, 'order.background_sync', 'shop', clientId, 'success', { synchronized: cleaned.rowCount, historicalOrdersDeleted: 0 });
      await client.query('COMMIT');
      return { synchronized: cleaned.rowCount, removed: 0, version: Number(saved.rows[0].version), updatedAt: saved.rows[0].updated_at };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async mergeProductSyncBatch(account, clientId, products, runId, allowedHosts) {
    clientId = String(clientId || '').trim();
    runId = String(runId || '').trim();
    if (!clientId || !/^[A-Za-z0-9._:-]{8,120}$/.test(runId) || !Array.isArray(products) || !products.length || products.length > 100) {
      throw Object.assign(new Error('商品同步批次数据不完整，已拒收，请重新发起一次同步。'), { publicCode: 'product_sync_batch_invalid' });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(
        `INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id)
         VALUES ($1,'erp_online_products',1,'array',$2) ON CONFLICT (tenant_id,document_key) DO NOTHING`,
        [account.tenantId, account.userId]
      );
      await client.query(`SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_online_products' FOR UPDATE`, [account.tenantId]);
      const current = await client.query(`SELECT record_key,payload,updated_at FROM business_products WHERE tenant_id=$1 AND shop_external_id=$2 ORDER BY updated_at DESC,record_key FOR UPDATE`, [account.tenantId, clientId]);
      const scoped = products.map(item => ({ ...item, clientId }));
      const preserved = preserveProductLocalFieldsForSync(scoped, current.rows.map(row => ({ ...(row.payload && typeof row.payload === 'object' ? row.payload : {}), clientId })));
      const platformPayload = normalizePlatformPayload('erp_online_products', preserved, allowedHosts);
      const normalized = rowsForPayload('erp_online_products', platformPayload.map(item => ({ ...item, _syncRunId: runId })));
      for (const row of normalized.rows) {
        const item = row.payload || {};
        const productId = String(item.id || item.productId || '').trim();
        if (productId) {
          const duplicates = current.rows.filter(existing => String(existing.payload && (existing.payload.id || existing.payload.productId) || '').trim() === productId);
          const protectedRows = duplicates.filter(existing => {
            const state = existing.payload && existing.payload.ozonEdit;
            return Boolean(existing.payload && existing.payload.editorDraft) || Boolean(state && ['queued', 'preparing', 'submitting', 'pending', 'unknown'].includes(state.phase));
          });
          if (protectedRows.length > 1) throw Object.assign(new Error('同一商品存在多条受保护编辑记录，请先完成正在进行的编辑任务后再同步。'), { publicCode: 'product_sync_duplicate_protected' });
          if (protectedRows.length === 1) row.recordKey = protectedRows[0].record_key;
          const duplicateKeys = duplicates.map(existing => String(existing.record_key)).filter(recordKey => recordKey && recordKey !== row.recordKey);
          if (duplicateKeys.length) await client.query(`DELETE FROM business_products WHERE tenant_id=$1 AND shop_external_id=$2 AND record_key=ANY($3::varchar[])`, [account.tenantId, clientId, duplicateKeys]);
        }
        await client.query(
          `INSERT INTO business_products
             (tenant_id,record_key,position,offer_id,shop_external_id,platform_source,platform_record_id,payload,updated_by_user_id)
           VALUES ($1,$2,$3,$4,$5,'ozon',$6,$7::jsonb,$8)
           ON CONFLICT (tenant_id,record_key) DO UPDATE SET
             offer_id=EXCLUDED.offer_id,shop_external_id=EXCLUDED.shop_external_id,platform_source='ozon',
             platform_record_id=EXCLUDED.platform_record_id,payload=EXCLUDED.payload,
             updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
          [account.tenantId, row.recordKey, row.position,
            String(item.offer_id || item.article || item.sku || '').slice(0, 180) || null,
            clientId, String(item.platformRecordId), JSON.stringify(item), account.userId]
        );
        await client.query(
          `INSERT INTO product_costs
             (tenant_id,product_record_key,purchase_amount,source_amount,domestic_shipping_amount,supplier_url,supplier_note,updated_by_user_id)
           VALUES ($1,$2,$3::numeric,$4::numeric,$5::numeric,$6,$7,$8)
           ON CONFLICT (tenant_id,product_record_key) DO UPDATE SET
             purchase_amount=EXCLUDED.purchase_amount,source_amount=EXCLUDED.source_amount,
             domestic_shipping_amount=EXCLUDED.domestic_shipping_amount,supplier_url=EXCLUDED.supplier_url,
             supplier_note=EXCLUDED.supplier_note,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
          [account.tenantId, row.recordKey, nullableAmount(item.purchasePrice), nullableAmount(item.srcPrice), nullableAmount(item.domesticShipping),
            String(item.srcUrl || item.sourceUrl || '') || null, String(item.srcNote || '').slice(0, 1000) || null, account.userId]
        );
      }
      const saved = await client.query(
        `UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now()
         WHERE tenant_id=$1 AND document_key='erp_online_products' RETURNING version,updated_at`,
        [account.tenantId, account.userId]
      );
      await client.query('COMMIT');
      return { count: normalized.rows.length, version: Number(saved.rows[0].version), updatedAt: saved.rows[0].updated_at };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async finalizeProductSync(account, clientId, runId, fullSync) {
    clientId = String(clientId || '').trim();
    runId = String(runId || '').trim();
    if (!clientId || !/^[A-Za-z0-9._:-]{8,120}$/.test(runId)) throw Object.assign(new Error('商品同步收尾数据不完整，请先确认本页数据全部提交后再收尾。'), { publicCode: 'product_sync_finalize_invalid' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(`SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_online_products' FOR UPDATE`, [account.tenantId]);
      let removed = 0;
      if (fullSync) {
        const deleted = await client.query(
          `DELETE FROM business_products WHERE tenant_id=$1 AND shop_external_id=$2
             AND COALESCE(payload->>'_syncRunId','')<>$3
             AND COALESCE(payload->'ozonEdit'->>'phase','') NOT IN ('queued','preparing','submitting','pending','unknown')
             AND NOT (payload ? 'editorDraft')`,
          [account.tenantId, clientId, runId]
        );
        removed = deleted.rowCount;
      }
      const cleaned = await client.query(
        `UPDATE business_products SET payload=payload-'_syncRunId',updated_at=now(),updated_by_user_id=$4
         WHERE tenant_id=$1 AND shop_external_id=$2 AND payload->>'_syncRunId'=$3`,
        [account.tenantId, clientId, runId, account.userId]
      );
      const saved = await client.query(
        `UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now()
         WHERE tenant_id=$1 AND document_key='erp_online_products' RETURNING version,updated_at`,
        [account.tenantId, account.userId]
      );
      await this.writeAudit(client, account, 'product.background_sync', 'shop', clientId, 'success', { synchronized: cleaned.rowCount, removed, fullSync: fullSync === true });
      await client.query('COMMIT');
      return { synchronized: cleaned.rowCount, removed, version: Number(saved.rows[0].version), updatedAt: saved.rows[0].updated_at };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async getBackgroundJobMetrics() {
    try {
      const [result, recentResult] = await Promise.all([this.pool.query(
        `SELECT job_type, state, count(*)::int AS count,
                round(avg(extract(epoch FROM (now() - created_at)))::numeric, 3)::float8 AS average_age_seconds,
                round(max(extract(epoch FROM (now() - created_at)))::numeric, 3)::float8 AS oldest_age_seconds
         FROM background_jobs
         GROUP BY job_type, state
         ORDER BY job_type, state`
      ), this.pool.query(
        `SELECT
           count(*) FILTER (WHERE ended_at >= now()-interval '1 hour' AND state='done')::int AS hour_done,
           count(*) FILTER (WHERE ended_at >= now()-interval '1 hour' AND state='failed')::int AS hour_failed,
           count(*) FILTER (WHERE ended_at >= now()-interval '1 hour' AND state='unknown')::int AS hour_unknown,
           count(*) FILTER (WHERE ended_at >= now()-interval '1 hour' AND state='cancelled')::int AS hour_cancelled,
           count(*) FILTER (WHERE ended_at >= now()-interval '24 hours' AND state='done')::int AS day_done,
           count(*) FILTER (WHERE ended_at >= now()-interval '24 hours' AND state='failed')::int AS day_failed,
           count(*) FILTER (WHERE ended_at >= now()-interval '24 hours' AND state='unknown')::int AS day_unknown,
           count(*) FILTER (WHERE ended_at >= now()-interval '24 hours' AND state='cancelled')::int AS day_cancelled
         FROM background_jobs`
      )]);
      const totals = {};
      const byType = {};
      let oldestWaitingSeconds = 0;
      for (const row of result.rows) {
        const type = String(row.job_type || 'unknown');
        const state = String(row.state || 'unknown');
        const count = Number(row.count) || 0;
        const item = { count, averageAgeSeconds: Number(row.average_age_seconds) || 0, oldestAgeSeconds: Number(row.oldest_age_seconds) || 0 };
        if (!byType[type]) byType[type] = {};
        byType[type][state] = item;
        totals[state] = (totals[state] || 0) + count;
        if (state === 'queued' || state === 'retry') oldestWaitingSeconds = Math.max(oldestWaitingSeconds, item.oldestAgeSeconds);
      }
      const recent = recentResult.rows[0] || {};
      function windowMetrics(prefix) {
        const done = Number(recent[prefix + '_done']) || 0;
        const failed = Number(recent[prefix + '_failed']) || 0;
        const unknown = Number(recent[prefix + '_unknown']) || 0;
        const cancelled = Number(recent[prefix + '_cancelled']) || 0;
        const decided = done + failed + unknown;
        return { done, failed, unknown, cancelled, decided, errorRate: decided ? Math.round((failed + unknown) / decided * 10000) / 10000 : 0 };
      }
      return { available: true, totals, byType, oldestWaitingSeconds, recent: { hour: windowMetrics('hour'), day: windowMetrics('day') } };
    } catch (error) {
      if (error && error.code === '42P01') return { available: false, totals: {}, byType: {}, oldestWaitingSeconds: 0, recent: { hour: {}, day: {} } };
      throw error;
    }
  }

  async cleanupExpiredProductCreateDrafts(options = {}) {
    const create = require('./product-create');
    const combinationStore = require('./product-combination-store');
    const now = options.now instanceof Date ? options.now.getTime() : Number(options.now);
    const currentNow = Number.isFinite(now) ? now : Date.now();
    const tenants = await this.pool.query(
      `SELECT tenant_id
         FROM tenant_documents
        WHERE document_key=$1
        ORDER BY tenant_id ASC`,
      [create.DRAFT_KEY]
    );
    let removed = 0, changedTenants = 0, scannedTenants = 0;
    for (const tenantRow of tenants.rows) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const current = await client.query(
          `SELECT payload FROM tenant_documents
            WHERE tenant_id=$1 AND document_key=$2 FOR UPDATE`,
          [tenantRow.tenant_id, create.DRAFT_KEY]
        );
        if (!current.rowCount) {
          await client.query('ROLLBACK');
          continue;
        }
        scannedTenants += 1;
        const graphResult = await client.query(
          `SELECT payload FROM tenant_documents WHERE tenant_id=$1 AND document_key=$2`,
          [tenantRow.tenant_id, combinationStore.DOCUMENT_KEY]
        );
        const graphPayload = graphResult.rowCount ? graphResult.rows[0].payload : null;
        const existing = Array.isArray(current.rows[0].payload) ? current.rows[0].payload : [];
        const ownerIds = [...new Set(existing.map(item => Number(item && item.ownerUserId) || 0).filter(Boolean))];
        let next = existing, removedIds = [];
        for (const ownerUserId of ownerIds) {
          const retained = create.pruneDrafts(next, ownerUserId, graphPayload, currentNow);
          next = retained.drafts;
          removedIds = removedIds.concat(retained.removedIds);
        }
        if (JSON.stringify(existing) !== JSON.stringify(next)) {
          await client.query(
            `UPDATE tenant_documents
                SET payload=$3::jsonb,version=version+1,updated_at=now()
              WHERE tenant_id=$1 AND document_key=$2`,
            [tenantRow.tenant_id, create.DRAFT_KEY, JSON.stringify(next)]
          );
          changedTenants += 1;
          removed += removedIds.length;
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    return { scannedTenants, changedTenants, removedDrafts: removed };
  }

  async cleanupBackgroundJobs(options = {}) {
    const terminalDays = Math.max(7, Math.min(365, Math.floor(Number(options.terminalDays) || 30)));
    const unknownDays = Math.max(30, Math.min(730, Math.floor(Number(options.unknownDays) || 90)));
    try {
      const result = await this.pool.query(
        `DELETE FROM background_jobs
         WHERE (state IN ('done','failed','cancelled') AND COALESCE(ended_at,updated_at) < now() - make_interval(days => $1))
            OR (state = 'unknown' AND COALESCE(ended_at,updated_at) < now() - make_interval(days => $2))`,
        [terminalDays, unknownDays]
      );
      return result.rowCount;
    } catch (error) {
      if (error && error.code === '42P01') return 0;
      throw error;
    }
  }

  async finishBackgroundJob(tenantId, jobId, workerId, outcome = {}) {
    const state = ['done', 'failed', 'cancelled', 'unknown', 'retry'].includes(outcome.state) ? outcome.state : 'done';
    const delayMs = Math.max(0, Math.min(86400000, Math.floor(Number(outcome.delayMs) || 0)));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE background_jobs
         SET state=$4::varchar, last_error=$5, lease_owner=NULL, lease_expires_at=NULL,
             available_at=CASE WHEN $4::varchar='retry' THEN now()+($6*interval '1 millisecond') ELSE available_at END,
             ended_at=CASE WHEN $4::varchar='retry' THEN NULL ELSE now() END, updated_at=now()
         WHERE tenant_id=$1 AND job_id=$2 AND state='running' AND lease_owner=$3
         RETURNING *`,
        [tenantId, jobId, String(workerId || '').slice(0, 120), state,
          String(outcome.error || '').slice(0, 1500), delayMs]
      );
      if (result.rows[0] && state !== 'retry') {
        const task = await client.query(`SELECT parent_task_id FROM sync_tasks WHERE tenant_id=$1 AND task_id=$2 LIMIT 1`, [tenantId, jobId]);
        const parentTaskId = task.rows[0] && task.rows[0].parent_task_id;
        if (parentTaskId) {
          await this.refreshSkuImageBatchParent(client, tenantId, parentTaskId);
          await this.refreshSyncBatchParent(client, tenantId, parentTaskId);
        }
      }
      await client.query('COMMIT');
      return mapBackgroundJob(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }


  async backgroundJobActor(job) {
    return this.productEditActor(job.tenantId, job.actorUserId);
  }

  async markBackgroundJobRetryVisible(job, delayMs) {
    const actor = await this.backgroundJobActor(job);
    if (!actor || !actor.enabled) return null;
    const names = { shops_sync: '店铺同步', products_sync: '在线商品同步（服务器资源）', orders_sync: job.context && job.context.source === 'manual_server_fallback' ? '订单同步（服务器资源）' : '订单同步', category_attributes: '三级类目属性全量同步', sku_image_ai: job.context && job.context.taskName || 'AI图片重绘', product_video_compose: '商品图片合成视频' };
    const seconds = Math.max(1, Math.ceil((Number(delayMs) || 0) / 1000));
    return this.upsertSyncTask(actor, { id: job.id, type: job.type === 'product_video_compose' ? 'edit' : 'sync', status: 'running', value: 0, name: names[job.type] || '后台同步', label: `暂时失败，约 ${seconds} 秒后自动重试`, reason: '服务器将自动重试，无需重复提交', startedAt: job.createdAt });
  }

  async refreshSkuImageBatchParent(client, tenantId, parentId) {
    if (!String(parentId || '').startsWith('sync-sku-ai-')) return;
    await client.query(`WITH children AS (
      SELECT COUNT(*)::integer AS total,
             COUNT(*) FILTER (WHERE COALESCE(job.state,task.status)='done')::integer AS done,
             COUNT(*) FILTER (WHERE COALESCE(job.state,task.status) IN ('failed','cancelled','unknown'))::integer AS failed
        FROM sync_tasks task LEFT JOIN background_jobs job
          ON job.tenant_id=task.tenant_id AND job.job_id=task.task_id
       WHERE task.tenant_id=$1 AND task.parent_task_id=$2
    ) UPDATE sync_tasks AS parent
       SET status=CASE WHEN children.failed>0 THEN 'failed'
                       WHEN children.done=children.total THEN 'done' ELSE 'running' END,
           progress_value=CASE WHEN children.total>0 THEN FLOOR(100.0*(children.done+children.failed)/children.total)::integer ELSE 0 END,
           progress_label=CASE WHEN children.failed>0 AND children.done+children.failed<children.total THEN '部分图片生成失败，其余图片继续处理'
                               WHEN children.failed>0 THEN '部分图片生成失败，请展开查看'
                               WHEN children.done<children.total THEN '正在生成批量图片'
                               ELSE '批量图片已生成，请展开查看' END,
           ended_at=CASE WHEN children.done+children.failed=children.total THEN now() ELSE NULL END,
           updated_at=now()
      FROM children WHERE parent.tenant_id=$1 AND parent.task_id=$2`, [tenantId, parentId]);
  }

  async refreshSyncBatchParent(client, tenantId, parentId) {
    parentId = String(parentId || '').trim();
    if (!parentId || parentId.startsWith('sync-sku-ai-')) return;
    await client.query(`WITH child_states AS (
      SELECT task.entity_article,task.progress_label,task.failure_reason,
             CASE WHEN job.job_id IS NOT NULL
                  THEN CASE WHEN job.state='done' THEN 'done'
                            WHEN job.state IN ('queued','running','retry') THEN 'running'
                            ELSE 'failed' END
                  WHEN task.status='done' THEN 'done'
                  WHEN task.status='running' AND task.ended_at IS NULL
                       AND task.updated_at >= now() - interval '${ORPHAN_SYNC_TASK_STALE_MINUTES} minutes' THEN 'running'
                  ELSE 'failed' END AS effective_status
        FROM sync_tasks task
        LEFT JOIN background_jobs job ON job.tenant_id=task.tenant_id AND job.job_id=task.task_id
       WHERE task.tenant_id=$1 AND task.parent_task_id=$2
    ), children AS (
      SELECT COUNT(*)::integer AS total,
             COUNT(*) FILTER (WHERE effective_status='running')::integer AS running,
             COUNT(*) FILTER (WHERE effective_status='done')::integer AS done,
             COUNT(*) FILTER (WHERE effective_status='failed')::integer AS failed,
             string_agg(
               CASE WHEN effective_status='failed'
                    THEN (CASE WHEN COALESCE(entity_article,'')<>'' THEN '店铺 '||entity_article||'：' ELSE '' END) ||
                         COALESCE(NULLIF(failure_reason,''),NULLIF(progress_label,''),'子任务失败')
                    ELSE NULL END,
               '；'
             ) FILTER (WHERE effective_status='failed') AS failure_detail
        FROM child_states
    ) UPDATE sync_tasks AS parent
       SET status=CASE WHEN children.running>0 THEN 'running'
                       WHEN children.failed>0 THEN 'failed'
                       WHEN children.total>0 AND children.done=children.total THEN 'done'
                       ELSE parent.status END,
           progress_value=CASE WHEN children.total>0
                               THEN FLOOR(100.0*(children.done+children.failed)/children.total)::integer
                               ELSE parent.progress_value END,
           progress_label=CASE WHEN children.running>0 AND children.failed>0 THEN '部分店铺同步失败，其余店铺继续处理'
                               WHEN children.running>0 THEN '同步进行中：已完成 '||(children.done+children.failed)||'/'||children.total||' 家店铺'
                               WHEN children.failed>0 THEN '同步结束，部分店铺失败'
                               WHEN children.total>0 AND children.done=children.total THEN '同步完成'
                               ELSE parent.progress_label END,
           failure_reason=CASE WHEN children.failed>0 THEN LEFT(COALESCE(children.failure_detail,'部分店铺同步失败'),1500)
                               WHEN children.running>0 THEN ''
                               ELSE parent.failure_reason END,
           ended_at=CASE WHEN children.total>0 AND children.running=0 AND children.done+children.failed=children.total THEN now()
                         ELSE NULL END,
           updated_at=now()
      FROM children
     WHERE parent.tenant_id=$1 AND parent.task_id=$2 AND children.total>0`, [tenantId, parentId]);
  }

  async upsertSyncTask(account, input, transaction = null) {
    const client = transaction || await this.pool.connect();
    try {
      if (!transaction) await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      const id = String(input && input.id || '').slice(0, 120);
      const rawParentTaskId = String(input && input.parentTaskId || '').trim();
      const parentTaskId = /^sync-[A-Za-z0-9-]{6,100}$/.test(rawParentTaskId) ? rawParentTaskId : null;
      const status = ['running', 'done', 'failed'].includes(input && input.status) ? input.status : 'running';
      const startedAt = new Date(String(input && input.startedAt || ''));
      const validStartedAt = isNaN(startedAt.getTime()) ? new Date() : startedAt;
      const result = await client.query(
        `INSERT INTO sync_tasks
          (tenant_id, task_id, parent_task_id, actor_user_id, actor_username, task_type, entity_article, entity_sku, task_name, progress_label,
           progress_value, status, failure_reason, started_at, ended_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (tenant_id, task_id) DO UPDATE
         SET parent_task_id = COALESCE(EXCLUDED.parent_task_id, sync_tasks.parent_task_id),
             task_type = EXCLUDED.task_type,
             entity_article = CASE WHEN sync_tasks.parent_task_id IS NOT NULL AND EXCLUDED.entity_article = '' THEN sync_tasks.entity_article ELSE EXCLUDED.entity_article END,
             entity_sku = EXCLUDED.entity_sku,
             task_name = EXCLUDED.task_name, progress_label = EXCLUDED.progress_label,
             progress_value = EXCLUDED.progress_value, status = EXCLUDED.status,
             failure_reason = EXCLUDED.failure_reason, updated_at = now(),
             ended_at = EXCLUDED.ended_at
         WHERE sync_tasks.actor_user_id = EXCLUDED.actor_user_id
           -- 浏览器生成的批次父任务一旦结束，不能被较早发出的进度running请求覆盖。
           -- 精确限定 sync-时间戳-随机串 格式，避免影响服务器后台任务的重试恢复。
           AND NOT (sync_tasks.status IN ('done','failed') AND EXCLUDED.status='running'
             AND sync_tasks.parent_task_id IS NULL
             AND sync_tasks.task_id ~ '^sync-[a-z0-9]+-[a-z0-9]{7}$')
           AND (
             sync_tasks.parent_task_id IS DISTINCT FROM COALESCE(EXCLUDED.parent_task_id, sync_tasks.parent_task_id)
             OR sync_tasks.task_type IS DISTINCT FROM EXCLUDED.task_type
             OR sync_tasks.entity_article IS DISTINCT FROM (CASE WHEN sync_tasks.parent_task_id IS NOT NULL AND EXCLUDED.entity_article = '' THEN sync_tasks.entity_article ELSE EXCLUDED.entity_article END)
             OR sync_tasks.entity_sku IS DISTINCT FROM EXCLUDED.entity_sku
             OR sync_tasks.task_name IS DISTINCT FROM EXCLUDED.task_name
             OR sync_tasks.progress_label IS DISTINCT FROM EXCLUDED.progress_label
             OR sync_tasks.progress_value IS DISTINCT FROM EXCLUDED.progress_value
             OR sync_tasks.status IS DISTINCT FROM EXCLUDED.status
             OR sync_tasks.failure_reason IS DISTINCT FROM EXCLUDED.failure_reason
             OR (sync_tasks.ended_at IS NULL) IS DISTINCT FROM (EXCLUDED.ended_at IS NULL)
           )
         RETURNING task_id, parent_task_id, actor_user_id::text, actor_username, task_type, entity_article, entity_sku, task_name, progress_label,
                   progress_value, status, failure_reason, started_at, updated_at, ended_at`,
        [account.tenantId, id, parentTaskId, account.userId, displayUsername(String(account.username || ''), account.isSystemAdmin),
          ['sync', 'create', 'edit', 'archive'].includes(input && input.type) ? input.type : 'sync',
          String(input && input.article || '').slice(0, 180),
          String(input && input.sku || '').slice(0, 180),
          String(input && input.name || '同步任务').slice(0, 160),
          String(input && input.label || '正在同步').slice(0, 500),
          Math.max(0, Math.min(100, Math.floor(Number(input && input.value) || 0))), status,
          String(input && input.reason || '').slice(0, 1500), validStartedAt,
          status === 'running' ? null : new Date()]
      );
      // A repeated progress event may be a deliberate no-op. Still read back
      // under the same transaction to distinguish it from an unauthorized
      // attempt to overwrite a different user's task.
      const row = result.rowCount ? result.rows[0] : (await client.query(
        `SELECT task_id, parent_task_id, actor_user_id::text, actor_username, task_type,
                entity_article, entity_sku, task_name, progress_label, progress_value,
                status, failure_reason, started_at, updated_at, ended_at
           FROM sync_tasks WHERE tenant_id=$1 AND task_id=$2 AND actor_user_id=$3`,
        [account.tenantId, id, account.userId]
      )).rows[0];
      if (!row) {
        const error = new Error('该同步任务不属于当前账号，请刷新任务列表后重试。');
        error.publicCode = 'sync_task_owner_mismatch';
        throw error;
      }
      if (result.rowCount) {
        await this.refreshSkuImageBatchParent(client, account.tenantId, row.parent_task_id);
        await this.refreshSyncBatchParent(client, account.tenantId, row.parent_task_id);
      }
      if (!transaction) await client.query('COMMIT');
      return this.mapSyncTask(row);
    } catch (error) {
      if (!transaction) await client.query('ROLLBACK');
      throw error;
    } finally {
      if (!transaction) client.release();
    }
  }

  async listProductEditJobs() {
    const result = await this.pool.query(`SELECT tenant_id::text, record_key, shop_external_id,
      COALESCE(payload->>'id',payload->>'productId') AS product_id, payload->'ozonEdit' AS state
      FROM business_products WHERE payload->'ozonEdit'->>'queueId' LIKE 'product-edit-%'
      AND payload->'ozonEdit'->>'phase' IN ('queued','preparing','submitting','pending')
      ORDER BY COALESCE(payload->'ozonEdit'->>'lastCheckedAt',payload->'ozonEdit'->>'enqueuedAt') LIMIT 30`);
    return result.rows;
  }

  async listProductCreateJobs() {
    const result = await this.pool.query(
      `SELECT document.tenant_id::text, draft->>'draftId' AS draft_id, draft->'ozonCreate' AS state
       FROM tenant_documents document
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(document.payload)='array' THEN document.payload ELSE '[]'::jsonb END) draft
       WHERE document.document_key='erp_product_drafts'
         AND draft->'ozonCreate'->>'queueId' LIKE 'product-create-%'
         AND draft->'ozonCreate'->>'phase' IN ('queued','preparing','submitting','pending','verifying')
       ORDER BY COALESCE(draft->'ozonCreate'->>'lastCheckedAt',draft->'ozonCreate'->>'enqueuedAt') LIMIT 30`
    );
    return result.rows;
  }

  async productEditActor(tenantId, userId) {
    const result = await this.pool.query(`SELECT u.id AS user_id,u.username,u.is_system_admin,tm.tenant_id,tm.member_type,tm.display_name,tm.shop_scope_mode,
      (u.status='active' AND tm.status='active' AND t.status='active') AS enabled,
      COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL),'{}') AS permissions
      FROM users u JOIN tenant_members tm ON tm.user_id=u.id JOIN tenants t ON t.id=tm.tenant_id
      LEFT JOIN member_roles mr ON mr.tenant_id=tm.tenant_id AND mr.user_id=tm.user_id
      LEFT JOIN role_permissions rp ON rp.tenant_id=mr.tenant_id AND rp.role_id=mr.role_id
      WHERE tm.tenant_id=$1 AND u.id=$2 AND u.is_system_admin=false AND lower(u.username)<>'admin'
      GROUP BY u.id,tm.tenant_id,tm.member_type,tm.display_name,tm.shop_scope_mode,tm.status,t.status`, [tenantId,userId]);
    if (result.rowCount) return { ...normalizeAccount(result.rows[0]), enabled: result.rows[0].enabled };

    const admin = await this.pool.query(`SELECT u.id::text AS user_id,u.username,u.is_system_admin,u.status AS user_status,
      t.id::text AS tenant_id,t.status AS tenant_status
      FROM users u JOIN tenants t ON t.id=$1
      WHERE u.id=$2 AND lower(u.username)='admin' AND u.is_system_admin=true`, [tenantId,userId]);
    if (admin.rowCount !== 1 || admin.rows[0].user_status !== 'active' || admin.rows[0].tenant_status !== 'active') return null;
    let home;
    try { home = await this.systemAdminHomeAccount(); }
    catch (_) { return null; }
    if (String(home.userId) !== String(admin.rows[0].user_id)) return null;
    return { ...home, tenantId: String(admin.rows[0].tenant_id), enabled: true };
  }

  async withProductEditLock(tenantId, queueId, work) {
    const client = await this.pool.connect();
    const key = 'product-edit:' + tenantId + ':' + queueId;
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[key])).rows[0].locked;
      if (locked) return await work();
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]); }
      finally { client.release(); }
    }
  }

  async withProductCreateLock(tenantId, draftId, queueId, work) {
    const client = await this.pool.connect();
    const key = 'product-create:' + tenantId + ':' + draftId + ':' + queueId;
    let locked = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [key])).rows[0].locked;
      if (locked) return await work();
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]); }
      finally { client.release(); }
    }
  }

  mapSyncTask(row) {
    return {
      id: row.task_id, parentTaskId: row.parent_task_id || '', serverOwned: false, actorUserId: String(row.actor_user_id), actorUsername: row.actor_username,
      actorProfileFullName: String(row.actor_profile_full_name || ''), actorEmail: String(row.actor_email || ''), actorIsSystemAdmin: row.actor_is_system_admin === true,
      actorLabel: row.actor_is_system_admin === true ? '系统管理员' : (String(row.actor_profile_full_name || '').trim() || String(row.actor_email || '').trim() || '历史未记录'),
      type: row.task_type || 'sync', article: row.entity_article || '', sku: row.entity_sku || '', name: row.task_name, label: row.progress_label, value: Number(row.progress_value),
      status: row.status, reason: row.failure_reason || '', startedAt: row.started_at,
      updatedAt: row.updated_at, endedAt: row.ended_at
    };
  }

  listSyncTasks(account, options = {}) {
    // 同一账号在多个页面轮询时，合并“正在执行”的相同只读查询。
    // 绝不保留已完成的查询结果（同步进度仍实时读取），也不跨租户/账号/权限共享。
    const taskIds = options.taskIds == null ? null : [...new Set(String(options.taskIds).split(',')
      .filter(id => /^[A-Za-z0-9._:-]{1,120}$/.test(id)))].slice(0, 100).sort();
    const key = JSON.stringify([
      String(account.tenantId), String(account.userId), !!account.isSystemAdmin, String(account.memberType || ''),
      Math.max(1, Math.min(200, Number(options.limit) || 50)),
      Math.max(0, Number(options.offset) || 0),
      ['sync', 'create', 'edit', 'archive'].includes(options.type) ? options.type : '',
      String(options.parentTaskId || '').trim(), taskIds
    ]);
    const pending = this._syncTaskPendingReads || (this._syncTaskPendingReads = new Map());
    if (pending.has(key)) return pending.get(key);
    const request = this._listSyncTasksQuery(account, options);
    pending.set(key, request);
    const clear = () => { if (pending.get(key) === request) pending.delete(key); };
    request.then(clear, clear);
    return request;
  }

  async _listSyncTasksQuery(account, options = {}) {
    const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
    const offset = Math.max(0, Number(options.offset) || 0);
    const ownOnly = !account.isSystemAdmin && account.memberType !== 'owner';
    const type = ['sync', 'create', 'edit', 'archive'].includes(options.type) ? options.type : '';
    const baseParams = ownOnly ? [account.tenantId, account.userId] : [account.tenantId];
    const conditions = [ownOnly ? 'task.tenant_id = $1 AND task.actor_user_id = $2' : 'task.tenant_id = $1'];
    const parentTaskId = String(options.parentTaskId || '').trim();
    if (parentTaskId && !/^sync-[A-Za-z0-9-]{6,100}$/.test(parentTaskId)) throw Object.assign(new Error('批量任务标识不正确，请刷新任务列表后重试。'), { publicCode: 'sync_task_parent_invalid' });
    // 精确ID检索须覆盖父/子任务；普通任务中心列表仍只显示顶层、点击后再展开子任务。
    // 租户及非owner本人权限过滤保持在conditions首项，不因指定ID而放开权限。
    if (parentTaskId) conditions.push(`task.parent_task_id = $${baseParams.push(parentTaskId)}`);
    else if (options.taskIds == null) conditions.push('task.parent_task_id IS NULL');
    if (type) { baseParams.push(type); conditions.push(`task.task_type = $${baseParams.length}`); }
    if (options.taskIds != null) {
      const taskIds = [...new Set(String(options.taskIds).split(',').filter(id => /^[A-Za-z0-9._:-]{1,120}$/.test(id)))].slice(0, 100);
      baseParams.push(taskIds); conditions.push(`task.task_id = ANY($${baseParams.length}::text[])`);
    }
    const where = conditions.join(' AND ');
    const params = baseParams.concat([limit, offset]);
    const limitParam = '$' + (baseParams.length + 1);
    const offsetParam = '$' + (baseParams.length + 2);
    const [items, count, summaryRows] = await Promise.all([
      this.pool.query(
        `SELECT task.task_id, task.parent_task_id, task.actor_user_id::text, task.actor_username, task.task_type, task.entity_article, task.entity_sku, task.task_name, task.progress_label,
                task.progress_value, task.status, task.failure_reason, task.started_at, task.updated_at, task.ended_at,
                COALESCE(up.full_name, '') AS actor_profile_full_name,
                CASE WHEN up.email_verified_at IS NOT NULL THEN COALESCE(up.email, '') ELSE '' END AS actor_email,
                COALESCE(u.is_system_admin, false) AS actor_is_system_admin
         FROM sync_tasks task
         LEFT JOIN users u ON u.id=task.actor_user_id
         LEFT JOIN user_profiles up ON up.user_id=task.actor_user_id
         WHERE ${where}
         ORDER BY task.started_at DESC, task.task_id DESC LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params
      ),
      this.pool.query(`SELECT COUNT(*)::int AS total FROM sync_tasks task WHERE ${where}`, baseParams),
      parentTaskId ? Promise.resolve({ rows: [] }) : this.pool.query(
        `SELECT CASE
                  WHEN job.job_id IS NOT NULL THEN CASE WHEN job.state='done' THEN 'done' WHEN job.state IN ('queued','running','retry') THEN 'running' ELSE 'failed' END
                  WHEN task.status='done' THEN 'done'
                  WHEN task.status='running' AND task.ended_at IS NULL AND task.updated_at >= now() - interval '${ORPHAN_SYNC_TASK_STALE_MINUTES} minutes' THEN 'running'
                  ELSE 'failed'
                END AS status,
                COUNT(*)::int AS count
           FROM sync_tasks task
           LEFT JOIN background_jobs job ON job.tenant_id=task.tenant_id AND job.job_id=task.task_id
          WHERE ${where}
          GROUP BY 1`, baseParams)
    ]);
    const summary = { running: 0, done: 0, failed: 0 };
    summaryRows.rows.forEach(row => { if (Object.prototype.hasOwnProperty.call(summary, row.status)) summary[row.status] = Number(row.count); });
    const tasks = items.rows.map(row => this.mapSyncTask(row));
    if (tasks.length) {
      let jobs;
      try {
        jobs = await this.pool.query(`SELECT job_id, state, last_error, updated_at, ended_at FROM background_jobs WHERE tenant_id=$1 AND job_id=ANY($2::text[])`, [account.tenantId, tasks.map(task => task.id)]);
      } catch (error) { if (error.code !== '42P01') throw error; }
      const byId = new Map((jobs ? jobs.rows : []).map(job => [job.job_id, job]));
      for (const task of tasks) {
        const job = byId.get(task.id);
        if (!job) continue;
        task.serverOwned = true;
        task.backgroundState = job.state;
        task.updatedAt = job.updated_at;
        task.endedAt = job.ended_at;
        task.status = projectSyncTaskStatus(task, job);
        if (job.state === 'done') task.value = 100;
        if (job.state === 'queued') { task.value = 0; task.label = task.parentTaskId.startsWith('sync-sku-ai-') ? '等待父任务启动' : '已进入服务器队列，等待执行'; task.reason = ''; }
        if (job.state === 'retry') { task.label = '暂时失败，服务器将自动重试'; task.reason = ''; }
        if (task.status === 'failed' && !task.reason) task.reason = job.state === 'cancelled' ? '服务器任务已取消' : bilingualExternalFailureText(job.last_error, '服务器任务已停止，请核对权限或稍后重试。');
      }
      for (const task of tasks) {
        if (byId.has(task.id)) continue;
        const effectiveStatus = projectSyncTaskStatus(task, null);
        if (task.status === 'running' && effectiveStatus === 'failed') {
          task.status = 'failed';
          task.label = `任务超过 ${ORPHAN_SYNC_TASK_STALE_MINUTES} 分钟没有进度更新，已停止处理`;
          task.reason = `没有找到服务器后台任务，且超过 ${ORPHAN_SYNC_TASK_STALE_MINUTES} 分钟没有进度更新，请重新发起任务`;
        } else if (!['running', 'done', 'failed'].includes(task.status)) {
          task.status = effectiveStatus;
          if (effectiveStatus === 'failed' && !task.reason) task.reason = '任务状态无法确认，已停止处理，请重新发起任务';
        }
      }
    }
    if (!parentTaskId && tasks.length) {
      const ids = tasks.map(task => task.id);
      const children = await this.pool.query(
        `SELECT parent_task_id,
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE effective_status='running')::int AS running,
                COUNT(*) FILTER (WHERE effective_status='done')::int AS done,
                COUNT(*) FILTER (WHERE effective_status='failed')::int AS failed,
                COALESCE(AVG(progress_value),0)::int AS value,
                MAX(updated_at) AS updated_at,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'article',entity_article,'label',progress_label,'reason',failure_reason
                )) FILTER (WHERE effective_status='failed'),'[]'::jsonb) AS failed_details
           FROM (
             SELECT child.parent_task_id,child.progress_value,child.updated_at,child.entity_article,child.progress_label,child.failure_reason,
                    CASE WHEN job.job_id IS NOT NULL
                         THEN CASE WHEN job.state='done' THEN 'done'
                                   WHEN job.state IN ('queued','running','retry') THEN 'running'
                                   ELSE 'failed' END
                         WHEN child.status='done' THEN 'done'
                         WHEN child.status='running' AND child.ended_at IS NULL
                              AND child.updated_at >= now() - interval '${ORPHAN_SYNC_TASK_STALE_MINUTES} minutes' THEN 'running'
                         ELSE 'failed' END AS effective_status
               FROM sync_tasks child LEFT JOIN background_jobs job
                 ON job.tenant_id=child.tenant_id AND job.job_id=child.task_id
              WHERE child.tenant_id=$1 AND child.parent_task_id=ANY($2::text[])
           ) child_states
          GROUP BY parent_task_id`, [account.tenantId, ids]
      );
      const summaries = new Map(children.rows.map(row => {
        const summary = { total: Number(row.total), running: Number(row.running), done: Number(row.done), failed: Number(row.failed), value: Number(row.value), updatedAt: row.updated_at };
        if (Array.isArray(row.failed_details) && row.failed_details.length) summary.failedDetails = row.failed_details;
        return [String(row.parent_task_id), summary];
      }));
      tasks.forEach(task => {
        if (!summaries.has(task.id)) return;
        task.childSummary = summaries.get(task.id);
        if (!task.id.startsWith('sync-sku-ai-') && task.childSummary.total > 0) {
          const details = Array.isArray(task.childSummary.failedDetails) ? task.childSummary.failedDetails : [];
          const reason = details.slice(0, 3).map(detail => {
            const article = String(detail && detail.article || '').trim();
            const text = String(detail && (detail.reason || detail.label) || '子任务失败').trim();
            return (article ? `店铺 ${article}：` : '') + text;
          }).join('；');
          if (task.childSummary.running > 0) {
            task.status = 'running';
            task.label = task.childSummary.failed > 0 ? '部分店铺同步失败，其余店铺继续处理' : `同步进行中：已完成 ${task.childSummary.done + task.childSummary.failed}/${task.childSummary.total} 家店铺`;
            task.reason = task.childSummary.failed > 0 ? (reason || `${task.childSummary.failed} 家店铺同步失败`) : '';
          } else if (task.childSummary.failed > 0) {
            task.status = 'failed';
            task.value = 100;
            task.label = '同步结束，部分店铺失败';
            task.reason = reason || `${task.childSummary.failed} 家店铺同步失败`;
            task.endedAt = task.childSummary.updatedAt || task.endedAt;
          } else if (task.childSummary.done === task.childSummary.total) {
            task.status = 'done';
            task.value = 100;
            task.label = '同步完成';
            task.reason = '';
            task.endedAt = task.childSummary.updatedAt || task.endedAt;
          }
        }
        if (task.id.startsWith('sync-sku-ai-') && task.childSummary.failed > 0) {
          task.status = 'failed';
          task.label = task.childSummary.running > 0 ? '部分图片生成失败，其余图片继续处理' : '部分图片生成失败，请展开查看';
          task.reason = task.childSummary.failed + ' 项子任务失败，展开查看详情';
        }
        if (task.id.startsWith('sync-sku-ai-') && ['failed', 'cancelled'].includes(task.backgroundState)) {
          if (task.childSummary.running > 0 && task.childSummary.failed === 0) {
            task.status = 'running';
            task.label = '父任务异常，子任务正在恢复处理';
            task.reason = '';
          } else if (task.childSummary.done === task.childSummary.total && task.childSummary.total > 0) {
            task.status = 'done';
            task.label = '批量图片已生成，请展开查看';
            task.reason = '';
            task.value = 100;
          }
        }
        if (task.id.startsWith('sync-sku-ai-') && task.backgroundState === 'done' && task.childSummary.failed > 0) {
          task.status = 'failed';
          task.label = '部分图片生成失败，请展开查看';
        }
      });
    }
    return { items: tasks, total: Number(count.rows[0].total), summary };
  }

  async listMembers(account) {
    const result = await this.pool.query(
      `SELECT tm.user_id, u.username, up.email, COALESCE(up.full_name, '') AS profile_full_name,
              tm.display_name, tm.member_type, tm.status, tm.shop_scope_mode,
              tm.joined_at, tm.created_at,
              COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
              COALESCE(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object('id', s.id::text, 'name', s.name, 'externalShopId', s.external_shop_id) ORDER BY s.name, s.id)
                FROM member_shop_scopes mss
                JOIN shops s ON s.tenant_id = mss.tenant_id AND s.id = mss.shop_id
                WHERE mss.tenant_id = tm.tenant_id AND mss.user_id = tm.user_id AND s.status = 'active'
              ), '[]'::jsonb) AS shops
       FROM tenant_members tm
       JOIN users u ON u.id = tm.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       LEFT JOIN member_roles mr ON mr.tenant_id = tm.tenant_id AND mr.user_id = tm.user_id
       LEFT JOIN roles r ON r.tenant_id = mr.tenant_id AND r.id = mr.role_id
       LEFT JOIN role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
       WHERE tm.tenant_id = $1 AND tm.status <> 'removed' AND u.is_system_admin=false
       GROUP BY tm.tenant_id, tm.user_id, u.username, up.email, up.full_name, tm.display_name, tm.member_type, tm.status, tm.shop_scope_mode, tm.joined_at, tm.created_at
       ORDER BY tm.member_type = 'owner' DESC, tm.created_at ASC`,
      [account.tenantId]
    );
    return result.rows.map(row => ({
      userId: String(row.user_id), username: row.username, email: String(row.email || ''), profileFullName: String(row.profile_full_name || ''), displayName: row.display_name,
      memberType: row.member_type, status: row.status, shopScopeMode: row.shop_scope_mode,
      roles: row.roles, permissions: row.member_type === 'owner' ? ['*'] : row.permissions,
      shops: row.member_type === 'owner' ? [] : row.shops,
      joinedAt: row.joined_at, createdAt: row.created_at
    }));
  }

  async performanceCpoAttributedTotal(account, clientId, from, to) {
    const result = await this.pool.query(
      `SELECT payload FROM business_orders WHERE tenant_id=$1 AND shop_external_id=$2`,
      [account.tenantId, String(clientId || '')]
    );
    let amountRub = 0, rows = 0;
    result.rows.forEach(row => {
      const items = row.payload && row.payload.finance && Array.isArray(row.payload.finance.performanceCpoItems)
        ? row.payload.finance.performanceCpoItems : [];
      items.forEach(item => {
        const date = String(item && item.date || '').slice(0, 10);
        if (date && date >= from && date <= to) {
          amountRub += Number(item.amount || 0);
          rows += 1;
        }
      });
    });
    return { amountRub: Math.round(amountRub * 100) / 100, rows };
  }

  async applyPerformanceCpoAttribution(account, clientId, input = {}) {
    clientId = String(clientId || '').trim();
    const from = String(input.from || '').trim(), to = String(input.to || '').trim();
    const rows = Array.isArray(input.rows) ? input.rows : [];
    if (!clientId || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw Object.assign(new Error('按订单付费归属参数不完整，请重新同步广告费用。'), { publicCode: 'performance_cpo_apply_invalid' });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query(
        `INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id)
         VALUES ($1,'erp_orders_data',1,'array',$2) ON CONFLICT (tenant_id,document_key) DO NOTHING`,
        [account.tenantId, account.userId]
      );
      await client.query(`SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data' FOR UPDATE`, [account.tenantId]);
      const current = await client.query(
        `SELECT record_key,posting_number,payload FROM business_orders
         WHERE tenant_id=$1 AND shop_external_id=$2 ORDER BY position,record_key FOR UPDATE`,
        [account.tenantId, clientId]
      );
      const byIdentity = new Map();
      current.rows.forEach(row => {
        const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
        const identities = [
          row.posting_number, payload.posting, payload.platformRecordId,
          payload.sellerOrderId, payload.sellerOrderNumber
        ].map(value => String(value || '').trim()).filter(Boolean);
        [...new Set(identities)].forEach(identity => {
          if (!byIdentity.has(identity)) byIdentity.set(identity, []);
          byIdentity.get(identity).push(row);
        });
      });
      const incoming = new Map(), unmatched = [];
      rows.forEach(row => {
        const matchedPosting = String(row && row.matchedPosting || '').trim();
        let targets = [];
        if (matchedPosting) {
          targets = current.rows.filter(item => String(item.posting_number || '').trim() === matchedPosting);
        } else {
          const identifiers = [row && row.orderId, row && row.orderNumber].map(value => String(value || '').trim()).filter(Boolean);
          const targetMap = new Map();
          identifiers.forEach(identifier => {
            (byIdentity.get(identifier) || []).forEach(target => targetMap.set(String(target.record_key), target));
          });
          targets = [...targetMap.values()];
        }
        if (targets.length !== 1) {
          unmatched.push(row);
          return;
        }
        const recordKey = String(targets[0].record_key);
        if (!incoming.has(recordKey)) incoming.set(recordKey, []);
        incoming.get(recordKey).push(row);
      });
      let changed = 0, matchedRows = 0, matchedRub = 0;
      const updatedAt = new Date().toISOString();
      for (const dbRow of current.rows) {
        const payload = dbRow.payload && typeof dbRow.payload === 'object' ? JSON.parse(JSON.stringify(dbRow.payload)) : {};
        const posting = String(dbRow.posting_number || payload.posting || '').trim();
        const finance = payload.finance && typeof payload.finance === 'object' ? payload.finance : {};
        const previous = Array.isArray(finance.performanceCpoItems) ? finance.performanceCpoItems : [];
        const retained = previous.filter(item => {
          const date = String(item && item.date || '').slice(0, 10);
          return !date || date < from || date > to;
        });
        const added = (incoming.get(String(dbRow.record_key)) || []).map(row => ({
          type: '54',
          name: 'Promotion',
          rawName: 'Ozon Performance CPO',
          paymentMethod: 'CPO',
          chargeModel: 'CPO',
          direction: 'charge',
          amount: Math.round((Number(row.expenseRub) || 0) * 100) / 100,
          signedAmount: -Math.round((Number(row.expenseRub) || 0) * 100) / 100,
          date: String(row.date || '').slice(0, 10),
          orderId: String(row.orderId || ''),
          orderNumber: String(row.orderNumber || ''),
          matchedPosting: posting,
          sku: String(row.sku || ''),
          promotedSku: String(row.promotedSku || ''),
          offerId: String(row.offerId || ''),
          quantity: Number(row.quantity) || 0,
          source: 'ozon_performance_cpo'
        })).filter(item => item.amount > 0);
        const nextItems = retained.concat(added);
        const nextRub = Math.round(nextItems.reduce((sum, item) => sum + Number(item.amount || 0), 0) * 100) / 100;
        matchedRows += added.length;
        matchedRub += added.reduce((sum, item) => sum + Number(item.amount || 0), 0);
        const nextFinance = {
          ...finance,
          performanceCpoItems: nextItems,
          performanceCpoRub: nextRub,
          performanceCpoUpdatedAt: updatedAt,
          performanceCpoSource: 'ozon_performance_api'
        };
        if (JSON.stringify(finance.performanceCpoItems || []) === JSON.stringify(nextItems)
          && Number(finance.performanceCpoRub || 0) === nextRub) continue;
        payload.finance = nextFinance;
        await client.query(
          `UPDATE business_orders SET payload=$4::jsonb,updated_by_user_id=$3,updated_at=now()
           WHERE tenant_id=$1 AND record_key=$2`,
          [account.tenantId, dbRow.record_key, account.userId, JSON.stringify(payload)]
        );
        changed += 1;
      }
      let version = null;
      if (changed) {
        const revision = await client.query(
          `UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now()
           WHERE tenant_id=$1 AND document_key='erp_orders_data' RETURNING version`,
          [account.tenantId, account.userId]
        );
        version = Number(revision.rows[0] && revision.rows[0].version || 0);
      }
      await this.writeAudit(client, account, 'order.performance_cpo.sync', 'shop', clientId, 'success', {
        from, to, reportRows: rows.length, matchedRows, unmatchedRows: unmatched.length,
        matchedRub: Math.round(matchedRub * 100) / 100, changedOrders: changed
      });
      await client.query('COMMIT');
      return {
        matchedRows, unmatchedRows: unmatched, matchedRub: Math.round(matchedRub * 100) / 100,
        changedOrders: changed, ordersVersion: version
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async syncShopsForClient(client, account, shopItems) {
    const items = Array.isArray(shopItems) ? shopItems : [];
    const normalized = items.filter(item => item && !item.archived).map(item => ({
      name: String(item && item.name || '').trim().slice(0, 160),
      externalShopId: String(item && (item.clientId || item.externalShopId) || '').trim().slice(0, 120) || null
    })).filter(item => item.name);
    const retainedIds = [];
    for (const item of normalized) {
      let existing = null;
      if (item.externalShopId) {
        existing = await client.query(
          `SELECT id FROM shops WHERE tenant_id = $1 AND external_shop_id = $2 LIMIT 1`,
          [account.tenantId, item.externalShopId]
        );
      }
      if (!existing || !existing.rowCount) {
        existing = await client.query(
          `SELECT id FROM shops WHERE tenant_id = $1 AND name = $2 ORDER BY status = 'active' DESC, id LIMIT 1`,
          [account.tenantId, item.name]
        );
      }
      if (existing.rowCount) {
        retainedIds.push(String(existing.rows[0].id));
        await client.query(
          `UPDATE shops SET name = $3, external_shop_id = COALESCE($4, external_shop_id), status = 'active', updated_at = now()
           WHERE tenant_id = $1 AND id = $2`,
          [account.tenantId, existing.rows[0].id, item.name, item.externalShopId]
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO shops (tenant_id, name, external_shop_id) VALUES ($1, $2, $3) RETURNING id`,
          [account.tenantId, item.name, item.externalShopId]
        );
        retainedIds.push(String(inserted.rows[0].id));
      }
    }
    await client.query(
      `UPDATE shops SET status = 'archived', updated_at = now()
       WHERE tenant_id = $1 AND status = 'active' AND NOT (id = ANY($2::bigint[]))`,
      [account.tenantId, retainedIds]
    );
  }

  async syncShops(account, shopItems) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.syncShopsForClient(client, account, shopItems);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return this.listShops(account);
  }

  async listShops(account) {
    const result = await this.pool.query(
      `SELECT id::text, name, external_shop_id FROM shops
       WHERE tenant_id = $1 AND status = 'active' ORDER BY name, id`,
      [account.tenantId]
    );
    return result.rows.map(row => ({ id: row.id, name: row.name, externalShopId: row.external_shop_id }));
  }

  async listAllowedShops(account) {
    if (!account || account.isSystemAdmin || account.memberType === 'owner' || account.shopScopeMode === 'all') return null;
    const result = await this.pool.query(
      `SELECT s.id::text, s.name, s.external_shop_id
       FROM member_shop_scopes mss
       JOIN shops s ON s.tenant_id = mss.tenant_id AND s.id = mss.shop_id
       WHERE mss.tenant_id = $1 AND mss.user_id = $2 AND s.status = 'active'
       ORDER BY s.name, s.id`,
      [account.tenantId, account.userId]
    );
    return result.rows.map(row => ({ id: row.id, name: row.name, externalShopId: row.external_shop_id }));
  }

  async listPermissions() {
    const result = await this.pool.query(
      `SELECT code, module, action, description FROM permissions ORDER BY module, code`
    );
    return result.rows;
  }

  async listSystemTenants(account) {
    if (!account || !account.isSystemAdmin) {
      const error = new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。');
      error.publicCode = 'system_admin_required';
      throw error;
    }
    const result = await this.pool.query(
      `SELECT t.id::text, t.slug, t.name, t.status, t.created_at,
              (SELECT tm_owner.user_id::text FROM tenant_members tm_owner
               WHERE tm_owner.tenant_id=t.id AND tm_owner.member_type='owner' AND tm_owner.status='active'
               ORDER BY tm_owner.joined_at,tm_owner.user_id LIMIT 1) AS owner_user_id,
              (SELECT u_owner.username FROM tenant_members tm_owner JOIN users u_owner ON u_owner.id=tm_owner.user_id
               WHERE tm_owner.tenant_id=t.id AND tm_owner.member_type='owner' AND tm_owner.status='active' AND u_owner.status='active'
               ORDER BY tm_owner.joined_at,tm_owner.user_id LIMIT 1) AS owner_username,
              COUNT(DISTINCT tm.user_id)::int AS member_count,
              COUNT(DISTINCT td.document_key)::int AS document_count,
              COALESCE((
                SELECT CASE WHEN jsonb_typeof(shop_doc.payload) = 'array' THEN jsonb_array_length(shop_doc.payload) ELSE 0 END
                FROM tenant_documents shop_doc
                WHERE shop_doc.tenant_id = t.id AND shop_doc.document_key = 'erp_shops_data'
              ), 0)::int AS shop_count,
              MAX(td.updated_at) AS data_updated_at
       FROM tenants t
       LEFT JOIN tenant_members tm ON tm.tenant_id = t.id AND tm.status <> 'removed'
       LEFT JOIN users member_user ON member_user.id = tm.user_id
       LEFT JOIN tenant_documents td ON td.tenant_id = t.id
       GROUP BY t.id
       ORDER BY t.created_at ASC, t.id ASC`
    );
    return result.rows.map(row => ({
      tenantId: row.id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      ownerUserId: row.owner_user_id || null,
      ownerUsername: row.owner_username || '',
      memberCount: row.member_count,
      documentCount: row.document_count,
      shopCount: row.shop_count,
      dataUpdatedAt: row.data_updated_at,
      createdAt: row.created_at
    }));
  }

  async listSystemAgents(account) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const result = await this.pool.query(
      `SELECT t.id AS tenant_id,t.name AS tenant_name,owner.user_id AS owner_user_id,owner.username AS owner_username,
              a.status,a.source,a.deposit_mode,a.credit_score,a.qualified_at,a.expires_at,a.assigned_reason,
              COALESCE(fin.payable_minor,0)::bigint AS payable_minor,
              COALESCE(fin.deposit_balance_minor,0)::bigint AS deposit_balance_minor,
              COALESCE(defaults.pending_default_batches,0)::integer AS pending_default_batches,
              COALESCE(defaults.pending_default_batch_ids,ARRAY[]::text[]) AS pending_default_batch_ids,
              deposit_requirement.deposit_deadline,
              a.status='active' AND (a.expires_at IS NULL OR a.expires_at>now()) AS is_active
       FROM tenants t
       LEFT JOIN LATERAL (
         SELECT tm.user_id,u.username FROM tenant_members tm JOIN users u ON u.id=tm.user_id
         WHERE tm.tenant_id=t.id AND tm.member_type='owner' AND tm.status='active'
         ORDER BY tm.joined_at,tm.user_id LIMIT 1
        ) owner ON true
        LEFT JOIN agents a ON a.tenant_id=t.id
        LEFT JOIN LATERAL (
          SELECT sum(CASE WHEN account_type='payable' AND direction='debit' THEN amount_minor
                          WHEN account_type='payable' AND direction='credit' THEN -amount_minor ELSE 0 END) AS payable_minor,
                 sum(CASE WHEN account_type='deposit' AND direction='credit' THEN amount_minor
                          WHEN account_type='deposit' AND direction='debit' THEN -amount_minor ELSE 0 END) AS deposit_balance_minor
          FROM agent_financial_events f WHERE f.tenant_id=a.tenant_id
        ) fin ON true
        LEFT JOIN LATERAL (
          SELECT count(DISTINCT e.metadata->>'batchId') AS pending_default_batches,
                 array_agg(DISTINCT e.metadata->>'batchId') FILTER (WHERE e.metadata->>'batchId' IS NOT NULL) AS pending_default_batch_ids
          FROM activation_code_events e
          WHERE e.tenant_id=a.tenant_id AND e.event_type='payment_default_batch_assigned'
            AND NOT EXISTS (SELECT 1 FROM agent_credit_events c
              WHERE c.tenant_id=e.tenant_id AND c.event_type='default' AND c.cycle_key=e.metadata->>'batchId')
        ) defaults ON true
        LEFT JOIN LATERAL (
          SELECT (q.next_state->>'depositDeadline')::timestamptz AS deposit_deadline
          FROM agent_qualification_events q
          WHERE q.tenant_id=a.tenant_id AND q.event_type='deposit_required'
          ORDER BY q.id DESC LIMIT 1
        ) deposit_requirement ON true
        ORDER BY t.created_at,t.id`
    );
    return result.rows.map(row => ({
      tenantId: String(row.tenant_id), tenantName: row.tenant_name, ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id),
      ownerUsername: row.owner_username || '',
      status: row.status === 'active' && row.is_active !== true ? 'expired' : row.status || 'not_assigned',
      isActive: row.is_active === true, source: row.source || '',
      depositMode: row.deposit_mode || '', creditScore: row.credit_score == null ? null : Number(row.credit_score),
      qualifiedAt: row.qualified_at, expiresAt: row.expires_at, assignedReason: row.assigned_reason || '',
      payableMinor: Number(row.payable_minor) || 0, depositBalanceMinor: Number(row.deposit_balance_minor) || 0,
      depositRequiredMinor: AGENT_DEPOSIT_REQUIRED_MINOR, pendingDefaultBatches: Number(row.pending_default_batches) || 0,
      pendingDefaultBatchIds: row.pending_default_batch_ids || [],
      depositDeadline: row.deposit_deadline || null
    }));
  }

  async getSystemAgentOverview(account, tenantId) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const owner = await this.pool.query(`SELECT owner_user_id::text FROM agents WHERE tenant_id=$1`, [tenantId]);
    if (!owner.rowCount) throw Object.assign(new Error('未找到该客户的代理商记录，请先为它指派代理商资格。'), { publicCode: 'agent_not_found' });
    return this.getAgentOverview({ tenantId: String(tenantId), userId: owner.rows[0].owner_user_id, memberType: 'owner' });
  }

  async listSystemMembershipPayments(account, tenantId) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const result = await this.pool.query(
      `SELECT p.id::text,p.provider,p.currency,p.amount_minor,p.paid_at,
              EXISTS(SELECT 1 FROM activation_codes c WHERE c.platform_payment_id=p.id) AS already_used
       FROM payments p
       WHERE p.tenant_id=$1 AND p.status='paid' AND p.paid_at IS NOT NULL
       ORDER BY p.paid_at DESC,p.id DESC LIMIT 100`, [tenantId]
    );
    return result.rows.map(row => ({
      id: row.id, provider: row.provider, currency: row.currency, amountMinor: Number(row.amount_minor),
      paidAt: row.paid_at, alreadyUsed: row.already_used === true
    }));
  }

  async assignAgent(account, input) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const client = await this.pool.connect();
    const targetAccount = { ...account, tenantId: input.tenantId };
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, targetAccount);
      const tenant = await client.query("SELECT id FROM tenants WHERE id=$1 AND status='active' FOR UPDATE", [input.tenantId]);
      if (!tenant.rowCount) throw Object.assign(new Error('未找到该客户空间，请刷新列表后重新选择。'), { publicCode: 'tenant_not_found' });
      const ownerResult = await client.query(
        `SELECT tm.user_id,u.username FROM tenant_members tm JOIN users u ON u.id=tm.user_id
         WHERE tm.tenant_id=$1 AND tm.member_type='owner' AND tm.status='active'
         ORDER BY tm.joined_at,tm.user_id LIMIT 1`,
        [input.tenantId]
      );
      if (!ownerResult.rowCount) throw Object.assign(new Error('该客户空间还没有主账号，请先确认空间归属后再操作。'), { publicCode: 'tenant_owner_missing' });
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,'system-agent-assign',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [input.tenantId, input.idempotencyKey, input.requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(
          `SELECT status,request_hash,response_code,response_body FROM idempotency_records
           WHERE tenant_id=$1 AND namespace='system-agent-assign' AND idempotency_key=$2 FOR UPDATE`,
          [input.tenantId, input.idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== input.requestHash) throw Object.assign(new Error('该请求编号已用于其他操作，请刷新页面后重新提交。'), { publicCode: 'idempotency_key_conflict' });
        if (row.status === 'completed') {
          await client.query('COMMIT');
          return { replayed: true, statusCode: row.response_code, response: row.response_body };
        }
        throw Object.assign(new Error('相同操作正在处理中，请稍候片刻再查看结果。'), { publicCode: 'idempotency_request_in_progress' });
      }
      const previousResult = await client.query(
        `SELECT status,source,deposit_mode,credit_score,qualified_at,expires_at,
                status='active' AND (expires_at IS NULL OR expires_at>now()) AS currently_active
         FROM agents WHERE tenant_id=$1 FOR UPDATE`,
        [input.tenantId]
      );
      const previous = previousResult.rows[0] || null;
      if (previous && previous.status === 'permanently_banned') throw Object.assign(new Error('该代理商资格已被永久取消，不能再申请激活码，请联系系统管理员核实。'), { publicCode: 'agent_permanently_banned' });
      if (previous && (previous.currently_active === true || ['pending', 'suspended'].includes(previous.status))) {
        throw Object.assign(new Error('该客户空间已经是有效代理商，无需重复指派。'), { publicCode: 'agent_already_active' });
      }
      if (previous && Number(previous.credit_score) <= 4 && input.depositMode !== 'required') {
        throw Object.assign(new Error('该代理商按规则必须缴纳保证金，请先完成保证金到账确认。'), { publicCode: 'agent_deposit_mode_required' });
      }
      const owner = ownerResult.rows[0];
      const assigned = await client.query(
        `INSERT INTO agents(tenant_id,owner_user_id,source,status,deposit_mode,qualified_at,expires_at,first_qualified_at,assigned_reason)
         VALUES($1,$2,'assigned',CASE WHEN $3='required' THEN 'pending' ELSE 'active' END,$3,
                CASE WHEN $3='required' THEN NULL ELSE now() END,CASE WHEN $3='required' THEN NULL ELSE now()+interval '365 days' END,
                CASE WHEN $3='required' THEN NULL ELSE now() END,$4)
         ON CONFLICT(tenant_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id,source='assigned',status=EXCLUDED.status,
           deposit_mode=EXCLUDED.deposit_mode,qualified_at=EXCLUDED.qualified_at,expires_at=EXCLUDED.expires_at,
           first_qualified_at=CASE WHEN $3='required' THEN agents.first_qualified_at ELSE COALESCE(agents.first_qualified_at,now()) END,application_blocked_until=NULL,
           assigned_reason=EXCLUDED.assigned_reason,updated_at=now()
         RETURNING status,source,deposit_mode,credit_score,qualified_at,expires_at`,
        [input.tenantId, owner.user_id, input.depositMode, input.reason]
      );
      const row = assigned.rows[0];
      await client.query(
        `INSERT INTO agent_qualification_events(tenant_id,actor_user_id,event_type,reason,previous_state,next_state)
         VALUES($1,$2,'assigned',$3,$4::jsonb,$5::jsonb)`,
        [input.tenantId, account.userId, input.reason, JSON.stringify(previous || {}), JSON.stringify({ status: row.status, source: row.source, depositMode: row.deposit_mode, expiresAt: row.expires_at })]
      );
      if (row.deposit_mode === 'required') {
        const depositDeadline = (await client.query(`SELECT clock_timestamp()+interval '7 days' AS value`)).rows[0].value;
        await client.query(
          `INSERT INTO agent_qualification_events(tenant_id,actor_user_id,event_type,reason,previous_state,next_state)
           VALUES($1,$2,'deposit_required','押金版资格需在7天内由管理员确认1000元保证金',$3::jsonb,$4::jsonb)`,
          [input.tenantId, account.userId, JSON.stringify({ status: previous && previous.status || 'not_assigned' }),
            JSON.stringify({ status: 'pending', depositRequiredMinor: AGENT_DEPOSIT_REQUIRED_MINOR, depositDeadline: depositDeadline.toISOString() })]
        );
      }
      await this.insertUserNotification(client, {
        tenantId: input.tenantId, userId: owner.user_id, category: 'agent.qualification',
        title: row.status === 'pending' ? '代理商资格待保证金确认' : '代理商资格已开通',
        body: row.status === 'pending'
          ? '押金版资格需在7天内由管理员确认1000元保证金，到账确认前不能申请激活码。'
          : '系统管理员已开通365天代理商资格，请进入代理商中心查看具体到期时间。',
        resourceType: 'agent', resourceId: String(input.tenantId), dedupeKey: `agent:${input.tenantId}:assigned:${input.idempotencyKey}`
      });
      await this.writeAudit(client, targetAccount, 'system.agent.assign', 'agent', String(input.tenantId), 'success', {
        ownerUserId: String(owner.user_id), depositMode: input.depositMode, reason: input.reason
      });
      const response = { item: {
        tenantId: String(input.tenantId), ownerUserId: String(owner.user_id), ownerUsername: owner.username,
        status: row.status, isActive: row.status === 'active', source: row.source, depositMode: row.deposit_mode, creditScore: Number(row.credit_score),
        qualifiedAt: row.qualified_at, expiresAt: row.expires_at, assignedReason: input.reason
      } };
      const completed = await client.query(
        `UPDATE idempotency_records SET status='completed',response_code=201,response_body=$4::jsonb,
           resource_type='agent',resource_id=$3,updated_at=now()
         WHERE tenant_id=$1 AND namespace='system-agent-assign' AND idempotency_key=$2
           AND request_hash=$5 AND status='processing'`,
        [input.tenantId, input.idempotencyKey, String(input.tenantId), JSON.stringify(response), input.requestHash]
      );
      if (completed.rowCount !== 1) throw new Error('代理商指派结果写回失败，本次指派已回滚，请稍后重试。');
      await client.query('COMMIT');
      return { replayed: false, statusCode: 201, response };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async reviewAgentFinancialAction(account, input) {
    if (!account || !account.isSystemAdmin) throw Object.assign(new Error('该操作仅限系统管理员，请用系统管理员账号登录后再试。'), { publicCode: 'system_admin_required' });
    const client = await this.pool.connect();
    const targetAccount = { ...account, tenantId: input.tenantId };
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, targetAccount);
      const reviewer = await client.query(`SELECT password_hash FROM users WHERE id=$1 AND status='active' AND is_system_admin=true FOR UPDATE`, [account.userId]);
      if (!reviewer.rowCount || !await verifyPassword(input.password, reviewer.rows[0].password_hash)) {
        throw Object.assign(new Error('密码校验未通过，请输入当前登录密码后再执行该操作。'), { publicCode: 'reauthentication_failed' });
      }
      const agentResult = await client.query(`SELECT * FROM agents WHERE tenant_id=$1 FOR UPDATE`, [input.tenantId]);
      if (!agentResult.rowCount) throw Object.assign(new Error('未找到该客户的代理商记录，请先为它指派代理商资格。'), { publicCode: 'agent_not_found' });
      const agent = agentResult.rows[0];
      const claim = await client.query(
        `INSERT INTO idempotency_records(tenant_id,namespace,idempotency_key,request_hash,status)
         VALUES($1,'system-agent-financial-review',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING status`,
        [input.tenantId, input.idempotencyKey, input.requestHash]
      );
      if (!claim.rowCount) {
        const existing = await client.query(
          `SELECT status,request_hash,response_code,response_body FROM idempotency_records
           WHERE tenant_id=$1 AND namespace='system-agent-financial-review' AND idempotency_key=$2 FOR UPDATE`,
          [input.tenantId, input.idempotencyKey]
        );
        const row = existing.rows[0];
        if (!row || row.request_hash !== input.requestHash) throw Object.assign(new Error('该请求编号已用于其他操作，请刷新页面后重新提交。'), { publicCode: 'idempotency_key_conflict' });
        if (row.status === 'completed') {
          await client.query('COMMIT');
          return { replayed: true, statusCode: row.response_code, response: row.response_body };
        }
        throw Object.assign(new Error('相同操作正在处理中，请稍候片刻再查看结果。'), { publicCode: 'idempotency_request_in_progress' });
      }
      const settings = (await client.query(
        `SELECT charging_enabled,membership_charging_enabled,automatic_agent_penalties_enabled FROM billing_settings WHERE singleton=true`
      )).rows[0] || {};
      const decisionAt = (await client.query(`SELECT clock_timestamp() AS value`)).rows[0].value;
      let summary = await this.agentFinancialSummary(client, input.tenantId);
      let nextStatus = agent.status;
      let eventType;
      let amountMinor = Number(input.amountMinor) || 0;
      if (input.action === 'confirm_deposit') {
        if (settings.charging_enabled !== true || settings.membership_charging_enabled !== true) {
          throw Object.assign(new Error('会员扣费开关尚未开启，暂时不能执行会员扣费。'), { publicCode: 'membership_charging_disabled' });
        }
        if (agent.deposit_mode !== 'required') throw Object.assign(new Error('该代理商当前不需要缴纳保证金，无需做保证金操作。'), { publicCode: 'agent_deposit_not_required' });
        const requiredTopUp = AGENT_DEPOSIT_REQUIRED_MINOR - summary.depositBalanceMinor;
        if (requiredTopUp <= 0) throw Object.assign(new Error('该代理商已免交保证金，不需要再确认到账。'), { publicCode: 'agent_deposit_already_funded' });
        if (amountMinor !== requiredTopUp) {
          throw Object.assign(new Error('本次确认的保证金金额与应缴金额不一致，请核对到账金额后重新填写。'), { publicCode: 'agent_deposit_amount_mismatch', expectedAmountMinor: requiredTopUp });
        }
        const eventKey = `deposit:${crypto.createHash('sha256').update(input.referenceId.toLowerCase()).digest('hex')}`;
        const inserted = await client.query(
          `INSERT INTO agent_financial_events(tenant_id,event_type,account_type,direction,currency,amount_minor,idempotency_key,reason,actor_user_id)
           VALUES($1,'deposit','deposit','credit','CNY',$2,$3,$4,$5) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id`,
          [input.tenantId, amountMinor, eventKey, input.reason, account.userId]
        );
        if (!inserted.rowCount) throw Object.assign(new Error('该凭证编号已用于其他资金操作，请核对后再提交。'), { publicCode: 'financial_reference_duplicate' });
        summary = await this.agentFinancialSummary(client, input.tenantId);
        if (summary.payableMinor <= 0 && ['pending', 'suspended'].includes(agent.status)) {
          nextStatus = 'active';
          await client.query(
            `UPDATE agents SET status='active',qualified_at=COALESCE(qualified_at,$2),expires_at=COALESCE(expires_at,$2+interval '365 days'),
                    first_qualified_at=COALESCE(first_qualified_at,$2),updated_at=$2 WHERE tenant_id=$1`,
            [input.tenantId, decisionAt]
          );
        }
        eventType = 'deposit_confirmed';
      } else if (input.action === 'confirm_default') {
        if (settings.automatic_agent_penalties_enabled !== true) {
          throw Object.assign(new Error('代理商自动处罚开关尚未开启，本次不会自动处罚，可先人工处理。'), { publicCode: 'automatic_agent_penalties_disabled' });
        }
        await this.reconcileAgentDefaultBatchesForClient(client, agent, decisionAt);
        const batch = await client.query(
          `SELECT array_agg(DISTINCT e.activation_code_id ORDER BY e.activation_code_id) AS code_ids
           FROM activation_code_events e
           WHERE e.tenant_id=$1 AND e.event_type='payment_default_batch_assigned' AND e.metadata->>'batchId'=$2`,
          [input.tenantId, input.batchId]
        );
        const codeIds = batch.rows[0] && batch.rows[0].code_ids || [];
        if (!codeIds.length) throw Object.assign(new Error('未找到这批欠款记录，请刷新列表后重试。'), { publicCode: 'agent_default_batch_not_found' });
        const scoreAfter = Math.max(0, Number(agent.credit_score) - 2);
        const credit = await client.query(
          `INSERT INTO agent_credit_events(tenant_id,event_type,delta,score_after,cycle_key,activation_code_id,actor_user_id,reason)
           VALUES($1,'default',-2,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,event_type,cycle_key) DO NOTHING RETURNING id`,
          [input.tenantId, scoreAfter, input.batchId, codeIds[0], account.userId, input.reason]
        );
        if (!credit.rowCount) throw Object.assign(new Error('这批欠款已经确认过，不能重复确认。'), { publicCode: 'agent_default_already_confirmed' });
        for (const codeId of codeIds) {
          await client.query(
            `INSERT INTO agent_financial_events(tenant_id,activation_code_id,event_type,account_type,direction,currency,amount_minor,idempotency_key,reason,actor_user_id)
             SELECT tenant_id,id,'amount_due','payable','debit','CNY',locked_agent_price_minor,$3,'逾期激活码应付平台代理价',$4
             FROM activation_codes WHERE tenant_id=$1 AND id=$2
             ON CONFLICT(tenant_id,idempotency_key) DO NOTHING`,
            [input.tenantId, codeId, `activation:${codeId}:amount-due`, account.userId]
          );
        }
        await client.query(
          `UPDATE activation_codes SET state='frozen',updated_at=$3
           WHERE tenant_id=$1 AND id=ANY($2::bigint[]) AND state IN ('used_temporary','payment_review')`,
          [input.tenantId, codeIds, decisionAt]
        );
        const frozenPeriods = await client.query(
          `UPDATE membership_periods p SET state='frozen',updated_at=$3
           WHERE p.source_type='activation_code' AND p.source_ref=ANY($2::text[]) AND p.state='active'
             AND EXISTS (
               SELECT 1 FROM activation_codes c
               WHERE c.tenant_id=$1 AND c.id=ANY($4::bigint[]) AND c.id::text=p.source_ref
             )
           RETURNING p.tenant_id`,
          [input.tenantId, codeIds.map(String), decisionAt, codeIds]
        );
        for (const targetTenantId of new Set(frozenPeriods.rows.map(row => String(row.tenant_id)))) {
          await this.reconcileMembershipPeriodsForClient(client, targetTenantId, decisionAt, account.userId);
        }
        nextStatus = agent.status;
        if (scoreAfter <= 4) {
          if (agent.deposit_mode === 'waived') {
            nextStatus = 'suspended';
            await client.query(`UPDATE agents SET credit_score=$2,deposit_mode='required',status='suspended',updated_at=$3 WHERE tenant_id=$1`, [input.tenantId, scoreAfter, decisionAt]);
            const deadline = new Date(decisionAt.getTime() + 7 * 86400000);
            await client.query(
              `INSERT INTO agent_qualification_events(tenant_id,actor_user_id,event_type,reason,previous_state,next_state)
               VALUES($1,$2,'deposit_required','信用分降至4分，7天内补足1000元保证金',$3::jsonb,$4::jsonb)`,
              [input.tenantId, account.userId, JSON.stringify({ status: agent.status, depositMode: agent.deposit_mode, creditScore: agent.credit_score }),
                JSON.stringify({ status: 'suspended', depositMode: 'required', creditScore: scoreAfter, depositRequiredMinor: AGENT_DEPOSIT_REQUIRED_MINOR, depositDeadline: deadline.toISOString() })]
            );
          } else {
            const priorPenalties = await client.query(
              `SELECT count(*)::integer AS count FROM agent_financial_events WHERE tenant_id=$1 AND event_type='penalty' AND account_type='deposit'`,
              [input.tenantId]
            );
            const repeat = Number(priorPenalties.rows[0].count) > 0;
            amountMinor = repeat ? summary.depositBalanceMinor
              : summary.depositBalanceMinor >= AGENT_DEPOSIT_REQUIRED_MINOR ? 20000 : 0;
            if (amountMinor > 0) {
              await client.query(
                `INSERT INTO agent_financial_events(tenant_id,event_type,account_type,direction,currency,amount_minor,idempotency_key,reason,actor_user_id)
                 VALUES($1,'penalty','deposit','debit','CNY',$2,$3,$4,$5)`,
                [input.tenantId, amountMinor, `deposit-penalty:${input.batchId}`, input.reason, account.userId]
              );
            }
            nextStatus = repeat ? 'permanently_banned' : 'suspended';
            await client.query(`UPDATE agents SET credit_score=$2,status=$3,updated_at=$4 WHERE tenant_id=$1`, [input.tenantId, scoreAfter, nextStatus, decisionAt]);
            if (!repeat && summary.depositBalanceMinor - amountMinor < AGENT_DEPOSIT_REQUIRED_MINOR) {
              const deadline = new Date(decisionAt.getTime() + 7 * 86400000);
              await client.query(
                `INSERT INTO agent_qualification_events(tenant_id,actor_user_id,event_type,reason,previous_state,next_state)
                 VALUES($1,$2,'deposit_required','保证金处罚后须在7天内补足至1000元',$3::jsonb,$4::jsonb)`,
                [input.tenantId, account.userId,
                  JSON.stringify({ status: agent.status, depositBalanceMinor: summary.depositBalanceMinor }),
                  JSON.stringify({ status: 'suspended', depositBalanceMinor: summary.depositBalanceMinor - amountMinor,
                    depositRequiredMinor: AGENT_DEPOSIT_REQUIRED_MINOR, depositDeadline: deadline.toISOString() })]
              );
            }
          }
        } else {
          await client.query(`UPDATE agents SET credit_score=$2,updated_at=$3 WHERE tenant_id=$1`, [input.tenantId, scoreAfter, decisionAt]);
        }
        eventType = 'default_confirmed';
      } else if (input.action === 'refund_deposit') {
        if (settings.charging_enabled !== true || settings.membership_charging_enabled !== true) {
          throw Object.assign(new Error('会员扣费开关尚未开启，暂时不能执行会员扣费。'), { publicCode: 'membership_charging_disabled' });
        }
        if (!['cancelled', 'expired'].includes(agent.status) || new Date(agent.updated_at).getTime() + 30 * 86400000 > decisionAt.getTime()) {
          throw Object.assign(new Error('该代理商刚退还过保证金，需等待1个自然月后才能再次退保证金。'), { publicCode: 'agent_deposit_refund_wait' });
        }
        const unfinished = await client.query(
          `SELECT 1 FROM activation_codes WHERE tenant_id=$1 AND state IN ('issued','used_temporary','payment_review','frozen') LIMIT 1`, [input.tenantId]
        );
        if (summary.payableMinor > 0 || unfinished.rowCount) throw Object.assign(new Error('该代理商仍有未结欠款或销量未达标，暂时不能退还保证金。'), { publicCode: 'agent_deposit_refund_blocked' });
        if (summary.depositBalanceMinor <= 0 || amountMinor !== summary.depositBalanceMinor) {
          throw Object.assign(new Error('本次确认的保证金金额与应缴金额不一致，请核对到账金额后重新填写。'), { publicCode: 'agent_deposit_amount_mismatch', expectedAmountMinor: summary.depositBalanceMinor });
        }
        const eventKey = `refund:${crypto.createHash('sha256').update(input.referenceId.toLowerCase()).digest('hex')}`;
        const inserted = await client.query(
          `INSERT INTO agent_financial_events(tenant_id,event_type,account_type,direction,currency,amount_minor,idempotency_key,reason,actor_user_id)
           VALUES($1,'refund','deposit','debit','CNY',$2,$3,$4,$5) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING RETURNING id`,
          [input.tenantId, amountMinor, eventKey, input.reason, account.userId]
        );
        if (!inserted.rowCount) throw Object.assign(new Error('该凭证编号已用于其他资金操作，请核对后再提交。'), { publicCode: 'financial_reference_duplicate' });
        eventType = 'deposit_refunded';
      } else {
        throw Object.assign(new Error('请选择正确的资金审核动作（保证金到账确认、欠款确认或保证金退还）。'), { publicCode: 'agent_financial_action_invalid' });
      }
      summary = await this.agentFinancialSummary(client, input.tenantId);
      await client.query(
        `INSERT INTO agent_qualification_events(tenant_id,actor_user_id,event_type,reason,previous_state,next_state)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [input.tenantId, account.userId, eventType, input.reason,
          JSON.stringify({ status: agent.status, creditScore: Number(agent.credit_score) }),
          JSON.stringify({ status: nextStatus, payableMinor: summary.payableMinor, depositBalanceMinor: summary.depositBalanceMinor })]
      );
      await this.writeAudit(client, targetAccount, `system.agent.financial.${input.action}`, 'agent', String(input.tenantId), 'success', {
        action: input.action, batchId: input.batchId || null, amountMinor, referenceHash: input.referenceId
          ? crypto.createHash('sha256').update(input.referenceId.toLowerCase()).digest('hex') : null
      });
      const response = { item: { tenantId: String(input.tenantId), action: input.action, status: nextStatus, financial: summary, reviewedAt: decisionAt } };
      const completed = await client.query(
        `UPDATE idempotency_records SET status='completed',response_code=200,response_body=$4::jsonb,
           resource_type='agent',resource_id=$3,updated_at=$5
         WHERE tenant_id=$1 AND namespace='system-agent-financial-review' AND idempotency_key=$2
           AND request_hash=$6 AND status='processing'`,
        [input.tenantId, input.idempotencyKey, String(input.tenantId), JSON.stringify(response), decisionAt, input.requestHash]
      );
      if (completed.rowCount !== 1) throw new Error('代理商资金审核结果写回失败，本次操作已回滚，请稍后重试。');
      await client.query('COMMIT');
      return { replayed: false, statusCode: 200, response };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {}); throw error;
    } finally { client.release(); }
  }

  async listAuditEvents(account, options = {}) {
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    const beforeId = /^\d+$/.test(String(options.beforeId || '')) ? String(options.beforeId) : null;
    const result = await this.pool.query(
      `SELECT ae.id::text, ae.action, ae.resource_type, ae.resource_id, ae.result,
              ae.metadata, ae.created_at, ae.actor_user_id::text AS actor_user_id,
              (u.id IS NOT NULL) AS actor_user_exists,
              COALESCE(u.username, legacy_admin.username) AS actor_username,
              COALESCE(u.is_system_admin, legacy_admin.is_system_admin) AS actor_is_system_admin,
              COALESCE(up.full_name, '') AS actor_profile_full_name,
              CASE WHEN up.email_verified_at IS NOT NULL THEN COALESCE(up.email, '') ELSE '' END AS actor_email
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.actor_user_id
       LEFT JOIN users legacy_admin ON ae.actor_user_id IS NULL
         AND ae.metadata->>'systemAdminActorUsername' = '系统管理员'
         AND legacy_admin.id::text = ae.metadata->>'systemAdminActorUserId'
         AND lower(legacy_admin.username) = 'admin' AND legacy_admin.is_system_admin = true
       LEFT JOIN user_profiles up ON up.user_id = COALESCE(u.id, legacy_admin.id)
       WHERE ae.tenant_id = $1 AND ($2::bigint IS NULL OR ae.id < $2::bigint)
       ORDER BY ae.id DESC LIMIT $3`,
      [account.tenantId, beforeId, limit]
    );
    return result.rows.map(auditEventRow);
  }

  async exportAuditEvents(account, limit = 10000) {
    const safeLimit = Math.max(1, Math.min(10000, Number(limit) || 10000));
    const result = await this.pool.query(
      `SELECT ae.id::text, ae.action, ae.resource_type, ae.resource_id, ae.result,
              ae.metadata, ae.created_at, ae.actor_user_id::text AS actor_user_id,
              (u.id IS NOT NULL) AS actor_user_exists,
              COALESCE(u.username, legacy_admin.username) AS actor_username,
              COALESCE(u.is_system_admin, legacy_admin.is_system_admin) AS actor_is_system_admin,
              COALESCE(up.full_name, '') AS actor_profile_full_name,
              CASE WHEN up.email_verified_at IS NOT NULL THEN COALESCE(up.email, '') ELSE '' END AS actor_email
       FROM audit_events ae
       LEFT JOIN users u ON u.id = ae.actor_user_id
       LEFT JOIN users legacy_admin ON ae.actor_user_id IS NULL
         AND ae.metadata->>'systemAdminActorUsername' = '系统管理员'
         AND legacy_admin.id::text = ae.metadata->>'systemAdminActorUserId'
         AND lower(legacy_admin.username) = 'admin' AND legacy_admin.is_system_admin = true
       LEFT JOIN user_profiles up ON up.user_id = COALESCE(u.id, legacy_admin.id)
       WHERE ae.tenant_id = $1
       ORDER BY ae.id DESC LIMIT $2`,
      [account.tenantId, safeLimit]
    );
    return result.rows.map(auditEventRow);
  }

  async recordAudit(account, action, resourceType, resourceId, result, metadata) {
    return this.writeAudit(this.pool, account, action, resourceType, resourceId, result, metadata);
  }

  async setMemberPermissions(account, userId, permissions, shopScopeMode, shopIds) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      const member = await client.query(
        `UPDATE tenant_members SET shop_scope_mode = $3, updated_at = now()
         WHERE tenant_id = $1 AND user_id = $2 AND member_type <> 'owner' AND status <> 'removed'
           AND EXISTS (SELECT 1 FROM users u WHERE u.id=tenant_members.user_id AND u.is_system_admin=false)
         RETURNING user_id`,
        [account.tenantId, userId, shopScopeMode === 'all' ? 'all' : 'selected']
      );
      if (!member.rowCount) { const error = new Error('未找到该成员账号，请刷新成员列表后重试。'); error.publicCode = 'member_not_found'; throw error; }
      const requestedShopIds = [...new Set((Array.isArray(shopIds) ? shopIds : []).map(value => String(value)).filter(value => /^\d+$/.test(value)))];
      const allowedShops = requestedShopIds.length ? await client.query(
        `SELECT id FROM shops WHERE tenant_id = $1 AND status = 'active' AND id = ANY($2::bigint[])`,
        [account.tenantId, requestedShopIds]
      ) : { rows: [] };
      await client.query(`DELETE FROM member_shop_scopes WHERE tenant_id = $1 AND user_id = $2`, [account.tenantId, userId]);
      if (shopScopeMode !== 'all' && allowedShops.rows.length) {
        await client.query(
          `INSERT INTO member_shop_scopes (tenant_id, user_id, shop_id, granted_by_user_id)
           SELECT $1, $2, id, $4 FROM shops WHERE tenant_id = $1 AND id = ANY($3::bigint[])`,
          [account.tenantId, userId, allowedShops.rows.map(row => row.id), account.userId]
        );
      }
      const role = await client.query(
        `INSERT INTO roles (tenant_id, code, name, is_system)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [account.tenantId, 'member_' + userId, '子账号 ' + userId + ' 权限']
      );
      await client.query(`DELETE FROM member_roles WHERE tenant_id = $1 AND user_id = $2`, [account.tenantId, userId]);
      await client.query(`DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2`, [account.tenantId, role.rows[0].id]);
      const allowed = permissions.length ? await client.query(
        `SELECT code FROM permissions WHERE code = ANY($1::varchar[])`, [permissions]
      ) : { rows: [] };
      permissions = allowed.rows.map(row => row.code);
      if (permissions.length) {
        await client.query(
          `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
           SELECT $1, $2, code FROM permissions WHERE code = ANY($3::varchar[])`,
          [account.tenantId, role.rows[0].id, permissions]
        );
      }
      await client.query(
        `INSERT INTO member_roles (tenant_id, user_id, role_id, granted_by_user_id)
         VALUES ($1, $2, $3, $4)`,
        [account.tenantId, userId, role.rows[0].id, account.userId]
      );
      const savedShopIds = shopScopeMode === 'all' ? [] : allowedShops.rows.map(row => String(row.id));
      await this.writeAudit(client, account, 'tenant.member.permissions.update', 'user', String(userId), 'success', { permissions, shopScopeMode, shopIds: savedShopIds });
      await client.query('COMMIT');
      return { userId: String(userId), permissions, shopScopeMode: shopScopeMode === 'all' ? 'all' : 'selected', shopIds: savedShopIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async createMember(account, input) {
    const email = normalizeAuthEmail(input && input.email);
    if (!email) throw Object.assign(new Error('请填写已注册并完成验证的邮箱。'), { publicCode: 'member_email_invalid' });
    const displayName = String(input && input.displayName || '').trim();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      await client.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [account.tenantId]);
      const target = await client.query(
        `SELECT u.id,u.username,up.email
           FROM users u
           JOIN user_profiles up ON up.user_id=u.id
          WHERE u.is_system_admin=false
            AND u.status='active'
            AND up.email_verified_at IS NOT NULL
            AND lower(up.email)=lower($1)
          LIMIT 1
          FOR UPDATE OF u`,
        [email]
      );
      if (!target.rowCount) {
        throw Object.assign(new Error('该邮箱尚未注册或尚未完成邮箱验证，请让用户先注册账号。'), { publicCode: 'member_email_not_registered' });
      }
      const user = target.rows[0];
      if (String(user.id) === String(account.userId)) {
        throw Object.assign(new Error('主账号不能把自己添加为子账号。'), { publicCode: 'member_self_add_denied' });
      }
      const existing = await client.query(
        'SELECT member_type,status FROM tenant_members WHERE tenant_id=$1 AND user_id=$2 FOR UPDATE',
        [account.tenantId, user.id]
      );
      if (existing.rowCount && existing.rows[0].status !== 'removed') {
        throw Object.assign(new Error('该邮箱已经是当前企业成员。'), { publicCode: 'member_already_exists' });
      }
      const benefits = await this.activeMembershipBenefits(client, account.tenantId);
      const childAccountLimit = Math.max(0, Number(benefits.childAccountLimit || 0));
      const activeChildren = await client.query(
        `SELECT count(*)::integer AS count FROM tenant_members m JOIN users u ON u.id=m.user_id
         WHERE m.tenant_id=$1 AND m.member_type='member' AND m.status='active' AND u.is_system_admin=false`,
        [account.tenantId]
      );
      if (Number(activeChildren.rows[0].count) >= childAccountLimit) {
        const error = new Error('当前会员套餐的子账号数量已达上限，请先升级会员或停用多余子账号。');
        error.publicCode = 'membership_child_account_limit';
        error.limit = childAccountLimit;
        throw error;
      }
      await client.query(
        `INSERT INTO tenant_members
           (tenant_id,user_id,member_type,status,shop_scope_mode,display_name,created_by_user_id,joined_at)
         VALUES($1,$2,'member','active',$3,$4,$5,now())
         ON CONFLICT(tenant_id,user_id) DO UPDATE
           SET member_type='member',status='active',shop_scope_mode=EXCLUDED.shop_scope_mode,
               display_name=EXCLUDED.display_name,created_by_user_id=EXCLUDED.created_by_user_id,
               joined_at=now(),updated_at=now()`,
        [account.tenantId, user.id, input.shopScopeMode || 'selected', displayName || email, account.userId]
      );
      const roleResult = await client.query(
        `INSERT INTO roles (tenant_id, code, name, is_system)
         VALUES ($1, 'staff', '普通员工', true)
         ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [account.tenantId]
      );
      await client.query(
        `INSERT INTO role_permissions (tenant_id, role_id, permission_code)
         SELECT $1, $2, code FROM permissions WHERE code IN ('shops.read','orders.read','products.read','collection.read','selection.read')
         ON CONFLICT DO NOTHING`,
        [account.tenantId, roleResult.rows[0].id]
      );
      await client.query(
        `INSERT INTO member_roles (tenant_id, user_id, role_id, granted_by_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [account.tenantId, user.id, roleResult.rows[0].id, account.userId]
      );
      await this.writeAudit(client, account, 'tenant.member.create', 'user', String(user.id), 'success', { emailMask: maskLoginAccount(email) });
      await client.query('COMMIT');
      return {
        userId: String(user.id), username: user.username, email,
        displayName: displayName || email, status: 'active', memberType: 'member', roles: ['staff']
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async setMemberStatus(account, userId, status) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      const result = await client.query(
        `UPDATE tenant_members SET status = $3, updated_at = now()
         WHERE tenant_id = $1 AND user_id = $2 AND member_type <> 'owner' AND status <> 'removed'
           AND EXISTS (SELECT 1 FROM users u WHERE u.id=tenant_members.user_id AND u.is_system_admin=false)
         RETURNING user_id, status`,
        [account.tenantId, userId, status]
      );
      if (!result.rowCount) {
        const error = new Error('未找到该成员账号，请刷新成员列表后重试。');
        error.publicCode = 'member_not_found';
        throw error;
      }
      if (status !== 'active') {
        await client.query(
          `UPDATE sessions SET revoked_at = COALESCE(revoked_at, now()), revoke_reason = 'member_disabled'
           WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [account.tenantId, userId]
        );
      }
      await this.writeAudit(client, account, 'tenant.member.status.update', 'user', String(userId), 'success', { status });
      await client.query('COMMIT');
      return { userId: String(userId), status };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveSkuImageUpload(account, input) {
    await this.assertSkuImageTarget(account, input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sku-image:${account.tenantId}:${input.clientId}:${input.productId}:${input.variantRef}`]);
      const originalExisting = await client.query('SELECT id FROM sku_image_objects WHERE tenant_id=$1 AND sha256=$2 FOR UPDATE', [account.tenantId, input.original.inputSha256]);
      const originalId = originalExisting.rowCount ? originalExisting.rows[0].id : input.originalId;
      if (!originalExisting.rowCount) await client.query(
        `INSERT INTO sku_image_objects(id,tenant_id,private_object_key,sha256,mime_type,extension,size_bytes,source_type,object_role,state,created_by_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'original','stored',$9)`,
        [originalId, account.tenantId, input.original.objectKey, input.original.inputSha256, input.original.inputMimeType, input.original.inputExtension, input.original.inputSizeBytes, input.sourceType || 'local_upload', account.userId]
      );
      const existing = await client.query('SELECT id FROM sku_image_objects WHERE tenant_id=$1 AND sha256=$2 FOR UPDATE', [account.tenantId, input.sha256]);
      const objectId = existing.rowCount ? existing.rows[0].id : input.id;
      if (!existing.rowCount) await client.query(
        `INSERT INTO sku_image_objects(id,tenant_id,private_object_key,sha256,mime_type,extension,size_bytes,width,height,frame_count,source_type,object_role,state,parent_object_id,processing_summary,created_by_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,'working','ready',$11,$12::jsonb,$13)`,
        [objectId, account.tenantId, input.objectKey, input.sha256, input.mimeType, input.extension, input.sizeBytes, input.width, input.height, input.sourceType || 'local_upload', originalId, JSON.stringify(input.processingSummary || {}), account.userId]
      );
      const existingLinks = await client.query(
        `SELECT id,image_object_id,sort_order,is_cover,association_version FROM sku_image_links
         WHERE tenant_id=$1 AND client_id=$2 AND product_ref=$3 AND variant_ref=$4 ORDER BY sort_order FOR UPDATE`,
        [account.tenantId, input.clientId, input.productId, input.variantRef]
      );
      const duplicateLink = existingLinks.rows.find(row => String(row.image_object_id) === String(objectId));
      if (duplicateLink) {
        await this.writeAudit(client, account, 'sku.image.upload', 'sku_image_object', objectId, 'success', { productId: input.productId, variantRef: input.variantRef, sizeBytes: input.sizeBytes, duplicateAssociation: true });
        await client.query('COMMIT');
        return { id: objectId, objectId, linkId: duplicateLink.id, associationVersion: Number(duplicateLink.association_version), mimeType: input.mimeType, extension: input.extension, sizeBytes: input.sizeBytes, width: input.width, height: input.height, state: 'ready', objectRole: 'working', url: `/api/private-objects/sku-images/${objectId}`, duplicate: true, duplicateAssociation: true };
      }
      const position = existingLinks.rows.length ? Math.max(...existingLinks.rows.map(row => Number(row.sort_order))) + 1 : 0;
      if (position >= 30) throw Object.assign(new Error('该规格的图片数量已达上限，请先删除多余图片。'), { publicCode: 'sku_image_limit_reached', status: 409 });
      await client.query(`INSERT INTO sku_image_links(id,tenant_id,client_id,product_ref,variant_ref,image_object_id,sort_order,is_cover,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [input.linkId, account.tenantId, input.clientId, input.productId, input.variantRef, objectId, position, position === 0, account.userId]);
      await this.writeAudit(client, account, 'sku.image.upload', 'sku_image_object', objectId, 'success', { productId: input.productId, variantRef: input.variantRef, sizeBytes: input.sizeBytes });
      await client.query('COMMIT'); return { id: objectId, objectId, linkId: input.linkId, associationVersion: 1, mimeType: input.mimeType, extension: input.extension, sizeBytes: input.sizeBytes, width: input.width, height: input.height, state: 'ready', objectRole: 'working', url: `/api/private-objects/sku-images/${objectId}`, duplicate: Boolean(existing.rowCount), duplicateAssociation: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async getSkuImageObject(account, id) {
    let result = await this.pool.query(`SELECT object.* FROM sku_image_objects object JOIN sku_image_links link ON link.image_object_id=object.id AND link.tenant_id=object.tenant_id WHERE object.id=$1 AND object.tenant_id=$2 LIMIT 1`, [id, account.tenantId]);
    const linked = Boolean(result.rowCount); if (!linked) result = await this.pool.query(`SELECT * FROM sku_image_objects WHERE id=$1 AND tenant_id=$2 AND object_role='candidate' AND state='candidate'`, [id, account.tenantId]);
    if (!result.rowCount) return null;
    const allowed = await this.listAllowedShops(account);
    if (allowed !== null) { const links = linked ? await this.pool.query('SELECT DISTINCT client_id,product_ref FROM sku_image_links WHERE tenant_id=$1 AND image_object_id=$2', [account.tenantId, id]) : { rows: [{ client_id: result.rows[0].processing_summary?.target?.clientId }] }; if (!links.rows.some(link => allowed.some(shop => String(shop.externalShopId) === String(link.client_id)))) return null; }
    return result.rows[0];
  }

  async saveSkuImagePreviewCache(account, id, input) {
    const preview = {
      version: 1,
      sourceSha256: String(input.sourceSha256 || ''),
      objectKey: String(input.objectKey || ''),
      sha256: String(input.sha256 || ''),
      sizeBytes: Number(input.sizeBytes) || 0,
      mimeType: String(input.mimeType || 'image/jpeg'),
      width: Number(input.width) || 0,
      height: Number(input.height) || 0,
      maxSide: Number(input.maxSide) || 360
    };
    if (!/^[a-f0-9]{64}$/i.test(preview.sourceSha256) || !/^[a-f0-9]{64}$/i.test(preview.sha256) || !preview.objectKey || preview.sizeBytes < 1 || preview.width < 1 || preview.height < 1) throw Object.assign(new Error('预览图缓存元数据不完整，无法保存。'), { publicCode: 'sku_image_preview_cache_invalid', status: 422 });
    const result = await this.pool.query(
      `UPDATE sku_image_objects
       SET processing_summary = jsonb_set(COALESCE(processing_summary,'{}'::jsonb), '{previewCache}', $3::jsonb, true)
       WHERE id=$1 AND tenant_id=$2 AND sha256=$4
       RETURNING id`,
      [id, account.tenantId, JSON.stringify(preview), preview.sourceSha256]
    );
    if (!result.rowCount) throw Object.assign(new Error('图片已经发生变化，请刷新后重新读取预览。'), { publicCode: 'sku_image_preview_source_changed', status: 409 });
    return preview;
  }

  async saveSkuImageCandidate(account, input) {
    await this.assertSkuImageTarget(account, input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const sourceKind = input.sourceKind === 'platform_snapshot' ? 'platform_snapshot' : 'linked';
      let parentObjectId = null;
      if (sourceKind === 'linked') {
        const link = await client.query(`SELECT image_object_id,association_version FROM sku_image_links WHERE id=$1 AND tenant_id=$2 AND client_id=$3 AND product_ref=$4 AND variant_ref=$5 FOR UPDATE`, [input.linkId, account.tenantId, input.clientId, input.productId, input.variantRef]);
        if (!link.rowCount || Number(link.rows[0].association_version) !== Number(input.associationVersion)) throw Object.assign(new Error('该商品图片已被他人修改，请刷新后重新编辑，避免覆盖别人的结果。'), { publicCode: 'sku_image_version_conflict', status: 409 });
        parentObjectId = link.rows[0].image_object_id;
      } else if (!/^online:\d+:\d+$/.test(String(input.sourceRef || ''))) throw Object.assign(new Error('平台快照来源记录无效，请重新发起AI任务。'), { publicCode: 'sku_image_ai_source_invalid', status: 409 });
      const existing = await client.query('SELECT id,object_role,state FROM sku_image_objects WHERE tenant_id=$1 AND sha256=$2 FOR UPDATE', [account.tenantId, input.sha256]);
      const objectId = existing.rowCount ? existing.rows[0].id : input.id;
      if (!existing.rowCount) await client.query(
        `INSERT INTO sku_image_objects(id,tenant_id,private_object_key,sha256,mime_type,extension,size_bytes,width,height,frame_count,source_type,object_role,state,parent_object_id,processing_summary,created_by_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'ai_candidate','candidate','candidate',$10,$11::jsonb,$12)`,
        [objectId, account.tenantId, input.objectKey, input.sha256, input.mimeType, input.extension, input.sizeBytes, input.width, input.height, parentObjectId, JSON.stringify({ ...(input.processingSummary || {}), capability: input.capability || input.processingSummary?.capability || 'image-redraw', target: { clientId: input.clientId, productId: input.productId, variantRef: input.variantRef, linkId: sourceKind === 'linked' ? input.linkId : null, associationVersion: sourceKind === 'linked' ? Number(input.associationVersion) : null, sourceKind, sourceRef: String(input.sourceRef || '') } }), account.userId]
      );
      await this.writeAudit(client, account, 'sku.image.ai.candidate', 'sku_image_object', objectId, 'success', { capability: input.capability, productId: input.productId, variantRef: input.variantRef });
      await client.query('COMMIT'); return { candidateId: String(objectId), url: `/api/private-objects/sku-images/${objectId}`, mimeType: input.mimeType, extension: input.extension, width: input.width, height: input.height };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  // 只读：列出该商品变体下 AI 产出的候选图（时间倒序，含是否已被采用）。不写库、不改状态。
  async listSkuImageCandidates(account, input) {
    await this.assertSkuImageTarget(account, input);
    const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 50);
    const retentionDays = 3;
    const listingKey = require('./product-create').LISTING_RECORD_KEY;
    const sql = `SELECT o.id, o.mime_type, o.extension, o.width, o.height, o.state, o.created_at, o.processing_summary,
      EXISTS (SELECT 1 FROM sku_image_links l WHERE l.tenant_id = o.tenant_id AND l.image_object_id = o.id) AS adopted
      FROM sku_image_objects o
      WHERE o.tenant_id = $1 AND o.source_type = 'ai_candidate' AND o.state <> 'processing'
        AND o.processing_summary #>> '{target,clientId}' = $2
        AND o.processing_summary #>> '{target,productId}' = $3
        AND o.processing_summary #>> '{target,variantRef}' = $4
        AND (
          o.created_at > now() - make_interval(days => $5)
          OR NOT EXISTS (
            SELECT 1 FROM tenant_documents d
            CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload)='array' THEN d.payload ELSE '[]'::jsonb END) listing
            WHERE d.tenant_id=o.tenant_id AND d.document_key=$6
              AND listing->>'source'='product_create_submit' AND listing->>'status'='新增成功'
              AND listing->>'clientId'=$2
              AND (listing->>'productId'=$3 OR listing->>'draftId'=$3)
              AND COALESCE(NULLIF(listing->>'completedAt',''),NULLIF(listing->>'updatedAt',''),'') ~ '^\\d{4}-\\d{2}-\\d{2}T'
              AND COALESCE(NULLIF(listing->>'completedAt',''),NULLIF(listing->>'updatedAt',''))::timestamptz <= now() - make_interval(days => $5)
          )
        )
      ORDER BY o.created_at DESC LIMIT $7`;
    const result = await this.pool.query(sql, [account.tenantId, String(input.clientId), String(input.productId), String(input.variantRef), retentionDays, listingKey, limit]);
    return result.rows.map(row => ({
      candidateId: String(row.id),
      url: '/api/private-objects/sku-images/' + String(row.id),
      mimeType: row.mime_type,
      extension: row.extension,
      width: row.width,
      height: row.height,
      state: row.state,
      capability: row.processing_summary && row.processing_summary.capability ? String(row.processing_summary.capability) : null,
      taskId: row.processing_summary && row.processing_summary.jobId ? String(row.processing_summary.jobId) : null,
      templateKey: row.processing_summary && row.processing_summary.templateKey ? String(row.processing_summary.templateKey) : null,
      sourceLanguage: row.processing_summary && row.processing_summary.sourceLanguage ? String(row.processing_summary.sourceLanguage) : null,
      targetLanguage: row.processing_summary && row.processing_summary.targetLanguage ? String(row.processing_summary.targetLanguage) : null,
      billingChannel: row.processing_summary && row.processing_summary.billingChannel ? String(row.processing_summary.billingChannel) : null,
      linkId: row.processing_summary && row.processing_summary.target && row.processing_summary.target.linkId ? String(row.processing_summary.target.linkId) : null,
      associationVersion: row.processing_summary && row.processing_summary.target && Number.isInteger(Number(row.processing_summary.target.associationVersion)) ? Number(row.processing_summary.target.associationVersion) : null,
      sourceKind: row.processing_summary && row.processing_summary.target && row.processing_summary.target.sourceKind ? String(row.processing_summary.target.sourceKind) : 'linked',
      sourceRef: row.processing_summary && row.processing_summary.target && row.processing_summary.target.sourceRef ? String(row.processing_summary.target.sourceRef) : '',
      adopted: Boolean(row.adopted),
      createdAt: row.created_at
    }));
  }
  async claimStaleAiCandidates(options = {}) {
    const retentionDays = Math.max(3, Math.min(30, Math.floor(Number(options.retentionDays) || 3)));
    const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.limit) || 200)));
    const listingKey = require('./product-create').LISTING_RECORD_KEY;
    try {
      const result = await this.pool.query(
        `WITH eligible AS (
           SELECT o.id,o.tenant_id
           FROM sku_image_objects o
           WHERE o.source_type='ai_candidate' AND o.object_role='candidate' AND o.state='candidate'
             AND o.created_at <= now() - make_interval(days => $1)
             AND NOT EXISTS (SELECT 1 FROM sku_image_links l WHERE l.tenant_id=o.tenant_id AND l.image_object_id=o.id)
             AND NOT EXISTS (SELECT 1 FROM sku_image_objects child WHERE child.tenant_id=o.tenant_id AND child.parent_object_id=o.id)
             AND EXISTS (
               SELECT 1 FROM tenant_documents d
               CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(d.payload)='array' THEN d.payload ELSE '[]'::jsonb END) listing
               WHERE d.tenant_id=o.tenant_id AND d.document_key=$3
                 AND listing->>'source'='product_create_submit' AND listing->>'status'='新增成功'
                 AND listing->>'clientId'=o.processing_summary #>> '{target,clientId}'
                 AND (listing->>'productId'=o.processing_summary #>> '{target,productId}' OR listing->>'draftId'=o.processing_summary #>> '{target,productId}')
                 AND COALESCE(NULLIF(listing->>'completedAt',''),NULLIF(listing->>'updatedAt',''),'') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                 AND COALESCE(NULLIF(listing->>'completedAt',''),NULLIF(listing->>'updatedAt',''))::timestamptz <= now() - make_interval(days => $1)
             )
           ORDER BY o.created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         UPDATE sku_image_objects o SET state='processing'
         FROM eligible e
         WHERE o.tenant_id=e.tenant_id AND o.id=e.id
           AND o.object_role='candidate' AND o.state='candidate'
           AND NOT EXISTS (SELECT 1 FROM sku_image_links l WHERE l.tenant_id=o.tenant_id AND l.image_object_id=o.id)
         RETURNING o.id,o.tenant_id,o.private_object_key,o.size_bytes,o.processing_summary #>> '{previewCache,objectKey}' AS preview_object_key`,
        [retentionDays, limit, listingKey]
      );
      return {
        retentionDays,
        claimed: result.rowCount,
        items: result.rows.map(row => ({ id: String(row.id), tenantId: String(row.tenant_id), objectKey: String(row.private_object_key || ''), previewObjectKey: String(row.preview_object_key || ''), sizeBytes: Number(row.size_bytes) || 0 }))
      };
    } catch (error) {
      if (error && error.code === '42P01') return { retentionDays, claimed: 0, items: [] };
      throw error;
    }
  }

  async finalizeStaleAiCandidate(item) {
    const result = await this.pool.query(
      `DELETE FROM sku_image_objects o
       WHERE o.id=$1 AND o.tenant_id=$2 AND o.source_type='ai_candidate' AND o.object_role='candidate' AND o.state='processing'
         AND NOT EXISTS (SELECT 1 FROM sku_image_links l WHERE l.tenant_id=o.tenant_id AND l.image_object_id=o.id)
         AND NOT EXISTS (SELECT 1 FROM sku_image_objects child WHERE child.tenant_id=o.tenant_id AND child.parent_object_id=o.id)
       RETURNING id`,
      [String(item.id), String(item.tenantId)]
    );
    return result.rowCount === 1;
  }

  async restoreStaleAiCandidate(item) {
    await this.pool.query(
      `UPDATE sku_image_objects SET state='candidate'
       WHERE id=$1 AND tenant_id=$2 AND source_type='ai_candidate' AND object_role='candidate' AND state='processing'`,
      [String(item.id), String(item.tenantId)]
    );
  }

  async skuImagePreviewObjectKeyInUse(objectKey, excludeId) {
    if (!objectKey) return false;
    const result = await this.pool.query(
      `SELECT 1 FROM sku_image_objects
       WHERE id<>$1 AND processing_summary #>> '{previewCache,objectKey}'=$2 LIMIT 1`,
      [String(excludeId), String(objectKey)]
    );
    return Boolean(result.rowCount);
  }

  async adoptSkuImageCandidate(account, input) {
    await this.assertSkuImageTarget(account, input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const link = await client.query(`SELECT image_object_id,association_version FROM sku_image_links WHERE id=$1 AND tenant_id=$2 AND client_id=$3 AND product_ref=$4 AND variant_ref=$5 FOR UPDATE`, [input.linkId, account.tenantId, input.clientId, input.productId, input.variantRef]);
      if (!link.rowCount || Number(link.rows[0].association_version) !== Number(input.associationVersion)) throw Object.assign(new Error('该商品图片已被他人修改，请刷新后重新编辑，避免覆盖别人的结果。'), { publicCode: 'sku_image_version_conflict', status: 409 });
      const candidate = await client.query(`SELECT id,object_role,state,processing_summary FROM sku_image_objects WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [input.candidateId, account.tenantId]);
      const target = candidate.rows[0]?.processing_summary?.target;
      if (!candidate.rowCount || candidate.rows[0].object_role !== 'candidate' || candidate.rows[0].state !== 'candidate' || String(target?.clientId) !== String(input.clientId) || String(target?.productId) !== String(input.productId) || String(target?.variantRef) !== String(input.variantRef) || String(target?.linkId) !== String(input.linkId)) throw Object.assign(new Error('未找到这张候选图片，请重新发起一次AI生成。'), { publicCode: 'sku_image_candidate_not_found', status: 404 });
      let adoptedLinkId = input.linkId;
      if (input.mode === 'append') {
        const links = await client.query(`SELECT id,image_object_id,sort_order FROM sku_image_links WHERE tenant_id=$1 AND client_id=$2 AND product_ref=$3 AND variant_ref=$4 ORDER BY sort_order FOR UPDATE`, [account.tenantId, input.clientId, input.productId, input.variantRef]);
        if (links.rows.some(row => String(row.image_object_id) === String(input.candidateId))) throw Object.assign(new Error('同一规格下已有相同的图片，请勿重复添加。'), { publicCode: 'sku_image_duplicate_in_variant', status: 409 });
        if (links.rowCount >= 30) throw Object.assign(new Error('该规格的图片数量已达上限，请先删除多余图片。'), { publicCode: 'sku_image_limit_reached', status: 409 });
        adoptedLinkId = crypto.randomUUID(); await client.query(`INSERT INTO sku_image_links(id,tenant_id,client_id,product_ref,variant_ref,image_object_id,sort_order,is_cover,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,false,$8)`, [adoptedLinkId, account.tenantId, input.clientId, input.productId, input.variantRef, input.candidateId, links.rowCount, account.userId]);
      } else await client.query(`UPDATE sku_image_links SET image_object_id=$1,association_version=association_version+1,updated_at=now() WHERE id=$2 AND tenant_id=$3`, [input.candidateId, input.linkId, account.tenantId]);
      await client.query(`UPDATE sku_image_objects SET object_role='working',state='ready' WHERE id=$1 AND tenant_id=$2`, [input.candidateId, account.tenantId]);
      await this.writeAudit(client, account, 'sku.image.ai.adopt', 'sku_image_object', input.candidateId, 'success', { mode: input.mode, productId: input.productId, variantRef: input.variantRef });
      await client.query('COMMIT'); return { candidateId: input.candidateId, linkId: String(adoptedLinkId), mode: input.mode };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  // 后台AI完成时一次提交对象元数据、历史记录和图片链接；对象二进制已先写入私有内容址存储，事务失败时不会暴露半成品链接。
  async getSkuImageVersionSource(account, input) {
    await this.assertSkuImageTarget(account, input);
    const result = await this.pool.query(
      `WITH RECURSIVE versions AS (
         SELECT object.*,0 AS depth FROM sku_image_links link
         JOIN sku_image_objects object ON object.id=link.image_object_id AND object.tenant_id=link.tenant_id
         WHERE link.id=$1 AND link.tenant_id=$2 AND link.client_id=$3 AND link.product_ref=$4 AND link.variant_ref=$5
           AND link.association_version=$6
         UNION ALL
         SELECT parent.*,versions.depth+1 FROM versions
         JOIN sku_image_objects parent ON parent.id=versions.parent_object_id AND parent.tenant_id=versions.tenant_id
       ) SELECT * FROM versions ${input.undo ? 'WHERE depth=1' : ''} ORDER BY depth ${input.restoreOriginal ? 'DESC' : 'ASC'} LIMIT 1`,
      [input.linkId, account.tenantId, input.clientId, input.productId, input.variantRef, input.associationVersion]
    );
    if (!result.rowCount) throw Object.assign(new Error(input.undo ? 'sku_image_undo_unavailable' : 'sku_image_version_conflict'), { publicCode: input.undo ? 'sku_image_undo_unavailable' : 'sku_image_version_conflict', status: 409 });
    return result.rows[0];
  }

  async saveSkuImageVersion(account, input) {
    await this.assertSkuImageTarget(account, input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const link = await client.query(
        `SELECT id,image_object_id,association_version FROM sku_image_links
         WHERE id=$1 AND tenant_id=$2 AND client_id=$3 AND product_ref=$4 AND variant_ref=$5 FOR UPDATE`,
        [input.linkId, account.tenantId, input.clientId, input.productId, input.variantRef]
      );
      if (!link.rowCount) throw Object.assign(new Error('未找到这条图片关联记录，请刷新后重试。'), { publicCode: 'sku_image_link_not_found', status: 404 });
      const current = link.rows[0];
      if (Number(current.association_version) !== Number(input.associationVersion) || String(current.image_object_id) !== String(input.parentObjectId)) throw Object.assign(new Error('该商品图片已被他人修改，请刷新后重新编辑，避免覆盖别人的结果。'), { publicCode: 'sku_image_version_conflict', status: 409 });
      const existing = await client.query('SELECT id FROM sku_image_objects WHERE tenant_id=$1 AND sha256=$2 FOR UPDATE', [account.tenantId, input.sha256]);
      const objectId = existing.rowCount ? existing.rows[0].id : input.id;
      if (!existing.rowCount) await client.query(
        `INSERT INTO sku_image_objects(id,tenant_id,private_object_key,sha256,mime_type,extension,size_bytes,width,height,frame_count,source_type,object_role,state,parent_object_id,processing_summary,created_by_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'edit','working','ready',$10,$11::jsonb,$12)`,
        [objectId, account.tenantId, input.objectKey, input.sha256, input.mimeType, input.extension, input.sizeBytes, input.width, input.height, input.parentObjectId, JSON.stringify(input.processingSummary || {}), account.userId]
      );
      const duplicate = await client.query(
        `SELECT id FROM sku_image_links WHERE tenant_id=$1 AND client_id=$2 AND product_ref=$3 AND variant_ref=$4 AND image_object_id=$5 AND id<>$6`,
        [account.tenantId, input.clientId, input.productId, input.variantRef, objectId, input.linkId]
      );
      if (duplicate.rowCount) throw Object.assign(new Error('同一规格下已有相同的图片，请勿重复添加。'), { publicCode: 'sku_image_duplicate_in_variant', status: 409 });
      const updated = await client.query(
        `UPDATE sku_image_links SET image_object_id=$1,association_version=association_version+1,updated_at=now()
         WHERE id=$2 AND tenant_id=$3 RETURNING association_version`,
        [objectId, input.linkId, account.tenantId]
      );
      await this.writeAudit(client, account, 'sku.image.version.create', 'sku_image_link', input.linkId, 'success', { productId: input.productId, variantRef: input.variantRef, objectId, parentObjectId: input.parentObjectId, processingSummary: input.processingSummary || {} });
      await client.query('COMMIT');
      return { linkId: String(input.linkId), objectId: String(objectId), associationVersion: Number(updated.rows[0].association_version), mimeType: input.mimeType, extension: input.extension, sizeBytes: input.sizeBytes, width: input.width, height: input.height, state: 'ready', objectRole: 'working', url: `/api/private-objects/sku-images/${objectId}` };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async updateSkuImageLinks(account, input) {
    await this.assertSkuImageTarget(account, input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const links = await client.query(`SELECT id,image_object_id,sort_order,is_cover,association_version FROM sku_image_links WHERE tenant_id=$1 AND client_id=$2 AND product_ref=$3 AND variant_ref=$4 ORDER BY sort_order FOR UPDATE`, [account.tenantId, input.clientId, input.productId, input.variantRef]);
      if (!links.rowCount) throw Object.assign(new Error('该商品还没有图片关联记录，请先在SKU图片编辑中上传图片。'), { publicCode: 'sku_image_links_not_found', status: 404 });
      const ids = input.linkIds.map(String); if (ids.length !== links.rowCount || new Set(ids).size !== ids.length || ids.some(id => !links.rows.some(row => String(row.id) === id))) throw Object.assign(new Error('图片顺序数据不正确，请重新排列后再保存。'), { publicCode: 'invalid_sku_image_order', status: 400 });
      if (links.rows.some(row => Number(input.linkVersions && input.linkVersions[row.id]) !== Number(row.association_version))) throw Object.assign(new Error('该商品图片已被他人修改，请刷新后重新编辑，避免覆盖别人的结果。'), { publicCode: 'sku_image_version_conflict', status: 409 });
      const coverId = String(input.coverLinkId || ''); if (!ids.includes(coverId)) throw Object.assign(new Error('请至少选择一张图片作为主图。'), { publicCode: 'invalid_sku_image_cover', status: 400 });
      const orderedIds = [coverId].concat(ids.filter(id => id !== coverId));
      await client.query('SET CONSTRAINTS sku_image_links_order_uniq DEFERRED');
      await client.query(`UPDATE sku_image_links SET is_cover=false WHERE tenant_id=$1 AND client_id=$2 AND product_ref=$3 AND variant_ref=$4 AND is_cover`, [account.tenantId, input.clientId, input.productId, input.variantRef]);
      for (let index = 0; index < orderedIds.length; index++) await client.query(`UPDATE sku_image_links SET sort_order=$1,is_cover=$2,association_version=association_version+1,updated_at=now() WHERE id=$3 AND tenant_id=$4`, [index, index === 0, orderedIds[index], account.tenantId]);
      await this.writeAudit(client, account, 'sku.image.order.update', 'sku_image_variant', `${input.productId}:${input.variantRef}`, 'success', { imageCount: ids.length });
      await client.query('COMMIT'); return { linkIds: orderedIds, coverLinkId: coverId, associationVersions: Object.fromEntries(links.rows.map(row => [String(row.id), Number(row.association_version) + 1])) };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async removeSkuImageLink(account, input) {
    await this.assertSkuImageTarget(account, input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const links = await client.query(`SELECT id,sort_order,is_cover,association_version FROM sku_image_links WHERE tenant_id=$1 AND client_id=$2 AND product_ref=$3 AND variant_ref=$4 ORDER BY sort_order FOR UPDATE`, [account.tenantId, input.clientId, input.productId, input.variantRef]);
      const target = links.rows.find(row => String(row.id) === String(input.linkId)); if (!target) throw Object.assign(new Error('未找到这条图片关联记录，请刷新后重试。'), { publicCode: 'sku_image_link_not_found', status: 404 });
      if (Number(input.associationVersion) !== Number(target.association_version)) throw Object.assign(new Error('该商品图片已被他人修改，请刷新后重新编辑，避免覆盖别人的结果。'), { publicCode: 'sku_image_version_conflict', status: 409 });
      await client.query('DELETE FROM sku_image_links WHERE tenant_id=$1 AND id=$2', [account.tenantId, input.linkId]);
      const remaining = links.rows.filter(row => String(row.id) !== String(input.linkId));
      for (let index = 0; index < remaining.length; index++) await client.query('UPDATE sku_image_links SET sort_order=$1,is_cover=$2,association_version=association_version+1,updated_at=now() WHERE tenant_id=$3 AND id=$4', [index, target.is_cover ? index === 0 : remaining[index].is_cover, account.tenantId, remaining[index].id]);
      await this.writeAudit(client, account, 'sku.image.unlink', 'sku_image_link', input.linkId, 'success', { productId: input.productId, variantRef: input.variantRef, wasCover: target.is_cover });
      await client.query('COMMIT'); return { removedLinkId: String(input.linkId), coverLinkId: remaining.find((_, index) => target.is_cover ? index === 0 : _.is_cover)?.id || null };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async copySkuImageLinks(account, input) {
    await this.assertSkuImageTarget(account, input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const source = await client.query(
        `SELECT id,image_object_id FROM sku_image_links WHERE tenant_id=$1 AND client_id=$2 AND product_ref=$3 AND variant_ref=$4 AND id=ANY($5::uuid[]) ORDER BY sort_order`,
        [account.tenantId, input.clientId, input.productId, input.variantRef, input.linkIds]
      );
      if (source.rowCount !== input.linkIds.length) throw Object.assign(new Error('未找到这条图片关联记录，请刷新后重试。'), { publicCode: 'sku_image_link_not_found', status: 404 });
      const results = [];
      for (const variantRef of input.targetVariantRefs) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sku-image:${account.tenantId}:${input.clientId}:${input.productId}:${variantRef}`]);
        const existing = await client.query(`SELECT image_object_id,sort_order FROM sku_image_links WHERE tenant_id=$1 AND client_id=$2 AND product_ref=$3 AND variant_ref=$4 ORDER BY sort_order FOR UPDATE`, [account.tenantId, input.clientId, input.productId, variantRef]);
        const add = source.rows.filter(row => !existing.rows.some(item => String(item.image_object_id) === String(row.image_object_id)));
        if (existing.rowCount + add.length > 30) throw Object.assign(new Error('该规格的图片数量已达上限，请先删除多余图片。'), { publicCode: 'sku_image_limit_reached', status: 409 });
        let position = existing.rowCount ? Math.max(...existing.rows.map(row => Number(row.sort_order))) + 1 : 0;
        for (const row of add) await client.query(
          `INSERT INTO sku_image_links(id,tenant_id,client_id,product_ref,variant_ref,image_object_id,sort_order,is_cover,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [crypto.randomUUID(), account.tenantId, input.clientId, input.productId, variantRef, row.image_object_id, position, position++ === 0, account.userId]
        );
        results.push({ variantRef, added: add.length, skippedDuplicates: source.rowCount - add.length });
      }
      await this.writeAudit(client, account, 'sku.image.copy.variants', 'sku_image_variant', `${input.productId}:${input.variantRef}`, 'success', { imageCount: source.rowCount, targets: results });
      await client.query('COMMIT'); return { targets: results };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async getSkuImageSyncSnapshot(account, input) {
    await this.assertSkuImageTarget(account, input);
    const result = await this.pool.query(
      `SELECT link.id AS link_id,link.sort_order,link.is_cover,link.association_version,
              object.id AS object_id,object.sha256,object.mime_type,object.extension,object.size_bytes,object.width,object.height
       FROM sku_image_links link
       JOIN sku_image_objects object ON object.id=link.image_object_id AND object.tenant_id=link.tenant_id
       WHERE link.tenant_id=$1 AND link.client_id=$2 AND link.product_ref=$3 AND link.variant_ref=$4
       ORDER BY link.sort_order`,
      [account.tenantId, input.clientId, input.productId, input.variantRef]
    );
    const items = result.rows.map(row => ({
      linkId: String(row.link_id), objectId: String(row.object_id), sha256: String(row.sha256),
      order: Number(row.sort_order), cover: Boolean(row.is_cover), associationVersion: Number(row.association_version),
      mimeType: String(row.mime_type || ''), extension: String(row.extension || ''), sizeBytes: Number(row.size_bytes),
      width: Number(row.width) || 0, height: Number(row.height) || 0
    }));
    const hash = crypto.createHash('sha256').update(JSON.stringify(items.map(item => ({ objectId: item.objectId, sha256: item.sha256, order: item.order, cover: item.cover })))).digest('hex');
    return { variantRef: String(input.variantRef), hash, items };
  }

  async getPublishedSkuImageObject(objectId) {
    const result = await this.pool.query(
      `SELECT object.id::text,object.tenant_id::text,object.private_object_key,object.sha256,object.mime_type,object.extension,object.size_bytes
       FROM sku_image_objects object
       WHERE object.id=$1 AND object.state='ready'
         AND EXISTS (SELECT 1 FROM sku_image_links link WHERE link.tenant_id=object.tenant_id AND link.image_object_id=object.id)
       LIMIT 1`,
      [objectId]
    );
    return result.rows[0] || null;
  }

  combinationReferenceImageDocumentKey(imageId) {
    const id = String(imageId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw Object.assign(new Error('组合参考图编号不正确，请重新上传。'), { publicCode: 'combination_reference_image_id_invalid', status: 400 });
    return 'erp_combination_reference_image_' + id.replace(/-/g, '');
  }

  async saveCombinationReferenceImage(account, input) {
    const id = String(input.id || '').trim().toLowerCase(), key = this.combinationReferenceImageDocumentKey(id);
    const objectKey = String(input.objectKey || '').trim(), sha256 = String(input.sha256 || '').trim().toLowerCase();
    const sizeBytes = Math.max(0, Math.floor(Number(input.sizeBytes) || 0)), width = Math.max(0, Math.floor(Number(input.width) || 0)), height = Math.max(0, Math.floor(Number(input.height) || 0));
    const mimeType = String(input.mimeType || '').toLowerCase(), bundleId = String(input.bundleId || '').trim().slice(0, 240);
    if (!new RegExp('^' + String(account.tenantId).replace(/[^0-9]/g, '') + '/combination_reference_image/[0-9a-f]{2}/[0-9a-f]{64}\\.enc$', 'i').test(objectKey) || !/^[0-9a-f]{64}$/.test(sha256) || sizeBytes < 1 || sizeBytes > 6 * 1024 * 1024 || !/^image\/(?:jpeg|png|webp)$/i.test(mimeType) || width < 1 || height < 1 || !bundleId) {
      throw Object.assign(new Error('组合参考图元数据不完整，无法保存。'), { publicCode: 'combination_reference_image_metadata_invalid', status: 422 });
    }
    const metadata = { version: 1, id, bundleId, objectKey, sha256, sizeBytes, mimeType, width, height, createdAt: new Date().toISOString(), createdByUserId: String(account.userId) };
    await this.putDocument(account, key, metadata, 0);
    return metadata;
  }

  async getCombinationReferenceImage(account, imageId) {
    const key = this.combinationReferenceImageDocumentKey(imageId), document = await this.getDocument(account, key);
    if (!document || !document.payload || document.payload.id !== String(imageId).toLowerCase()) return null;
    return { ...document.payload, version: document.version, updatedAt: document.updatedAt };
  }

  productVideoDocumentKey(videoId) {
    const id = String(videoId || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw Object.assign(new Error('视频编号不正确，请刷新商品页面后重试。'), { publicCode: 'product_video_id_invalid', status: 400 });
    return 'erp_product_video_object_' + id.replace(/-/g, '');
  }

  isTransientProductVideoTarget(input) {
    return /^session_[\w-]{8,120}$/i.test(String(input && input.productId || '')) && /^row_[0-9]{1,5}$/i.test(String(input && input.variantRef || ''));
  }

  async saveProductVideoObject(account, input) {
    if (!this.isTransientProductVideoTarget(input)) await this.assertSkuImageTarget(account, input);
    const id = String(input.id || '').trim().toLowerCase();
    const key = this.productVideoDocumentKey(id);
    const objectKey = String(input.objectKey || '').trim(), sha256 = String(input.sha256 || '').trim().toLowerCase();
    const sizeBytes = Math.max(0, Math.floor(Number(input.sizeBytes) || 0));
    if (!new RegExp('^' + String(account.tenantId).replace(/[^0-9]/g, '') + '/product_video_compose/[0-9a-f]{2}/[0-9a-f]{64}\\.enc$', 'i').test(objectKey) || !/^[0-9a-f]{64}$/.test(sha256) || sizeBytes < 1 || sizeBytes > 100 * 1024 * 1024) {
      throw Object.assign(new Error('视频文件元数据不完整，无法保存。'), { publicCode: 'product_video_metadata_invalid', status: 422 });
    }
    const metadata = {
      version: 1, id, clientId: String(input.clientId), productId: String(input.productId), variantRef: String(input.variantRef),
      objectKey, sha256, sizeBytes, mimeType: 'video/mp4', durationSeconds: Math.floor(Number(input.durationSeconds) || 0),
      width: Math.floor(Number(input.width) || 0), height: Math.floor(Number(input.height) || 0), fps: Math.floor(Number(input.fps) || 0),
      transition: input.transition === 'fade' ? 'fade' : 'cut', motion: input.motion === true,
      createdAt: new Date().toISOString(), createdByUserId: String(account.userId)
    };
    if (metadata.durationSeconds < 8 || metadata.durationSeconds > 20 || metadata.width < 2 || metadata.width > 2160 || metadata.height < 2 || metadata.height > 2880 || metadata.fps < 1 || metadata.fps > 60) {
      throw Object.assign(new Error('视频参数超出允许范围，无法保存。'), { publicCode: 'product_video_metadata_invalid', status: 422 });
    }
    await this.putDocument(account, key, metadata, 0);
    return metadata;
  }

  async getProductVideoObject(account, videoId) {
    const key = this.productVideoDocumentKey(videoId);
    const document = await this.getDocument(account, key);
    if (!document || !document.payload || document.payload.id !== String(videoId).toLowerCase()) return null;
    if (!this.isTransientProductVideoTarget(document.payload)) await this.assertSkuImageTarget(account, document.payload);
    return { ...document.payload, version: document.version, updatedAt: document.updatedAt };
  }

  async deleteProductVideoObject(account, videoId) {
    const metadata = await this.getProductVideoObject(account, videoId);
    if (!metadata) return null;
    await this.deleteDocument(account, this.productVideoDocumentKey(videoId));
    const references = await this.pool.query(`SELECT count(*)::int AS count FROM tenant_documents WHERE tenant_id=$1 AND document_key ~ '^erp_product_video_object_[0-9a-f]{32}$' AND payload->>'objectKey'=$2`, [account.tenantId, metadata.objectKey]);
    return { ...metadata, objectStillReferenced: Number(references.rows[0] && references.rows[0].count || 0) > 0 };
  }

  async listSkuImageLinks(account, input) {
    await this.assertSkuImageTarget(account, input);
    const result = await this.pool.query(`SELECT link.id AS link_id,link.sort_order,link.is_cover,link.association_version,object.id AS object_id,object.mime_type,object.extension,object.size_bytes,object.width,object.height,object.state,object.object_role FROM sku_image_links link JOIN sku_image_objects object ON object.id=link.image_object_id AND object.tenant_id=link.tenant_id WHERE link.tenant_id=$1 AND link.client_id=$2 AND link.product_ref=$3 AND link.variant_ref=$4 ORDER BY link.sort_order`, [account.tenantId, input.clientId, input.productId, input.variantRef]);
    return result.rows.map(row => ({ id: row.link_id, objectId: row.object_id, cover: row.is_cover, order: Number(row.sort_order), associationVersion: Number(row.association_version), mimeType: row.mime_type, extension: row.extension, sizeBytes: Number(row.size_bytes), width: row.width, height: row.height, state: row.state, objectRole: row.object_role, url: `/api/private-objects/sku-images/${row.object_id}` }));
  }

  async assertSkuImageTarget(account, input) {
    if (/^draft_[\w-]+$/.test(String(input.productId))) {
      const draft = await this.getProductCreateDraft(account, String(input.productId));
      if (!draft || String(draft.item && draft.item.shop || draft.shop || '') !== String(input.clientId)) throw Object.assign(new Error('未找到要编辑的规格图片，请刷新页面后重试。'), { publicCode: 'sku_image_target_not_found', status: 404 });
      return;
    }
    await this.getEditableProduct(account, { clientId: String(input.clientId), productId: String(input.productId) });
  }

  async writeAudit(clientOrPool, account, action, resourceType, resourceId, result, metadata = {}) {
    const systemAdmin = Boolean(account && account.isSystemAdmin);
    const auditMetadata = systemAdmin ? { ...metadata, systemAdminActorUserId: String(account.userId), systemAdminActorUsername: '系统管理员' } : metadata;
    await clientOrPool.query(
      `INSERT INTO audit_events (tenant_id, actor_user_id, action, resource_type, resource_id, result, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [account && account.tenantId, account && account.userId, action, resourceType, resourceId, result, JSON.stringify(auditMetadata)]
    );
  }

  async upsertClientSyncDevice(account, input) {
    await this.assertClientOrderSyncActor(account);
    const installationId = clientOrderSync.safeUuid(input && input.installationId);
    const clientId = clientOrderSync.safeClientId(input && input.clientId);
    const verified = input && input.verified === true;
    const preserveAuthorization = input && input.preserveAuthorization === true;
    const contractVersion = input && input.orderContractVersion === clientOrderSync.ORDER_CONTRACT_VERSION ? clientOrderSync.ORDER_CONTRACT_VERSION : null;
    const expiresAt = new Date(Date.now() + clientOrderSync.DEVICE_LEASE_MS);
    const result = await this.pool.query(
      `INSERT INTO client_sync_devices
        (tenant_id,user_id,installation_id,shop_external_id,status,seller_verified_at,last_heartbeat_at,authorization_expires_at,order_contract_version)
       VALUES ($1,$2,$3,$4,$5::varchar,CASE WHEN $5::varchar='authorized' THEN now() END,now(),$6,$7)
       ON CONFLICT (tenant_id,installation_id,shop_external_id) DO UPDATE SET
         user_id=EXCLUDED.user_id,status=CASE WHEN $8::boolean THEN client_sync_devices.status ELSE EXCLUDED.status END,
         seller_verified_at=CASE WHEN EXCLUDED.status='authorized' THEN now() ELSE client_sync_devices.seller_verified_at END,
         last_heartbeat_at=now(),authorization_expires_at=EXCLUDED.authorization_expires_at,
         order_contract_version=EXCLUDED.order_contract_version,updated_at=now()
       RETURNING status,authorization_expires_at,order_contract_version`,
      [account.tenantId, account.userId, installationId, clientId, verified ? 'authorized' : 'unauthorized', expiresAt, contractVersion, preserveAuthorization]
    );
    return { installationId, clientId, status: result.rows[0].status, expiresAt: result.rows[0].authorization_expires_at, orderContractVersion: result.rows[0].order_contract_version };
  }

  async assertClientOrderSyncActor(account) {
    const actor = account && await this.productEditActor(account.tenantId, account.userId);
    if (!actor || !actor.enabled || !this.hasPermission(actor, 'sync.run') || !this.hasPermission(actor, 'orders.write')) {
      throw Object.assign(new Error('当前账号未获目标工作空间的订单同步权限，请重新登录或联系主账号授权。'),
        { publicCode: 'client_sync_actor_unavailable', status: 403 });
    }
    return actor;
  }

  async listClientSyncDevices(account) {
    const result = await this.pool.query(
      `SELECT installation_id,shop_external_id,status,last_heartbeat_at,authorization_expires_at,order_contract_version
       FROM client_sync_devices WHERE tenant_id=$1 AND user_id=$2 ORDER BY last_heartbeat_at DESC`,
      [account.tenantId, account.userId]
    );
    return result.rows.map(row => ({ installationId: row.installation_id, clientId: row.shop_external_id, status: row.status, lastHeartbeatAt: row.last_heartbeat_at, expiresAt: row.authorization_expires_at, orderContractVersion: row.order_contract_version }));
  }

  async beginClientOrderDailyCycle(participants, now = new Date(), cutoffLocalHour = 3) {
    const current = new Date(now);
    if (Number.isNaN(current.getTime())) throw clientOrderSync.publicError('client_sync_time_invalid', 400, '订单同步时间无效，请重新选择时间范围。');
    const cycleDay = [current.getFullYear(), String(current.getMonth() + 1).padStart(2, '0'), String(current.getDate()).padStart(2, '0')].join('-');
    const cutoffHour = Math.max(0, Math.min(23, Number.isInteger(Number(cutoffLocalHour)) ? Number(cutoffLocalHour) : 3));
    const cutoffAt = new Date(current.getFullYear(), current.getMonth(), current.getDate(), cutoffHour, 0, 0);
    const unique = new Map();
    for (const item of Array.isArray(participants) ? participants : []) {
      const tenantId = String(item && item.tenantId || '').trim();
      const actorUserId = String(item && item.actorUserId || '').trim();
      const clientId = clientOrderSync.safeClientId(item && item.clientId);
      if (!/^\d+$/.test(tenantId) || !/^\d+$/.test(actorUserId)) throw clientOrderSync.publicError('client_sync_daily_participant_invalid', 400, '每日订单同步参与者无效，任务未创建。');
      unique.set(tenantId + '\u0000' + clientId, { tenantId, actorUserId, clientId });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cycleId = crypto.randomUUID();
      const inserted = await client.query(
        `INSERT INTO client_order_daily_cycles (cycle_id,cycle_day,cutoff_at,participant_count)
         VALUES ($1,$2,$3,$4) ON CONFLICT (cycle_day) DO NOTHING RETURNING *`,
        [cycleId, cycleDay, cutoffAt, unique.size]
      );
      if (!inserted.rowCount) {
        const existing = await client.query(`SELECT * FROM client_order_daily_cycles WHERE cycle_day=$1`, [cycleDay]);
        await client.query('COMMIT');
        return { cycle: existing.rows[0], duplicate: true };
      }
      for (const item of unique.values()) await client.query(
        `INSERT INTO client_order_daily_participants (cycle_id,tenant_id,actor_user_id,shop_external_id)
         VALUES ($1,$2,$3,$4)`, [cycleId, item.tenantId, item.actorUserId, item.clientId]
      );
      await client.query('COMMIT');
      return { cycle: inserted.rows[0], duplicate: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async claimIncompleteClientOrderBackupAlert() {
    const result = await this.pool.query(
      `UPDATE backup_generations generation SET alert_attempted_at=now(),alert_failure=NULL
       WHERE generation.generation_id=(
         SELECT candidate.generation_id FROM backup_generations candidate
         WHERE candidate.status='complete' AND candidate.incomplete_sync_count>0 AND candidate.alerted_at IS NULL
           AND (candidate.alert_attempted_at IS NULL OR candidate.alert_attempted_at<now()-interval '10 minutes')
           AND (candidate.daily_cycle_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM backup_generations alerted
             WHERE alerted.daily_cycle_id=candidate.daily_cycle_id AND alerted.alerted_at IS NOT NULL
           ))
         ORDER BY candidate.completed_at,candidate.generation_id FOR UPDATE SKIP LOCKED LIMIT 1
       ) RETURNING generation_id,daily_cycle_id,incomplete_sync_count,completed_at`
    );
    return result.rows[0] || null;
  }

  async finishIncompleteClientOrderBackupAlert(generationId, error = null) {
    const id = Number(generationId);
    if (!Number.isSafeInteger(id) || id < 1) throw clientOrderSync.publicError('backup_generation_invalid', 400, '订单同步备份代次无效，本批次未入库。');
    const failure = error ? String(error.publicCode || error.message || error).replace(/[\r\n\t]/g, ' ').slice(0, 500) : null;
    const result = await this.pool.query(
      `UPDATE backup_generations SET alerted_at=CASE WHEN $2::text IS NULL THEN now() ELSE alerted_at END,
         alert_failure=$2,alert_attempted_at=now() WHERE generation_id=$1 AND incomplete_sync_count>0
       RETURNING generation_id,alerted_at,alert_failure`, [id, failure]
    );
    return result.rows[0] || null;
  }

  async createClientOrderSyncRun(account, input) {
    const clientId = clientOrderSync.safeClientId(input && input.clientId);
    const mode = String(input && input.mode || 'manual_all');
    if (!['manual_all','manual_selected','auto_daily','auto_new','auto_tracked'].includes(mode)) throw clientOrderSync.publicError('client_sync_mode_invalid', 400, '订单同步方式无效，请重新发起任务。');
    const postings = [...new Set((Array.isArray(input && input.postingNumbers) ? input.postingNumbers : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 1000);
    if ((mode === 'manual_selected' || mode === 'auto_tracked') && !postings.length) throw clientOrderSync.publicError('client_sync_postings_required', 400, '请先选择需要同步的订单货件。');
    let range = mode === 'manual_all'
      ? clientOrderSync.manualRange({ rangeStart: input && input.rangeStart, rangeEnd: input && input.rangeEnd }, input && input.now || new Date())
      : clientOrderSync.rangeFor(mode, input && input.now || new Date());
    const runId = crypto.randomUUID();
    const dailyCycleId = input && input.dailyCycleId ? clientOrderSync.safeUuid(input.dailyCycleId, 'client_sync_daily_cycle_invalid') : null;
    if ((mode === 'auto_daily') !== Boolean(dailyCycleId)) throw clientOrderSync.publicError('client_sync_daily_cycle_required', 400, '每日订单同步周期无效，任务未创建。');
    const manual = mode.startsWith('manual_');
    if (!manual) throw clientOrderSync.publicError('client_sync_auto_paused', 409, '自动订单处理已暂停，请从订单页面手动发起同步。');
    const parentTaskId = manual ? String(input && input.parentTaskId || '') : '';
    const taskName = manual ? '订单同步（用户资源）' : '订单同步';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureSystemAdminTenantMembership(client, account);
      if (!manual) {
        const capable = await client.query(
          `SELECT 1 FROM client_sync_devices WHERE tenant_id=$1 AND shop_external_id=$2
             AND authorization_expires_at>now() AND order_contract_version=$3
             AND status='authorized' LIMIT 1`,
          [account.tenantId, clientId, clientOrderSync.ORDER_CONTRACT_VERSION]
        );
        if (!capable.rowCount) throw clientOrderSync.publicError('client_sync_device_unavailable', 409, '没有在线且已登录ERP的订单读取扩展。');
      }
      if (dailyCycleId) {
        const participant = await client.query(
          `SELECT 1 FROM client_order_daily_participants WHERE cycle_id=$1 AND tenant_id=$2
             AND actor_user_id=$3 AND shop_external_id=$4 AND run_id IS NULL FOR UPDATE`,
          [dailyCycleId, account.tenantId, account.userId, clientId]
        );
        if (!participant.rowCount) throw clientOrderSync.publicError('client_sync_daily_participant_denied', 403, '当前账号无权参与该店铺的每日订单同步。');
      }
      if (mode === 'auto_new') {
        const watermark = await client.query(
          `SELECT run.range_end,run.server_revision,manifest.order_count FROM client_order_sync_runs run
           LEFT JOIN client_order_sync_manifests manifest ON manifest.run_id=run.run_id
           WHERE run.tenant_id=$1 AND run.shop_external_id=$2
             AND run.state IN ('completed','no_change') AND run.server_revision IS NOT NULL
           ORDER BY run.range_end DESC LIMIT 1`, [account.tenantId, clientId]
        );
        const confirmedAt = watermark.rows[0] && new Date(watermark.rows[0].range_end);
        const currentVersion = await client.query(
          `SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data'`,
          [account.tenantId]
        );
        const confirmedRevision = Number(watermark.rows[0] && watermark.rows[0].server_revision || 0);
        const serverRevision = Number(currentVersion.rows[0] && currentVersion.rows[0].version || 0);
        const serverRows = await client.query(
          `SELECT count(*)::int AS count FROM business_orders WHERE tenant_id=$1 AND shop_external_id=$2`,
          [account.tenantId, clientId]
        );
        const recoverableSettlement = await client.query(
          `SELECT 1 FROM business_orders orders
           WHERE orders.tenant_id=$1 AND orders.shop_external_id=$2 AND orders.payload->>'status'='已签收'
             AND COALESCE(orders.payload->>'deliverySchema','')<>'WHD'
             AND ((NULLIF(orders.payload#>>'{finance,ozonFeeRub}','') IS NULL OR NULLIF(orders.payload#>>'{finance,intlLogisticsRub}','') IS NULL)
               OR CASE WHEN orders.payload#>>'{finance,settlementVersion}' ~ '^\\d+$' THEN (orders.payload#>>'{finance,settlementVersion}')::int ELSE 0 END < 3) LIMIT 1`,
          [account.tenantId, clientId]
        );
        const serverDatasetMissing = Number(serverRows.rows[0] && serverRows.rows[0].count || 0) === 0
          && Number(watermark.rows[0] && watermark.rows[0].order_count || 0) > 0;
        if (confirmedRevision > serverRevision || serverDatasetMissing || recoverableSettlement.rowCount) {
          // The authoritative dataset was cleared or restored. Browser snapshots
          // are no longer a valid delta base, so rebuild from the full 60 days.
          range = clientOrderSync.rangeFor('auto_daily', input && input.now || new Date());
        } else if (confirmedAt && !Number.isNaN(confirmedAt.getTime()) && confirmedAt < range.end) {
          const overlapStart = new Date(confirmedAt.getTime() - 15 * 60 * 1000);
          const floor = new Date(range.end.getTime() - 60 * 24 * 60 * 60 * 1000);
          range = { start: overlapStart < floor ? floor : overlapStart, end: range.end };
        }
      }
      const inserted = await client.query(
        `INSERT INTO client_order_sync_runs
          (run_id,tenant_id,actor_user_id,shop_external_id,mode,requested_postings,range_start,range_end,daily_cycle_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
         ON CONFLICT DO NOTHING RETURNING *`,
        [runId, account.tenantId, account.userId, clientId, mode, JSON.stringify(postings), range.start, range.end, dailyCycleId]
      );
      if (!inserted.rowCount) {
        const existing = await client.query(`SELECT * FROM client_order_sync_runs WHERE tenant_id=$1 AND shop_external_id=$2 AND mode IN ('manual_all','manual_selected') AND state IN ('waiting_client','leased','manifested','backup_ready','uploading','applying') ORDER BY created_at LIMIT 1`, [account.tenantId, clientId]);
        if (manual && existing.rows[0]) await this.upsertSyncTask(account, { id: 'client-order-' + existing.rows[0].run_id, parentTaskId, type: 'sync', status: 'running', value: 0, name: taskName, label: '正在同步订单', article: clientId, startedAt: existing.rows[0].created_at }, client);
        await client.query('COMMIT');
        return { run: existing.rows[0], duplicate: true };
      }
      if (dailyCycleId) await client.query(
        `UPDATE client_order_daily_participants SET run_id=$2,state='waiting_client',updated_at=now()
         WHERE cycle_id=$1 AND tenant_id=$3 AND shop_external_id=$4`,
        [dailyCycleId, runId, account.tenantId, clientId]
      );
      if (manual) await this.upsertSyncTask(account, { id: 'client-order-' + runId, parentTaskId, type: 'sync', status: 'running', value: 0, name: taskName, label: '正在同步订单', article: clientId, startedAt: inserted.rows[0].created_at }, client);
      await client.query('COMMIT');
      return { run: inserted.rows[0], duplicate: false };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async claimClientOrderSyncRun(account, input) {
    await this.assertClientOrderSyncActor(account);
    const installationId = clientOrderSync.safeUuid(input && input.installationId);
    const requestedClientId = clientOrderSync.safeClientId(input && input.clientId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const device = await client.query(
        `SELECT * FROM client_sync_devices WHERE tenant_id=$1 AND user_id=$2 AND installation_id=$3
           AND shop_external_id=$4
           AND authorization_expires_at>now() AND order_contract_version=$5
         ORDER BY last_heartbeat_at DESC LIMIT 1 FOR UPDATE`,
        [account.tenantId, account.userId, installationId, requestedClientId, clientOrderSync.ORDER_CONTRACT_VERSION]
      );
      if (!device.rowCount) throw clientOrderSync.publicError('client_sync_device_unavailable', 409, '没有在线且已登录ERP的订单读取扩展。');
      const clientId = device.rows[0].shop_external_id;
      const claimed = await client.query(
        `SELECT * FROM client_order_sync_runs WHERE tenant_id=$1 AND shop_external_id=$2
           AND (state='waiting_client' OR (state='leased' AND lease_expires_at<now()))
           AND mode IN ('manual_all','manual_selected')
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [account.tenantId, clientId]);
      if (!claimed.rowCount) { await client.query('COMMIT'); return null; }
      const ticket = clientOrderSync.createUploadTicket();
      const leaseExpiresAt = new Date(Date.now() + clientOrderSync.runLeaseMs(claimed.rows[0].mode, claimed.rows[0].range_start, claimed.rows[0].range_end));
      const updated = await client.query(
        `UPDATE client_order_sync_runs SET state='leased',device_installation_id=$3,lease_expires_at=$4,
           upload_ticket_hash=$5,updated_at=now(),failure_code=NULL,failure_detail=NULL
         WHERE run_id=$1 AND tenant_id=$2 RETURNING *`,
        [claimed.rows[0].run_id, account.tenantId, installationId, leaseExpiresAt, ticket.ticketHash]
      );
      const currentVersion = await client.query(
        `SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data'`,
        [account.tenantId]
      );
      const confirmed = await client.query(
        `SELECT run.server_revision,manifest.order_count FROM client_order_sync_runs run
         LEFT JOIN client_order_sync_manifests manifest ON manifest.run_id=run.run_id
         WHERE run.tenant_id=$1 AND run.shop_external_id=$2 AND run.run_id<>$3
           AND run.state IN ('completed','no_change') AND run.server_revision IS NOT NULL
         ORDER BY run.range_end DESC LIMIT 1`,
        [account.tenantId, clientId, updated.rows[0].run_id]
      );
      const serverRows = await client.query(
        `SELECT count(*)::int AS count FROM business_orders WHERE tenant_id=$1 AND shop_external_id=$2`,
        [account.tenantId, clientId]
      );
      const recoverableSettlement = await client.query(
        `SELECT 1 FROM business_orders orders
         WHERE orders.tenant_id=$1 AND orders.shop_external_id=$2 AND orders.payload->>'status'='已签收'
           AND COALESCE(orders.payload->>'deliverySchema','')<>'WHD'
           AND ((NULLIF(orders.payload#>>'{finance,ozonFeeRub}','') IS NULL OR NULLIF(orders.payload#>>'{finance,intlLogisticsRub}','') IS NULL)
             OR CASE WHEN orders.payload#>>'{finance,settlementVersion}' ~ '^\\d+$' THEN (orders.payload#>>'{finance,settlementVersion}')::int ELSE 0 END < 3) LIMIT 1`,
        [account.tenantId, clientId]
      );
      const forceFullUpload = Number(confirmed.rows[0] && confirmed.rows[0].server_revision || 0)
        > Number(currentVersion.rows[0] && currentVersion.rows[0].version || 0)
        || (Number(serverRows.rows[0] && serverRows.rows[0].count || 0) === 0
          && Number(confirmed.rows[0] && confirmed.rows[0].order_count || 0) > 0)
        || Boolean(recoverableSettlement.rowCount);
      if (updated.rows[0].daily_cycle_id) await client.query(
        `UPDATE client_order_daily_participants SET state='leased',updated_at=now()
         WHERE cycle_id=$1 AND run_id=$2`, [updated.rows[0].daily_cycle_id, updated.rows[0].run_id]
      );
      await client.query('COMMIT');
      return { ...updated.rows[0], forceFullUpload, uploadTicket: ticket.ticket };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async saveClientOrderManifest(account, input, uploadTicket) {
    await this.assertClientOrderSyncActor(account);
    const manifest = clientOrderSync.normalizeManifest(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query(`SELECT * FROM client_order_sync_runs WHERE run_id=$1 AND tenant_id=$2 FOR UPDATE`, [manifest.runId, account.tenantId]);
      const row = run.rows[0];
      if (!row || row.shop_external_id !== manifest.clientId || String(row.device_installation_id) !== manifest.installationId) throw clientOrderSync.publicError('client_sync_run_scope_denied', 403, '当前账号无权操作该订单同步任务。');
      if (!['manual_all','manual_selected'].includes(row.mode)) throw clientOrderSync.publicError('client_sync_auto_paused', 409, '自动订单处理已暂停，该任务不能继续上传清单。');
      if (row.state !== 'leased' || !row.lease_expires_at || new Date(row.lease_expires_at) <= new Date()) throw clientOrderSync.publicError('client_sync_lease_expired', 409, '订单同步任务租约已过期，请重新发起同步。');
      if (!clientOrderSync.verifyUploadTicket(uploadTicket, row.upload_ticket_hash)) throw clientOrderSync.publicError('client_sync_ticket_invalid', 403, '订单同步上传票据无效，请重新领取。');
      await client.query(`INSERT INTO client_order_sync_manifests (run_id,tenant_id,shop_external_id,order_count,batch_count,content_sha256) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id) DO UPDATE SET order_count=EXCLUDED.order_count,batch_count=EXCLUDED.batch_count,content_sha256=EXCLUDED.content_sha256`, [manifest.runId, account.tenantId, manifest.clientId, manifest.orderCount, manifest.batchCount, manifest.contentSha256]);
      await client.query(`UPDATE client_order_sync_runs SET state='manifested',lease_expires_at=NULL,updated_at=now() WHERE run_id=$1`, [manifest.runId]);
      const manual = String(row.mode || '').startsWith('manual_');
      if (manual) await this.upsertSyncTask(account, {
        id: 'client-order-' + manifest.runId,
        parentTaskId: row.parent_task_id,
        type: 'sync',
        status: 'running',
        value: 45,
        name: '订单同步（用户资源）',
        label: '订单读取完成，正在创建数据库备份',
        article: manifest.clientId,
        startedAt: row.created_at
      }, client);
      if (row.daily_cycle_id) await client.query(
        `UPDATE client_order_daily_participants SET state='snapshot_ready',updated_at=now()
         WHERE cycle_id=$1 AND run_id=$2`, [row.daily_cycle_id, manifest.runId]
      );
      await client.query('COMMIT');
      return { state: 'manifested', backupReady: false, manual };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async enqueueClientOrderUploadBatch(account, input, uploadTicket) {
    await this.assertClientOrderSyncActor(account);
    const batch = clientOrderSync.normalizeBatch(input);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO client_order_tenant_queue_state (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [account.tenantId]);
      await client.query(`SELECT tenant_id FROM client_order_tenant_queue_state WHERE tenant_id=$1 FOR UPDATE`, [account.tenantId]);
      const run = await client.query(`SELECT * FROM client_order_sync_runs WHERE run_id=$1 AND tenant_id=$2 FOR UPDATE`, [batch.runId, account.tenantId]);
      const row = run.rows[0];
      if (!row || row.shop_external_id !== batch.clientId || String(row.device_installation_id) !== batch.installationId) throw clientOrderSync.publicError('client_sync_run_scope_denied', 403, '当前账号无权操作该订单同步任务。');
      if (!['manual_all','manual_selected'].includes(row.mode)) throw clientOrderSync.publicError('client_sync_auto_paused', 409, '自动订单处理已暂停，该任务不能继续上传订单。');
      if (!clientOrderSync.verifyUploadTicket(uploadTicket, row.upload_ticket_hash)) throw clientOrderSync.publicError('client_sync_ticket_invalid', 403, '订单同步上传票据无效，请重新领取。');
      if (!['backup_ready','uploading'].includes(row.state) || Number(row.backup_generation_id) !== batch.backupGenerationId) throw clientOrderSync.publicError('client_sync_backup_not_ready', 409, '数据库备份代次尚未完成，订单批次未入库。');
      const manifest = await client.query(`SELECT batch_count FROM client_order_sync_manifests WHERE run_id=$1`, [batch.runId]);
      if (!manifest.rowCount || batch.sequenceNo >= manifest.rows[0].batch_count) throw clientOrderSync.publicError('client_sync_batch_sequence_invalid', 400, '订单同步批次顺序无效，本批次未入库。');
      const generation = await client.query(`SELECT 1 FROM backup_generations WHERE generation_id=$1 AND status='complete'`, [batch.backupGenerationId]);
      if (!generation.rowCount) throw clientOrderSync.publicError('client_sync_backup_not_ready', 409, '数据库备份代次尚未完成，订单批次未入库。');
      const existing = await client.query(`SELECT body_sha256,state FROM client_order_upload_batches WHERE tenant_id=$1 AND shop_external_id=$2 AND backup_generation_id=$3 AND batch_id=$4`, [account.tenantId, batch.clientId, batch.backupGenerationId, batch.batchId]);
      if (existing.rowCount) {
        if (existing.rows[0].body_sha256 !== batch.bodySha256) throw clientOrderSync.publicError('client_sync_idempotency_conflict', 409, '订单批次编号重复但内容不同，已拒绝覆盖。');
        await client.query('COMMIT'); return { duplicate: true, state: existing.rows[0].state };
      }
      await client.query(`INSERT INTO client_order_upload_batches (tenant_id,run_id,shop_external_id,backup_generation_id,batch_id,sequence_no,body_sha256,order_count,body_bytes,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [account.tenantId,batch.runId,batch.clientId,batch.backupGenerationId,batch.batchId,batch.sequenceNo,batch.bodySha256,batch.orders.length,batch.bodyBytes,JSON.stringify(batch.orders)]);
      await client.query(`UPDATE client_order_tenant_queue_state SET ready_batch_count=ready_batch_count+1,updated_at=now() WHERE tenant_id=$1`, [account.tenantId]);
      await client.query(`UPDATE client_order_sync_runs SET state='uploading',updated_at=now() WHERE run_id=$1`, [batch.runId]);
      await client.query('COMMIT');
      return { duplicate: false, state: 'queued' };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async clientOrderSyncRun(account, runId, installationId = null) {
    const id = clientOrderSync.safeUuid(runId, 'client_sync_run_invalid');
    const deviceId = installationId ? clientOrderSync.safeUuid(installationId) : null;
    const result = await this.pool.query(`SELECT run.run_id,run.shop_external_id,run.mode,run.state,run.range_start,run.range_end,run.server_revision,run.daily_cycle_id,run.backup_generation_id,run.failure_code,run.created_at,run.updated_at,manifest.order_count,manifest.batch_count FROM client_order_sync_runs run LEFT JOIN client_order_sync_manifests manifest ON manifest.run_id=run.run_id WHERE run.run_id=$1 AND run.tenant_id=$2 AND (run.actor_user_id=$3 OR ($4::uuid IS NOT NULL AND run.device_installation_id=$4 AND EXISTS (SELECT 1 FROM client_sync_devices device WHERE device.tenant_id=run.tenant_id AND device.installation_id=$4 AND device.shop_external_id=run.shop_external_id AND device.user_id=$3)))`, [id, account.tenantId, account.userId, deviceId]);
    return result.rows[0] || null;
  }

  async issueClientOrderUploadTicket(account, input) {
    const actor = await this.assertClientOrderSyncActor(account);
    const runId = clientOrderSync.safeUuid(input && input.runId, 'client_sync_run_invalid', '订单同步任务标识格式不正确，请重新发起同步。');
    const installationId = clientOrderSync.safeUuid(input && input.installationId);
    const clientId = clientOrderSync.safeClientId(input && input.clientId);
    const allowed = await this.listAllowedShops(actor);
    const shops = await this.listShops(actor);
    if (!shops.some(shop => String(shop.externalShopId || '') === clientId)
      || allowed !== null && !allowed.some(shop => String(shop.externalShopId || '') === clientId)) {
      const message = '当前账号没有该店铺的订单同步权限，请重新获取店铺授权后再试。';
      throw Object.assign(new Error(message), { publicCode: 'shop_scope_denied', status: 403, publicMessage: message });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query(`SELECT * FROM client_order_sync_runs WHERE run_id=$1 AND tenant_id=$2 AND shop_external_id=$3 AND device_installation_id=$4 FOR UPDATE`, [runId, account.tenantId, clientId, installationId]);
      const row = run.rows[0];
      if (!row) throw clientOrderSync.publicError('client_sync_run_scope_denied', 403, '当前账号无权操作该订单同步任务。');
      if (!['manual_all','manual_selected'].includes(row.mode)) throw clientOrderSync.publicError('client_sync_auto_paused', 409, '自动订单处理已暂停，该任务不能续领上传票据。');
      const device = await client.query(`SELECT 1 FROM client_sync_devices WHERE tenant_id=$1 AND user_id=$2 AND installation_id=$3 AND shop_external_id=$4 AND authorization_expires_at>now() AND order_contract_version=$5 AND ($6::boolean OR status='authorized') FOR UPDATE`, [account.tenantId, account.userId, installationId, clientId, clientOrderSync.ORDER_CONTRACT_VERSION, String(row.mode || '').startsWith('manual_')]);
      if (!device.rowCount) throw clientOrderSync.publicError('client_sync_device_unavailable', 409, '没有在线且已登录ERP的订单读取扩展。');
      if (!['backup_ready','uploading'].includes(row.state) || !row.backup_generation_id) throw clientOrderSync.publicError('client_sync_backup_not_ready', 409, '数据库备份代次尚未完成，订单批次未入库。');
      const ticket = clientOrderSync.createUploadTicket();
      await client.query(`UPDATE client_order_sync_runs SET upload_ticket_hash=$2,updated_at=now() WHERE run_id=$1`, [runId, ticket.ticketHash]);
      await client.query('COMMIT');
      return { uploadTicket: ticket.ticket, backupGenerationId: Number(row.backup_generation_id), state: row.state };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async reportClientOrderSyncFailure(account, input) {
    const runId = clientOrderSync.safeUuid(input && input.runId, 'client_sync_run_invalid');
    const installationId = clientOrderSync.safeUuid(input && input.installationId);
    const clientId = clientOrderSync.safeClientId(input && input.clientId);
    const reportedCode = String(input && input.code || '');
    const code = /^(?:client_sync|seller|erp|order)_[a-z0-9_]{1,80}$/.test(reportedCode)
      && !/(?:password|secret|token|cookie_value|authorization_header)/.test(reportedCode)
      ? reportedCode : 'client_sync_failed';
    const configurationCodes = new Set(['seller_session_required','seller_binding_required','seller_cookie_unauthorized',
      'seller_cookie_credential_unreadable','erp_login_required','client_sync_device_unavailable','client_sync_device_unauthorized',
      'client_sync_contract_unverified','client_sync_actor_unavailable','client_sync_client_restarted','seller_page_unavailable']);
    const category = configurationCodes.has(code) ? 'configuration' : 'business';
    // 失败原因在写库这一处就必须是完整中文：优先采用扩展上报的中文原文，缺失时当场写出中文说明；内部代号只进 failure_code 列。
    const reportedReason = String(input && input.message || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const originalMessage = String(input && input.originalMessage || '').replace(/\s+/g, ' ').trim().slice(0, 900);
    const fallbackReason = category === 'configuration'
      ? '订单读取扩展的登录或配置状态不可用，本次未读取订单，请在浏览器里重新登录 Ozon 卖家后台与网研ERP后再试。'
      : '订单读取或数据校验未通过，本次未录入订单，请重新发起同步；若持续失败请在网研ERP提交 BUG 反馈。';
    const translatedReason = /[\u3400-\u9fff]/.test(reportedReason) ? reportedReason : fallbackReason;
    const failureReason = originalMessage
      ? bilingualExternalFailureText(originalMessage, translatedReason)
      : bilingualExternalFailureText(reportedReason, fallbackReason);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO client_order_tenant_queue_state (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [account.tenantId]);
      await client.query(`SELECT tenant_id FROM client_order_tenant_queue_state WHERE tenant_id=$1 FOR UPDATE`, [account.tenantId]);
      const run = await client.query(`SELECT run.* FROM client_order_sync_runs run WHERE run.run_id=$1 AND run.tenant_id=$2 AND run.shop_external_id=$3 AND run.device_installation_id=$4 AND run.state IN ('leased','manifested','backup_ready','uploading') AND EXISTS (SELECT 1 FROM client_sync_devices device WHERE device.tenant_id=run.tenant_id AND device.installation_id=$4 AND device.shop_external_id=$3 AND device.user_id=$5) FOR UPDATE`, [runId, account.tenantId, clientId, installationId, account.userId]);
      if (!run.rowCount) throw clientOrderSync.publicError('client_sync_run_scope_denied', 403, '当前账号无权操作该订单同步任务。');
      if (!['manual_all','manual_selected'].includes(run.rows[0].mode)) throw clientOrderSync.publicError('client_sync_auto_paused', 409, '自动订单处理已暂停，该任务不能更新失败状态。');
      const state = category === 'configuration' ? 'authorization_expired' : 'failed';
      await client.query(`UPDATE client_order_sync_runs SET state=$2,failure_code=$3,failure_detail=$4,completed_at=now(),lease_expires_at=NULL,updated_at=now() WHERE run_id=$1`, [runId, state, code, failureReason]);
      if (run.rows[0].state === 'uploading') {
        const stopped = await client.query(`WITH stopped AS (
          UPDATE client_order_upload_batches SET state='failed',lease_owner=NULL,lease_expires_at=NULL,last_error=$3,updated_at=now()
          WHERE tenant_id=$1 AND run_id=$2 AND state IN ('queued','retry','running') RETURNING attempts
        ) SELECT count(*) FILTER (WHERE attempts<3)::int AS ready_removed FROM stopped`, [account.tenantId,runId,code]);
        const readyRemoved = Number(stopped.rows[0]?.ready_removed || 0);
        if (readyRemoved > 0) await client.query(`UPDATE client_order_tenant_queue_state SET ready_batch_count=GREATEST(0,ready_batch_count-$2),updated_at=now() WHERE tenant_id=$1`, [account.tenantId,readyRemoved]);
      }
      if (run.rows[0].daily_cycle_id) await client.query(
        `UPDATE client_order_daily_participants SET state='failed',failure_code=$3,updated_at=now()
         WHERE cycle_id=$1 AND run_id=$2`, [run.rows[0].daily_cycle_id, runId, code]
      );
      await client.query(`UPDATE sync_tasks SET status='failed',progress_label='订单同步失败',failure_reason=$3,ended_at=now(),updated_at=now() WHERE tenant_id=$1 AND task_id=$2`, [account.tenantId, 'client-order-' + runId, category === 'configuration' ? '客户端登录或配置不可用，请检查后重新同步。' : '客户端订单读取或校验失败，请重新同步或联系管理员查看任务日志。']);
      await client.query('COMMIT');
      return { state, category, code, failureReason, mode: run.rows[0].mode, clientId };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async cancelClientOrderSyncRun(account, runId) {
    const id = clientOrderSync.safeUuid(runId, 'client_sync_run_invalid');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE client_order_sync_runs SET state='cancelled',completed_at=now(),updated_at=now()
         WHERE run_id=$1 AND tenant_id=$2 AND actor_user_id=$3
           AND mode IN ('manual_all','manual_selected')
           AND state IN ('waiting_client','leased','manifested','backup_ready') RETURNING *`,
        [id, account.tenantId, account.userId]
      );
      if (result.rows[0] && result.rows[0].daily_cycle_id) await client.query(
        `UPDATE client_order_daily_participants SET state='failed',failure_code='client_sync_cancelled',updated_at=now()
         WHERE cycle_id=$1 AND run_id=$2`, [result.rows[0].daily_cycle_id, id]
      );
      await client.query('COMMIT');
      return result.rows[0] || null;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  // Migration 067 initially counted all historical queued runs, including
  // auto_* runs which are now paused. Reconcile that existing counter once
  // per worker/store lifecycle before using the ready-count index. Enqueue,
  // claim, complete and failure paths maintain the count incrementally after
  // this repair; the queue-row lock serializes it with active enqueues.
  async reconcileClientOrderReadyCounts() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT tenant_id FROM client_order_tenant_queue_state ORDER BY tenant_id FOR UPDATE`);
      await client.query(
        `UPDATE client_order_tenant_queue_state queue
         SET ready_batch_count = (
           SELECT count(*)::integer FROM client_order_upload_batches batch
           JOIN client_order_sync_runs run ON run.run_id=batch.run_id AND run.tenant_id=batch.tenant_id
           WHERE batch.tenant_id=queue.tenant_id AND run.state='uploading'
             AND run.mode IN ('manual_all','manual_selected') AND batch.attempts<3
             AND batch.state IN ('queued','retry','running')
         ),updated_at=now()`
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }

  async claimClientOrderUploadBatch(workerId, leaseMs) {
    if (!this.clientOrderReadyCountInitialization) {
      this.clientOrderReadyCountInitialization = this.reconcileClientOrderReadyCounts();
    }
    try { await this.clientOrderReadyCountInitialization; }
    catch (error) { this.clientOrderReadyCountInitialization = null; throw error; }
    for (let collision = 0; collision < 5; collision += 1) {
      try {
        const result = await this.pool.query(
      `WITH tenant_candidate AS (
         SELECT queue.tenant_id FROM client_order_tenant_queue_state queue
         WHERE queue.ready_batch_count > 0
         ORDER BY queue.last_claimed_at NULLS FIRST,queue.tenant_id
         FOR UPDATE SKIP LOCKED LIMIT 1
       ), candidate AS (
         SELECT batch.tenant_id,batch.shop_external_id,batch.backup_generation_id,batch.batch_id
         FROM client_order_upload_batches batch
         JOIN tenant_candidate tenant ON tenant.tenant_id=batch.tenant_id
         JOIN client_order_sync_runs run ON run.run_id=batch.run_id AND run.tenant_id=batch.tenant_id
         WHERE run.state='uploading' AND run.mode IN ('manual_all','manual_selected') AND batch.attempts<3
           AND (batch.state IN ('queued','retry') OR (batch.state='running' AND batch.lease_expires_at<now()))
           AND NOT EXISTS (SELECT 1 FROM client_order_upload_batches active
             WHERE active.tenant_id=batch.tenant_id AND active.shop_external_id=batch.shop_external_id AND active.run_id=batch.run_id
               AND active.state='running' AND active.lease_expires_at>=now())
         ORDER BY batch.created_at,batch.sequence_no
         FOR UPDATE OF batch SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE client_order_upload_batches batch SET state='running',lease_owner=$1,
           lease_expires_at=now()+($2*interval '1 millisecond'),attempts=attempts+1,updated_at=now()
         FROM candidate WHERE batch.tenant_id=candidate.tenant_id AND batch.shop_external_id=candidate.shop_external_id
           AND batch.backup_generation_id=candidate.backup_generation_id AND batch.batch_id=candidate.batch_id
         RETURNING batch.*
       ), touched AS (
         UPDATE client_order_tenant_queue_state queue
         SET last_claimed_at=clock_timestamp(),
             ready_batch_count=GREATEST(0,queue.ready_batch_count-CASE WHEN claimed.attempts>=3 THEN 1 ELSE 0 END),
             updated_at=now()
         FROM claimed WHERE queue.tenant_id=claimed.tenant_id RETURNING queue.tenant_id
       ) SELECT claimed.* FROM claimed JOIN touched ON touched.tenant_id=claimed.tenant_id`,
          [String(workerId).slice(0,120), Math.max(5000, Math.min(300000, Number(leaseMs)||120000))]);
        return result.rows[0] || null;
      } catch (error) {
        // The partial unique index is the final same-shop concurrency guard.
        // A competing worker can win between candidate visibility and UPDATE;
        // retry tenant selection instead of turning that safe rejection into a task failure.
        if (error && error.code === '23505' && error.constraint === 'client_order_upload_batches_one_running_shop_idx') continue;
        throw error;
      }
    }
    return null;
  }

  async applyClientOrderUploadBatch(batch, workerId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO client_order_tenant_queue_state (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [batch.tenant_id]);
      await client.query(`SELECT tenant_id FROM client_order_tenant_queue_state WHERE tenant_id=$1 FOR UPDATE`, [batch.tenant_id]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))`, [String(batch.tenant_id), String(batch.shop_external_id)]);
      const locked = await client.query(`SELECT * FROM client_order_upload_batches WHERE tenant_id=$1 AND shop_external_id=$2 AND backup_generation_id=$3 AND batch_id=$4 AND state='running' AND lease_owner=$5 FOR UPDATE`, [batch.tenant_id,batch.shop_external_id,batch.backup_generation_id,batch.batch_id,workerId]);
      if (!locked.rowCount) throw clientOrderSync.publicError('client_sync_batch_lease_lost', 409, '订单同步批次租约已失效，本批次未入库。');
      const run = await client.query(`SELECT actor_user_id,state,mode FROM client_order_sync_runs WHERE run_id=$1 AND tenant_id=$2 FOR UPDATE`, [batch.run_id,batch.tenant_id]);
      if (!run.rowCount || run.rows[0].state !== 'uploading') throw clientOrderSync.publicError('client_sync_run_not_uploading', 409, '订单同步任务不在上传状态，本批次未入库。');
      if (!['manual_all','manual_selected'].includes(run.rows[0].mode)) throw clientOrderSync.publicError('client_sync_auto_paused', 409, '自动订单处理已暂停，该批次不能入库。');
      const actor = await this.productEditActor(batch.tenant_id, run.rows[0].actor_user_id);
      if (!actor || !actor.enabled || !this.hasPermission(actor,'orders.write')) throw clientOrderSync.publicError('client_sync_actor_unavailable', 403, '当前账号没有该店铺的订单同步权限。');
      await client.query(`INSERT INTO business_data_versions (tenant_id,document_key,version,payload_shape,updated_by_user_id) VALUES ($1,'erp_orders_data',1,'array',$2) ON CONFLICT (tenant_id,document_key) DO NOTHING`, [actor.tenantId,actor.userId]);
      await client.query(`SELECT version FROM business_data_versions WHERE tenant_id=$1 AND document_key='erp_orders_data' FOR UPDATE`, [actor.tenantId]);
      const scoped = batch.payload.map(item => applySystemOrderReasonMappings({...item,clientId:batch.shop_external_id}));
      const current = await currentOrderPayloadsForSync(client, actor.tenantId, batch.shop_external_id, scoped);
      await reconcileOrderManualData(client, actor.tenantId, scoped, current);
      const normalized = rowsForPayload('erp_orders_data',normalizePlatformPayload('erp_orders_data',scoped,supplierHosts(process.env.ERP_SUPPLIER_HOST_ALLOWLIST)).map(item=>({...item,_syncRunId:String(batch.run_id)})));
      const upsertRows = normalized.rows.map(row => {
        const item = row.payload || {};
        return { record_key: row.recordKey, position: row.position, posting_number: String(item.posting || '').slice(0, 180) || null,
          platform_record_id: String(item.platformRecordId), payload: item };
      });
      if (upsertRows.length) await client.query(
        `INSERT INTO business_orders (tenant_id,record_key,position,posting_number,shop_external_id,platform_source,platform_record_id,payload,updated_by_user_id)
         SELECT $1,row.record_key,row.position,row.posting_number,$2,'ozon',row.platform_record_id,row.payload,$3
         FROM jsonb_to_recordset($4::jsonb) AS row(record_key text,position integer,posting_number text,platform_record_id text,payload jsonb)
         ON CONFLICT (tenant_id,record_key) DO UPDATE SET posting_number=EXCLUDED.posting_number,shop_external_id=EXCLUDED.shop_external_id,
           platform_source='ozon',platform_record_id=EXCLUDED.platform_record_id,payload=EXCLUDED.payload,
           updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=now()`,
        [actor.tenantId, batch.shop_external_id, actor.userId, JSON.stringify(upsertRows)]
      );
      const revision = await client.query(`UPDATE business_data_versions SET version=version+1,updated_by_user_id=$2,updated_at=now() WHERE tenant_id=$1 AND document_key='erp_orders_data' RETURNING version`, [actor.tenantId,actor.userId]);
      await client.query(`UPDATE client_order_upload_batches SET state='complete',lease_owner=NULL,lease_expires_at=NULL,completed_at=now(),updated_at=now() WHERE tenant_id=$1 AND shop_external_id=$2 AND backup_generation_id=$3 AND batch_id=$4`, [batch.tenant_id,batch.shop_external_id,batch.backup_generation_id,batch.batch_id]);
      if (Number(locked.rows[0].attempts) < 3) await client.query(`UPDATE client_order_tenant_queue_state SET ready_batch_count=GREATEST(0,ready_batch_count-1),updated_at=now() WHERE tenant_id=$1`, [batch.tenant_id]);
      const pending = await client.query(`SELECT count(*) FILTER (WHERE state='complete')::int done,count(*)::int total FROM client_order_upload_batches WHERE run_id=$1`, [batch.run_id]);
      const manifest = await client.query(`SELECT batch_count FROM client_order_sync_manifests WHERE run_id=$1`, [batch.run_id]);
      if (manifest.rowCount && pending.rows[0].done === manifest.rows[0].batch_count && pending.rows[0].total === manifest.rows[0].batch_count) {
        const allBatches = await client.query(`SELECT body_sha256 FROM client_order_upload_batches WHERE run_id=$1 ORDER BY sequence_no`, [batch.run_id]);
        const expectedHash = (await client.query(`SELECT content_sha256 FROM client_order_sync_manifests WHERE run_id=$1`, [batch.run_id])).rows[0].content_sha256;
        const receivedHash = clientOrderSync.sha256(clientOrderSync.canonicalize(allBatches.rows.map(row => row.body_sha256)));
        if (receivedHash !== expectedHash) throw clientOrderSync.publicError('client_sync_manifest_hash_mismatch', 409, '订单同步清单与实际批次不一致，本批次未入库。');
        await client.query(`UPDATE business_orders SET payload=payload-'_syncRunId',updated_at=now() WHERE tenant_id=$1 AND shop_external_id=$2 AND payload->>'_syncRunId'=$3`, [batch.tenant_id,batch.shop_external_id,String(batch.run_id)]);
        await client.query(`UPDATE client_order_sync_runs SET state='completed',server_revision=$2,completed_at=now(),updated_at=now() WHERE run_id=$1`, [batch.run_id,revision.rows[0].version]);
        const completedTask = await client.query(`UPDATE sync_tasks SET status='done',progress_value=100,progress_label='订单同步完成',ended_at=now(),updated_at=now() WHERE tenant_id=$1 AND task_id=$2 RETURNING parent_task_id`, [batch.tenant_id,'client-order-'+batch.run_id]);
        if (completedTask.rows[0]?.parent_task_id) await this.refreshSyncBatchParent(client, batch.tenant_id, completedTask.rows[0].parent_task_id);
      }
      await this.writeAudit(client, actor, 'order.client_sync_batch', 'shop', batch.shop_external_id, 'success', { runId: String(batch.run_id), batchId: batch.batch_id, orderCount: normalized.rows.length, backupGenerationId: Number(batch.backup_generation_id) });
      await client.query('COMMIT');
      return { count: normalized.rows.length };
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
    finally { client.release(); }
  }

  async failClientOrderUploadBatch(batch, workerId, error) {
    const code=/^[a-z][a-z0-9_]{0,119}$/.test(String(error&&error.publicCode||'')) ? String(error.publicCode) : 'client_sync_apply_failed';
    const client=await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Match enqueue/claim/apply lock order before changing batch states.
      await client.query(`SELECT tenant_id FROM client_order_tenant_queue_state WHERE tenant_id=$1 FOR UPDATE`,[batch.tenant_id]);
      const failed=await client.query(`UPDATE client_order_upload_batches batch SET state=CASE WHEN attempts<3 THEN 'retry' ELSE 'failed' END,lease_owner=NULL,lease_expires_at=NULL,last_error=$6,updated_at=now() FROM client_order_sync_runs run WHERE batch.tenant_id=$1 AND batch.shop_external_id=$2 AND batch.backup_generation_id=$3 AND batch.batch_id=$4 AND batch.lease_owner=$5 AND run.run_id=batch.run_id AND run.mode IN ('manual_all','manual_selected') RETURNING batch.state,batch.run_id`, [batch.tenant_id,batch.shop_external_id,batch.backup_generation_id,batch.batch_id,workerId,code]);
      let finalFailure=null;
      if(failed.rows[0]&&failed.rows[0].state==='failed'){
        // A terminal failure cancels the remaining batches of this run. Keep
        // ready-count consistent, otherwise a queue with no eligible manual
        // work can stay "ready" and starve later tenants.
        const abandoned=await client.query(
          `WITH stopped AS (
             UPDATE client_order_upload_batches SET state='failed',lease_owner=NULL,lease_expires_at=NULL,last_error=$2,updated_at=now()
             WHERE run_id=$1 AND state IN ('queued','retry','running') RETURNING attempts
           ) SELECT count(*) FILTER (WHERE attempts<3)::integer AS count FROM stopped`,
          [failed.rows[0].run_id,code]
        );
        const count=Number(abandoned.rows[0]?.count || 0);
        if(count) await client.query(`UPDATE client_order_tenant_queue_state SET ready_batch_count=GREATEST(0,ready_batch_count-$2),updated_at=now() WHERE tenant_id=$1`,[batch.tenant_id,count]);
        await client.query(`UPDATE client_order_sync_runs SET state='failed',failure_code=$2,failure_detail=$3,completed_at=now(),updated_at=now() WHERE run_id=$1`,[failed.rows[0].run_id,code,'客户端订单批次入库失败']);
        await client.query(`UPDATE sync_tasks SET status='failed',progress_label='订单同步失败',failure_reason=$3,ended_at=now(),updated_at=now() WHERE tenant_id=$1 AND task_id=$2`,[batch.tenant_id,'client-order-'+failed.rows[0].run_id,'订单批次校验或入库失败，请重新同步或联系管理员查看任务日志。']);
        const run=await client.query(`SELECT mode,shop_external_id FROM client_order_sync_runs WHERE run_id=$1 AND tenant_id=$2`,[failed.rows[0].run_id,batch.tenant_id]);
        if(run.rowCount) finalFailure={final:true,runId:String(failed.rows[0].run_id),tenantId:String(batch.tenant_id),clientId:String(run.rows[0].shop_external_id),mode:String(run.rows[0].mode),code};
      }
      await client.query('COMMIT');
      return finalFailure||{final:false,code};
    } catch(error2){await client.query('ROLLBACK').catch(()=>{});throw error2;} finally{client.release();}
  }
}

module.exports = { PostgresAuthStore, preserveProductLocalFieldsForSync, confirmedCreateCombinationReplacement, membershipRewardAmount };
