#!/usr/bin/env node
/* 网研ERP 数据服务：静态文件 + 用户账号 + 按用户隔离的 JSON 数据存储
   启动：node server.js
   浏览器：http://<服务器IP>:8765
   生产部署建议：放到 Nginx/Caddy 反向代理后面并启用 HTTPS。 */
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { URL } = require('url');
const { clientAddress: resolveClientAddress, isLoopbackAddress, socketAddress } = require('./auth/client-address');
const { PostgresAuthStore } = require('./auth/postgres-store');
const membershipQuota = require('./auth/membership-quota');
const favoriteCreator = require('./auth/favorite-creator');
const identityDisplay = require('./assets/identity-display');
const { createActivationCode } = require('./auth/activation-code');
const orderManualExcel = require('./auth/order-manual-excel');
const { AUDITED_KEYS, applyEntityAudit, filterEntityAuditVisibility } = require('./auth/entity-audit');
const { localizeAuditEvent, formatAuditMetadata } = require('./auth/audit-display');
const { parseCredentialKey, encryptShopCredentials, decryptShopCredentials, hasPlaintextShopCredentials } = require('./auth/credential-crypto');
const { loadRuntimeSecret } = require('./auth/runtime-secret');
const { createBugMailer } = require('./auth/bug-mailer');
const { transportMode: logisticsTransportMode } = require('./auth/logistics-tariff-parser');
const { parseLogisticsWorkbookInWorker } = require('./auth/logistics-parse-worker');
const { createPromiseTaskQueue } = require('./auth/promise-task-queue');
const { LOGISTICS_PREFERENCE_POLICY_VERSION, reconcileLogisticsPreferences } = require('./auth/logistics-preferences');
const { LOGISTICS_PLAN_PROFILE_IDS, normalizeLogisticsPlanProfiles, assignLogisticsPlanProfile } = require('./auth/logistics-plan-profiles');
const { selectPreferredVersions, promoteOfficialVersion, canDownloadOriginal } = require('./auth/logistics-versions');
const { normalizeStoredPricingSettings, validatePricingSettingsInput } = require('./auth/pricing-settings');
const { normalizeLibrary: normalizeCategoryAttributeLibrary, summarizeLibrary: summarizeCategoryAttributeLibrary, categoryKey: categoryAttributeKey } = require('./auth/category-attribute-library');
const { syncCategoryAttributes } = require('./auth/category-attribute-sync');
const { createPublicCategoryCatalog } = require('./auth/public-category-catalog');
const { stringifyLargeCategoryDocument } = require('./auth/large-document-json');
const { createApiMonitor } = require('./auth/api-monitor');
const { createBackgroundTaskQueue } = require('./auth/background-task-queue');
const { createPersistentBackgroundWorker } = require('./auth/persistent-background-worker');
const clientOrderSync = require('./auth/client-order-sync');
const { runProductSync } = require('./auth/product-sync-runner');
const { runOrderSync } = require('./auth/order-sync-runner');
const { syncOrderNetIncome } = require('./auth/order-net-income-sync');
const { syncOrderExchangeRates } = require('./auth/order-exchange-rate-sync');
const { createOrderFeeEnricher } = require('./auth/order-fee-enricher');
const { createOrderAcquiringSync } = require('./auth/order-acquiring-sync');
const orderAdvertisingSync = require('./auth/order-advertising-sync');
const ozonPerformanceCpo = require('./auth/ozon-performance-cpo');
const { createOrderImageEnricher } = require('./auth/order-image-enricher');
const { createOrderEnrichmentPipeline } = require('./auth/order-enrichment-pipeline');
const { autoMapUnmappedReasons } = require('./auth/order-cancel-reason-auto-mapper');
const { autoMapUnmappedStatuses } = require('./auth/order-return-status-auto-mapper');
const { autoMapUnmappedCategories } = require('./auth/category-auto-mapper');
const { autoMapUnmappedTerms, mappedTranslation } = require('./auth/option-label-auto-mapper');
const { projectWhdOrders, matchingOrigin } = require('./auth/order-whd-projector');
const { limitFields: shopLimitFields, warehouseFields: shopWarehouseFields } = require('./auth/shop-sync');
const { createSingleFlightTask } = require('./auth/single-flight-task');
const { createManualOrderBackup } = require('./auth/manual-order-backup');
const { createUserSecurityMonitor } = require('./auth/user-security-monitor');
const { getOzonCommand } = require('./auth/ozon-commands');
const optionEvidence = require('./auth/product-option-evidence').createOptionEvidence();
const productEdit = require('./auth/product-edit');
const productCombinationGraph = require('./auth/product-combination-store');
const onlineProductCostQuery = require('./auth/online-product-cost-query');
const productCombinationAi = require('./auth/product-combination-ai');
const { createProductEditQueue } = require('./auth/product-edit-queue');
const productCreate = require('./auth/product-create');
const { createProductCreateQueue } = require('./auth/product-create-queue');
const { createOzonShopScheduler } = require('./auth/ozon-shop-scheduler');
const { PRODUCT_READS, readProduct, failureCode: ozonFailureCode } = require('./auth/ozon-product-read');
const { createSeerfarMarketCache } = require('./auth/seerfar-market-cache');
const seerfarAnalysisBilling = require('./auth/seerfar-analysis-billing');
const { createOzonCategoryReference } = require('./auth/ozon-category-reference');
const { createManager: createOzonCommissionCatalog } = require('./auth/ozon-commission-catalog');
const { supplierHosts, normalizePlatformPayload, RELATIONAL_BUSINESS_KEYS, FINANCE_SETTING_KEYS } = require('./auth/business-boundaries');
const collectionImageSources = require('./assets/product-collection-images');
const collectionService = require('./auth/collection-service');
const { PrivateObjectStore, pathInside } = require('./auth/private-object-store');
const aiConfig = require('./auth/ai-config');
const { createAiConfigStore } = require('./auth/ai-config-store');
const { createAiBeanStore, IMAGE_COST_BEAN } = require('./auth/ai-bean-store');
const { createAiPromptStore } = require('./auth/ai-prompt-store');
const { createAiProductRuleStore } = require('./auth/ai-product-rules');
const { createAiPricingStore } = require('./auth/ai-pricing-store');
const { nodeRole, runsBackgroundJobs, servesBusinessRequests } = require('./auth/node-role');
const aiPrompts = require('./auth/ai-prompts');
const aiCandidate = require('./auth/ai-product-candidate');
const { createContentDiagnostics } = require('./auth/product-content-diagnostics');
const skuImageAnalysisProof = require('./auth/sku-image-analysis-proof');
const skuSellingPointsLanguage = require('./auth/sku-selling-points-language');
const skuImageFinalPrompt = require('./auth/sku-image-final-prompt');
const skuImagePolling = require('./auth/sku-image-polling');
const { createSkuImageAiWorker, requireSkuImagePromptReady } = require('./auth/sku-image-ai-worker');
const { composeProductVideo, parseHttpByteRange } = require('./auth/product-video-compose-worker');
const { createSkuImageAiEnqueuer } = require('./auth/sku-image-ai-enqueue');
const skuImagePromptSnapshot = require('./auth/sku-image-prompt-snapshot');
const { createSkuImageJobId } = require('./auth/sku-image-job-id');
const aiContent = require('./auth/ai-product-content');
const aiProvider = require('./auth/ai-provider');
const skuImageUpload = require('./auth/sku-image-upload');
const { createPublisher: createSkuImagePublisher } = require('./auth/sku-image-publish');
const OFFICIAL_SKU_IMAGE_SUBMIT_TIMEOUT_MS = 120000;
const orderAdvertisingCache = new Map();
const ORDER_ADVERTISING_DAILY_CACHE_PREFIX = 'erp_order_advertising_daily_';
function orderAdvertisingDocumentKey(clientId) {
  const value = String(clientId || '').trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) {
    const error = new Error('广告统计店铺编号不正确，请刷新店铺配置后重试。');
    error.publicCode = 'order_advertising_client_invalid';
    throw error;
  }
  return ORDER_ADVERTISING_DAILY_CACHE_PREFIX + value;
}
function advertisingBreakdownForAccount(rows, exposeTypeId) {
  return (Array.isArray(rows) ? rows : []).map(row => {
    if (exposeTypeId) return row;
    const copy = { ...row };
    delete copy.type;
    return copy;
  });
}
function advertisingPublicDays(days, dates, exposeTypeId) {
  const out = {};
  (dates || Object.keys(days || {})).forEach(date => {
    const day = days && days[date];
    if (!day) return;
    out[date] = {
      date,
      fetchedAt: day.fetchedAt || null,
      unallocatedBreakdown: advertisingBreakdownForAccount(day.unallocatedBreakdown, exposeTypeId)
    };
  });
  return out;
}
async function persistAdvertisingDailyCache(account, clientId, result, existingDocument) {
  if (!result || !Array.isArray(result.fetchedDates) || !result.fetchedDates.length) return existingDocument;
  const key = orderAdvertisingDocumentKey(clientId);
  let current = existingDocument;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const base = current && current.payload && typeof current.payload === 'object' ? current.payload : {};
    const mergedDays = { ...(base.days && typeof base.days === 'object' ? base.days : {}) };
    result.fetchedDates.forEach(date => { if (result.days && result.days[date]) mergedDays[date] = result.days[date]; });
    const payload = { schemaVersion: 1, clientId: String(clientId), days: mergedDays };
    try {
      const saved = await authStore.putDocument(account, key, payload, current ? current.version : 0);
      return { payload, version: saved.version, updatedAt: saved.updatedAt };
    } catch (error) {
      if (error.publicCode !== 'document_version_conflict' || attempt >= 2) throw error;
      current = await authStore.getDocument(account, key);
    }
  }
  return current;
}

const ORDER_PERFORMANCE_CPO_CACHE_PREFIX = 'erp_order_performance_cpo_';
function performanceCpoDocumentKey(clientId) {
  const value = String(clientId || '').trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(value)) {
    const error = new Error('按订单付费店铺编号不正确，请刷新店铺配置后重试。');
    error.publicCode = 'performance_cpo_client_invalid';
    throw error;
  }
  return ORDER_PERFORMANCE_CPO_CACHE_PREFIX + value;
}
async function persistPerformanceCpoCache(account, clientId, result, existingDocument) {
  if (!result || !Array.isArray(result.fetchedDates) || !result.fetchedDates.length) return existingDocument;
  const key = performanceCpoDocumentKey(clientId);
  let current = existingDocument;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const base = current && current.payload && typeof current.payload === 'object' ? current.payload : {};
    const mergedDays = { ...(base.days && typeof base.days === 'object' ? base.days : {}) };
    result.fetchedDates.forEach(date => { if (result.days && result.days[date]) mergedDays[date] = result.days[date]; });
    const payload = { schemaVersion: 1, clientId: String(clientId), days: mergedDays };
    try {
      const saved = await authStore.putDocument(account, key, payload, current ? current.version : 0);
      return { payload, version: saved.version, updatedAt: saved.updatedAt };
    } catch (error) {
      if (error.publicCode !== 'document_version_conflict' || attempt >= 2) throw error;
      current = await authStore.getDocument(account, key);
    }
  }
  return current;
}
function advertisingRecordNetRub(records, chargeModel) {
  return Math.round((Array.isArray(records) ? records : []).filter(item => String(item && item.chargeModel || '') === chargeModel)
    .reduce((sum, item) => sum + (String(item && item.direction || '') === 'credit' ? -Number(item.amountRub || 0) : Number(item.amountRub || 0)), 0) * 100) / 100;
}

const OFFICIAL_SKU_IMAGE_POLL_TOTAL_WAIT_MS = skuImagePolling.TOTAL_WAIT_MS;
const OFFICIAL_SKU_IMAGE_POLL_INTERVAL_MS = skuImagePolling.INTERVAL_MS;
const SKU_REDRAW_ATTEMPT_MAX_PROCESSING_MS = 180000;
function skuRedrawAttemptId(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}
function skuRedrawSafeDiagnostic(value) {
  if (!value || value.stage !== 'ai_provider_dns' || typeof value.hostname !== 'string' || value.hostname.length > 255 || !Array.isArray(value.addressClasses)) return null;
  const allowed = new Set(['proxy_fake_ip', 'protected', 'public', 'invalid']);
  const addressClasses = Array.from(new Set(value.addressClasses.filter(item => allowed.has(item))));
  return { stage: 'ai_provider_dns', hostname: value.hostname, addressClasses };
}
async function skuRedrawRuleHash(aiProductRuleStore) {
  const rules = await aiProductRuleStore.effective('sellingPoints', { requireGlobal: true, includeMetadata: true });
  return skuImageAnalysisProof.digest(JSON.stringify({ global: skuImageAnalysisProof.digest(rules.global), sellingPoints: skuImageAnalysisProof.digest(rules.item), versions: rules.versions }));
}
const { createFileMatcher: create1688CategoryMatcher } = require('./auth/1688-category-matcher');
const { matchBatchCompiled: matchOzonCategoriesCompiled, compileCatalogAsync: compileOzonCategoryCatalogAsync, normalizeFeedback: normalizeOzonCategoryFeedback, recordFeedbackCompiled: recordOzonCategoryFeedbackCompiled, sourceSignature: ozonCategorySourceSignature, titleFingerprint: ozonCategoryTitleFingerprint } = require('./auth/ozon-category-matcher');
const productSourceLink = require('./assets/product-source-link');
const { currentCnyRubRate } = require('./auth/cny-rub-rate');

const BASE = __dirname;
const VERSION_FILE = path.join(BASE, 'version.json');
function loadAppVersion() {
  let source;
  try {
    source = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch (error) {
    throw new Error('版本信息读取失败: ' + String(error && error.message || error));
  }
  const productVersion = String(source && source.productVersion || '').trim();
  const channel = String(source && source.channel || '').trim();
  const build = String(source && source.build || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(productVersion)) throw new Error('version.json productVersion 格式无效');
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) throw new Error('version.json channel 格式无效');
  if (!/^\d{8}\.\d+$/.test(build)) throw new Error('version.json build 格式无效');
  return Object.freeze({
    productVersion,
    channel,
    build,
    displayVersion: 'v' + productVersion + '-' + channel + ' · ' + build
  });
}
const APP_VERSION = loadAppVersion();
function appVersionPayload() {
  return {
    version: APP_VERSION.productVersion,
    channel: APP_VERSION.channel,
    build: APP_VERSION.build,
    displayVersion: APP_VERSION.displayVersion
  };
}const manualOrderBackup = createManualOrderBackup({
  baseDir: BASE,
  onError: error => console.error('手动订单同步数据库备份失败:', error && error.message || error)
});
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(process.env.ERP_DATA_DIR || path.join(BASE, 'data'));
// Public official reference data is independent of tenant business records.
// If no verified active version has been installed, retain the legacy DB read
// path so existing accounts do not suddenly lose their category data.
const publicCategoryCatalog = createPublicCategoryCatalog(path.resolve(
  process.env.ERP_PUBLIC_OZON_CATEGORY_DIR || path.join(DATA_DIR, 'reference', 'ozon-category-catalog')
));
const RUNTIME_LOG_DIR = path.resolve(process.env.ERP_RUNTIME_LOG_DIR || path.join(BASE, '..', '本机数据', 'logs'));
function runtimeDiagnostic(level, message) {
  try {
    fs.mkdirSync(RUNTIME_LOG_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const line = `[${new Date().toISOString()}] ${String(level || 'INFO')} ${String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 2000)}\n`;
    fs.appendFile(path.join(RUNTIME_LOG_DIR, `wyerp-runtime-${day}.log`), line, 'utf8', function () {});
  } catch (_) {}
}
const runtimeEventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
runtimeEventLoopDelay.enable();
let recentEventLoopP99Ms = 0;
function runtimePoolMetrics() {
  const pool = authStore && authStore.pool;
  return pool ? {
    total: Number(pool.totalCount) || 0,
    idle: Number(pool.idleCount) || 0,
    waiting: Number(pool.waitingCount) || 0
  } : { total: 0, idle: 0, waiting: 0 };
}
function sampleRuntimeContention() {
  const p99 = runtimeEventLoopDelay.percentile(99) / 1e6;
  recentEventLoopP99Ms = Number.isFinite(p99) ? Math.round(p99) : 0;
  runtimeEventLoopDelay.reset();
  const pool = runtimePoolMetrics();
  if (recentEventLoopP99Ms >= 500 || pool.waiting > 0) {
    // No account, SKU, tenant, cookie or SQL body is ever logged.
    runtimeDiagnostic('WARN', `[负载诊断] eventLoopP99=${recentEventLoopP99Ms}ms PG池(total=${pool.total},idle=${pool.idle},waiting=${pool.waiting})`);
  }
}
const TENANTS_DIR = path.join(DATA_DIR, 'tenants');
const P2_FREEZE_MARKER = path.join(DATA_DIR, '.p2-legacy-json-frozen.json');
const LEGACY_JSON_LAZY_IMPORT_ENABLED = process.env.ERP_LEGACY_JSON_LAZY_IMPORT === '1' && !IS_PRODUCTION;
const BUG_ATTACHMENT_DIR = path.join(DATA_DIR, 'bug-attachments');
const LOGISTICS_TARIFF_DIR = path.resolve(process.env.ERP_LOGISTICS_TARIFF_DIR || path.join(BASE, '..', '本机数据', '物流原表'));
const PRIVATE_OBJECT_DIR = path.resolve(process.env.ERP_PRIVATE_OBJECT_DIR || path.join(BASE, '..', '本机数据', 'private-objects'));
// 私有对象加密密钥：优先环境变量，其次受保护密钥文件（与 credentials.key / csrf.key 同一模式，均不入 Git）
const PRIVATE_OBJECT_KEY_FILE = String(process.env.ERP_PRIVATE_OBJECT_KEY_FILE || path.join(__dirname, '..', '本机数据', '配置', 'private-object.key'));
function loadPrivateObjectKey() {
  const inline = String(process.env.ERP_PRIVATE_OBJECT_KEY || '').trim();
  if (inline) return inline;
  try { return String(fs.readFileSync(PRIVATE_OBJECT_KEY_FILE, 'utf8')).trim(); } catch (error) { return ''; }
}
// 启动时报告私有对象存储就绪情况与查找路径（只报路径与状态，绝不输出密钥内容）。
function reportPrivateObjectStore() {
  const ready = privateObjectStore.encryptionAvailable();
  const source = String(process.env.ERP_PRIVATE_OBJECT_KEY || '').trim() ? '环境变量 ERP_PRIVATE_OBJECT_KEY' : PRIVATE_OBJECT_KEY_FILE;
  console.log('[sku-image] 私有对象存储：' + (ready ? '已就绪' : '未就绪（缺少加密密钥，图片上传/处理接口会返回 503）') + '；目录=' + PRIVATE_OBJECT_DIR + '；密钥来源=' + source);
  return ready;
}
const privateObjectStore = new PrivateObjectStore(PRIVATE_OBJECT_DIR, { encryptionKey: loadPrivateObjectKey() });
const CATEGORY_1688_TREE_FILE = path.resolve(process.env.ERP_1688_CATEGORY_TREE_FILE || path.join(BASE, '..', '本机数据', '1688', '类目', '第三方公开数据', 'github-jackyfkj-2024-05-29', '1688-三级类目树.json'));
const match1688Category = create1688CategoryMatcher(CATEGORY_1688_TREE_FILE);
const OZON_CATEGORY_FEEDBACK_KEY = 'erp_ozon_category_mapping_feedback';
const CONTRACT_CATALOG_FILE = path.join(BASE, 'contracts', 'catalog.json');
const CONTRACT_SETTINGS_FILE = path.join(DATA_DIR, 'system-contract-settings.json');
// Private contract documents are not distributed with this community snapshot.
const CONTRACT_FILES = new Map();
const HOST = process.env.ERP_HOST || (IS_PRODUCTION ? '127.0.0.1' : '0.0.0.0');
const PORT = Number(process.env.ERP_PORT || 8765);
const STANDALONE_MODE = process.env.WYERP_STANDALONE_MODE === '1' &&
  ['127.0.0.1', '::1', 'localhost'].includes(HOST);
const STANDALONE_UNAVAILABLE_ROUTES = /^\/api\/(?:membership(?:\/|$)|agent(?:\/|$)|payment-evidence(?:\/|$)|system\/(?:contracts?|agents|membership|agent-activation|activation|ai-beans|payment-evidence)(?:\/|$)|auth\/(?:email\/|register$|recovery\/|login\/verify$|profile\/email\/))/;
const STANDALONE_HIDDEN_PAGES = /^(?:pages\/)?(?:membership(?:-admin)?|ai-beans|contract-terms|agent(?:-[^/]*)?|activation(?:-[^/]*)?|accounts|user-monitor)\.html$/;
const ERP_NODE_ROLE = nodeRole(process.env);
const RUN_BACKGROUND_JOBS = runsBackgroundJobs(ERP_NODE_ROLE);
if (ERP_NODE_ROLE === 'worker' && !['127.0.0.1', '::1', 'localhost'].includes(HOST)) {
  throw new Error('后台 Worker 的 HTTP 监听地址必须限制在本机回环地址。');
}

const FRONTEND_VERSION_DIRS = [path.join(BASE, 'assets'), path.join(BASE, 'pages')];
const FRONTEND_VERSION_ROOT_FILES = [path.join(BASE, 'workspace.html'), path.join(BASE, 'login.html'), path.join(BASE, 'index.html')];
const FRONTEND_SHELL_FILES = [
  path.join(BASE, 'workspace.html'),
  path.join(BASE, 'assets', 'workspace-tabs.js'),
  path.join(BASE, 'assets', 'storage.js'),
  path.join(BASE, 'assets', 'sidebar.js'),
  path.join(BASE, 'assets', 'style.css'),
  path.join(BASE, 'assets', 'brand.js'),
  path.join(BASE, 'assets', 'theme-restore.js')
];
const FRONTEND_VERSION_CACHE_MS = 15000;
let frontendVersionCache = { at: 0, value: null, promise: null };
async function frontendFingerprint(entries, recursive) {
  const rows = [];
  async function visit(target) {
    let stat;
    try { stat = await fs.promises.stat(target); } catch (error) { rows.push(path.relative(BASE, target).replace(/\\/g, '/') + ':missing'); return; }
    const relative = path.relative(BASE, target).replace(/\\/g, '/');
    if (stat.isDirectory()) {
      if (!recursive) { rows.push(relative + ':dir:' + Math.floor(stat.mtimeMs)); return; }
      let names = [];
      try { names = (await fs.promises.readdir(target)).sort(); } catch (error) { rows.push(relative + ':unreadable'); return; }
      for (const name of names) await visit(path.join(target, name));
      return;
    }
    if (!stat.isFile()) return;
    rows.push(relative + ':' + stat.size + ':' + Math.floor(stat.mtimeMs));
  }
  for (const entry of entries) await visit(entry);
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 24);
}
async function frontendVersionSnapshot() {
  const now = Date.now();
  if (frontendVersionCache.value && now - frontendVersionCache.at < FRONTEND_VERSION_CACHE_MS) return frontendVersionCache.value;
  if (frontendVersionCache.promise) return frontendVersionCache.promise;
  const pending = Promise.all([
    frontendFingerprint(FRONTEND_VERSION_DIRS.concat(FRONTEND_VERSION_ROOT_FILES), true),
    frontendFingerprint(FRONTEND_SHELL_FILES, false)
  ]).then(([version, shellVersion]) => ({ version, shellVersion }));
  frontendVersionCache.promise = pending;
  try {
    const value = await pending;
    frontendVersionCache = { at: Date.now(), value, promise: null };
    return value;
  } catch (error) {
    frontendVersionCache.promise = null;
    if (frontendVersionCache.value) return frontendVersionCache.value;
    throw error;
  }
}
function refreshGlobalCnyRubRate() {
  if (process.env.NODE_ENV === 'test') return Promise.resolve({ rate: 12, fallback: true, reason: 'test_external_calls_disabled' });
  return currentCnyRubRate({ store: authStore }).catch(error => ({ rate: 12, fallback: true, reason: String(error && (error.code || error.message) || 'cny_rate_unavailable') }));
}

function resolveOzonApiBaseUrl() {
  const configured = String(process.env.ERP_OZON_API_BASE_URL || '').trim();
  if (!configured) return 'https://api-seller.ozon.ru';
  if (process.env.NODE_ENV !== 'test') throw new Error('ERP_OZON_API_BASE_URL is test-only');
  const parsed = new URL(configured);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (!loopback || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/') {
    throw new Error('ERP_OZON_API_BASE_URL must be a loopback HTTP(S) origin in test mode');
  }
  return parsed.origin;
}

const OZON_API_BASE_URL = resolveOzonApiBaseUrl();

function loadSeerfarApiKey() {
  const direct = String(process.env.ERP_SEERFAR_API_KEY || '').trim();
  if (direct) return direct;
  const keyFile = path.resolve(process.env.ERP_SEERFAR_API_KEY_FILE || path.join(BASE, '..', '本机数据', '配置', 'seerfar-api.key'));
  if (!fs.existsSync(keyFile)) return '';
  return fs.readFileSync(keyFile, 'utf8').trim();
}

function loadOfficialAiApiKey() {
  const direct = String(process.env.ERP_OFFICIAL_AI_API_KEY || '').trim();
  if (direct) return direct;
  const keyFile = path.resolve(process.env.ERP_OFFICIAL_AI_API_KEY_FILE || path.join(__dirname, '..', '本机数据', '配置', 'official-ai-api.key'));
  if (!fs.existsSync(keyFile)) return '';
  return fs.readFileSync(keyFile, 'utf8').trim();
}

async function loadPlatformImageApiKey() {
  try {
    const result = await authStore.pool.query(
      `SELECT id, template, encrypted_api_key, tenant_id, owner_user_id
       FROM ai_configurations
       WHERE template = 'grsai-image'
         AND enabled = true
         AND test_status = 'passed'
         AND encrypted_api_key IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 1`
    );
    if (result.rows.length > 0) {
      const row = result.rows[0];
      return aiConfig.decrypt(row, CREDENTIALS_KEY);
    }
  } catch (error) {
    console.error('[loadPlatformImageApiKey] 数据库查询失败:', error.message);
  }
  return loadOfficialAiApiKey();
}

const seerfarMarketCache = createSeerfarMarketCache({
  cacheDir: path.resolve(process.env.ERP_SEERFAR_CACHE_DIR || path.join(DATA_DIR, 'cache', 'seerfar')),
  apiKey: loadSeerfarApiKey
});
const ozonCommissionCatalog = createOzonCommissionCatalog({
  catalogDir: path.join(DATA_DIR, 'commission-rates'),
  workbookPath: path.resolve(process.env.ERP_OZON_GLOBAL_COMMISSION_FILE || path.join(BASE, '..', '本机数据', 'Ozon', '佣金', 'Ozon中国卖家类目佣金表-2025-12-01.xlsx')),
  treePathForTenant: tenantId => path.join(TENANTS_DIR, String(tenantId), 'erp_category_tree.json'),
  localizedCatalogPathForTenant: tenantId => categoryAttributeSnapshotFile(tenantId)
});
const ozonCategoryReference = createOzonCategoryReference({ commissionCatalog: ozonCommissionCatalog });

function loadCredentialKey() {
  const config = loadRuntimeSecret({
    envValue: process.env.ERP_CREDENTIALS_KEY,
    production: IS_PRODUCTION,
    file: process.env.ERP_CREDENTIALS_KEY_FILE || path.join(__dirname, '..', '本机数据', '配置', 'credentials.key')
  });
  return config.secret ? parseCredentialKey(config.secret) : null;
}

const BUSINESS_DATA_KEYS = new Set([
  'erp_shops_data', 'erp_orders_data', 'erp_accrual_types', 'erp_accruals_data',
  'erp_acquiring_data', 'erp_rate', 'erp_fee_manual', 'erp_amount_fix_v1',
  'erp_online_products', 'erp_product_drafts', 'erp_online_product_manual', 'erp_collected_products', 'erp_favorite_products', 'erp_online_categories',
  'erp_category_tree', 'erp_category_attributes', 'erp_dev_manual_backup', 'erp_message_templates', 'erp_message_blacklist',
  'erp_ai_analysis_rules',
  'erp_message_sendlog', 'erp_promotion_rules', 'erp_watermark_templates', 'erp_watermark_preview_base',
  'erp_shop_groups', 'erp_bug_reports'
]);
const BUSINESS_DATA_PERMISSIONS = new Map([
  ['erp_shops_data', { read:['shops.read','analytics.read'], write:['shops.write'] }],
  ['erp_shop_groups', { read:['shops.read'], write:['shops.write'] }],
  ['erp_orders_data', { read:['orders.read','analytics.read','dashboard.read'], write:['orders.write'] }],
  ['erp_accrual_types', { read:['orders.read','analytics.read','dashboard.read'], write:['orders.write'] }],
  ['erp_accruals_data', { read:['orders.read','analytics.read','dashboard.read'], write:['orders.write'] }],
  ['erp_acquiring_data', { read:['orders.read','analytics.read','dashboard.read'], write:['orders.write'] }],
  ['erp_rate', { read:['orders.read','analytics.read','dashboard.read'], write:['orders.write'] }],
  ['erp_fee_manual', { read:['orders.read','analytics.read','dashboard.read'], write:['orders.write'] }],
  ['erp_amount_fix_v1', { read:['orders.read','analytics.read','dashboard.read'], write:['orders.write'] }],
  ['erp_dev_manual_backup', { read:['orders.read'], write:['orders.write'] }],
  ['erp_online_products', { read:['products.read','analytics.read'], write:['products.write'] }],
  ['erp_product_drafts', { read:['products.read'], write:['products.write'] }],
  ['erp_online_product_manual', { read:['products.read'], write:['products.write'] }],
  ['erp_online_categories', { read:['products.read','selection.read'], write:['products.write'] }],
  ['erp_category_tree', { read:['products.read','selection.read'], write:['products.write'] }],
  ['erp_category_attributes', { read:['products.read','selection.read'], write:['products.write'] }],
  ['erp_watermark_templates', { read:['products.read'], write:['products.write'] }],
  ['erp_watermark_preview_base', { read:['products.read'], write:['products.write'] }],
  ['erp_collected_products', { read:['collection.read'], write:['collection.write'] }],
  ['erp_favorite_products', { read:['selection.read'], write:['selection.manage'] }],
  ['erp_promotion_rules', { read:['promotions.read'], write:['promotions.write'] }],
  ['erp_message_templates', { read:['messages.read'], write:['messages.write'] }],
  ['erp_message_blacklist', { read:['messages.read'], write:['messages.write'] }],
  ['erp_message_sendlog', { read:['messages.read'], write:['messages.write'] }]
]);
function requiredBusinessDataPermissions(key, method) {
  const entry = BUSINESS_DATA_PERMISSIONS.get(key);
  if (!entry) return [];
  const value = method === 'GET' ? entry.read : entry.write;
  return Array.isArray(value) ? value : value ? [value] : [];
}
function hasAnyPermission(account, permissions) {
  return permissions.some(code => authStore.hasPermission(account, code));
}
if (process.env.NODE_ENV === 'test') BUSINESS_DATA_KEYS.add('security_test');
// 这些键的合法形态就是集合：租户从未写入过时也必须给 200 + 空数组，否则页面一刷新就在控制台记一条 404。
const EMPTY_WHEN_MISSING_DATA_KEYS = new Set([
  'erp_favorite_products', 'erp_message_templates', 'erp_message_sendlog', 'erp_message_blacklist', 'erp_bug_reports'
]);

const STATIC_ROOT_FILES = new Set(['index.html', 'workspace.html', 'login.html', 'favicon.ico']);
const STATIC_ROOT_DIRS = new Set(['assets', 'pages']);
const PAGE_PERMISSIONS = new Map([
  ['index.html', ''],
  ['workspace.html', ''],
  ['pages/account-security.html', ''],
  ['pages/bug-feedback.html', ''],
  ['pages/audit-log.html', 'audit.read'],
  ['pages/goods-online.html', 'products.read'], ['pages/product-detail.html', 'products.read'], ['pages/goods.html', 'collection.read'],
  ['pages/goods-onlist.html', 'products.read'], ['pages/goods-relist.html', 'products.read'],
  ['pages/goods-favorites.html', 'selection.read'], ['pages/category.html', 'selection.read'],
  ['pages/ranking.html', 'selection.read'], ['pages/tag-search.html', 'selection.read'],
  ['pages/watermark.html', 'products.write'],
  ['pages/analytics.html', 'selection.read'], ['pages/source-pick.html', 'selection.read'],
  ['pages/promo-ozon.html', 'promotions.read'], ['pages/promo-auto.html', 'promotions.read'],
  ['pages/msg-templates.html', 'messages.read'], ['pages/msg-sendlog.html', 'messages.read'],
  ['pages/dashboard.html', 'dashboard.read'], ['pages/shop-analysis.html', 'analytics.read'],
  ['pages/pricing.html', 'tools.use'], ['pages/profit.html', 'tools.use'],
  ['pages/orders.html', 'orders.read'], ['pages/order-statistics.html', 'orders.read'], ['pages/blacklist.html', 'orders.read'],
  ['pages/shops.html', 'shops.read'], ['pages/shop-groups.html', 'shops.read'],
  ['pages/ai-config.html', ''], ['pages/logistics-config.html', ''], ['pages/pricing-settings.html', ''],
  ['pages/api-monitor.html', ''],
  ['pages/user-monitor.html', ''],
  ['pages/contract-terms.html', ''],
  ['pages/membership.html', ''],
  ['pages/ai-beans.html', ''],
  ['pages/agent-center.html', ''],
  ['pages/membership-admin.html', ''],
  ['pages/accounts.html', ['tenant.members.read', 'tenant.roles.read']]
]);
const SYSTEM_ADMIN_PAGES = new Set(['pages/api-monitor.html', 'pages/user-monitor.html', 'pages/contract-terms.html', 'pages/membership-admin.html']);
const AGENT_OWNER_PAGES = new Set(['pages/agent-center.html']);
// AI 配置页含密钥、模型与系统管理员规则，按规则只允许租户主账号与系统管理员，子账号即使有页面权限码也拒绝。
const OWNER_ONLY_PAGES = new Set(['pages/ai-config.html']);
const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');
const bugMailer = createBugMailer({ env: process.env, publicOrigin: PUBLIC_ORIGIN });
const SECURE_COOKIE = IS_PRODUCTION || process.env.ERP_FORCE_SECURE_COOKIE === '1';
const SESSION_COOKIE = SECURE_COOKIE ? '__Host-wyerp_session' : 'wyerp_session';
const DEVICE_COOKIE = SECURE_COOKIE ? '__Host-wyerp_device' : 'wyerp_device';
const SESSION_ABSOLUTE_MS = Number(process.env.SESSION_TTL_SECONDS || 12 * 60 * 60) * 1000;
const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_SECONDS || 30 * 60) * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const CAPTCHA_REQUEST_WINDOW_MS = 60 * 1000;
const CAPTCHA_REQUEST_MAX = 40;
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const REGISTRATION_MAX_ATTEMPTS = 10;
const ALLOW_REGISTRATION = !IS_PRODUCTION;
const PUBLIC_LAUNCH_ENABLED = false;
const CHARGING_ENABLED = false;
const UNAUTHENTICATED_JSON_MAX_BYTES = 8 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_VIDEO_DOCUMENT_PREFIX = 'erp_product_video_object:';
const SUPPLIER_HOST_ALLOWLIST = supplierHosts(process.env.ERP_SUPPLIER_HOST_ALLOWLIST);
const CREDENTIALS_KEY = loadCredentialKey();
const CSRF_SECRET_CONFIG = loadRuntimeSecret({
  envValue: process.env.ERP_CSRF_SECRET,
  production: IS_PRODUCTION,
  file: process.env.ERP_CSRF_SECRET_FILE || path.join(__dirname, '..', '本机数据', '配置', 'csrf.key')
});
const skuImagePublisher = createSkuImagePublisher({ publicOrigin: PUBLIC_ORIGIN, secret: CSRF_SECRET_CONFIG.secret });
const loginFailures = new Map();
const captchaChallenges = new Map();
const captchaRequestWindows = new Map();
const registrationWindows = new Map();
const activationWindows = new Map();
const paymentReviewWindows = new Map();
const financialReviewWindows = new Map();
const aiBeanAdminWindows = new Map();
const ozonRequestWindows = new Map();
const aiContentWindows = new Map();
const bugEmailWindows = new Map();
const bugEmailNotifications = new Map();
const sellerCookieBindings = new Map();
const categoryAttributeJobs = new Map();
const categoryMatchCompiledCache = new Map();
const skuImageUploadTickets = new Map();
const SKU_IMAGE_UPLOAD_TICKET_TTL_MS = 5 * 60 * 1000;
let authStore;
let aiConfigStore;
let aiBeanStore;
let skuImageAiEnqueuer;
let aiPromptStore;
let aiProductRuleStore;
let aiPricingStore;
let productEditQueue;
let productCreateQueue;
let ozonShopScheduler;
let apiMonitor;
let persistentBackgroundWorker;
const bugEmailQueue = createBackgroundTaskQueue({
  concurrency: 1,
  maximumPending: 200,
  onError: (error, key) => console.error('BUG邮件后台任务失败:', key, error.message)
});
const logisticsParseQueue = createPromiseTaskQueue({ concurrency: 1, maximumSize: 2 });
const shopSyncFallbackQueue = createBackgroundTaskQueue({ concurrency: 1, maximumPending: 200, onError: error => console.error('店铺同步兼容队列失败:', error.message) });
const productSyncFallbackQueue = createBackgroundTaskQueue({ concurrency: 1, maximumPending: 200, onError: error => console.error('商品同步兼容队列失败:', error.message) });
const ORDER_MANUAL_XLSX_MAX_BYTES = 8 * 1024 * 1024;
let userSecurityMonitor;
let warnedUntrustedLoopbackProxy = false;

function validateRuntimeConfig() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('ERP_PORT must be an integer between 1 and 65535');
  if (!Number.isFinite(SESSION_ABSOLUTE_MS) || SESSION_ABSOLUTE_MS <= 0) throw new Error('SESSION_TTL_SECONDS must be positive');
  if (!Number.isFinite(SESSION_IDLE_MS) || SESSION_IDLE_MS <= 0 || SESSION_IDLE_MS > SESSION_ABSOLUTE_MS) {
    throw new Error('SESSION_IDLE_SECONDS must be positive and no greater than SESSION_TTL_SECONDS');
  }
  if (PUBLIC_LAUNCH_ENABLED || CHARGING_ENABLED) throw new Error('Public launch and production charging are paused in this build');
  if (IS_PRODUCTION && process.env.ERP_LEGACY_JSON_LAZY_IMPORT === '1') throw new Error('Production legacy JSON lazy import is permanently disabled');
  if (!IS_PRODUCTION) return;
  const loopback = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';
  if (!loopback && (!PUBLIC_LAUNCH_ENABLED || process.env.ERP_ALLOW_NON_LOOPBACK !== '1')) {
    throw new Error('Production must bind to loopback while public launch is paused');
  }
  if (pathInside(BASE, DATA_DIR)) {
    throw new Error('Production ERP_DATA_DIR must be outside the application directory');
  }
  if (pathInside(BASE, PRIVATE_OBJECT_DIR)) throw new Error('Production ERP_PRIVATE_OBJECT_DIR must be outside the application directory');
  if (!PUBLIC_ORIGIN) throw new Error('Production PUBLIC_ORIGIN is required');
  if (!process.env.ERP_CSRF_SECRET || process.env.ERP_CSRF_SECRET.length < 32) {
    throw new Error('Production ERP_CSRF_SECRET must contain at least 32 characters');
  }
  if (!CREDENTIALS_KEY) throw new Error('Production ERP_CREDENTIALS_KEY is required for encrypted shop credentials');
  let publicUrl;
  try { publicUrl = new URL(PUBLIC_ORIGIN); }
  catch (e) { throw new Error('Production PUBLIC_ORIGIN must be a valid absolute URL'); }
  if (publicUrl.protocol !== 'https:') throw new Error('Production PUBLIC_ORIGIN must use https');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const BUG_ATTACHMENT_TYPES = new Map([
  ['image/jpeg', { extension: '.jpg', maximum: 10 * 1024 * 1024 }],
  ['image/png', { extension: '.png', maximum: 10 * 1024 * 1024 }],
  ['image/gif', { extension: '.gif', maximum: 10 * 1024 * 1024 }],
  ['image/webp', { extension: '.webp', maximum: 10 * 1024 * 1024 }],
  ['video/mp4', { extension: '.mp4', maximum: 100 * 1024 * 1024 }],
  ['video/webm', { extension: '.webm', maximum: 100 * 1024 * 1024 }],
  ['video/quicktime', { extension: '.mov', maximum: 100 * 1024 * 1024 }]
]);
const PAYMENT_EVIDENCE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const PAYMENT_EVIDENCE_MAX_BYTES = 8 * 1024 * 1024;
// 头像：只接受真实图片（文件头再校验一次），字节进加密私有对象区，数据库只留引用。
const PROFILE_AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const PROFILE_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const LOGISTICS_TARIFF_MAX_BYTES = 20 * 1024 * 1024;
const LOGISTICS_CONFIG_KEY = 'erp_logistics_configs';
const LOGISTICS_PLAN_PROFILES_KEY = 'erp_logistics_plan_profiles';
const PRICING_SETTINGS_KEY = 'erp_pricing_settings';
const LOGISTICS_GROUPS = ['Extra Small', 'Budget', 'Small', 'Big', 'Premium Small', 'Premium Big', 'HK'];
const LOGISTICS_TRANSPORT_MODES = ['空运', '陆空', '陆运'];
const LOGISTICS_SCHEMES = ['FBO', 'FBS', 'FBP', 'rFBS'];
const LOGISTICS_PROVIDERS = ['GUOO', 'CEL', 'RETS', 'OGL', 'CHINA_POST'];
const CATEGORY_ATTRIBUTE_KEY = 'erp_category_attributes';

function parseJsonStrict(raw) {
  if (typeof raw === 'string' && raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  return JSON.parse(raw);
}
function loadJson(file, fallback) {
  try {
    return parseJsonStrict(fs.readFileSync(file, 'utf8'));
  } catch (e) { return fallback; }
}

function saveJson(file, data) {
  if (fs.existsSync(P2_FREEZE_MARKER) && pathInside(DATA_DIR, path.resolve(file))) {
    const error = new Error('P2 migration source is frozen'); error.publicCode = 'migration_source_frozen'; throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function validateUsername(username) {
  return typeof username === 'string' && username.trim().length >= 2 && username.trim().length <= 32;
}

function tenantScopedReadAccount(req, res, account) {
  const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
  const tenantId = String(params.get('tenantId') || '').trim();
  if (!tenantId) return account;
  if (!account.isSystemAdmin) {
    sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    return null;
  }
  if (!/^\d+$/.test(tenantId)) {
    sendJson(res, 400, { error: 'invalid_tenant_id', message: '客户空间标识不正确，请刷新页面后重新选择空间。' });
    return null;
  }
  return { ...account, tenantId };
}

// 命令处理器统一入口：先认证，再按 query tenantId 切换到系统管理员选中的租户（非管理员带 tenantId 会被拒绝）。
// 返回 null 时已发出 401/403/400 响应，调用方直接 return。
async function scopedAccountFor(req, res) {
  const account = await authenticate(req);
  if (!account) { sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' }); return null; }
  return tenantScopedReadAccount(req, res, account);
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 6 && password.length <= 128;
}

// 基础信息格式校验（2026-09-21 用户直令：手机号暂用正则校验格式、邮箱格式符合、公司名称至少是中文）。
// 手机号本轮不接短信通道，只允许中国大陆 11 位号码，输入可带 +86、空格、短横线和括号，入库前规范化为纯数字。
const PROFILE_PHONE_RE = /^1[3-9]\d{9}$/;
// 邮箱只做语法校验，真实可达性由验证码证明。
const PROFILE_EMAIL_RE = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function normalizeProfilePhone(value) {
  const raw = String(value == null ? '' : value);
  if (raw.length > 32) return { error: '手机号格式不正确，请填写 11 位中国大陆手机号' };
  const digits = raw.replace(/[^\d+]/g, '').replace(/^\+?86(?=1\d{10}$)/, '');
  return PROFILE_PHONE_RE.test(digits) ? { phone: digits } : { error: '手机号格式不正确，请填写 11 位中国大陆手机号' };
}

// 基础信息栏输入校验：姓名、手机号必填且格式必须正确；公司名称只在请求体确实携带时校验长度，
// “至少是中文”由存储层在与当前名称比对后校验，避免历史不规范名称把整张面板锁死。
// 邮箱不在此处保存，必须由验证码流程 confirmEmailVerification 绑定，浏览器自报邮箱不入库。
function normalizeProfileInput(body) {
  const text = (value, maximum) => String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
  const fullName = text(body.fullName, 60);
  const phone = normalizeProfilePhone(body.phone);
  if (phone.error) return { error: phone.error };
  const tenantName = text(body.tenantName, 160);
  const gender = ['male', 'female'].includes(String(body.gender || '')) ? String(body.gender) : '';
  const signature = String(body.signature == null ? '' : body.signature).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 200);
  if (fullName.length < 2) return { error: '姓名需为 2-60 个字符' };
  if (Object.prototype.hasOwnProperty.call(body, 'tenantName') && tenantName.length < 2) {
    return { error: '公司名称需为 2-160 个字符' };
  }
  return { fullName, phone: phone.phone, tenantName, gender, signature };
}

function normalizeProfileEmail(value) {
  const email = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, '').trim().toLowerCase();
  if (email.length > 240) return { error: '邮箱长度不能超过 240 个字符' };
  if (!PROFILE_EMAIL_RE.test(email) || /\.\./.test(email)) return { error: '邮箱格式不正确，请填写有效邮箱地址' };
  return { email };
}

// 基础信息接口族的响应合同：用户可见字段 error 与 message 都只放判定与抛出行自带的中文，
// 内部代号不进响应体，只写进服务端日志，与中文一一对应供排查。
function profileErrorRes(res, error) {
  const code = error && error.publicCode;
  function respond(status, fallback, extra) {
    if (code) console.warn('基础信息拦截 [' + code + ']:', String((error && error.message) || ''));
    const reason = userErrorText(error, fallback);
    return sendJson(res, status, Object.assign({ error: reason, message: reason }, extra));
  }
  if (code === 'email_code_too_frequent' || code === 'avatar_too_frequent') {
    const fallbackSeconds = code === 'avatar_too_frequent' ? 10 : 60;
    return respond(429, '操作过于频繁，请稍后再试。', {
      retryAfterSeconds: Math.max(1, Number(error.retryAfterSeconds) || fallbackSeconds)
    });
  }
  if (code === 'email_code_send_failed') return respond(502, '验证码邮件发送失败，请稍后重试。');
  if (code) {
    const status = code === 'email_already_used' ? 409 : (code === 'profile_owner_only' || code === 'profile_tenant_rename_owner_only') ? 403 : 400;
    return respond(status, '基础信息保存失败，请检查填写内容后重试。');
  }
  console.error('基础信息处理失败:', error && error.message);
  return respond(500, '基础信息保存失败，请稍后重试。');
}

function authEmailErrorRes(res, error) {
  const code = error && error.publicCode;
  const message = userErrorText(error, '邮箱验证失败，请稍后重试。');
  if (code === 'email_code_too_frequent') {
    return sendJson(res, 429, { error: code, message, retryAfterSeconds: Math.max(1, Number(error.retryAfterSeconds) || 60) });
  }
  if (code === 'email_code_hourly_limit') return sendJson(res, 429, { error: code, message });
  if (code === 'email_code_send_failed') return sendJson(res, 502, { error: code, message });
  if (code === 'email_already_registered') return sendJson(res, 409, { error: code, message });
  if (code === 'account_frozen' || code === 'account_banned') return sendJson(res, 423, { error: code, message });
  if (code) return sendJson(res, 400, { error: code, message });
  console.error('邮箱认证处理失败:', error && error.message);
  return sendJson(res, 500, { error: 'auth_email_failed', message: '邮箱验证失败，请稍后重试。' });
}

function authVerificationSender(email, code, minutes) {
  return process.env.NODE_ENV === 'test' && process.env.ERP_EMAIL_CODE_TEST_MODE === '1'
    ? Promise.resolve({ sent: true, reason: 'test_mode', recipient: email })
    : bugMailer.sendEmailVerificationCode(email, code, minutes);
}

function tenantDir(tenantId) {
  return path.join(TENANTS_DIR, String(tenantId));
}

function tenantDataFile(tenantId, key) {
  const safe = path.basename(String(key));
  return path.join(tenantDir(tenantId), safe + '.json');
}

function canManageSettings(account) {
  return Boolean(account && (account.isSystemAdmin || account.memberType === 'owner'));
}

function logisticsUserConfigKey(account) {
  return 'erp_logistics_user_files_' + String(account.userId);
}

function logisticsPreferenceKey(account) {
  return 'erp_logistics_preferences_' + String(account.userId);
}

function annotateLogisticsSource(items, scope, tenantId) {
  return (Array.isArray(items) ? items : []).map(item => ({ ...item, scope, storageTenantId: String(item.storageTenantId || tenantId) }));
}

function publicLogisticsItem(item, account) {
  const visible = { ...(item || {}) };
  visible.canDownloadOriginal = canDownloadOriginal(account, item);
  ['storageTenantId', 'storedRelativePath', 'storedName', 'objectId', 'objectOrigin'].forEach(key => { delete visible[key]; });
  if (visible.scope === 'official') {
    ['uploadedBy', 'uploadedByUserId', 'promotedFromTenantId', 'promotedFromUserId', 'promotedFromUsername', 'promotionSource', 'previousOfficialVersionId', 'sheetName', 'sha256', 'size'].forEach(key => { delete visible[key]; });
    visible.originalName = '官方资费表.xlsx';
    visible.sheets = Array.isArray(visible.sheets) ? visible.sheets.map(sheet => ({ schemeDefaulted: sheet && sheet.schemeDefaulted === true })) : [];
    visible.rules = Array.isArray(visible.rules) ? visible.rules.map(rule => {
      const publicRule = { ...rule };
      delete publicRule.sheetName;
      return publicRule;
    }) : [];
  }
  return visible;
}

async function promoteGlobalLogisticsOfficial(officialAccount, candidate, sourceAccount) {
  const maxAttempts = 6;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const document = await authStore.getDocument(officialAccount, LOGISTICS_CONFIG_KEY);
    const items = normalizeLogisticsItems(document && document.payload);
    const decision = promoteOfficialVersion(items, candidate);
    if (!decision.promoted) return { promoted: false, current: decision.current, item: null };
    const promotedAt = new Date().toISOString();
    const officialItem = {
      ...decision.items[0],
      scope: 'official', localOnly: false, promoted: true,
      storageTenantId: String(candidate.storageTenantId || sourceAccount.tenantId),
      promotedAt,
      promotionSource: sourceAccount.isSystemAdmin ? 'admin_upload' : 'customer_auto_promoted',
      promotedFromTenantId: String(sourceAccount.tenantId),
      promotedFromUserId: String(sourceAccount.userId),
      promotedFromUsername: String(sourceAccount.username || sourceAccount.userId),
      previousOfficialVersionId: decision.current && decision.current.id ? String(decision.current.id) : null
    };
    const nextItems = decision.items.map((item, index) => index === 0 ? officialItem : item).slice(0, 30);
    try {
      await authStore.putDocument(officialAccount, LOGISTICS_CONFIG_KEY, nextItems, document ? document.version : 0);
      return { promoted: true, current: decision.current, item: officialItem };
    } catch (error) {
      if (error.publicCode === 'document_version_conflict') continue;
      throw error;
    }
  }
  throw Object.assign(new Error('物流官方版本同时发生更新，请刷新后重新上传。'), { publicCode: 'logistics_official_version_conflict', status: 409 });
}

async function loadLogisticsSources(account, dataAccount, customizationAllowed) {
  const officialAccount = await authStore.systemAdminHomeAccount();
  const officialDocument = await authStore.getDocument(officialAccount, LOGISTICS_CONFIG_KEY);
  let officialItems = annotateLogisticsSource(normalizeLogisticsItems(officialDocument && officialDocument.payload), 'official', officialAccount.tenantId);
  let tenantItems = [];
  let localItems = [];
  if (customizationAllowed && !account.isSystemAdmin && String(dataAccount.tenantId) !== String(officialAccount.tenantId)) {
    const [tenantDocument, localDocument] = await Promise.all([
      authStore.getDocument(dataAccount, LOGISTICS_CONFIG_KEY),
      authStore.getDocument(dataAccount, logisticsUserConfigKey(account))
    ]);
    tenantItems = annotateLogisticsSource(normalizeLogisticsItems(tenantDocument && tenantDocument.payload), 'tenant', dataAccount.tenantId);
    localItems = annotateLogisticsSource(normalizeLogisticsItems(localDocument && localDocument.payload), 'local', dataAccount.tenantId);
  } else if (customizationAllowed && account.isSystemAdmin) {
    const localDocument = await authStore.getDocument(officialAccount, logisticsUserConfigKey(officialAccount));
    localItems = annotateLogisticsSource(normalizeLogisticsItems(localDocument && localDocument.payload), 'local', officialAccount.tenantId);
  } else if (!customizationAllowed && !account.isSystemAdmin) {
    const localDocument = await authStore.getDocument(dataAccount, logisticsUserConfigKey(account));
    localItems = annotateLogisticsSource(normalizeLogisticsItems(localDocument && localDocument.payload), 'local', dataAccount.tenantId)
      .map(item => ({ ...item, active: false }));
  }
  const overriddenProviders = new Set(tenantItems.filter(item => item.active).map(item => item.provider));
  const officialIds = new Set(officialItems.map(item => item.id));
  tenantItems = tenantItems.filter(item => !officialIds.has(item.id));
  officialItems = officialItems.map(item => overriddenProviders.has(item.provider) ? { ...item, officialActive: item.active, active: false } : item);
  return {
    officialAccount,
    officialItems,
    tenantItems,
    localItems,
    effectiveItems: officialItems.concat(tenantItems),
    activeItems: officialItems.concat(tenantItems).filter(item => item.active)
  };
}

function normalizeLogisticsItems(payload, preserveActive = false) {
  return selectPreferredVersions((Array.isArray(payload) ? payload : []).filter(Boolean).map(item => ({
    ...item,
    sourceUpdatedAt: item.officialDateEvidence === 'workbook_cell' ? item.parsedSourceUpdatedAt || null : null,
    rules: (Array.isArray(item.rules) ? item.rules : []).map(rule => ({
      ...rule,
      scheme: rule.scheme || 'rFBS',
      market: rule.market || (rule.group === 'HK' ? '中国香港' : '俄罗斯'),
      transportMode: rule.transportMode || logisticsTransportMode(rule.transport, rule.channel)
    })),
    schemes: Array.isArray(item.schemes) ? item.schemes : Array.from(new Set((item.rules || []).map(rule => rule.scheme || 'rFBS'))),
    markets: Array.isArray(item.markets) ? item.markets : Array.from(new Set((item.rules || []).map(rule => rule.market || (rule.group === 'HK' ? '中国香港' : '俄罗斯'))))
  })), preserveActive);
}

function logisticsStoredFile(tenantId, item) {
  const tenantFolder = path.join(LOGISTICS_TARIFF_DIR, String(tenantId));
  const relative = String(item && (item.storedRelativePath || item.storedName) || '');
  const file = path.resolve(tenantFolder, relative);
  return pathInside(tenantFolder, file) ? file : '';
}

function privateObjectFile(object) {
  if (!object || !object.object_key) return '';
  const file = path.resolve(PRIVATE_OBJECT_DIR, ...String(object.object_key).split('/'));
  return pathInside(PRIVATE_OBJECT_DIR, file) ? file : '';
}

function readTenantJson(tenantId, key) {
  const file = tenantDataFile(tenantId, key);
  if (!fs.existsSync(file)) return null;
  return parseJsonStrict(fs.readFileSync(file, 'utf8'));
}

function itemMatchesShop(item, shops) {
  if (!item || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(shops)) return false;
  // A historical name is not a shop identity, even if it matches an authorized shop.
  const ids = [item.clientId, item.externalShopId]
    .filter(id => id !== null && id !== undefined && String(id).trim() !== '')
    .map(id => String(id).trim());
  if (!ids.length || ids.some(id => id !== ids[0])) return false;
  return shops.some(shop => shop && shop.externalShopId !== null && shop.externalShopId !== undefined
    && String(shop.externalShopId).trim() === ids[0]);
}

function projectedIdentity(source, legacyLabel) {
  if (!source && (legacyLabel === '系统管理员' || legacyLabel === '系统同步')) {
    return { kind: 'system_admin', raw: legacyLabel, masked: legacyLabel };
  }
  const identity = identityDisplay.displayIdentity(source || {});
  return identity.kind === 'unknown' ? { kind: 'unknown', raw: '', masked: '历史未记录' } : identity;
}

function businessIdentityUserIds(key, data) {
  if (!Array.isArray(data)) return [];
  const ids = new Set();
  const add = value => { const id = String(value || '').trim(); if (/^\d+$/.test(id)) ids.add(id); };
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (AUDITED_KEYS.has(key)) {
      add(item.lastOperatorUserId);
      for (const entry of Array.isArray(item.changeLog) ? item.changeLog : []) add(entry && entry.userId);
    } else if (key === 'erp_collected_products') add(item.collectedByUserId);
    else if (key === 'erp_favorite_products') add(item.favoritedByUserId);
    else if (key === 'erp_bug_reports') add(item.createdByUserId);
  }
  return [...ids];
}

async function projectBusinessIdentityDisplay(key, data, account) {
  const supported = AUDITED_KEYS.has(key) || ['erp_collected_products', 'erp_favorite_products', 'erp_bug_reports'].includes(key);
  if (!supported || !Array.isArray(data)) return data;
  const directory = await authStore.displayIdentitiesByUserId(account && account.tenantId, businessIdentityUserIds(key, data));
  const identityFor = (userId, legacyLabel) => projectedIdentity(directory[String(userId || '')], legacyLabel);
  return data.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const safe = { ...item };
    if (AUDITED_KEYS.has(key)) {
      if (Array.isArray(safe.changeLog)) safe.changeLog = safe.changeLog.map(entry => {
        const next = { ...(entry || {}) };
        next.operatorIdentity = identityFor(next.userId, next.username);
        delete next.username;
        return next;
      });
      safe.lastOperatorIdentity = identityFor(safe.lastOperatorUserId, safe.lastOperator);
      delete safe.lastOperator;
    } else if (key === 'erp_collected_products') {
      safe.collectedByIdentity = identityFor(safe.collectedByUserId, safe.collectedBy);
      delete safe.collectedBy;
    } else if (key === 'erp_favorite_products') {
      safe.favoritedByIdentity = identityFor(safe.favoritedByUserId, safe.favoritedBy);
      delete safe.favoritedBy;
    } else if (key === 'erp_bug_reports') {
      safe.createdByIdentity = identityFor(safe.createdByUserId, safe.createdBy);
      delete safe.createdBy;
    }
    return safe;
  });
}


function filterShopScopedData(key, data, shops, account) {
  // Non-array historical payloads cannot be row-authorized: fail closed for scoped users.
  if (!Array.isArray(data)) {
    if (shops !== null && ['erp_shops_data', 'erp_shop_groups', 'erp_orders_data', 'erp_online_products'].includes(key)) return [];
    return data;
  }
  data = filterEntityAuditVisibility(key, data, account);
  if (key === productCreate.DRAFT_KEY) {
    const actorUserId = Number(account && account.userId) || 0;
    return actorUserId ? data.filter(item => item && Number(item.ownerUserId) === actorUserId) : [];
  }
  if (key === 'erp_shops_data') {
    const visible = shops === null ? data : data.filter(item => itemMatchesShop(item, shops));
    return visible.map(item => {
      const safe = { ...item };
      safe.credentialsConfigured = Boolean(safe.apiKey || safe.apiSecret || safe.secret || safe.token);
      safe.performanceCredentialsConfigured = Boolean(safe.performanceClientId && safe.performanceClientSecret);
      delete safe.apiKey;
      delete safe.apiSecret;
      delete safe.secret;
      delete safe.token;
      delete safe.performanceClientSecret;
      delete safe.sellerCookies;
      return safe;
    });
  }
  if (key === 'erp_shop_groups' && shops !== null) {
    const allowed = new Set(shops.flatMap(shop => [shop.id, shop.externalShopId]).filter(id => id !== null && id !== undefined && String(id).trim() !== '').map(id => String(id).trim()));
    return data.map(item => ({
      ...item,
      shopIds: (Array.isArray(item && item.shopIds) ? item.shopIds : []).filter(id => allowed.has(String(id)))
    })).filter(item => item.shopIds.length);
  }
  if (!['erp_orders_data', 'erp_online_products'].includes(key) || shops === null) return data;
  return data.filter(item => itemMatchesShop(item, shops));
}

function mergeShopCredentialInput(incoming, existing) {
  if (!Array.isArray(incoming)) return incoming;
  const previousById = new Map((Array.isArray(existing) ? existing : []).map(item => [String(item && (item.clientId || item.externalShopId) || ''), item]));
  const sellerFields = ['apiKey', 'apiSecret', 'secret', 'token'];
  const fields = sellerFields.concat(['performanceClientSecret']);
  return incoming.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const merged = { ...item };
    delete merged.credentialsConfigured;
    delete merged.performanceCredentialsConfigured;
    const previous = previousById.get(String(item.clientId || item.externalShopId || ''));
    const sellerCredentialUpdated = sellerFields.some(field => typeof item[field] === 'string' && item[field].trim().length > 0);
    if (sellerCredentialUpdated && previous && previous.apiHealth && previous.apiHealth.status === 'abnormal') {
      merged.status = previous.apiHealth.previousStatus && previous.apiHealth.previousStatus !== '异常' ? previous.apiHealth.previousStatus : '正常';
      merged.apiHealth = { status: 'normal', blockingSync: false, code: '', messageZh: '', originalMessage: '', message: '', checkedAt: null, source: 'credential_updated', previousStatus: merged.status };
    }
    delete merged.sellerCookies;
    delete merged.sellerCookieAuthorization;
    merged.cookie = previous && previous.cookie === '已授权' ? '已授权' : '未授权';
    if (previous && Array.isArray(previous.sellerCookies) && previous.sellerCookies.length) merged.sellerCookies = previous.sellerCookies;
    if (previous && previous.sellerCookieAuthorization) merged.sellerCookieAuthorization = previous.sellerCookieAuthorization;
    for (const field of fields) {
      if ((!merged[field] || typeof merged[field] !== 'string') && previous && typeof previous[field] === 'string' && previous[field]) {
        merged[field] = previous[field];
      }
    }
    return merged;
  });
}

function normalizeSellerCookies(input) {
  if (!Array.isArray(input) || !input.length || input.length > 200) return null;
  let total = 0;
  const cookies = [];
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const name = String(item.name || '');
    const value = String(item.value || '');
    const domain = String(item.domain || '').toLowerCase();
    const cookiePath = String(item.path || '/');
    if (!name || name.length > 256 || value.length > 8192 || domain.length > 255 || cookiePath.length > 1024) return null;
    if (!/(^|\.)ozon\.ru$/.test(domain.replace(/^\./, ''))) return null;
    total += name.length + value.length + domain.length + cookiePath.length;
    if (total > 384 * 1024) return null;
    const cookie = { name, value, domain, path: cookiePath, secure: item.secure === true, httpOnly: item.httpOnly === true, session: item.session === true, hostOnly: item.hostOnly === true, sameSite: ['no_restriction', 'lax', 'strict', 'unspecified'].includes(String(item.sameSite)) ? String(item.sameSite) : 'unspecified' };
    if (Number.isFinite(Number(item.expirationDate))) cookie.expirationDate = Number(item.expirationDate);
    const topLevelSite = String(item.partitionKey && item.partitionKey.topLevelSite || '');
    if (/^https:\/\/(?:www\.)?ozon\.ru\/?$/.test(topLevelSite)) cookie.partitionKey = { topLevelSite };
    cookies.push(cookie);
  }
  return cookies;
}

function isValidShopCredentialInput(data) {
  if (!Array.isArray(data) || data.length > 100) return false;
  const secretFields = ['apiKey', 'apiSecret', 'secret', 'token', 'performanceClientSecret'];
  return data.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const clientId = String(item.clientId || item.externalShopId || '').trim();
    if (!clientId || clientId.length > 120) return false;
    if ('performanceClientId' in item && (typeof item.performanceClientId !== 'string' || item.performanceClientId.length > 240)) return false;
    const performanceClientId = String(item.performanceClientId || '').trim();
    if (performanceClientId.length > 320) return false;
    return secretFields.every(field => !(field in item) || (typeof item[field] === 'string' && item[field].length <= 4096));
  });
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!key) return;
    try { out[key] = decodeURIComponent(value); } catch (e) { out[key] = ''; }
  });
  return out;
}

function sessionCookie(token) {
  return SESSION_COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax' + (SECURE_COOKIE ? '; Secure' : '');
}

function deviceCookie(value) {
  return DEVICE_COOKIE + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000' + (SECURE_COOKIE ? '; Secure' : '');
}

function requestDeviceId(req) {
  const value = String(parseCookies(req)[DEVICE_COOKIE] || '');
  return /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : '';
}

function ensureRequestDeviceId(req) {
  return requestDeviceId(req) || crypto.randomBytes(32).toString('hex');
}

function clearSessionCookie() {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (SECURE_COOKIE ? '; Secure' : '');
}

async function authenticate(req) {
  const token = parseCookies(req)[SESSION_COOKIE] || '';
  if (!token) return null;
  const account = await authStore.authenticate(token);
  if (!account) return null;
  req.erpAuth = account;
  if (userSecurityMonitor && !account.isSystemAdmin) {
    userSecurityMonitor.noteRequest(account, { ip: clientAddress(req), deviceId: requestDeviceId(req) });
  }
  return account;
}

async function revokeSession(req) {
  if (req.erpAuth) await authStore.revokeSession(req.erpAuth.sessionId);
}

function cleanupExpiredSessions() {
  authStore.cleanupExpiredSessions().catch(error => console.error('清理过期会话失败:', error.message));
}

let membershipSchemaWarningShown = false;
function expireUnusedActivationCodes() {
  authStore.expireUnusedActivationCodes().then(() => {
    membershipSchemaWarningShown = false;
  }).catch(error => {
    if (persistentQueueSchemaMissing(error)) {
      if (!membershipSchemaWarningShown) console.warn('会员迁移 023 尚未应用，已跳过激活码自动作废任务。');
      membershipSchemaWarningShown = true;
      return;
    }
    console.error('自动作废过期激活码失败:', error.message);
  });
}

function reconcileMembershipPeriods() {
  authStore.reconcileMembershipPeriods().catch(error => {
    if (persistentQueueSchemaMissing(error)) return;
    console.error('会员权益时间段推进失败:', error.message);
  });
}

let agentSalesSchemaWarningShown = false;
function reconcileAgentMonthlySales() {
  authStore.reconcileAgentMonthlySales().then(() => {
    agentSalesSchemaWarningShown = false;
  }).catch(error => {
    if (persistentQueueSchemaMissing(error)) {
      if (!agentSalesSchemaWarningShown) console.warn('会员迁移 023 尚未应用，已跳过代理商月度销量核对。');
      agentSalesSchemaWarningShown = true;
      return;
    }
    console.error('代理商月度销量核对失败:', error.message);
  });
}

let agentFinancialSchemaWarningShown = false;
function reconcileAgentFinancialControls() {
  authStore.reconcileAgentDefaultBatches().then(() => {
    agentFinancialSchemaWarningShown = false;
  }).catch(error => {
    if (persistentQueueSchemaMissing(error)) {
      if (!agentFinancialSchemaWarningShown) console.warn('会员迁移 023 尚未应用，已跳过代理商逾期批次和保证金期限核对。');
      agentFinancialSchemaWarningShown = true;
      return;
    }
    console.error('代理商逾期批次和保证金期限核对失败:', error.message);
  });
}

function sellerCookieBindingKey(tenantId, clientId) { return String(tenantId) + '|' + String(clientId); }
function clientOrderStorageScope(account) {
  return crypto.createHash('sha256').update(String(account?.tenantId || '') + '\u0000' + String(account?.userId || '')).digest('hex');
}
function cleanupSellerCookieBindings() {
  const now = Date.now();
  for (const [key, binding] of sellerCookieBindings) if (!binding || binding.expiresAt <= now) sellerCookieBindings.delete(key);
}
function hasVerifiedSellerCookieBinding(tenantId, clientId) {
  cleanupSellerCookieBindings();
  return sellerCookieBindings.has(sellerCookieBindingKey(tenantId, clientId));
}

let productDraftCleanupRunning = false;
async function cleanupExpiredProductDrafts() {
  if (productDraftCleanupRunning) return;
  productDraftCleanupRunning = true;
  try {
    const result = await authStore.cleanupExpiredProductCreateDrafts();
    if (result && result.removedDrafts) {
      console.log('[product-draft] 自动清理过期草稿:', result.removedDrafts, '条；租户:', result.changedTenants);
    }
  } catch (error) {
    console.error('清理过期商品草稿失败:', error.message);
  } finally {
    productDraftCleanupRunning = false;
  }
}

function cleanupBackgroundJobs() {
  authStore.cleanupBackgroundJobs().catch(error => console.error('清理过期后台任务失败:', error.message));
}

let skuAiCandidateCleanupRunning = false;
async function cleanupStaleSkuAiCandidates() {
  if (skuAiCandidateCleanupRunning) return;
  skuAiCandidateCleanupRunning = true;
  let claimed = 0, deleted = 0, deletedFiles = 0, freedBytes = 0, fileFailures = 0, restored = 0;
  try {
    for (let batch = 0; batch < 20; batch += 1) {
      const result = await authStore.claimStaleAiCandidates({ retentionDays: 3, limit: 200 });
      claimed += Number(result && result.claimed) || 0;
      for (const item of (result && result.items) || []) {
        try {
          const previewInUse = item.previewObjectKey ? await authStore.skuImagePreviewObjectKeyInUse(item.previewObjectKey, item.id) : false;
          const finalized = await authStore.finalizeStaleAiCandidate(item);
          if (!finalized) { await authStore.restoreStaleAiCandidate(item).catch(() => {}); restored += 1; continue; }
          deleted += 1;
          try { await privateObjectStore.deleteEncryptedBuffer(item.objectKey); deletedFiles += 1; freedBytes += Number(item.sizeBytes) || 0; }
          catch (error) { fileFailures += 1; console.error('清理AI候选私有文件失败:', item.objectKey, error.message); }
          if (item.previewObjectKey && !previewInUse) {
            try { await privateObjectStore.deleteEncryptedBuffer(item.previewObjectKey); deletedFiles += 1; }
            catch (error) { fileFailures += 1; console.error('清理AI候选预览缓存失败:', item.previewObjectKey, error.message); }
          }
        } catch (error) {
          await authStore.restoreStaleAiCandidate(item).catch(() => {});
          restored += 1;
          console.error('清理AI候选失败，已恢复候选状态:', item.id, error.message);
        }
      }
      if (!result || result.claimed < 200) break;
    }
    if (claimed || fileFailures || restored) console.log(`[sku-image] AI候选自动清理：领取 ${claimed} 条，删除候选 ${deleted} 条，删除私有文件 ${deletedFiles} 个，释放约 ${freedBytes} 字节${restored ? `，恢复待重试 ${restored} 条` : ''}${fileFailures ? `，文件删除失败 ${fileFailures} 个` : ''}`);
  } catch (error) {
    console.error('AI生图记录自动清理失败:', error.message);
  } finally {
    skuAiCandidateCleanupRunning = false;
  }
}

// 用户可见文字强制中文：拦截点当场写中文句子，代号只进 error 机器字段与日志。
function userErrorText(error, fallback) {
  const text = String((error && error.message) || '');
  return /[\u3400-\u9fff]/.test(text) ? text.slice(0, 300) : fallback;
}

const SKU_IMAGE_REDRAW_TEMPLATE_KEYS = new Set(['image-main', 'image-scene', 'image-selling', 'image-accessory', 'image-white-base', 'image-size']);

function skuVariantMatchesRef(variant, variantRef) {
  const expected = String(variantRef || '').trim();
  if (!expected || !variant || typeof variant !== 'object') return false;
  return [variant.offerId, variant.offer_id, variant.article, variant.sku]
    .map(value => String(value || '').trim()).filter(Boolean).includes(expected);
}
function skuVariantPlatformUrls(variant) {
  const urls = [];
  const append = value => {
    if (value && typeof value === 'object') value = value.file_name_url || value.url || value.src || value.big_url;
    const url = String(value || '').trim();
    if (/^https:\/\//i.test(url) && !urls.includes(url)) urls.push(url);
  };
  [variant?.image, variant?.primary_image, variant?.img].forEach(append);
  (Array.isArray(variant?.images) ? variant.images : []).forEach(append);
  return urls.slice(0, 30);
}
async function resolveOnlineSkuSnapshotSource(account, raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const target = { clientId: String(input.clientId || ''), productId: String(input.productId || ''), variantRef: String(input.variantRef || '') };
  const sourceVariantIndex = Number(input.sourceVariantIndex), sourceIndex = Number(input.sourceId);
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(target.clientId) || !/^(?:\d+|draft_[\w-]+)$/.test(target.productId)
    || !/^[A-Za-z0-9._:-]{1,180}$/.test(target.variantRef) || !Number.isInteger(sourceVariantIndex) || sourceVariantIndex < 0 || sourceVariantIndex > 99
    || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex > 29) {
    throw Object.assign(new Error('平台快照来源参数不完整，请重新打开图片编辑后再试。'), { publicCode: 'invalid_sku_image_snapshot_source', status: 400 });
  }
  await authStore.assertSkuImageTarget(account, target);
  const holder = /^draft_/.test(target.productId)
    ? await authStore.getProductCreateDraft(account, target.productId)
    : await authStore.getEditableProduct(account, { clientId: target.clientId, productId: target.productId });
  const product = holder && holder.item;
  const variants = Array.isArray(product?.variants) && product.variants.length ? product.variants : [product];
  const variant = variants[sourceVariantIndex];
  if (!variant || !skuVariantMatchesRef(variant, target.variantRef)) {
    throw Object.assign(new Error('平台图片对应的SKU已经变化，请重新打开图片编辑后再试。'), { publicCode: 'sku_image_snapshot_source_changed', status: 409 });
  }
  const urls = skuVariantPlatformUrls(variant);
  const sourceUrl = urls[sourceIndex];
  if (!sourceUrl || String(input.sourceUrl || '') !== sourceUrl) {
    throw Object.assign(new Error('平台图片来源已经变化，请重新打开图片编辑后再试。'), { publicCode: 'sku_image_snapshot_source_changed', status: 409 });
  }
  return { ...target, sourceType: 'online', sourceVariantIndex, sourceIndex, sourceUrl, sourceRef: 'online:' + sourceVariantIndex + ':' + sourceIndex };
}
async function prepareSkuAiSource(account, raw, options = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const linked = UUID_PATTERN.test(String(input.linkId || '')) && Number.isInteger(Number(input.associationVersion));
  if (linked) {
    const scoped = { clientId: String(input.clientId), productId: String(input.productId), variantRef: String(input.variantRef), linkId: String(input.linkId), associationVersion: Number(input.associationVersion) };
    await authStore.assertSkuImageTarget(account, scoped);
    const source = await authStore.getSkuImageVersionSource(account, scoped);
    return { scoped, source, sourceKind: 'linked', sourceRef: 'link:' + scoped.linkId + ':' + scoped.associationVersion };
  }
  if (String(input.sourceType || '') !== 'online') {
    throw Object.assign(new Error('AI图片来源不完整，请重新选择图片后再试。'), { publicCode: 'invalid_sku_image_ai_source', status: 400 });
  }
  const resolved = await resolveOnlineSkuSnapshotSource(account, input);
  const cacheKey = [resolved.clientId, resolved.productId, resolved.variantRef, resolved.sourceRef, skuImageAnalysisProof.digest(resolved.sourceUrl)].join('|');
  let pending = options.sourceCache instanceof Map ? options.sourceCache.get(cacheKey) : null;
  if (!pending) {
    pending = (async () => {
      const downloaded = await downloadExternalImage(resolved.sourceUrl, 0);
      const processed = await skuImageUpload.processImage({ body: downloaded.buffer, contentType: downloaded.contentType, name: 'snapshot' + downloaded.extension });
      const stored = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image_ai_source', body: processed.body });
      return {
        private_object_key: stored.objectKey,
        sha256: processed.sha256 || stored.sha256,
        size_bytes: processed.sizeBytes || stored.size,
        mime_type: processed.mimeType,
        extension: processed.extension,
        width: processed.width,
        height: processed.height
      };
    })();
    if (options.sourceCache instanceof Map) options.sourceCache.set(cacheKey, pending);
  }
  const source = await pending;
  return {
    scoped: { clientId: resolved.clientId, productId: resolved.productId, variantRef: resolved.variantRef, linkId: '', associationVersion: null },
    source,
    sourceKind: 'platform_snapshot',
    sourceRef: resolved.sourceRef,
    sourceObject: { objectKey: source.private_object_key, sha256: source.sha256, sizeBytes: Number(source.size_bytes), mimeType: source.mime_type }
  };
}

async function resolveSkuCombinationReferenceObjects(account, raw, options = {}) {
  const target = { clientId: String(raw && raw.clientId || ''), productId: String(raw && raw.productId || ''), variantRef: String(raw && raw.variantRef || '') };
  const holder = /^draft_/.test(target.productId)
    ? await authStore.getProductCreateDraft(account, target.productId)
    : await authStore.getEditableProduct(account, { clientId: target.clientId, productId: target.productId });
  const product = holder && holder.item;
  if (!product) return [];
  const variants = Array.isArray(product.variants) && product.variants.length ? product.variants : [product];
  const variant = variants.find(item => skuVariantMatchesRef(item, target.variantRef));
  if (!variant) return [];
  const hasLocalLinks = Array.isArray(variant.sourceBundleIds) && variant.sourceBundleIds.length;
  const erpVariantRef = String(variant.erpVariantRef || '').trim();
  if (!hasLocalLinks && !erpVariantRef) return [];
  const [graph, collectionDocument] = await Promise.all([
    productCombinationGraph.read(authStore, account),
    authStore.getDocument(account, 'erp_collected_products')
  ]);
  const urls = productCombinationAi.resolveReferenceUrls({
    product, variant,
    relations: graph && graph.payload && graph.payload.relations || [],
    aliases: graph && graph.payload && graph.payload.aliases || [],
    collections: collectionDocument && Array.isArray(collectionDocument.payload) ? collectionDocument.payload : [],
    maxReferences: 7
  });
  if (!urls.length) return [];
  const cache = options.referenceCache instanceof Map ? options.referenceCache : null;
  const objects = [];
  for (const url of urls) {
    const cacheKey = 'combo:' + skuImageAnalysisProof.digest(url);
    let pending = cache && cache.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        const downloaded = await downloadExternalImage(url, 0);
        const processed = await skuImageUpload.processImage({ body: downloaded.buffer, contentType: downloaded.contentType, name: 'combination-reference' + downloaded.extension });
        const stored = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image_ai_combination_reference', body: processed.body });
        return { objectKey: stored.objectKey, sha256: processed.sha256 || stored.sha256, sizeBytes: processed.sizeBytes || stored.size, mimeType: processed.mimeType };
      })();
      if (cache) cache.set(cacheKey, pending);
    }
    objects.push(await pending);
  }
  return objects.slice(0, 7);
}

// 浏览器只提交目标、模板标识和卖点；来源、版本、模板正文及全部摘要均在服务端重新读取。
async function buildTrustedSkuImageRedrawTask(account, input, options = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const capability = String(raw.capability || 'image-redraw');
  const billingChannel = String(raw.billingChannel || 'official');
  const templateKey = String(raw.templateKey || '');
  const invalid = capability !== 'image-redraw' || billingChannel !== 'official' || !SKU_IMAGE_REDRAW_TEMPLATE_KEYS.has(templateKey)
    || !/^[A-Za-z0-9._-]{1,120}$/.test(String(raw.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(raw.productId))
    || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(raw.variantRef));
  if (invalid) throw Object.assign(new Error('AI重绘模板或图片来源不正确，请刷新后重新选择。'), { publicCode: 'invalid_sku_image_ai_request', status: 400 });

  const preparedSource = await prepareSkuAiSource(account, raw, options);
  const scoped = preparedSource.scoped;
  const productScope = { clientId: scoped.clientId, productId: scoped.productId, variantRef: scoped.variantRef };
  const source = preparedSource.source;
  const sourceHash = String(source.sha256);
  const referenceObjects = await resolveSkuCombinationReferenceObjects(account, scoped, options);
  const referenceHash = skuImageAnalysisProof.digest(JSON.stringify(referenceObjects.map(item => [item.sha256, item.sizeBytes, item.mimeType])));
  const sellingPoints = String(options.sellingPoints === undefined ? raw.sellingPoints || '' : options.sellingPoints).trim();
  if (!sellingPoints || sellingPoints.length > 5000) throw Object.assign(new Error('请填写不超过5000字的卖点后再开始生图。'), { publicCode: 'invalid_sku_image_selling_points', status: 400 });
  const imageTextLanguage = skuSellingPointsLanguage.normalizeLanguage(options.imageTextLanguage === undefined ? raw.imageTextLanguage || 'ru' : options.imageTextLanguage);
  const imageSellingPoints = skuSellingPointsLanguage.select(sellingPoints, imageTextLanguage).text;
  const requestedSource = options.sellingPointsSource === undefined ? (raw.sellingPointsSource === undefined ? '' : String(raw.sellingPointsSource)) : String(options.sellingPointsSource);
  if (requestedSource && !['ai', 'manual'].includes(requestedSource)) throw Object.assign(new Error('请选择卖点的来源后再提交。'), { publicCode: 'invalid_sku_image_selling_points_source', status: 400 });
  if (options.requireManualSellingPoints && requestedSource !== 'manual') throw Object.assign(new Error('批量重绘请使用已确认的手动卖点后再开始。'), { publicCode: 'sku_image_batch_manual_selling_points_required', status: 400 });
  let sellingPointsSource = requestedSource || 'ai';
  let proof = sellingPointsSource === 'ai' ? skuImageAnalysisProof.verify(raw.analysisProof, account, productScope, CSRF_SECRET_CONFIG.secret) : null;
  if (sellingPointsSource === 'ai' && (!proof || String(proof.resultHash) !== skuImageAnalysisProof.digest(sellingPoints))) {
    if (requestedSource === 'ai') throw Object.assign(new Error('AI卖点证明无效或卖点已编辑，请改为手动卖点后再开始生图。'), { publicCode: 'sku_redraw_analysis_required', status: 409 });
    sellingPointsSource = 'manual';
  }
  if (sellingPointsSource === 'ai') {
    const sellingPointRules = await aiProductRuleStore.effective('sellingPoints', { requireGlobal: true, includeMetadata: true });
    const sellingPointRuleHash = skuImageAnalysisProof.digest(JSON.stringify({ global: skuImageAnalysisProof.digest(sellingPointRules.global), sellingPoints: skuImageAnalysisProof.digest(sellingPointRules.item), versions: sellingPointRules.versions }));
    if (String(proof.ruleHash || '') !== sellingPointRuleHash) throw Object.assign(new Error('卖点规则已变更，请重新解析或改为手动卖点后再开始生图。'), { publicCode: 'sku_redraw_analysis_required', status: 409 });
  }
  const configuration = options.configuration || await aiConfigStore.availableOfficial(account, ['image-redraw']);
  const customizationAllowed = options.customizationAllowed === undefined ? (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account)) : options.customizationAllowed;
  const promptCacheKey = templateKey + '|' + (customizationAllowed ? 'custom' : 'official');
  let promptBody;
  if (options.promptBodies instanceof Map && options.promptBodies.has(promptCacheKey)) promptBody = await options.promptBodies.get(promptCacheKey);
  else {
    const pendingPrompt = aiPromptStore.effective(account, templateKey, { officialOnly: !customizationAllowed });
    if (options.promptBodies instanceof Map) options.promptBodies.set(promptCacheKey, pendingPrompt);
    promptBody = await pendingPrompt;
  }
  requireSkuImagePromptReady(promptBody);
  const promptHash = skuImageAnalysisProof.digest(promptBody);
  const sellingPointResultHash = skuImageAnalysisProof.digest(sellingPoints);
  const imageSellingPointHash = skuImageAnalysisProof.digest(imageSellingPoints);
  const fingerprint = skuImageAnalysisProof.digest([account.tenantId, account.userId, scoped.clientId, scoped.productId, scoped.variantRef, preparedSource.sourceRef, sourceHash, referenceHash, templateKey, promptHash, sellingPointsSource, sellingPointResultHash, imageTextLanguage, imageSellingPointHash].join('|'));
  return {
    fingerprint,
    requestHash: skuImageAnalysisProof.digest(JSON.stringify({ fingerprint, billingChannel: 'official', capability: 'image-redraw', imageTextLanguage })),
    context: { ...scoped, capability: 'image-redraw', sourceKind: preparedSource.sourceKind, sourceRef: preparedSource.sourceRef, sourceObject: preparedSource.sourceObject || null, sourceHash, referenceObjects, referenceHash, promptHash, sellingPointResultHash, imageSellingPointHash, imageTextLanguage, sellingPoints: imageSellingPoints, sellingPointsSource, sellingPointSourceHash: sellingPointResultHash, configurationId: String(configuration.id), templateKey, billingChannel: 'official' },
    snapshotFactory: async taskId => ({
      template: await skuImagePromptSnapshot.save(privateObjectStore, account.tenantId, taskId, 'template', promptBody),
      sellingPoints: await skuImagePromptSnapshot.save(privateObjectStore, account.tenantId, taskId, 'selling_points', imageSellingPoints),
      rawResponse: null, finalPrompt: null
    })
  };
}

function activationCodeSecretObjectKey(tenantId, digest) {
  const safeTenantId = String(tenantId || '');
  const safeDigest = String(digest || '').toLowerCase();
  if (!/^\d+$/.test(safeTenantId) || !/^[a-f0-9]{64}$/.test(safeDigest)) return '';
  return safeTenantId + '/activation_code_secret/' + safeDigest.slice(0, 2) + '/' + safeDigest + '.enc';
}

async function storeActivationCodeSecret(tenantId, generatedCode) {
  if (!privateObjectStore.encryptionAvailable()) throw Object.assign(new Error('完整激活码加密存储尚未就绪，请联系管理员检查私有对象密钥。'), { publicCode: 'activation_code_secret_storage_unavailable', status: 503 });
  const body = Buffer.from(String(generatedCode.code || ''), 'utf8');
  const stored = await privateObjectStore.putEncryptedBuffer({ tenantId, kind: 'activation_code_secret', body });
  if (stored.sha256 !== generatedCode.digest) throw Object.assign(new Error('完整激活码加密存储校验失败，请重新生成。'), { publicCode: 'activation_code_secret_integrity_failed', status: 500 });
  return stored.objectKey;
}

async function revealActivationCodeForSystemAdmin(item) {
  const safe = { ...item };
  const ref = safe.adminSecretRef || null;
  delete safe.adminSecretRef;
  delete safe.codeMask;
  if (!ref) return { ...safe, code: null, codeAvailability: 'legacy_unavailable' };
  if (!privateObjectStore.encryptionAvailable()) return { ...safe, code: null, codeAvailability: 'encryption_unavailable' };
  const objectKey = activationCodeSecretObjectKey(ref.tenantId, ref.digest);
  if (!objectKey) return { ...safe, code: null, codeAvailability: 'legacy_unavailable' };
  try {
    const body = await privateObjectStore.readEncryptedBuffer(objectKey);
    const code = body.toString('utf8');
    const digest = crypto.createHash('sha256').update(code).digest('hex');
    if (digest !== String(ref.digest).toLowerCase() || !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}(?:-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}){5}$/.test(code)) {
      throw Object.assign(new Error('管理员完整激活码存储校验失败，请联系系统管理员检查私有对象。'), { publicCode: 'activation_code_secret_integrity_failed' });
    }
    return { ...safe, code, codeAvailability: 'available' };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ...safe, code: null, codeAvailability: 'legacy_unavailable' };
    throw error;
  }
}

async function revealActivationCodesForSystemAdmin(payload) {
  const items = await Promise.all((payload.items || []).map(revealActivationCodeForSystemAdmin));
  return { ...payload, items };
}

// 兜底门禁：任何带 error 的响应都必须带中文 message，未写中文一律落回通用中文，绝不把英文代号甩给用户。
function ensureChineseMessage(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !('error' in payload)) return payload;
  const message = String(payload.message || '');
  if (/[\u3400-\u9fff]/.test(message)) return payload;
  const error = String(payload.error || '');
  return Object.assign({}, payload, {
    message: /[\u3400-\u9fff]/.test(error) ? error : '本次操作未完成，请稍后重试；若持续失败请联系系统管理员。'
  });
}

function sendJson(res, code, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(ensureChineseMessage(payload)), 'utf8');
  res.writeHead(code, Object.assign(securityHeaders(), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {}));
  res.end(body);
}

function csvCell(value) {
  let text = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
  if (/^[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function sendCsv(res, filename, rows) {
  const body = '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  res.writeHead(200, Object.assign(securityHeaders(), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  }));
  res.end(body);
}

function sendRedirect(res, location) {
  res.writeHead(302, Object.assign(securityHeaders(), { Location: location, 'Cache-Control': 'no-store', 'Content-Length': '0' }));
  res.end();
}

function cspHash(value) {
  // HTML parsing normalizes CRLF/CR to LF before Chromium verifies inline
  // script/style hashes. Hash the browser-visible text, not raw file endings.
  const browserText = String(value).replace(/\r\n?/g, '\n');
  return `'sha256-${crypto.createHash('sha256').update(browserText, 'utf8').digest('base64')}'`;
}

function contentSecurityPolicy(html) {
  const source = Buffer.isBuffer(html) ? html.toString('utf8') : String(html || '');
  const scriptHashes = new Set();
  const styleHashes = new Set();
  const scriptAttributeHashes = new Set();
  const styleAttributeHashes = new Set();
  for (const match of source.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)) scriptHashes.add(cspHash(match[1]));
  for (const match of source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styleHashes.add(cspHash(match[1]));
  for (const match of source.matchAll(/\son[a-z]+\s*=\s*(["'])([\s\S]*?)\1/gi)) scriptAttributeHashes.add(cspHash(match[2]));
  for (const match of source.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) styleAttributeHashes.add(cspHash(match[2]));
  const scripts = ["'self'", ...scriptHashes];
  const styles = ["'self'", ...styleHashes];
  const scriptAttrs = scriptAttributeHashes.size ? ["'unsafe-hashes'", ...scriptAttributeHashes] : ["'none'"];
  const styleAttrs = styleAttributeHashes.size ? ["'unsafe-hashes'", ...styleAttributeHashes] : ["'none'"];
  return `default-src 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'; script-src ${scripts.join(' ')}; script-src-attr ${scriptAttrs.join(' ')}; style-src ${styles.join(' ')}; style-src-attr ${styleAttrs.join(' ')}; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self'; font-src 'self' data:; form-action 'self'`;
}

function securityHeaders(html) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Content-Security-Policy': contentSecurityPolicy(html)
  };
  if (SECURE_COOKIE) headers['Strict-Transport-Security'] = 'max-age=31536000';
  return headers;
}

function expectedOrigin(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  return 'http://' + String(req.headers.host || (HOST + ':' + PORT));
}

function requireAllowedOrigin(req, res, message) {
  const origin = String(req.headers.origin || '');
  if (!origin && !IS_PRODUCTION) return true;
  if (origin === expectedOrigin(req)) return true;
  sendJson(res, 403, message ? { error: 'origin_forbidden', message } : { error: 'origin_forbidden' });
  return false;
}

function requireCsrf(req, res, messages) {
  if (!requireAllowedOrigin(req, res, messages && messages.origin)) return false;
  const supplied = String(req.headers['x-csrf-token'] || '');
  if (authStore.verifyCsrf(req.erpAuth, supplied)) return true;
  sendJson(res, 403, messages && messages.csrf ? { error: 'csrf_invalid', message: messages.csrf } : { error: 'csrf_invalid' });
  return false;
}

function clientAddress(req) {
  const direct = socketAddress(req);
  const trustProxy = process.env.ERP_TRUST_PROXY === '1';
  if (IS_PRODUCTION && !trustProxy && isLoopbackAddress(direct) && !warnedUntrustedLoopbackProxy) {
    warnedUntrustedLoopbackProxy = true;
    console.warn('检测到生产请求经回环地址转发，但未启用 ERP_TRUST_PROXY=1；设备、安全和限流将记录回环地址。仅在同机 Nginx/Caddy 覆盖 X-Forwarded-For 后才可启用。');
  }
  return resolveClientAddress(req, trustProxy);
}

const dns = require('dns').promises;
// ── 外部图片下载统一配置与安全实现（SKU 图片/采集箱/Ozon/1688 外部图代理下载）──
const EXTERNAL_IMAGE_DOWNLOAD = {
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
  maxImages: 50,
  concurrency: 5,
  requestTimeoutMs: 12000,
  totalTimeoutMs: 120000
};
const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif']
]);
const externalDownloadWindows = new Map();
const EXTERNAL_DOWNLOAD_LIMIT = { windowMs: 60000, maximum: 10 };

// 私网/回环/链路本地/保留地址判定（IPv4 + IPv6 + 云 metadata 169.254.169.254）
function isPrivateIp(ip) {
  const host = String(ip || '').replace(/^::ffff:/, '').toLowerCase();
  if (host === '::1' || host === '127.0.0.1') return true;
  if (net.isIPv4(host)) {
    const p = host.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return true;
    if (p[0] === 169 && p[1] === 254) return true; // 含云 metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    if (p[0] >= 224) return true; // 组播与保留段
    return false;
  }
  if (net.isIPv6(host)) {
    if (host === '::' || host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true; // fe80::/10
    return false;
  }
  return true;
}
async function isSafeExternalImageHost(hostname) {
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(String(hostname || ''))) return false;
  try {
    const records = await dns.lookup(String(hostname), { all: true });
    if (!records || !records.length) return false;
    return records.every(r => !isPrivateIp(r.address));
  } catch (e) { return false; }
}
function isSafeExternalImageUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch (e) { return false; }
  if (url.protocol !== 'https:') return false;
  const host = String(url.hostname).toLowerCase();
  if (!host || host.length > 253 || host.includes(':')) return false; // 含 IPv6 字面量
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal')) return false;
  if (!host.includes('.')) return false;
  if (/^(0|10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false; // 裸 IPv4 一律拒绝（含回环/私网）
  return true;
}
// 文件头魔数检测：防 403 HTML 页/登录页/JSON 报错被当作图片保存
function detectImageType(buffer) {
  if (!buffer || buffer.length < 3) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp' && (buffer.toString('ascii', 8, 12) === 'avif' || buffer.toString('ascii', 8, 12) === 'avis')) return 'image/avif';
  return null;
}
function sanitizeFilename(name) {
  return String(name || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\.+$/g, '').trim().slice(0, 120);
}
function buildImageFilename(index, sku, extension) {
  const prefix = String(index + 1).padStart(3, '0');
  const safeSku = sanitizeFilename(sku || 'image') || 'image';
  return prefix + '_' + safeSku + extension;
}
// 并发池：单张失败不中断整批（单张异常统一记入结果）
async function mapWithConcurrency(items, limit, handler) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (true) {
      const current = index++;
      if (current >= items.length) return;
      try { results[current] = await handler(items[current], current); }
      catch (error) { results[current] = { ok: false, index: current, sourceUrl: String(items[current] || ''), error: (error && error.message) || '未知错误' }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
// 单张外部图安全下载：URL/SSRF → 手动 redirect（每跳重校验，最多 4 跳）→ HTTP → Content-Type → 流式限大小 → 文件头双验证
async function downloadExternalImage(raw, index) {
  if (!isSafeExternalImageUrl(raw)) throw new Error('远程地址不合法（仅允许公网 https 图片）');
  let currentUrl = new URL(String(raw));
  let resp = null;
  for (let hop = 0; hop <= 4; hop++) {
    if (!await isSafeExternalImageHost(currentUrl.hostname)) throw new Error('远程地址解析到不安全网络');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTERNAL_IMAGE_DOWNLOAD.requestTimeoutMs);
    try {
      resp = await fetch(currentUrl.toString(), { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } });
    } finally { clearTimeout(timer); }
    if (resp && resp.status >= 300 && resp.status < 400) {
      const location = String(resp.headers.get('location') || '').trim();
      if (!location) { const redirectProblem = new Error('图片地址跳转异常：对方响应里没有给出跳转目标，无法继续下载，请更换图片来源后重试。'); redirectProblem.status = resp.status; throw redirectProblem; }
      const next = new URL(location, currentUrl);
      if (next.protocol !== 'https:' || !isSafeExternalImageUrl(next.toString())) throw new Error('跳转目标不安全（仅允许公网 https）');
      currentUrl = next;
      continue;
    }
    break;
  }
  if (!resp || !resp.ok) throw new Error('HTTP ' + (resp ? resp.status : 0));
  const declaredType = String(resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(declaredType)) throw new Error('远程地址返回的不是有效图片（' + (declaredType || 'unknown') + '）');
  let total = 0;
  const chunks = [];
  if (resp.body && typeof resp.body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of resp.body) {
      total += chunk.length;
      if (total > EXTERNAL_IMAGE_DOWNLOAD.maxImageBytes) throw new Error('单张图片超过最大允许大小（8MB）');
      chunks.push(chunk);
    }
  } else {
    const buf = Buffer.from(await resp.arrayBuffer());
    total = buf.length; chunks.push(buf);
    if (total > EXTERNAL_IMAGE_DOWNLOAD.maxImageBytes) throw new Error('单张图片超过最大允许大小（8MB）');
  }
  if (!total) throw new Error('下载内容为空');
  const buffer = Buffer.concat(chunks);
  const detectedType = detectImageType(buffer);
  if (!detectedType) throw new Error('下载内容不是有效图片文件');
  if (detectedType !== declaredType) throw new Error('远程返回类型与图片内容不一致（' + declaredType + ' vs ' + detectedType + '）');
  return { ok: true, index, sourceUrl: String(raw), buffer, contentType: detectedType, extension: ALLOWED_IMAGE_TYPES.get(detectedType), size: buffer.length };
}

function consumeWindow(store, key, windowMs, maximum) {
  const now = Date.now();
  let current = store.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    if (!current && store.size >= 50000) store.delete(store.keys().next().value);
    current = { startedAt: now, count: 0 };
    store.set(key, current);
  }
  current.count += 1;
  return current.count > maximum ? Math.max(1, Math.ceil((windowMs - (now - current.startedAt)) / 1000)) : 0;
}

function captchaDigest(answer) {
  return crypto.createHash('sha256').update(String(answer || '').trim().toUpperCase()).digest();
}

function createCaptcha(req) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const answer = process.env.NODE_ENV === 'test' && process.env.ERP_CAPTCHA_TEST_ANSWER
    ? String(process.env.ERP_CAPTCHA_TEST_ANSWER).slice(0, 6).toUpperCase()
    : Array.from({ length: 5 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  const id = crypto.randomUUID();
  const colors = ['#6ce7ff', '#70a7ff', '#9b8cff', '#4ff1ca', '#ffffff'];
  const glyphs = answer.split('').map((character, index) => {
    const x = 18 + index * 24 + crypto.randomInt(-2, 3);
    const y = 32 + crypto.randomInt(-3, 4);
    const rotate = crypto.randomInt(-16, 17);
    const color = colors[crypto.randomInt(0, colors.length)];
    return `<text x="${x}" y="${y}" fill="${color}" transform="rotate(${rotate} ${x} ${y})">${character}</text>`;
  }).join('');
  const lines = Array.from({ length: 4 }, () => {
    const y1 = crypto.randomInt(5, 43);
    const y2 = crypto.randomInt(5, 43);
    return `<path d="M0 ${y1} Q70 ${crypto.randomInt(0, 48)} 140 ${y2}"/>`;
  }).join('');
  const dots = Array.from({ length: 28 }, () => `<circle cx="${crypto.randomInt(2, 139)}" cy="${crypto.randomInt(2, 47)}" r="${crypto.randomInt(1, 3) / 2}"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="48" viewBox="0 0 140 48"><defs><linearGradient id="b"><stop stop-color="#071226"/><stop offset="1" stop-color="#0d1d39"/></linearGradient></defs><rect width="140" height="48" rx="9" fill="url(#b)"/><g fill="#3fdcff" opacity=".34">${dots}</g><g fill="none" stroke="#4bdcff" stroke-width=".7" opacity=".26">${lines}</g><g font-family="Consolas,monospace" font-size="24" font-weight="700" letter-spacing="2">${glyphs}</g></svg>`;
  if (captchaChallenges.size >= 10000) captchaChallenges.delete(captchaChallenges.keys().next().value);
  captchaChallenges.set(id, { digest: captchaDigest(answer), address: clientAddress(req), expiresAt: Date.now() + CAPTCHA_TTL_MS });
  return { id, image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), expiresIn: Math.floor(CAPTCHA_TTL_MS / 1000) };
}

function verifyCaptcha(req, id, answer) {
  const key = String(id || '');
  const challenge = captchaChallenges.get(key);
  captchaChallenges.delete(key);
  if (!challenge || challenge.expiresAt < Date.now() || challenge.address !== clientAddress(req)) return false;
  const actual = captchaDigest(answer);
  return actual.length === challenge.digest.length && crypto.timingSafeEqual(actual, challenge.digest);
}

function cleanupAuthAbuseControls() {
  const now = Date.now();
  for (const [key, value] of captchaChallenges.entries()) if (!value || value.expiresAt < now) captchaChallenges.delete(key);
  for (const [key, value] of captchaRequestWindows.entries()) if (!value || now - value.startedAt >= CAPTCHA_REQUEST_WINDOW_MS) captchaRequestWindows.delete(key);
  for (const [key, value] of registrationWindows.entries()) if (!value || now - value.startedAt >= REGISTRATION_WINDOW_MS) registrationWindows.delete(key);
  for (const [key, value] of paymentReviewWindows.entries()) if (!value || now - value.startedAt >= 15 * 60 * 1000) paymentReviewWindows.delete(key);
  for (const [key, value] of financialReviewWindows.entries()) if (!value || now - value.startedAt >= 15 * 60 * 1000) financialReviewWindows.delete(key);
  for (const [key, value] of bugEmailWindows.entries()) if (!value || now - value.startedAt >= 60 * 60 * 1000) bugEmailWindows.delete(key);
  for (const [key, value] of bugEmailNotifications.entries()) if (!value || now - value >= 24 * 60 * 60 * 1000) bugEmailNotifications.delete(key);
}

function persistentQueueSchemaMissing(error) {
  return Boolean(error && error.code === '42P01');
}

async function runPersistedShopSync(job) {
  const actor = await authStore.backgroundJobActor(job);
  const kind = String(job.context && job.context.kind || '');
  const clientId = String(job.context && job.context.clientId || '');
  if (!actor || !actor.enabled || !authStore.hasPermission(actor, 'shops.write')) throw Object.assign(new Error('当前账号无法登记为任务执行人，请重新登录后重试。'), { publicCode: 'background_job_actor_unavailable' });
  const allowedShops = await authStore.listAllowedShops(actor);
  if (allowedShops !== null && !allowedShops.some(item => String(item.externalShopId || '') === clientId)) throw Object.assign(new Error('该店铺不在你的授权范围内，请重新选择店铺。'), { publicCode: 'shop_scope_denied' });
  const taskName = kind === 'limit' ? '商品限额同步' : '仓库同步';
  const startedAt = job.createdAt || new Date().toISOString();
  await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'running', value: 10, name: taskName, label: '正在请求Ozon店铺数据', startedAt });
  try {
    const document = await authStore.getDocument(actor, 'erp_shops_data');
    const shops = document ? decryptShopCredentials(document.payload, CREDENTIALS_KEY, actor.tenantId) : [];
    const shop = Array.isArray(shops) ? shops.find(item => String(item && item.clientId || '') === clientId) : null;
    if (!shop || !shop.apiKey) throw Object.assign(new Error('该店铺尚未配置平台密钥，请先在店铺管理中添加密钥。'), { publicCode: 'shop_credentials_not_found' });
    if (shopApiHealthIsAbnormal(shop)) {
      await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'done', value: 100, name: taskName, label: '已跳过：店铺API状态异常', reason: shopApiHealthMessage(shop), startedAt });
      return { skipped: true, clientId, reason: shopApiHealthMessage(shop) };
    }
    const request = createDirectOzonRequester(shop, actor, 'shop_sync:' + kind);
    let fields;
    if (kind === 'limit') {
      const limit = await request('/v4/product/info/limit', {});
      const roles = await request('/v1/roles', {});
      fields = shopLimitFields(limit, roles);
    } else if (kind === 'warehouse') {
      fields = shopWarehouseFields(await request('/v2/warehouse/list', { limit: 200 }), shop);
    } else throw Object.assign(new Error('请选择正确的店铺同步类型后再提交。'), { publicCode: 'shop_sync_kind_invalid' });
    await authStore.mutateTenantDocumentWithAudit(actor, 'erp_shops_data', payload => {
      const latest = decryptShopCredentials(payload, CREDENTIALS_KEY, actor.tenantId);
      const target = Array.isArray(latest) ? latest.find(item => String(item && item.clientId || '') === clientId) : null;
      if (!target) throw Object.assign(new Error('未找到该店铺，请刷新店铺列表后重试。'), { publicCode: 'shop_not_found' });
      Object.assign(target, fields);
      return { payload: encryptShopCredentials(latest, CREDENTIALS_KEY, actor.tenantId), value: { clientId, kind } };
    }, { action: 'shop.background_sync', resourceType: 'shop', resourceId: clientId, metadata: { kind } });
    await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'done', value: 100, name: taskName, label: taskName + '完成', startedAt });
  } catch (error) {
    await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'failed', value: 0, name: taskName, label: taskName + '失败', reason: bilingualSyncFailure(error, chineseShopSyncReason(error)), startedAt }).catch(() => {});
    throw error;
  }
}

function chineseShopSyncReason(error) {
  const raw = String(error && (error.publicCode || error.message) || error || '');
  if (isOzonApiAccessDisabledError(error)) return 'Ozon 已禁用该店铺的 API 访问权限，当前无法执行店铺同步。请检查该店铺 API 权限，必要时联系 Ozon 支持恢复访问。';
  if (/shop_api_abnormal/i.test(raw)) return '该店铺 API 状态已标记为异常，本次已自动跳过同步。请在店铺列表点击“重新测试连接”。';
  if (/credential|api.?key|401|unauthorized|shop_credentials_not_found/i.test(raw)) return '店铺接口密钥无效、缺失或已经失效';
  if (/shop_scope_denied|permission|actor_unavailable/i.test(raw)) return '当前账号没有该店铺的同步权限';
  if (/timeout|abort|timed out/i.test(raw)) return '请求Ozon店铺接口超时';
  if (/network|fetch|socket|econn|dns/i.test(raw)) return '服务器无法连接Ozon，请检查网络';
  if (/document_version_conflict/i.test(raw)) return '店铺资料正在被修改，请稍后重新同步';
  return '店铺同步异常中断，请查看服务器日志后重试';
}

function externalFailureOriginal(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const candidates = [current.externalMessage, current.upstreamMessage, current.providerMessage, current.rawMessage, current.message];
    for (const value of candidates) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (text && !/[\u3400-\u9fff]/.test(text)) return text.slice(0, 900);
    }
    current = current.cause;
  }
  return '';
}

function bilingualSyncFailure(error, translated) {
  const chinese = String(translated || '').trim() || '同步任务执行失败，请稍后重试。';
  if (/原始报错[:：]/.test(chinese)) return chinese;
  const original = externalFailureOriginal(error);
  if (!original) return chinese;
  return (`中文说明：${chinese}\n原始报错：${original}`).slice(0, 1450);
}

function isOzonApiAccessDisabledError(error) {
  const original = externalFailureOriginal(error) || String(error && error.message || error || '');
  const status = Number(error && error.status);
  return /api\s+access\s+disabled/i.test(original) && (!status || status === 403);
}

function shopApiHealthIsAbnormal(shop) {
  return Boolean(shop && shop.apiHealth && shop.apiHealth.status === 'abnormal' && shop.apiHealth.blockingSync !== false);
}

function shopApiHealthMessage(shop) {
  const health = shop && shop.apiHealth || {};
  return String(health.message || '').trim() || '该店铺 API 状态异常，已自动跳过同步。请在店铺列表点击“重新测试连接”。';
}

function shopApiSkipItem(shop) {
  return { clientId: String(shop && shop.clientId || ''), name: String(shop && shop.name || ''), reason: shopApiHealthMessage(shop), code: String(shop && shop.apiHealth && shop.apiHealth.code || 'shop_api_abnormal') };
}

async function markShopApiAbnormal(account, shopOrClientId, error, source) {
  if (!account || !isOzonApiAccessDisabledError(error)) return false;
  const clientId = String(shopOrClientId && shopOrClientId.clientId || shopOrClientId || '').trim();
  if (!clientId) return false;
  const original = externalFailureOriginal(error) || 'Api access disabled, please contact support';
  const translated = 'Ozon 已禁用该店铺的 API 访问权限，当前无法执行同步或读取平台数据。请检查该店铺 API 权限，必要时联系 Ozon 支持恢复访问。';
  const message = ('中文说明：' + translated + '\n原始报错：' + original).slice(0, 1450);
  const detectedAt = new Date().toISOString();
  await authStore.mutateTenantDocumentWithAudit(account, 'erp_shops_data', payload => {
    const latest = decryptShopCredentials(payload, CREDENTIALS_KEY, account.tenantId);
    const target = Array.isArray(latest) ? latest.find(item => String(item && item.clientId || '') === clientId) : null;
    if (!target) throw Object.assign(new Error('未找到该店铺，请刷新店铺列表后重试。'), { publicCode: 'shop_not_found' });
    const previousStatus = target.apiHealth && target.apiHealth.previousStatus ? String(target.apiHealth.previousStatus) : (target.status && target.status !== '异常' ? String(target.status) : '正常');
    target.status = '异常';
    target.apiHealth = { status: 'abnormal', blockingSync: true, code: 'ozon_api_access_disabled', messageZh: translated, originalMessage: original, message, detectedAt, checkedAt: detectedAt, source: String(source || 'ozon_sync').slice(0, 120), previousStatus };
    return { payload: encryptShopCredentials(latest, CREDENTIALS_KEY, account.tenantId), value: { clientId, status: '异常', code: 'ozon_api_access_disabled' } };
  }, { action: 'shop.api_health.abnormal', resourceType: 'shop', resourceId: clientId, metadata: { code: 'ozon_api_access_disabled', source: String(source || 'ozon_sync').slice(0, 120) } });
  return true;
}

async function clearShopApiAbnormal(account, clientId, source) {
  clientId = String(clientId || '').trim();
  if (!account || !clientId) return false;
  const checkedAt = new Date().toISOString();
  await authStore.mutateTenantDocumentWithAudit(account, 'erp_shops_data', payload => {
    const latest = decryptShopCredentials(payload, CREDENTIALS_KEY, account.tenantId);
    const target = Array.isArray(latest) ? latest.find(item => String(item && item.clientId || '') === clientId) : null;
    if (!target) throw Object.assign(new Error('未找到该店铺，请刷新店铺列表后重试。'), { publicCode: 'shop_not_found' });
    const previousStatus = target.apiHealth && target.apiHealth.previousStatus && target.apiHealth.previousStatus !== '异常' ? String(target.apiHealth.previousStatus) : '正常';
    if (target.status === '异常') target.status = previousStatus;
    target.apiHealth = { status: 'normal', blockingSync: false, code: '', messageZh: '', originalMessage: '', message: '', checkedAt, source: String(source || 'connection_test').slice(0, 120), previousStatus };
    return { payload: encryptShopCredentials(latest, CREDENTIALS_KEY, account.tenantId), value: { clientId, status: target.status || '正常' } };
  }, { action: 'shop.api_health.recovered', resourceType: 'shop', resourceId: clientId, metadata: { source: String(source || 'connection_test').slice(0, 120) } });
  return true;
}

function chineseProductSyncReason(error) {
  const publicCode = String(error && error.publicCode || '');
  const message = String(error && error.message || error || '');
  const raw = publicCode + '\n' + message;
  const status = Number(error && error.status);
  // Ozon 明确返回“已禁用 API 访问”时，不能把它误报成泛化的同步中断，
  // 也不能仅凭 HTTP 403 断言密钥已经失效。
  if (status === 403 && /api\s+access\s+disabled/i.test(message)) return 'Ozon 已禁用此店铺的 API 访问，请检查店铺密钥和接口权限；若配置无误请联系 Ozon 支持（HTTP 403）';
  if (status === 401) return 'Ozon 未通过此店铺的接口身份验证，请检查店铺密钥是否有效（HTTP 401）';
  if (status === 403) return 'Ozon 拒绝访问此店铺接口，请检查店铺接口权限和授权状态（HTTP 403）';
  if (/credential|api.?key|401|unauthorized|shop_credentials_not_found/i.test(raw)) return '店铺接口密钥无效、缺失或已经失效';
  if (/shop_scope_denied|permission|actor_unavailable/i.test(raw)) return '当前账号没有该店铺的商品同步权限';
  if (/product_sync_incomplete_batch/i.test(raw)) return 'Ozon商品详情返回不完整，本次未清理任何旧商品';
  if (/page_limit/i.test(raw)) return 'Ozon商品分页超过安全上限，本次未清理任何旧商品';
  if (/timeout|abort|timed out/i.test(raw)) return '请求Ozon商品接口超时，任务将按检查点重试';
  if (/429|frequent|too many/i.test(raw)) return 'Ozon请求过于频繁，任务将稍后重试';
  if (/network|fetch|socket|econn|dns/i.test(raw)) return '服务器无法连接Ozon，请检查网络';
  return '商品同步异常中断，本次未清理任何旧商品';
}

function chineseAdvertisingFinanceReason(error) {
  const message = String(error && error.message || error || '');
  const publicCode = String(error && error.publicCode || '');
  const raw = `${publicCode}\n${message}`;
  const status = Number(error && error.status);
  if (status === 403 && /api\s+access\s+disabled/i.test(message)) return 'Ozon 已禁用该店铺的 API 访问权限，当前无法读取广告/财务数据。请检查该店铺 API 权限，必要时联系 Ozon 支持恢复访问。';
  if (status === 401 || /unauthorized|authentication|invalid.?api.?key/i.test(raw)) return 'Ozon 未通过该店铺的 API 身份验证，当前无法读取广告/财务数据。请检查店铺 API 密钥是否正确且仍然有效。';
  if (status === 403 || /forbidden|permission denied|access denied/i.test(raw)) return 'Ozon 拒绝该店铺访问广告/财务接口。请检查店铺 API 权限和授权状态；若配置无误请联系 Ozon 支持。';
  if (status === 429 || /rate.?limit|too many|frequent/i.test(raw)) return 'Ozon 广告/财务接口请求过于频繁，系统会稍后再试；已缓存日期不会重复请求。';
  if (/timeout|abort|timed out/i.test(raw)) return 'Ozon 广告/财务接口响应超时，请稍后重试；已缓存日期不会重复请求。';
  if (/network|fetch|socket|econn|dns/i.test(raw)) return '服务器当前无法连接 Ozon 广告/财务接口，请检查网络连接后重试。';
  return 'Ozon 广告/财务接口读取失败，当前店铺的其它已缓存广告数据仍会保留。';
}

function orderCacheKey(kind, clientId) {
  return `erp_order_${kind}_cache_${crypto.createHash('sha256').update(String(clientId || '')).digest('hex').slice(0, 16)}`;
}

function userErrorText(error, fallback) {
  const text = String((error && error.message) || '');
  return /[\u3400-\u9fff]/.test(text) ? text.slice(0, 300) : fallback;
}

function orderSyncPublicMessage(error, fallback = '订单同步失败，请检查任务状态后重试。') {
  const message = String(error && error.message || '').trim();
  const safe = message.replace(/\b(?:Ozon|ERP|WHD|Seller)\b/g, '');
  return /^[a-z][a-z0-9_]{1,119}$/.test(String(error && error.publicCode || ''))
    && message.length <= 300 && /[\u3400-\u9fff]/.test(message)
    && !/[A-Za-z]/.test(safe) && !/[/\\]|\b[1-5]\d\d\b|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|(?:token|secret|password|cookie|authorization)/i.test(message)
    ? message : fallback;
}

async function runPersistedOrderSync(job, tools = {}) {
  const actor = await authStore.backgroundJobActor(job);
  const context = job.context || {};
  if (context.source !== 'manual_server_fallback') throw Object.assign(new Error('服务器订单读取开关尚未开启，请改用页面采集同步或由管理员开启后重试。'), { publicCode: 'server_order_read_disabled', retryable: false });
  const clientId = String(context.clientId || '');
  const startedAt = job.createdAt || new Date().toISOString();
  const taskName = '订单同步（服务器资源）';
  const silent = context.silent === true;
  if (!actor || !actor.enabled || !authStore.hasPermission(actor, 'orders.write')) throw Object.assign(new Error('当前账号无法登记为任务执行人，请重新登录后重试。'), { publicCode: 'background_job_actor_unavailable' });
  const allowedShops = await authStore.listAllowedShops(actor);
  if (allowedShops !== null && !allowedShops.some(item => String(item.externalShopId || '') === clientId)) throw Object.assign(new Error('该店铺不在你的授权范围内，请重新选择店铺。'), { publicCode: 'shop_scope_denied' });
  if (!silent) await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'running', value: 1, name: taskName, label: '正在同步订单', startedAt });
  try {
    const feeKey = orderCacheKey('fee', clientId);
    const acquiringKey = orderCacheKey('acquiring', clientId);
    const documents = await Promise.all([authStore.getDocument(actor, 'erp_shops_data'), authStore.getDocument(actor, 'erp_orders_data'), authStore.getDocument(actor, feeKey), authStore.getDocument(actor, acquiringKey)]);
    const shops = documents[0] ? decryptShopCredentials(documents[0].payload, CREDENTIALS_KEY, actor.tenantId) : [];
    const shop = Array.isArray(shops) ? shops.find(item => String(item && item.clientId || '') === clientId) : null;
    if (!shop || !shop.apiKey) throw Object.assign(new Error('该店铺尚未配置平台密钥，请先在店铺管理中添加密钥。'), { publicCode: 'shop_credentials_not_found' });
    if (shopApiHealthIsAbnormal(shop)) {
      if (!silent) await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'done', value: 100, name: taskName, label: '已跳过：店铺API状态异常', reason: shopApiHealthMessage(shop), startedAt });
      return { skipped: true, clientId, reason: shopApiHealthMessage(shop) };
    }
    const existing = documents[1] && Array.isArray(documents[1].payload) ? documents[1].payload : [];
    const feeState = documents[2] && documents[2].payload || {};
    const acquiringState = documents[3] && documents[3].payload || {};
    const request = createDirectOzonRequester(shop, actor, 'order_sync');
    const warnings = [];
    const acquiringSync = createOrderAcquiringSync({ request, cache: acquiringState.cache, whd: acquiringState.whd, operations: acquiringState.operations, types: acquiringState.types, refreshedAt: acquiringState.refreshedAt, persist: state => authStore.replaceOrderAcquiringCache(actor, acquiringKey, state) });
    const feeEnricher = createOrderFeeEnricher({
      request,
      types: feeState.types,
      cache: feeState.cache,
      realizationBonus: feeState.realizationBonus,
      loadAcquiring: postingNumbers => acquiringSync.refresh({ now: context.rangeEnd || new Date().toISOString(), postingNumbers }),
      persist: state => authStore.mergeOrderFeeCache(actor, feeKey, { types: state.types, cachePatch: state.cache, realizationBonus: state.realizationBonus }),
      autoMapEnabled: true,
      account: actor,
      pool: authStore.pool,
      writeAudit: authStore.writeAudit.bind(authStore)
    });
    const imageEnricher = createOrderImageEnricher({ request, existing, onWarning: warning => { warnings.push(warning); } });
    const enrichBatch = createOrderEnrichmentPipeline({ fees: feeEnricher, images: imageEnricher });
    let lastProgressWriteAt = 0;
    const result = await runOrderSync({
      request, shop, mode: context.mode, postingNumbers: context.postingNumbers, rangeEnd: context.rangeEnd, since: context.since, windowCount: context.windowCount, fullFinalize: context.mode === 'all', runId: context.runId, state: context, existing, enrichBatch, mapOptions: { preserveMissingBuyer: true }, discoverUnfulfilled: true, discoverReturns: true,
      checkpoint: typeof tools.checkpoint === 'function' ? tools.checkpoint : async () => {},
      persistBatch: rows => authStore.mergeOrderSyncBatch(actor, clientId, rows, context.runId, SUPPLIER_HOST_ALLOWLIST),
      finalize: async (runId, full) => {
        const acquiring = await acquiringSync.refresh({ now: context.rangeEnd || new Date().toISOString() });
        const whdNumbers = Object.keys(acquiring.whd || {});
        if (whdNumbers.length) {
          const rows = whdNumbers.map(posting => ({ posting, status: '已签收', items: [], finance: {} }));
          const postings = whdNumbers.map(posting_number => ({ posting_number, status: 'delivered', products: [], financial_data: { products: [] } }));
          await feeEnricher(rows, postings, shop);
          const latest = await authStore.getDocument(actor, 'erp_orders_data');
          const latestOrders = latest && Array.isArray(latest.payload) ? latest.payload : [];
          const feeCacheBeforeOrigin = feeEnricher.state().verifiedFeeMap || {};
          const missingOrigins = new Map();
          for (const operations of Object.values(acquiring.whd || {})) {
            const list = Array.isArray(operations) ? operations : [];
            const sale = list.find(operation => operation && operation.operation_type === 'OperationAgentDeliveredToCustomer');
            const skus = [...new Set((sale && sale.items || []).map(item => String(item && item.sku || '')).filter(Boolean))];
            const saleDate = list.map(operation => operation && operation.posting && operation.posting.order_date).find(Boolean) || '';
            const matched = matchingOrigin(latestOrders, skus, saleDate, shop);
            const origin = matched && matched.origin;
            const originPosting = String(origin && origin.posting || '').trim();
            if (!originPosting || feeCacheBeforeOrigin[originPosting] || missingOrigins.has(originPosting)) continue;
            missingOrigins.set(originPosting, origin);
          }
          if (missingOrigins.size) {
            const originRows = [], originPostings = [];
            for (const [postingNumber, origin] of missingOrigins.entries()) {
              const cancelled = origin && origin.status === '已取消';
              originRows.push({ posting: postingNumber, status: origin && origin.status || (cancelled ? '已取消' : '已签收'), items: [], finance: {} });
              originPostings.push({
                posting_number: postingNumber,
                status: cancelled ? 'cancelled' : 'delivered',
                cancellation: cancelled ? {
                  cancelled_after_ship: !!(origin.cancel && origin.cancel.shipped),
                  cancel_reason: String(origin.cancel && (origin.cancel.why || origin.cancel.whyZh) || '')
                } : undefined,
                products: [], financial_data: { products: [] }
              });
            }
            await feeEnricher(originRows, originPostings, shop);
          }
          const projected = projectWhdOrders({ orders: latestOrders, whd: acquiring.whd, feeMap: feeEnricher.state().verifiedFeeMap, shop });
          for (let offset = 0; offset < projected.changedOrders.length; offset += 100) await authStore.mergeOrderSyncBatch(actor, clientId, projected.changedOrders.slice(offset, offset + 100), runId, SUPPLIER_HOST_ALLOWLIST);
        }
        return full ? authStore.finalizeOrderSync(actor, clientId, runId) : { removed: 0 };
      },
      progress: async status => {
        const now = Date.now();
        if (now - lastProgressWriteAt < 1500) return;
        lastProgressWriteAt = now;
        if (!silent) await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'running', value: Math.min(95, 5 + Math.floor(status.processed / 20)), name: taskName, label: `已增量保存 ${status.processed} 个订单`, startedAt });
      }
    });
    const latestOrdersDocument = await authStore.getDocument(actor, 'erp_orders_data');
    const latestOrders = latestOrdersDocument && Array.isArray(latestOrdersDocument.payload) ? latestOrdersDocument.payload : [];
    const exchangeRateResult = await syncOrderExchangeRates({
      store: authStore, orders: latestOrders, clientId,
      persist: patches => authStore.applyOrderExchangeRateBatch(actor, clientId, patches)
    });
    const netIncomeResult = await syncOrderNetIncome({
      request, orders: latestOrders, clientId, mode: context.mode, postingNumbers: context.postingNumbers,
      now: context.rangeEnd || new Date().toISOString(),
      persist: patches => authStore.applyOrderNetIncomeBatch(actor, clientId, patches)
    });
    const warningText = warnings.length ? `，${warnings.length} 批图片暂未补全` : '';
    const exchangeRateText = exchangeRateResult.targeted ? `，汇率锁定 ${exchangeRateResult.updated}/${exchangeRateResult.targeted} 单` : '';
    const netIncomeText = netIncomeResult.targeted ? `，净收入更新 ${netIncomeResult.updated}/${netIncomeResult.targeted} 单` : '';
    const netIncomeMissingText = netIncomeResult.missing ? `，${netIncomeResult.missing} 单尚未产生财务应计` : '';
    if (!silent) await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'done', value: 100, name: taskName, label: `同步完成，共处理 ${result.processed} 个订单${exchangeRateText}${netIncomeText}${netIncomeMissingText}${warningText}`, startedAt });

    // 异步触发取消原因和退货状态自动映射（不阻塞主流程）
    try {
      const ordersDocument = await authStore.getDocument(actor, 'erp_orders_data');
      const orders = ordersDocument && Array.isArray(ordersDocument.payload) ? ordersDocument.payload : [];
      if (orders.length) {
        autoMapUnmappedReasons(orders, actor, {
          pool: authStore.pool,
          writeAudit: authStore.writeAudit.bind(authStore)
        }).then(autoMapResult => {
          if (autoMapResult.detected > 0) {
            console.log(`[order-sync] 取消原因自动映射: 检测到 ${autoMapResult.detected} 个, 翻译 ${autoMapResult.translated} 个, 持久化 ${autoMapResult.persisted} 个`);
          }
        }).catch(error => console.error('[order-sync] 取消原因自动映射失败:', error.message));

        const returnInfos = orders.map(order => order.returnInfo).filter(Boolean);
        if (returnInfos.length) {
          autoMapUnmappedStatuses(returnInfos, actor, {
            pool: authStore.pool,
            writeAudit: authStore.writeAudit.bind(authStore)
          }).then(autoMapResult => {
            if (autoMapResult.detected > 0) {
              console.log(`[order-sync] 退货状态自动映射: 检测到 ${autoMapResult.detected} 个, 翻译 ${autoMapResult.translated} 个, 持久化 ${autoMapResult.persisted} 个`);
            }
          }).catch(error => console.error('[order-sync] 退货状态自动映射失败:', error.message));
        }
      }
    } catch (autoMapError) {
      console.error('[order-sync] 触发自动映射失败:', autoMapError.message);
    }

    return result;
  } catch (error) {
    if (!silent) await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'failed', value: 0, name: taskName, label: '订单同步失败', reason: orderSyncPublicMessage(error), startedAt }).catch(() => {});
    throw error;
  }
}

async function runPersistedSkuImageAi(job, tools = {}) {
  return createSkuImageAiWorker({
    authStore, privateObjectStore, aiPromptStore, aiConfigStore, aiConfig,
    credentialsKey: CREDENTIALS_KEY, aiProvider, skuImageUpload, aiBeanStore,
    imageCostBean: IMAGE_COST_BEAN, submitTimeoutMs: OFFICIAL_SKU_IMAGE_SUBMIT_TIMEOUT_MS,
    pollTotalWaitMs: OFFICIAL_SKU_IMAGE_POLL_TOTAL_WAIT_MS, pollIntervalMs: OFFICIAL_SKU_IMAGE_POLL_INTERVAL_MS
  })(job, tools);
}

async function runPersistedProductSync(job, tools = {}) {
  const actor = await authStore.backgroundJobActor(job);
  const context = job.context || {};
  const clientId = String(context.clientId || '');
  const startedAt = job.createdAt || new Date().toISOString();
  if (!actor || !actor.enabled || !authStore.hasPermission(actor, 'products.write')) throw Object.assign(new Error('当前账号无法登记为任务执行人，请重新登录后重试。'), { publicCode: 'background_job_actor_unavailable' });
  const allowedShops = await authStore.listAllowedShops(actor);
  if (allowedShops !== null && !allowedShops.some(item => String(item.externalShopId || '') === clientId)) throw Object.assign(new Error('该店铺不在你的授权范围内，请重新选择店铺。'), { publicCode: 'shop_scope_denied' });
  await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'running', value: 1, name: '在线商品同步（服务器资源）', label: '已领取服务器队列任务', startedAt });
  try {
    const documents = await Promise.all([
      authStore.getDocument(actor, 'erp_shops_data'), authStore.getDocument(actor, 'erp_online_products'),
      authStore.getDocument(actor, 'erp_online_categories'), authStore.getDocument(actor, 'erp_online_product_manual'),
      authStore.getDocument(actor, 'erp_orders_data'), authStore.getDocument(actor, LOGISTICS_CONFIG_KEY),
      authStore.getDocument(actor, logisticsPreferenceKey(actor))
    ]);
    const shops = documents[0] ? decryptShopCredentials(documents[0].payload, CREDENTIALS_KEY, actor.tenantId) : [];
    const shop = Array.isArray(shops) ? shops.find(item => String(item && item.clientId || '') === clientId) : null;
    if (!shop || !shop.apiKey) throw Object.assign(new Error('该店铺尚未配置平台密钥，请先在店铺管理中添加密钥。'), { publicCode: 'shop_credentials_not_found' });
    if (shopApiHealthIsAbnormal(shop)) {
      await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'done', value: 100, name: '在线商品同步（服务器资源）', label: '已跳过：店铺API状态异常', reason: shopApiHealthMessage(shop), startedAt });
      return { skipped: true, clientId, reason: shopApiHealthMessage(shop) };
    }
    const logistics = normalizeLogisticsItems(documents[5] && documents[5].payload).filter(item => item.active);
    const preferences = reconcileLogisticsPreferences(logistics, documents[6] && documents[6].payload);
    shop.fulfillmentSchema = preferences.value.defaultScheme || shop.fulfillmentSchema || 'rFBS';
    let lastProgressWriteAt = 0;
    const result = await runProductSync({
      request: createDirectOzonRequester(shop, actor, 'product_sync'), shop, mode: context.mode, productIds: context.productIds,
      runId: context.runId, state: context, existing: documents[1] && documents[1].payload,
      mapOptions: { category: documents[2] && documents[2].payload || {}, manualEntries: documents[3] && documents[3].payload, orders: documents[4] && documents[4].payload, logisticsScheme: shop.fulfillmentSchema },
      checkpoint: typeof tools.checkpoint === 'function' ? tools.checkpoint : async () => {},
      persistBatch: rows => authStore.mergeProductSyncBatch(actor, clientId, rows, context.runId, SUPPLIER_HOST_ALLOWLIST),
      finalize: (runId, fullSync) => authStore.finalizeProductSync(actor, clientId, runId, fullSync),
      progress: async status => {
        const now = Date.now();
        if (now - lastProgressWriteAt < 1500) return;
        lastProgressWriteAt = now;
        await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'running', value: Math.min(95, 5 + Math.floor(status.processed / 100)), name: '在线商品同步（服务器资源）', label: `已增量保存 ${status.processed} 个商品`, startedAt });
      }
    });
    await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'done', value: 100, name: '在线商品同步（服务器资源）', label: `同步完成，共处理 ${result.processed} 个商品`, startedAt });

    // 仅补全公共类目名称；商品已选属性值不能自动写入公共术语映射。
    try {
      const productsDocument = await authStore.getDocument(actor, 'erp_online_products');
      const products = productsDocument && Array.isArray(productsDocument.payload) ? productsDocument.payload : [];
      if (products.length) {
        const categoryNames = new Set();
        for (const product of products) {
          if (product.cat1) categoryNames.add(String(product.cat1).trim());
          if (product.cat2) categoryNames.add(String(product.cat2).trim());
          if (product.cat3) categoryNames.add(String(product.cat3).trim());
        }
        const uniqueNames = [...categoryNames].filter(Boolean);
        if (uniqueNames.length) {
          autoMapUnmappedCategories(uniqueNames, actor, {
            pool: authStore.pool,
            writeAudit: authStore.writeAudit.bind(authStore)
          }).then(autoMapResult => {
            if (autoMapResult.detected > 0) {
              console.log(`[product-sync] 类目名称自动映射: 检测到 ${autoMapResult.detected} 个, 翻译 ${autoMapResult.translated} 个, 持久化 ${autoMapResult.persisted} 个`);
            }
          }).catch(error => console.error('[product-sync] 类目名称自动映射失败:', error.message));
        }
      }
    } catch (autoMapError) {
      console.error('[product-sync] 触发自动映射失败:', autoMapError.message);
    }

    return result;
  } catch (error) {
    await authStore.upsertSyncTask(actor, { id: job.id, type: 'sync', status: 'failed', value: 0, name: '在线商品同步（服务器资源）', label: '商品同步失败', reason: bilingualSyncFailure(error, chineseProductSyncReason(error)), startedAt }).catch(() => {});
    throw error;
  }
}
async function runPersistedCategoryAttributes(job) {
  const actor = await authStore.backgroundJobActor(job);
  if (!actor || !actor.enabled || !authStore.hasPermission(actor, 'sync.run')) throw Object.assign(new Error('当前账号无法登记为任务执行人，请重新登录后重试。'), { publicCode: 'background_job_actor_unavailable' });
  const clientId = String(job.context && job.context.clientId || '');
  const allowedShops = await authStore.listAllowedShops(actor);
  if (allowedShops !== null && !allowedShops.some(item => String(item.externalShopId || '') === clientId)) throw Object.assign(new Error('该店铺不在你的授权范围内，请重新选择店铺。'), { publicCode: 'shop_scope_denied' });
  const shopDocument = await authStore.getDocument(actor, 'erp_shops_data');
  const shops = shopDocument ? decryptShopCredentials(shopDocument.payload, CREDENTIALS_KEY, actor.tenantId) : [];
  const shop = Array.isArray(shops) ? shops.find(item => String(item && item.clientId || '') === clientId) : null;
  if (!shop || !shop.apiKey) throw Object.assign(new Error('该店铺尚未配置平台密钥，请先在店铺管理中添加密钥。'), { publicCode: 'shop_credentials_not_found' });
  const now = new Date().toISOString();
  const view = { taskId: job.id, status: 'running', startedAt: job.createdAt || now, updatedAt: now, summary: null, failures: [] };
  categoryAttributeJobs.set(String(actor.tenantId), view);
  await authStore.upsertSyncTask(actor, { id: view.taskId, type: 'sync', status: 'running', value: 1, name: '三级类目属性全量同步', label: '正在读取 OZON 三级类目树', startedAt: view.startedAt });
  await runCategoryAttributeJob(actor, shop, { force: job.context && job.context.force === true }, view);
  if (view.status !== 'done') throw Object.assign(new Error(view.reason || 'category_attribute_sync_partial'), { publicCode: 'category_attribute_sync_failed' });
}
async function sendPersistedBugEmail(job) {
  const actor = await authStore.backgroundJobActor(job);
  if (!actor || !actor.enabled) throw Object.assign(new Error('当前账号无法登记为任务执行人，请重新登录后重试。'), { publicCode: 'background_job_actor_unavailable' });
  const reportId = String(job.context && job.context.reportId || '');
  const document = await authStore.getDocument(actor, 'erp_bug_reports');
  const report = (document && Array.isArray(document.payload) ? document.payload : []).find(item => item && item.id === reportId);
  if (!report) throw Object.assign(new Error('未找到这条报错记录，请刷新列表后重试。'), { publicCode: 'bug_report_not_found' });
  try {
    const result = await bugMailer.send(report, actor);
    if (result.sent) bugEmailNotifications.set(String(actor.tenantId) + '|' + reportId, Date.now());
    await authStore.recordAudit(actor, 'bug.email.notify', 'bug_report', reportId, result.sent ? 'success' : 'skipped', { emailConfigured: bugMailer.configured, reason: result.reason || '' });
  } catch (error) {
    await authStore.recordAudit(actor, 'bug.email.notify', 'bug_report', reportId, 'failed', { emailConfigured: bugMailer.configured, reason: 'send_failed' }).catch(() => {});
    throw error;
  }
}
function loginFailureKey(req, username) {
  return clientAddress(req) + '|' + String(username || '').trim().toLowerCase();
}

function getLoginLimit(req, username) {
  const key = loginFailureKey(req, username);
  const current = loginFailures.get(key);
  if (!current || Date.now() - current.firstAt > LOGIN_WINDOW_MS) {
    loginFailures.delete(key);
    return null;
  }
  if (current.count < LOGIN_MAX_FAILURES) return null;
  return Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (Date.now() - current.firstAt)) / 1000));
}

function recordLoginFailure(req, username) {
  const key = loginFailureKey(req, username);
  const now = Date.now();
  const current = loginFailures.get(key);
  if (!current || now - current.firstAt > LOGIN_WINDOW_MS) {
    if (!current && loginFailures.size >= 50000) loginFailures.delete(loginFailures.keys().next().value);
    loginFailures.set(key, { count: 1, firstAt: now });
  }
  else current.count += 1;
}

function clearLoginFailures(req, username) {
  loginFailures.delete(loginFailureKey(req, username));
}

function cleanupLoginFailures() {
  const now = Date.now();
  for (const [key, value] of loginFailures.entries()) {
    if (!value || now - value.firstAt > LOGIN_WINDOW_MS) loginFailures.delete(key);
  }
}

function consumeOzonRateLimit(account, clientId) {
  const now = Date.now();
  const key = `${account.tenantId}|${clientId}`;
  let window = ozonRequestWindows.get(key);
  if (!window || now - window.startedAt >= 60000) {
    window = { startedAt: now, count: 0 };
    ozonRequestWindows.set(key, window);
  }
  window.count += 1;
  return window.count > 120 ? Math.max(1, Math.ceil((60000 - (now - window.startedAt)) / 1000)) : 0;
}

function cleanupOzonRateLimits() {
  const cutoff = Date.now() - 120000;
  for (const [key, value] of ozonRequestWindows.entries()) {
    if (!value || value.startedAt < cutoff) ozonRequestWindows.delete(key);
  }
}

function categoryAttributeSnapshotFile(tenantId) {
  return path.join(DATA_DIR, 'category-attributes', `tenant-${String(tenantId)}.json`);
}

function normalizeOzonCategoryMatchItem(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const pathValue = Array.isArray(source.sourceCategoryPath) ? source.sourceCategoryPath : [];
  return {
    id: String(source.id || '').trim().slice(0, 160),
    title: String(source.title || '').trim().slice(0, 300),
    sourcePlatform: String(source.sourcePlatform || '').trim().toLowerCase().slice(0, 40),
    sourceCategoryId: String(source.sourceCategoryId || '').trim().slice(0, 80),
    sourceCategoryPath: pathValue.map(item => String(item && typeof item === 'object' ? item.name || item.title || item.label : item || '').trim().slice(0, 120)).filter(Boolean).slice(0, 6),
    attributeNames: String(source.attributeNames || '').trim().slice(0, 600),
    attributeKeywords: String(source.attributeKeywords || '').trim().slice(0, 1200),
    descriptionKeywords: String(source.descriptionKeywords || '').trim().slice(0, 600),
    keywords: String(source.keywords || '').trim().slice(0, 1200)
  };
}

function validOzonCategoryMatchItem(item) {
  return Boolean(item && item.id && item.title && item.id.length <= 160 && item.title.length <= 300);
}

function createDirectOzonRequester(shop, account, source, options = {}) {
  const clientId = String(shop && shop.clientId || '');
  const apiKey = String(shop && shop.apiKey || '');
  return async function requestOzon(endpoint, body) {
    if (shopApiHealthIsAbnormal(shop) && options.allowAbnormal !== true) {
      const blocked = new Error(shopApiHealthMessage(shop));
      blocked.publicCode = 'shop_api_abnormal';
      blocked.status = 409;
      blocked.retryable = false;
      throw blocked;
    }
    return ozonShopScheduler.run(clientId, async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45000);
      try {
        const response = await fetch(OZON_API_BASE_URL + endpoint, {
          method: 'POST',
          headers: { 'Client-Id': clientId, 'Api-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: controller.signal
        });
        const responseText = await response.text();
        let payload;
        try { payload = responseText ? JSON.parse(responseText) : null; }
        catch (error) {
          const invalid = new Error('invalid response'); invalid.retryable = response.status >= 500; throw invalid;
        }
        if (!response.ok) {
          // payload.message 是 Ozon 平台原文，原样保留；我们自己生成的兜底句必须是中文，HTTP 状态只进机器字段。
          const upstreamMessage = String((payload && payload.message) || '').slice(0, 500);
          const upstream = new Error(upstreamMessage || 'Ozon 接口本次调用失败，请稍后重试；若持续失败请联系系统管理员。');
          if (upstreamMessage) upstream.externalMessage = upstreamMessage;
          upstream.status = response.status;
          upstream.retryable = response.status === 429 || response.status >= 500 || /rate limit|too many|frequent/i.test(upstreamMessage);
          const retryAfter = Number(response.headers.get('retry-after'));
          if (Number.isFinite(retryAfter) && retryAfter > 0) upstream.retryAfterMs = retryAfter * 1000;
          if (account && isOzonApiAccessDisabledError(upstream)) {
            await markShopApiAbnormal(account, shop, upstream, source || endpoint).catch(markError => console.error('回写店铺API异常状态失败:', markError.message));
          }
          throw upstream;
        }
        return payload;
      } catch (error) {
        if (error.name === 'AbortError') { const timeout = new Error('OZON request timeout'); timeout.externalMessage = 'OZON request timeout'; timeout.retryable = true; throw timeout; }
        if (error.retryable == null) error.retryable = true;
        throw error;
      } finally { clearTimeout(timer); }
    });
  };
}
async function categoryMatchCompiledFor(account) {
  const tenantId = String(account && account.tenantId || '').trim();
  if (!tenantId) throw Object.assign(new Error('客户空间信息不完整，请重新进入后再试。'), { publicCode: 'tenant_required' });
  const activeReference = await publicCategoryCatalog.active();
  const cacheKey = activeReference ? `public:${activeReference.version}` : `tenant:${tenantId}`;
  const cached = categoryMatchCompiledCache.get(cacheKey);
  if (cached) return cached;
  const pending = (async () => {
    const library = activeReference
      ? await publicCategoryCatalog.matcher()
      : normalizeCategoryAttributeLibrary((await authStore.getDocument(account, CATEGORY_ATTRIBUTE_KEY))?.payload);
    const compiled = await compileOzonCategoryCatalogAsync(library);
    if (!compiled.catalog.length) throw Object.assign(new Error('Ozon 类目目录尚未导入，请先在类目管理页完成一次目录同步。'), { publicCode: 'ozon_category_catalog_empty' });
    return { compiled, updatedAt: library.updatedAt || compiled.updatedAt || null };
  })();
  categoryMatchCompiledCache.set(cacheKey, pending);
  try {
    return await pending;
  } catch (error) {
    if (categoryMatchCompiledCache.get(cacheKey) === pending) categoryMatchCompiledCache.delete(cacheKey);
    throw error;
  }
}

function invalidateCategoryMatchCompiledCache(accountOrTenantId) {
  const tenantId = String(accountOrTenantId && accountOrTenantId.tenantId || accountOrTenantId || '').trim();
  if (tenantId) categoryMatchCompiledCache.delete(`tenant:${tenantId}`);
}

async function persistCategoryAttributeLibrary(account, library, treeDocument) {
  // A public reference may be activated while a legacy per-shop sync is
  // already in flight. Never let that old job reintroduce large tenant JSONB
  // writes after the shared version has become authoritative.
  if (await publicCategoryCatalog.active()) return;
  const serialized = await stringifyLargeCategoryDocument(library);
  await authStore.putLargeDocument(account, CATEGORY_ATTRIBUTE_KEY, library, 180000, serialized);
  invalidateCategoryMatchCompiledCache(account);
  await authStore.putDocument(account, 'erp_category_tree', treeDocument);
  if (await authStore.getTenantCutoverRun(account)) {
    const body = Buffer.from(serialized + '\n', 'utf8');
    const stored = await privateObjectStore.putBuffer({ tenantId: account.tenantId, kind: 'category_snapshot', body, extension: '.json' });
    await authStore.addLivePrivateObject(account, {
      ...stored, kind: 'category_snapshot', mediaType: 'application/json',
      sourceRelativePath: `live/category-attributes/${account.tenantId}/current.json`,
      metadata: { purpose: 'category-attribute-snapshot', generatedAt: new Date().toISOString() }
    });
  } else {
    const file = categoryAttributeSnapshotFile(account.tenantId);
    if (fs.existsSync(P2_FREEZE_MARKER) && pathInside(DATA_DIR, path.resolve(file))) {
      const error = new Error('P2 migration source is frozen'); error.publicCode = 'migration_source_frozen'; throw error;
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp';
    await fs.promises.writeFile(temporary, serialized, 'utf8');
    await fs.promises.rename(temporary, file);
  }
}

async function runCategoryAttributeJob(account, shop, options, job) {
  const shared = await publicCategoryCatalog.summary();
  if (shared) {
    job.status = 'done'; job.summary = shared.summary;
    job.updatedAt = new Date().toISOString(); job.endedAt = job.updatedAt;
    await authStore.upsertSyncTask(account, { id: job.taskId, type: 'sync', status: 'done', value: 100,
      name: '三级类目属性全量同步', label: '公共类目目录已就绪，无需按店铺重复采集', startedAt: job.startedAt }).catch(() => {});
    return { skipped: true, publicReference: true, version: shared.version };
  }
  if (shopApiHealthIsAbnormal(shop)) {
    job.status = 'done'; job.reason = shopApiHealthMessage(shop); job.updatedAt = new Date().toISOString(); job.endedAt = job.updatedAt;
    await authStore.upsertSyncTask(account, { id: job.taskId, type: 'sync', status: 'done', value: 100, name: '三级类目属性全量同步', label: '已跳过：店铺API状态异常', reason: job.reason, startedAt: job.startedAt }).catch(() => {});
    return { skipped: true, reason: job.reason };
  }
  const document = await authStore.getDocument(account, CATEGORY_ATTRIBUTE_KEY);
  let lastTaskWriteAt = 0;
  let lastTaskPercent = -1;
  try {
    const result = await syncCategoryAttributes({
      existing: document && document.payload,
      force: options.force === true,
      delayMs: Number(process.env.ERP_CATEGORY_ATTRIBUTE_DELAY_MS || 650),
      batchSize: Number(process.env.ERP_CATEGORY_ATTRIBUTE_BATCH_SIZE || 100),
      concurrency: Number(process.env.ERP_CATEGORY_ATTRIBUTE_CONCURRENCY || 4),
      request: createDirectOzonRequester(shop, account, 'category_attribute_sync'),
      persist: (library, treeDocument) => persistCategoryAttributeLibrary(account, library, treeDocument),
      progress: async (library, category, stage) => {
        const percent = Math.max(1, Math.min(99, Math.floor((library.processedCategories / Math.max(1, library.totalCategories)) * 100)));
        job.summary = summarizeCategoryAttributeLibrary(library);
        job.status = 'running'; job.updatedAt = new Date().toISOString();
        const now = Date.now();
        if (percent !== lastTaskPercent || now - lastTaskWriteAt >= 5000) {
          lastTaskPercent = percent; lastTaskWriteAt = now;
          await authStore.upsertSyncTask(account, {
            id: job.taskId, type: 'sync', status: 'running', value: percent, name: '三级类目属性全量同步',
            label: `${stage} · ${library.processedCategories}/${library.totalCategories} · ${category.path.map(item => item.name).join(' > ')}`,
            startedAt: job.startedAt
          });
        }
      }
    });
    job.status = result.library.status === 'done' ? 'done' : 'failed';
    job.summary = result.summary; job.failures = result.library.failures; job.updatedAt = new Date().toISOString(); job.endedAt = job.updatedAt;
    const reason = result.summary.failedCategories ? `仍有 ${result.summary.failedCategories} 个三级类目未获取，详细中文原因已保存到类目属性失败清单` : '';
    await authStore.upsertSyncTask(account, {
      id: job.taskId, type: 'sync', status: job.status, value: 100, name: '三级类目属性全量同步',
      label: result.summary.failedCategories ? `完成采集，失败 ${result.summary.failedCategories} 个类目` : `全部 ${result.summary.totalCategories} 个三级类目属性获取完成`,
      reason, startedAt: job.startedAt
    });
    await authStore.recordAudit(account, 'category.attributes.sync', 'tenant_document', CATEGORY_ATTRIBUTE_KEY, job.status === 'done' ? 'success' : 'failed', result.summary);
  } catch (error) {
    job.status = 'failed'; job.reason = chineseCategorySyncReason(error); job.updatedAt = new Date().toISOString(); job.endedAt = job.updatedAt;
    const failedProgress = job.summary ? Math.floor(Number(job.summary.processedCategories || 0) / Math.max(1, Number(job.summary.totalCategories || 0)) * 100) : 0;
    await authStore.upsertSyncTask(account, { id: job.taskId, type: 'sync', status: 'failed', value: failedProgress, name: '三级类目属性全量同步', label: '同步中断', reason: job.reason, startedAt: job.startedAt }).catch(() => {});
    console.error('三级类目属性全量同步失败:', job.reason);
  }
}

function chineseCategorySyncReason(error) {
  const raw = String(error && (error.publicCode || error.message) || error || '');
  if (/shop_api_abnormal/i.test(raw)) return '该店铺 API 状态已标记为异常，本次类目属性同步已自动跳过，请先在店铺列表重新测试连接。';
  if (isOzonApiAccessDisabledError(error)) return 'Ozon 已禁用该店铺的 API 访问权限，类目属性同步已停止。请到店铺列表重新测试连接。';
  if (/credential|api.?key|401|unauthorized/i.test(raw)) return '店铺接口密钥无效或已经失效';
  if (/timeout|abort|timed out/i.test(raw)) return '请求 OZON 类目接口超时';
  if (/network|fetch|socket|econn|dns/i.test(raw)) return '服务器无法连接 OZON，请检查网络';
  if (/类目|OZON/.test(raw)) return raw.slice(0, 300);
  return '类目属性同步异常中断，请查看服务器日志后重试';
}

async function getSystemAdminMonitorAccount() {
  try { return await authStore.systemAdminHomeAccount(); }
  catch (_) { return null; }
}

function readBody(req, maximumBytes = 256 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
        const error = new Error('body too large');
        error.publicCode = 'body_too_large';
        reject(error);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', (error) => { if (!tooLarge) reject(error); });
  });
}

// Product synchronization sends the complete shop snapshot so PostgreSQL can
// apply it atomically and remove records that disappeared from Ozon. A normal
// 1,500-product snapshot is larger than the former 16 MiB route limit, while
// the relational writer still enforces its separate 10,000-row ceiling.
const BUSINESS_ROWS_JSON_MAX_BYTES = 64 * 1024 * 1024;

function matchesBugAttachmentSignature(type, body) {
  if (!Buffer.isBuffer(body) || body.length < 12) return false;
  if (type === 'image/jpeg') return body[0] === 0xFF && body[1] === 0xD8 && body[2] === 0xFF;
  if (type === 'image/png') return body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('ascii'));
  if (type === 'image/webp') return body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP';
  if (type === 'video/webm') return body.subarray(0, 4).equals(Buffer.from([0x1A, 0x45, 0xDF, 0xA3]));
  if (type === 'video/mp4' || type === 'video/quicktime') return body.subarray(4, 8).toString('ascii') === 'ftyp';
  return false;
}

async function readJsonBody(req, res, maximumBytes, messages) {
  try {
    const body = await readBody(req, maximumBytes);
    return JSON.parse(body.toString('utf8'));
  } catch (e) {
    const tooLarge = e.publicCode === 'body_too_large';
    const error = e.publicCode || 'bad json';
    const message = messages && (tooLarge ? messages.tooLarge : messages.invalid);
    sendJson(res, tooLarge ? 413 : 400, message ? { error, message } : { error });
    return null;
  }
}

async function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch (e) { sendJson(res, 400, { error: 'bad path', message: '请求地址不正确，请从页面内的正常入口重新操作。' }); return; }
  let rel = path.normalize(decoded).replace(/^[/\\]+/, '');
  if (!rel || rel === '.') rel = 'index.html';
  if (STANDALONE_MODE && STANDALONE_HIDDEN_PAGES.test(rel.replace(/\\/g, '/'))) {
    return sendJson(res, 404, { error: 'standalone_feature_disabled', message: '单机版不提供会员、代理或合同服务。' });
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  const first = segments[0] || '';
  const allowed = segments.length === 1 ? STATIC_ROOT_FILES.has(first) : STATIC_ROOT_DIRS.has(first);
  if (!allowed || segments.some(part => part.startsWith('.'))) {
    sendJson(res, 403, { error: 'forbidden', message: '没有权限执行该操作，请联系管理员确认账号权限。' });
    return;
  }
  if (rel === 'favicon.ico') {
    res.writeHead(204, Object.assign(securityHeaders(), { 'Cache-Control': 'public, max-age=86400' }));
    res.end();
    return;
  }
  const isProtectedPage = rel === 'index.html' || rel === 'workspace.html' || (first === 'pages' && path.extname(rel).toLowerCase() === '.html');
  const pageAccount = isProtectedPage ? await authenticate(req) : null;
  if (isProtectedPage && !pageAccount) {
    let next = pathname && pathname !== '/' ? pathname : '/';
    try {
      const requested = new URL(req.url, 'http://' + HOST + ':' + PORT);
      if (requested.searchParams.get('workspace') === '1' && requested.pathname !== '/workspace.html') {
        requested.searchParams.delete('workspace');
        const childRoute = requested.pathname + (requested.search ? requested.search : '') + (requested.hash ? requested.hash : '');
        next = '/workspace.html?open=' + encodeURIComponent(childRoute);
      }
    } catch (error) {}
    sendRedirect(res, '/login.html?next=' + encodeURIComponent(next));
    return;
  }
  if (isProtectedPage && SYSTEM_ADMIN_PAGES.has(rel.replace(/\\/g, '/')) && !pageAccount.isSystemAdmin) {
    sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    return;
  }
  if (isProtectedPage && AGENT_OWNER_PAGES.has(rel.replace(/\\/g, '/'))) {
    const membership = await authStore.getMembershipCurrent(pageAccount);
    if (pageAccount.memberType !== 'owner' || !membership.agent) {
      sendJson(res, 403, { error: 'agent_owner_required', message: '只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。' });
      return;
    }
  }
  if (isProtectedPage && OWNER_ONLY_PAGES.has(rel.replace(/\\/g, '/')) && !pageAccount.isSystemAdmin && pageAccount.memberType !== 'owner') {
    sendJson(res, 403, { error: 'owner_required', message: '只有客户空间主账号可以执行该操作，请用主账号登录后重试。' });
    return;
  }
  if (isProtectedPage && !pageAccount.isSystemAdmin && pageAccount.memberType !== 'owner') {
    const pageKey = rel.replace(/\\/g, '/');
    const permission = PAGE_PERMISSIONS.get(pageKey);
    const required = Array.isArray(permission) ? permission : (permission ? [permission] : []);
    if (!PAGE_PERMISSIONS.has(pageKey) || required.some(code => !authStore.hasPermission(pageAccount, code))) {
      sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
      return;
    }
  }
  if (rel === 'login.html' && await authenticate(req)) {
    sendRedirect(res, '/');
    return;
  }
  let p = path.resolve(BASE, rel);
  if (!pathInside(BASE, p)) { sendJson(res, 403, { error: 'forbidden', message: '没有权限执行该操作，请联系管理员确认账号权限。' }); return; }
  fs.stat(p, (err, st) => {
    if (!err && st.isDirectory()) p = path.join(p, 'index.html');
    fs.readFile(p, (err2, data) => {
      if (err2) { sendJson(res, 404, { error: 'not found', message: '未找到请求的内容，请刷新页面后重试。' }); return; }
      const ext = path.extname(p).toLowerCase();
      // Standalone UI changes are injected into HTML only on localhost.
      const body = STANDALONE_MODE && ext === '.html'
        ? Buffer.from(data.toString('utf8').replace('</head>', '<meta name="wyerp-edition" content="standalone"><script src="/assets/standalone-ui.js" defer></script></head>'), 'utf8')
        : data;
      res.writeHead(200, Object.assign(securityHeaders(ext === '.html' ? data : null), {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache'
      }));
      res.end(body);
    });
  });
}

const overviewSyncTask = createSingleFlightTask(() => new Promise((resolve, reject) => {
  const configFile = path.join(BASE, 'config', 'overview.json');
  let config = {};
  try { config = parseJsonStrict(fs.readFileSync(configFile, 'utf8')); } catch (e) { reject(new Error('config/overview.json not found or invalid')); return; }
  const overviewToken = process.env.OVERVIEW_TOKEN || process.env.MAOZI_TOKEN || '';
  if (!overviewToken) { reject(new Error('missing OVERVIEW_TOKEN')); return; }
  const cp = require('child_process');
  const syncScript = path.join(BASE, 'work_sync_overview.mjs');
  const env = Object.assign({}, process.env, { OVERVIEW_TOKEN: overviewToken });
  cp.execFile(process.execPath, [syncScript], { env: env, timeout: 120000, cwd: BASE }, function (err, stdout, stderr) {
    if (err) reject(err); else resolve({ stdout, stderr });
  });
}));

function runOverviewSync(cb) {
  const started = overviewSyncTask.start();
  if (cb) started.promise.then(result => cb(null, result.stdout, result.stderr), error => cb(error));
  return started.started;
}

function maybeAutoSyncOverview() {
  fs.readFile(path.join(DATA_DIR, 'overview.json'), 'utf8', function (err, raw) {
    let stale = true;
    if (!err) {
      try {
        const d = parseJsonStrict(raw);
        const t = d && d.fetched_at ? Date.parse(d.fetched_at) : NaN;
        stale = isNaN(t) || (Date.now() - t) > 24 * 60 * 60 * 1000;
      } catch (e) { stale = true; }
    }
    if (!stale) return;
    console.log('大盘总览缓存超过 24 小时，开始自动同步...');
    runOverviewSync(function (err, stdout, stderr) {
      if (err) { console.error('大盘总览自动同步失败:', err.message); return; }
      console.log('大盘总览自动同步 stdout:', String(stdout || '').slice(0, 300));
      if (stderr) console.error('大盘总览自动同步 stderr:', String(stderr || '').slice(0, 300));
    });
  });
}
async function handleApi(req, res, pathname) {
  if (pathname === '/api/local/standalone-mode' && req.method === 'GET') {
    return sendJson(res, 200, { standalone: STANDALONE_MODE, email: !STANDALONE_MODE,
      membership: !STANDALONE_MODE, agents: !STANDALONE_MODE, contracts: !STANDALONE_MODE },
      { 'Cache-Control': 'no-store' });
  }
  if (STANDALONE_MODE && STANDALONE_UNAVAILABLE_ROUTES.test(pathname)) {
    return sendJson(res, 404, { error: 'standalone_feature_disabled',
      message: '单机版不提供此项在线会员、代理、合同或邮箱服务。' });
  }
  if (pathname === '/api/system/frontend-version' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' }, { 'Cache-Control': 'no-store' });
    return sendJson(res, 200, await frontendVersionSnapshot(), { 'Cache-Control': 'no-store' });
  }
  if (pathname === '/api/domain/commands/sku-image-upload-ticket' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const input = await readJsonBody(req, res, 16 * 1024); if (!input) return;
    const clientId = String(input.clientId || ''), productId = String(input.productId || ''), variantRef = String(input.variantRef || '');
    const name = String(input.name || '').slice(0, 180), linkId = String(input.linkId || ''), associationVersion = Number(input.associationVersion || 0);
    if (!/^(?:\d+|draft_[\w-]+)$/.test(productId) || !/^[A-Za-z0-9._-]{1,120}$/.test(clientId) || !/^[A-Za-z0-9._:-]{1,180}$/.test(variantRef)) return sendJson(res, 400, { error: 'invalid_sku_image_target', message: '未确定要编辑的规格图片，请先在列表中选择一个规格。' });
    const replacing = Boolean(linkId) || Boolean(input.associationVersion);
    if (replacing && (!UUID_PATTERN.test(linkId) || !Number.isInteger(associationVersion) || associationVersion < 1)) return sendJson(res, 400, { error: 'invalid_sku_image_replace', message: '请选择要替换的原图片后再替换。' });
    try {
      await authStore.assertSkuImageTarget(account, { clientId, productId, variantRef });
      const now = Date.now();
      for (const [key, value] of skuImageUploadTickets.entries()) if (!value || value.expiresAt <= now) skuImageUploadTickets.delete(key);
      const ticket = crypto.randomUUID();
      skuImageUploadTickets.set(ticket, { tenantId: String(account.tenantId), userId: String(account.userId), expiresAt: now + SKU_IMAGE_UPLOAD_TICKET_TTL_MS, clientId, productId, variantRef, name, linkId, associationVersion });
      return sendJson(res, 201, { ticket, expiresAt: new Date(now + SKU_IMAGE_UPLOAD_TICKET_TTL_MS).toISOString() }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_upload_ticket_failed', message: userErrorText(error, '图片上传准备失败，请刷新商品后重新选择图片。') });
    }
  }
  if (pathname === '/api/domain/commands/sku-image-upload' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return; if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    if (!privateObjectStore.encryptionAvailable()) return sendJson(res, 503, { error: 'sku_image_storage_unavailable', message: '图片私有存储目录暂不可用，请联系管理员检查配置。' });
    if (!skuImageUpload.processorReady()) return sendJson(res, 503, { error: 'sku_image_processor_unavailable', message: '图片处理组件尚未就绪，请安装后重启服务再试。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    const ticketId = String(params.get('ticket') || '').trim();
    let uploadMeta = null;
    if (ticketId) {
      const ticket = skuImageUploadTickets.get(ticketId); skuImageUploadTickets.delete(ticketId);
      if (!ticket || ticket.expiresAt <= Date.now() || String(ticket.tenantId) !== String(account.tenantId) || String(ticket.userId) !== String(account.userId)) return sendJson(res, 410, { error: 'sku_image_upload_ticket_expired', message: '图片上传凭证已失效，请重新保存商品后再试。' });
      uploadMeta = ticket;
    } else {
      uploadMeta = { productId: String(params.get('productId') || ''), clientId: String(params.get('clientId') || ''), variantRef: String(params.get('variantRef') || ''), name: String(params.get('name') || ''), linkId: String(params.get('linkId') || ''), associationVersion: params.get('associationVersion') == null ? 0 : Number(params.get('associationVersion')) };
    }
    const productId = String(uploadMeta.productId || ''), clientId = String(uploadMeta.clientId || ''), variantRef = String(uploadMeta.variantRef || ''), uploadName = String(uploadMeta.name || '');
    if (!/^(?:\d+|draft_[\w-]+)$/.test(productId) || !/^[A-Za-z0-9._-]{1,120}$/.test(clientId) || !/^[A-Za-z0-9._:-]{1,180}$/.test(variantRef)) return sendJson(res, 400, { error: 'invalid_sku_image_target', message: '未确定要编辑的规格图片，请先在列表中选择一个规格。' });
    const replaceLinkId = String(uploadMeta.linkId || ''), replaceVersion = Number(uploadMeta.associationVersion || 0), replacing = Boolean(replaceLinkId) || replaceVersion > 0;
    if (replacing && (!UUID_PATTERN.test(replaceLinkId) || !Number.isInteger(replaceVersion) || replaceVersion < 1)) return sendJson(res, 400, { error: 'invalid_sku_image_replace', message: '请选择要替换的原图片后再替换。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    let claimed = false;
    try {
      const body = await readBody(req, skuImageUpload.MAX_BYTES);
      const checked = skuImageUpload.validate({ body, contentType: req.headers['content-type'], name: uploadName });
      await authStore.assertSkuImageTarget(account, { productId, clientId, variantRef });
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ clientId, productId, variantRef, replaceLinkId, replaceVersion: replacing ? replaceVersion : null, sha256: checked.sha256 })).digest('hex');
      const claim = await authStore.claimIdempotency(account, 'sku_image.upload', idempotencyKey, requestHash);
      if (claim.state === 'conflict') return sendJson(res, 409, { error: 'idempotency_conflict', message: '该请求编号已用于其他操作，请刷新页面后重新提交。' });
      if (claim.state === 'processing') return sendJson(res, 409, { error: 'idempotency_in_progress', message: '相同操作正在处理中，请稍候片刻再查看结果。' });
      if (claim.state === 'replay') return sendJson(res, claim.statusCode, claim.body);
      claimed = true;
      if (replacing) {
        const current = (await authStore.listSkuImageLinks(account, { clientId, productId, variantRef })).find(item => item.id === replaceLinkId);
        if (!current || Number(current.associationVersion) !== replaceVersion) throw Object.assign(new Error('该商品图片已被他人修改，请刷新后重新编辑，避免覆盖别人的结果。'), { publicCode: 'sku_image_version_conflict', status: 409 });
        const probed = await skuImageUpload.probe({ body, contentType: req.headers['content-type'], name: uploadName });
        const stored = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image', body });
        const item = await authStore.saveSkuImageVersion(account, {
          clientId, productId, variantRef, linkId: replaceLinkId, associationVersion: replaceVersion,
          id: crypto.randomUUID(), parentObjectId: current.objectId, objectKey: stored.objectKey,
          sha256: probed.input.inputSha256, mimeType: probed.input.inputMimeType, extension: probed.input.inputExtension,
          sizeBytes: probed.input.inputSizeBytes, width: probed.width, height: probed.height,
          processingSummary: { engine: 'browser-local', watermark: true, parentObjectId: current.objectId }
        });
        const response = { item, replaced: true };
        await authStore.completeIdempotency(account, 'sku_image.upload', idempotencyKey, 200, response);
        return sendJson(res, 200, response);
      }
      const processed = await skuImageUpload.processImage({ body, contentType: req.headers['content-type'], name: uploadName });
      const original = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image_original', body });
      const working = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image', body: processed.body });
      const item = await authStore.saveSkuImageUpload(account, { ...processed, body: undefined, objectKey: working.objectKey, original: { ...checked, objectKey: original.objectKey }, id: crypto.randomUUID(), originalId: crypto.randomUUID(), linkId: crypto.randomUUID(), productId, clientId, variantRef });
      const response = { item };
      await authStore.completeIdempotency(account, 'sku_image.upload', idempotencyKey, 201, response);
      return sendJson(res, 201, response);
    } catch (error) {
      if (claimed) await authStore.failIdempotency(account, 'sku_image.upload', idempotencyKey).catch(() => {});
      return sendJson(res, error.publicCode === 'body_too_large' ? 413 : error.status || (error.publicCode ? 400 : 500), { error: error.publicCode === 'body_too_large' ? 'sku_image_too_large' : error.publicCode || 'sku_image_upload_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }
  if (pathname === '/api/domain/commands/sku-image-process' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return; if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    if (!privateObjectStore.encryptionAvailable()) return sendJson(res, 503, { error: 'sku_image_storage_unavailable', message: '图片私有存储目录暂不可用，请联系管理员检查配置。' });
    if (!skuImageUpload.processorReady()) return sendJson(res, 503, { error: 'sku_image_processor_unavailable', message: '图片处理组件尚未就绪，请安装后重启服务再试。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    let claimed = false;
    try {
      const input = await readJsonBody(req, res, 768 * 1024); if (!input) return;
      const targetValid = /^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) && /^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) && /^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef));
      if (!targetValid || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 30 || input.items.some(item => !item || !/^[0-9a-f-]{36}$/i.test(String(item.linkId)) || !Number.isInteger(Number(item.associationVersion)) || Number(item.associationVersion) < 1)) return sendJson(res, 400, { error: 'invalid_sku_image_process', message: '图片处理方式未选择，请选择裁剪、压缩或其他处理后重试。' });
      const operations = skuImageUpload.normalizeOperations(input.operations || []), outputFormat = String(input.outputFormat || 'jpeg').toLowerCase();
      if (!['jpeg', 'png'].includes(outputFormat)) return sendJson(res, 400, { error: 'sku_image_output_format_invalid', message: '不支持该输出格式，请选择 JPG 或 PNG 后重试。' });
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ ...input, operations, outputFormat })).digest('hex');
      const claim = await authStore.claimIdempotency(account, 'sku_image.process', idempotencyKey, requestHash);
      if (claim.state === 'conflict') return sendJson(res, 409, { error: 'idempotency_conflict', message: '该请求编号已用于其他操作，请刷新页面后重新提交。' });
      if (claim.state === 'processing') return sendJson(res, 409, { error: 'idempotency_in_progress', message: '相同操作正在处理中，请稍候片刻再查看结果。' });
      if (claim.state === 'replay') return sendJson(res, claim.statusCode, claim.body);
      claimed = true;
      const results = [];
      for (const requested of input.items) {
        const scoped = { clientId: String(input.clientId), productId: String(input.productId), variantRef: String(input.variantRef), linkId: String(requested.linkId), associationVersion: Number(requested.associationVersion) };
        const current = (await authStore.listSkuImageLinks(account, scoped)).find(item => item.id === scoped.linkId);
        if (!current || current.associationVersion !== scoped.associationVersion) throw Object.assign(new Error('该商品图片已被他人修改，请刷新后重新编辑，避免覆盖别人的结果。'), { publicCode: 'sku_image_version_conflict', status: 409 });
        const source = await authStore.getSkuImageVersionSource(account, { ...scoped, restoreOriginal: input.restoreOriginal === true, undo: input.undo === true });
        const body = await privateObjectStore.readEncryptedBuffer(source.private_object_key);
        if (body.length !== Number(source.size_bytes) || crypto.createHash('sha256').update(body).digest('hex') !== source.sha256) throw new Error('sku image integrity check failed');
        const processed = await skuImageUpload.processImage({ body, contentType: source.mime_type, name: 'source' + source.extension, operations, outputFormat });
        const stored = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image', body: processed.body });
        results.push(await authStore.saveSkuImageVersion(account, { ...scoped, ...processed, body: undefined, objectKey: stored.objectKey, id: crypto.randomUUID(), parentObjectId: current.objectId, processingSummary: { ...processed.processingSummary, restoreOriginal: input.restoreOriginal === true } }));
      }
      const response = { items: results };
      await authStore.completeIdempotency(account, 'sku_image.process', idempotencyKey, 200, response);
      return sendJson(res, 200, response);
    } catch (error) {
      if (claimed) await authStore.failIdempotency(account, 'sku_image.process', idempotencyKey).catch(() => {});
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_process_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }
  if (pathname === '/api/domain/commands/sku-image-import' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return; if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    if (!privateObjectStore.encryptionAvailable()) return sendJson(res, 503, { error: 'sku_image_storage_unavailable', message: '图片私有存储目录暂不可用，请联系管理员检查配置。' }); if (!skuImageUpload.processorReady()) return sendJson(res, 503, { error: 'sku_image_processor_unavailable', message: '图片处理组件尚未就绪，请安装后重启服务再试。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim(); if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' }); let claimed = false;
    try {
      const input = await readJsonBody(req, res, 16 * 1024); if (!input) return;
      if (!['collection', 'online', 'network'].includes(input.sourceType) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.sourceId)) || !/^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef))) return sendJson(res, 400, { error: 'invalid_sku_image_source', message: '图片来源不正确，请重新选择图片后再操作。' });
      await authStore.assertSkuImageTarget(account, input);
      let sourceUrl;
      if (input.sourceType === 'collection') {
        const sourceIndex = Number(input.sourceIndex ?? 0);
        const sourceGroup = input.sourceGroup === 'detail' ? 'detail' : input.sourceGroup === 'sku' || input.sourceGroup == null || input.sourceGroup === '' ? 'sku' : '';
        if (!sourceGroup || !Number.isInteger(sourceIndex) || sourceIndex < 0 || sourceIndex > 199) return sendJson(res, 400, { error: 'invalid_sku_image_source', message: '图片来源不正确，请重新选择图片后再操作。' });
        const document = await authStore.getDocument(account, 'erp_collected_products'), rows = Array.isArray(document?.payload) ? document.payload : [], item = rows.find(row => String(row?.id || '') === String(input.sourceId));
        const collected = item ? collectionImageSources.sources(item)[sourceGroup] : [];
        sourceUrl = collected[sourceIndex] && collected[sourceIndex].url;
      } else if (input.sourceType === 'online') {
        sourceUrl = (await resolveOnlineSkuSnapshotSource(account, input)).sourceUrl;
      } else {
        sourceUrl = String(input.sourceUrl || '').trim();
        if (!sourceUrl || sourceUrl.length > 2048 || !isSafeExternalImageUrl(sourceUrl)) return sendJson(res, 400, { error: 'invalid_sku_image_network_url', message: '网络图片必须填写完整的公网 HTTPS 图片链接，请修改后重试。' });
      }
      if (input.sourceUrl && String(input.sourceUrl) !== sourceUrl) return sendJson(res, 409, { error: 'sku_image_source_changed', message: '这张来源图片已变化，请重新打开图片列表后再导入。' });
      if (!sourceUrl || typeof aiProvider.downloadImage !== 'function') return sendJson(res, 409, { error: 'sku_image_source_unavailable', message: '原图暂时无法读取，请稍后重试或重新上传。' });
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ clientId: input.clientId, productId: input.productId, variantRef: input.variantRef, sourceType: input.sourceType, sourceId: input.sourceId, sourceGroup: input.sourceType === 'collection' ? String(input.sourceGroup || 'sku') : '', sourceIndex: input.sourceType === 'collection' ? Number(input.sourceIndex || 0) : null, sourceUrlHash: crypto.createHash('sha256').update(sourceUrl).digest('hex') })).digest('hex'), claim = await authStore.claimIdempotency(account, 'sku_image.import', idempotencyKey, requestHash);
      if (claim.state === 'conflict') return sendJson(res, 409, { error: 'idempotency_conflict', message: '该请求编号已用于其他操作，请刷新页面后重新提交。' }); if (claim.state === 'processing') return sendJson(res, 409, { error: 'idempotency_in_progress', message: '相同操作正在处理中，请稍候片刻再查看结果。' }); if (claim.state === 'replay') return sendJson(res, claim.statusCode, claim.body); claimed = true;
      const downloaded = input.sourceType === 'network'
        ? await downloadExternalImage(sourceUrl, 0).then(result => ({ buffer: result.buffer, mime: result.contentType, extension: result.extension.replace(/^\./, '') }))
        : await aiProvider.downloadImage(sourceUrl, { allowSourceFormats: true });
      const processed = await skuImageUpload.processImage({ body: downloaded.buffer, contentType: downloaded.mime, name: 'source.' + downloaded.extension });
      const original = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image_original', body: downloaded.buffer }), working = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image', body: processed.body });
      const item = await authStore.saveSkuImageUpload(account, { ...processed, body: undefined, objectKey: working.objectKey, original: { ...skuImageUpload.validate({ body: downloaded.buffer, contentType: downloaded.mime, name: 'source.' + downloaded.extension }), objectKey: original.objectKey }, sourceType: input.sourceType, id: crypto.randomUUID(), originalId: crypto.randomUUID(), linkId: crypto.randomUUID(), productId: input.productId, clientId: input.clientId, variantRef: input.variantRef });
      const response = { item }; await authStore.completeIdempotency(account, 'sku_image.import', idempotencyKey, 201, response); return sendJson(res, 201, response);
    } catch (error) { if (claimed) await authStore.failIdempotency(account, 'sku_image.import', idempotencyKey).catch(() => {}); return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_import_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }
  if (pathname === '/api/domain/commands/sku-image-copy' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return; if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim(); if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    let claimed = false;
    try {
      const input = await readJsonBody(req, res, 32 * 1024); if (!input) return;
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef)) || !Array.isArray(input.linkIds) || input.linkIds.length < 1 || input.linkIds.length > 30 || input.linkIds.some(id => !/^[0-9a-f-]{36}$/i.test(String(id))) || !Array.isArray(input.targetVariantRefs) || input.targetVariantRefs.length < 1 || input.targetVariantRefs.length > 30 || input.targetVariantRefs.some(ref => !/^[A-Za-z0-9._:-]{1,180}$/.test(String(ref)) || String(ref) === String(input.variantRef))) return sendJson(res, 400, { error: 'invalid_sku_image_copy', message: '请选择要复制到的目标规格后再复制图片。' });
      input.linkIds = Array.from(new Set(input.linkIds.map(String))); input.targetVariantRefs = Array.from(new Set(input.targetVariantRefs.map(String)));
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'), claim = await authStore.claimIdempotency(account, 'sku_image.copy', idempotencyKey, requestHash);
      if (claim.state === 'conflict') return sendJson(res, 409, { error: 'idempotency_conflict', message: '该请求编号已用于其他操作，请刷新页面后重新提交。' }); if (claim.state === 'processing') return sendJson(res, 409, { error: 'idempotency_in_progress', message: '相同操作正在处理中，请稍候片刻再查看结果。' }); if (claim.state === 'replay') return sendJson(res, claim.statusCode, claim.body); claimed = true;
      const response = await authStore.copySkuImageLinks(account, input); await authStore.completeIdempotency(account, 'sku_image.copy', idempotencyKey, 200, response); return sendJson(res, 200, response);
    } catch (error) { if (claimed) await authStore.failIdempotency(account, 'sku_image.copy', idempotencyKey).catch(() => {}); return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_copy_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }
  if (pathname === '/api/domain/queries/sku-image-collection-sources' && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看商品采集来源的权限，请联系管理员授权。' });
    try {
      const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
      const collectionId = String(query.get('collectionId') || '').trim();
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(collectionId)) return sendJson(res, 400, { error: 'invalid_collection_id', message: '采集记录编号不正确，请从采集箱重新进入新增商品。' }, { 'Cache-Control': 'no-store' });
      const document = await authStore.getDocument(account, 'erp_collected_products');
      const rows = Array.isArray(document && document.payload) ? document.payload : [];
      const item = rows.find(row => String(row && row.id || '') === collectionId);
      if (!item) return sendJson(res, 404, { error: 'collection_source_not_found', message: '没有找到对应的采集记录，请返回采集箱重新进入。' }, { 'Cache-Control': 'no-store' });
      const sources = collectionImageSources.sources(item);
      return sendJson(res, 200, { collectionId, sku: sources.sku, detail: sources.detail }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return sendJson(res, 500, { error: 'collection_source_read_failed', message: '读取采集图片来源失败，请稍后重试。' }, { 'Cache-Control': 'no-store' });
    }
  }
  if (pathname === '/api/domain/commands/sku-image-candidates' && ['GET', 'POST'].includes(req.method)) {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (req.method === 'POST' && !requireCsrf(req, res)) return;
    try {
      const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
      const input = req.method === 'POST' ? await readJsonBody(req, res, 16 * 1024) : { clientId: query.get('clientId'), productId: query.get('productId'), variantRef: query.get('variantRef'), limit: query.get('limit') };
      if (req.method === 'POST' && !input) return;
      const items = await authStore.listSkuImageCandidates(account, { clientId: input.clientId, productId: input.productId, variantRef: input.variantRef, limit: input.limit });
      return sendJson(res, 200, { items });
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_candidates_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }

  if (pathname === '/api/domain/ai-beans/balance' && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    try {
      const wallet = await aiBeanStore.balance(account.tenantId);
      const pricing = await aiPricingStore.current();
      return sendJson(res, 200, {
        balanceBean: wallet.balanceBean,
        frozenBean: wallet.frozenBean,
        imageCostBean: pricing.image.effectiveBean,
        imagePricing: pricing.image,
        currencyName: 'AI豆',
        officialChannelAvailable: await aiConfigStore.availableOfficial(account, ['image-redraw']).then(() => true, () => false)
      }, { 'Cache-Control': 'no-store' });
    } catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'ai_bean_balance_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }

  if (pathname === '/api/domain/ai-beans/events' && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    try {
      const eventType = String(params.get('eventType') || '').trim();
      const result = await aiBeanStore.listEvents(account.tenantId, { limit: params.get('limit'), beforeId: params.get('beforeId'), eventType, hideSettledFreeze: true });
      return sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
    } catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'ai_bean_events_read_failed', message: userErrorText(error, 'AI豆流水读取失败，请稍后刷新重试。') }, { 'Cache-Control': 'no-store' }); }
  }

  if (pathname === '/api/domain/commands/sku-image-ai-prompt-details' && req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try {
      const taskId = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams.get('taskId');
      const job = await authStore.getSkuImageAiPromptTask(account, taskId);
      const canReadPromptContents = account.isSystemAdmin === true || account.memberType === 'owner';
      const snapshots = {};
      const types = { template: 'template', sellingPoints: 'selling_points', rawResponse: 'raw_response', finalPrompt: 'final_prompt' };
      for (const [name, type] of Object.entries(types)) {
        const reference = job.context?.promptSnapshots?.[name];
        if (!reference) { snapshots[name] = null; continue; }
        if (!canReadPromptContents) {
          snapshots[name] = { version: null, sha256: reference.contentHash, size: reference.size, chars: reference.chars, createdAt: null, content: '', masked: true };
          continue;
        }
        const record = await skuImagePromptSnapshot.read(privateObjectStore, job.id, type, reference);
        snapshots[name] = { version: record.version, sha256: reference.contentHash, size: reference.size, chars: reference.chars, createdAt: record.createdAt, content: record.content };
      }
      await authStore.recordAudit(account, 'sku.image.ai.prompt_details.read', 'background_job', job.id, 'success', {
        phase: job.context?.phase || job.state, snapshots: Object.fromEntries(Object.entries(job.context?.promptSnapshots || {}).filter(([, ref]) => ref).map(([name, ref]) => [name, { sha256: ref.contentHash, size: ref.size, objectRef: ref.objectKey }]))
      });
      return sendJson(res, 200, { taskId: job.id, taskName: job.context?.taskName || `AI图片重绘 · ${job.id.slice(-8)}`, state: job.state, phase: job.context?.phase || 'queued', diagnostic: job.context?.diagnostic || {}, snapshots }, { 'Cache-Control': 'no-store' });
    } catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'sku_image_ai_prompt_details_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}, { 'Cache-Control': 'no-store' }); }
  }

  if (pathname === '/api/domain/commands/sku-image-ai-batch' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    if (!privateObjectStore.encryptionAvailable() || !skuImageUpload.processorReady()) return sendJson(res, 503, { error: 'sku_image_processor_unavailable', message: '图片私有存储或处理服务当前不可用。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    try {
      const input = await readJsonBody(req, res, 512 * 1024); if (!input) return;
      const items = Array.isArray(input.items) ? input.items : [];
      const sellingPointsSource = String(input.sellingPointsSource || '');
      const imageTextLanguage = skuSellingPointsLanguage.normalizeLanguage(input.imageTextLanguage || 'ru');
      if (items.length < 1 || items.length > 1380 || !['ai', 'manual'].includes(sellingPointsSource)) return sendJson(res, 400, { error: 'invalid_sku_image_ai_batch_request', message: '请勾选不超过1380个图片和模板组合，并选择已确认的卖点来源后再开始。' });
      const sellingPoints = String(input.sellingPoints || '').trim();
      const configuration = await aiConfigStore.availableOfficial(account, ['image-redraw']);
      const customizationAllowed = (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
      const promptBodies = new Map();
      const sourceCache = new Map();
      const referenceCache = new Map();
      const trustedItems = [];
      const candidateSequences = new Map();
      for (const item of items) {
        const trusted = await buildTrustedSkuImageRedrawTask(account, { ...item, capability: 'image-redraw', billingChannel: 'official', sellingPoints, sellingPointsSource, imageTextLanguage, analysisProof: input.analysisProof }, {
          sellingPoints, sellingPointsSource, imageTextLanguage, configuration, customizationAllowed, promptBodies, sourceCache, referenceCache
        });
        const sequenceKey = trusted.context.sourceHash + '|' + trusted.context.templateKey;
        const candidateSequence = (candidateSequences.get(sequenceKey) || 0) + 1;
        if (candidateSequence > 9) return sendJson(res, 400, { error: 'sku_image_batch_candidate_count_invalid', message: '同一图片和模板最多生成9张候选，请减少数量后重新提交。' });
        candidateSequences.set(sequenceKey, candidateSequence);
        trusted.context.candidateSequence = candidateSequence;
        trusted.fingerprint = skuImageAnalysisProof.digest(trusted.fingerprint + '|candidate:' + candidateSequence);
        trusted.requestHash = skuImageAnalysisProof.digest(JSON.stringify({ fingerprint: trusted.fingerprint, billingChannel: 'official', capability: 'image-redraw', candidateSequence }));
        trustedItems.push(trusted);
      }
      const uniqueFingerprints = new Set(trustedItems.map(item => item.fingerprint));
      if (uniqueFingerprints.size !== trustedItems.length) return sendJson(res, 409, { error: 'sku_image_batch_duplicate', message: '批量选择中存在重复的图片和模板，请去重后重新提交。' });
      const targetScopes = new Set(trustedItems.map(item => [item.context.clientId, item.context.productId, item.context.variantRef].join('|')));
      if (targetScopes.size !== 1) return sendJson(res, 400, { error: 'sku_image_batch_scope_invalid', message: '批量重绘只能处理当前商品的同一规格图片，请重新选择。' });
      const requestHash = skuImageAnalysisProof.digest(JSON.stringify({ sellingPointsHash: skuImageAnalysisProof.digest(sellingPoints), imageTextLanguage, items: trustedItems.map(item => item.requestHash) }));
      const parentId = 'sync-sku-ai-' + crypto.randomUUID();
      const queued = await skuImageAiEnqueuer.enqueueBatch({
        account, idempotencyKey, requestHash,
        parentTask: { id: parentId, article: trustedItems[0].context.productId, sku: trustedItems[0].context.variantRef },
        items: trustedItems
      });
      return sendJson(res, 202, queued.response, queued.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_ai_batch_enqueue_failed', message: userErrorText(error, '批量AI图片任务入队失败，请稍后重试。') });
    }
  }

  if (pathname === '/api/domain/commands/sku-image-ai-prompt-details' && req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try {
      const taskId = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams.get('taskId');
      const job = await authStore.getSkuImageAiPromptTask(account, taskId);
      const canReadPromptContents = account.isSystemAdmin === true || (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
      const snapshots = {};
      const types = { template: 'template', sellingPoints: 'selling_points', rawResponse: 'raw_response', finalPrompt: 'final_prompt' };
      for (const [name, type] of Object.entries(types)) {
        const reference = job.context?.promptSnapshots?.[name];
        if (!reference) { snapshots[name] = null; continue; }
        if (!canReadPromptContents) {
          snapshots[name] = { version: null, sha256: reference.contentHash, size: reference.size, chars: reference.chars, createdAt: null, content: '', masked: true };
          continue;
        }
        const record = await skuImagePromptSnapshot.read(privateObjectStore, job.id, type, reference);
        snapshots[name] = { version: record.version, sha256: reference.contentHash, size: reference.size, chars: reference.chars, createdAt: record.createdAt, content: record.content };
      }
      await authStore.recordAudit(account, 'sku.image.ai.prompt_details.read', 'background_job', job.id, 'success', {
        phase: job.context?.phase || job.state, snapshots: Object.fromEntries(Object.entries(job.context?.promptSnapshots || {}).filter(([, ref]) => ref).map(([name, ref]) => [name, { sha256: ref.contentHash, size: ref.size, objectRef: ref.objectKey }]))
      });
      return sendJson(res, 200, { taskId: job.id, taskName: job.context?.taskName || `AI图片重绘 · ${job.id.slice(-8)}`, state: job.state, phase: job.context?.phase || 'queued', diagnostic: job.context?.diagnostic || {}, snapshots }, { 'Cache-Control': 'no-store' });
    } catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'sku_image_ai_prompt_details_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}, { 'Cache-Control': 'no-store' }); }
  }

  if (pathname === '/api/domain/commands/sku-image-ai' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!requireCsrf(req, res)) return; if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    if (!privateObjectStore.encryptionAvailable() || !skuImageUpload.processorReady()) return sendJson(res, 503, { error: 'sku_image_processor_unavailable', message: '图片私有存储或处理服务当前不可用' }); const idempotencyKey = String(req.headers['idempotency-key'] || '').trim(); if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    try {
      const input = await readJsonBody(req, res, 16 * 1024); if (!input) return;
      const capability = String(input.capability || '');
      const billingChannel = String(input.billingChannel || '');
      const commonInvalid = !['image-redraw','image-translation'].includes(capability) || !UUID_PATTERN.test(String(input.linkId)) || !Number.isInteger(Number(input.associationVersion)) || !/^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef));
      if (commonInvalid) return sendJson(res, 400, { error: 'invalid_sku_image_ai_request', message: 'AI图片请求参数不完整，请重新选择图片后再试。' });
      if (capability === 'image-redraw' && (billingChannel !== 'official' || !['image-main','image-scene','image-selling','image-accessory','image-white-base','image-size'].includes(String(input.templateKey)))) return sendJson(res, 400, { error: 'invalid_sku_image_ai_request', message: 'AI重绘模板或通道不正确，请重新选择模板后再试。' });
      if (capability === 'image-translation' && (!['official','own'].includes(billingChannel) || !['zh','en'].includes(String(input.sourceLanguage || '')) || String(input.targetLanguage || '') !== 'ru' || billingChannel === 'own' && !UUID_PATTERN.test(String(input.configurationId || '')))) return sendJson(res, 400, { error: 'invalid_sku_image_ai_request', message: '图片翻译方向或AI通道不正确，请重新选择后再试。' });
      if (billingChannel === 'own') if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const scoped = { clientId: String(input.clientId), productId: String(input.productId), variantRef: String(input.variantRef), linkId: String(input.linkId), associationVersion: Number(input.associationVersion) };
      const productScope = { clientId: scoped.clientId, productId: scoped.productId, variantRef: scoped.variantRef };
      await authStore.assertSkuImageTarget(account, scoped);
      const source = await authStore.getSkuImageVersionSource(account, scoped);
      const sourceHash = String(source.sha256);
      if (capability === 'image-translation') {
        const configuration = billingChannel === 'official'
          ? await aiConfigStore.availableOfficial(account, ['image-translation'])
          : await aiConfigStore.available(account, String(input.configurationId), ['image-translation']);
        const sourceLanguage = String(input.sourceLanguage), targetLanguage = 'ru';
        const fingerprint = skuImageAnalysisProof.digest([account.tenantId, account.userId, scoped.clientId, scoped.productId, scoped.variantRef, scoped.linkId, scoped.associationVersion, sourceHash, capability, billingChannel, configuration.id, sourceLanguage, targetLanguage].join('|'));
        const requestHash = skuImageAnalysisProof.digest(JSON.stringify({ fingerprint, billingChannel, capability, sourceLanguage, targetLanguage }));
        const queued = await skuImageAiEnqueuer({
          account, idempotencyKey, requestHash, fingerprint,
          context: { ...scoped, capability, billingChannel, sourceHash, configurationId: String(configuration.id), sourceLanguage, targetLanguage }
        });
        return sendJson(res, 202, queued.response, queued.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
      }
      const sellingPoints = String(input.sellingPoints || '').trim();
      if (!sellingPoints || sellingPoints.length > 5000) return sendJson(res, 400, { error: 'invalid_sku_image_selling_points', message: '请填写不超过5000字的中文卖点后再开始生图' });
      const requestedSellingPointsSource = input.sellingPointsSource === undefined ? '' : String(input.sellingPointsSource);
      if (requestedSellingPointsSource && !['ai', 'manual'].includes(requestedSellingPointsSource)) return sendJson(res, 400, { error: 'invalid_sku_image_selling_points_source', message: '请选择卖点的来源（手写、AI解析或其他）后再提交。' });
      let sellingPointsSource = requestedSellingPointsSource || 'ai';
      let proof = sellingPointsSource === 'ai' ? skuImageAnalysisProof.verify(input.analysisProof, account, productScope, CSRF_SECRET_CONFIG.secret) : null;
      if (sellingPointsSource === 'ai' && (!proof || String(proof.resultHash) !== skuImageAnalysisProof.digest(sellingPoints))) {
        if (requestedSellingPointsSource === 'ai') return sendJson(res, 409, { error: 'sku_redraw_analysis_required', message: 'AI卖点证明无效或卖点已编辑，请改为手动卖点后再开始生图' });
        sellingPointsSource = 'manual';
        proof = null;
      }
      if (sellingPointsSource === 'ai') {
        const sellingPointRules = await aiProductRuleStore.effective('sellingPoints', { requireGlobal: true, includeMetadata: true });
        const sellingPointRuleHash = skuImageAnalysisProof.digest(JSON.stringify({ global: skuImageAnalysisProof.digest(sellingPointRules.global), sellingPoints: skuImageAnalysisProof.digest(sellingPointRules.item), versions: sellingPointRules.versions }));
        if (String(proof.ruleHash || '') !== sellingPointRuleHash) return sendJson(res, 409, { error: 'sku_redraw_analysis_required', message: '卖点规则已变更，请重新解析或改为手动卖点后再开始生图' });
      }
      const configuration = await aiConfigStore.availableOfficial(account, ['image-redraw']);
      const sellingPointResultHash = skuImageAnalysisProof.digest(sellingPoints);
      const promptBody = await aiPromptStore.effective(account, String(input.templateKey), { officialOnly: !((STANDALONE_MODE || await authStore.canUseCustomConfigurations(account))) });
      requireSkuImagePromptReady(promptBody);
      const promptHash = skuImageAnalysisProof.digest(promptBody);
      const fingerprint = skuImageAnalysisProof.digest([account.tenantId, account.userId, scoped.clientId, scoped.productId, scoped.variantRef, scoped.linkId, scoped.associationVersion, sourceHash, input.templateKey, promptHash, sellingPointsSource, sellingPointResultHash].join('|'));
      const requestHash = skuImageAnalysisProof.digest(JSON.stringify({ fingerprint, billingChannel: 'official', capability: 'image-redraw' }));
      const queued = await skuImageAiEnqueuer({
        account, idempotencyKey, requestHash, fingerprint,
        context: { ...scoped, capability: 'image-redraw', sourceHash, promptHash, sellingPointResultHash, sellingPoints, sellingPointsSource, sellingPointSourceHash: sellingPointResultHash, configurationId: String(configuration.id), templateKey: String(input.templateKey), billingChannel: 'official' },
        snapshotFactory: async taskId => ({
          template: await skuImagePromptSnapshot.save(privateObjectStore, account.tenantId, taskId, 'template', promptBody),
          sellingPoints: await skuImagePromptSnapshot.save(privateObjectStore, account.tenantId, taskId, 'selling_points', sellingPoints),
          rawResponse: null, finalPrompt: null
        })
      });
      return sendJson(res, 202, queued.response, queued.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_ai_enqueue_failed', message: error.publicCode ? error.message : 'AI图片任务入队失败，请稍后重试' }); }
  }
  if (pathname === '/api/domain/commands/sku-image-ai-adopt' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!requireCsrf(req, res)) return; if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' }); const idempotencyKey = String(req.headers['idempotency-key'] || '').trim(); if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' }); let claimed = false;
    try { const input = await readJsonBody(req, res, 16 * 1024); if (!input) return; if (!UUID_PATTERN.test(String(input.candidateId)) || !UUID_PATTERN.test(String(input.linkId)) || !Number.isInteger(Number(input.associationVersion)) || !['replace', 'append'].includes(input.mode) || !/^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef))) return sendJson(res, 400, { error: 'invalid_sku_image_candidate', message: '所选候选图片不正确，请重新选择后再操作。' }); const requestHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'), claim = await authStore.claimIdempotency(account, 'sku_image.ai.adopt', idempotencyKey, requestHash); if (claim.state === 'conflict') return sendJson(res, 409, { error: 'idempotency_conflict', message: '该请求编号已用于其他操作，请刷新页面后重新提交。' }); if (claim.state === 'processing') return sendJson(res, 409, { error: 'idempotency_in_progress', message: '相同操作正在处理中，请稍候片刻再查看结果。' }); if (claim.state === 'replay') return sendJson(res, claim.statusCode, claim.body); claimed = true; const response = await authStore.adoptSkuImageCandidate(account, input); await authStore.completeIdempotency(account, 'sku_image.ai.adopt', idempotencyKey, 200, response); return sendJson(res, 200, response); }
    catch (error) { if (claimed) await authStore.failIdempotency(account, 'sku_image.ai.adopt', idempotencyKey).catch(() => {}); return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_candidate_adopt_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }
  if (pathname === '/api/domain/commands/sku-image-links' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return; if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    let claimed = false;
    try {
      const input = await readJsonBody(req, res, 32 * 1024);
      if (!input || !/^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef)) || !Array.isArray(input.linkIds) || input.linkIds.length < 1 || input.linkIds.length > 30 || !input.linkVersions || typeof input.linkVersions !== 'object') return sendJson(res, 400, { error: 'invalid_sku_image_links', message: '图片与规格的关联数据不完整，请刷新后重新设置。' });
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const claim = await authStore.claimIdempotency(account, 'sku_image.links.update', idempotencyKey, requestHash);
      if (claim.state === 'conflict') return sendJson(res, 409, { error: 'idempotency_conflict', message: '该请求编号已用于其他操作，请刷新页面后重新提交。' });
      if (claim.state === 'processing') return sendJson(res, 409, { error: 'idempotency_in_progress', message: '相同操作正在处理中，请稍候片刻再查看结果。' });
      if (claim.state === 'replay') return sendJson(res, claim.statusCode, claim.body);
      claimed = true;
      const response = await authStore.updateSkuImageLinks(account, input);
      await authStore.completeIdempotency(account, 'sku_image.links.update', idempotencyKey, 200, response);
      return sendJson(res, 200, response);
    } catch (error) {
      if (claimed) await authStore.failIdempotency(account, 'sku_image.links.update', idempotencyKey).catch(() => {});
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_links_update_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }
  if (pathname === '/api/domain/queries/sku-image-links' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try { const input = await readJsonBody(req, res, 16 * 1024); if (!input) return; if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef))) return sendJson(res, 400, { error: 'invalid_sku_image_target', message: '未确定要编辑的规格图片，请先在列表中选择一个规格。' }); return sendJson(res, 200, { images: await authStore.listSkuImageLinks(account, input) }); } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_list_failed', message: userErrorText(error, '读取规格图片失败，请刷新后重试。') }); }
  }
  if (pathname === '/api/domain/commands/sku-image-links' && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try { const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams; const input = { clientId: query.get('clientId'), productId: query.get('productId'), variantRef: query.get('variantRef') }; if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef))) return sendJson(res, 400, { error: 'invalid_sku_image_target', message: '未确定要编辑的规格图片，请先在列表中选择一个规格。' }); return sendJson(res, 200, { images: await authStore.listSkuImageLinks(account, input) }); } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_list_failed' }); }
  }
  if (pathname === '/api/domain/commands/sku-image-download' && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try {
      const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams, ids = Array.from(new Set(String(query.get('ids') || '').split(',').filter(Boolean)));
      if (ids.length < 2 || ids.length > 30 || ids.some(id => !UUID_PATTERN.test(id))) return sendJson(res, 400, { error: 'sku_image_download_invalid', message: '图片下载参数不正确，请重新选择图片后再下载。' });
      const files = [];
      for (let index = 0; index < ids.length; index++) { const item = await authStore.getSkuImageObject(account, ids[index]); if (!item) return sendJson(res, 404, { error: 'sku_image_not_found', message: '未找到这张图片，请刷新页面后重试。' }); const body = await privateObjectStore.readEncryptedBuffer(item.private_object_key); if (body.length !== Number(item.size_bytes) || crypto.createHash('sha256').update(body).digest('hex') !== item.sha256) throw new Error('sku image integrity check failed'); files.push({ name: `sku_${String(index + 1).padStart(2, '0')}_${item.width || 0}x${item.height || 0}${item.extension}`, body }); }
      const archive = skuImageUpload.createZip(files), stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); await authStore.recordAudit(account, 'sku.image.download.batch', 'sku_image_archive', null, 'success', { imageCount: files.length, sizeBytes: archive.length }); const requestedName = String(query.get('filename') || '').trim(); const archiveName = /^[\w.-]{1,120}$/.test(requestedName) ? requestedName : `SKU-images-${stamp}.zip`; const headers = securityHeaders(); delete headers['Content-Security-Policy']; res.writeHead(200, Object.assign(headers, { 'Content-Type': 'application/zip', 'Content-Length': archive.length, 'Content-Disposition': `attachment; filename="${archiveName}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })); res.end(archive); return;
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_download_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }
  if (pathname === '/api/domain/commands/sku-image-download-external' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    // 限流：每用户每分钟最多 10 次批量下载
    const limitKey = 'u:' + String(account && (account.userId || account.id || account.username) || req.socket.remoteAddress || 'unknown');
    const retryAfter = consumeWindow(externalDownloadWindows, limitKey, EXTERNAL_DOWNLOAD_LIMIT.windowMs, EXTERNAL_DOWNLOAD_LIMIT.maximum);
    if (retryAfter) return sendJson(res, 429, { error: 'download_too_many_requests', message: '文件下载请求过于频繁，请稍后再试。', retryAfter });
    try {
      const body = await readJsonBody(req, res, 128 * 1024); if (!body) return;
      const rawUrls = Array.isArray(body && body.urls) ? body.urls.filter(u => typeof u === 'string' && u.trim().length > 0 && u.trim().length <= 2048).map(u => u.trim()) : [];
      if (!rawUrls.length) return sendJson(res, 400, { error: '请选择需要下载的图片' });
      if (rawUrls.length > EXTERNAL_IMAGE_DOWNLOAD.maxImages) return sendJson(res, 400, { error: '单次最多下载 ' + EXTERNAL_IMAGE_DOWNLOAD.maxImages + ' 张图片' });
      const urls = rawUrls.slice(0, EXTERNAL_IMAGE_DOWNLOAD.maxImages);
      const sku = sanitizeFilename(body && body.sku) || 'image';
      let overallTimer;
      const results = await Promise.race([
        mapWithConcurrency(urls, EXTERNAL_IMAGE_DOWNLOAD.concurrency, downloadExternalImage),
        new Promise(function (_, reject) { overallTimer = setTimeout(function () { reject(Object.assign(new Error('批量图片下载超过2分钟已自动停止，请减少本次选择的图片数量后分批重试。'), { code: 'batch_timeout' })); }, EXTERNAL_IMAGE_DOWNLOAD.totalTimeoutMs); })
      ]).finally(function () { clearTimeout(overallTimer); });
      const okResults = results.filter(function (r) { return r && r.ok; });
      const failResults = results.filter(function (r) { return r && !r.ok; });
      if (!okResults.length) return sendJson(res, 422, { error: '所有图片下载失败', failed: failResults.map(function (r) { return { index: r.index + 1, reason: r.error }; }) });
      const totalBytes = okResults.reduce(function (sum, r) { return sum + r.size; }, 0);
      if (totalBytes > EXTERNAL_IMAGE_DOWNLOAD.maxTotalBytes) return sendJson(res, 413, { error: '本次下载总大小超过限制（200MB）' });
      const files = okResults.map(function (r) { return { name: buildImageFilename(r.index, sku, r.extension), body: r.buffer, type: r.contentType }; });
      if (failResults.length) {
        const lines = ['以下图片下载失败：'];
        failResults.forEach(function (r) { lines.push('  ' + (r.index + 1) + '. ' + r.sourceUrl + ' 原因：' + r.error); });
        files.push({ name: 'download-errors.txt', body: Buffer.from(lines.join('\n'), 'utf8'), type: 'text/plain' });
      }
      const headers = securityHeaders(); delete headers['Content-Security-Policy'];
      const counts = { 'X-Download-Success-Count': String(okResults.length), 'X-Download-Failed-Count': String(failResults.length) };
      await authStore.recordAudit(account, 'sku.image.download.external', 'sku_image_archive', null, 'success', { imageCount: okResults.length, failedCount: failResults.length, totalBytes: totalBytes }).catch(() => {});
      if (okResults.length === 1 && !failResults.length) {
        // 单张且无失败：直接返回图片附件（不打包 zip）
        const one = files[0];
        res.writeHead(200, Object.assign(headers, counts, { 'Content-Type': one.type, 'Content-Length': one.body.length, 'Content-Disposition': 'attachment; filename="' + one.name + '"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }));
        res.end(one.body); return;
      }
      const archive = skuImageUpload.createZip(files);
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
      res.writeHead(200, Object.assign(headers, counts, { 'Content-Type': 'application/zip', 'Content-Length': archive.length, 'Content-Disposition': 'attachment; filename="SKU-external-' + stamp + '.zip"', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }));
      res.end(archive); return;
    } catch (error) {
      if (error && error.code === 'batch_timeout') return sendJson(res, 504, { error: 'batch_timeout', message: userErrorText(error, '批量图片下载超过2分钟已自动停止，请减少本次选择的图片数量后分批重试。') });
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_download_external_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }
  const skuImageLinkMatch = pathname.match(/^\/api\/domain\/commands\/sku-image-links\/([0-9a-f-]{36})$/i);
  if (skuImageLinkMatch && req.method === 'DELETE') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!requireCsrf(req, res)) return; if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    let claimed = false;
    try {
      const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
      let bodyInput = null;
      if (Number(req.headers['content-length'] || 0) > 0) { bodyInput = await readJsonBody(req, res, 16 * 1024); if (!bodyInput) return; }
      const input = { linkId: skuImageLinkMatch[1], clientId: bodyInput && bodyInput.clientId || query.get('clientId'), productId: bodyInput && bodyInput.productId || query.get('productId'), variantRef: bodyInput && bodyInput.variantRef || query.get('variantRef'), associationVersion: Number(bodyInput && bodyInput.associationVersion || query.get('associationVersion')) };
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(input.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(input.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(input.variantRef)) || !Number.isInteger(input.associationVersion) || input.associationVersion < 1) return sendJson(res, 400, { error: 'invalid_sku_image_target', message: '未确定要编辑的规格图片，请先在列表中选择一个规格。' });
      const requestHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const claim = await authStore.claimIdempotency(account, 'sku_image.link.remove', idempotencyKey, requestHash);
      if (claim.state === 'conflict') return sendJson(res, 409, { error: 'idempotency_conflict', message: '该请求编号已用于其他操作，请刷新页面后重新提交。' });
      if (claim.state === 'processing') return sendJson(res, 409, { error: 'idempotency_in_progress', message: '相同操作正在处理中，请稍候片刻再查看结果。' });
      if (claim.state === 'replay') return sendJson(res, claim.statusCode, claim.body);
      claimed = true;
      const response = await authStore.removeSkuImageLink(account, input);
      await authStore.completeIdempotency(account, 'sku_image.link.remove', idempotencyKey, 200, response);
      return sendJson(res, 200, response);
    } catch (error) {
      if (claimed) await authStore.failIdempotency(account, 'sku_image.link.remove', idempotencyKey).catch(() => {});
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_image_remove_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }
  if (pathname === '/api/domain/commands/product-video-compose' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有编辑商品视频的权限，请联系管理员授权。' });
    try {
      const input = await readJsonBody(req, res, 24 * 1024); if (!input) return;
      const clientId = String(input.clientId || '').trim(), productId = String(input.productId || '').trim(), variantRef = String(input.variantRef || '').trim();
      const imageObjectIds = [...new Set((Array.isArray(input.imageObjectIds) ? input.imageObjectIds : []).map(id => String(id || '').trim()).filter(Boolean))];
      const rawSources = Array.isArray(input.imageSources) ? input.imageSources : [];
      const imageSources = rawSources.slice(0,8).map(item => {
        const source = item && typeof item === 'object' ? item : {}, objectId = String(source.objectId || '').trim(), url = String(source.url || '').trim();
        if (objectId && UUID_PATTERN.test(objectId)) return { kind:'object', objectId };
        if (/^\/api\/private-objects\/sku-images\/[0-9a-f-]{36}(?:[?#].*)?$/i.test(url)) return { kind:'url', url };
        if (/^https:\/\//i.test(url) && isSafeExternalImageUrl(url)) return { kind:'url', url };
        return null;
      }).filter(Boolean);
      const durationSeconds = Math.floor(Number(input.durationSeconds) || 0), transition = input.transition === 'fade' ? 'fade' : 'cut', motion = input.motion === true;
      const sourceCount = imageSources.length || imageObjectIds.length;
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(clientId)) return sendJson(res, 400, { error: 'product_video_client_invalid', message: '当前店铺标识无效，请重新打开商品页面后再生成视频。' });
      if (!/^(?:\d+|draft_[\w-]+|session_[\w-]+)$/.test(productId)) return sendJson(res, 400, { error: 'product_video_product_invalid', message: '当前商品目标无效，请重新打开商品页面后再生成视频。' });
      if (!/^[A-Za-z0-9._:-]{1,180}$/.test(variantRef)) return sendJson(res, 400, { error: 'product_video_variant_invalid', message: '当前规格标识无效，请重新打开这个SKU后再生成视频。' });
      if (sourceCount < 2 || sourceCount > 8) return sendJson(res, 400, { error: 'product_video_image_count_invalid', message: '请选择2到8张当前规格商品图片。' });
      if (imageObjectIds.some(id => !UUID_PATTERN.test(id))) return sendJson(res, 400, { error: 'product_video_image_id_invalid', message: '部分所选图片标识无效，请重新选择图片。' });
      if (durationSeconds < 8 || durationSeconds > 20) return sendJson(res, 400, { error: 'product_video_duration_invalid', message: '视频时长必须设置为8到20秒。' });
      const target = { clientId, productId, variantRef };
      if (!imageSources.length) {
        const links = await authStore.listSkuImageLinks(account, target);
        const allowed = new Set(links.map(item => String(item.objectId)));
        if (imageObjectIds.some(id => !allowed.has(id))) return sendJson(res, 409, { error: 'product_video_source_changed', message: '部分所选图片已经移除或不属于当前规格，请刷新图片后重新选择。' });
      } else {
        for (const source of imageSources) {
          const objectId = source.objectId || (String(source.url || '').match(/^\/api\/private-objects\/sku-images\/([0-9a-f-]{36})/i) || [])[1];
          if (objectId && !await authStore.getSkuImageObject(account, objectId)) return sendJson(res, 409, { error:'product_video_source_changed', message:'部分所选图片已经不可用，请重新选择。' });
        }
      }
      const id = 'product-video-compose-' + crypto.randomUUID();
      const dedupeKey = 'product-video:' + crypto.createHash('sha256').update(JSON.stringify({ clientId, productId, variantRef, imageObjectIds, imageSources, durationSeconds, transition, motion })).digest('hex');
      const persisted = await authStore.enqueueBackgroundJob(account, { id, type: 'product_video_compose', dedupeKey, context: { ...target, imageObjectIds, imageSources, durationSeconds, transition, motion, phase: 'queued' }, maxAttempts: 2, task: { type: 'edit', name: '商品图片合成视频', label: '已进入服务器队列', article: productId, sku: variantRef } });
      return sendJson(res, persisted.duplicate ? 200 : 202, { task: { id: persisted.job.id, state: persisted.job.state, duplicate: persisted.duplicate === true } });
    } catch (error) {
      if (error.publicCode === 'background_job_queue_full') return sendJson(res, 503, { error: error.publicCode, message: '视频合成队列已满，请稍后重试。' }, { 'Retry-After': '10' });
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'product_video_compose_start_failed', message: userErrorText(error, '视频合成任务启动失败，请稍后重试。') });
    }
  }
  if (pathname === '/api/domain/queries/product-video-compose' && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看商品视频的权限，请联系管理员授权。' });
    try {
      const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
      const job = await authStore.getProductVideoComposeTask(account, query.get('taskId'));
      const context = job.context || {}, result = context.result || null;
      return sendJson(res, 200, { task: { id: job.id, state: job.state, attempts: job.attempts, maxAttempts: job.maxAttempts, phase: context.phase || 'queued', result: result ? { videoId: result.videoId, url: '/api/private-objects/product-videos/' + result.videoId, mimeType: 'video/mp4', sizeBytes: result.sizeBytes, durationSeconds: result.durationSeconds, width: result.width, height: result.height, fps: result.fps } : null } });
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'product_video_task_read_failed', message: userErrorText(error, '读取视频合成任务失败，请刷新后重试。') }); }
  }
  if (pathname === '/api/domain/commands/combination-reference-image' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有上传组合参考图的权限，请联系管理员授权。' });
    if (!privateObjectStore.encryptionAvailable()) return sendJson(res, 503, { error: 'combination_reference_storage_unavailable', message: '组合参考图私有存储暂不可用，请联系管理员检查配置。' });
    if (!skuImageUpload.processorReady()) return sendJson(res, 503, { error: 'combination_reference_processor_unavailable', message: '图片处理组件尚未就绪，请安装后重启服务再试。' });
    try {
      const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
      const bundleId = String(query.get('bundleId') || '').trim(), name = String(query.get('name') || 'combination-reference.jpg').trim();
      if (!bundleId || bundleId.length > 240) return sendJson(res, 400, { error: 'combination_reference_bundle_invalid', message: '组合子项编号无效，请重新打开商品后再试。' });
      const body = await readBody(req, skuImageUpload.MAX_BYTES);
      const processed = await skuImageUpload.processImage({ body, contentType: req.headers['content-type'], name });
      const stored = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'combination_reference_image', body: processed.body });
      const metadata = await authStore.saveCombinationReferenceImage(account, { id: crypto.randomUUID(), bundleId, objectKey: stored.objectKey, sha256: stored.sha256, sizeBytes: stored.size, mimeType: processed.mimeType, width: processed.width, height: processed.height });
      await authStore.recordAudit(account, 'combination.reference.upload', 'combination_reference_image', metadata.id, 'success', { bundleId, sizeBytes: metadata.sizeBytes, width: metadata.width, height: metadata.height });
      return sendJson(res, 201, { item: { id: metadata.id, url: '/api/private-objects/combination-references/' + metadata.id, mimeType: metadata.mimeType, width: metadata.width, height: metadata.height, sizeBytes: metadata.sizeBytes } });
    } catch (error) {
      return sendJson(res, error.publicCode === 'body_too_large' ? 413 : (error.status || (error.publicCode ? 400 : 500)), { error: error.publicCode === 'body_too_large' ? 'combination_reference_too_large' : error.publicCode || 'combination_reference_upload_failed', message: userErrorText(error, '组合参考图上传失败，请重试。') });
    }
  }

  const combinationReferenceObjectMatch = pathname.match(/^\/api\/private-objects\/combination-references\/([0-9a-f-]{36})$/i);
  if (combinationReferenceObjectMatch && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看组合参考图的权限，请联系管理员授权。' });
    try {
      const metadata = await authStore.getCombinationReferenceImage(account, combinationReferenceObjectMatch[1]);
      if (!metadata) return sendJson(res, 404, { error: 'combination_reference_not_found', message: '未找到这张组合参考图，请重新上传。' });
      const body = await privateObjectStore.readEncryptedBuffer(metadata.objectKey);
      if (body.length !== Number(metadata.sizeBytes) || crypto.createHash('sha256').update(body).digest('hex') !== metadata.sha256) throw new Error('combination reference image integrity check failed');
      const headers = securityHeaders(); delete headers['Content-Security-Policy'];
      res.writeHead(200, Object.assign(headers, { 'Content-Type': metadata.mimeType, 'Content-Length': body.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }));
      res.end(body); return;
    } catch (error) {
      return sendJson(res, error.publicCode === 'private_object_encryption_unavailable' ? 503 : (error.status || 500), { error: error.publicCode || 'combination_reference_read_failed', message: userErrorText(error, '读取组合参考图失败，请重新上传或联系管理员。') });
    }
  }

  const productVideoDeleteMatch = pathname.match(/^\/api\/domain\/commands\/product-video-compose\/([0-9a-f-]{36})$/i);
  if (productVideoDeleteMatch && req.method === 'DELETE') {
    const account = await scopedAccountFor(req, res); if (!account) return; if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有删除商品视频的权限，请联系管理员授权。' });
    try {
      const metadata = await authStore.deleteProductVideoObject(account, productVideoDeleteMatch[1]);
      if (!metadata) return sendJson(res, 404, { error: 'product_video_not_found', message: '未找到这个已生成视频，可能已经被删除。' });
      if (!metadata.objectStillReferenced) await privateObjectStore.deleteEncryptedBuffer(metadata.objectKey);
      await authStore.recordAudit(account, 'product.video.delete', 'product_video', metadata.id, 'success', { sizeBytes: metadata.sizeBytes });
      return sendJson(res, 200, { ok: true, id: metadata.id });
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'product_video_delete_failed', message: userErrorText(error, '删除已生成视频失败，请刷新后重试。') }); }
  }
  const productVideoObjectMatch = pathname.match(/^\/api\/private-objects\/product-videos\/([0-9a-f-]{36})$/i);
  if (productVideoObjectMatch && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看商品视频的权限，请联系管理员授权。' });
    try {
      const metadata = await authStore.getProductVideoObject(account, productVideoObjectMatch[1]);
      if (!metadata) return sendJson(res, 404, { error: 'product_video_not_found', message: '未找到这个已生成视频，请重新生成。' });
      const body = await privateObjectStore.readEncryptedBuffer(metadata.objectKey);
      if (body.length !== Number(metadata.sizeBytes) || crypto.createHash('sha256').update(body).digest('hex') !== metadata.sha256) throw new Error('product video integrity check failed');
      const range = parseHttpByteRange(req.headers.range, body.length);
      const headers = securityHeaders(); delete headers['Content-Security-Policy'];
      const commonHeaders = Object.assign(headers, { 'Content-Type': 'video/mp4', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });
      if (range && !range.valid) {
        await authStore.recordAudit(account, 'product.video.read', 'product_video', metadata.id, 'failed', { sizeBytes: body.length, reason: 'range_not_satisfiable' });
        res.writeHead(416, Object.assign(commonHeaders, { 'Content-Range': `bytes */${body.length}`, 'Content-Length': '0' }));
        res.end(); return;
      }
      const responseBody = range ? body.subarray(range.start, range.end + 1) : body;
      await authStore.recordAudit(account, 'product.video.read', 'product_video', metadata.id, 'success', range ? { sizeBytes: body.length, rangeStart: range.start, rangeEnd: range.end } : { sizeBytes: body.length });
      if (range) {
        res.writeHead(206, Object.assign(commonHeaders, { 'Content-Range': `bytes ${range.start}-${range.end}/${body.length}`, 'Content-Length': responseBody.length }));
      } else {
        res.writeHead(200, Object.assign(commonHeaders, { 'Content-Length': responseBody.length }));
      }
      res.end(responseBody); return;
    } catch (error) { return sendJson(res, error.publicCode === 'private_object_encryption_unavailable' ? 503 : (error.status || 500), { error: error.publicCode || 'product_video_read_failed', message: userErrorText(error, '读取已生成视频失败，请重新生成或联系管理员。') }); }
  }
  const skuImageObjectMatch = pathname.match(/^\/api\/private-objects\/sku-images\/([0-9a-f-]{36})$/i);
  if (skuImageObjectMatch && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!authStore.hasPermission(account, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try {
      const item = await authStore.getSkuImageObject(account, skuImageObjectMatch[1]);
      if (!item) return sendJson(res, 404, { error: 'sku_image_not_found', message: '未找到这张图片，请刷新页面后重试。' });
      const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
      const download = query.get('download') === '1';
      const preview = query.get('preview') === '1' && !download;
      let body;
      let responseType = item.mime_type;
      if (preview) {
        const cached = item.processing_summary && item.processing_summary.previewCache;
        const cacheValid = cached && Number(cached.version) === 1
          && String(cached.sourceSha256 || '') === String(item.sha256 || '')
          && /^[a-f0-9]{64}$/i.test(String(cached.sha256 || ''))
          && String(cached.objectKey || '')
          && Number(cached.sizeBytes) > 0;
        if (cacheValid) {
          try {
            const cachedBody = await privateObjectStore.readEncryptedBuffer(cached.objectKey);
            if (cachedBody.length === Number(cached.sizeBytes) && crypto.createHash('sha256').update(cachedBody).digest('hex') === String(cached.sha256)) body = cachedBody;
          } catch (error) {
            body = null;
          }
        }
        if (!body) {
          const sourceBody = await privateObjectStore.readEncryptedBuffer(item.private_object_key);
          if (sourceBody.length !== Number(item.size_bytes) || crypto.createHash('sha256').update(sourceBody).digest('hex') !== item.sha256) throw new Error('sku image integrity check failed');
          const generated = await skuImageUpload.createThumbnail({ body: sourceBody, contentType: item.mime_type });
          const stored = await privateObjectStore.putEncryptedBuffer({ tenantId: account.tenantId, kind: 'sku_image_thumbnail', body: generated.body });
          await authStore.saveSkuImagePreviewCache(account, item.id, {
            sourceSha256: item.sha256,
            objectKey: stored.objectKey,
            sha256: stored.sha256,
            sizeBytes: stored.size,
            mimeType: generated.mimeType,
            width: generated.width,
            height: generated.height,
            maxSide: generated.maxSide
          });
          body = generated.body;
        }
        responseType = 'image/jpeg';
      } else {
        body = await privateObjectStore.readEncryptedBuffer(item.private_object_key);
        if (body.length !== Number(item.size_bytes) || crypto.createHash('sha256').update(body).digest('hex') !== item.sha256) throw new Error('sku image integrity check failed');
      }
      await authStore.recordAudit(account, download ? 'sku.image.download' : preview ? 'sku.image.preview' : 'sku.image.read', 'sku_image_object', item.id, 'success', { sizeBytes: body.length, mimeType: responseType });
      const headers = securityHeaders();
      delete headers['Content-Security-Policy'];
      const requestedName = String(query.get('filename') || '').trim();
      const objectName = /^[\w.-]{1,120}$/.test(requestedName) ? requestedName : `sku-image-${item.id}${item.extension}`;
      const disposition = download ? { 'Content-Disposition': `attachment; filename="${objectName}"` } : {};
      res.writeHead(200, Object.assign(headers, { 'Content-Type': responseType, 'Content-Length': body.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }, disposition));
      res.end(body);
      return;
    }
    catch (error) { return sendJson(res, error.publicCode === 'private_object_encryption_unavailable' ? 503 : 500, { error: error.publicCode || 'sku_image_read_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }
  if (pathname === '/api/payment-evidence' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (account.isSystemAdmin || account.memberType !== 'owner') return sendJson(res, 403, { error: 'payment_evidence_owner_required', message: '只有上传该付款凭证的账号可以修改或删除它。' });
    if (!privateObjectStore.encryptionAvailable()) return sendJson(res, 503, { error: 'payment_evidence_storage_unavailable', message: '私有存储目录暂不可用，无法保存付款凭证，请联系管理员检查配置。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    const activationCodeId = String(params.get('activationCodeId') || '').trim();
    const evidenceKind = String(params.get('kind') || '').trim();
    if (!/^\d+$/.test(activationCodeId)) return sendJson(res, 400, { error: 'payment_evidence_activation_code_invalid', message: '该付款凭证未关联到有效的激活码，请先选择对应激活码。' });
    if (!['agent_to_platform', 'customer_to_agent'].includes(evidenceKind)) return sendJson(res, 400, { error: 'payment_evidence_kind_invalid', message: '请选择正确的付款类型（代理商付平台或客户付代理）。' });
    const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!PAYMENT_EVIDENCE_TYPES.has(mediaType)) return sendJson(res, 415, { error: 'payment_evidence_type_not_allowed', message: '只支持上传常见图片格式的付款凭证，请更换文件。' });
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > PAYMENT_EVIDENCE_MAX_BYTES) return sendJson(res, 413, { error: 'payment_evidence_too_large', message: '付款截图超过允许大小，请压缩后重新上传。' });
    let target;
    try { target = await authStore.paymentEvidenceUploadTarget(account, activationCodeId, evidenceKind); }
    catch (error) {
      if (error.publicCode === 'payment_evidence_scope_denied') return sendJson(res, 404, { error: 'payment_evidence_target_not_found', message: '未找到这笔付款对应的记录，请刷新后重试。' });
      console.error('核对付款凭证上传范围失败:', error.message);
      return sendJson(res, 500, { error: 'payment_evidence_upload_failed', message: '付款凭证上传失败，请稍后重试。' });
    }
    let body;
    try { body = await readBody(req, PAYMENT_EVIDENCE_MAX_BYTES); }
    catch (error) { return sendJson(res, error.publicCode === 'body_too_large' ? 413 : 400, { error: error.publicCode || 'payment_evidence_upload_failed', message: userErrorText(error, "付款凭证上传失败，请稍后重试。")}); }
    if (!body.length) return sendJson(res, 400, { error: 'payment_evidence_empty', message: '请选择要上传的付款截图后再提交。' });
    if (!matchesBugAttachmentSignature(mediaType, body)) return sendJson(res, 415, { error: 'payment_evidence_content_invalid', message: '付款截图内容校验未通过，请重新截图后上传。' });
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    try {
      if (await authStore.hasPaymentEvidenceHash(target.tenant_id, sha256)) return sendJson(res, 409, { error: 'payment_evidence_duplicate', message: '这张付款凭证已上传过，请勿重复提交。' });
      const stored = await privateObjectStore.putEncryptedBuffer({ tenantId: target.tenant_id, kind: 'membership_payment_evidence', body });
      const originalName = String(params.get('name') || '付款凭证').replace(/[\u0000-\u001f\u007f\\/]/g, '').slice(0, 160) || '付款凭证';
      const item = await authStore.savePaymentEvidence(account, {
        activationCodeId, evidenceKind, objectKey: stored.objectKey,
        originalName, mediaType, size: stored.size, sha256: stored.sha256
      });
      return sendJson(res, 201, { item });
    } catch (error) {
      if (error.publicCode === 'payment_evidence_duplicate') return sendJson(res, 409, { error: error.publicCode, message: userErrorText(error, "这张付款凭证已上传过，请勿重复提交。")});
      if (error.publicCode === 'payment_evidence_scope_denied') return sendJson(res, 404, { error: 'payment_evidence_target_not_found', message: '未找到这笔付款对应的记录，请刷新后重试。' });
      if (error.publicCode === 'private_object_encryption_unavailable') return sendJson(res, 503, { error: 'payment_evidence_storage_unavailable', message: '私有存储目录暂不可用，无法保存付款凭证，请联系管理员检查配置。' });
      console.error('保存付款凭证失败:', error.message);
      return sendJson(res, 500, { error: 'payment_evidence_save_failed', message: '付款凭证保存失败，请稍后重新上传。' });
    }
  }

  const paymentEvidenceObjectMatch = pathname.match(/^\/api\/private-objects\/payment-evidence\/(\d+)$/);
  if (paymentEvidenceObjectMatch && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    try {
      const item = await authStore.getPaymentEvidenceObject(account, paymentEvidenceObjectMatch[1]);
      if (!item) return sendJson(res, 404, { error: 'payment_evidence_not_found', message: '未找到这张付款凭证，请刷新列表后重试。' });
      const body = await privateObjectStore.readEncryptedBuffer(item.object_key);
      const digest = crypto.createHash('sha256').update(body).digest('hex');
      if (body.length !== Number(item.size_bytes) || digest !== item.sha256) throw new Error('payment evidence integrity check failed');
      await authStore.recordAudit(account, 'payment.evidence.read', 'payment_evidence', item.id, 'success', {
        evidenceTenantId: item.tenant_id, evidenceKind: item.evidence_kind, mediaType: item.media_type, size: body.length
      });
      const imageHeaders = securityHeaders();
      // Raster bytes are signature-checked and nosniff; a document CSP only breaks Chromium's built-in image viewer.
      delete imageHeaders['Content-Security-Policy'];
      res.writeHead(200, Object.assign(imageHeaders, {
        'Content-Type': item.media_type,
        'Content-Length': body.length,
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(item.original_name || 'payment-evidence')}`
      }));
      res.end(body);
      return;
    } catch (error) {
      if (error.publicCode === 'private_object_encryption_unavailable') return sendJson(res, 503, { error: 'payment_evidence_storage_unavailable', message: '私有存储目录暂不可用，无法保存付款凭证，请联系管理员检查配置。' });
      console.error('读取付款凭证失败:', error.message);
      return sendJson(res, 500, { error: 'payment_evidence_read_failed', message: '付款凭证读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/notifications' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    try { return sendJson(res, 200, await authStore.listUserNotifications(account, params.get('limit'))); }
    catch (error) {
      console.error('读取站内通知失败:', error.message);
      return sendJson(res, 500, { error: 'notifications_read_failed', message: '通知列表读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/notifications/read-all' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    try { return sendJson(res, 200, await authStore.markAllUserNotificationsRead(account)); }
    catch (error) {
      console.error('一键已读更新失败:', error.message);
      return sendJson(res, 500, { error: 'notifications_read_all_failed', message: '通知一键已读失败，请稍后重试。' });
    }
  }

  const notificationReadMatch = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
  if (notificationReadMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    try {
      const item = await authStore.markUserNotificationRead(account, notificationReadMatch[1]);
      return item ? sendJson(res, 200, { item }) : sendJson(res, 404, { error: 'notification_not_found', message: '未找到这条通知，可能已被清理，请刷新通知列表。' });
    } catch (error) {
      console.error('更新站内通知已读状态失败:', error.message);
      return sendJson(res, 500, { error: 'notification_read_update_failed', message: '通知已读状态更新失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/auth/captcha' && req.method === 'GET') {
    const retryAfter = consumeWindow(captchaRequestWindows, clientAddress(req), CAPTCHA_REQUEST_WINDOW_MS, CAPTCHA_REQUEST_MAX);
    if (retryAfter) return sendJson(res, 429, { error: '验证码请求过多，请稍后再试' }, { 'Retry-After': String(retryAfter) });
    return sendJson(res, 200, createCaptcha(req), { 'Cache-Control': 'no-store' });
  }

  if (pathname === '/api/auth/email/send' && req.method === 'POST') {
    if (!requireAllowedOrigin(req, res)) return;
    const body = await readJsonBody(req, res, UNAUTHENTICATED_JSON_MAX_BYTES);
    if (!body) return;
    const normalized = normalizeProfileEmail(body.email);
    if (normalized.error) return sendJson(res, 400, { error: 'invalid_email', message: normalized.error });
    const purpose = String(body.purpose || 'register');
    if (purpose !== 'register') return sendJson(res, 400, { error: 'email_challenge_purpose_invalid', message: '该验证码用途不支持直接发送。' });
    try {
      const result = await authStore.issueAuthEmailChallenge({
        purpose: 'register', email: normalized.email, userId: null,
        createdIp: clientAddress(req), deviceHash: userSecurityMonitor.deviceHash(ensureRequestDeviceId(req))
      }, authVerificationSender);
      return sendJson(res, 200, { ok: true, emailMask: result.emailMask, expiresAt: result.expiresAt });
    } catch (error) { return authEmailErrorRes(res, error); }
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    if (!requireAllowedOrigin(req, res)) return;
    if (!ALLOW_REGISTRATION) return sendJson(res, 403, { error: 'registration_disabled', message: '公网环境已关闭自助注册，请联系管理员创建账号。' });
    const registrationRetryAfter = consumeWindow(registrationWindows, clientAddress(req), REGISTRATION_WINDOW_MS, REGISTRATION_MAX_ATTEMPTS);
    if (registrationRetryAfter) return sendJson(res, 429, { error: 'registration_rate_limited', message: '注册请求过多，请稍后再试。' }, { 'Retry-After': String(registrationRetryAfter) });
    const body = await readJsonBody(req, res, UNAUTHENTICATED_JSON_MAX_BYTES);
    if (!body) return;
    const normalized = normalizeProfileEmail(body.email);
    const password = String(body.password || '');
    const emailCode = String(body.emailCode || '').replace(/\D/g, '');
    const inviteCode = String(body.inviteCode || '').trim().toUpperCase();
    if (normalized.error) return sendJson(res, 400, { error: 'invalid_email', message: normalized.error });
    if (!validatePassword(password)) return sendJson(res, 400, { error: 'invalid_password', message: '密码需为 6-128 个字符。' });
    if (!/^\d{6}$/.test(emailCode)) return sendJson(res, 400, { error: 'email_code_invalid', message: '请输入邮件中的 6 位验证码。' });
    if (inviteCode && !/^WY[A-F0-9]{10}$/.test(inviteCode)) return sendJson(res, 400, { error: 'referral_code_invalid', message: '邀请码格式不正确，请核对后重试；也可以清空邀请码继续注册。' });
    try {
      const base = await authStore.registerOwner({
        password, email: normalized.email, emailCode, inviteCode,
        tenantName: String(body.tenantName || '').trim()
      });
      const account = { ...base, memberType: 'owner', isSystemAdmin: false, shopScopeMode: 'all', permissions: ['*'], displayName: normalized.email };
      const requestDevice = ensureRequestDeviceId(req);
      const deviceHash = userSecurityMonitor.deviceHash(requestDevice);
      await authStore.trustLoginDevice(account, deviceHash, clientAddress(req));
      await userSecurityMonitor.noteLogin(account, { ip: clientAddress(req), deviceId: requestDevice, emailVerified: true });
      const created = await authStore.createSession(account, { ipAddress: clientAddress(req), deviceId: requestDevice });
      await authStore.writeAudit(authStore.pool, account, 'auth.register', 'session', created.sessionId, 'success');
      authStore.notifyMembershipRewardActivityLogin(account);
      return sendJson(res, 200, { ...account, email: normalized.email, csrfToken: created.csrfToken }, { 'Set-Cookie': [sessionCookie(created.token), deviceCookie(requestDevice)] });
    } catch (error) {
      if (error.publicCode === 'email_already_registered') return authEmailErrorRes(res, error);
      if (error.publicCode && String(error.publicCode).startsWith('email_code_')) return authEmailErrorRes(res, error);
      if (error.publicCode && String(error.publicCode).startsWith('referral_')) return sendJson(res, 400, { error: error.publicCode, message: error.message });
      console.error('注册失败:', error.message);
      return sendJson(res, 500, { error: 'registration_failed', message: '账号创建失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!requireAllowedOrigin(req, res)) return;
    const body = await readJsonBody(req, res, UNAUTHENTICATED_JSON_MAX_BYTES);
    if (!body) return;
    const identifier = String(body.email || body.username || '').trim();
    const password = String(body.password || '');
    const adminLogin = identifier.toLowerCase() === 'admin';
    const retryAfter = getLoginLimit(req, identifier);
    if (retryAfter) return sendJson(res, 429, { error: 'login_rate_limited', message: '登录尝试过多，请稍后再试。' }, { 'Retry-After': String(retryAfter) });
    if (!validatePassword(password)) return sendJson(res, 401, { error: 'invalid_credentials', message: '登录信息不正确，请检查后重试。' });

    if (adminLogin) {
      if (!verifyCaptcha(req, body.captchaId, body.captchaAnswer)) return sendJson(res, 401, { error: 'invalid_credentials', message: '登录信息不正确，请检查后重试。' });
      let account;
      try { account = await authStore.verifyCredentials('admin', password); }
      catch (error) { return authEmailErrorRes(res, error); }
      if (!account || !account.isSystemAdmin) {
        recordLoginFailure(req, identifier);
        return sendJson(res, 401, { error: 'invalid_credentials', message: '登录信息不正确，请检查后重试。' });
      }
      clearLoginFailures(req, identifier);
      const requestDevice = ensureRequestDeviceId(req);
      const created = await authStore.createSession(account, { ipAddress: clientAddress(req), deviceId: requestDevice });
      await authStore.writeAudit(authStore.pool, account, 'auth.login.admin', 'session', created.sessionId, 'success');
      return sendJson(res, 200, { ...account, csrfToken: created.csrfToken }, { 'Set-Cookie': [sessionCookie(created.token), deviceCookie(requestDevice)] });
    }

    const normalized = normalizeProfileEmail(identifier);
    if (normalized.error) return sendJson(res, 401, { error: 'invalid_credentials', message: '登录信息不正确，请检查后重试。' });
    let state;
    try { state = await authStore.verifyEmailCredentials(normalized.email, password, body.tenantId); }
    catch (error) { return authEmailErrorRes(res, error); }
    if (!state) {
      recordLoginFailure(req, normalized.email);
      return sendJson(res, 401, { error: 'invalid_credentials', message: '登录信息不正确，请检查后重试。' });
    }
    if (state.tenantSelectionRequired) {
      clearLoginFailures(req, normalized.email);
      return sendJson(res, 300, { ok: true, requiresTenantSelection: true, tenants: state.tenants || [] });
    }
    clearLoginFailures(req, normalized.email);
    const requestDevice = ensureRequestDeviceId(req);
    const deviceHash = userSecurityMonitor.deviceHash(requestDevice);
    const trusted = await authStore.isTrustedLoginDevice(state.account.userId, deviceHash);
    const hasTrusted = trusted || await authStore.hasTrustedLoginDevice(state.account.userId);
    const requiresEmailCode = state.blockType === 'auto_frozen' || !trusted;
    if (requiresEmailCode) {
      const reason = state.blockType === 'auto_frozen' ? 'account_abnormal' : hasTrusted ? 'new_device' : 'first_login';
      const message = reason === 'first_login'
        ? '首次登录需要验证邮箱，请点击“获取验证码”后完成验证。'
        : reason === 'new_device'
          ? '检测到新设备，需要验证邮箱，请点击“获取验证码”后完成验证。'
          : '账号存在自动安全异常，需要验证邮箱后继续；验证通过后将解除自动异常状态。请点击“获取验证码”。';
      if (body.sendEmailCode !== true) {
        return sendJson(res, 202, {
          ok: true, requiresEmailCode: true, codeSent: false, reason, message
        }, { 'Set-Cookie': deviceCookie(requestDevice) });
      }
      try {
        const challenge = await authStore.issueAuthEmailChallenge({
          purpose: 'login_step_up', email: normalized.email, userId: state.account.userId,
          createdIp: clientAddress(req), deviceHash
        }, authVerificationSender);
        return sendJson(res, 202, {
          ok: true, requiresEmailCode: true, codeSent: true, reason, message,
          emailMask: challenge.emailMask, expiresAt: challenge.expiresAt
        }, { 'Set-Cookie': deviceCookie(requestDevice) });
      } catch (error) { return authEmailErrorRes(res, error); }
    }

    const security = await userSecurityMonitor.noteLogin(state.account, { ip: clientAddress(req), deviceId: requestDevice });
    if (security.frozen) {
      return sendJson(res, 202, {
        ok: true,
        requiresEmailCode: true,
        codeSent: false,
        reason: 'security_risk',
        message: '检测到登录安全风险，需要验证邮箱后继续。请点击“获取验证码”。'
      }, { 'Set-Cookie': deviceCookie(requestDevice) });
    }
    const created = await authStore.createSession(state.account, { ipAddress: clientAddress(req), deviceId: requestDevice });
    await authStore.writeAudit(authStore.pool, state.account, 'auth.login.email_password', 'session', created.sessionId, 'success');
    authStore.notifyMembershipRewardActivityLogin(state.account);
    return sendJson(res, 200, { ...state.account, csrfToken: created.csrfToken }, { 'Set-Cookie': [sessionCookie(created.token), deviceCookie(requestDevice)] });
  }

  if (pathname === '/api/auth/login/verify' && req.method === 'POST') {
    if (!requireAllowedOrigin(req, res)) return;
    const body = await readJsonBody(req, res, UNAUTHENTICATED_JSON_MAX_BYTES);
    if (!body) return;
    const normalized = normalizeProfileEmail(body.email);
    const code = String(body.emailCode || body.code || '').replace(/\D/g, '');
    if (normalized.error || !/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'email_code_invalid', message: '请输入邮件中的 6 位验证码。' });
    try {
      const state = await authStore.accountForEmailRecovery(normalized.email, body.tenantId);
      if (!state) return sendJson(res, 400, { error: 'email_code_invalid', message: '邮箱验证码无效或已过期，请重新登录。' });
      if (state.tenantSelectionRequired) return sendJson(res, 300, { ok: true, requiresTenantSelection: true, tenants: state.tenants || [] });
      await authStore.verifyAuthEmailChallenge({ purpose: 'login_step_up', email: normalized.email, userId: state.account.userId, code });
      const requestDevice = ensureRequestDeviceId(req);
      const deviceHash = userSecurityMonitor.deviceHash(requestDevice);
      if (state.blockType === 'auto_frozen') await userSecurityMonitor.unfreezeAfterEmailVerification(state.account);
      await authStore.trustLoginDevice(state.account, deviceHash, clientAddress(req));
      await userSecurityMonitor.noteLogin(state.account, { ip: clientAddress(req), deviceId: requestDevice, emailVerified: true });
      const created = await authStore.createSession(state.account, { ipAddress: clientAddress(req), deviceId: requestDevice });
      await authStore.writeAudit(authStore.pool, state.account, 'auth.login.email_step_up', 'session', created.sessionId, 'success');
      authStore.notifyMembershipRewardActivityLogin(state.account);
      return sendJson(res, 200, { ...state.account, csrfToken: created.csrfToken }, { 'Set-Cookie': [sessionCookie(created.token), deviceCookie(requestDevice)] });
    } catch (error) { return authEmailErrorRes(res, error); }
  }

  if (pathname === '/api/auth/recovery/send' && req.method === 'POST') {
    if (!requireAllowedOrigin(req, res)) return;
    const body = await readJsonBody(req, res, UNAUTHENTICATED_JSON_MAX_BYTES);
    if (!body) return;
    const normalized = normalizeProfileEmail(body.email);
    if (normalized.error) return sendJson(res, 400, { error: 'invalid_email', message: normalized.error });
    try {
      const identity = await authStore.emailIdentity(normalized.email);
      if (!identity) return sendJson(res, 200, { ok: true, message: '如果该邮箱已注册，验证码会发送到邮箱。' });
      const requestDevice = ensureRequestDeviceId(req);
      const result = await authStore.issueAuthEmailChallenge({
        purpose: 'password_recovery', email: normalized.email, userId: identity.userId,
        createdIp: clientAddress(req), deviceHash: userSecurityMonitor.deviceHash(requestDevice)
      }, authVerificationSender);
      return sendJson(res, 200, { ok: true, emailMask: result.emailMask, expiresAt: result.expiresAt });
    } catch (error) { return authEmailErrorRes(res, error); }
  }

  if (pathname === '/api/auth/recovery/login' && req.method === 'POST') {
    if (!requireAllowedOrigin(req, res)) return;
    const body = await readJsonBody(req, res, UNAUTHENTICATED_JSON_MAX_BYTES);
    if (!body) return;
    const normalized = normalizeProfileEmail(body.email);
    const code = String(body.emailCode || body.code || '').replace(/\D/g, '');
    if (normalized.error || !/^\d{6}$/.test(code)) return sendJson(res, 400, { error: 'email_code_invalid', message: '请输入邮件中的 6 位验证码。' });
    try {
      const identity = await authStore.emailIdentity(normalized.email);
      if (!identity) return sendJson(res, 400, { error: 'email_code_invalid', message: '邮箱验证码无效或已过期。' });
      if ((!body.tenantId || !String(body.tenantId).trim()) && identity.tenants.length > 1) {
        await authStore.verifyAuthEmailChallenge({ purpose: 'password_recovery', email: normalized.email, userId: identity.userId, code, consume: false });
        return sendJson(res, 300, { ok: true, requiresTenantSelection: true, tenants: identity.tenants });
      }
      const state = await authStore.accountForEmailRecovery(normalized.email, body.tenantId);
      if (!state || state.tenantSelectionRequired) return sendJson(res, 400, { error: 'tenant_selection_invalid', message: '请选择正确的企业后继续登录。' });
      await authStore.verifyAuthEmailChallenge({ purpose: 'password_recovery', email: normalized.email, userId: identity.userId, code });
      const requestDevice = ensureRequestDeviceId(req);
      const deviceHash = userSecurityMonitor.deviceHash(requestDevice);
      if (state.blockType === 'auto_frozen') await userSecurityMonitor.unfreezeAfterEmailVerification(state.account);
      await authStore.trustLoginDevice(state.account, deviceHash, clientAddress(req));
      await userSecurityMonitor.noteLogin(state.account, { ip: clientAddress(req), deviceId: requestDevice, emailVerified: true });
      const created = await authStore.createSession(state.account, { ipAddress: clientAddress(req), deviceId: requestDevice });
      await authStore.writeAudit(authStore.pool, state.account, 'auth.login.password_recovery', 'session', created.sessionId, 'success');
      authStore.notifyMembershipRewardActivityLogin(state.account);
      return sendJson(res, 200, { ...state.account, csrfToken: created.csrfToken, passwordResetRecommended: true }, { 'Set-Cookie': [sessionCookie(created.token), deviceCookie(requestDevice)] });
    } catch (error) { return authEmailErrorRes(res, error); }
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const identity = await authStore.accountDisplayIdentity(account);
    return sendJson(res, 200, {
      userId: account.userId, tenantId: account.tenantId, username: account.username,
      displayName: account.displayName, memberType: account.memberType,
      profileFullName: identity.profileFullName, email: identity.email,
      isSystemAdmin: account.isSystemAdmin,
      shopScopeMode: account.shopScopeMode, permissions: account.permissions,
      csrfToken: account.csrfToken
    });
  }

  if (pathname === '/api/order-advertising' && ['GET', 'POST'].includes(req.method)) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (req.method === 'POST' && !requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'orders.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有读取订单统计的权限，请联系管理员授权。' });
    const advertisingUrl = new URL(req.url, 'http://' + HOST + ':' + PORT);
    const advertisingInput = req.method === 'POST' ? await readJsonBody(req, res, 64 * 1024) : null;
    if (req.method === 'POST' && !advertisingInput) return;
    const from = String(req.method === 'POST' ? advertisingInput.from || '' : advertisingUrl.searchParams.get('from') || '').trim();
    const to = String(req.method === 'POST' ? advertisingInput.to || '' : advertisingUrl.searchParams.get('to') || '').trim();
    const requestedClientId = String(req.method === 'POST' ? advertisingInput.clientId || '' : advertisingUrl.searchParams.get('clientId') || '').trim();
    const force = req.method === 'POST' ? advertisingInput.force === true : advertisingUrl.searchParams.get('force') === '1';
    if (force && !account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '只有系统管理员可以强制刷新已缓存的广告费用。' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return sendJson(res, 400, { error: 'order_advertising_dates_required', message: '请选择广告费用统计的开始日期和结束日期。' });
    try {
      const dates = orderAdvertisingSync.dateKeys(from, to);
      if (!dates.length || dates.length > 93) return sendJson(res, 400, { error: 'order_advertising_range_invalid', message: dates.length > 93 ? '广告费用一次最多读取93天，请缩小日期范围后重试。' : '广告统计日期不正确，请重新选择日期。' });
      const document = await authStore.getDocument(dataAccount, 'erp_shops_data');
      const shops = document ? decryptShopCredentials(document.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
      const allowedShops = await authStore.listAllowedShops(dataAccount);
      const allowedIds = allowedShops === null ? null : new Set(allowedShops.map(item => String(item.externalShopId || item.clientId || '')));
      const targets = (Array.isArray(shops) ? shops : []).filter(shop => {
        const clientId = String(shop && shop.clientId || '');
        return clientId && shop.apiKey && (!requestedClientId || clientId === requestedClientId) && (allowedIds === null || allowedIds.has(clientId));
      });
      const unallocatedRecords = [], byShop = {}, dailyByShop = {};
      const exposeAdvertisingTypeId = account.isSystemAdmin === true;
      const results = await Promise.all(targets.map(async shop => {
        const clientId = String(shop.clientId), name = String(shop.name || '');
        const memoryKey = [dataAccount.tenantId, clientId, from, to, force ? 'force' : 'normal'].join('|');
        const memory = !force && orderAdvertisingCache.get(memoryKey);
        if (memory && memory.expiresAt > Date.now() && memory.error) return { clientId, name, error: memory.error, status: memory.status || 502 };
        try {
          const documentKey = orderAdvertisingDocumentKey(clientId);
          const persistent = await authStore.getDocument(dataAccount, documentKey);
          const persistentDays = persistent && persistent.payload && persistent.payload.days && typeof persistent.payload.days === 'object' ? persistent.payload.days : {};
          let result;
          if (memory && memory.expiresAt > Date.now() && memory.value) result = memory.value;
          else {
            result = await orderAdvertisingSync.fetchRangeCached(createDirectOzonRequester(shop, dataAccount, 'order_advertising'), { clientId, from, to, cachedDays: persistentDays, force });
            const persisted = await persistAdvertisingDailyCache(dataAccount, clientId, result, persistent);
            if (persisted && persisted.payload && persisted.payload.days) result.days = persisted.payload.days;
          }
          const sellerCpoRecords = (Array.isArray(result.records) ? result.records : []).filter(item => String(item && item.chargeModel || '') === 'CPO');
          const sellerCpoRub = advertisingRecordNetRub(sellerCpoRecords, 'CPO');
          const existingAttribution = await authStore.performanceCpoAttributedTotal(dataAccount, clientId, from, to);
          const cpo = {
            configured: Boolean(shop.performanceClientId && shop.performanceClientSecret),
            status: sellerCpoRub ? 'pending_configuration' : 'none',
            sellerTotalRub: sellerCpoRub,
            sellerRows: sellerCpoRecords.length,
            reportTotalRub: null,
            matchedRub: existingAttribution.amountRub,
            pendingRub: Math.max(0, Math.round((sellerCpoRub - existingAttribution.amountRub) * 100) / 100),
            matchedRows: existingAttribution.rows,
            unmatchedRows: 0,
            reconciliationDeltaRub: null,
            ordersUpdated: 0
          };
          if (sellerCpoRub && cpo.configured) {
            try {
              const cpoKey = performanceCpoDocumentKey(clientId);
              const cpoPersistent = await authStore.getDocument(dataAccount, cpoKey);
              const cpoDays = cpoPersistent && cpoPersistent.payload && cpoPersistent.payload.days && typeof cpoPersistent.payload.days === 'object' ? cpoPersistent.payload.days : {};
              const performanceClient = ozonPerformanceCpo.createClient({
                clientId: String(shop.performanceClientId),
                clientSecret: String(shop.performanceClientSecret)
              });
              const performance = await ozonPerformanceCpo.fetchRangeCached(performanceClient, { from, to, cachedDays: cpoDays, force });
              await persistPerformanceCpoCache(dataAccount, clientId, performance, cpoPersistent);
              cpo.reportTotalRub = performance.amountRub;
              cpo.reconciliationDeltaRub = Math.round((sellerCpoRub - performance.amountRub) * 100) / 100;
              if (Math.abs(cpo.reconciliationDeltaRub) <= 0.05 && !(performance.unresolvedRows || []).length) {
                const sellerIdentity = await ozonPerformanceCpo.resolveSellerPostings(
                  createDirectOzonRequester(shop, dataAccount, 'performance_cpo_seller_identity'),
                  performance.rows,
                  { from, to }
                );
                const applied = await authStore.applyPerformanceCpoAttribution(dataAccount, clientId, { from, to, rows: sellerIdentity.matchedRows });
                cpo.matchedRub = applied.matchedRub;
                cpo.matchedRows = applied.matchedRows;
                cpo.unmatchedRows = sellerIdentity.unmatchedRows.length + applied.unmatchedRows.length;
                cpo.pendingRub = Math.max(0, Math.round((sellerCpoRub - applied.matchedRub) * 100) / 100);
                cpo.ordersUpdated = applied.changedOrders;
                cpo.status = cpo.pendingRub <= 0.05 && !cpo.unmatchedRows ? 'matched' : 'partial';
              } else {
                cpo.status = 'reconciliation_mismatch';
              }
            } catch (error) {
              cpo.status = 'performance_error';
              cpo.error = bilingualSyncFailure(error, 'Ozon Performance API 按订单付费明细读取失败；已保留现有订单归属，并把尚未归属部分继续作为待归属费用扣除。');
            }
          }
          result.cpo = cpo;
          orderAdvertisingCache.set(memoryKey, { expiresAt: Date.now() + 15 * 60 * 1000, value: result });
          return { clientId, name, result };
        } catch (error) {
          const message = bilingualSyncFailure(error, chineseAdvertisingFinanceReason(error));
          const status = Number(error && error.status) || 502;
          orderAdvertisingCache.set(memoryKey, { expiresAt: Date.now() + 15 * 60 * 1000, error: message, status });
          return { clientId, name, error: message, status };
        }
      }));
      const shopErrors = [];
      results.forEach(item => {
        if (!item.result) {
          shopErrors.push({ clientId: item.clientId, name: item.name, status: item.status || 502, message: item.error || '广告费用读取失败，请稍后重试。' });
          return;
        }
        unallocatedRecords.push(...item.result.unallocatedRecords);
        byShop[item.clientId] = {
          clientId: item.clientId, name: item.name,
          unallocatedBreakdown: advertisingBreakdownForAccount(item.result.unallocatedBreakdown, exposeAdvertisingTypeId),
          cpo: item.result.cpo,
          fetchedDates: item.result.fetchedDates || [],
          cachedDates: item.result.cachedDates || []
        };
        dailyByShop[item.clientId] = advertisingPublicDays(item.result.days, dates, exposeAdvertisingTypeId);
      });
      const successful = results.filter(item => item.result);
      const cpoSummary = successful.reduce((sum, item) => {
        const cpo = item.result.cpo || {};
        sum.sellerTotalRub += Number(cpo.sellerTotalRub) || 0;
        sum.reportTotalRub += Number(cpo.reportTotalRub) || 0;
        sum.matchedRub += Number(cpo.matchedRub) || 0;
        sum.pendingRub += Number(cpo.pendingRub) || 0;
        sum.matchedRows += Number(cpo.matchedRows) || 0;
        sum.unmatchedRows += Number(cpo.unmatchedRows) || 0;
        sum.ordersUpdated += Number(cpo.ordersUpdated) || 0;
        if (cpo.configured) sum.configuredShops += 1;
        if (cpo.error) sum.errors.push({ clientId: item.clientId, name: item.name, message: cpo.error });
        if (cpo.status && cpo.status !== 'none' && !sum.statuses.includes(cpo.status)) sum.statuses.push(cpo.status);
        return sum;
      }, { sellerTotalRub: 0, reportTotalRub: 0, matchedRub: 0, pendingRub: 0, matchedRows: 0, unmatchedRows: 0, ordersUpdated: 0, configuredShops: 0, errors: [], statuses: [] });
      ['sellerTotalRub','reportTotalRub','matchedRub','pendingRub'].forEach(key => { cpoSummary[key] = Math.round(cpoSummary[key] * 100) / 100; });
      return sendJson(res, 200, {
        from, to,
        unallocatedBreakdown: advertisingBreakdownForAccount(orderAdvertisingSync.summarize(unallocatedRecords), exposeAdvertisingTypeId),
        cpo: cpoSummary,
        byShop, dailyByShop, shopErrors,
        partial: shopErrors.length > 0 || cpoSummary.errors.length > 0,
        cache: {
          source: successful.some(item => (item.result.fetchedDates || []).length) ? 'mixed' : 'server',
          requestedDays: dates.length,
          fetchedDays: successful.reduce((sum, item) => sum + (item.result.fetchedDates || []).length, 0)
        }
      });
    } catch (error) {
      return sendJson(res, Number(error.status) || 502, { error: error.publicCode || 'order_advertising_read_failed', message: bilingualSyncFailure(error, chineseAdvertisingFinanceReason(error)) });
    }
  }

  if (pathname === '/api/membership/plans' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    try {
      const [items, settings] = await Promise.all([authStore.listMembershipPlans(), authStore.membershipSettings()]);
      return sendJson(res, 200, { items, settings });
    } catch (error) {
      console.error('读取会员方案失败:', error.message);
      return sendJson(res, 500, { error: 'membership_plans_read_failed', message: '会员方案读取失败，请稍后刷新页面重试。' });
    }
  }

  if (pathname === '/api/membership/current' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    try {
      const [membership, settings, quotas] = await Promise.all([
        authStore.getMembershipCurrent(dataAccount),
        authStore.membershipSettings(),
        membershipQuota.snapshot(authStore, dataAccount)
      ]);
      return sendJson(res, 200, { membership, settings, quotas });
    } catch (error) {
      console.error('读取当前会员失败:', error.message);
      return sendJson(res, 500, { error: 'membership_current_read_failed', message: '会员状态读取失败，请稍后刷新页面重试。' });
    }
  }

  if (pathname === '/api/membership/referral' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    try {
      return sendJson(res, 200, { referral: await authStore.getReferralProgram(account) }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      console.error('读取邀请奖励信息失败:', error.message);
      return sendJson(res, 500, { error: 'membership_referral_read_failed', message: '邀请奖励信息读取失败，请稍后刷新重试。' }, { 'Cache-Control': 'no-store' });
    }
  }

  if (pathname === '/api/membership/devices' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    try { return sendJson(res, 200, { items: await authStore.listMembershipDevices(account) }); }
    catch (error) {
      console.error('读取会员设备失败:', error.message);
      return sendJson(res, 500, { error: 'membership_devices_read_failed', message: '登录设备列表读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/membership/activation-records' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin && account.memberType !== 'owner') return sendJson(res, 403, { error: 'membership_owner_required', message: '只有客户空间的主账号可以操作会员功能，请用主账号登录后重试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    try { return sendJson(res, 200, { items: await authStore.listMembershipActivationRecords(dataAccount) }); }
    catch (error) {
      console.error('读取脱敏激活记录失败:', error.message);
      return sendJson(res, 500, { error: 'membership_activation_records_read_failed', message: '激活码使用记录读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/membership/activate' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'membership_owner_required', message: '只有客户主账号可以激活会员' });
    const retryAfter = consumeWindow(activationWindows, `${clientAddress(req)}|${account.userId}`, 15 * 60 * 1000, 10);
    if (retryAfter) return sendJson(res, 429, { error: 'activation_rate_limited', message: '激活尝试过多，请稍后再试' }, { 'Retry-After': String(retryAfter) });
    const settings = await authStore.membershipSettings();
    if (!settings.activationCodesEnabled) return sendJson(res, 403, { error: 'activation_codes_disabled', message: '激活码功能尚未开放' });
    const body = await readJsonBody(req, res);
    if (!body) return;
    const code = String(body.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{16,128}$/.test(code)) return sendJson(res, 400, { error: 'activation_code_invalid', message: '激活码格式无效' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    const codeDigest = crypto.createHash('sha256').update(code).digest('hex');
    const requestHash = crypto.createHash('sha256').update(String(account.tenantId)).update('\0').update(codeDigest).digest('hex');
    try {
      const result = await authStore.activateMembershipCode(
        account, codeDigest, idempotencyKey, requestHash,
        '当前为代理商付款待确认的临时会员；代理商逾期可能导致本次会员暂停。'
      );
      return sendJson(res, result.statusCode, result.response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      if (error.publicCode === 'idempotency_request_in_progress') return sendJson(res, 409, { error: error.publicCode, message: userErrorText(error, "相同操作正在处理中，请稍候片刻再查看结果。")}, { 'Retry-After': '2' });
      if (error.publicCode) return sendJson(res, Number(error.status) || 409, { error: error.publicCode, message: userErrorText(error, '激活码校验未通过，请核对激活码后重试；若多次失败请联系管理员。') });
      console.error('会员激活失败:', error.message);
      return sendJson(res, 500, { error: 'membership_activation_failed', message: '会员激活失败，服务端已记录原因，请稍后重试或联系管理员。' });
    }
  }

  if (pathname === '/api/agent/overview' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'agent_owner_required', message: '只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。' });
    try {
      const [agent, settings] = await Promise.all([authStore.getAgentOverview(account), authStore.membershipSettings()]);
      return sendJson(res, 200, { agent, settings });
    } catch (error) {
      if (error.publicCode === 'agent_owner_required') return sendJson(res, 403, { error: error.publicCode, message: userErrorText(error, "只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。")});
      console.error('读取代理商概览失败:', error.message);
      return sendJson(res, 500, { error: 'agent_overview_read_failed', message: '代理商中心数据读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/agent/application' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    try {
      return sendJson(res, 200, await authStore.getAgentApplicationReadiness(account));
    } catch (error) {
      if (error.publicCode === 'tenant_owner_required') {
        return sendJson(res, 403, { error: error.publicCode, message: '只有客户空间主账号可以申请代理商' });
      }
      console.error('读取代理商申请状态失败:', error.message);
      return sendJson(res, 500, { error: 'agent_application_read_failed', message: '读取代理商申请资格失败，请稍后刷新页面重试。' });
    }
  }

  if (pathname === '/api/agent/application' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    try {
      const readiness = await authStore.getAgentApplicationReadiness(account);
      if (readiness.existingAgent) {
        return sendJson(res, 409, { error: 'agent_already_exists', message: '当前客户空间已有代理商记录，无需重复申请' });
      }
      if (!readiness.featureEnabled) {
        return sendJson(res, 403, { error: 'agent_application_disabled', message: '代理商自助申请尚未开放' });
      }
      return sendJson(res, 409, {
        error: 'agent_application_contract_not_ready',
        message: '正式合同尚未完成人工和法律复核，当前不能提交或签署申请'
      });
    } catch (error) {
      if (error.publicCode === 'tenant_owner_required') {
        return sendJson(res, 403, { error: error.publicCode, message: '只有客户空间主账号可以申请代理商' });
      }
      console.error('提交代理商申请失败:', error.message);
      return sendJson(res, 500, { error: 'agent_application_failed', message: '提交代理商申请失败，服务端已记录原因，请稍后重试或联系管理员。' });
    }
  }

  if (pathname === '/api/agent/activation-codes' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'agent_owner_required', message: '只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。' });
    try {
      await authStore.getAgentOverview(account);
      return sendJson(res, 200, { items: await authStore.listAgentActivationCodes(account) });
    } catch (error) {
      if (error.publicCode === 'agent_owner_required') return sendJson(res, 403, { error: error.publicCode, message: userErrorText(error, "只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。")});
      console.error('读取代理商激活码失败:', error.message);
      return sendJson(res, 500, { error: 'agent_activation_codes_read_failed', message: '代理商激活码列表读取失败，请稍后重试；持续失败请联系管理员。' });
    }
  }

  if (pathname === '/api/agent/activation-codes' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'agent_owner_required', message: '只有有效代理商主账号可以生成激活码' });
    const body = await readJsonBody(req, res, 16 * 1024);
    if (!body) return;
    const benefitType = String(body.benefitType || 'membership').trim();
    const purpose = String(body.purpose || '').trim();
    const planCode = String(body.planCode || '').trim();
    const beanAmount = Number(body.beanAmount);
    const customerAccount = String(body.customerAccount || '').trim();
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    const requestId = String(req.headers['x-request-id'] || '').trim();
    const auditInput = { purpose, planCode, beanAmount, customerAccount, benefitType, idempotencyKey, requestId };
    const rejectRequest = async (error, message) => {
      try {
        await authStore.recordAgentActivationFailure(account, auditInput,
          Object.assign(new Error(message), { publicCode: error, publicReason: message }));
      } catch (auditError) {
        console.error('代理商激活码参数失败审计写入失败:', auditError.message);
        return sendJson(res, 500, { error: 'audit_persistence_failed', message: '请求未执行，但失败审计保存失败，请联系管理员复核。' });
      }
      return sendJson(res, 400, { error, message });
    };
    if (!['membership', 'bean_recharge'].includes(benefitType)) return rejectRequest('agent_activation_benefit_not_supported', '请选择会员激活码或AI豆充值码');
    if (!['customer', 'self'].includes(purpose)) return rejectRequest('activation_code_purpose_invalid', '请选择客户使用或本人使用');
    if (benefitType === 'membership' && !['month', 'quarter', 'year'].includes(planCode)) return rejectRequest('membership_plan_invalid', '请选择有效的会员方案');
    if (benefitType === 'bean_recharge' && ![1000, 2000, 5000, 10000, 50000].includes(beanAmount)) return rejectRequest('bean_amount_invalid', '代理商AI豆充值码仅支持1000、2000、5000、10000或50000豆');
    if (purpose === 'customer' && (customerAccount.length < 2 || customerAccount.length > 120)) {
      return rejectRequest('customer_account_required', '请输入有效的客户登录邮箱或手机号');
    }
    if (purpose === 'self' && Object.prototype.hasOwnProperty.call(body, 'customerAccount')) return rejectRequest('customer_account_not_allowed_for_self', '本人使用时不能填写客户账号');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return rejectRequest('idempotency_key_required', '缺少有效的幂等请求标识');
    const generatedCode = createActivationCode();
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({
      benefitType, planCode: benefitType === 'membership' ? planCode : '', beanAmount: benefitType === 'bean_recharge' ? beanAmount : 0,
      purpose, customerAccount: purpose === 'customer' ? customerAccount.toLowerCase() : ''
    })).digest('hex');
    let secretObjectKey = '';
    try {
      secretObjectKey = await storeActivationCodeSecret(account.tenantId, generatedCode);
      const result = await authStore.requestAgentActivationCode(account, {
        planCode: benefitType === 'membership' ? planCode : '', beanAmount: benefitType === 'bean_recharge' ? beanAmount : null,
        purpose, customerAccount: purpose === 'customer' ? customerAccount : '',
        benefitType, idempotencyKey, requestHash,
        codeDigest: generatedCode.digest, codeMask: generatedCode.mask, requestId
      });
      if (result.replayed && secretObjectKey) await privateObjectStore.deleteEncryptedBuffer(secretObjectKey).catch(() => {});
      const response = result.replayed ? result.response : { ...result.response, code: generatedCode.code, oneTimeCodeUnavailable: false };
      return sendJson(res, result.statusCode, response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      if (secretObjectKey) await privateObjectStore.deleteEncryptedBuffer(secretObjectKey).catch(() => {});
      const statusByCode = {
        audit_persistence_failed: 500, activation_codes_disabled: 403, agent_owner_required: 403,
        customer_account_not_found: 404, customer_account_system_admin: 403,
        customer_account_disabled: 409, customer_account_owner_required: 409, customer_account_ambiguous: 409,
        membership_plan_unavailable: 409, agent_deposit_required: 409, agent_code_requests_blocked: 409,
        agent_activation_code_quota_exceeded: 409, agent_payment_overdue: 409, agent_first_payment_required: 409,
        agent_profile_required: 409,
        idempotency_key_conflict: 409, idempotency_request_in_progress: 409,
        agent_activation_benefit_not_supported: 400, bean_code_purpose_invalid: 400, bean_amount_invalid: 400,
        agent_to_agent_activation_forbidden: 409,
        activation_code_secret_storage_unavailable: 503,
        activation_code_secret_integrity_failed: 500
      };
      if (statusByCode[error.publicCode]) return sendJson(res, statusByCode[error.publicCode], {
        error: error.publicCode, message: userErrorText(error, '代理商激活码申请未通过校验，请检查客户账号与保证金状态后重试。'),
        depositRequiredMinor: error.depositRequiredMinor, depositBalanceMinor: error.depositBalanceMinor, quota: error.quota
      }, error.publicCode === 'idempotency_request_in_progress' ? { 'Retry-After': '2' } : undefined);
      console.error('代理商生成激活码失败:', error.message);
      return sendJson(res, 500, { error: 'agent_activation_code_request_failed', message: '代理商激活码申请失败，服务端已记录失败原因。' });
    }
  }

  const agentCodeVoidMatch = pathname.match(/^\/api\/agent\/activation-codes\/(\d+)\/void$/);
  if (agentCodeVoidMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'agent_owner_required', message: '只有有效代理商的主账号可以操作代理商功能，请用主账号登录后重试。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    const codeId = agentCodeVoidMatch[1];
    const requestHash = crypto.createHash('sha256').update(String(account.tenantId)).update('\0').update(codeId).digest('hex');
    try {
      const result = await authStore.voidAgentActivationCode(account, codeId, idempotencyKey, requestHash);
      return sendJson(res, result.statusCode, result.response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      if (error.publicCode) return sendJson(res, error.publicCode === 'agent_owner_required' ? 403 : Number(error.status) || 409, { error: error.publicCode, message: userErrorText(error, '作废激活码未通过校验，请刷新列表后重试。') });
      if (error.publicCode === 'idempotency_request_in_progress') return sendJson(res, 409, { error: error.publicCode, message: userErrorText(error, "相同操作正在处理中，请稍候片刻再查看结果。")}, { 'Retry-After': '2' });
      console.error('作废代理商激活码失败:', error.message);
      return sendJson(res, 500, { error: 'agent_activation_code_void_failed', message: '作废代理商激活码失败，服务端已记录原因，请稍后重试或联系管理员。' });
    }
  }

  if (pathname === '/api/sync-tasks' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    try {
      return sendJson(res, 200, await authStore.listSyncTasks(dataAccount, {
        limit: params.get('limit'), offset: params.get('offset'), type: params.get('type'), taskIds: params.get('ids'), parentTaskId: params.get('parentTaskId')
      }));
    } catch (error) {
      console.error('读取同步任务失败:', error.message);
      return sendJson(res, error.publicCode ? 400 : 500, { error: error.publicCode || 'sync_tasks_read_failed', message: error.publicCode ? error.message : '同步任务列表读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/sync-tasks' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const taskPermission = body.type === 'sync' || !body.type ? 'sync.run' : 'products.write';
    if (!authStore.hasPermission(account, taskPermission)) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    if (!/^sync-[A-Za-z0-9-]{6,100}$/.test(String(body.id || ''))) return sendJson(res, 400, { error: 'invalid_sync_task_id', message: '未找到这条同步任务，请刷新任务中心后重试。' });
    if (/^sync-(?:products-|shop-|orders-|category-attributes-)/.test(body.id)) return sendJson(res, 403, { error: 'server_owned_sync_task', message: '后台任务状态由服务器维护，不能由浏览器改写。' });
    try {
      return sendJson(res, 200, { item: await authStore.upsertSyncTask(dataAccount, { ...body, parentTaskId: '' }) });
    } catch (error) {
      if (error.publicCode === 'sync_task_owner_mismatch') return sendJson(res, 403, { error: error.publicCode, message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
      console.error('保存同步任务失败:', error.message);
      return sendJson(res, 500, { error: 'sync_task_save_failed', message: '同步任务保存失败，服务端已记录原因，请稍后重试。' });
    }
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const account = await authenticate(req);
    if (account && !requireCsrf(req, res)) return;
    if (!account && !requireAllowedOrigin(req, res)) return;
    if (account) await authStore.writeAudit(authStore.pool, account, 'auth.logout', 'session', account.sessionId, 'success');
    await revokeSession(req);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  if (pathname === '/api/auth/password' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!validatePassword(newPassword)) return sendJson(res, 400, { error: '新密码需为 6-128 个字符' });
    if (currentPassword === newPassword) return sendJson(res, 400, { error: '新密码不能与当前密码相同' });
    try { return sendJson(res, 200, await authStore.changePassword(account, currentPassword, newPassword)); }
    catch (error) {
      if (error.publicCode === 'current_password_invalid') return sendJson(res, 400, { error: '当前密码错误' });
      console.error('修改密码失败:', error.message);
      return sendJson(res, 500, { error: '修改密码失败' });
    }
  }

  if (pathname === '/api/auth/logout-all' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    try {
      const count = await authStore.revokeAllUserSessions(account);
      return sendJson(res, 200, { ok: true, revokedSessions: count }, { 'Set-Cookie': clearSessionCookie() });
    } catch (error) {
      console.error('退出全部设备失败:', error.message);
      return sendJson(res, 500, { error: '退出全部设备失败' });
    }
  }

  if (pathname === '/api/auth/profile' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    try { return sendJson(res, 200, { profile: await authStore.getProfile(account) }); }
    catch (error) { return profileErrorRes(res, error); }
  }

  if (pathname === '/api/auth/profile' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const input = normalizeProfileInput(body);
    if (input.error) return sendJson(res, 400, { error: input.error });
    try {
      return sendJson(res, 200, {
        profile: await authStore.updateProfile(account, {
          fullName: input.fullName, phone: input.phone, gender: input.gender, signature: input.signature, tenantName: input.tenantName
        })
      });
    } catch (error) { return profileErrorRes(res, error); }
  }

  if (pathname === '/api/auth/profile/email/send' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const normalized = normalizeProfileEmail(body.email);
    if (normalized.error) return sendJson(res, 400, { error: normalized.error });
    const sendCode = (email, code, minutes) => process.env.NODE_ENV === 'test' && process.env.ERP_EMAIL_CODE_TEST_MODE === '1'
      ? Promise.resolve({ sent: true, reason: 'test_mode', recipient: email })
      : bugMailer.sendEmailVerificationCode(email, code, minutes);
    try {
      const result = await authStore.requestEmailVerification(account, normalized.email, sendCode);
      return sendJson(res, 200, { ok: true, email: result.email, expiresAt: result.expiresAt });
    } catch (error) { return profileErrorRes(res, error); }
  }

  if (pathname === '/api/auth/profile/email/confirm' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const normalized = normalizeProfileEmail(body.email);
    if (normalized.error) return sendJson(res, 400, { error: normalized.error });
    const code = String(body.code == null ? '' : body.code).replace(/\D/g, '');
    if (!/^\d{6}$/.test(code)) return sendJson(res, 400, { error: '验证码为 6 位数字' });
    try { return sendJson(res, 200, { profile: await authStore.confirmEmailVerification(account, normalized.email, code) }); }
    catch (error) { return profileErrorRes(res, error); }
  }

  if (pathname === '/api/auth/profile/avatar' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!privateObjectStore.encryptionAvailable()) return sendJson(res, 503, { error: '头像存储未就绪：服务端私有对象加密密钥未配置' });
    const mediaType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!PROFILE_AVATAR_TYPES.has(mediaType)) return sendJson(res, 415, { error: '头像只支持 PNG、JPG、WebP 或 GIF 图片' });
    if (Number(req.headers['content-length'] || 0) > PROFILE_AVATAR_MAX_BYTES) return sendJson(res, 413, { error: '头像图片不得超过 2MB' });
    let body;
    try { body = await readBody(req, PROFILE_AVATAR_MAX_BYTES); }
    catch (error) {
      return sendJson(res, error.publicCode === 'body_too_large' ? 413 : 400, {
        error: error.publicCode === 'body_too_large' ? 'body_too_large' : 'avatar_upload_failed',
        message: userErrorText(error, error.publicCode === 'body_too_large' ? '头像图片不得超过 2MB，请压缩后重新上传。' : '头像上传失败，请重新选择图片后再试。')
      });
    }
    if (!body.length) return sendJson(res, 400, { error: '头像图片为空，请重新选择文件' });
    if (!matchesBugAttachmentSignature(mediaType, body)) return sendJson(res, 415, { error: '头像图片内容与所选格式不符，请重新选择' });
    let stored;
    try { stored = await privateObjectStore.putEncryptedBuffer({ tenantId: account.userId, kind: 'user_avatar', body }); }
    catch (error) {
      console.error('头像私有对象写入失败:', error.message);
      return sendJson(res, 500, { error: '头像保存失败，请稍后重试' });
    }
    try {
      const profile = await authStore.updateProfileAvatar(account, {
        objectKey: stored.objectKey, contentType: mediaType, sha256: stored.sha256, size: stored.size
      });
      return sendJson(res, 200, { ok: true, profile });
    } catch (error) { return profileErrorRes(res, error); }
  }

  if (pathname === '/api/auth/profile/avatar' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const target = String(new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams.get('user') || '').trim();
    if (!/^\d{1,18}$/.test(target)) return sendJson(res, 404, { error: '未找到可显示的头像' });
    let item;
    try { item = await authStore.getProfileAvatar(account, target); }
    catch (error) {
      console.error('头像读取失败:', error.message);
      return sendJson(res, 500, { error: '头像读取失败，请稍后重试' });
    }
    if (!item) return sendJson(res, 404, { error: '未找到可显示的头像' });
    let body;
    try { body = await privateObjectStore.readEncryptedBuffer(item.objectKey); }
    catch (error) { return sendJson(res, 500, { error: '头像读取失败，请稍后重试' }); }
    if (!body.length || crypto.createHash('sha256').update(body).digest('hex') !== item.sha256) {
      return sendJson(res, 500, { error: '头像完整性校验失败，请重新上传' });
    }
    const headers = securityHeaders();
    delete headers['Content-Security-Policy'];
    res.writeHead(200, Object.assign(headers, {
      'Content-Type': item.contentType, 'Content-Length': body.length, 'Cache-Control': 'private, no-store'
    }));
    res.end(body);
    return;
  }

  if (pathname === '/api/tenant/members' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!authStore.hasPermission(account, 'tenant.members.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    return sendJson(res, 200, { items: await authStore.listMembers(dataAccount) });
  }

  if (pathname === '/api/tenant/permissions' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!authStore.hasPermission(account, 'tenant.roles.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    return sendJson(res, 200, { items: await authStore.listPermissions() });
  }

  if (pathname === '/api/tenant/audit' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!authStore.hasPermission(account, 'audit.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const limit = Math.max(1, Math.min(100, Number(params.get('limit')) || 50));
    const beforeId = params.get('beforeId') || '';
    const items = (await authStore.listAuditEvents(dataAccount, { limit, beforeId })).map(localizeAuditEvent);
    return sendJson(res, 200, { items, nextBeforeId: items.length === limit ? items[items.length - 1].id : null });
  }

  if (pathname === '/api/tenant/audit/export' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!authStore.hasPermission(account, 'audit.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    try {
      const items = (await authStore.exportAuditEvents(dataAccount, 10000)).map(localizeAuditEvent);
      await authStore.recordAudit(account, 'audit.export', 'audit_events', '', 'success', { count: items.length, format: 'csv', queriedTenantId: dataAccount.tenantId });
      const rows = [['记录编号', '时间', '操作账号', '动作', '资源类型', '资源编号', '结果', '附加信息']];
      for (const item of items) rows.push([
        item.id, new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }), item.actorLabel || '历史未记录', item.action,
        item.resourceType, item.resourceId, item.result, formatAuditMetadata(item.metadata)
      ]);
      return sendCsv(res, `wyerp-audit-${new Date().toISOString().slice(0, 10)}.csv`, rows);
    } catch (error) {
      console.error('导出审计日志失败:', error.message);
      return sendJson(res, 500, { error: 'audit_export_failed', message: '审计记录导出失败，请稍后重试；仍未成功请联系管理员。' });
    }
  }

  if (pathname === '/api/tenant/shops' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!authStore.hasPermission(account, 'tenant.roles.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    try {
      const document = await authStore.getDocument(dataAccount, 'erp_shops_data');
      const shopData = document ? document.payload : (LEGACY_JSON_LAZY_IMPORT_ENABLED ? readTenantJson(dataAccount.tenantId, 'erp_shops_data') : null);
      if (Array.isArray(shopData)) await authStore.syncShops(dataAccount, shopData);
      return sendJson(res, 200, { items: await authStore.listShops(dataAccount) });
    } catch (error) {
      console.error('读取店铺目录失败:', error.message);
      return sendJson(res, 500, { error: '店铺目录读取失败' });
    }
  }

  if (pathname === '/api/tenant/members' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'tenant.members.manage')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const normalizedEmail = normalizeProfileEmail(body.email);
    const displayName = String(body.displayName || '').trim();
    const shopScopeMode = body.shopScopeMode === 'all' ? 'all' : 'selected';
    if (normalizedEmail.error) return sendJson(res, 400, { error: 'member_email_invalid', message: normalizedEmail.error });
    if (displayName.length > 120) return sendJson(res, 400, { error: 'display_name_too_long', message: '显示名称不能超过 120 个字符。' });
    try {
      return sendJson(res, 201, await authStore.createMember(dataAccount, { email: normalizedEmail.email, displayName, shopScopeMode }));
    } catch (error) {
      if (error.publicCode === 'membership_child_account_limit') return sendJson(res, 409, { error: error.publicCode, message: `当前会员最多可创建 ${error.limit} 个启用中的子账号` });
      if (['member_email_not_registered','member_email_invalid','member_self_add_denied'].includes(error.publicCode)) {
        return sendJson(res, 400, { error: error.publicCode, message: error.message });
      }
      if (error.publicCode === 'member_already_exists') return sendJson(res, 409, { error: error.publicCode, message: error.message });
      console.error('创建子账号失败:', error.message);
      return sendJson(res, 500, { error: 'member_create_failed', message: '子账号添加失败，请稍后重试。' });
    }
  }

  const memberStatusMatch = pathname.match(/^\/api\/tenant\/members\/(\d+)\/status$/);
  if (memberStatusMatch && req.method === 'PATCH') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'tenant.members.manage')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    if (!['active', 'disabled'].includes(body.status)) return sendJson(res, 400, { error: '状态必须是 active 或 disabled' });
    try { return sendJson(res, 200, await authStore.setMemberStatus(dataAccount, memberStatusMatch[1], body.status)); }
    catch (error) {
      if (error.publicCode === 'member_not_found') return sendJson(res, 404, { error: '子账号不存在' });
      console.error('更新子账号状态失败:', error.message);
      return sendJson(res, 500, { error: '状态更新失败' });
    }
  }

  const memberPermissionsMatch = pathname.match(/^\/api\/tenant\/members\/(\d+)\/permissions$/);
  if (memberPermissionsMatch && req.method === 'PATCH') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'tenant.roles.manage')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const permissions = Array.isArray(body.permissions) ? [...new Set(body.permissions.map(value => String(value).trim()).filter(Boolean))] : [];
    if (permissions.length > 100 || permissions.some(code => code.length > 100)) return sendJson(res, 400, { error: '权限列表无效' });
    const shopIds = Array.isArray(body.shopIds) ? body.shopIds : [];
    if (shopIds.length > 100 || shopIds.some(id => !/^\d+$/.test(String(id)))) return sendJson(res, 400, { error: '店铺范围无效' });
    try { return sendJson(res, 200, await authStore.setMemberPermissions(dataAccount, memberPermissionsMatch[1], permissions, body.shopScopeMode, shopIds)); }
    catch (error) {
      if (error.publicCode === 'member_not_found') return sendJson(res, 404, { error: '子账号不存在' });
      console.error('更新子账号权限失败:', error.message);
      return sendJson(res, 500, { error: '权限更新失败' });
    }
  }

  if (pathname === '/api/domain/queries/product-combinations' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account); if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看商品组合的权限，请联系管理员授权。' });
    try {
      const graph = await productCombinationGraph.read(authStore, dataAccount);
      return sendJson(res, 200, { schemaVersion: graph.payload.schemaVersion, relations: graph.payload.relations, aliases: graph.payload.aliases || [], history: graph.payload.history, version: graph.version, updatedAt: graph.updatedAt || graph.payload.updatedAt || '' }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      console.error('读取商品组合关系失败:', error.publicCode || error.message);
      return sendJson(res, error.status || 500, { error: error.publicCode || 'product_combination_read_failed', message: error.publicCode ? error.message : '商品组合关系读取失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/domain/queries/online-product-costs' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account); if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read') || !authStore.hasPermission(dataAccount, 'orders.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号缺少商品或订单读取权限，无法计算实际平均成本。' });
    const body = await readJsonBody(req, res, 16 * 1024); if (!body) return;
    try {
      const result = await onlineProductCostQuery.query({
        store: authStore,
        account: dataAccount,
        window: { days: body.days, from: body.from, to: body.to }
      });
      return sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
    } catch (error) {
      const code = error && (error.code || error.publicCode);
      if (code === 'invalid_window') return sendJson(res, 400, { error: 'online_product_cost_window_invalid', message: error.message });
      if (code === 'online_product_cost_rate_unavailable') return sendJson(res, error.status || 409, { error: code, message: error.message });
      console.error('在线商品平均成本读取失败:', code || error.message);
      return sendJson(res, 500, { error: 'online_product_cost_read_failed', message: '在线商品实际平均成本读取失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/domain/commands/product-edit' && ['GET', 'POST'].includes(req.method)) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (req.method === 'POST' && !requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const input = req.method === 'POST' ? await readJsonBody(req, res, 2 * 1024 * 1024) : {};
    if (!input) return;
    const query = new URL(req.url, 'http://localhost').searchParams;
    const rawTarget = input.target || { clientId: query.get('clientId'), productId: query.get('productId') };
    const target = { clientId: String(rawTarget.clientId || ''), productId: String(rawTarget.productId || '') };
    if (!/^\d{1,18}$/.test(target.clientId) || !/^\d+$/.test(target.productId) || !Number.isSafeInteger(Number(target.productId)) || Number(target.productId) <= 0) return sendJson(res, 400, { error: 'invalid_product_target', message: '未找到该商品，请刷新商品列表后重试。' });
    try {
      const allowed = await authStore.listAllowedShops(dataAccount);
      if (allowed !== null && !allowed.some(shop => String(shop.externalShopId) === target.clientId)) return sendJson(res, 403, { error: 'shop_scope_denied', message: '该店铺不在你的授权范围内，请重新选择店铺。' });
      if (req.method === 'GET' || input.action === 'read') return sendJson(res, 200, await authStore.getEditableProduct(dataAccount, target));
      if (input.action === 'runQueued') return sendJson(res, 400, { error: 'invalid_product_action', message: '请选择正确的商品操作（上架、下架、改价或同步）。' });
      if (input.action === 'enqueue') {
        const accepted = await productEdit.enqueue({ store: authStore, account: dataAccount, target, input, hosts: SUPPLIER_HOST_ALLOWLIST, idempotencyKey: String(req.headers['idempotency-key'] || ''), imagePublisher: publishSkuImagesForOzon });
        productEditQueue.tick();
        return sendJson(res, 202, accepted);
      }
      const call = productEditCall(dataAccount, target);
      return sendJson(res, 200, await productEdit.execute({ store: authStore, account: dataAccount, target, input, call, hosts: SUPPLIER_HOST_ALLOWLIST, idempotencyKey: String(req.headers['idempotency-key'] || ''), imagePublisher: publishSkuImagesForOzon }));
    } catch (error) {
      console.error('商品编辑命令失败:', error.publicCode || 'internal_error');
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'product_edit_failed', message: error.publicCode ? error.message : '商品保存失败，数据库事务未完成' });
    }
  }

  if (pathname === '/api/domain/queries/product-listing-records' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看商品记录的权限，请联系管理员授权。' });
    try {
      return sendJson(res, 200, { items: await authStore.listProductListingRecords(dataAccount) }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      console.error('读取上架记录失败:', error.message);
      return sendJson(res, 500, { error: 'product_listing_records_read_failed', message: '上架记录读取失败，请稍后刷新页面重试。' });
    }
  }

  if (pathname === '/api/domain/commands/product-create' && ['GET', 'POST'].includes(req.method)) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (req.method === 'POST' && !requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, req.method === 'GET' ? 'products.read' : 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const input = req.method === 'POST' ? await readJsonBody(req, res, 2 * 1024 * 1024) : {};
    if (!input) return;
    const query = new URL(req.url, 'http://localhost').searchParams;
    const clientId = String(input.clientId || query.get('clientId') || '').trim();
    const draftId = String(input.draftId || query.get('draftId') || '').trim();
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(clientId) || !/^draft_[\w-]+$/.test(draftId)) return sendJson(res, 400, { error: 'invalid_product_create_target', message: '未找到要新建商品的目标店铺，请先选择店铺后再提交。' });
    try {
      const shops = await authStore.listShops(dataAccount);
      if (!shops.some(shop => String(shop.externalShopId) === clientId)) return sendJson(res, 404, { error: 'shop_not_found', message: '未找到该店铺，请刷新店铺列表后重试。' });
      const allowed = await authStore.listAllowedShops(dataAccount);
      if (allowed !== null && !allowed.some(shop => String(shop.externalShopId) === clientId)) return sendJson(res, 403, { error: 'shop_scope_denied', message: '该店铺不在你的授权范围内，请重新选择店铺。' });
      if (req.method === 'GET') return sendJson(res, 200, await authStore.getProductCreateDraft(dataAccount, draftId));
      if (input.action !== 'enqueue') return sendJson(res, 400, { error: 'invalid_product_action', message: '请选择正确的商品操作（上架、下架、改价或同步）。' });
      const accepted = await productCreate.enqueue({ store: authStore, account: dataAccount, clientId, draftId, idempotencyKey: String(req.headers['idempotency-key'] || '') });
      productCreateQueue.tick();
      return sendJson(res, 202, accepted);
    } catch (error) {
      console.error('商品新增命令失败:', error.publicCode || 'internal_error');
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'product_create_failed', message: error.publicCode ? error.message : '新增商品入队失败，数据库事务未完成' });
    }
  }

  if (pathname === '/api/shop-analysis/seerfar' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'analytics.fetch')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有获取外部分析数据的权限，请联系管理员授权。' });
    const input = await readJsonBody(req, res, 16 * 1024);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const shopId = String(input.shopId || '').trim();
    const pageNumber = Number(input.pageNumber || 1);
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    try {
      const shops = await authStore.listShops(dataAccount);
      const target = shops.find(shop => String(shop && shop.externalShopId || '') === shopId);
      if (!target) return sendJson(res, 404, { error: 'shop_not_found', message: '未找到该店铺，请刷新店铺列表后重试。' });
      const allowed = await authStore.listAllowedShops(dataAccount);
      if (allowed !== null && !allowed.some(shop => String(shop && shop.externalShopId || '') === shopId)) {
        return sendJson(res, 403, { error: 'shop_scope_denied', message: '该店铺不在你的授权范围内，请重新选择店铺。' });
      }
      const pricing = await aiPricingStore.current();
      const fetched = await seerfarAnalysisBilling.fetchShopPage({
        tenantId: dataAccount.tenantId,
        actorUserId: dataAccount.userId,
        shopId,
        pageNumber,
        idempotencyKey,
        marketCache: seerfarMarketCache,
        chargeBean: pricing.analysis.effectiveBean,
        aiBeanStore
      });
      const payload = {
        ...fetched.result,
        billing: fetched.billing,
        pricing: { ...pricing.analysis, beanPerBatch: pricing.analysis.effectiveBean },
        shop: { id: shopId, name: String(target.name || target.displayName || shopId) }
      };
      await authStore.recordAudit(dataAccount, 'shop.analysis.seerfar.fetch', 'shop', shopId, 'success', {
        pageNumber,
        rowCount: fetched.billing.rowCount,
        chargedBean: fetched.billing.chargedBean,
        beanPerBatch: fetched.billing.beanPerBatch,
        cacheStatus: fetched.result && fetched.result.cache && fetched.result.cache.status || ''
      }).catch(() => {});
      return sendJson(res, 200, payload, { 'Cache-Control': 'no-store' });
    } catch (error) {
      if (error && error.billingReleaseError) console.error('Seerfar分析失败后的AI豆退回异常:', error.billingReleaseError.publicCode || error.billingReleaseError.message);
      const status = Number(error && error.status) || 502;
      const translated = String(error && error.message || 'Seerfar店铺分析数据读取失败，请稍后重试。');
      return sendJson(res, status, {
        error: String(error && error.publicCode || 'seerfar_analysis_failed'),
        message: bilingualSyncFailure(error, translated),
        billingReleased: Boolean(error && error.billingReleased)
      }, { 'Cache-Control': 'no-store' });
    }
  }

  if ((pathname === '/api/integrations/seerfar/ozon/product' || pathname === '/api/integrations/seerfar/ozon/products') && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const input = await readJsonBody(req, res, 16 * 1024);
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    try {
      const isBatchRequest = pathname.endsWith('/products');
      const result = isBatchRequest
        ? await seerfarMarketCache.requestProducts({ items: input.items })
        : input.queue === true
          ? await seerfarMarketCache.requestProduct({ sku: input.sku, dateRange: input.dateRange, forceRefresh: input.forceRefresh === true })
          : await seerfarMarketCache.getProduct({ sku: input.sku, dateRange: input.dateRange, forceRefresh: input.forceRefresh === true });
      if (isBatchRequest) {
        await Promise.all(result.items
          .filter(item => item.status === 'ready')
          .map(item => ozonCategoryReference.enrichProduct(item.result, { tenantId: dataAccount.tenantId })));
      } else if (!result.queued) {
        await ozonCategoryReference.enrichProduct(result, { tenantId: dataAccount.tenantId });
      }
      return sendJson(res, result.queued ? 202 : 200, result);
    } catch (error) {
      const code = String(error.publicCode || 'seerfar_upstream_failed');
      const allowed = new Set([
        'seerfar_not_configured', 'seerfar_quota_exhausted', 'seerfar_rate_limited',
        'seerfar_timeout', 'seerfar_network_failed', 'seerfar_response_too_large',
        'seerfar_upstream_failed', 'seerfar_empty_result', 'seerfar_product_not_found',
        'seerfar_sku_mismatch', 'seerfar_payload_sparse', 'seerfar_invalid_sku',
        'seerfar_invalid_date_range', 'seerfar_invalid_shop', 'seerfar_invalid_page',
        'seerfar_queue_full', 'seerfar_invalid_batch'
      ]);
      const publicCode = allowed.has(code) ? code : 'seerfar_upstream_failed';
      return sendJson(res, Number(error.status) || 502, { error: publicCode, message: allowed.has(code) ? error.message : 'Seerfar数据源暂时不可用。' });
    }
  }

  if (pathname === '/api/integrations/ozon/commands' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const requestData = await readJsonBody(req, res, 2 * 1024 * 1024);
    if (!requestData || typeof requestData !== 'object' || Array.isArray(requestData)) return;
    const clientId = String(requestData.clientId || '').trim();
    const commandName = String(requestData.command || '').trim();
    const command = getOzonCommand(commandName);
    const upstreamBody = requestData.body == null ? {} : requestData.body;
    if (!clientId || clientId.length > 120 || !command || !upstreamBody || typeof upstreamBody !== 'object' || Array.isArray(upstreamBody)) {
      return sendJson(res, 400, { error: 'invalid_ozon_command', message: '请选择正确的 Ozon 操作后再提交。' });
    }
    if (!command.permissions.some(permission => authStore.hasPermission(dataAccount, permission))) {
      return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    }
    const retryAfter = consumeOzonRateLimit(dataAccount, clientId);
    if (retryAfter) return sendJson(res, 429, { error: 'ozon_proxy_rate_limited', message: 'Ozon 请求过于频繁已被限制，请稍后再试。', retryAfter }, { 'Retry-After': String(retryAfter) });
    const serializedBody = JSON.stringify(upstreamBody);
    if (Buffer.byteLength(serializedBody) > 2 * 1024 * 1024) return sendJson(res, 413, { error: 'ozon_request_too_large', message: '本次提交的 Ozon 请求内容过大，请减少数量后分批提交。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    const idempotencyNamespace = `ozon:${commandName}:${clientId}`;
    let idempotencyClaim = null;
    if (command.writes) {
      if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    }
    try {
      const allowedShops = await authStore.listAllowedShops(dataAccount);
      if (allowedShops !== null && !allowedShops.some(shop => String(shop.externalShopId || '') === clientId)) {
        return sendJson(res, 403, { error: 'shop_scope_denied', message: '该店铺不在你的授权范围内，请重新选择店铺。' });
      }
      const document = await authStore.getDocument(dataAccount, 'erp_shops_data');
      const shops = document ? decryptShopCredentials(document.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
      const shop = Array.isArray(shops) ? shops.find(item => String(item && item.clientId || '') === clientId) : null;
      if (!shop || !shop.apiKey) return sendJson(res, 404, { error: 'shop_credentials_not_found', message: '该店铺尚未配置平台密钥，请先在店铺管理中添加密钥。' });
      if (shopApiHealthIsAbnormal(shop)) return sendJson(res, 409, { error: 'shop_api_abnormal', message: shopApiHealthMessage(shop) + '\n该店铺已自动跳过本次 Ozon 请求；请先在店铺列表点击“重新测试连接”。' });
      if (command.writes) {
        const requestHash = crypto.createHash('sha256').update(commandName).update('\0').update(clientId).update('\0').update(serializedBody).digest('hex');
        idempotencyClaim = await authStore.claimIdempotency(dataAccount, idempotencyNamespace, idempotencyKey, requestHash);
        if (idempotencyClaim.state === 'replay') return sendJson(res, idempotencyClaim.statusCode, idempotencyClaim.body, { 'Idempotency-Replayed': 'true' });
        if (idempotencyClaim.state === 'conflict') return sendJson(res, 409, { error: 'idempotency_key_conflict', message: '该请求编号已用于其他操作，请刷新页面后重新提交。' });
        if (idempotencyClaim.state !== 'claimed') return sendJson(res, 409, { error: 'idempotency_request_in_progress', message: '相同操作正在处理中，请稍候片刻再查看结果。' }, { 'Retry-After': '2' });
      }

      const fetchOptions = {
        method: 'POST',
        headers: {
          'Client-Id': clientId,
          'Api-Key': String(shop.apiKey),
          'Content-Type': 'application/json'
        },
        body: serializedBody
      };
      const scheduled = await ozonShopScheduler.run(clientId, async () => {
        let upstream, productReadText, timer;
        try {
          if (PRODUCT_READS.has(commandName)) {
            const result = await readProduct(commandName, OZON_API_BASE_URL + command.endpoint, fetchOptions);
            upstream = result.upstream; productReadText = result.text;
          } else {
            const controller = new AbortController();
            timer = setTimeout(() => controller.abort(), 45000);
            upstream = await fetch(OZON_API_BASE_URL + command.endpoint, { ...fetchOptions, signal: controller.signal });
          }
          const contentLength = Number(upstream.headers.get('content-length') || 0);
          if (contentLength > 10 * 1024 * 1024) {
            if (upstream.body) await upstream.body.cancel();
            throw Object.assign(new Error('Ozon 返回内容超过允许大小，请缩小查询范围后重试。'), { code: 'ozon_response_too_large' });
          }
          const text = productReadText === undefined ? await upstream.text() : productReadText;
          if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw Object.assign(new Error('Ozon 返回内容超过允许大小，请缩小查询范围后重试。'), { code: 'ozon_response_too_large' });
          return { upstream, text };
        } finally { if (timer) clearTimeout(timer); }
      });
      const upstream = scheduled.upstream;
      const text = scheduled.text;
      const contentLength = Number(upstream.headers.get('content-length') || 0);
      if (contentLength > 10 * 1024 * 1024) {
        if (command.writes) await authStore.failIdempotency(dataAccount, idempotencyNamespace, idempotencyKey);
        return sendJson(res, 502, { error: 'ozon_response_too_large', message: 'Ozon 返回内容超过允许大小，请缩小查询范围后重试。' });
      }
      if (Buffer.byteLength(text) > 10 * 1024 * 1024) {
        if (command.writes) await authStore.failIdempotency(dataAccount, idempotencyNamespace, idempotencyKey);
        return sendJson(res, 502, { error: 'ozon_response_too_large', message: 'Ozon 返回内容超过允许大小，请缩小查询范围后重试。' });
      }
      let payload;
      try { payload = text ? JSON.parse(text) : null; }
      catch (error) {
        if (command.writes) await authStore.failIdempotency(dataAccount, idempotencyNamespace, idempotencyKey);
        return sendJson(res, 502, { error: 'ozon_invalid_response', message: 'Ozon 返回的数据格式不正确，本次未采用该结果，请稍后重试。' });
      }
      if (!upstream.ok) {
        const upstreamMessage = String(payload && payload.message || '').slice(0, 300);
        const upstreamRetryAfter = String(upstream.headers.get('retry-after') || '').trim();
        const retryHeaders = /^\d+(?:\.\d+)?$/.test(upstreamRetryAfter) || !Number.isNaN(Date.parse(upstreamRetryAfter))
          ? { 'Retry-After': upstreamRetryAfter }
          : {};
        const responseStatus = upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502;
        const upstreamError = new Error(upstreamMessage || 'Ozon 接口本次调用失败，请稍后重试；若持续失败请联系系统管理员。');
        if (upstreamMessage) upstreamError.externalMessage = upstreamMessage;
        upstreamError.status = upstream.status;
        if (isOzonApiAccessDisabledError(upstreamError)) await markShopApiAbnormal(dataAccount, shop, upstreamError, 'ozon_command:' + commandName).catch(() => {});
        const responsePayload = {
          error: isOzonApiAccessDisabledError(upstreamError) ? 'shop_api_abnormal' : 'ozon_request_failed',
          message: isOzonApiAccessDisabledError(upstreamError)
            ? bilingualSyncFailure(upstreamError, 'Ozon 已禁用该店铺的 API 访问权限，当前无法执行同步或读取平台数据。请检查该店铺 API 权限，必要时联系 Ozon 支持恢复访问。')
            : (upstreamMessage || 'Ozon 接口本次调用失败，请稍后重试；若持续失败请联系系统管理员。'),
          ...(upstreamRetryAfter ? { retryAfter: upstreamRetryAfter } : {})
        };
        if (command.writes) await authStore.completeIdempotency(dataAccount, idempotencyNamespace, idempotencyKey, responseStatus, responsePayload);
        return sendJson(res, responseStatus, responsePayload, retryHeaders);
      }
      if (['catalog.getAttributeValues', 'catalog.searchAttributeValues'].includes(commandName)) optionEvidence.attach(payload, dataAccount, clientId, upstreamBody);
      if (command.writes) await authStore.completeIdempotency(dataAccount, idempotencyNamespace, idempotencyKey, 200, payload);
      return sendJson(res, 200, payload);
    } catch (error) {
      if (command.writes && idempotencyClaim && idempotencyClaim.state === 'claimed') await authStore.failIdempotency(dataAccount, idempotencyNamespace, idempotencyKey).catch(() => {});
      const code = ozonFailureCode(error);
      console.error('OZON 服务端命令失败:', commandName, code, new Date().toISOString());
      if (error.code === 'ozon_response_too_large') return sendJson(res, 502, { error: 'ozon_response_too_large', message: userErrorText(error, 'Ozon 返回内容超过允许大小，请缩小查询范围后重试。') });
      if (code === 'TIMEOUT') return sendJson(res, 502, { error: 'ozon_timeout', message: 'Ozon 接口响应超时，请稍后重试；若持续超时请缩小查询范围后重试。' });
      if (code !== 'UNKNOWN') return sendJson(res, 502, { error: 'ozon_network_failed', message: `连接 Ozon 接口失败，请检查店铺 API 凭证与本机网络后重试；若持续失败请提交 BUG 反馈，内部代号：${code}。` });
      return sendJson(res, 502, { error: 'ozon_request_failed', message: userErrorText(error, 'Ozon 接口请求未完成，请稍后重试；若持续失败请联系系统管理员。') });
    }
  }

  if (pathname === '/api/source-categories/match' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效，请重新登录后再匹配1688类目。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，请从当前页面重新匹配1688类目。', csrf: '页面验证信息已失效，请刷新后重新匹配1688类目。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看商品类目的权限，请联系管理员授权。' });
    const body = await readJsonBody(req, res, 64 * 1024, { invalid: '1688类目匹配请求格式不正确，请刷新页面后重试。', tooLarge: '1688类目匹配内容过大，请减少一次提交的内容。' });
    if (!body) return;
    try {
      return sendJson(res, 200, match1688Category(body));
    } catch (error) {
      const code = error.code || (/^source_category_(?:platform_invalid|catalog_unavailable|catalog_invalid|catalog_empty)$/.test(String(error.message || '')) ? error.message : '');
      if (code === 'source_category_platform_invalid') return sendJson(res, 400, { error: code, message: '只有1688货源支持自动匹配类目，请更换货源链接。' });
      if (code === 'source_category_catalog_unavailable') return sendJson(res, 503, { error: code, message: '1688类目目录暂不可用，请稍后重试；持续失败请联系系统管理员。' });
      if (code === 'source_category_catalog_invalid') return sendJson(res, 503, { error: code, message: '1688类目目录格式不正确，请联系系统管理员核对目录文件。' });
      if (code === 'source_category_catalog_empty') return sendJson(res, 503, { error: code, message: '1688类目目录暂无可匹配内容，请联系系统管理员更新目录。' });
      console.error('1688类目匹配失败:', new Date().toISOString());
      return sendJson(res, 500, { error: 'source_category_match_failed', message: '1688类目匹配失败，请稍后重试；持续失败请联系系统管理员。' });
    }
  }

  if (pathname === '/api/product-category-mappings/match' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效，请重新登录后再匹配Ozon类目。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，请从当前页面重新匹配Ozon类目。', csrf: '页面验证信息已失效，请刷新后重新匹配Ozon类目。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看商品类目的权限，请联系管理员授权。' });
    const body = await readJsonBody(req, res, 1024 * 1024, { invalid: 'Ozon类目匹配请求格式不正确，请刷新页面后重试。', tooLarge: 'Ozon类目匹配内容过大，请减少一次提交的商品数量。' });
    if (!body) return;
    const items = Array.isArray(body.items) ? body.items.map(normalizeOzonCategoryMatchItem) : [];
    if (!items.length || items.length > 300 || items.some(item => !validOzonCategoryMatchItem(item)) || new Set(items.map(item => item.id)).size !== items.length) {
      return sendJson(res, 400, { error: 'category_mapping_items_invalid', message: '请选择1至300条有效商品记录，且同批商品编号不能重复。' });
    }
    try {
      const [catalogCache, feedbackDocument] = await Promise.all([
        categoryMatchCompiledFor(dataAccount),
        authStore.getDocument(dataAccount, OZON_CATEGORY_FEEDBACK_KEY)
      ]);
      const feedback = normalizeOzonCategoryFeedback(feedbackDocument && feedbackDocument.payload);
      const matched = matchOzonCategoriesCompiled(items, catalogCache.compiled, feedback);
      return sendJson(res, 200, {
        ...matched,
        catalogUpdatedAt: catalogCache.updatedAt,
        training: { examples: feedback.examples.length, history: feedback.history.length, updatedAt: feedback.updatedAt }
      });
    } catch (error) {
      if (error.publicCode === 'ozon_category_catalog_empty') return sendJson(res, 503, { error: error.publicCode, message: 'Ozon类目目录暂无可匹配内容，请先更新类目数据。' });
      console.error('Ozon类目批量匹配失败:', error.message, new Date().toISOString());
      return sendJson(res, 500, { error: 'ozon_category_mapping_failed', message: 'Ozon类目匹配失败，请稍后重试；持续失败请联系系统管理员。' });
    }
  }

  if (pathname === '/api/product-category-mappings/feedback' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效，请重新登录后再保存类目匹配。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，类目匹配未保存，请从当前页面重新操作。', csrf: '页面验证信息已失效，类目匹配未保存，请刷新后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有修改商品类目映射的权限，请联系管理员授权。' });
    if (!dataAccount.isSystemAdmin && dataAccount.memberType !== 'owner' && dataAccount.shopScopeMode === 'selected') return sendJson(res, 403, { error: 'selected_shop_scope_write_denied', message: '当前账号只获授权部分店铺，不能保存整租户共用的类目映射。' });
    const body = await readJsonBody(req, res, 64 * 1024, { invalid: '类目匹配反馈格式不正确，本次未保存，请刷新页面后重试。', tooLarge: '类目匹配反馈内容过大，本次未保存，请缩减后重试。' });
    if (!body) return;
    const item = normalizeOzonCategoryMatchItem(body.item);
    const target = {
      descriptionCategoryId: String(body.target && body.target.descriptionCategoryId || '').trim(),
      typeId: String(body.target && body.target.typeId || '').trim()
    };
    if (!validOzonCategoryMatchItem(item) || !/^\d+$/.test(target.descriptionCategoryId) || !/^\d+$/.test(target.typeId)) {
      return sendJson(res, 400, { error: 'category_mapping_feedback_invalid', message: '来源商品或目标Ozon类目编号不正确，本次未保存。' });
    }
    try {
      const catalogCache = await categoryMatchCompiledFor(dataAccount);
      const productFingerprint = ozonCategoryTitleFingerprint(item);
      const saved = await authStore.mutateTenantDocumentWithAudit(
        dataAccount,
        OZON_CATEGORY_FEEDBACK_KEY,
        current => {
          const recorded = recordOzonCategoryFeedbackCompiled(current, item, target, catalogCache.compiled);
          return {
            payload: recorded.document,
            value: {
              match: recorded.match,
              changed: recorded.changed,
              examples: recorded.document.examples.length,
              history: recorded.document.history.length,
              exampleId: recorded.example.id
            }
          };
        },
        {
          action: 'product.category_mapping.feedback',
          resourceType: 'category_mapping_example',
          resourceId: productFingerprint,
          metadata: outcome => ({
            sourceSignature: ozonCategorySourceSignature(item),
            sourceCategoryId: item.sourceCategoryId,
            targetCategoryKey: `${target.descriptionCategoryId}:${target.typeId}`,
            changed: Boolean(outcome && outcome.value && outcome.value.changed)
          })
        }
      );
      return sendJson(res, 200, {
        ok: true,
        match: saved.value.match,
        training: { examples: saved.value.examples, history: saved.value.history, updatedAt: saved.updatedAt },
        version: saved.version
      });
    } catch (error) {
      if (error.publicCode === 'ozon_category_catalog_empty') return sendJson(res, 503, { error: error.publicCode, message: 'Ozon类目目录暂无可用内容，本次匹配未保存，请先更新类目数据。' });
      if (error.publicCode === 'ozon_category_target_invalid') return sendJson(res, 400, { error: error.publicCode, message: '目标Ozon类目不存在或不在当前目录中，本次匹配未保存。' });
      if (error.publicCode === 'category_mapping_title_required') return sendJson(res, 400, { error: error.publicCode, message: '来源商品缺少标题，本次匹配未保存，请补全标题后重试。' });
      console.error('保存Ozon类目人工反馈失败:', error.message, new Date().toISOString());
      return sendJson(res, 500, { error: 'category_mapping_feedback_failed', message: 'Ozon类目匹配保存失败，请稍后重试；持续失败请联系系统管理员。' });
    }
  }

  if (pathname === '/api/domain/queries/collection-sources' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'collection.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看采集箱的权限，请联系管理员授权。' });
    try {
      const requestUrl = new URL(req.url, 'http://' + HOST + ':' + PORT);
      const id = String(requestUrl.searchParams.get('id') || '').trim();
      const result = id
        ? await collectionService.get({ store: authStore, account: dataAccount, id })
        : await collectionService.list({ store: authStore, account: dataAccount });
      if (id && !result.item) return sendJson(res, 404, { error: 'collection_source_not_found', message: '未找到该采集货源，请刷新采集箱后重试。' });
      const projectedItems = await projectBusinessIdentityDisplay('erp_collected_products', id && result.item ? [result.item] : (result.items || []), dataAccount);
      const safeResult = { ...result, items: projectedItems };
      if (id) safeResult.item = projectedItems.find(row => String(row && row.id || '') === id) || null;
      return sendJson(res, 200, safeResult);
    } catch (error) {
      console.error('读取标准采集货源失败:', error.message);
      return sendJson(res, error.status || 500, { error: error.publicCode || 'collection_source_read_failed', message: userErrorText(error, '采集货源读取失败，请稍后重试。') });
    }
  }

  if (pathname === '/api/domain/commands/collection-source' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'collection.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有采集箱写入权限，请联系管理员授权。' });
    if (!dataAccount.isSystemAdmin && dataAccount.memberType !== 'owner' && dataAccount.shopScopeMode === 'selected') {
      return sendJson(res, 403, { error: 'selected_shop_scope_write_denied', message: '所选店铺范围账号不能修改共享采集箱，请联系管理员调整权限。' });
    }
    const body = await readJsonBody(req, res, 2 * 1024 * 1024);
    if (!body) return;
    const action = String(body.action || 'upsert').trim().toLowerCase();
    if (!['upsert', 'refresh', 'package-facts'].includes(action)) return sendJson(res, 400, { error: 'collection_action_invalid', message: '该采集箱操作不受支持，请重新发起采集。' });
    try {
      const execute = action === 'refresh' ? collectionService.refresh : action === 'package-facts' ? collectionService.backwritePackageFacts : collectionService.upsert;
      const result = await execute({
        store: authStore,
        account: dataAccount,
        payload: body.payload,
        operationSource: action === 'refresh' ? 'refresh' : action === 'package-facts' ? 'product_create_user' : 'collector',
        withQuota: (STANDALONE_MODE || action === 'package-facts') ? undefined : (nextPayload, writer) => membershipQuota.withCollectionBoxGate(authStore, dataAccount, nextPayload, writer)
      });
      const projectedItem = (await projectBusinessIdentityDisplay('erp_collected_products', result.item ? [result.item] : [], dataAccount))[0] || null;
      return sendJson(res, result.created ? 201 : 200, { ...result, item: projectedItem });
    } catch (error) {
      if (error.publicCode === 'membership_collection_box_limit') return sendJson(res, 409, { error: error.publicCode, message: userErrorText(error, '采集箱会员额度已用完，请先清理不再需要的商品或升级会员。') });
      if (error.publicCode === 'document_version_conflict' || error.publicCode === 'collection_write_conflict') return sendJson(res, 409, { error: error.publicCode, message: userErrorText(error, '采集箱刚被其他操作更新，请重新采集。') });
      if (error.publicCode && (error.status || 400) < 500) return sendJson(res, error.status || 400, { error: error.publicCode, message: userErrorText(error, '采集数据格式不正确，请重新采集。') });
      console.error('标准采集货源写入失败:', error.message);
      return sendJson(res, 500, { error: 'collection_source_write_failed', message: '采集箱保存失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/domain/commands/source-boundary' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效，货源信息未保存，请重新登录后重试。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，货源信息未保存，请从当前页面重新操作。', csrf: '页面验证信息已失效，货源信息未保存，请刷新页面后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'orders.write') || !authStore.hasPermission(dataAccount, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有同时修改商品和订单货源的权限，请联系空间管理员授权。' });
    if (!dataAccount.isSystemAdmin && dataAccount.memberType !== 'owner' && dataAccount.shopScopeMode === 'selected') return sendJson(res, 403, { error: 'selected_shop_scope_write_denied', message: '当前账号仅能操作指定店铺，不能修改跨店铺的商品与订单货源关联。' });
    const body = await readJsonBody(req, res, 32 * 1024, { tooLarge: '货源信息请求内容过大，本次修改未保存，请减少输入后重试。', invalid: '货源信息请求格式不正确，本次修改未保存，请刷新页面后重试。' });
    if (!body) return;
    const action = String(body.action || '');
    if (!['repair-all', 'update-product-source'].includes(action)) return sendJson(res, 400, { error: 'unsupported_business_command', message: '不支持该货源关联操作，本次修改未保存，请刷新页面后重试。' });
    try {
      return sendJson(res, 200, await authStore.sourceBoundaryCommand(dataAccount, { ...body, action }, productSourceLink, SUPPLIER_HOST_ALLOWLIST));
    } catch (error) {
      if (['product_not_found', 'supplier_url_invalid', 'supplier_url_not_allowed', 'unsupported_business_command'].includes(error.publicCode)) {
        if (error.publicCode === 'product_not_found') return sendJson(res, 404, { error: error.publicCode, message: '未找到要修改的在线商品，货源信息未保存，请刷新列表后重试。' });
        if (error.publicCode === 'supplier_url_invalid') return sendJson(res, 400, { error: error.publicCode, message: '货源地址格式不正确，货源信息未保存，请检查地址后重试。' });
        if (error.publicCode === 'supplier_url_not_allowed') return sendJson(res, 400, { error: error.publicCode, message: '货源地址不属于允许的网站，货源信息未保存，请更换有效地址。' });
        return sendJson(res, 400, { error: error.publicCode, message: '不支持该货源关联操作，货源信息未保存，请刷新页面后重试。' });
      }
      console.error('跨业务边界事务命令失败:', action, error.message);
      return sendJson(res, 500, { error: 'business_transaction_failed', message: '货源信息保存失败，本次修改没有生效，请稍后重试。' });
    }
  }

  if (pathname === '/api/domain/commands/business-rows' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效，业务数据未保存，请重新登录后重试。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，业务数据未保存，请从当前页面重新操作。', csrf: '页面验证信息已失效，业务数据未保存，请刷新页面后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res, BUSINESS_ROWS_JSON_MAX_BYTES, { tooLarge: '业务数据请求内容过大，本次未保存，请减少数据后重试。', invalid: '业务数据请求格式不正确，本次未保存，请刷新页面后重试。' });
    if (!body) return;
    const key = String(body.key || '');
    const moduleName = key === 'erp_orders_data' || key === 'erp_accruals_data' || key === 'erp_acquiring_data' || key === 'erp_amount_fix_v1'
      ? 'orders' : key === 'erp_online_products' ? 'products' : '';
    if (!moduleName || !RELATIONAL_BUSINESS_KEYS.has(key) || FINANCE_SETTING_KEYS.has(key) || key === 'erp_bug_reports') {
      return sendJson(res, 400, { error: 'unsupported_business_row_key', message: '该行数据标识不受支持，请刷新页面后重试。' });
    }
    if (!authStore.hasPermission(dataAccount, moduleName + '.write')) return sendJson(res, 403, key === 'erp_online_products' ? { error: 'permission_denied', message: '当前账号没有修改在线商品的权限，请联系空间管理员授权。' } : { error: 'permission_denied' });
    if (!dataAccount.isSystemAdmin && dataAccount.memberType !== 'owner' && dataAccount.shopScopeMode === 'selected') {
      return sendJson(res, 403, key === 'erp_online_products' ? { error: 'selected_shop_scope_write_denied', message: '当前账号仅能操作指定店铺，不能修改整个客户空间的在线商品集合。' } : { error: 'selected_shop_scope_write_denied' });
    }
    const expectedVersion = Number(body.expectedVersion);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return sendJson(res, 400, key === 'erp_online_products' ? { error: 'invalid_data_version', message: '在线商品数据版本不正确，本次未保存，请刷新列表后重试。' } : { error: 'invalid_data_version' });
    try {
      let desired = body.payload;
      let commissionRateDocument = null;
      if (key === 'erp_online_products' && body.source === 'sync') {
        commissionRateDocument = await authStore.getDocument(dataAccount, 'erp_rate');
        const enriched = await ozonCommissionCatalog.enrichProducts({
          products: desired, cnyPerRub: commissionRateDocument && commissionRateDocument.payload
        });
        desired = enriched.products;
      }
      const existing = await authStore.getDocument(dataAccount, key);
      if (AUDITED_KEYS.has(key)) {
        const displayIdentity = await authStore.accountDisplayIdentity(dataAccount);
        const actorAccount = { ...dataAccount, profileFullName: displayIdentity.profileFullName || '', email: displayIdentity.email || '' };
        desired = applyEntityAudit(key, existing ? existing.payload : [], desired, actorAccount, undefined, {
          source: body.source === 'sync' ? 'sync' : 'manual'
        });
      }
      const saved = await authStore.replaceBusinessRows(dataAccount, key, desired, expectedVersion, SUPPLIER_HOST_ALLOWLIST, {
        source: body.source === 'sync' ? 'sync' : 'manual'
      });
      let commissionCatalogUpdate = null;
      if (key === 'erp_online_products' && body.source === 'sync') {
        try {
          commissionCatalogUpdate = await ozonCommissionCatalog.updateFromProducts({
            tenantId: dataAccount.tenantId, products: saved.payload,
            cnyPerRub: commissionRateDocument && commissionRateDocument.payload
          });
        } catch (catalogError) {
          console.error('自动更新Ozon佣金费率文件失败:', catalogError.message);
          commissionCatalogUpdate = { updated: false, error: 'commission_catalog_update_failed', message: '佣金目录更新失败，服务端已记录原因，请稍后重试或联系管理员。' };
        }
      }
      if (key === 'erp_orders_data' && body.source === 'sync') {
        try {
          const [rateDocument, productsDocument] = await Promise.all([
            authStore.getDocument(dataAccount, 'erp_rate'),
            authStore.getDocument(dataAccount, 'erp_online_products')
          ]);
          commissionCatalogUpdate = await ozonCommissionCatalog.updateFromSettledOrders({
            tenantId: dataAccount.tenantId, orders: saved.payload,
            products: productsDocument && productsDocument.payload,
            cnyPerRub: rateDocument && rateDocument.payload
          });
        } catch (catalogError) {
          console.error('使用已结算订单更新Ozon佣金费率文件失败:', catalogError.message);
          commissionCatalogUpdate = { updated: false, error: 'commission_catalog_settlement_update_failed', message: '佣金结算口径更新失败，请稍后重试；仍未成功请联系管理员。' };
        }
      }
      const scopedPayload = filterShopScopedData(key, saved.payload, null, dataAccount);
      const responsePayload = await projectBusinessIdentityDisplay(key, scopedPayload, dataAccount);
      return sendJson(res, 200, {
        ok: true, version: saved.version, updatedAt: saved.updatedAt,
        payload: responsePayload,
        commissionCatalog: commissionCatalogUpdate
      });
    } catch (error) {
      if (error.publicCode === 'document_version_conflict') return sendJson(res, 409, key === 'erp_online_products' ? { error: 'data_version_conflict', message: '在线商品数据已被其他操作更新，本次未覆盖，请刷新列表后重试。' } : { error: 'data_version_conflict' });
      if (error.publicCode === 'product_edit_pending') return sendJson(res, 409, { error: 'product_edit_pending', message: '在线商品仍有待处理的编辑任务，本次未保存，请等待任务完成后重试。' });
      if (error.publicCode === 'product_draft_pending') return sendJson(res, 409, { error: 'product_draft_pending', message: '商品仍有服务器草稿，不能通过集合同步移除。' });
      if (['supplier_url_invalid', 'supplier_url_not_allowed', 'unsupported_business_row_key', 'business_row_limit_exceeded'].includes(error.publicCode)) {
        if (key === 'erp_online_products' && error.publicCode === 'supplier_url_invalid') return sendJson(res, 400, { error: error.publicCode, message: '商品货源地址格式不正确，本次未保存，请检查后重试。' });
        if (key === 'erp_online_products' && error.publicCode === 'supplier_url_not_allowed') return sendJson(res, 400, { error: error.publicCode, message: '商品货源地址不属于允许的网站，本次未保存，请更换有效地址。' });
        if (key === 'erp_online_products' && error.publicCode === 'business_row_limit_exceeded') return sendJson(res, 400, { error: error.publicCode, message: '在线商品数据量超过本次保存上限，请减少数据后重试。' });
        return sendJson(res, 400, key === 'erp_online_products' ? { error: error.publicCode, message: '在线商品保存请求不受支持，本次未保存，请刷新页面后重试。' } : { error: error.publicCode });
      }
      console.error('行级业务命令失败:', key, error.message);
      return sendJson(res, 500, key === 'erp_online_products' ? { error: 'business_row_command_failed', message: '在线商品保存失败，无法确认是否已生效，请刷新列表核对后重试。' } : { error: 'business_row_command_failed' });
    }
  }

  if (pathname === '/api/domain/commands/finance-settings' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再保存财务设置。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，财务设置未保存，请从当前页面重新操作。', csrf: '页面验证信息已失效，财务设置未保存，请刷新页面后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'orders.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有修改订单财务设置的权限，请联系空间管理员授权。' });
    if (!dataAccount.isSystemAdmin && dataAccount.memberType !== 'owner' && dataAccount.shopScopeMode === 'selected') return sendJson(res, 403, { error: 'selected_shop_scope_write_denied', message: '当前账号仅能操作指定店铺，不能修改整个客户空间的汇率和贴单费。' });
    const body = await readJsonBody(req, res, 4 * 1024, { tooLarge: '财务设置请求内容超过4KB，本次修改未保存，请减少输入后重试。', invalid: '财务设置请求格式不正确，本次修改未保存，请刷新页面后重试。' });
    if (!body) return;
    try {
      return sendJson(res, 200, await authStore.updateFinanceSettingsTransaction(dataAccount, body));
    } catch (error) {
      if (error.publicCode === 'invalid_finance_setting') return sendJson(res, 400, { error: error.publicCode, message: '汇率和贴单费必须填写非负数字，请检查后重试。' });
      console.error('财务设置事务命令失败:', error.message);
      return sendJson(res, 500, { error: 'business_transaction_failed', message: '财务设置保存失败，本次修改没有生效，请稍后重试。' });
    }
  }

  if (pathname === '/api/exchange-rates/cny-rub' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    return sendJson(res, 200, await currentCnyRubRate({ store: authStore }), { 'Cache-Control': 'no-store' });
  }

  if (pathname === '/api/shops/test-connection' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'shops.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有测试店铺连接的权限，请联系管理员授权。' });
    const body = await readJsonBody(req, res, 8 * 1024);
    if (!body) return;
    const clientId = String(body.clientId || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(clientId)) return sendJson(res, 400, { error: 'shop_client_id_invalid', message: '店铺编号不正确，请刷新店铺列表后重试。' });
    try {
      const allowed = await authStore.listAllowedShops(dataAccount);
      if (allowed !== null && !allowed.some(item => String(item.externalShopId || '') === clientId)) return sendJson(res, 403, { error: 'shop_scope_denied', message: '该店铺不在你的授权范围内，请重新选择店铺。' });
      const document = await authStore.getDocument(dataAccount, 'erp_shops_data');
      const shops = document ? decryptShopCredentials(document.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
      const shop = Array.isArray(shops) ? shops.find(item => String(item && item.clientId || '') === clientId) : null;
      if (!shop || !shop.apiKey) return sendJson(res, 409, { error: 'shop_credentials_not_found', message: '该店铺尚未配置平台密钥，请先编辑店铺填写 API Key。' });
      const request = createDirectOzonRequester(shop, dataAccount, 'shop_connection_test', { allowAbnormal: true });
      await request('/v1/roles', {});
      await clearShopApiAbnormal(dataAccount, clientId, 'shop_connection_test');
      return sendJson(res, 200, { ok: true, clientId, status: '正常', message: '连接测试成功，店铺 API 状态已恢复正常。' });
    } catch (error) {
      if (isOzonApiAccessDisabledError(error)) await markShopApiAbnormal(dataAccount, clientId, error, 'shop_connection_test').catch(() => {});
      const translated = isOzonApiAccessDisabledError(error)
        ? 'Ozon 已禁用该店铺的 API 访问权限，当前无法执行同步或读取平台数据。请检查该店铺 API 权限，必要时联系 Ozon 支持恢复访问。'
        : 'Ozon 店铺连接测试失败，请检查 API 密钥、店铺权限和网络后重试。';
      return sendJson(res, Number(error.status) || 502, { error: error.publicCode || 'shop_connection_test_failed', message: bilingualSyncFailure(error, translated) });
    }
  }

  if (pathname === '/api/shops/sync' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'shops.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const body = await readJsonBody(req, res, 32 * 1024);
    if (!body) return;
    const kind = String(body.kind || '');
    const batchId = /^sync-[A-Za-z0-9-]{6,100}$/.test(String(body.batchId || '')) ? String(body.batchId) : '';
    if (body.batchId && !batchId) return sendJson(res, 400, { error: 'sync_batch_id_invalid', message: '同步批次标识不正确，请重新发起一次同步。' });
    const clientIds = [...new Set((Array.isArray(body.clientIds) ? body.clientIds : []).map(value => String(value).trim()).filter(value => /^[A-Za-z0-9._:-]{1,120}$/.test(value)))].slice(0, 100);
    if (!['limit', 'warehouse'].includes(kind) || !clientIds.length) return sendJson(res, 400, { error: 'shop_sync_input_invalid', message: '店铺数据格式不正确，已拒收，请重新提交。' });
    const items = [], skipped = [];
    try {
      const allowed = await authStore.listAllowedShops(dataAccount);
      if (allowed !== null && clientIds.some(clientId => !allowed.some(item => String(item.externalShopId || '') === clientId))) return sendJson(res, 403, { error: 'shop_scope_denied', message: '该店铺不在你的授权范围内，请重新选择店铺。' });
      const shopDocument = await authStore.getDocument(dataAccount, 'erp_shops_data');
      const storedShops = shopDocument ? decryptShopCredentials(shopDocument.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
      const shopByClientId = new Map((Array.isArray(storedShops) ? storedShops : []).map(shop => [String(shop && shop.clientId || ''), shop]));
      for (let index = 0; index < clientIds.length; index += 1) {
        const clientId = clientIds[index];
        const storedShop = shopByClientId.get(clientId);
        if (shopApiHealthIsAbnormal(storedShop)) { skipped.push(shopApiSkipItem(storedShop)); continue; }
        const id = `sync-shop-${kind}-${crypto.randomUUID()}`;
        let persisted;
        try {
          persisted = await authStore.enqueueBackgroundJob(dataAccount, { id, type: 'shops_sync', dedupeKey: kind + ':' + clientId, context: { clientId, kind, batchId }, maxAttempts: 3, task: { name: kind === 'limit' ? '商品限额同步' : '仓库同步', label: '已进入服务器队列', article: clientId, parentTaskId: batchId } });
        } catch (error) {
          if (!persistentQueueSchemaMissing(error)) throw error;
        }
        if (persisted && persisted.job) items.push({ id: persisted.job.id, clientId, duplicate: persisted.duplicate, state: persisted.job.state });
        else {
          const volatile = shopSyncFallbackQueue.enqueue(String(dataAccount.tenantId) + '|' + kind + '|' + clientId, () => runPersistedShopSync({ tenantId: dataAccount.tenantId, actorUserId: dataAccount.userId, id, type: 'shops_sync', context: { clientId, kind, batchId }, createdAt: new Date().toISOString() }));
          if (volatile.full) return sendJson(res, 503, { error: 'shop_sync_queue_full', message: '店铺同步兼容队列已满，请稍后重试。', items }, { 'Retry-After': '10' });
          if (volatile.duplicate) return sendJson(res, 409, { error: 'background_job_scope_conflict', message: '该店铺已有兼容队列任务，请等待原任务完成后重试。', items });
          items.push({ id, clientId, duplicate: volatile.duplicate, state: 'queued', volatile: true });
        }
      }
      return sendJson(res, 202, { ok: true, items, skipped });
    } catch (error) {
      if (error.publicCode === 'background_job_queue_full') return sendJson(res, 503, { error: 'background_job_queue_full', message: '服务器任务队列已满，请稍后重试。', items }, { 'Retry-After': '10' });
      if (error.publicCode === 'background_job_scope_conflict') return sendJson(res, 409, { error: error.publicCode, message: '该店铺已有其他操作人的同步任务，请等待完成后重试。', items });
      console.error('店铺后台同步入队失败:', error.message);
      return sendJson(res, 500, { error: 'shop_sync_enqueue_failed', message: '店铺同步入队失败，请到任务中心核对已接受任务后重试。', items });
    }
  }
  if (pathname === '/api/products/sync' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效，商品同步未入队，请重新登录后重试。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，商品同步未入队，请从当前页面重新操作。', csrf: '页面验证信息已失效，商品同步未入队，请刷新页面后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有同步在线商品的权限，请联系空间管理员授权。' });
    const body = await readJsonBody(req, res, 128 * 1024, { tooLarge: '商品同步请求内容过大，本次未入队，请减少所选商品后重试。', invalid: '商品同步请求格式不正确，本次未入队，请刷新页面后重试。' });
    if (!body) return;
    const mode = body.mode === 'selected' ? 'selected' : 'all';
    const batchId = /^sync-[A-Za-z0-9-]{6,100}$/.test(String(body.batchId || '')) ? String(body.batchId) : '';
    if (body.batchId && !batchId) return sendJson(res, 400, { error: 'sync_batch_id_invalid', message: '商品同步批次标识不正确，本次未入队，请重新发起同步。' });
    const rawItems = Array.isArray(body.items) ? body.items : [];
    const items = rawItems.slice(0, 100).map(item => ({
      clientId: String(item && item.clientId || '').trim(),
      productIds: [...new Set((Array.isArray(item && item.productIds) ? item.productIds : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 1000)
    }));
    if (!items.length || items.some(item => !/^[A-Za-z0-9._:-]{1,120}$/.test(item.clientId) || (mode === 'selected' && !item.productIds.length))) return sendJson(res, 400, { error: 'product_sync_input_invalid', message: '请选择有效店铺和商品后再同步，本次任务未入队。' });
    const queued = [], skipped = [];
    try {
      const allowed = await authStore.listAllowedShops(dataAccount);
      if (allowed !== null && items.some(item => !allowed.some(shop => String(shop.externalShopId || '') === item.clientId))) return sendJson(res, 403, { error: 'shop_scope_denied', message: '所选店铺不在当前账号的授权范围内，商品同步未入队，请重新选择店铺。' });
      const document = await authStore.getDocument(dataAccount, 'erp_shops_data');
      const shops = document ? decryptShopCredentials(document.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
      if (items.some(item => !Array.isArray(shops) || !shops.some(shop => String(shop && shop.clientId || '') === item.clientId && shop.apiKey))) return sendJson(res, 404, { error: 'shop_credentials_not_found', message: '所选店铺缺少可用的Ozon授权，商品同步未入队，请先检查店铺授权。' });
      const shopByClientId = new Map((Array.isArray(shops) ? shops : []).map(shop => [String(shop && shop.clientId || ''), shop]));
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const storedShop = shopByClientId.get(item.clientId);
        if (shopApiHealthIsAbnormal(storedShop)) { skipped.push(shopApiSkipItem(storedShop)); continue; }
        const id = `sync-products-${crypto.randomUUID()}`;
        const context = { clientId: item.clientId, mode, productIds: mode === 'selected' ? item.productIds : [], runId: 'product-' + crypto.randomUUID(), batchId };
        let persisted;
        try {
          persisted = await authStore.enqueueBackgroundJob(dataAccount, { id, type: 'products_sync', dedupeKey: item.clientId, context, maxAttempts: 3, task: { name: '在线商品同步（服务器资源）', label: '已进入服务器队列', article: item.clientId, parentTaskId: batchId } });
        } catch (error) {
          if (!persistentQueueSchemaMissing(error)) throw error;
        }
        if (persisted && persisted.job) queued.push({ id: persisted.job.id, clientId: item.clientId, duplicate: persisted.duplicate, state: persisted.job.state });
        else {
          const synthetic = { tenantId: dataAccount.tenantId, actorUserId: dataAccount.userId, id, type: 'products_sync', context, createdAt: new Date().toISOString() };
          const volatile = productSyncFallbackQueue.enqueue(String(dataAccount.tenantId) + '|' + item.clientId, () => runPersistedProductSync(synthetic));
          if (volatile.full) return sendJson(res, 503, { error: 'product_sync_queue_full', message: '商品同步兼容队列已满，请稍后重试。', items: queued }, { 'Retry-After': '10' });
          if (volatile.duplicate) return sendJson(res, 409, { error: 'background_job_scope_conflict', message: '该店铺已有兼容队列任务，请等待原任务完成后重试。', items: queued });
          queued.push({ id, clientId: item.clientId, duplicate: volatile.duplicate, state: 'queued', volatile: true });
        }
      }
      return sendJson(res, 202, { ok: true, items: queued, skipped });
    } catch (error) {
      if (error.publicCode === 'background_job_queue_full') return sendJson(res, 503, { error: 'background_job_queue_full', message: '服务器任务队列已满，请稍后重试。', items: queued }, { 'Retry-After': '10' });
      if (error.publicCode === 'background_job_scope_conflict') return sendJson(res, 409, { error: error.publicCode, message: '该店铺已有不同范围或其他操作人的同步任务，请等待完成后重试。', items: queued });
      console.error('商品后台同步入队失败:', error.message);
      return sendJson(res, 500, { error: 'product_sync_enqueue_failed', message: '商品同步入队失败，请到任务中心核对已接受任务后重试。', items: queued });
    }
  }
  if (pathname === '/api/integrations/ozon/cookie-bindings' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    cleanupSellerCookieBindings();
    const allowed = await authStore.listAllowedShops(dataAccount);
    const allowedIds = allowed === null ? null : new Set(allowed.map(item => String(item.externalShopId || '')));
    const document = await authStore.getDocument(dataAccount, 'erp_shops_data');
    let shops = [];
    try { shops = document ? decryptOrderCookieShops(document.payload, dataAccount.tenantId) : []; }
    catch (_) {
      const items = (Array.isArray(document?.payload) ? document.payload : []).map(shop => String(shop && shop.clientId || '')).filter(clientId => clientId && (!allowedIds || allowedIds.has(clientId)))
        .map(clientId => ({ clientId, status: 'unauthorized', persistent: false, reason: 'seller_cookie_credential_unreadable' }));
      return sendJson(res, 200, { items, authorizationState: 'unreadable' });
    }
    const itemsByClientId = new Map();
    for (const shop of Array.isArray(shops) ? shops : []) {
      const clientId = String(shop && shop.clientId || '');
      const authorization = shop && shop.sellerCookieAuthorization;
      if (!clientId || allowedIds && !allowedIds.has(clientId) || shop.cookie !== '已授权' || authorization?.status !== 'authorized' || !Array.isArray(shop.sellerCookies) || !shop.sellerCookies.length) continue;
      itemsByClientId.set(clientId, { clientId, status: 'authorized', boundAt: authorization.verifiedAt, lastVerifiedAt: authorization.verifiedAt, persistent: true });
    }
    for (const binding of sellerCookieBindings.values()) {
      if (String(binding.tenantId) !== String(dataAccount.tenantId) || allowedIds && !allowedIds.has(binding.clientId)) continue;
      const current = itemsByClientId.get(binding.clientId) || {};
      itemsByClientId.set(binding.clientId, { ...current, clientId: binding.clientId, status: 'authorized', boundAt: current.boundAt || binding.boundAt, lastVerifiedAt: binding.boundAt, expiresAt: new Date(binding.expiresAt).toISOString(), persistent: Boolean(current.persistent) });
    }
    return sendJson(res, 200, { items: Array.from(itemsByClientId.values()) });
  }
  if (pathname === '/api/integrations/ozon/cookie-bindings' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res, 512 * 1024);
    if (!body) return;
    const clientId = String(body.clientId || '').trim();
    if (!/^[1-9]\d{2,19}$/.test(clientId) || typeof body.verified !== 'boolean') return sendJson(res, 400, { error: 'seller_cookie_binding_invalid', message: '店铺授权信息与当前店铺不匹配，请重新完成一次授权。' });
    const hasSubmittedCookies = Object.prototype.hasOwnProperty.call(body, 'cookies');
    const submittedCookies = hasSubmittedCookies ? normalizeSellerCookies(body.cookies) : null;
    if (body.verified === true && hasSubmittedCookies && !submittedCookies) return sendJson(res, 400, { error: 'seller_cookie_payload_invalid', message: '授权数据格式不正确，请在插件中重新授权后重试。' });
    const allowed = await authStore.listAllowedShops(dataAccount);
    if (allowed !== null && !allowed.some(item => String(item.externalShopId || '') === clientId)) return sendJson(res, 403, { error: 'shop_scope_denied', message: '该店铺不在你的授权范围内，请重新选择店铺。' });
    const document = await authStore.getDocument(dataAccount, 'erp_shops_data');
    const shops = document ? decryptShopCredentials(document.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
    if (!Array.isArray(shops) || !shops.some(shop => String(shop && shop.clientId || '') === clientId)) return sendJson(res, 404, { error: 'shop_not_found', message: '未找到该店铺，请刷新店铺列表后重试。' });
    const key = sellerCookieBindingKey(dataAccount.tenantId, clientId);
    // Cookie binding is a collector/Tianyan concern, not a client order device heartbeat.
    if (body.verified === false) {
      sellerCookieBindings.delete(key);
      await authStore.mutateTenantDocumentWithAudit(dataAccount, 'erp_shops_data', payload => {
        const latest = decryptShopCredentials(payload, CREDENTIALS_KEY, dataAccount.tenantId);
        const target = Array.isArray(latest) ? latest.find(shop => String(shop && shop.clientId || '') === clientId) : null;
        if (!target) throw Object.assign(new Error('未找到该店铺，请刷新店铺列表后重试。'), { publicCode: 'shop_not_found' });
        target.cookie = '未授权';
        delete target.sellerCookies;
        target.sellerCookieAuthorization = { status: 'unauthorized', updatedAt: new Date().toISOString() };
        return { payload: encryptShopCredentials(latest, CREDENTIALS_KEY, dataAccount.tenantId), value: { clientId, status: 'unauthorized' } };
      }, { action: 'shop.seller_cookie.revoke', resourceType: 'shop', resourceId: clientId, metadata: { status: 'unauthorized' } });
      return sendJson(res, 200, { ok: true, clientId, status: 'unauthorized' });
    }
    // The extension rechecks Seller every five minutes. Keep the server lease
    // only slightly longer so an expired Cookie cannot look authorized for 30m.
    const now = Date.now(), expiresAt = now + 8 * 60 * 1000;
    const verifiedAt = new Date(now).toISOString();
    await authStore.mutateTenantDocumentWithAudit(dataAccount, 'erp_shops_data', payload => {
      const latest = decryptShopCredentials(payload, CREDENTIALS_KEY, dataAccount.tenantId);
      const target = Array.isArray(latest) ? latest.find(shop => String(shop && shop.clientId || '') === clientId) : null;
      if (!target) throw Object.assign(new Error('未找到该店铺，请刷新店铺列表后重试。'), { publicCode: 'shop_not_found' });
      if (submittedCookies) target.sellerCookies = submittedCookies;
      if (!Array.isArray(target.sellerCookies) || !target.sellerCookies.length) throw Object.assign(new Error('请先在采集插件中完成 Ozon 卖家后台授权后再使用相关辅助功能。'), { publicCode: 'seller_cookies_required' });
      target.cookie = '已授权';
      target.sellerCookieAuthorization = { status: 'authorized', verifiedAt, updatedAt: verifiedAt, source: 'seller_cookie_verified' };
      return { payload: encryptShopCredentials(latest, CREDENTIALS_KEY, dataAccount.tenantId), value: { clientId, status: 'authorized' } };
    }, { action: 'shop.seller_cookie.authorize', resourceType: 'shop', resourceId: clientId, metadata: { status: 'authorized' } });
    sellerCookieBindings.set(key, { tenantId: String(dataAccount.tenantId), clientId, userId: String(dataAccount.userId), boundAt: new Date(now).toISOString(), expiresAt });
    return sendJson(res, 200, { ok: true, clientId, status: 'authorized', persistent: true, verifiedAt, expiresAt: new Date(expiresAt).toISOString() });
  }
  if (pathname === '/api/orders/sync' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再同步订单。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，订单同步未开始，请从当前页面重新操作。', csrf: '页面验证信息已失效，订单同步未开始，请刷新页面后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'sync.run') || !authStore.hasPermission(dataAccount, 'orders.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有订单同步权限，请联系主账号授权后再试。' });
    const body = await readJsonBody(req, res, 128 * 1024, { tooLarge: '订单同步请求超过128KB，本次未开始，请减少所选订单后重试。', invalid: '订单同步请求格式不正确，本次未开始，请刷新页面后重试。' });
    if (!body) return;
    const mode = body.mode === 'selected' ? 'selected' : 'all';
    const batchId = /^sync-[A-Za-z0-9-]{6,100}$/.test(String(body.batchId || '')) ? String(body.batchId) : '';
    if (body.batchId && !batchId) return sendJson(res, 400, { error: 'sync_batch_id_invalid', message: '订单同步任务编号格式不正确，本次未开始，请刷新页面后重试。' });
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, 100).map(item => ({ clientId: String(item && item.clientId || '').trim(), postingNumbers: [...new Set((Array.isArray(item && item.postingNumbers) ? item.postingNumbers : []).map(value => String(value).trim()).filter(Boolean))].slice(0, 1000) }));
    if (!items.length || items.some(item => !/^[A-Za-z0-9._:-]{1,120}$/.test(item.clientId) || (mode === 'selected' && !item.postingNumbers.length))) return sendJson(res, 400, { error: 'order_sync_input_invalid', message: '所选店铺或订单编号不完整，本次同步未开始，请重新选择后再试。' });
    try {
      let range;
      try {
        range = mode === 'all'
          ? clientOrderSync.manualRange({ rangeStart: body.rangeStart, rangeEnd: body.rangeEnd })
          : clientOrderSync.rangeFor('manual_all');
      } catch (error) {
        if (error.publicCode === 'order_sync_range_invalid') return sendJson(res, 400, { error: 'order_sync_range_invalid', message: '订单同步日期范围不正确，本次未开始，请检查起止时间后重试。' });
        throw error;
      }
      const windowCount = clientOrderSync.windowCountForRange(range.start, range.end);
      const allowed = await authStore.listAllowedShops(dataAccount);
      const visible = allowed === null ? await authStore.listShops(dataAccount) : allowed;
      if (items.some(item => !visible.some(shop => String(shop.externalShopId || '') === item.clientId))) return sendJson(res, 403, { error: 'shop_scope_denied', message: '当前账号没有所选店铺的订单同步权限，请重新选择有权限的店铺或联系主账号授权。' });
      const shopDocument = await authStore.getDocument(dataAccount, 'erp_shops_data');
      const storedShops = shopDocument ? decryptShopCredentials(shopDocument.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
      const shopByClientId = new Map((Array.isArray(storedShops) ? storedShops : []).map(shop => [String(shop && shop.clientId || ''), shop]));
      const skipped = items.map(item => shopByClientId.get(item.clientId)).filter(shopApiHealthIsAbnormal).map(shopApiSkipItem);
      const activeItems = items.filter(item => !shopApiHealthIsAbnormal(shopByClientId.get(item.clientId)));
      if (!activeItems.length) return sendJson(res, 202, { ok: true, items: [], skipped });
      const serverReady = new Set((Array.isArray(storedShops) ? storedShops : []).filter(shop => shop && shop.apiKey && !shopApiHealthIsAbnormal(shop)).map(shop => String(shop.clientId || '')));
      if (activeItems.some(item => !serverReady.has(item.clientId))) return sendJson(res, 409, { error: 'order_sync_api_credentials_required', message: '所选店铺缺少可用的Ozon官方API密钥，请先到店铺管理配置并测试连接。' });
      const queued = [];
      for (let index = 0; index < activeItems.length; index += 1) {
        const item = activeItems[index];
        const id = crypto.randomUUID();
        const persisted = await authStore.enqueueBackgroundJob(dataAccount, {
          id, type: 'orders_sync', dedupeKey: 'manual:' + item.clientId,
          context: { source: 'manual_server_fallback', clientId: item.clientId, mode, postingNumbers: item.postingNumbers, runId: 'server-order-' + crypto.randomUUID(), rangeEnd: range.end.toISOString(), since: range.start.toISOString(), windowCount },
          maxAttempts: 3,
          task: { name: '订单同步（服务器资源）', label: '正在同步订单', article: item.clientId, parentTaskId: batchId }
        });
        queued.push({ id: persisted.job.id, clientId: item.clientId, duplicate: persisted.duplicate, state: persisted.job.state, source: 'server' });
      }
      return sendJson(res, 202, { ok: true, items: queued, skipped });
    } catch (error) {
      console.error('订单后台同步入队失败:', error.message);
      const status = Number(error.status) || 500;
      return sendJson(res, status, { error: error.publicCode || 'order_sync_enqueue_failed', message: status === 400 ? '订单同步请求未通过校验，本次未开始，请检查所选订单后重试。' : status === 403 ? '当前账号没有执行订单同步的权限，本次未开始，请联系主账号授权。' : '订单同步任务入队失败，本次未开始，请稍后重试。' });
    }
  }
  if (pathname === '/api/orders/sync/cancel' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'orders.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const body = await readJsonBody(req, res, 4 * 1024);
    if (!body) return;
    const jobId = String(body.jobId || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return sendJson(res, 400, { error: 'client_sync_run_invalid', message: '本次同步运行记录不完整，请重新发起一次同步。' });
    try {
      let job = await authStore.cancelClientOrderSyncRun(dataAccount, jobId);
      if (!job) job = await authStore.cancelBackgroundJob(dataAccount, jobId, 'orders_sync');
      if (!job) return sendJson(res, 409, { error: 'background_job_not_cancellable', message: '该任务已进入不可取消阶段，请等待执行结果后再查看。' });
      const clientRun = Boolean(job.run_id);
      await authStore.upsertSyncTask(dataAccount, { id: clientRun ? 'client-order-' + job.run_id : job.id, type: 'sync', status: 'failed', value: 0, name: clientRun ? '订单同步（用户资源）' : '订单同步（服务器资源）', label: '订单同步已取消', reason: '任务在执行前由发起人取消', startedAt: clientRun ? job.created_at : job.createdAt }).catch(() => {});
      return sendJson(res, 200, { ok: true, job: { id: clientRun ? job.run_id : job.id, state: job.state, type: clientRun ? 'client_orders_sync' : 'orders_sync' } });
    } catch (error) {
      if (persistentQueueSchemaMissing(error)) return sendJson(res, 503, { error: 'background_queue_unavailable', message: '后台任务队列暂时不可用，请稍后重试。' });
      console.error('取消订单同步任务失败:', error.message);
      return sendJson(res, 500, { error: 'background_job_cancel_failed', message: '取消后台任务失败，服务端已记录原因，请稍后重试。' });
    }
  }
  if (pathname === '/api/category-attributes/sync' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (fs.existsSync(P2_FREEZE_MARKER) && !await authStore.getTenantCutoverRun(dataAccount)) return sendJson(res, 423, { error: 'migration_source_frozen', message: '迁移期间的旧数据只读冻结，不能写入，请等待迁移完成。' });
    if (!authStore.hasPermission(dataAccount, 'sync.run') && !authStore.hasPermission(dataAccount, 'selection.manage')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有同步选品类目数据的权限，请联系管理员授权。' });
    const body = await readJsonBody(req, res, 32 * 1024);
    if (!body) return;
    // A verified public reference is shared by all tenants. Do not enqueue
    // per-shop full downloads or write another 181 MB tenant JSONB document.
    try {
      const shared = await publicCategoryCatalog.summary();
      if (shared) return sendJson(res, 200, { job: {
        taskId: `public-ozon-category-${shared.version}`, status: 'done', value: 100,
        summary: shared.summary, failures: shared.failures,
        label: '系统公共类目已经就绪，无需每个店铺重复同步', updatedAt: new Date().toISOString()
      }, publicReference: true, alreadyRunning: false });
    } catch (error) {
      console.error('读取公共类目版本失败:', error.message);
      return sendJson(res, 503, { error: 'public_category_reference_invalid', message: '公共类目版本读取失败，旧数据没有被修改，请联系管理员恢复参考目录。' });
    }
    const clientId = String(body.clientId || '').trim();
    if (!clientId || clientId.length > 120) return sendJson(res, 400, { error: 'category_attribute_client_id_required', message: '请先填写本次提交的类目属性记录标识。' });
    const jobKey = String(dataAccount.tenantId);
    const current = categoryAttributeJobs.get(jobKey);
    if (current && current.status === 'running') return sendJson(res, 200, { job: current, alreadyRunning: true });
    try {
      const allowedShops = await authStore.listAllowedShops(dataAccount);
      if (allowedShops !== null && !allowedShops.some(item => String(item.externalShopId || '') === clientId)) return sendJson(res, 403, { error: 'shop_scope_denied', message: '该店铺不在你的授权范围内，请重新选择店铺。' });
      const shopDocument = await authStore.getDocument(dataAccount, 'erp_shops_data');
      const shops = shopDocument ? decryptShopCredentials(shopDocument.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
      const shop = Array.isArray(shops) ? shops.find(item => String(item && item.clientId || '') === clientId) : null;
      if (!shop || !shop.apiKey) return sendJson(res, 404, { error: 'shop_credentials_not_found', message: '该店铺尚未配置平台密钥，请先在店铺管理中添加密钥。' });
      const now = new Date().toISOString();
      const taskId = `sync-category-attributes-${Date.now().toString(36)}`;
      let persisted;
      try {
        persisted = await authStore.enqueueBackgroundJob(dataAccount, {
          id: taskId, type: 'category_attributes', dedupeKey: 'tenant-category-attributes',
          context: { clientId, force: body.force === true }, maxAttempts: 3
        });
      } catch (error) {
        if (!persistentQueueSchemaMissing(error)) throw error;
      }
      if (persisted && persisted.job) {
        const queuedJob = { taskId: persisted.job.id, status: 'running', startedAt: persisted.job.createdAt || now, updatedAt: now, summary: null, failures: [], queued: persisted.job.state === 'queued' };
        categoryAttributeJobs.set(jobKey, queuedJob);
        await authStore.upsertSyncTask(dataAccount, { id: queuedJob.taskId, type: 'sync', status: 'running', value: 1, name: '三级类目属性全量同步', label: queuedJob.queued ? '已进入服务器队列' : '正在恢复后台同步', startedAt: queuedJob.startedAt });
        return sendJson(res, persisted.duplicate ? 200 : 202, { job: queuedJob, alreadyRunning: persisted.duplicate });
      }
      const volatileJob = { taskId, status: 'running', startedAt: now, updatedAt: now, summary: null, failures: [], volatile: true };
      categoryAttributeJobs.set(jobKey, volatileJob);
      await authStore.upsertSyncTask(dataAccount, { id: taskId, type: 'sync', status: 'running', value: 1, name: '三级类目属性全量同步', label: '正在读取 OZON 三级类目树', startedAt: now });
      runCategoryAttributeJob(dataAccount, shop, { force: body.force === true }, volatileJob).catch(error => console.error('类目属性后台任务异常:', error.message));
      return sendJson(res, 202, { job: volatileJob });    } catch (error) {
      if (error.publicCode === 'background_job_queue_full') return sendJson(res, 503, { error: 'background_job_queue_full', message: '服务器任务队列已满，请稍后重试。' }, { 'Retry-After': '10' });
      console.error('启动类目属性同步失败:', error.message);
      return sendJson(res, 500, { error: 'category_attribute_sync_start_failed', message: '类目属性同步任务启动失败，请稍后重试或联系管理员。' });
    }
  }

  if (pathname === '/api/category-attributes/status' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read') && !authStore.hasPermission(dataAccount, 'selection.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看类目选品数据的权限，请联系管理员授权。' });
    try {
      const shared = await publicCategoryCatalog.summary();
      if (shared) return sendJson(res, 200, {
        summary: shared.summary, failures: shared.failures,
        job: categoryAttributeJobs.get(String(dataAccount.tenantId)) || null,
        publicReference: true, catalogVersion: shared.version
      });
      const document = await authStore.getDocument(dataAccount, CATEGORY_ATTRIBUTE_KEY);
      const library = normalizeCategoryAttributeLibrary(document && document.payload);
      const activeJob = categoryAttributeJobs.get(String(dataAccount.tenantId)) || null;
      return sendJson(res, 200, { summary: summarizeCategoryAttributeLibrary(library), failures: library.failures, job: activeJob });
    } catch (error) {
      console.error('读取类目属性同步状态失败:', error.message);
      return sendJson(res, 500, { error: 'category_attribute_status_failed', message: '类目属性状态更新失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/category-attributes/category' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read') && !authStore.hasPermission(dataAccount, 'selection.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看类目选品数据的权限，请联系管理员授权。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    const descriptionCategoryId = String(params.get('descriptionCategoryId') || '');
    const typeId = String(params.get('typeId') || '');
    if (!/^\d+$/.test(descriptionCategoryId) || !/^\d+$/.test(typeId)) return sendJson(res, 400, { error: 'category_attribute_ids_required', message: '请至少选择一个要处理的类目属性。' });
    const shared = await publicCategoryCatalog.category(descriptionCategoryId, typeId);
    if (shared) return shared.item
      ? sendJson(res, 200, { item: { ...shared.item, requiredAttributes: shared.item.required || [], optionalAttributes: shared.item.optional || [] }, libraryUpdatedAt: shared.updatedAt })
      : sendJson(res, 404, { error: 'category_attributes_not_found', message: '公共目录未找到这个商品类目或属性。' });
    const document = await authStore.getDocument(dataAccount, CATEGORY_ATTRIBUTE_KEY);
    const library = normalizeCategoryAttributeLibrary(document && document.payload);
    const item = library.categories[categoryAttributeKey(descriptionCategoryId, typeId)];
    return item ? sendJson(res, 200, { item: { ...item, requiredAttributes: item.required || [], optionalAttributes: item.optional || [] }, libraryUpdatedAt: library.updatedAt }) : sendJson(res, 404, { error: 'category_attributes_not_found', message: '未找到该商品的类目属性，请先完成一次类目属性同步。' });
  }

  if (pathname === '/api/category-attributes/catalog' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!authStore.hasPermission(dataAccount, 'products.read') && !authStore.hasPermission(dataAccount, 'selection.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看类目选品数据的权限，请联系管理员授权。' });
    const shared = await publicCategoryCatalog.catalog();
    if (shared) return sendJson(res, 200, shared);
    const document = await authStore.getDocument(dataAccount, CATEGORY_ATTRIBUTE_KEY);
    const library = normalizeCategoryAttributeLibrary(document && document.payload);
    const items = Object.values(library.categories).map(item => ({
      key: item.key, descriptionCategoryId: String(item.descriptionCategoryId || item.path && item.path[1] && item.path[1].id || ''),
      typeId: String(item.typeId || item.path && item.path[2] && item.path[2].id || ''), disabled: Boolean(item.disabled),
      path: Array.isArray(item.path) ? item.path.map(level => ({ id: String(level.id || ''), name: String(level.name || ''), level: Number(level.level || 0) })) : []
    }));
    return sendJson(res, 200, { items, libraryUpdatedAt: library.updatedAt });
  }

  if (pathname === '/api/system/tenants' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    return sendJson(res, 200, { items: await authStore.listSystemTenants(account) });
  }

  if (pathname === '/api/system/agents' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    try { return sendJson(res, 200, { items: await authStore.listSystemAgents(account) }); }
    catch (error) {
      console.error('读取代理商管理列表失败:', error.message);
      return sendJson(res, 500, { error: 'system_agents_read_failed', message: '代理商列表读取失败，请稍后刷新重试。' });
    }
  }

  const systemAgentOverviewMatch = pathname.match(/^\/api\/system\/agents\/(\d+)\/overview$/);
  if (systemAgentOverviewMatch && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    try {
      return sendJson(res, 200, { agent: await authStore.getSystemAgentOverview(account, systemAgentOverviewMatch[1]) });
    } catch (error) {
      if (error.publicCode === 'agent_not_found') return sendJson(res, 404, { error: error.publicCode, message: userErrorText(error, "未找到该客户的代理商记录，请先为它指派代理商资格。")});
      console.error('读取代理商精确价格失败:', error.message);
      return sendJson(res, 500, { error: 'system_agent_overview_failed', message: '代理商详情读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/system/membership-payments' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    const tenantId = String(params.get('tenantId') || '').trim();
    if (!/^\d+$/.test(tenantId)) return sendJson(res, 400, { error: 'invalid_tenant_id', message: '客户空间标识不正确，请刷新页面后重新选择空间。' });
    try { return sendJson(res, 200, { items: await authStore.listSystemMembershipPayments(account, tenantId) }); }
    catch (error) {
      console.error('读取已确认平台收款失败:', error.message);
      return sendJson(res, 500, { error: 'system_membership_payments_read_failed', message: '会员付款记录读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/system/membership-campaigns' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    try { return sendJson(res, 200, { items: await authStore.listSystemMembershipCampaigns(account) }, { 'Cache-Control': 'no-store' }); }
    catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'membership_campaign_list_failed', message: userErrorText(error, '会员活动列表读取失败，请稍后重试。') }); }
  }

  if (pathname === '/api/system/membership-campaigns' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res, 8 * 1024); if (!body) return;
    const calendarYear = Number(body.calendarYear);
    const campaignType = String(body.campaignType || '');
    const name = String(body.name || '').trim();
    const startsText = String(body.startsAtBeijing || '').trim();
    const endsText = String(body.endsAtBeijing || '').trim();
    if (!Number.isInteger(calendarYear) || calendarYear < 2020 || calendarYear > 2200) return sendJson(res, 400, { error: 'membership_campaign_year_invalid', message: '活动年份必须在2020到2200之间。' });
    if (!['spring_festival','labour_day','mid_autumn_national_day'].includes(campaignType)) return sendJson(res, 400, { error: 'membership_campaign_type_invalid', message: '请选择春节、劳动节或中秋国庆活动类型。' });
    if (!name || name.length > 160) return sendJson(res, 400, { error: 'membership_campaign_name_invalid', message: '活动名称需为1至160个字符。' });
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startsText) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endsText)) return sendJson(res, 400, { error: 'membership_campaign_time_invalid', message: '请填写完整的北京时间起止时间。' });
    if (Number(startsText.slice(0, 4)) !== calendarYear) return sendJson(res, 400, { error: 'membership_campaign_year_mismatch', message: '活动年份必须与北京时间开始时间的年份一致。' });
    const startsAt = new Date(startsText + ':00+08:00'), endsAt = new Date(endsText + ':00+08:00');
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt <= startsAt) return sendJson(res, 400, { error: 'membership_campaign_time_invalid', message: '活动结束时间必须晚于开始时间。' });
    try { return sendJson(res, 200, { item: await authStore.saveSystemMembershipCampaignDraft(account, { calendarYear, campaignType, name, startsAt, endsAt }) }); }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 409 : 500), { error: error.publicCode || 'membership_campaign_save_failed', message: userErrorText(error, '会员活动草稿保存失败，请稍后重试。') }); }
  }

  const membershipCampaignActionMatch = pathname.match(/^\/api\/system\/membership-campaigns\/(\d+)\/(publish|cancel)$/);
  if (membershipCampaignActionMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    try {
      const item = membershipCampaignActionMatch[2] === 'publish'
        ? await authStore.publishSystemMembershipCampaign(account, membershipCampaignActionMatch[1])
        : await authStore.cancelSystemMembershipCampaign(account, membershipCampaignActionMatch[1]);
      return sendJson(res, 200, { item });
    } catch (error) {
      const status = error.status || (error.publicCode === 'membership_campaign_not_found' ? 404 : error.publicCode ? 409 : 500);
      return sendJson(res, status, { error: error.publicCode || 'membership_campaign_action_failed', message: userErrorText(error, '会员活动操作失败，请刷新列表后重试。') });
    }
  }

  if (pathname === '/api/system/activation-codes' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    const targetTenantId = query.get('targetTenantId') || '';
    const benefitType = query.get('benefitType') || '';
    const status = query.get('status') || '';
    const planCode = query.get('planCode') || '';
    const beanAmountText = query.get('beanAmount') || '';
    const pageText = query.get('page') || '1';
    const pageSizeText = query.get('pageSize') || '10';
    const page = Number(pageText);
    if (targetTenantId && !/^\d+$/.test(targetTenantId)) return sendJson(res, 400, { error: 'invalid_tenant_id', message: '客户空间标识不正确，请刷新页面后重新选择空间。' });
    if (benefitType && !['membership', 'ai_beans'].includes(benefitType)) return sendJson(res, 400, { error: 'invalid_benefit_type', message: '权益类型只能是会员或AI豆' });
    if (status && !['issued', 'activated', 'expired', 'voided'].includes(status)) return sendJson(res, 400, { error: 'invalid_activation_code_status', message: '激活码状态无效' });
    if (planCode && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(planCode)) return sendJson(res, 400, { error: 'invalid_plan_code', message: '会员方案代码无效' });
    if (beanAmountText && !['1000', '2000', '5000', '10000', '50000'].includes(beanAmountText)) return sendJson(res, 400, { error: 'invalid_bean_amount', message: 'AI豆额度只能是1000、2000、5000、10000或50000' });
    if ((planCode && benefitType === 'ai_beans') || (beanAmountText && benefitType === 'membership') || (planCode && beanAmountText)) return sendJson(res, 400, { error: 'activation_code_filter_conflict', message: '会员方案和AI豆额度不能组合查询' });
    if (!/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1) return sendJson(res, 400, { error: 'invalid_page', message: '页码必须是正整数' });
    if (!['10', '20', '50', '100'].includes(pageSizeText)) return sendJson(res, 400, { error: 'invalid_page_size', message: '每页数量只能是10、20、50或100' });
    try {
      const payload = await authStore.listSystemActivationCodes(account, {
        targetTenantId, benefitType: benefitType || (planCode ? 'membership' : beanAmountText ? 'ai_beans' : ''),
        status, planCode, beanAmount: beanAmountText ? Number(beanAmountText) : null,
        page, pageSize: Number(pageSizeText)
      });
      return sendJson(res, 200, await revealActivationCodesForSystemAdmin(payload), { 'Cache-Control': 'no-store' });
    }
    catch (error) { return sendJson(res, error.publicCode === 'system_admin_required' ? 403 : 500, { error: error.publicCode || 'system_activation_codes_read_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }

  if (pathname === '/api/system/agent-activation-codes' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const status = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams.get('status') || '';
    if (status && !['unactivated', 'pending_payment', 'confirmed', 'expired', 'voided'].includes(status)) return sendJson(res, 400, { error: 'invalid_agent_activation_status', message: '请选择正确的代理商激活码状态（未使用、待确认付款、已确认、已作废等）。' });
    try { return sendJson(res, 200, await revealActivationCodesForSystemAdmin(await authStore.listSystemAgentActivationCodes(account, status)), { 'Cache-Control': 'no-store' }); }
    catch (error) { return sendJson(res, error.publicCode === 'system_admin_required' ? 403 : 500, { error: error.publicCode || 'system_agent_activation_codes_read_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }

  const agentActivationConfirmMatch = pathname.match(/^\/api\/system\/agent-activation-codes\/(\d+)\/confirm-payment$/);
  if (agentActivationConfirmMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res, 4 * 1024); if (!body) return;
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    const input = { idempotencyKey, requestId: String(req.headers['x-request-id'] || '').trim().slice(0, 128) || null,
      requestHash: crypto.createHash('sha256').update(`agent-activation-payment:${agentActivationConfirmMatch[1]}`).digest('hex') };
    try {
      const result = await authStore.confirmSystemAgentActivationPayment(account, agentActivationConfirmMatch[1], input);
      return sendJson(res, result.statusCode, result.response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      const status = error.publicCode === 'agent_activation_code_not_found' ? 404
        : ['agent_activation_payment_not_pending', 'idempotency_key_conflict', 'idempotency_request_in_progress'].includes(error.publicCode) ? 409 : 500;
      return sendJson(res, status, { error: error.publicCode || 'agent_activation_payment_confirm_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }

  const systemActivationVoidMatch = pathname.match(/^\/api\/system\/activation-codes\/(\d+)\/void$/);
  if (systemActivationVoidMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    const requestHash = crypto.createHash('sha256').update(`void:${systemActivationVoidMatch[1]}`).digest('hex');
    try {
      const result = await authStore.voidSystemActivationCode(account, systemActivationVoidMatch[1], { idempotencyKey, requestHash, requestId: String(req.headers['x-request-id'] || '').trim() });
      return sendJson(res, result.statusCode, result.response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      const status = ['activation_code_not_found'].includes(error.publicCode) ? 404 : ['activation_code_cannot_void','idempotency_key_conflict','idempotency_request_in_progress'].includes(error.publicCode) ? 409 : 500;
      return sendJson(res, status, { error: error.publicCode || 'system_activation_code_void_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }


  if (pathname === '/api/system/activation-codes' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res, 16 * 1024);
    if (!body) return;
    const mode = String(body.mode || '').trim();
    const targetTenantId = String(body.targetTenantId || '').trim();
    const planCode = String(body.planCode || '').trim();
    const reason = String(body.reason || '').trim();
    const benefitType = String(body.benefitType || 'membership').trim();
    const beanAmount = Number(body.beanAmount);
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    const requestId = String(req.headers['x-request-id'] || '').trim();
    const auditInput = { mode: mode || 'admin_direct', targetTenantId, benefitType, beanAmount, planCode, idempotencyKey, requestId };
    const rejectRequest = async (error, message) => {
      try { await authStore.recordSystemActivationFailure(account, auditInput, Object.assign(new Error(message), { publicCode: error, publicReason: message })); }
      catch (auditError) {
        console.error('管理员激活码参数失败审计写入失败:', auditError.message);
        return sendJson(res, 500, { error: 'audit_persistence_failed', message: '请求未执行，但失败审计保存失败，请联系管理员复核。' });
      }
      return sendJson(res, 400, { error, ...(message ? { message } : {}) });
    };
    if (mode === 'agent_delegated') return rejectRequest('agent_delegated_not_open', '前期暂未开放');
    if (!['membership', 'bean_recharge'].includes(benefitType)) return rejectRequest('activation_benefit_type_invalid', '请选择会员激活码或AI豆充值码');
    if (!/^\d+$/.test(targetTenantId)) return rejectRequest('invalid_tenant_id', '目标客户无效');
    let normalizedBeanAmount = 0;
    if (benefitType === 'bean_recharge') {
      if (![1000, 2000, 5000, 10000, 50000].includes(beanAmount)) return rejectRequest('bean_amount_invalid', 'AI豆仅支持1000、2000、5000、10000或50000豆');
      normalizedBeanAmount = beanAmount;
    } else if (!['month', 'quarter', 'year'].includes(planCode)) return rejectRequest('membership_plan_invalid', '请选择有效的会员方案');
    if (reason.length > 500) return rejectRequest('system_activation_reason_too_long', '申请理由最多500字。');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return rejectRequest('idempotency_key_required', '缺少有效的幂等请求标识');
    const generatedCode = createActivationCode();
    const fullCode = generatedCode.code;
    const codeDigest = generatedCode.digest;
    const codeMask = generatedCode.mask;
    let secretObjectKey = '';
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({
      targetTenantId, planCode, reason,
      benefitType, beanAmount: normalizedBeanAmount
    })).digest('hex');
    try {
      secretObjectKey = await storeActivationCodeSecret(targetTenantId, generatedCode);
      const shared = {
        planCode: benefitType === 'membership' ? planCode : '', benefitType, beanAmount: normalizedBeanAmount,
        mode: 'admin_direct', reason, idempotencyKey, requestHash, codeDigest, codeMask,
        requestId
      };
      const result = await authStore.requestSystemPlatformActivationCode(account, { ...shared, targetTenantId });
      if (result.replayed && secretObjectKey) await privateObjectStore.deleteEncryptedBuffer(secretObjectKey).catch(() => {});
      const response = result.replayed ? result.response : { ...result.response, code: fullCode, oneTimeCodeUnavailable: false };
      return sendJson(res, result.statusCode, response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      if (secretObjectKey) await privateObjectStore.deleteEncryptedBuffer(secretObjectKey).catch(() => {});
      const statusByCode = {
        audit_persistence_failed: 500,
        activation_codes_disabled: 403,
        tenant_owner_missing: 404, agent_owner_required: 409, membership_plan_unavailable: 409,
        bean_amount_invalid: 400,
        activation_code_secret_storage_unavailable: 503, activation_code_secret_integrity_failed: 500,
        idempotency_key_conflict: 409, idempotency_request_in_progress: 409
      };
      if (statusByCode[error.publicCode]) return sendJson(res, statusByCode[error.publicCode], {
        error: error.publicCode, message: userErrorText(error, '管理员激活码申请未通过校验，请核对客户空间、会员方案与保证金状态后重试。'), expectedAmountMinor: error.expectedAmountMinor,
        depositRequiredMinor: error.depositRequiredMinor, depositBalanceMinor: error.depositBalanceMinor, quota: error.quota
      });
      console.error('管理员生成激活码失败:', error.message);
      return sendJson(res, 500, { error: 'system_activation_code_request_failed', message: '管理员激活码申请失败，服务端已记录失败原因。' });
    }
  }

  // ── AI 豆：系统管理员人工充值/调账/查账户与流水（第一期不做在线支付） ──
  if (pathname === '/api/system/ai-beans/accounts' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '请重新登录后重试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '仅系统管理员可查看租户钱包列表。' });
    try { return sendJson(res, 200, await aiBeanStore.adminAccounts(), { 'Cache-Control': 'no-store' }); }
    catch (error) { return sendJson(res, 500, { error: 'ai_bean_accounts_read_failed', message: '租户钱包列表读取失败，请重试。' }); }
  }
  if (pathname === '/api/system/ai-beans/account' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    try { return sendJson(res, 200, await aiBeanStore.adminAccount(params.get('tenantId')), { 'Cache-Control': 'no-store' }); }
    catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'ai_bean_account_read_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }
  if (pathname === '/api/system/ai-beans/events' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    const tenantId = String(params.get('tenantId') || '').trim();
    if (!/^\d+$/.test(tenantId)) return sendJson(res, 400, { error: 'invalid_tenant_id', message: '客户空间标识不正确，请刷新页面后重新选择空间。' });
    try {
      const eventType = String(params.get('eventType') || '').trim();
      const result = await aiBeanStore.listEvents(tenantId, { limit: params.get('limit'), beforeId: params.get('beforeId'), eventType, hideSettledFreeze: true });
      return sendJson(res, 200, result, { 'Cache-Control': 'no-store' });
    } catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'ai_bean_events_read_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }
  if (pathname === '/api/system/ai-beans/recharge' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const retryAfter = consumeWindow(aiBeanAdminWindows, `${clientAddress(req)}|${account.userId}`, 15 * 60 * 1000, 120);
    if (retryAfter) return sendJson(res, 429, { error: 'ai_bean_admin_rate_limited', message: 'AI豆人工调整提交过于频繁，请稍后再试。' }, { 'Retry-After': String(retryAfter) });
    const body = await readJsonBody(req, res, 16 * 1024); if (!body) return;
    const targetTenantId = String(body.tenantId || '').trim();
    const amountBean = Number(body.amountBean);
    const reason = String(body.reason || '').trim();
    if (!/^\d+$/.test(targetTenantId)) return sendJson(res, 400, { error: 'invalid_tenant_id', message: '客户空间标识不正确，请刷新页面后重新选择空间。' });
    if (!Number.isSafeInteger(amountBean) || amountBean < 1 || amountBean > 100000000) return sendJson(res, 400, { error: 'invalid_ai_bean_amount', message: '请填写正确的AI豆数量（1至100000之间的整数）。' });
    if (reason.length < 5 || reason.length > 500) return sendJson(res, 400, { error: 'ai_bean_reason_required', message: '请填写5至500字的充值原因（如付款渠道、付款时间、客户信息）。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    try {
      await aiBeanStore.adminAccount(targetTenantId);
      const result = await aiBeanStore.credit(targetTenantId, {
        eventType: 'recharge', amount: amountBean, idempotencyKey: 'recharge:' + idempotencyKey,
        businessRef: 'admin-recharge:' + idempotencyKey, reason, actorUserId: account.userId
      });
      const wallet = await aiBeanStore.adminAccount(targetTenantId);
      if (!result.replayed) await authStore.recordAudit(account, 'ai_beans.recharge', 'ai_bean_account', targetTenantId, 'success', { amountBean, balanceAfter: wallet.balanceBean, reason }).catch(() => {});
      return sendJson(res, 200, { replayed: result.replayed, event: result.event, wallet }, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      const status = error.status || (error.publicCode === 'tenant_not_found' ? 404 : 500);
      if (status >= 500) console.error('管理员AI豆充值失败:', error.message);
      return sendJson(res, status, { error: error.publicCode || 'ai_bean_recharge_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }
  if (pathname === '/api/system/ai-beans/adjust' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const retryAfter = consumeWindow(aiBeanAdminWindows, `${clientAddress(req)}|${account.userId}`, 15 * 60 * 1000, 120);
    if (retryAfter) return sendJson(res, 429, { error: 'ai_bean_admin_rate_limited', message: 'AI豆人工调整提交过于频繁，请稍后再试。' }, { 'Retry-After': String(retryAfter) });
    const body = await readJsonBody(req, res, 16 * 1024); if (!body) return;
    const targetTenantId = String(body.tenantId || '').trim();
    const deltaBean = Number(body.deltaBean);
    const reason = String(body.reason || '').trim();
    if (!/^\d+$/.test(targetTenantId)) return sendJson(res, 400, { error: 'invalid_tenant_id', message: '客户空间标识不正确，请刷新页面后重新选择空间。' });
    if (!Number.isSafeInteger(deltaBean) || deltaBean === 0 || Math.abs(deltaBean) > 100000000) return sendJson(res, 400, { error: 'invalid_ai_bean_delta', message: '请填写不等于0的AI豆调整数量，并说明调整原因。' });
    if (reason.length < 5 || reason.length > 500) return sendJson(res, 400, { error: 'ai_bean_reason_required', message: '请填写5至500字的调账原因。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    try {
      await aiBeanStore.adminAccount(targetTenantId);
      const result = await aiBeanStore.adminAdjust(targetTenantId, {
        deltaBean, idempotencyKey: 'adjust:' + idempotencyKey,
        businessRef: 'admin-adjust:' + idempotencyKey, reason, actorUserId: account.userId
      });
      const wallet = await aiBeanStore.adminAccount(targetTenantId);
      if (!result.replayed) await authStore.recordAudit(account, 'ai_beans.adjust', 'ai_bean_account', targetTenantId, 'success', { deltaBean, balanceAfter: wallet.balanceBean, reason }).catch(() => {});
      return sendJson(res, 200, { replayed: result.replayed, event: result.event, wallet }, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      const status = error.status || (error.publicCode === 'tenant_not_found' ? 404 : 500);
      if (status >= 500) console.error('管理员AI豆调账失败:', error.message);
      return sendJson(res, status, { error: error.publicCode || 'ai_bean_adjust_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")});
    }
  }

  if (pathname === '/api/system/payment-evidence' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    try { return sendJson(res, 200, { items: await authStore.listPaymentEvidenceForAdmin(account, params.get('limit')) }); }
    catch (error) {
      console.error('读取付款材料审核列表失败:', error.message);
      return sendJson(res, 500, { error: 'payment_evidence_list_failed', message: '付款凭证列表读取失败，请稍后刷新重试。' });
    }
  }

  const paymentEvidenceReviewMatch = pathname.match(/^\/api\/system\/payment-evidence\/(\d+)\/review$/);
  if (paymentEvidenceReviewMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const retryAfter = consumeWindow(paymentReviewWindows, `${clientAddress(req)}|${account.userId}`, 15 * 60 * 1000, 10);
    if (retryAfter) return sendJson(res, 429, { error: 'payment_review_rate_limited', message: '审核重新认证尝试过多，请稍后再试。' }, { 'Retry-After': String(retryAfter) });
    const body = await readJsonBody(req, res, 16 * 1024);
    if (!body) return;
    const action = String(body.action || '').trim();
    const password = String(body.password || '');
    const reason = String(body.reason || '').trim();
    if (!['confirm', 'reject'].includes(action)) return sendJson(res, 400, { error: 'payment_review_action_invalid', message: '请选择正确的审核结论（通过或退回）。' });
    if (!password || password.length > 128) return sendJson(res, 400, { error: 'payment_review_password_required', message: '请填写当前登录密码以确认身份后再提交审核。' });
    if (reason.length < 5 || reason.length > 500) return sendJson(res, 400, { error: 'payment_review_reason_required', message: '请填写5至500字的审核理由。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    const input = { evidenceId: paymentEvidenceReviewMatch[1], action, password, reason, idempotencyKey };
    if (action === 'confirm') {
      input.transactionId = String(body.transactionId || '').trim();
      input.currency = String(body.currency || '').trim().toUpperCase();
      input.payer = String(body.payer || '').trim();
      input.payee = String(body.payee || '').trim();
      input.amountMinor = Number(body.amountMinor);
      const paidAt = new Date(body.paidAt);
      if (input.transactionId.length < 6 || input.transactionId.length > 160) return sendJson(res, 400, { error: 'payment_transaction_id_required', message: '请填写银行或支付平台的交易号后再提交。' });
      if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) return sendJson(res, 400, { error: 'payment_amount_invalid', message: '请填写正确的付款金额（大于0，单位为元）。' });
      if (input.currency !== 'CNY') return sendJson(res, 400, { error: 'payment_currency_invalid', message: '请填写正确的币种（如人民币 CNY 或卢布 RUB）。' });
      if (input.payer.length < 2 || input.payer.length > 160 || input.payee.length < 2 || input.payee.length > 160) return sendJson(res, 400, { error: 'payment_parties_required', message: '请填写付款方与收款方名称后再提交。' });
      if (!Number.isFinite(paidAt.getTime()) || paidAt.getTime() > Date.now() + 5 * 60 * 1000) return sendJson(res, 400, { error: 'payment_time_invalid', message: '付款时间格式不正确，请按实际到账时间重新填写。' });
      input.paidAt = paidAt.toISOString();
    }
    input.requestHash = crypto.createHash('sha256').update(JSON.stringify({
      evidenceId: input.evidenceId, action, reason, transactionId: input.transactionId || '',
      amountMinor: input.amountMinor || 0, currency: input.currency || '', payer: input.payer || '',
      payee: input.payee || '', paidAt: input.paidAt || ''
    })).digest('hex');
    try {
      const result = await authStore.reviewPaymentEvidence(account, input);
      return sendJson(res, result.statusCode, result.response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      if (error.publicCode === 'reauthentication_failed') return sendJson(res, 403, { error: error.publicCode, message: '密码校验未通过，请输入当前登录密码后再审核。' });
      if (error.publicCode === 'payment_evidence_not_found') return sendJson(res, 404, { error: error.publicCode, message: '未找到这张付款材料，请刷新审核列表后重试。' });
      if (error.publicCode === 'payment_evidence_already_reviewed') return sendJson(res, 409, { error: error.publicCode, message: '这张付款材料已审核，请刷新审核记录查看结果。' });
      if (error.publicCode === 'payment_evidence_must_be_viewed') return sendJson(res, 409, { error: error.publicCode, message: '请先打开并查看这张付款原图，再提交审核结论。' });
      if (error.publicCode === 'partner_purchase_refund_required') return sendJson(res, 409, { error: error.publicCode, message: '该客户已有永久合作商权益，请先人工核对退款，暂不能确认本次会员付款。' });
      if (error.publicCode === 'payment_amount_mismatch') return sendJson(res, 409, { error: error.publicCode, expectedAmountMinor: error.expectedAmountMinor, message: '付款金额与该激活码锁定的应付金额不一致，请核对原始凭证。' });
      if (error.publicCode === 'payment_transaction_duplicate') return sendJson(res, 409, { error: error.publicCode, message: '这笔付款交易已用于另一张凭证，请核对交易编号。' });
      if (error.publicCode === 'membership_campaign_overlap') return sendJson(res, 409, { error: error.publicCode, message: '会员赠送活动时间重叠，请联系系统管理员核对活动配置。' });
      if (error.publicCode === 'membership_campaign_bonus_invalid') return sendJson(res, 409, { error: error.publicCode, message: '会员赠送活动天数配置无效，请联系系统管理员核对。' });
      if (error.publicCode === 'idempotency_key_conflict') return sendJson(res, 409, { error: error.publicCode, message: '该请求编号已用于其他审核，请刷新页面后重新提交。' });
      if (error.publicCode === 'idempotency_request_in_progress') return sendJson(res, 409, { error: error.publicCode, message: '相同审核正在处理中，请稍后刷新审核记录。' });
      console.error('审核付款材料失败:', error.message);
      return sendJson(res, 500, { error: 'payment_evidence_review_failed', message: '付款材料审核结果暂无法确认，请到审核记录核对后再操作。' });
    }
  }

  if (pathname === '/api/system/agents/assign' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res, 16 * 1024);
    if (!body) return;
    const tenantId = String(body.tenantId || '').trim();
    const reason = String(body.reason || '').trim();
    const depositMode = String(body.depositMode || '').trim();
    if (!/^\d+$/.test(tenantId)) return sendJson(res, 400, { error: 'invalid_tenant_id', message: '客户空间标识不正确，请刷新页面后重新选择空间。' });
    if (reason.length < 5 || reason.length > 500) return sendJson(res, 400, { error: 'agent_assignment_reason_required', message: '请填写5至500字的指派理由' });
    if (!['waived', 'required'].includes(depositMode)) return sendJson(res, 400, { error: 'agent_deposit_mode_invalid', message: '请选择保证金模式' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    const requestHash = crypto.createHash('sha256').update(tenantId).update('\0').update(depositMode).update('\0').update(reason).digest('hex');
    try {
      const result = await authStore.assignAgent(account, { tenantId, reason, depositMode, idempotencyKey, requestHash });
      return sendJson(res, result.statusCode, result.response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      if (error.publicCode) return sendJson(res, Number(error.status) || 409, { error: error.publicCode, message: userErrorText(error, '代理商指派未通过校验，请核对客户空间与保证金方式后重试。') });
      if (error.publicCode === 'idempotency_request_in_progress') return sendJson(res, 409, { error: error.publicCode, message: userErrorText(error, "相同操作正在处理中，请稍候片刻再查看结果。")}, { 'Retry-After': '2' });
      console.error('指派代理商失败:', error.message);
      return sendJson(res, 500, { error: 'system_agent_assign_failed', message: '代理商指派保存失败，服务端已记录原因，请稍后重试或联系管理员。' });
    }
  }

  const agentFinancialReviewMatch = pathname.match(/^\/api\/system\/agents\/(\d+)\/financial-review$/);
  if (agentFinancialReviewMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const retryAfter = consumeWindow(financialReviewWindows, `${clientAddress(req)}|${account.userId}`, 15 * 60 * 1000, 10);
    if (retryAfter) return sendJson(res, 429, { error: 'financial_review_rate_limited', message: '资金审核重新认证尝试过多，请稍后再试。' }, { 'Retry-After': String(retryAfter) });
    const body = await readJsonBody(req, res, 16 * 1024);
    if (!body) return;
    const action = String(body.action || '').trim();
    const password = String(body.password || '');
    const reason = String(body.reason || '').trim();
    const referenceId = String(body.referenceId || '').trim();
    const batchId = String(body.batchId || '').trim();
    const amountMinor = Number(body.amountMinor || 0);
    if (!['confirm_deposit', 'confirm_default', 'refund_deposit'].includes(action)) return sendJson(res, 400, { error: 'agent_financial_action_invalid', message: '请选择正确的资金审核动作（保证金到账确认、欠款确认或保证金退还）。' });
    if (!password || password.length > 128) return sendJson(res, 400, { error: 'payment_review_password_required', message: '请填写当前登录密码以确认身份后再提交审核。' });
    if (reason.length < 5 || reason.length > 500) return sendJson(res, 400, { error: 'payment_review_reason_required', message: '请填写5至500字的审核理由。' });
    if (action === 'confirm_default' && !/^default-\d+-\d+$/.test(batchId)) return sendJson(res, 400, { error: 'agent_default_batch_required', message: '确认欠款时必须选择对应的欠款批次，请先在列表中选定批次。' });
    if (action !== 'confirm_default' && (referenceId.length < 6 || referenceId.length > 160)) return sendJson(res, 400, { error: 'financial_reference_required', message: '请填写这笔资金对应的凭证编号后再提交。' });
    if (action !== 'confirm_default' && (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)) return sendJson(res, 400, { error: 'payment_amount_invalid', message: '请填写正确的付款金额（大于0，单位为元）。' });
    const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) return sendJson(res, 400, { error: 'idempotency_key_required', message: '缺少请求编号，请刷新页面后重新提交。' });
    const input = {
      tenantId: agentFinancialReviewMatch[1], action, password, reason, referenceId, batchId, amountMinor, idempotencyKey,
      requestHash: crypto.createHash('sha256').update(JSON.stringify({
        tenantId: agentFinancialReviewMatch[1], action, reason, referenceId, batchId, amountMinor
      })).digest('hex')
    };
    try {
      const result = await authStore.reviewAgentFinancialAction(account, input);
      return sendJson(res, result.statusCode, result.response, result.replayed ? { 'Idempotency-Replayed': 'true' } : undefined);
    } catch (error) {
      const statusByCode = {
        reauthentication_failed: 403, agent_not_found: 404, membership_charging_disabled: 409,
        automatic_agent_penalties_disabled: 409, agent_deposit_not_required: 409, agent_deposit_already_funded: 409,
        agent_deposit_amount_mismatch: 409, financial_reference_duplicate: 409, agent_default_batch_not_found: 404,
        agent_default_already_confirmed: 409, agent_deposit_refund_wait: 409, agent_deposit_refund_blocked: 409,
        idempotency_key_conflict: 409, idempotency_request_in_progress: 409
      };
      if (statusByCode[error.publicCode]) return sendJson(res, statusByCode[error.publicCode], {
        error: error.publicCode, message: userErrorText(error, '代理商信用或保证金审核未通过校验，请核对操作类型、金额与流水号后重试。'), expectedAmountMinor: error.expectedAmountMinor
      });
      console.error('审核代理商信用或保证金失败:', error.message);
      return sendJson(res, 500, { error: 'agent_financial_review_failed', message: '代理商资金审核处理失败，服务端已记录原因，请稍后重试或联系管理员。' });
    }
  }

  if (pathname === '/api/system/api-monitor' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    return sendJson(res, 200, { ...apiMonitor.getState(), email: { configured: bugMailer.configured, recipient: bugMailer.recipient } });
  }

  if (pathname === '/api/system/api-monitor/check' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    apiMonitor.runDaily(true).catch(error => console.error('接口监控手动检测失败:', error.message));
    return sendJson(res, 202, { ok: true, monitor: apiMonitor.getState() });
  }

  if (pathname === '/api/system/queue-metrics' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const persistentDatabase = await authStore.getBackgroundJobMetrics();
    return sendJson(res, 200, {
      capturedAt: new Date().toISOString(),
      seerfar: seerfarMarketCache.getState(),
      ozon: ozonShopScheduler.state(),
      bugEmail: bugEmailQueue.state(),
      persistentBackground: persistentBackgroundWorker ? persistentBackgroundWorker.state() : { enabled: false },
      runtimePool: runtimePoolMetrics(),
      eventLoopP99Ms: recentEventLoopP99Ms,
      persistentDatabase,
      shopSyncFallback: shopSyncFallbackQueue.state(),
      logisticsParse: logisticsParseQueue.state(),
      overview: { running: overviewSyncTask.isRunning() }
    }, { 'Cache-Control': 'no-store' });
  }

  if (pathname === '/api/system/contracts' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const catalog = loadJson(CONTRACT_CATALOG_FILE, { defaultAgentVersion: 'no_deposit', documents: [] });
    const settings = loadJson(CONTRACT_SETTINGS_FILE, {});
    const activeAgentVersion = ['no_deposit', 'deposit'].includes(settings.agentVersion) ? settings.agentVersion : (catalog.defaultAgentVersion || 'no_deposit');
    return sendJson(res, 200, { documents: Array.isArray(catalog.documents) ? catalog.documents : [], activeAgentVersion });
  }

  if (pathname === '/api/system/contracts/agent-version' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res, 16 * 1024);
    if (!body) return;
    const version = String(body.version || '');
    if (!['no_deposit', 'deposit'].includes(version)) return sendJson(res, 400, { error: 'contract_version_invalid', message: '请选择正确的合同版本（免保证金版或保证金版）。' });
    try {
      saveJson(CONTRACT_SETTINGS_FILE, { agentVersion: version, updatedAt: new Date().toISOString(), updatedBy: account.username || String(account.userId) });
      await authStore.recordAudit(account, 'contract.agent.version.update', 'contract_terms', 'agent', 'success', { version });
      return sendJson(res, 200, { activeAgentVersion: version });
    } catch (error) {
      console.error('保存代理商合同版本失败:', error.message);
      return sendJson(res, 500, { error: 'contract_version_save_failed', message: '合同版本保存失败，请稍后重试；仍未成功请联系管理员。' });
    }
  }

  const contractFileMatch = pathname.match(/^\/api\/system\/contracts\/([a-z-]+)\/file$/);
  if (contractFileMatch && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    const fileName = CONTRACT_FILES.get(contractFileMatch[1]);
    if (!fileName) return sendJson(res, 404, { error: 'contract_not_found', message: '未找到该合同，请从合同列表重新进入。' });
    const file = path.join(BASE, 'contracts', fileName);
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, Object.assign(securityHeaders(), {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'no-store',
        'Content-Length': data.length
      }));
      return res.end(data);
    } catch (error) {
      return sendJson(res, 404, { error: 'contract_file_missing', message: '该合同文件尚未上传，请联系管理员补齐后再查看。' });
    }
  }

  if (pathname === '/api/system/user-monitor' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    return sendJson(res, 200, { items: await userSecurityMonitor.list(), rules: {
      normalPerMinute: 120, anomalyPerMinute: 180, anomalyPerTenSeconds: 50,
      identityWindowMinutes: 30, maxRisks: 10, autoUnfreezeHours: 24
    } });
  }

  const userMonitorActionMatch = pathname.match(/^\/api\/system\/user-monitor\/(\d+)\/action$/);
  if (userMonitorActionMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const body = await readJsonBody(req, res);
    if (!body) return;
    const action = String(body.action || '');
    if (!['freeze', 'unfreeze', 'ban', 'unban', 'set_email'].includes(action)) return sendJson(res, 400, { error: 'invalid_action', message: '请选择正确的操作后再提交。' });
    try { return sendJson(res, 200, await userSecurityMonitor.adminAction(account, userMonitorActionMatch[1], action, body)); }
    catch (error) { return sendJson(res, error.publicCode === 'user_not_found' ? 404 : 400, { error: error.publicCode || 'user_security_action_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }

  if (pathname === '/api/system/order-manual-data/export' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员。' });
    const dataAccount = tenantScopedReadAccount(req, res, account); if (!dataAccount) return;
    try {
      const orders = await authStore.exportOrderManualData(dataAccount);
      const body = await orderManualExcel.buildWorkbook({ tenantId: dataAccount.tenantId, orders });
      res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('订单手动数据.xlsx')}`, 'Cache-Control': 'no-store', 'Content-Length': body.length });
      return res.end(body);
    } catch (error) { console.error('导出订单手动数据失败:', error.message); return sendJson(res, 500, { error: 'order_manual_data_export_failed', message: '订单手动数据导出失败，请稍后重试。' }); }
  }
  if (pathname === '/api/system/order-manual-data/import' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员。' });
    if (!requireCsrf(req, res, { origin: '请求来源不正确，请刷新页面后重试。', csrf: '登录状态已过期，请刷新页面后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account); if (!dataAccount) return;
    let body;
    try { body = await readBody(req, ORDER_MANUAL_XLSX_MAX_BYTES); }
    catch (error) { return sendJson(res, 413, { error: 'order_manual_xlsx_too_large', message: 'Excel 文件不能超过 8MB。' }); }
    try { return sendJson(res, 200, await authStore.importOrderManualData(dataAccount, await orderManualExcel.parseWorkbook(body, { tenantId: dataAccount.tenantId }), SUPPLIER_HOST_ALLOWLIST)); }
    catch (error) { return sendJson(res, /^manual_excel_|supplier_url_/.test(error.publicCode || '') ? 422 : 500, { error: error.publicCode || 'order_manual_data_import_failed', message: error.publicCode ? error.message : '订单手动数据导入失败，请稍后重试。' }); }
  }
  if (pathname === '/api/system/order-manual-data/restore' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员。' });
    if (!requireCsrf(req, res, { origin: '请求来源不正确，请刷新页面后重试。', csrf: '登录状态已过期，请刷新页面后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account); if (!dataAccount) return;
    try { return sendJson(res, 200, await authStore.restoreOrderManualData(dataAccount)); }
    catch (error) { return sendJson(res, error.publicCode === 'manual_excel_backup_missing' ? 404 : 500, { error: error.publicCode || 'order_manual_data_restore_failed', message: error.publicCode ? error.message : '订单手动数据恢复失败，请稍后重试。' }); }
  }
  if (pathname === '/api/system/clear-page-data' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效，页面数据未清除，请重新登录后再操作。' });
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '只有系统管理员可以清除页面同步数据，当前数据未改变。' });
    if (!requireCsrf(req, res, { origin: '请求来源不符合当前ERP地址，页面数据未清除，请从当前页面重新操作。', csrf: '页面验证信息已失效，页面数据未清除，请刷新页面后重试。' })) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res, undefined, { tooLarge: '清除请求内容过大，页面数据未改变，请刷新页面后重试。', invalid: '清除请求格式不正确，页面数据未改变，请刷新页面后重试。' });
    if (!body) return;
    const page = String(body.page || '');
    try {
      return sendJson(res, 200, await authStore.clearBusinessPageTransaction(dataAccount, page));
    } catch (error) {
      if (error.publicCode === 'unsupported_page') return sendJson(res, 400, { error: error.publicCode, message: '不支持清除该页面的数据，现有数据未改变。' });
      console.error('系统管理员清除页面同步数据失败:', page, error.message);
      return sendJson(res, 500, { error: 'page_data_clear_failed', message: '页面数据清除失败，无法确认是否已生效，请刷新页面核对后再操作。' });
    }
  }

  if (pathname === '/api/pricing-settings' && ['GET', 'PATCH'].includes(req.method)) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    try {
      const document = await authStore.getDocument(dataAccount, PRICING_SETTINGS_KEY);
      if (req.method === 'GET') return sendJson(res, 200, { settings: normalizeStoredPricingSettings(document && document.payload), canManage: canManageSettings(account), version: document ? document.version : 0, updatedAt: document ? document.updatedAt : null });
      if (!canManageSettings(account)) return sendJson(res, 403, { error: 'settings_owner_required', message: '只有租户主账号或系统管理员可以修改定价设置。' });
      if (!requireCsrf(req, res)) return;
      const body = await readJsonBody(req, res, 32 * 1024);
      if (!body) return;
      const settings = validatePricingSettingsInput(body);
      const expectedVersion = Number(body.expectedVersion);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return sendJson(res, 400, { error: 'pricing_settings_version_invalid', message: '定价设置版本不正确，请刷新页面后重新保存。' });
      const saved = await authStore.putDocument(dataAccount, PRICING_SETTINGS_KEY, settings, expectedVersion);
      await authStore.recordAudit(dataAccount, 'pricing.settings.update', 'tenant_setting', PRICING_SETTINGS_KEY, 'success', { version: saved.version, targetMarginPct: settings.targetMarginPct, defaultCommissionPct: settings.defaultCommissionPct, damageLossPct: settings.damageLossPct, advertisingPct: settings.advertisingPct, market: settings.market, logisticsScheme: settings.logisticsScheme || 'follow_default', roundingRule: settings.roundingRule });
      return sendJson(res, 200, { settings, canManage: true, version: saved.version, updatedAt: saved.updatedAt });
    } catch (error) {
      if (error.publicCode === 'pricing_settings_invalid') return sendJson(res, error.status || 400, { error: error.publicCode, message: error.message, field: error.field || '' });
      if (error.publicCode === 'document_version_conflict') return sendJson(res, 409, { error: 'pricing_settings_version_conflict', message: '定价设置已被其他操作更新，请刷新后重新修改。' });
      console.error('定价设置读写失败:', error.message);
      return sendJson(res, 500, { error: 'pricing_settings_failed', message: '定价设置处理失败，请稍后重试。' });
    }
  }
  if (pathname === '/api/logistics-configs' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    try {
      const customizationAllowed = (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
      const [sources, preferenceDocument, profileDocument] = await Promise.all([
        loadLogisticsSources(account, dataAccount, customizationAllowed),
        customizationAllowed ? authStore.getDocument(dataAccount, logisticsPreferenceKey(account)) : Promise.resolve(null),
        customizationAllowed && !account.isSystemAdmin ? authStore.getDocument(dataAccount, LOGISTICS_PLAN_PROFILES_KEY) : Promise.resolve(null)
      ]);
      const effectiveItems = sources.effectiveItems;
      const localItems = sources.localItems;
      const preferencePayload = customizationAllowed && preferenceDocument ? preferenceDocument.payload : null;
      const reconciled = reconcileLogisticsPreferences(sources.activeItems, preferencePayload);
      let planProfiles = normalizeLogisticsPlanProfiles(customizationAllowed && profileDocument ? profileDocument.payload : null);
      let members = [];
      if (customizationAllowed && !account.isSystemAdmin && account.memberType === 'owner') {
        members = (await authStore.listMembers(dataAccount)).map(member => ({ userId: member.userId, username: member.username, displayName: member.displayName, memberType: member.memberType, status: member.status }));
        if (!profileDocument) planProfiles[0] = { ...planProfiles[0], userIds: [String(account.userId)], defaultScheme: reconciled.value.defaultScheme, defaults: reconciled.value.defaults };
      } else {
        const assigned = planProfiles.find(profile => profile.userIds.includes(String(account.userId)));
        planProfiles = [{ ...(assigned || { id: 'personal', name: '我的方案', userIds: [String(account.userId)] }), userIds: [String(account.userId)], defaultScheme: reconciled.value.defaultScheme, defaults: reconciled.value.defaults }];
      }
      return sendJson(res, 200, {
        items: effectiveItems.map(item => publicLogisticsItem(item, account)),
        localItems: localItems.map(item => publicLogisticsItem(item, account)),
        preferences: reconciled.value.defaults,
        defaultScheme: reconciled.value.defaultScheme,
        preferenceNeedsSave: customizationAllowed && reconciled.changed,
        customizationAllowed,
        canManage: customizationAllowed && canManageSettings(account),
        canManageOfficial: account.isSystemAdmin === true,
        canApplyToMembers: customizationAllowed && !account.isSystemAdmin && account.memberType === 'owner',
        canManagePlanProfiles: customizationAllowed && !account.isSystemAdmin && account.memberType === 'owner',
        planProfiles,
        members
      });
    } catch (error) {
      console.error('读取物流配置失败:', error.message);
      return sendJson(res, 500, { error: 'logistics_config_read_failed', message: '物流配置读取失败，请稍后刷新重试。' });
    }
  }

  if (pathname === '/api/logistics-configs' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    // Verify the tenant's CURRENT membership on every request, before reading,
    // parsing, storing or promoting a user-supplied workbook.
    try { await authStore.requireLogisticsCustomizationEntitlement(account); }
    catch (error) {
      return sendJson(res, error.status || 403, {
        error: error.publicCode || 'membership_logistics_config_required',
        message: userErrorText(error, '免费用户可以使用官方物流模板；配置自己的物流模板需要付费会员。')
      });
    }
    const customizationAllowed = true;
    const requestedAccount = tenantScopedReadAccount(req, res, account);
    if (!requestedAccount) return;
    let dataAccount;
    try { dataAccount = account.isSystemAdmin ? await authStore.systemAdminHomeAccount() : requestedAccount; }
    catch (error) { return sendJson(res, 500, { error: error.publicCode || 'system_admin_home_invalid', message: userErrorText(error, '系统管理员官方配置空间不可用，请检查唯一admin账号。') }); }
    const cutoverRunId = await authStore.getTenantCutoverRun(dataAccount);
    if (fs.existsSync(P2_FREEZE_MARKER) && !cutoverRunId) return sendJson(res, 423, { error: 'migration_source_frozen', message: '迁移期间的旧数据只读冻结，不能写入，请等待迁移完成。' });
    const requestUrl = new URL(req.url, 'http://' + HOST + ':' + PORT);
    const originalName = String(requestUrl.searchParams.get('name') || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
    const clientModifiedAt = Number(requestUrl.searchParams.get('modifiedAt') || 0);
    if (!/\.xlsx$/i.test(originalName)) return sendJson(res, 415, { error: 'logistics_xlsx_only', message: '只支持上传 Excel（.xlsx）格式的物流原表，请转换格式后再上传。' });
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > LOGISTICS_TARIFF_MAX_BYTES) return sendJson(res, 413, { error: 'logistics_xlsx_too_large', message: '物流原表文件过大，请拆分或精简后重新上传。' });
    let body;
    try { body = await readBody(req, LOGISTICS_TARIFF_MAX_BYTES); }
    catch (error) { return sendJson(res, error.publicCode === 'body_too_large' ? 413 : 400, { error: error.publicCode || 'logistics_upload_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
    let parsed;
    try {
      const parseKey = crypto.createHash('sha256').update(body).digest('hex');
      parsed = await logisticsParseQueue.run(parseKey, () => parseLogisticsWorkbookInWorker(body, originalName)).promise;
    }
    catch (error) {
      if (error.publicCode === 'task_queue_full') return sendJson(res, 503, { error: 'logistics_parse_queue_full', message: '物流资费表解析队列已满，请稍后重试。' }, { 'Retry-After': '10' });
      console.error('解析物流资费表失败:', error.publicCode || 'logistics_parse_failed');
      return sendJson(res, 422, { error: error.publicCode || 'logistics_parse_failed', message: '物流资费表未通过解析，请检查文件格式、工作表及渠道规则后重新上传。' });
    }
    const id = crypto.randomUUID();
    const tenantFolder = path.join(LOGISTICS_TARIFF_DIR, String(dataAccount.tenantId));
    const storedRelativePath = path.join('users', String(account.userId), id + '.xlsx');
    const target = path.join(tenantFolder, storedRelativePath);
    if (customizationAllowed && !cutoverRunId) fs.mkdirSync(path.dirname(target), { recursive: true });
    const now = new Date().toISOString();
    const modifiedDate = Number.isFinite(clientModifiedAt) && clientModifiedAt > 0 ? new Date(clientModifiedAt) : null;
    const trustedSourceUpdatedAt = parsed.sourceUpdatedAt || null;
    const sourceUpdatedAt = trustedSourceUpdatedAt || (modifiedDate && !Number.isNaN(modifiedDate.getTime()) ? modifiedDate.toISOString() : now);
    const item = {
      id, provider: parsed.provider, version: parsed.version, sheetName: parsed.sheetName,
      originalName, ...(customizationAllowed ? { storedRelativePath } : {}), size: body.length, sha256: crypto.createHash('sha256').update(body).digest('hex'), schemes: parsed.schemes, markets: parsed.markets, sheets: parsed.sheets,
      sourceUpdatedAt, parsedSourceUpdatedAt: trustedSourceUpdatedAt, uploadedAt: now, uploadedBy: account.username || String(account.userId), uploadedByUserId: String(account.userId), rules: parsed.rules
    };
    let uploadRecordSaved = false;
    try {
      if (customizationAllowed && cutoverRunId) {
        const stored = await privateObjectStore.putBuffer({ tenantId: dataAccount.tenantId, kind: 'logistics_file', body, extension: '.xlsx' });
        const object = await authStore.addLivePrivateObject(dataAccount, {
          ...stored, kind: 'logistics_file', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          sourceRelativePath: 'logistics/' + String(dataAccount.tenantId) + '/' + storedRelativePath.replace(/\\/g, '/'),
          metadata: { id, originalName, uploadedByUserId: String(account.userId) }
        });
        item.objectId = object.objectId;
        item.objectOrigin = 'live';
      } else if (customizationAllowed) fs.writeFileSync(target, body, { flag: 'wx', mode: 0o600 });
      if (customizationAllowed) {
        const localKeyAccount = account.isSystemAdmin ? dataAccount : account;
        const localDocument = await authStore.getDocument(dataAccount, logisticsUserConfigKey(localKeyAccount));
        let localItems = normalizeLogisticsItems(localDocument && localDocument.payload);
        localItems.unshift({ ...item, promoted: false, localOnly: true, scope: 'local' });
        await authStore.putDocument(dataAccount, logisticsUserConfigKey(localKeyAccount), localItems.slice(0, 20));
        uploadRecordSaved = true;
      }

      const officialAccount = await authStore.systemAdminHomeAccount();
      const officialCandidate = {
        ...item,
        sourceUpdatedAt: trustedSourceUpdatedAt,
        parsedSourceUpdatedAt: trustedSourceUpdatedAt,
        storageTenantId: String(dataAccount.tenantId)
      };
      const officialResult = await promoteGlobalLogisticsOfficial(officialAccount, officialCandidate, { ...account, tenantId: dataAccount.tenantId });
      const officialPromoted = officialResult.promoted === true;
      if (officialPromoted) {
        await authStore.recordAudit(officialAccount, 'logistics.tariff.auto_promote', 'logistics_tariff', id, 'success', {
          provider: item.provider,
          version: item.version,
          sourceUpdatedAt: trustedSourceUpdatedAt,
          promotionSource: account.isSystemAdmin ? 'admin_upload' : 'customer_auto_promoted',
          promotedFromTenantId: String(dataAccount.tenantId),
          promotedFromUserId: String(account.userId),
          promotedFromUsername: String(account.username || account.userId),
          previousOfficialVersionId: officialResult.item && officialResult.item.previousOfficialVersionId || null
        });
      }
      await authStore.recordAudit(dataAccount, 'logistics.tariff.upload', 'logistics_tariff', id, 'success', {
        provider: item.provider, version: item.version, rules: item.rules.length, sha256: item.sha256,
        sourceUpdatedAt, parsedSourceUpdatedAt: trustedSourceUpdatedAt, promoted: officialPromoted, officialPromoted
      });
      const currentOfficial = officialPromoted ? officialResult.item : officialResult.current;
      return sendJson(res, 201, {
        item: officialPromoted || customizationAllowed ? publicLogisticsItem({ ...item, scope: officialPromoted ? 'official' : 'local' }, account) : null,
        promoted: officialPromoted,
        official: officialPromoted,
        officialPromoted,
        currentVersion: currentOfficial && currentOfficial.version
      });
    } catch (error) {
      if (!cutoverRunId && !uploadRecordSaved) try { fs.unlinkSync(target); } catch (cleanupError) {}
      console.error('保存物流资费配置失败:', error.publicCode || 'logistics_config_save_failed');
      return sendJson(res, error.status || 500, {
        error: error.publicCode || 'logistics_config_save_failed',
        message: '物流配置保存失败，请刷新列表核对后重新上传；如仍失败请联系管理员。'
      });
    }
  }

  if (pathname === '/api/logistics-preferences' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    try { await authStore.requireLogisticsCustomizationEntitlement(account); }
    catch (error) { return sendJson(res, error.status || 403, { error: error.publicCode || 'membership_logistics_config_required', message: userErrorText(error, '免费用户可以使用官方物流模板；配置自己的物流模板需要付费会员。') }); }
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res, 64 * 1024);
    if (!body) return;
    const applyToMembers = body.applyToMembers === true;
    if (applyToMembers && (account.isSystemAdmin || account.memberType !== 'owner')) return sendJson(res, 403, { error: 'logistics_member_sync_owner_required', message: '只有客户空间主账号可以开启物流方案的成员同步。' });
    const requested = Array.isArray(body.defaults) ? body.defaults : [];
    const defaultScheme = String(body.defaultScheme || '');
    const sources = await loadLogisticsSources(account, dataAccount, true);
    const activeItems = sources.activeItems;
    const availableSchemes = Array.from(new Set(activeItems.flatMap(item => item.rules.map(rule => rule.scheme))));
    if (!LOGISTICS_SCHEMES.includes(defaultScheme) || !availableSchemes.includes(defaultScheme)) return sendJson(res, 400, { error: 'logistics_scheme_unavailable', message: '该物流方案当前不可用，请选择其他方案。' });
    const defaults = [];
    const seen = new Set();
    for (const input of requested) {
      const provider = String(input && input.provider || '').toUpperCase();
      const scheme = String(input && input.scheme || '');
      const market = String(input && input.market || '');
      const group = String(input && input.group || '');
      const transportMode = String(input && input.transportMode || '');
      const key = [provider, scheme, market, group].join('|');
      if (!LOGISTICS_PROVIDERS.includes(provider) || !LOGISTICS_SCHEMES.includes(scheme) || !market || !LOGISTICS_GROUPS.includes(group) || !LOGISTICS_TRANSPORT_MODES.includes(transportMode) || seen.has(key)) {
        return sendJson(res, 400, { error: 'logistics_preference_invalid', message: '物流偏好设置不正确，请重新选择承运方式后再保存。' });
      }
      const available = activeItems.some(config => config.provider === provider && config.rules.some(rule => rule.scheme === scheme && rule.market === market && rule.group === group && rule.transportMode === transportMode));
      if (!available) return sendJson(res, 400, { error: 'logistics_transport_unavailable', message: '该线路暂无可用承运方式，请更换出发地或目的地后重试。' });
      seen.add(key);
      defaults.push({ provider, scheme, market, group, transportMode });
    }
    try {
      const payload = { policyVersion: LOGISTICS_PREFERENCE_POLICY_VERSION, defaultScheme, defaults };
      await authStore.putDocument(dataAccount, logisticsPreferenceKey(account), payload);
      let appliedMembers = 0;
      if (applyToMembers) {
        const members = (await authStore.listMembers(dataAccount)).filter(member => member.memberType !== 'owner');
        appliedMembers = await authStore.putUserScopedDocuments(dataAccount, members.map(member => member.userId), 'erp_logistics_preferences_', payload);
      }
      await authStore.recordAudit(dataAccount, applyToMembers ? 'logistics.preference.sync_members' : 'logistics.preference.update', 'logistics_tariff', String(account.userId), 'success', { defaultScheme, defaults: defaults.length, appliedMembers });
      return sendJson(res, 200, { defaultScheme, defaults, appliedMembers });
    } catch (error) {
      console.error('保存物流默认运输方式失败:', error.message);
      return sendJson(res, 500, { error: 'logistics_preference_save_failed', message: '物流偏好保存失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/logistics-plan-profiles' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (account.isSystemAdmin || account.memberType !== 'owner') return sendJson(res, 403, { error: 'logistics_profile_owner_required', message: '只有该物流方案的所有者可以修改它。' });
    try { await authStore.requireLogisticsCustomizationEntitlement(account); }
    catch (error) { return sendJson(res, error.status || 403, { error: error.publicCode || 'membership_logistics_config_required', message: userErrorText(error, '免费用户可以使用官方物流模板；配置自己的物流模板需要付费会员。') }); }
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res, 96 * 1024);
    if (!body) return;
    const profileId = String(body.profileId || '');
    if (!LOGISTICS_PLAN_PROFILE_IDS.includes(profileId)) return sendJson(res, 400, { error: 'logistics_profile_invalid', message: '物流方案档案数据不完整，请重新选择方案后再保存。' });
    const requestedUserIds = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(String).filter(value => /^\d+$/.test(value)))];
    const members = await authStore.listMembers(dataAccount);
    const allowedUserIds = new Set(members.map(member => member.userId));
    if (requestedUserIds.some(userId => !allowedUserIds.has(userId))) return sendJson(res, 400, { error: 'logistics_profile_user_invalid', message: '所选成员账号不可用，请重新选择后再保存。' });
    const defaultScheme = String(body.defaultScheme || '');
    const requested = Array.isArray(body.defaults) ? body.defaults : [];
    const sources = await loadLogisticsSources(account, dataAccount, true);
    const activeItems = sources.activeItems;
    const availableSchemes = Array.from(new Set(activeItems.flatMap(item => item.rules.map(rule => rule.scheme))));
    if (!LOGISTICS_SCHEMES.includes(defaultScheme) || !availableSchemes.includes(defaultScheme)) return sendJson(res, 400, { error: 'logistics_scheme_unavailable', message: '该物流方案当前不可用，请选择其他方案。' });
    const defaults = [];
    const seen = new Set();
    for (const input of requested) {
      const provider = String(input && input.provider || '').toUpperCase();
      const scheme = String(input && input.scheme || '');
      const market = String(input && input.market || '');
      const group = String(input && input.group || '');
      const transportMode = String(input && input.transportMode || '');
      const key = [provider, scheme, market, group].join('|');
      if (!LOGISTICS_PROVIDERS.includes(provider) || !LOGISTICS_SCHEMES.includes(scheme) || !market || !LOGISTICS_GROUPS.includes(group) || !LOGISTICS_TRANSPORT_MODES.includes(transportMode) || seen.has(key)) return sendJson(res, 400, { error: 'logistics_preference_invalid', message: '物流偏好设置不正确，请重新选择承运方式后再保存。' });
      const available = activeItems.some(config => config.provider === provider && config.rules.some(rule => rule.scheme === scheme && rule.market === market && rule.group === group && rule.transportMode === transportMode));
      if (!available) return sendJson(res, 400, { error: 'logistics_transport_unavailable', message: '该线路暂无可用承运方式，请更换出发地或目的地后重试。' });
      seen.add(key);
      defaults.push({ provider, scheme, market, group, transportMode });
    }
    try {
      const profileDocument = await authStore.getDocument(dataAccount, LOGISTICS_PLAN_PROFILES_KEY);
      const profile = { id: profileId, userIds: requestedUserIds, defaultScheme, defaults, updatedAt: new Date().toISOString(), updatedBy: account.username };
      const profiles = assignLogisticsPlanProfile(profileDocument && profileDocument.payload, profile);
      await authStore.putDocument(dataAccount, LOGISTICS_PLAN_PROFILES_KEY, profiles);
      const payload = { policyVersion: LOGISTICS_PREFERENCE_POLICY_VERSION, defaultScheme, defaults };
      const ownerSelected = requestedUserIds.includes(String(account.userId));
      if (ownerSelected) await authStore.putDocument(dataAccount, logisticsPreferenceKey(account), payload);
      const childIds = requestedUserIds.filter(userId => userId !== String(account.userId));
      const appliedUsers = await authStore.putUserScopedDocuments(dataAccount, childIds, 'erp_logistics_preferences_', payload);
      await authStore.recordAudit(dataAccount, 'logistics.profile.update', 'logistics_tariff', profileId, 'success', { defaultScheme, defaults: defaults.length, appliedMembers: appliedUsers, userIds: requestedUserIds });
      return sendJson(res, 200, { profiles, appliedUsers });
    } catch (error) {
      console.error('保存物流方案失败:', error.message);
      return sendJson(res, 500, { error: 'logistics_profile_save_failed', message: '物流方案档案保存失败，请稍后重试。' });
    }
  }

  const logisticsActivateMatch = pathname.match(/^\/api\/logistics-configs\/([a-f0-9-]{36})\/activate$/);
  if (logisticsActivateMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!canManageSettings(account)) return sendJson(res, 403, { error: 'settings_owner_required', message: '只有该设置的所有者可以修改它，请用自己的账号操作。' });
    if (!requireCsrf(req, res)) return;
    try { await authStore.requireLogisticsCustomizationEntitlement(account); }
    catch (error) { return sendJson(res, error.status || 403, { error: error.publicCode || 'membership_logistics_config_required', message: userErrorText(error, '免费用户可以使用官方物流模板；配置自己的物流模板需要付费会员。') }); }
    const requestedAccount = tenantScopedReadAccount(req, res, account);
    if (!requestedAccount) return;
    let dataAccount;
    try { dataAccount = account.isSystemAdmin ? await authStore.systemAdminHomeAccount() : requestedAccount; }
    catch (error) { return sendJson(res, 500, { error: error.publicCode || 'system_admin_home_invalid', message: userErrorText(error, '系统管理员官方配置空间不可用，请检查唯一admin账号。') }); }
    try {
      const [document, localDocument] = await Promise.all([
        authStore.getDocument(dataAccount, LOGISTICS_CONFIG_KEY),
        authStore.getDocument(dataAccount, logisticsUserConfigKey(account.isSystemAdmin ? dataAccount : account))
      ]);
      const items = normalizeLogisticsItems(document && document.payload, true);
      const localItems = normalizeLogisticsItems(localDocument && localDocument.payload);
      const selected = items.concat(localItems).find(item => item && item.id === logisticsActivateMatch[1]);
      if (!selected) return sendJson(res, 404, { error: 'logistics_config_not_found', message: '未找到该物流方案配置，请刷新列表后重试。' });
      const selectedSystemItem = { ...selected, active: true, scope: account.isSystemAdmin ? 'official' : 'tenant', localOnly: false, promoted: true };
      const existing = items.some(item => item.id === selected.id);
      const updated = (existing ? items : [selectedSystemItem, ...items]).map(item => item && item.provider === selected.provider ? { ...item, active: item.id === selected.id } : item);
      await authStore.putDocument(dataAccount, LOGISTICS_CONFIG_KEY, updated);
      await authStore.recordAudit(dataAccount, 'logistics.tariff.activate', 'logistics_tariff', selected.id, 'success', { provider: selected.provider, version: selected.version });
      return sendJson(res, 200, { ok: true });
    } catch (error) {
      console.error('启用物流资费版本失败:', error.message);
      return sendJson(res, 500, { error: 'logistics_config_activate_failed', message: '物流方案启用失败，请稍后重试；仍未成功请联系管理员。' });
    }
  }

  const logisticsFileMatch = pathname.match(/^\/api\/logistics-configs\/([a-f0-9-]{36})\/file$/);
  if (logisticsFileMatch && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const customizationAllowed = (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
    // Free/expired members may USE official tariff rules, but cannot read
    // protected original Excel bytes even if they uploaded before expiry.
    if (!customizationAllowed) return sendJson(res, 403, {
      error: 'membership_logistics_config_required',
      message: '免费会员可以使用官方物流模板，但无法查看或下载受保护的原始表格。'
    });
    let sources;
    try { sources = await loadLogisticsSources(account, dataAccount, customizationAllowed); }
    catch (error) { return sendJson(res, 500, { error: error.publicCode || 'logistics_config_read_failed', message: userErrorText(error, '物流配置读取失败，请稍后刷新重试。') }); }
    const item = sources.effectiveItems.concat(sources.localItems).find(config => config.id === logisticsFileMatch[1]);
    if (!item) return sendJson(res, 404, { error: 'logistics_config_not_found', message: '未找到该物流方案配置，请刷新列表后重试。' });
    if (!canDownloadOriginal(account, item)) {
      return sendJson(res, 403, { error: 'logistics_original_file_owner_required', message: '原始物流表只允许上传者或系统管理员下载，请查看页面中的官方资费规则。' });
    }
    const storageTenantId = String(item.storageTenantId || dataAccount.tenantId);
    const storageAccount = { ...dataAccount, tenantId: storageTenantId };
    const sourceRelativePath = 'logistics/' + storageTenantId + '/' + String(item.storedRelativePath || item.storedName || '').replace(/\\/g, '/');
    const migratedObject = await authStore.getPrivateObjectBySource(storageAccount, 'logistics_file', sourceRelativePath);
    const file = privateObjectFile(migratedObject) || logisticsStoredFile(storageTenantId, item);
    if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: 'logistics_file_not_found', message: '未找到该物流原始表格文件，请重新上传后再解析。' });
    const stat = fs.statSync(file);
    res.writeHead(200, Object.assign(securityHeaders(), {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': stat.size, 'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.originalName || 'logistics.xlsx')}`
    }));
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (pathname === '/api/bug-attachments' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const cutoverRunId = await authStore.getTenantCutoverRun(dataAccount);
    if (fs.existsSync(P2_FREEZE_MARKER) && !cutoverRunId) return sendJson(res, 423, { error: 'migration_source_frozen', message: '迁移期间的旧数据只读冻结，不能写入，请等待迁移完成。' });
    const params = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
    const reportId = String(params.get('reportId') || '').trim();
    if (!/^BUG-[A-Z0-9-]{6,80}$/.test(reportId)) return sendJson(res, 400, { error: 'invalid_bug_report_id', message: '未找到要操作的报错记录，请刷新列表后重试。' });
    if (!await authStore.canAccessBugReport(dataAccount, reportId)) return sendJson(res, 404, { error: 'bug_report_not_found', message: '未找到这条报错记录，请刷新列表后重试。' });
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const rule = BUG_ATTACHMENT_TYPES.get(type);
    if (!rule) return sendJson(res, 415, { error: 'bug_attachment_type_not_allowed', message: '该文件类型不支持上传，请选择图片、日志或文本文件。' });
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > rule.maximum) return sendJson(res, 413, { error: 'bug_attachment_too_large', message: '附件超过允许大小，请压缩或改用更小的文件后再上传。' });
    const reportDir = path.join(BUG_ATTACHMENT_DIR, String(dataAccount.tenantId), reportId);
    if (await authStore.countBugAttachments(dataAccount, reportId) >= 6) return sendJson(res, 409, { error: 'bug_attachment_limit_reached', message: '该报错的附件数量已达上限，请删除部分附件后再上传。' });
    if (!cutoverRunId) fs.mkdirSync(reportDir, { recursive: true });
    let body;
    try { body = await readBody(req, rule.maximum); }
    catch (error) { return sendJson(res, error.publicCode === 'body_too_large' ? 413 : 400, { error: error.publicCode || 'bug_attachment_upload_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
    if (!body.length) return sendJson(res, 400, { error: 'bug_attachment_empty', message: '请至少选择一个报错附件再提交。' });
    if (!matchesBugAttachmentSignature(type, body)) return sendJson(res, 415, { error: 'bug_attachment_content_invalid', message: '附件内容校验未通过，请重新选择图片、日志或文本文件。' });
    const attachmentId = crypto.randomUUID();
    const storedName = attachmentId + rule.extension;
    const target = path.join(reportDir, storedName);
    const originalName = String(params.get('name') || '附件').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || '附件';
    try {
      let object = null;
      if (cutoverRunId) {
        const stored = await privateObjectStore.putBuffer({ tenantId: dataAccount.tenantId, kind: 'bug_attachment', body, extension: rule.extension });
        object = await authStore.addLivePrivateObject(dataAccount, {
          ...stored, kind: 'bug_attachment', mediaType: type,
          sourceRelativePath: `bug-attachments/${dataAccount.tenantId}/${reportId}/${storedName}`,
          metadata: { reportId, attachmentId, originalName, uploadedByUserId: String(account.userId) }
        });
      } else fs.writeFileSync(target, body, { flag: 'wx', mode: 0o600 });
      await authStore.addBugAttachment(dataAccount, reportId, {
        id: attachmentId, name: originalName, storedName, type, size: body.length,
        objectId: object && object.objectId, sha256: object && object.sha256
      });
      await authStore.recordAudit(dataAccount, 'bug.attachment.upload', 'bug_report', reportId, 'success', { attachmentId, type, size: body.length });
      const tenantSuffix = account.isSystemAdmin && String(dataAccount.tenantId) !== String(account.tenantId) ? '?tenantId=' + encodeURIComponent(dataAccount.tenantId) : '';
      return sendJson(res, 201, {
        attachment: {
          id: attachmentId, name: originalName, type, size: body.length,
          url: '/api/bug-attachments/' + encodeURIComponent(reportId) + '/' + storedName + tenantSuffix
        }
      });
    } catch (error) {
      if (!cutoverRunId) try { fs.unlinkSync(target); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') console.error('清理 BUG 附件失败:', cleanupError.message); }
      if (error.publicCode === 'bug_report_forbidden') return sendJson(res, 403, { error: error.publicCode, message: userErrorText(error, "没有权限查看或修改这条报错记录。")});
      console.error('保存 BUG 附件失败:', error.message);
      return sendJson(res, 500, { error: 'bug_attachment_save_failed', message: '报错附件保存失败，请稍后重试；仍未成功请联系管理员。' });
    }
  }

  if (pathname === '/api/bug-reports/notify' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    const body = await readJsonBody(req, res, 16 * 1024);
    if (!body) return;
    const reportId = String(body.reportId || '').trim();
    if (!/^BUG-[A-Z0-9-]{6,80}$/.test(reportId)) return sendJson(res, 400, { error: 'invalid_bug_report_id', message: '未找到要操作的报错记录，请刷新列表后重试。' });
    const retryAfter = consumeWindow(bugEmailWindows, String(account.userId), 60 * 60 * 1000, 20);
    if (retryAfter) return sendJson(res, 429, { error: 'bug_email_rate_limited', message: '报错邮件发送过于频繁，请稍后再试。', retryAfter }, { 'Retry-After': String(retryAfter) });
    const notificationKey = String(dataAccount.tenantId) + '|' + reportId;
    if (bugEmailNotifications.has(notificationKey)) return sendJson(res, 200, { ok: true, email: { sent: true, duplicate: true, recipient: bugMailer.recipient } });
    try {
      const document = await authStore.getDocument(dataAccount, 'erp_bug_reports');
      const report = (document && Array.isArray(document.payload) ? document.payload : []).find(item => item && item.id === reportId);
      if (!report) return sendJson(res, 404, { error: 'bug_report_not_found', message: '未找到这条报错记录，请刷新列表后重试。' });
      let persisted;
      try {
        persisted = await authStore.enqueueBackgroundJob(dataAccount, {
          id: 'bug-email-' + reportId, type: 'bug_email', dedupeKey: reportId,
          context: { reportId }, maxAttempts: 1
        });
      } catch (error) {
        if (!persistentQueueSchemaMissing(error)) throw error;
      }
      if (persisted && persisted.job) {
        const sent = persisted.job.state === 'done';
        return sendJson(res, sent ? 200 : 202, { ok: true, email: { queued: !sent, sent, duplicate: persisted.duplicate, recipient: bugMailer.recipient } });
      }      const queued = bugEmailQueue.enqueue(notificationKey, async () => {
        try {
          const result = await bugMailer.send(report, account);
          if (result.sent) bugEmailNotifications.set(notificationKey, Date.now());
          await authStore.recordAudit(dataAccount, 'bug.email.notify', 'bug_report', reportId, result.sent ? 'success' : 'skipped', {
            emailConfigured: bugMailer.configured, reason: result.reason || ''
          });
        } catch (error) {
          await authStore.recordAudit(dataAccount, 'bug.email.notify', 'bug_report', reportId, 'failed', { emailConfigured: bugMailer.configured, reason: 'send_failed' }).catch(() => {});
          throw error;
        }
      });
      if (queued.full) return sendJson(res, 503, { error: 'bug_email_queue_full', message: 'BUG邮件队列已满，请稍后重试。' }, { 'Retry-After': '10' });
      return sendJson(res, 202, { ok: true, email: { queued: true, duplicate: queued.duplicate, volatile: true, recipient: bugMailer.recipient } });
    } catch (error) {
      if (error.publicCode === 'background_job_queue_full') return sendJson(res, 503, { error: 'background_job_queue_full', message: '服务器任务队列已满，请稍后重试。' }, { 'Retry-After': '10' });
      console.error('BUG邮件入队失败:', reportId, error.message);
      return sendJson(res, 500, { error: 'bug_email_enqueue_failed', message: '报错提醒邮件排队失败，不影响报错提交，请稍后在队列页面重试。' });
    }
  }

  const bugAttachmentMatch = pathname.match(/^\/api\/bug-attachments\/(BUG-[A-Z0-9-]{6,80})\/([a-f0-9-]{36}\.(?:jpg|png|gif|webp|mp4|webm|mov))$/);
  if (bugAttachmentMatch && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const dataAccount = tenantScopedReadAccount(req, res, account);
    if (!dataAccount) return;
    if (!await authStore.canAccessBugAttachment(dataAccount, bugAttachmentMatch[1], bugAttachmentMatch[2])) return sendJson(res, 404, { error: 'bug_attachment_not_found', message: '未找到该报错附件，请刷新页面后重试。' });
    const migratedObject = await authStore.getBugAttachmentObject(dataAccount, bugAttachmentMatch[1], bugAttachmentMatch[2]);
    const file = privateObjectFile(migratedObject) || path.join(BUG_ATTACHMENT_DIR, String(dataAccount.tenantId), bugAttachmentMatch[1], bugAttachmentMatch[2]);
    if (!pathInside(BUG_ATTACHMENT_DIR, file)) return sendJson(res, 403, { error: 'forbidden', message: '没有权限执行该操作，请联系管理员确认账号权限。' });
    let stat;
    try { stat = fs.statSync(file); } catch (error) { return sendJson(res, 404, { error: 'bug_attachment_not_found', message: '未找到该报错附件，请刷新页面后重试。' }); }
    const extension = path.extname(file).toLowerCase();
    const type = extension === '.mov' ? 'video/quicktime' : MIME[extension] || (extension === '.webm' ? 'video/webm' : extension === '.mp4' ? 'video/mp4' : extension === '.webp' ? 'image/webp' : 'application/octet-stream');
    res.writeHead(200, Object.assign(securityHeaders(), {
      'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline'
    }));
    fs.createReadStream(file).pipe(res);
    return;
  }

function collectionCollectorLabel(account) {
  if (!account) return '';
  if (account.isSystemAdmin) return '系统管理员';
  return String(account.profileFullName || account.email || '').trim();
}
function stampCollectionCollectors(previousPayload, incomingPayload, account) {
  if (!Array.isArray(incomingPayload)) return incomingPayload;
  const previous = Array.isArray(previousPayload) ? previousPayload : [];
  const byId = new Map(previous.map(item => [String(item && item.id || ''), item]).filter(pair => pair[0]));
  const actor = collectionCollectorLabel(account);
  const userId = String(account && account.userId || '');
  const now = new Date().toISOString();
  return incomingPayload.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const next = { ...item };
    delete next.collectedByIdentity;
    const before = byId.get(String(next.id || '')) || null;
    if (!before) {
      next.collectedBy = actor || '历史未记录';
      next.collectedByUserId = userId;
      next.collectedAt = now;
    } else {
      next.collectedBy = String(before.collectedBy || '');
      next.collectedByUserId = String(before.collectedByUserId || '');
      next.collectedAt = String(before.collectedAt || '');
    }
    return next;
  });
}

function stampBugReportCreators(previousPayload, incomingPayload, account) {
  if (!Array.isArray(incomingPayload)) return incomingPayload;
  const previous = Array.isArray(previousPayload) ? previousPayload : [];
  const byId = new Map(previous.map(item => [String(item && item.id || ''), item]).filter(pair => pair[0]));
  const actor = collectionCollectorLabel(account) || '历史未记录';
  const userId = String(account && account.userId || '');
  return incomingPayload.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const next = { ...item };
    delete next.createdByIdentity;
    const before = byId.get(String(next.id || ''));
    if (before) {
      next.createdBy = String(before.createdBy || '历史未记录');
      next.createdByUserId = String(before.createdByUserId || '');
    } else {
      next.createdBy = actor;
      next.createdByUserId = userId;
    }
    return next;
  });
}


  if (pathname.startsWith('/api/data/')) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    const key = pathname.slice('/api/data/'.length);
    if (!key) return sendJson(res, 400, { error: 'missing key' });
    if (!BUSINESS_DATA_KEYS.has(key)) return sendJson(res, 404, { error: 'unknown data key' });
    const requiredPermissions = requiredBusinessDataPermissions(key, req.method);
    const sharedAuthenticatedKey = key === 'erp_bug_reports';
    if ((!requiredPermissions.length && !sharedAuthenticatedKey && !account.isSystemAdmin && account.memberType !== 'owner') || (requiredPermissions.length && !hasAnyPermission(account, requiredPermissions))) {
      return sendJson(res, 403, { error: 'permission_denied' });
    }
    if (req.method !== 'GET' && !sharedAuthenticatedKey && key !== productCreate.DRAFT_KEY && !account.isSystemAdmin && account.memberType !== 'owner' && account.shopScopeMode === 'selected') {
      return sendJson(res, 403, { error: 'selected_shop_scope_write_denied', message: '所选店铺不在你的授权范围内，不能写入，请重新选择店铺。' });
    }
    // 预览底图决定所有客户看到的出图效果，按 2026-09-21 确认只允许系统管理员更换；普通账号仍可读取用于预览。
    if (key === 'erp_watermark_preview_base' && req.method !== 'GET' && !account.isSystemAdmin) {
      return sendJson(res, 403, { error: 'watermark_preview_base_system_admin_only', message: '水印底图只能由系统管理员更换，普通账号仅可选择文字与位置。' });
    }
    if (key === 'erp_shops_data' && req.method !== 'GET' && !account.isSystemAdmin && account.memberType !== 'owner' && !authStore.hasPermission(account, 'shops.credentials.manage')) {
      return sendJson(res, 403, { error: 'shop_credentials_permission_required', message: '没有查看该店铺密钥的权限，请联系管理员授权。' });
    }
    const requestUrl = new URL(req.url, 'http://' + HOST + ':' + PORT);
    const requestedTenantId = String(requestUrl.searchParams.get('tenantId') || '').trim();
    if (requestedTenantId && !account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    if (requestedTenantId && !/^\d+$/.test(requestedTenantId)) return sendJson(res, 400, { error: 'invalid_tenant_id', message: '客户空间标识不正确，请刷新页面后重新选择空间。' });
    const dataAccount = requestedTenantId ? { ...account, tenantId: requestedTenantId } : account;
    if (req.method === 'GET') {
      try {
        let document = key === productCreate.DRAFT_KEY
          ? await authStore.getProductCreateDraftDocument(dataAccount)
          : await authStore.getDocument(dataAccount, key);
        if (!document && LEGACY_JSON_LAZY_IMPORT_ENABLED) {
          const legacyData = readTenantJson(dataAccount.tenantId, key);
          if (legacyData === null) {
            if (EMPTY_WHEN_MISSING_DATA_KEYS.has(key)) return sendJson(res, 200, [], { 'X-Data-Version': '0' });
            return sendJson(res, 404, { error: 'not found', message: '未找到对应的业务数据，请刷新页面后重试。' });
          }
          const importData = key === 'erp_shops_data'
            ? encryptShopCredentials(legacyData, CREDENTIALS_KEY, dataAccount.tenantId)
            : legacyData;
          const imported = await authStore.putDocument(dataAccount, key, importData);
          document = { payload: legacyData, version: imported.version, updatedAt: imported.updatedAt };
        }
        if (!document) {
          if (EMPTY_WHEN_MISSING_DATA_KEYS.has(key)) return sendJson(res, 200, [], { 'X-Data-Version': '0' });
          return sendJson(res, 404, { error: 'not found', message: '未找到对应的业务数据，请刷新页面后重试。' });
        }
        if (key === 'erp_shops_data') {
          const storedPayload = document.payload;
          document.payload = decryptShopCredentials(storedPayload, CREDENTIALS_KEY, dataAccount.tenantId);
          if (CREDENTIALS_KEY && hasPlaintextShopCredentials(storedPayload)) {
            const migrated = await authStore.putDocument(
              dataAccount,
              key,
              encryptShopCredentials(storedPayload, CREDENTIALS_KEY, dataAccount.tenantId),
              document.version
            );
            document.version = migrated.version;
          }
        }
        const allowedShops = await authStore.listAllowedShops(dataAccount);
        // Explicit shop targets must be authorized by ID, never by a matching display name.
        if (allowedShops !== null && ['clientId', 'externalShopId', 'shopId'].some(field => {
          if (!requestUrl.searchParams.has(field)) return false;
          const id = String(requestUrl.searchParams.get(field) || '').trim();
          return !id || !allowedShops.some(shop => shop && (field === 'shopId'
            ? [shop.id, shop.externalShopId].some(value => value !== null && value !== undefined && String(value).trim() === id)
            : shop.externalShopId !== null && shop.externalShopId !== undefined && String(shop.externalShopId).trim() === id));
        })) return sendJson(res, 403, { error: 'shop_scope_denied' });
        return sendJson(
          res,
          200,
          filterShopScopedData(key, document.payload, allowedShops, dataAccount),
          { 'X-Data-Version': String(document.version) }
        );
      } catch (e) {
        console.error('读取租户业务数据失败:', key, e.message);
        return sendJson(res, 500, { error: 'business_data_read_failed', message: '数据读取失败，请稍后刷新页面重试。' });
      }
    }
    if (req.method === 'POST') {
      if (!requireCsrf(req, res)) return;
      if (RELATIONAL_BUSINESS_KEYS.has(key) && !FINANCE_SETTING_KEYS.has(key) && key !== 'erp_bug_reports') {
        return sendJson(res, 405, { error: 'business_row_command_required', message: '请选择要执行的操作（新增、更新或清理）后再提交。' }, { Allow: 'GET' });
      }
      try {
        const ifMatch = String(req.headers['if-match'] || '').trim().replace(/^"|"$/g, '');
        if (ifMatch && !/^\d+$/.test(ifMatch)) return sendJson(res, 400, { error: 'invalid_data_version', message: '数据版本号不正确，请刷新页面后重新提交。' });
        const expectedVersion = ifMatch ? Number(ifMatch) : undefined;
        const body = await readBody(req);
        let data;
        try { data = JSON.parse(body.toString('utf8')); }
        catch (e) { return sendJson(res, 400, { error: 'bad json', message: '请求内容格式不正确，请刷新页面后重新提交。' }); }
        if (key === 'erp_shops_data' && !isValidShopCredentialInput(data)) {
          return sendJson(res, 400, { error: 'invalid_shop_data', message: '店铺信息不完整，请填写店铺名称与平台密钥后再保存。' });
        }
        let documentData = data;
        let previousPayload = [];
        if (AUDITED_KEYS.has(key) || key === 'erp_collected_products' || key === 'erp_favorite_products' || key === 'erp_bug_reports' || key === productCreate.DRAFT_KEY) {
          const existing = await authStore.getDocument(dataAccount, key);
          previousPayload = existing
            ? (key === 'erp_shops_data' ? decryptShopCredentials(existing.payload, CREDENTIALS_KEY, dataAccount.tenantId) : existing.payload)
            : [];
        }
        if (key === 'erp_shops_data') {
          documentData = mergeShopCredentialInput(data, previousPayload);
          const incompletePerformance = documentData.find(item => {
            const performanceClientId = String(item && item.performanceClientId || '').trim();
            const performanceClientSecret = String(item && item.performanceClientSecret || '').trim();
            return Boolean(performanceClientId) !== Boolean(performanceClientSecret);
          });
          if (incompletePerformance) {
            return sendJson(res, 400, {
              error: 'performance_credentials_incomplete',
              message: '广告费接口必须同时填写 Performance Client ID 和 Client Secret；Client Secret 留空仅可用于保持已保存密钥不变。'
            });
          }
        }
        if (key === productCreate.DRAFT_KEY) {
          const combinationGraph = await productCombinationGraph.read(authStore, dataAccount);
          documentData = productCreate.limitDrafts(documentData, previousPayload, account.userId, {
            combinationPayload: combinationGraph.payload
          });
        }
        if (['erp_orders_data', 'erp_online_products', 'erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1', 'erp_collected_products', 'erp_favorite_products', 'erp_online_product_manual', 'erp_dev_manual_backup'].includes(key)) {
          documentData = normalizePlatformPayload(key, documentData, SUPPLIER_HOST_ALLOWLIST);
        }
        const rawOperationSource = String(req.headers['x-erp-operation-source'] || '').toLowerCase();
        const displayIdentity = (AUDITED_KEYS.has(key) || key === 'erp_collected_products' || key === 'erp_favorite_products' || key === 'erp_bug_reports')
          ? await authStore.accountDisplayIdentity(dataAccount) : null;
        const actorAccount = displayIdentity ? { ...dataAccount, profileFullName: displayIdentity.profileFullName || '', email: displayIdentity.email || '' } : dataAccount;
        if (key === 'erp_collected_products') documentData = stampCollectionCollectors(previousPayload, documentData, actorAccount);
        if (key === 'erp_favorite_products') documentData = favoriteCreator.stamp(previousPayload, documentData, actorAccount);
        if (key === 'erp_bug_reports') documentData = stampBugReportCreators(previousPayload, documentData, actorAccount);
        if (key === 'erp_collected_products') {
          const previousIds = new Set((Array.isArray(previousPayload) ? previousPayload : []).map(item => String(item && item.id || '')).filter(Boolean));
          const nextIds = new Set((Array.isArray(documentData) ? documentData : []).map(item => String(item && item.id || '')).filter(Boolean));
          const removedIds = [...previousIds].filter(id => !nextIds.has(id));
          if (removedIds.length) {
            const combinationGraph = await productCombinationGraph.read(authStore, dataAccount);
            productCombinationGraph.assertCollectionsRemovable(combinationGraph.payload, removedIds);
          }
        }
        const operationSource = rawOperationSource === 'sync' ? 'sync' : 'manual';
        if (AUDITED_KEYS.has(key)) documentData = applyEntityAudit(key, previousPayload, documentData, actorAccount, undefined, { source: operationSource });
        const storedData = key === 'erp_shops_data'
          ? encryptShopCredentials(documentData, CREDENTIALS_KEY, dataAccount.tenantId)
          : documentData;
        const saved = key === 'erp_collected_products' && !STANDALONE_MODE
          ? await membershipQuota.withCollectionBoxGate(authStore, dataAccount, documentData, function () { return authStore.putDocument(dataAccount, key, storedData, expectedVersion); })
          : await authStore.putDocument(dataAccount, key, storedData, expectedVersion);
        if (key === CATEGORY_ATTRIBUTE_KEY) invalidateCategoryMatchCompiledCache(dataAccount);
        await authStore.recordAudit(dataAccount, 'tenant.document.update', 'tenant_document', key, 'success', { version: saved.version });
        const responseData = { ok: true, version: saved.version, updatedAt: saved.updatedAt };
        if (AUDITED_KEYS.has(key) || key === 'erp_collected_products' || key === 'erp_favorite_products' || key === 'erp_bug_reports' || key === productCreate.DRAFT_KEY) {
          const scopedResponsePayload = filterShopScopedData(key, documentData, null, dataAccount);
          responseData.payload = await projectBusinessIdentityDisplay(key, scopedResponsePayload, dataAccount);
        }
        sendJson(res, 200, responseData);
      } catch (e) {
        if (e.publicCode === 'document_version_conflict') return sendJson(res, 409, { error: 'data_version_conflict', message: '这条记录已被其他操作更新，请刷新后重新修改，避免覆盖别人的结果。' });
        if (e.publicCode === 'collection_product_in_combination') return sendJson(res, 409, { error: e.publicCode, message: e.message });
        if (e.publicCode === 'membership_shop_limit' || e.publicCode === 'membership_favorite_limit') {
          const label = e.publicCode === 'membership_shop_limit' ? '店铺' : '收藏商品';
          return sendJson(res, 409, { error: e.publicCode, message: `当前会员方案最多可保留 ${e.limit} 个${label}，已保留 ${e.usage} 个。请先清理不再使用的${label}，或升级会员方案后再新增。`, limit: e.limit, usage: e.usage });
        }
        if (e.publicCode === 'membership_collection_box_limit') {
          return sendJson(res, 409, { error: e.publicCode, message: `当前会员方案采集箱最多可保留 ${e.limit} 个商品，当前已保留 ${e.usage} 个。请先清理不再需要的采集商品，或升级会员方案后再继续采集。`, limit: e.limit, usage: e.usage });
        }
        if (e.publicCode === 'supplier_url_invalid' || e.publicCode === 'supplier_url_not_allowed' || e.publicCode === 'invalid_bug_reports' || e.publicCode === 'invalid_product_drafts') {
          return sendJson(res, 400, { error: e.publicCode, message: userErrorText(e, '保存的内容里有不符合要求的链接或记录，请按页面提示修改后再保存。') });
        }
        console.error('写入租户业务数据失败:', key, e.message);
        sendJson(res, 500, { error: 'business_data_write_failed', message: '数据保存失败，服务端已记录原因，请重试；仍未成功请联系管理员。' });
      }
      return;
    }
    if (req.method === 'DELETE') {
      if (!requireCsrf(req, res)) return;
      if (RELATIONAL_BUSINESS_KEYS.has(key)) return sendJson(res, 405, { error: 'domain_command_required', message: '缺少操作指令，请从页面入口重新发起操作。' }, { Allow: 'GET' });
      try {
        if (key === 'erp_collected_products') {
          const current = await authStore.getDocument(dataAccount, key);
          const ids = Array.isArray(current && current.payload) ? current.payload.map(item => String(item && item.id || '')).filter(Boolean) : [];
          if (ids.length) {
            const combinationGraph = await productCombinationGraph.read(authStore, dataAccount);
            productCombinationGraph.assertCollectionsRemovable(combinationGraph.payload, ids);
          }
        }
        await authStore.deleteDocument(dataAccount, key);
        await authStore.recordAudit(dataAccount, 'tenant.document.delete', 'tenant_document', key, 'success');
        return sendJson(res, 200, { ok: true });
      } catch (error) {
        if (error.publicCode === 'collection_product_in_combination') return sendJson(res, 409, { error: error.publicCode, message: error.message });
        console.error('删除租户业务数据失败:', key, error.message);
        return sendJson(res, 500, { error: 'business_data_delete_failed', message: '数据删除失败，服务端已记录原因，请稍后重试或联系管理员。' });
      }
    }
    return sendJson(res, 405, { error: 'method not allowed', message: '该请求方式不被支持，请刷新页面后重试。' });
  }

  // 版本更新公告（公众只读）
  if (pathname === '/api/notices' && req.method === 'GET') {
    fs.readFile(path.join(DATA_DIR, 'notices.json'), 'utf8', function (err, raw) {
      if (err) return sendJson(res, 200, []);
      try { sendJson(res, 200, parseJsonStrict(raw)); }
      catch (e) { sendJson(res, 200, []); }
    });
    return;
  }

  if (pathname === '/api/integrations/1688/status' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    return sendJson(res, 200, {
      configured: Boolean(process.env.ERP_1688_APP_KEY && process.env.ERP_1688_APP_SECRET),
      oauthImplemented: false,
      message: '当前版本尚未实现 1688 OAuth 回调，页面不会收集或保存授权密钥。'
    });
  }

  if (pathname === '/api/integrations/ai/prompts' && ['GET', 'POST'].includes(req.method)) {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (req.method === 'POST' && !requireCsrf(req, res)) return;
    try {
      if (req.method === 'GET') {
        const customizationAllowed = (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
        const data = await aiPromptStore.list(account);
        const canReadPromptBodies = account.isSystemAdmin === true || data.owner === true;
        if (canReadPromptBodies && (customizationAllowed || account.isSystemAdmin)) return sendJson(res, 200, { ...data, customizationAllowed: true });
        if (canReadPromptBodies) return sendJson(res, 200, {
          ...data,
          customizationAllowed: false,
          custom: [],
          variables: [],
          official: data.official.map(item => ({ ...item, body: '', masked: true })),
          effective: data.effective.map(item => ({ functionKey: item.functionKey, source: 'official', promptId: null, auto: false, configured: Boolean(data.official.find(row => row.functionKey === item.functionKey)?.configured), masked: true }))
        });
        const effective = data.effective.map(item => {
          const custom = customizationAllowed && item.promptId ? data.custom.find(row => row.id === item.promptId && row.enabled !== false) : null;
          const official = data.official.find(row => row.functionKey === item.functionKey);
          const customBody = custom ? String(custom.body || '').trim() : '';
          const configured = custom ? Boolean(customBody && !/待系统管理员或租户填写/.test(customBody)) : Boolean(official && official.configured === true);
          return { functionKey: item.functionKey, source: custom ? 'custom' : 'official', promptId: null, auto: Boolean(item.auto), configured, masked: true };
        });
        return sendJson(res, 200, {
          owner: false,
          systemAdmin: false,
          customizationAllowed: Boolean(customizationAllowed),
          custom: [],
          variables: [],
          official: data.official.map(item => ({ ...item, body: '', masked: true })),
          effective
        });
      }
      // 读取对租户全体成员开放（AI重绘弹窗要用管理员保存的模板）；新增/修改仅管理员
      if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'ai_prompt_owner_required', message: '只有该提示词的所有者可以修改或删除它，请用自己的账号操作。' });
      if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const body = await readJsonBody(req, res, 16 * 1024); if (!body) return;
      if (body.id && !UUID_PATTERN.test(String(body.id))) return sendJson(res, 400, { error: 'invalid_ai_prompt_id', message: '未找到要操作的提示词，请刷新列表后重试。' });
      const saved = await aiPromptStore.save(account, body); return sendJson(res, 200, { prompt: { id: saved.id, name: saved.name, functionKey: saved.function_key, body: saved.body, enabled: saved.enabled, officialKey: saved.official_key, officialVersion: saved.official_version } });
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_prompt_failed', message: error.publicCode ? error.message : '提示词保存失败' }); }
  }
  const aiPromptMatch = pathname.match(/^\/api\/integrations\/ai\/prompts\/([0-9a-f-]{36})$/i);
  if (aiPromptMatch && req.method === 'DELETE') {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' }); if (!requireCsrf(req, res)) return;
      if (account.memberType !== 'owner' && !account.isSystemAdmin) return sendJson(res, 403, { error: 'ai_prompt_owner_required', message: '只有该提示词的所有者可以修改或删除它，请用自己的账号操作。' });
    try { if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account); await aiPromptStore.remove(account, aiPromptMatch[1]); return sendJson(res, 200, { removed: true }); }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_prompt_delete_failed', message: error.publicCode ? error.message : '提示词删除失败' }); }
  }
  const aiPromptSelectionMatch = pathname.match(/^\/api\/integrations\/ai\/prompt-selections\/([a-z0-9-]{3,64})$/);
  if (aiPromptSelectionMatch && req.method === 'PUT') {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' }); if (!requireCsrf(req, res)) return;
      if (account.memberType !== 'owner' && !account.isSystemAdmin) return sendJson(res, 403, { error: 'ai_prompt_owner_required', message: '只有该提示词的所有者可以修改或删除它，请用自己的账号操作。' });
    try { if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account); const body = await readJsonBody(req, res, 4 * 1024); if (!body) return; if (body.promptId && !UUID_PATTERN.test(String(body.promptId))) return sendJson(res, 400, { error: 'invalid_ai_prompt_id', message: '未找到要操作的提示词，请刷新列表后重试。' }); await aiPromptStore.select(account, aiPromptSelectionMatch[1], body.promptId || null); return sendJson(res, 200, { saved: true }); }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_prompt_selection_failed', message: error.publicCode ? error.message : '生效提示词保存失败' }); }
  }

  const aiOfficialPromptMatch = pathname.match(/^\/api\/integrations\/ai\/official-prompts\/([a-z0-9-]{3,64})$/);
  if (aiOfficialPromptMatch && req.method === 'PUT') {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' }); if (!requireCsrf(req, res)) return;
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    try {
      const body = await readJsonBody(req, res, 24 * 1024); if (!body) return;
      return sendJson(res, 200, { prompt: await aiPromptStore.saveOfficial(account, aiOfficialPromptMatch[1], body) });
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_official_prompt_save_failed', message: error.publicCode ? error.message : '官方提示词保存失败，请稍后重试。' }); }
  }

  // 系统管理员：设置官方图片提示词是否对所有租户可读（列表内"租户可读"勾选）。
  const aiOfficialReadableMatch = pathname.match(/^\/api\/integrations\/ai\/official-prompts\/([a-z0-9-]{3,64})\/readable$/);
  if (aiOfficialReadableMatch && req.method === 'PUT') {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' }); if (!requireCsrf(req, res)) return;
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    try {
      const body = await readJsonBody(req, res, 2 * 1024); if (!body) return;
      if (typeof body.readable !== 'boolean') return sendJson(res, 400, { error: 'ai_official_readable_invalid', message: '请明确选择"仅本人可见"或"允许其他账号使用"后再保存。' });
      const saved = await aiPromptStore.setOfficialReadable(account, aiOfficialReadableMatch[1], body.readable);
      return sendJson(res, 200, saved);
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_official_readable_failed', message: error.publicCode ? error.message : '官方模板可读设置失败' }); }
  }

  if (pathname === '/api/integrations/ai/grsai/credits' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'ai_configuration_owner_required', message: '只有该配置的所有者可以修改或删除它，请用自己的账号操作。' });
    try {
      if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const listed = await aiConfigStore.list(account);
      const row = listed.rows.find(item => item.template === 'grsai-product' && item.encrypted_api_key);
      if (!row) return sendJson(res, 409, { error: 'ai_configuration_unavailable', message: '请先保存 GRS AI 密钥' });
      return sendJson(res, 200, await aiProvider.getCredits({ configuration: row, apiKey: aiConfig.decrypt(row, CREDENTIALS_KEY) }));
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'grsai_credits_failed', message: error.publicCode ? error.message : 'GRS AI 积分查询失败' });
    }
  }

  if (pathname === '/api/integrations/ai/grsai/models' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'ai_configuration_owner_required', message: '只有该配置的所有者可以修改或删除它，请用自己的账号操作。' });
    try {
      const listed = await aiConfigStore.list(account);
      const rowFor = template => listed.rows.find(item => item.template === template);
      const productRow = rowFor('grsai-product'); const imageRow = rowFor('grsai-image');
      return sendJson(res, 200, {
        baseUrl: aiConfig.GRS_BASE_URL,
        nodeName: '国内节点',
        text: aiConfig.grsaiModels('product').map(item => ({ name: item.name, label: item.label })),
        image: aiConfig.grsaiModels('image').map(item => ({ name: item.name, label: item.label, aspectRatios: item.aspectRatios, pixelSizes: item.pixelSizes || [], imageSizes: item.imageSizes || [], qualities: item.qualities || [], backgrounds: item.backgrounds || [] })),
        selected: {
          product: aiConfig.modelForCapability(productRow?.model, 'name') || '',
          imageTranslation: aiConfig.modelForCapability(imageRow?.model, 'image-translation') || '',
          imageRedraw: aiConfig.modelForCapability(imageRow?.model, 'image-redraw') || ''
        },
        credentialsConfigured: Boolean(productRow?.encrypted_api_key)
      });
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'grsai_models_failed', message: error.publicCode ? error.message : 'GRS AI 模型清单读取失败' });
    }
  }

  if (pathname === '/api/integrations/ai/grsai' && ['POST', 'DELETE'].includes(req.method)) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'ai_configuration_owner_required', message: '只有该配置的所有者可以修改或删除它，请用自己的账号操作。' });
    try {
      if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const listed = await aiConfigStore.list(account);
      const existingFor = template => listed.rows.find(row => row.template === template);
      if (req.method === 'DELETE') {
        const ids = listed.rows.filter(row => String(row.template).startsWith('grsai-')).map(row => row.id);
        await aiConfigStore.removeMany(account, ids);
        return sendJson(res, 200, { removed: true });
      }
      const body = await readJsonBody(req, res, 16 * 1024); if (!body) return;
      const apiKey = String(body.apiKey || '').trim();
      const models = body.models && typeof body.models === 'object' && !Array.isArray(body.models) ? body.models : {};
      const textModel = String(models.product || '').trim();
      const redrawModel = String(models.imageRedraw || '').trim();
      const translationModel = String(models.imageTranslation || '').trim() || redrawModel;
      if (textModel && !aiConfig.grsaiModel('product', textModel)) return sendJson(res, 400, { error: 'invalid_ai_model', message: 'GRS AI 文字模型不在内置官方清单中' });
      for (const candidate of [translationModel, redrawModel]) if (candidate && !aiConfig.grsaiModel('image', candidate)) return sendJson(res, 400, { error: 'invalid_ai_model', message: 'GRS AI 图片模型不在内置官方清单中' });
      const allowSubaccounts = body.allowSubaccounts !== false;
      const existingText = existingFor('grsai-product'); const existingImage = existingFor('grsai-image');
      // 能力分组：未传 groups 时沿用旧一键配置语义（文本+图片均启用）；视频为登记能力，只能随图片通道一起开。
      const groups = body.groups && typeof body.groups === 'object' && !Array.isArray(body.groups) ? body.groups : null;
      const groupFlag = (name, fallback) => (groups ? groups[name] === true : fallback);
      const wantText = groupFlag('text', true);
      const wantImage = groupFlag('image', true);
      const wantVideo = groupFlag('video', Boolean(existingImage?.capabilities?.includes('video-generation')));
      if (!wantText && !wantImage) return sendJson(res, 400, { error: 'invalid_ai_capability_groups', message: '文本、图片至少要勾选一项' });
      if (wantVideo && !wantImage) return sendJson(res, 400, { error: 'invalid_ai_capability_groups', message: '视频能力目前只能随图片通道一起登记，请同时勾选“支持图片”' });
      const configName = String(body.name || '').trim().slice(0, 120);
      const imageModel = models.imageTranslation || models.imageRedraw ? (() => {
        const fallback = aiConfig.template('grsai-image').model.name;
        const redraw = redrawModel || aiConfig.modelForCapability(existingImage?.model, 'image-redraw') || fallback;
        return { name: redraw, 'image-redraw': redraw, 'image-repair': redraw, 'image-translation': translationModel || redraw };
      })() : (existingImage?.model && Object.keys(existingImage.model).length ? existingImage.model : aiConfig.template('grsai-image').model.name);
      const definitions = [];
      if (wantText || existingText) definitions.push({ template: 'grsai-product', name: configName || (existingText?.name || 'GRS AI 商品优化'), model: wantText ? (textModel || aiConfig.modelForCapability(existingText?.model, 'name') || aiConfig.template('grsai-product').model.name) : (existingText?.model || aiConfig.template('grsai-product').model.name), enabled: wantText, supportsVideo: false });
      if (wantImage || existingImage) definitions.push({ template: 'grsai-image', name: configName || (existingImage?.name || 'GRS AI 图片'), model: imageModel, enabled: wantImage, supportsVideo: wantVideo });
      const configs = definitions.map(item => {
        const definition = aiConfig.template(item.template);
        return aiConfig.normalize({ ...definition, name: item.name, template: item.template, model: item.model, apiKey, enabled: item.enabled, supportsVideo: item.supportsVideo, allowSubaccounts }, { key: CREDENTIALS_KEY, tenantId: account.tenantId, ownerUserId: account.userId, existing: existingFor(item.template) });
      });
      const saved = await aiConfigStore.saveMany(account, configs);
      return sendJson(res, 200, { configurations: saved.map(row => aiConfig.redact(row)) });
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'grsai_configuration_failed', message: error.publicCode ? error.message : 'GRS AI 配置保存失败' });
    }
  }

  if (pathname === '/api/integrations/ai/configurations' && ['GET', 'POST'].includes(req.method)) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (req.method === 'POST' && !requireCsrf(req, res)) return;
    try {
      if (req.method === 'GET') {
        const customizationAllowed = STANDALONE_MODE || (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
        const [listed, subaccounts, registrationOverrides] = await Promise.all([aiConfigStore.list(account), aiConfigStore.listSubaccounts(account), aiConfigStore.listPublishedRegistrationOverrides()]);
        const configurations = customizationAllowed ? listed.rows.map(row => aiConfig.redact(row, !listed.isOwner)) : [];
        const covered = group => configurations.some(row => row.enabled && row.credentialsConfigured && row.groups.includes(group));
        const coverage = { text: covered('text'), image: covered('image'), video: covered('video') };
        return sendJson(res, 200, { owner: listed.isOwner, systemAdmin: Boolean(account.isSystemAdmin), standalone: STANDALONE_MODE, customizationAllowed, configurations, coverage, subaccounts: customizationAllowed ? subaccounts : [], registrationOverrides });
      }
      if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'ai_configuration_owner_required' });
      if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const body = await readJsonBody(req, res, STANDALONE_MODE ? 48 * 1024 : 32 * 1024); if (!body) return;
      if (String(body.template || '').startsWith('grsai-')) return sendJson(res, 400, { error: 'grsai_quick_setup_required', message: '请使用 GRS AI 一键配置' });
      if (body.id && !UUID_PATTERN.test(String(body.id))) return sendJson(res, 400, { error: 'invalid_ai_configuration_id', message: '未找到要操作的AI配置，请刷新列表后重试。' });
      const existing = body.id ? await aiConfigStore.getOwner(account, String(body.id)) : null;
      const saved = await aiConfigStore.save(account, aiConfig.normalize(body, { key: CREDENTIALS_KEY, tenantId: account.tenantId, ownerUserId: account.userId, existing, allowCustom: STANDALONE_MODE }));
      return sendJson(res, 200, { configuration: aiConfig.redact(saved) });
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_configuration_failed', message: error.publicCode ? error.message : 'AI 配置保存失败' });
    }
  }

  if (pathname === '/api/system/ai/product-rules' && ['GET', 'POST'].includes(req.method)) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (req.method === 'POST' && !requireCsrf(req, res)) return;
    try {
      if (req.method === 'GET') return sendJson(res, 200, { rules: await aiProductRuleStore.list(account) });
      const body = await readJsonBody(req, res, 96 * 1024); if (!body) return;
      return sendJson(res, 200, { rules: await aiProductRuleStore.saveAll(account, body.rules) });
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_product_rule_failed', message: error.publicCode ? error.message : '商品内容规则读取失败' });
    }
  }

  if (pathname === '/api/system/ai/pricing' && ['GET', 'POST'].includes(req.method)) {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (req.method === 'POST' && !requireCsrf(req, res)) return;
    try {
      if (req.method === 'GET') return sendJson(res, 200, { pricing: await aiPricingStore.getForAdmin(account) }, { 'Cache-Control': 'no-store' });
      const body = await readJsonBody(req, res, 16 * 1024); if (!body) return;
      return sendJson(res, 200, { pricing: await aiPricingStore.save(account, body) }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_pricing_failed', message: error.publicCode ? error.message : 'AI豆价格读取或保存失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/domain/ai-pricing' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    try {
      return sendJson(res, 200, { pricing: await aiPricingStore.current() }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return sendJson(res, 500, { error: 'ai_pricing_read_failed', message: 'AI豆价格读取失败，请稍后刷新页面重试。' }, { 'Cache-Control': 'no-store' });
    }
  }
  const aiRegistrationOverrideMatch = pathname.match(/^\/api\/system\/ai\/registration-overrides\/([a-z0-9-]{3,80})$/);
  if (aiRegistrationOverrideMatch && req.method === 'PUT') {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' }); if (!requireCsrf(req, res)) return;
    if (!account.isSystemAdmin) return sendJson(res, 403, { error: 'system_admin_required', message: '该操作仅限系统管理员，请用系统管理员账号登录后再试。' });
    try { const body = await readJsonBody(req, res, 8 * 1024); if (!body || typeof body.published !== 'boolean') return sendJson(res, 400, { error: 'ai_registration_override_invalid', message: '要改用其他账号的配置，必须先填写覆盖原因。' }); const saved = await aiConfigStore.setRegistrationOverride(account, aiRegistrationOverrideMatch[1], body.invitationUrl, body.published); return sendJson(res, 200, { override: saved }); }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_registration_override_failed', message: error.publicCode ? error.message : '邀请注册链接保存失败' }); }
  }

  const aiConfigurationMatch = pathname.match(/^\/api\/integrations\/ai\/configurations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  if (aiConfigurationMatch && req.method === 'DELETE') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    try { if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      await aiConfigStore.remove(account, aiConfigurationMatch[1]); return sendJson(res, 200, { removed: true }); }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_configuration_delete_failed', message: error.publicCode ? error.message : 'AI 配置删除失败' }); }
  }

  const aiConfigurationEnableMatch = pathname.match(/^\/api\/integrations\/ai\/configurations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/enable$/i);
  if (aiConfigurationEnableMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'ai_configuration_owner_required', message: '只有该配置的所有者可以修改或删除它，请用自己的账号操作。' });
    try {
      if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const body = await readJsonBody(req, res, 4 * 1024); if (!body || typeof body.enabled !== 'boolean') return sendJson(res, 400, { error: 'invalid_ai_enabled_flag', message: '启用状态不正确' });
      const saved = await aiConfigStore.setEnabled(account, aiConfigurationEnableMatch[1], body.enabled);
      return sendJson(res, 200, { configuration: aiConfig.redact(saved) });
    }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_configuration_enable_failed', message: error.publicCode ? error.message : 'AI 配置启用状态保存失败' }); }
  }

  const aiConfigurationTestMatch = pathname.match(/^\/api\/integrations\/ai\/configurations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/test$/i);
  if (aiConfigurationTestMatch && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    try {
      if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const body = await readJsonBody(req, res, 8 * 1024); if (!body) return;
      if (!['connection', 'functional'].includes(body.kind)) return sendJson(res, 400, { error: 'ai_test_kind_invalid', message: '测试类型无效' });
      if (body.kind === 'functional' && body.confirmed !== true) return sendJson(res, 409, { error: 'ai_paid_test_confirmation_required', message: '功能测试可能产生费用，请先明确确认' });
      const row = await aiConfigStore.getOwner(account, aiConfigurationTestMatch[1]);
      const key = aiConfig.decrypt(row, CREDENTIALS_KEY);
      const exchanges = [];
      try {
        const outcome = body.kind === 'functional' ? await aiProvider.functionalTest({ configuration: row, apiKey: key, confirmed: true, trace: exchanges }) : await aiProvider.testConnection({ configuration: row, apiKey: key });
        const saved = await aiConfigStore.markTest(account, row.id, outcome);
        return sendJson(res, 200, { ok: true, kind: body.kind, models: outcome.models || [], credits: outcome.credits === undefined ? null : outcome.credits, exchanges, configuration: aiConfig.redact(saved) });
      } catch (error) {
        const errorCode = error.publicCode || 'ai_provider_unreachable';
        await aiConfigStore.markTest(account, row.id, { ok: false, kind: body.kind, errorCode });
        return sendJson(res, error.status || 502, { error: errorCode, exchanges, message: error.publicCode ? error.message : `AI ${body.kind === 'functional' ? '功能' : '连接'}测试失败：${String(error.code || error.message || '未知错误').slice(0, 200)}` });
      }
    } catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_configuration_test_failed', message: error.publicCode ? error.message : `AI 测试未能发起：${String(error.code || error.message || '未知错误').slice(0, 200)}` }); }
  }

  const aiDefaultMatch = pathname.match(/^\/api\/integrations\/ai\/defaults\/([a-z-]{3,80})$/);
  if (aiDefaultMatch && req.method === 'PUT') {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized' }); if (!requireCsrf(req, res)) return;
    try { if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const body = await readJsonBody(req, res, 8 * 1024); if (!body) return; if (!UUID_PATTERN.test(String(body.configurationId || ''))) return sendJson(res, 400, { error: 'invalid_ai_configuration_id' }); await aiConfigStore.setDefault(account, aiDefaultMatch[1], String(body.configurationId)); return sendJson(res, 200, { saved: true }); }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_default_save_failed', message: error.publicCode ? error.message : 'AI 默认方案保存失败' }); }
  }

  const aiPreferenceMatch = pathname.match(/^\/api\/integrations\/ai\/preferences\/([a-z-]{3,80})$/);
  if (aiPreferenceMatch && req.method === 'PUT') {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized' }); if (!requireCsrf(req, res)) return;
    try { if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const body = await readJsonBody(req, res, 8 * 1024); if (!body) return; if (!UUID_PATTERN.test(String(body.configurationId || ''))) return sendJson(res, 400, { error: 'invalid_ai_configuration_id' }); await aiConfigStore.setPreference(account, aiPreferenceMatch[1], String(body.configurationId)); return sendJson(res, 200, { saved: true }); }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_preference_save_failed', message: error.publicCode ? error.message : 'AI 使用偏好保存失败' }); }
  }

  if (pathname === '/api/integrations/ai/ui-preferences' && (req.method === 'GET' || req.method === 'PUT')) {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    try {
      const customizationAllowed = (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
      if (req.method === 'GET') {
        const preferences = await aiConfigStore.getUiPreferences(account);
        const savedChannel = preferences['billing-channel'] === 'own' || preferences['billing-channel'] === 'official' ? preferences['billing-channel'] : null;
        return sendJson(res, 200, { billingChannel: customizationAllowed ? savedChannel : 'official', customizationAllowed });
      }
      if (!requireCsrf(req, res)) return;
      const body = await readJsonBody(req, res, 4 * 1024); if (!body) return;
      const channel = body.billingChannel === 'own' || body.billingChannel === 'official' ? String(body.billingChannel) : '';
      if (!channel) return sendJson(res, 400, { error: 'invalid_billing_channel', message: '费用通道只能是“官方通道”或“自己的密钥”' });
      if (channel === 'own') if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      await aiConfigStore.setUiPreference(account, 'billing-channel', channel);
      return sendJson(res, 200, { saved: true, billingChannel: channel, customizationAllowed });
    } catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'ai_ui_preference_save_failed', message: error.publicCode ? error.message : '界面偏好保存失败，本次仍可正常使用' }); }
  }

  const aiSubaccountMatch = pathname.match(/^\/api\/integrations\/ai\/subaccounts\/(\d+)$/);
  if (aiSubaccountMatch && req.method === 'PUT') {
    const account = await authenticate(req); if (!account) return sendJson(res, 401, { error: 'unauthorized' }); if (!requireCsrf(req, res)) return;
    try { if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const body = await readJsonBody(req, res, 8 * 1024); if (!body || typeof body.allowed !== 'boolean') return sendJson(res, 400, { error: 'invalid_ai_subaccount_permission' }); await aiConfigStore.setSubaccount(account, aiSubaccountMatch[1], body.allowed, body.capabilities); return sendJson(res, 200, { saved: true }); }
    catch (error) { return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'ai_subaccount_save_failed', message: error.publicCode ? error.message : 'AI 子账号授权保存失败' }); }
  }

  if (pathname === '/api/domain/commands/sku-redraw-selling-points-attempt' && req.method === 'GET') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try {
      const query = new URL(req.url, 'http://' + HOST + ':' + PORT).searchParams;
      const input = {
        clientId: String(query.get('clientId') || ''), productId: String(query.get('productId') || ''), variantRef: String(query.get('variantRef') || '')
      };
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(input.clientId) || !/^(?:\d+|draft_[\w-]+)$/.test(input.productId) || !/^[A-Za-z0-9._:-]{1,180}$/.test(input.variantRef)) return sendJson(res, 400, { error: 'invalid_sku_redraw_attempt_target', message: '未找到这次AI重绘记录，请刷新任务中心后重试。' });
      await authStore.assertSkuImageTarget(account, input);
      const attempt = await authStore.getSkuRedrawSellingPointsAttempt(account, input);
      if (!attempt) return sendJson(res, 200, { state: 'none', attempt: null }, { 'Cache-Control': 'no-store' });
      const summary = {
        requestId: skuRedrawAttemptId(attempt.idempotency_key),
        createdAt: new Date(attempt.created_at).toISOString(), updatedAt: new Date(attempt.updated_at).toISOString()
      };
      if (attempt.status === 'processing') {
        const stale = Date.now() - new Date(attempt.updated_at).getTime() >= SKU_REDRAW_ATTEMPT_MAX_PROCESSING_MS;
        return sendJson(res, 200, stale
          ? { state: 'recovery_required', attempt: summary, error: 'sku_redraw_analysis_recovery_required', message: '卖点解析超过最大请求等待时间，结果无法确认；系统不会自动重发。' }
          : { state: 'processing', attempt: summary, message: '卖点解析正在处理中，系统不会重复调用AI。' }, { 'Cache-Control': 'no-store' });
      }
      const response = attempt.response_body || {};
      const recoveryState = String(response?.recovery?.state || '');
      if (recoveryState === 'unknown') return sendJson(res, 200, { state: 'unknown', attempt: summary, error: 'sku_redraw_analysis_recovery_required', message: '卖点解析结果无法确认，系统不会自动重发。', diagnostic: skuRedrawSafeDiagnostic(response.diagnostic) }, { 'Cache-Control': 'no-store' });
      if (attempt.status === 'failed' || recoveryState === 'failed') {
        const code = typeof response.error === 'string' ? response.error : 'sku_redraw_analysis_failed';
        let message = '卖点解析失败，未修改商品草稿。';
        if (code === 'ai_timeout') message = 'AI 请求超时，结果需要人工恢复确认。';
        else if (code === 'ai_configuration_unavailable') message = '当前商品优化配置不可用。';
        else if (code === 'ai_product_rule_unavailable') message = '系统管理员商品规则不可用。';
        else if (code === 'ai_product_rule_conflict') message = '系统管理员商品规则存在冲突。';
        return sendJson(res, 200, { state: 'failed', attempt: summary, error: code, message, diagnostic: skuRedrawSafeDiagnostic(response.diagnostic) }, { 'Cache-Control': 'no-store' });
      }
      if (attempt.status !== 'completed' || recoveryState !== 'completed' || Number(attempt.response_code) !== 200 || typeof response.sellingPoints !== 'string' || typeof response.analysisProof !== 'string') return sendJson(res, 200, { state: 'recovery_required', attempt: summary, error: 'sku_redraw_analysis_recovery_required', message: '卖点解析记录不完整，不能安全恢复；请重新解析。' }, { 'Cache-Control': 'no-store' });
      const proof = skuImageAnalysisProof.verify(response.analysisProof, account, input, CSRF_SECRET_CONFIG.secret);
      const ruleHash = await skuRedrawRuleHash(aiProductRuleStore);
      if (!proof || skuImageAnalysisProof.digest(response.sellingPoints) !== String(proof.resultHash) || String(ruleHash) !== String(proof.ruleHash)) return sendJson(res, 200, { state: 'recovery_required', attempt: summary, error: 'sku_redraw_analysis_recovery_required', message: '商品范围、卖点或规则已变化，不能安全恢复旧卖点。' }, { 'Cache-Control': 'no-store' });
      return sendJson(res, 200, { state: 'succeeded', attempt: summary, result: { sellingPoints: response.sellingPoints, analysisProof: response.analysisProof, expiresAt: response.expiresAt } }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 500), { error: error.publicCode || 'sku_redraw_attempt_read_failed', message: userErrorText(error, '卖点解析状态读取失败，请刷新页面后重新发起解析。') }, { 'Cache-Control': 'no-store' });
    }
  }

  if (pathname === '/api/domain/commands/product-ai-candidate' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res);
    if (!account) return;
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    let skuRedrawAttempt = null;
    try {
      const rawInput = await readJsonBody(req, res, 96 * 1024);
      const skuRedrawSellingPoints = rawInput?.intent === 'sku_redraw_selling_points';
      const customizationAllowed = (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
      const useOfficial = skuRedrawSellingPoints || !customizationAllowed;
      const input = aiCandidate.request(useOfficial ? { ...rawInput, configurationId: '00000000-0000-4000-8000-000000000000' } : rawInput);
      const row = useOfficial
        ? await aiConfigStore.availableOfficial(account, input.requiredCapabilities)
        : await aiConfigStore.available(account, input.configurationId, input.requiredCapabilities);
      const key = aiConfig.decrypt(row, CREDENTIALS_KEY);
      const capability = input.requiredCapabilities[0];
      const functionKey = capability === 'product-translation' ? (String(input.sourceLanguage || '').toLowerCase().startsWith('en') ? 'product-en-ru' : 'product-zh-ru') : capability === 'selling-point-generation' ? 'selling-points' : 'product-copy';
      if (skuRedrawSellingPoints) {
        const target = rawInput.target || {};
        if (input.mode !== 'optimize-ru' || Object.keys(input.fields).length !== 1 || !input.fields.sellingPoints || !/^[A-Za-z0-9._-]{1,120}$/.test(String(target.clientId)) || !/^(?:\d+|draft_[\w-]+)$/.test(String(target.productId)) || !/^[A-Za-z0-9._:-]{1,180}$/.test(String(target.variantRef)) || !UUID_PATTERN.test(String(target.linkId)) || !Number.isInteger(Number(target.associationVersion))) return sendJson(res, 400, { error: 'invalid_sku_redraw_analysis', message: '卖点解析请求缺少有效的图片目标' });
        const scoped = { clientId: String(target.clientId), productId: String(target.productId), variantRef: String(target.variantRef), linkId: String(target.linkId), associationVersion: Number(target.associationVersion) };
        const productScope = { clientId: scoped.clientId, productId: scoped.productId, variantRef: scoped.variantRef };
        await authStore.assertSkuImageTarget(account, productScope);
        const inputHash = skuImageAnalysisProof.digest(String(input.fields.sellingPoints));
        const sourceHash = inputHash;
        const modelName = aiConfig.modelForCapability(row.model, capability) || '';
        const namespace = 'sku_redraw.selling_points';
        const claimSkuRedraw = async (promptHash, ruleHash) => {
          const requestHash = skuImageAnalysisProof.digest(JSON.stringify({ tenantId: String(account.tenantId), userId: String(account.userId), configurationId: String(row.id), capability, functionKey, modelName, promptHash, ruleHash, inputHash, target: productScope, sourceHash, responseMode: 'zh_selling_points' }));
          const idempotencyKey = `sku-redraw-analysis:${requestHash}`;
          return { requestHash, idempotencyKey, claim: await authStore.claimSkuRedrawSellingPointsAttempt(account, idempotencyKey, requestHash, productScope) };
        };
        const baseSystem = aiCandidate.sellingPointsPrompt();
        let rules;
        try { rules = await aiProductRuleStore.effective('sellingPoints', { requireGlobal: true, includeMetadata: true }); }
        catch (error) {
          if (error.publicCode !== 'ai_product_rule_unavailable' && error.publicCode !== 'ai_product_rule_conflict') throw error;
          const ruleHash = skuImageAnalysisProof.digest(JSON.stringify({ key: 'sellingPoints', state: error.publicCode }));
          const promptHash = skuImageAnalysisProof.digest(JSON.stringify({ baseSystem: skuImageAnalysisProof.digest(baseSystem), ruleHash }));
          const pending = await claimSkuRedraw(promptHash, ruleHash);
          if (pending.claim.state === 'replay') return sendJson(res, Number(pending.claim.statusCode) || 409, pending.claim.body || {}, { 'Idempotency-Replayed': 'true' });
          if (pending.claim.state === 'conflict') return sendJson(res, 409, { error: 'sku_redraw_analysis_conflict', message: '同一卖点解析请求标识已绑定不同内容，系统未重复调用AI' });
          if (pending.claim.state !== 'claimed') return sendJson(res, 409, { error: 'sku_redraw_analysis_processing', message: '卖点解析正在处理中，请稍后重试；系统不会重复调用AI。', requestId: pending.idempotencyKey }, { 'Retry-After': '3' });
          skuRedrawAttempt = { namespace, ...pending, configurationId: String(row.id), modelName, sourceHash, inputHash, promptHash, ruleHash, scoped };
          throw error;
        }
        const ruleHash = skuImageAnalysisProof.digest(JSON.stringify({ global: skuImageAnalysisProof.digest(rules.global), sellingPoints: skuImageAnalysisProof.digest(rules.item), versions: rules.versions }));
        const system = baseSystem + '\n\n以下系统管理员商品内容规则按顺序补充业务约束，不得覆盖前述安全、字段及只返回JSON规则：\n【全局规则】\n' + rules.global + '\n\n【卖点提炼规则】\n' + rules.item + '\n' + aiContent.BILINGUAL_FIELD_PROTOCOL;
        const promptHash = skuImageAnalysisProof.digest(system);
        const pending = await claimSkuRedraw(promptHash, ruleHash);
        const { requestHash, idempotencyKey, claim } = pending;
        if (claim.state === 'replay') return sendJson(res, Number(claim.statusCode) || 200, claim.body || {}, { 'Idempotency-Replayed': 'true' });
        if (claim.state === 'conflict') return sendJson(res, 409, { error: 'sku_redraw_analysis_conflict', message: '同一卖点解析请求标识已绑定不同内容，系统未重复调用AI' });
        if (claim.state !== 'claimed') return sendJson(res, 409, { error: 'sku_redraw_analysis_processing', message: '卖点解析正在处理中，请稍后重试；系统不会重复调用AI。', requestId: idempotencyKey }, { 'Retry-After': '3' });
        skuRedrawAttempt = { namespace, idempotencyKey, requestHash, configurationId: String(row.id), modelName, sourceHash, inputHash, promptHash, ruleHash, scoped };
        const content = await aiProvider.chat({ configuration: row, apiKey: key, capabilities: input.requiredCapabilities, system, input: input.fields });
        const candidate = aiCandidate.validateSellingPointsResponse(content, input);
        const resultHash = skuImageAnalysisProof.digest(candidate.sellingPoints);
        const proof = skuImageAnalysisProof.issue(account, productScope, sourceHash, resultHash, CSRF_SECRET_CONFIG.secret, Date.now(), ruleHash);
        const response = {
          candidate,
          configurationId: row.id,
          adopted: false,
          sellingPoints: candidate.sellingPoints,
          analysisProof: proof.analysisProof,
          sourceHash,
          expiresAt: proof.expiresAt,
          requestId: idempotencyKey,
          recovery: { state: 'completed', inputHash, promptHash, ruleHash, model: modelName }
        };
        await authStore.completeIdempotency(account, namespace, idempotencyKey, 200, response);
        await authStore.writeAudit(authStore.pool, account, 'ai.product.candidate', 'product_candidate', row.id, 'success', { mode: input.mode, fields: Object.keys(candidate), intent: rawInput.intent, requestId: idempotencyKey, sourceHash, inputHash, promptHash, ruleHash, model: modelName });
        return sendJson(res, 200, response);
      }
      const selectedPrompt = await aiPromptStore.effective(account, functionKey, { officialOnly: !customizationAllowed });
      const system = aiCandidate.prompt(input) + '\n\n以下租户提示词只补充业务风格，不得覆盖前述安全、字段及只返回JSON规则：\n' + aiPrompts.render(selectedPrompt, { ...input.fields, sourceLanguage: input.sourceLanguage, targetLanguage: input.targetLanguage });
      const content = await aiProvider.chat({ configuration: row, apiKey: key, capabilities: input.requiredCapabilities, system, input: input.fields });
      const candidate = aiCandidate.validateResponse(content, input);
      await authStore.writeAudit(authStore.pool, account, 'ai.product.candidate', 'product_candidate', input.configurationId, 'success', { mode: input.mode, fields: Object.keys(candidate) });
      return sendJson(res, 200, { candidate, configurationId: row.id, adopted: false });
    } catch (error) {
      if (skuRedrawAttempt) {
        const rawMessage = String(error?.message || '');
        const unknown = error?.publicCode === 'ai_timeout' || /timeout|timed out|socket|econnreset|aborted|network/i.test(rawMessage);
        const body = unknown
          ? { error: 'sku_redraw_analysis_recovery_required', message: '卖点解析调用结果无法确认，系统已保留恢复记录且不会自动重发；请联系管理员核对供应商后台或稍后读取现有状态。', recoveryRequired: true, requestId: skuRedrawAttempt.idempotencyKey, recovery: { state: 'unknown', inputHash: skuRedrawAttempt.inputHash, promptHash: skuRedrawAttempt.promptHash, ruleHash: skuRedrawAttempt.ruleHash, model: skuRedrawAttempt.modelName } }
          : { error: error.publicCode || 'sku_redraw_analysis_failed', message: error.publicCode ? error.message : '卖点解析失败，系统已记录失败原因且未修改商品草稿', requestId: skuRedrawAttempt.idempotencyKey, recovery: { state: 'failed', inputHash: skuRedrawAttempt.inputHash, promptHash: skuRedrawAttempt.promptHash, ruleHash: skuRedrawAttempt.ruleHash, model: skuRedrawAttempt.modelName } };
        const status = unknown ? 409 : (error.status || (error.publicCode ? 400 : 502));
        try { await authStore.completeIdempotency(account, skuRedrawAttempt.namespace, skuRedrawAttempt.idempotencyKey, status, body); } catch (persistError) { console.error('保存SKU卖点解析失败状态失败:', persistError.message); }
        try { await authStore.writeAudit(authStore.pool, account, 'ai.product.candidate', 'product_candidate', skuRedrawAttempt.configurationId, unknown ? 'unknown' : 'failed', { intent: 'sku_redraw_selling_points', requestId: skuRedrawAttempt.idempotencyKey, error: body.error, sourceHash: skuRedrawAttempt.sourceHash, inputHash: skuRedrawAttempt.inputHash, promptHash: skuRedrawAttempt.promptHash, ruleHash: skuRedrawAttempt.ruleHash, model: skuRedrawAttempt.modelName }); } catch (auditError) { console.error('记录SKU卖点解析审计失败:', auditError.message); }
        return sendJson(res, status, body);
      }
      return sendJson(res, error.status || (error.publicCode ? 400 : 502), { error: error.publicCode || 'ai_candidate_failed', message: error.publicCode ? error.message : 'AI 候选生成失败，商品草稿未修改' });
    }
  }

  if (pathname === '/api/domain/commands/product-option-auto-map' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const retryAfter = consumeWindow(aiContentWindows, `${account.tenantId}|${account.userId}|option-auto-map`, 60 * 1000, 10);
    if (retryAfter) return sendJson(res, 429, { error: 'option_mapping_rate_limited', message: '属性映射补全请求过于频繁，请稍后重试' }, { 'Retry-After': String(retryAfter) });
    let diagnosticIds = [];
    try {
      const body = await readJsonBody(req, res, 32 * 1024); if (!body) return;
      const sources = optionEvidence.verify(body.entries, account);
      const terms = sources.map(row => row.raw);
      const translations = {}, missing = [];
      for (const text of terms) {
        const existing = mappedTranslation(text);
        if (existing) translations[text] = existing;
        else missing.push(text);
      }
      let result = { detected: 0, translated: 0, persisted: 0, details: [] };
      if (missing.length) result = await autoMapUnmappedTerms(missing, account, { pool: authStore.pool, writeAudit: authStore.writeAudit.bind(authStore), batchSize: 20, sources, diagnostics: createContentDiagnostics(authStore, privateObjectStore) });
      diagnosticIds = result.diagnosticIds || [];
      const diagnosticsByTerm = result.diagnosticsByTerm || {};
      const diagnosticResponse = { diagnosticIds, diagnosticsByTerm, ...(diagnosticIds.length ? { diagnosticId: diagnosticIds[0] } : {}) };
      const details = Array.isArray(result.details) ? result.details : [];
      const failures = {};
      for (const text of missing) {
        const mapped = mappedTranslation(text);
        const detail = details.find(item => String(item.rawTerm || '') === text);
        const candidate = detail && detail.status !== 'failed' && /[\u3400-\u9fff]/.test(String(detail.chinese || '')) ? String(detail.chinese).trim() : '';
        const translated = mapped || candidate;
        if (translated) translations[text] = translated;
        else failures[text] = detail && detail.error || (result.reason === 'no_ai_config' ? '当前没有可用的商品翻译AI配置' : 'AI未返回可用中文映射');
      }
      if (!Object.keys(translations).length) {
        const message = result.reason === 'no_ai_config' ? '当前没有可用的商品翻译AI配置，公共映射未更新。' : 'AI未返回可用的中文属性映射，公共映射未更新。';
        return sendJson(res, result.reason === 'no_ai_config' ? 409 : 502, { error: result.reason || 'option_mapping_failed', message, failures, ...diagnosticResponse });
      }
      await authStore.recordAudit(account, 'ai.product.option.auto_map', 'product_option_mapping', crypto.createHash('sha256').update(terms.join('\n')).digest('hex').slice(0, 24), 'success', { requested: terms.length, missing: missing.length, persisted: Number(result.persisted || 0), failed: Object.keys(failures).length }).catch(() => { throw Object.assign(new Error('公共映射处理审计保存失败，已有映射可能已写入，请联系系统管理员。'), { publicCode: 'option_mapping_audit_failed', status: 503, diagnosticIds }); });
      const singleText = terms.length === 1 ? translations[terms[0]] || '' : '';
      return sendJson(res, 200, { text: singleText, translations, failures, persisted: Number(result.persisted || 0), ...diagnosticResponse });
    } catch (error) {
      const ids = error.diagnosticIds || diagnosticIds;
      return sendJson(res, error.status || 502, { diagnosticIds: ids, ...(ids.length ? { diagnosticId: ids[0] } : {}), error: error.publicCode || error.code || 'option_mapping_failed', message: error.publicCode ? error.message : '公共属性映射自动补全失败，请稍后重试。' });
    }
  }

  if ((pathname === '/api/domain/product-content-diagnostics' || /^\/api\/domain\/product-content-diagnostics\/[0-9a-f-]{36}$/.test(pathname)) && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { message: '登录状态已失效或未登录，请重新登录后再试。' });
    try {
      const id = pathname === '/api/domain/product-content-diagnostics' ? null : pathname.split('/').pop();
      const detail = await createContentDiagnostics(authStore, privateObjectStore).list(account, id);
      return sendJson(res, 200, detail, { 'Cache-Control': 'no-store' });
    } catch (error) { return sendJson(res, error.status || 503, { message: error.publicCode ? error.message : '商品内容处理记录暂时无法读取，请联系系统管理员。' }, { 'Cache-Control': 'no-store' }); }
  }

  if (pathname === '/api/domain/commands/product-field-translate' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const retryAfter = consumeWindow(aiContentWindows, `${account.tenantId}|${account.userId}|field-translate`, 60 * 1000, 20);
    if (retryAfter) return sendJson(res, 429, { error: 'ai_translation_rate_limited', message: '翻译请求过于频繁，请稍后重试' }, { 'Retry-After': String(retryAfter) });
    let contentRuleAudit = [];
    let contentDiagnostic;
    const diagnosticStore = createContentDiagnostics(authStore, privateObjectStore);
    try {
      const body = await readJsonBody(req, res, 24 * 1024); if (!body) return;
      const translationInput = aiContent.translationRequest(body);
      const text = String(body.text || '').trim();
      const source = String(body.source || '').trim().toLowerCase();
      const target = String(body.target || '').trim().toLowerCase();
      if (!text || text.length > 20000) return sendJson(res, 400, { error: 'invalid_translation_text', message: '当前字段内容为空或超过 20000 字，请缩短后重试。' });
      if (!['zh','ru','en'].includes(source) || !['zh','ru','en'].includes(target) || source === target) return sendJson(res, 400, { error: 'invalid_translation_language', message: '请选择不同的中文、俄文或英文翻译方向。' });
      const functionKey = source === 'ru' && target === 'zh' ? 'product-ru-zh' : source === 'zh' && target === 'ru' ? 'product-zh-ru' : source === 'en' && target === 'ru' ? 'product-en-ru' : '';
      if (!functionKey) return sendJson(res, 400, { error: 'unsupported_translation_direction', message: '当前仅支持中文→俄文、英文→俄文、俄文→中文。' });
      const contentRule = translationInput.fieldKey === 'attribute' ? await aiProductRuleStore.attributeRule() : await aiProductRuleStore.effective(translationInput.fieldKey, { requireGlobal: true, includeMetadata: true, requirePolicy: true });
      contentRuleAudit = aiContent.ruleAuditMetadata({ [translationInput.fieldKey]: contentRule });
      const customizationAllowed = (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
      let row;
      if (customizationAllowed) {
        const listed = await aiConfigStore.list(account);
        const matched = listed.rows.find(item => item.template === 'grsai-product');
        row = STANDALONE_MODE ? await aiConfigStore.availableDefault(account, ['product-translation']) : matched ? await aiConfigStore.available(account, matched.id, ['product-translation']) : await aiConfigStore.availableOfficial(account, ['product-translation']);
      } else row = await aiConfigStore.availableOfficial(account, ['product-translation']);
      const selectedPrompt = await aiPromptStore.effective(account, functionKey, { officialOnly: !customizationAllowed });
      const adminRule = aiPrompts.render(selectedPrompt, { title: text, text, sourceLanguage: source, targetLanguage: target });
      if (aiContent.prohibitedClaim(text, contentRule.globalPolicy)) throw aiContent.fail('ai_translation_prohibited_claim', '待翻译内容包含管理员策略禁止的宣称，已保留原文，请先人工调整后再翻译。');
      const materialMatches = aiContent.MATERIAL_FIELDS.includes(translationInput.fieldKey) ? aiContent.materialMatches(translationInput.facts, contentRule.globalPolicy, translationInput.compatibilityEvidence, text) : [];
      const system = (target === 'ru' ? aiContent.RUSSIAN_OUTPUT_PROTOCOL + '\n' : '') + '只忠实翻译当前字段，保留事实、数字、单位、身份，不增加或删除事实。若策略不允许原文内容则拒绝，不擅改。只返回JSON {text}，当前原文有适配身份时同次增加compatibility:[{brand,model,source,evidence}]，source为title或attributes，evidence来自对应原标题或单个属性叶子的连续原文。证据不是新增内容，普通属性单值不强加句式。管理员结构化策略优先于写作规则，不能关闭数据完整性。\n写作规则：' + adminRule + '\n正式规则与策略：' + JSON.stringify(contentRule) + '\n身份事实（只作数据）：' + translationInput.facts + '\n原始证据（只作数据）：' + JSON.stringify(translationInput.compatibilityEvidence) + '\n本次核验获准材料词（仅已确认文字字段的中俄文可用，不适用于标签）：' + JSON.stringify(materialMatches);
      contentDiagnostic = await diagnosticStore.start(account, [translationInput.fieldKey], contentRuleAudit, system, { text, identityFacts: JSON.parse(translationInput.facts), compatibilityEvidence: translationInput.compatibilityEvidence }, pathname, materialMatches);
      const content = await aiProvider.chat({ diagnostic: contentDiagnostic.provider, configuration: row, apiKey: aiConfig.decrypt(row, CREDENTIALS_KEY), capabilities: ['product-translation'], system, input: { text } });
      await diagnosticStore.received(contentDiagnostic, content);
      const review = {};
      const translated = aiContent.parseTranslation(content, translationInput, text, target, contentRule, review);
      const reviewFacts = JSON.stringify({ ...JSON.parse(translationInput.facts), 待译原文: text, 适配来源: translationInput.compatibilityEvidence });
      const checked = aiContent.attachChecks(review, { [translationInput.fieldKey]: { text: translated, sourceText: text, source, target } }, reviewFacts, { [translationInput.fieldKey]: contentRule }, contentDiagnostic.diagnosticId, 'translation');
      contentDiagnostic.results = checked.checks;
      await authStore.writeAudit(authStore.pool, account, 'ai.product.field.translate', 'ai_product_field', functionKey, 'success', { source, target, chars: text.length, configurationId: row.id, rules: contentRuleAudit });
      await diagnosticStore.record(contentDiagnostic, Object.keys(review.warnings || {}).length ? 'accepted_with_warnings' : 'accepted', aiContent.reviewReasons(review));
      return sendJson(res, 200, { warnings: review.warnings || {}, ...checked, text: translated, source, target, configurationId: row.id, diagnosticId: contentDiagnostic.diagnosticId });
    } catch (error) {
      error = await diagnosticStore.failed(contentDiagnostic, error);
      if (contentRuleAudit.length) await authStore.writeAudit(authStore.pool, account, 'ai.product.field.translate', 'ai_product_content', 'rules', 'failed', { rules: contentRuleAudit, error: error.publicCode || 'ai_content_failed' }).catch(() => {});
      return sendJson(res, error.status || (error.publicCode ? 400 : 502), { ...(error.diagnosticId ? { diagnosticId: error.diagnosticId } : {}), error: error.publicCode || 'ai_translation_failed', message: error.publicCode ? error.message : '当前字段翻译失败，请稍后重试。' });
    }
  }

  if (pathname === '/api/domain/commands/product-content-recheck' && req.method === 'POST') {
    const account = await scopedAccountFor(req, res); if (!account) return;
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有商品内容核对权限，请联系管理员授权。' });
    const diagnosticStore = createContentDiagnostics(authStore, privateObjectStore);
    let contentDiagnostic;
    try {
      const body = await readJsonBody(req, res, 64 * 1024); if (!body) return;
      if (!/^[A-Za-z0-9._-]{1,120}$/.test(String(body.clientId || ''))) throw aiContent.fail('invalid_review_shop', '请选择当前商品店铺后再核对。');
      const allowed = await authStore.listAllowedShops(account);
      if (allowed !== null && !allowed.some(shop => String(shop.externalShopId) === String(body.clientId))) throw aiContent.fail('shop_scope_denied', '该店铺不在你的授权范围内，请重新选择店铺。', 403);
      if (!body.pairs || typeof body.pairs !== 'object' || Array.isArray(body.pairs) || !Object.keys(body.pairs).length || Object.entries(body.pairs).some(([key, pair]) => !aiContent.REVIEW_FIELDS.includes(key) || !pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).some(name => !['zh', 'ru'].includes(name)) || (pair.zh !== undefined && typeof pair.zh !== 'string') || typeof pair.ru !== 'string' || (pair.zh || '').length > 20000 || pair.ru.length > 20000)) throw aiContent.fail('invalid_review_pairs', '请提交当前字段的俄语内容后再核对，中文可不提交。');
      if (body.diagnosticIds !== undefined && (!body.diagnosticIds || typeof body.diagnosticIds !== 'object' || Array.isArray(body.diagnosticIds) || Object.entries(body.diagnosticIds).some(([key, id]) => !Object.hasOwn(body.pairs, key) || typeof id !== 'string' || !UUID_PATTERN.test(id)))) throw aiContent.fail('invalid_review_diagnostic', '原处理记录编号不正确，请重新生成或翻译后再核对。');
      const input = aiContent.request({ facts: body.facts, items: Object.keys(body.pairs), bilingual: true });
      const snapshot = await aiProductRuleStore.rows(undefined, true), rules = {};
      for (const key of input.keys) rules[key] = await aiProductRuleStore.effective(key, { snapshot, requireGlobal: true, includeMetadata: true, requirePolicy: true });
      contentDiagnostic = await diagnosticStore.start(account, input.keys, aiContent.ruleAuditMetadata(rules), '确定性规则复核，未调用模型，未产生模型费用。', { facts: input.rawFacts, pairs: body.pairs }, 'product-content-recheck');
      const parsed = await aiContent.recheckPairs(body.pairs, input.rawFacts, rules, body.diagnosticIds, id => diagnosticStore.list(account, id));
      const checked = aiContent.attachChecks(parsed, Object.fromEntries(Object.entries(body.pairs).map(([key, pair]) => [key, { ru: pair.ru }])), input.rawFacts, rules, contentDiagnostic.diagnosticId, 'ru');
      contentDiagnostic.results = checked.checks;
      contentDiagnostic.input.compatibility = parsed.compatibility || {};
      contentDiagnostic.input.dimensionClaims = parsed.dimensionClaims || {};
      contentDiagnostic.finishedAt = new Date().toISOString();
      await diagnosticStore.record(contentDiagnostic, 'recheck', aiContent.reviewReasons(parsed));
      return sendJson(res, 200, { diagnosticId: contentDiagnostic.diagnosticId, ...checked, candidates: parsed.candidates, translations: parsed.translations, failures: parsed.failures, warnings: parsed.warnings });
    } catch (error) {
      error = await diagnosticStore.failed(contentDiagnostic, error);
      return sendJson(res, error.status || 400, { ...(error.diagnosticId ? { diagnosticId: error.diagnosticId } : {}), error: error.publicCode || 'ai_content_review_failed', message: error.publicCode ? error.message : '商品内容规则核对失败，已保留当前内容，请稍后重试。' });
    }
  }

  if (pathname === '/api/domain/commands/product-content-candidates' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const retryAfter = consumeWindow(aiContentWindows, `${account.tenantId}|${account.userId}`, 60 * 1000, 6);
    if (retryAfter) return sendJson(res, 429, { error: 'ai_content_rate_limited', message: 'AI 生成请求过于频繁，请稍后重试' }, { 'Retry-After': String(retryAfter) });
    let contentRuleAudit = [];
    let contentDiagnostic;
    const diagnosticStore = createContentDiagnostics(authStore, privateObjectStore);
    try {
      const body = await readJsonBody(req, res, 24 * 1024); if (!body) return;
      const input = aiContent.request(body);
      const capabilities = Array.from(new Set(input.keys.map(key => aiContent.ITEMS[key].capability)));
      const customizationAllowed = (STANDALONE_MODE || await authStore.canUseCustomConfigurations(account));
      let row;
      if (customizationAllowed) {
        const listed = await aiConfigStore.list(account);
        const matched = listed.rows.find(item => item.template === 'grsai-product');
        const wanted = String(body.configurationId || '') || (STANDALONE_MODE ? '' : (matched ? matched.id : ''));
        row = wanted ? await aiConfigStore.available(account, wanted, capabilities) : STANDALONE_MODE ? await aiConfigStore.availableDefault(account, capabilities) : await aiConfigStore.availableOfficial(account, capabilities);
      } else row = await aiConfigStore.availableOfficial(account, capabilities);
      const ruleSnapshot = await aiProductRuleStore.rows(undefined, true);
      const rulesByKey = {};
      const usableKeys = [];
      const ruleFailures = {};
      for (const key of input.keys) {
        try { rulesByKey[key] = await aiProductRuleStore.effective(key, { snapshot: ruleSnapshot, requireGlobal: true, includeMetadata: true, requirePolicy: true }); contentRuleAudit = aiContent.ruleAuditMetadata(rulesByKey); usableKeys.push(key); }
        catch (error) { if (error.publicCode !== 'ai_product_rule_unavailable' && error.publicCode !== 'ai_product_rule_conflict') throw error; ruleFailures[key] = { code: error.publicCode, message: error.message }; }
      }
      if (!usableKeys.length) return sendJson(res, 409, { error: 'ai_product_rule_conflict', message: Object.values(ruleFailures)[0].message });
      const usableCapabilities = Array.from(new Set(usableKeys.map(key => aiContent.ITEMS[key].capability)));
      const key = aiConfig.decrypt(row, CREDENTIALS_KEY);
      // 一次请求拿回整份内容；商品编辑页可要求中俄双语，正式字段只采用俄语，中文作为ERP对照。
      const materialMatches = usableKeys.some(item => aiContent.MATERIAL_FIELDS.includes(item)) ? aiContent.materialMatches(input.facts, rulesByKey[usableKeys[0]].globalPolicy) : [];
      const promptItems = usableKeys.map(itemKey => ({ key: itemKey, label: aiContent.ITEMS[itemKey].label, sectionTitle: aiContent.ITEMS[itemKey].label, body: rulesByKey[itemKey].item, policy: rulesByKey[itemKey].policy }));
      const system = input.bilingual
        ? aiContent.promptForBilingual({ global: rulesByKey[usableKeys[0]].global, globalPolicy: rulesByKey[usableKeys[0]].globalPolicy, materialMatches, items: promptItems })
        : aiContent.promptFor({ global: rulesByKey[usableKeys[0]].global, globalPolicy: rulesByKey[usableKeys[0]].globalPolicy, materialMatches, items: promptItems });
      contentDiagnostic = await diagnosticStore.start(account, usableKeys, contentRuleAudit, system, { facts: input.rawFacts }, pathname, materialMatches);
      const content = await aiProvider.chat({ diagnostic: contentDiagnostic.provider, configuration: row, apiKey: key, capabilities: usableCapabilities, system, input: { facts: input.facts } });
      await diagnosticStore.received(contentDiagnostic, content);
      const parsed = input.bilingual
        ? aiContent.parseBilingualResponse(content, usableKeys, rulesByKey, input.rawFacts)
        : aiContent.parseResponse(content, usableKeys, rulesByKey, input.rawFacts);
      await authStore.writeAudit(authStore.pool, account, 'ai.product.content.candidates', 'ai_product_content', row.id, 'success', { items: Object.keys(parsed.candidates), failed: Object.keys(parsed.failures).length, rules: contentRuleAudit, model: aiConfig.modelForCapability(row.model, usableCapabilities[0]) });
      parsed.failures = { ...ruleFailures, ...parsed.failures };
      const pairs = aiContent.responsePairs(content, input.keys, input.bilingual);
      const checked = aiContent.attachChecks(parsed, pairs, input.rawFacts, rulesByKey, contentDiagnostic.diagnosticId, input.bilingual ? 'pair' : 'translation');
      contentDiagnostic.results = checked.checks;
      const diagnosticReasons = aiContent.reviewReasons(parsed);
      const hasFailures = Object.keys(parsed.failures).length;
      await diagnosticStore.record(contentDiagnostic, hasFailures ? (Object.keys(parsed.candidates).length ? 'partial' : 'rejected') : Object.keys(parsed.warnings || {}).length ? 'accepted_with_warnings' : 'accepted', diagnosticReasons);
      return sendJson(res, 200, { diagnosticId: contentDiagnostic.diagnosticId, ...checked, candidates: parsed.candidates, translations: parsed.translations || {}, failures: parsed.failures, warnings: parsed.warnings || {}, configurationId: row.id, generatedAt: new Date().toISOString(), adopted: false });
    } catch (error) {
      error = await diagnosticStore.failed(contentDiagnostic, error);
      if (contentRuleAudit.length) await authStore.writeAudit(authStore.pool, account, 'ai.product.content.candidates', 'ai_product_content', 'rules', 'failed', { rules: contentRuleAudit, error: error.publicCode || 'ai_content_failed' }).catch(() => {});
      return sendJson(res, error.status || (error.publicCode ? 400 : 502), { ...(error.diagnosticId ? { diagnosticId: error.diagnosticId } : {}), error: error.publicCode || 'ai_content_failed', message: error.publicCode ? error.message : 'AI 候选生成失败，未保存任何内容' });
    }
  }

  if (pathname === '/api/domain/commands/ai-prompt-fuse' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
    try {
      const body = await readJsonBody(req, res, 64 * 1024); if (!body) return;
      const template = String(body.template || '').trim();
      if (!template || template.length > 6000) return sendJson(res, 400, { error: 'ai_fuse_template_invalid', message: '主图提示词模板为空或超过 6000 字' });
      const listed = await aiConfigStore.list(account);
      const configured = listed.rows.find(item => item.template === 'grsai-product');
      const row = STANDALONE_MODE ? await aiConfigStore.availableDefault(account, ['title-optimization']) : configured ? await aiConfigStore.available(account, configured.id, ['title-optimization']) : await aiConfigStore.availableOfficial(account, ['title-optimization']);
      const limited = consumeWindow(aiContentWindows, `${account.tenantId}|${account.userId}|fuse`, 60 * 1000, 8);
      if (limited) return sendJson(res, 429, { error: 'ai_content_rate_limited', message: '融合请求过于频繁，请稍后再试' }, { 'Retry-After': String(limited) });
      const slots = Array.from(template.matchAll(/\[([^\]\n]{1,60})\]/g)).map(item => item[1].trim());
      if (!slots.length) return sendJson(res, 200, { prompt: template, unfilled: [], filled: 0, slots: 0 });
      const materials = { 卖点提炼: String(body.sellingPoints || '').trim().slice(0, 4000), 商品标题: String(body.title || '').trim().slice(0, 500), 标签: String(body.tags || '').trim().slice(0, 800), 商品简介: String(body.summary || '').trim().slice(0, 2500), 原始事实: String(body.facts || '').trim().slice(0, 6000) };
      const system = '你是提示词装配员。任务：只把资料填进模板已有的 [方括号占位] 里，占位之外的一字不改。\n规则一：占位含义按名称理解，例如 [卖点文案1] 填第 1 条卖点正文，[图标元素/主题1] 填该卖点最适合做图标的两到六字名词，[商品核心标题文案] 填商品标题。\n规则二：资料里没有依据时，保留原样的占位名并在 unfilled 中回报，禁止编造颜色、数量、尺寸、材质、功效、认证、价格或承诺。\n规则三：只输出一个 JSON 对象，字段为 prompt（完整模板文本）与 unfilled（未填写的占位名数组），不要输出解释或代码块。';
      const content = await aiProvider.chat({ configuration: row, apiKey: aiConfig.decrypt(row, CREDENTIALS_KEY), capabilities: [String(row.capabilities && row.capabilities[0] || 'title-optimization')], system, input: { template, materials } });
      let parsed = null;
      try { parsed = JSON.parse(String(content).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch (error) { parsed = null; }
      if (!parsed || typeof parsed.prompt !== 'string' || !parsed.prompt.trim()) return sendJson(res, 502, { error: 'ai_response_invalid', message: '文字模型没有返回可用的融合结果' });
      const prompt = parsed.prompt.trim();
      const allowedNumbers = new Set(Array.from(aiContent.numbers(template)).concat(Array.from(aiContent.numbers(JSON.stringify(materials)))));
      const invented = Array.from(aiContent.numbers(prompt)).filter(number => !allowedNumbers.has(number));
      if (invented.length) return sendJson(res, 422, { error: 'ai_candidate_facts_changed', message: '融合结果出现资料中没有的数字：' + invented.join('、') + '，已拒绝采用' });
      const skeleton = text => String(text).replace(/\[([^\]\n]{1,60})\]/g, '').replace(/\s+/g, '').replace(/[：:，,。.、；;（）()「」“”"']/g, '');
      const drift = skeleton(prompt) === skeleton(template) ? null : (function () {
        const clean = str => String(str).replace(/\s+/g, ' ').trim();
        return { template: clean(template).slice(0, 160), fused: clean(prompt).slice(0, 160) };
      })();
      const unfilled = Array.isArray(parsed.unfilled) ? parsed.unfilled.map(String).filter(key => slots.indexOf(key) >= 0) : [];
      await authStore.writeAudit(authStore.pool, account, 'ai.prompt.fuse', 'ai_configuration', row.id, 'success', { slots: slots.length, unfilled: unfilled.length, chars: prompt.length, drift: Boolean(drift) });
      return sendJson(res, 200, { prompt, unfilled, filled: slots.length - unfilled.length, slots: slots.length, drift, model: aiConfig.modelForCapability(row.model, 'title-optimization') });
    } catch (error) {
      return sendJson(res, error.status || (error.publicCode ? 400 : 502), { error: error.publicCode || 'ai_prompt_fuse_failed', message: error.publicCode ? error.message : '提示词融合失败：' + String(error.code || error.message || '未知错误').slice(0, 200) });
    }
  }

  if (pathname === '/api/domain/commands/ai-image-generate' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    const limited = consumeWindow(aiContentWindows, `${account.tenantId}|${account.userId}|image`, 5 * 60 * 1000, 4);
    if (limited) return sendJson(res, 429, { error: 'ai_content_rate_limited', message: '生图请求过于频繁，请稍后再试' }, { 'Retry-After': String(limited) });
    try {
      const body = await readJsonBody(req, res, 24 * 1024 * 1024); if (!body) return;
      const prompt = String(body.prompt || '').trim();
      if (!prompt || prompt.length > 8000) return sendJson(res, 400, { error: 'invalid_ai_image_prompt', message: '请先在「图片提示词」填写主图并读取卖点提炼，组合出 1-8000 字的提示词' });
      const images = Array.isArray(body.images) ? body.images.slice(0, 8).map(String) : [];
      if (!images.length) return sendJson(res, 400, { error: 'invalid_ai_reference_images', message: '请先上传至少 1 张参考图' });
      if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      console.log('[ai-image-generate] 收到请求', account.tenantId, '提示词', prompt.length, '字，参考图', images.length, '张');
      const listed = await aiConfigStore.list(account);
      const configured = listed.rows.find(item => item.template === 'grsai-image');
      if (!configured && !STANDALONE_MODE) return sendJson(res, 409, { error: 'ai_configuration_unavailable', message: '请先保存已启用、已通过功能测试且有密钥的 GRS AI 配置' });
      const row = STANDALONE_MODE ? await aiConfigStore.availableDefault(account, ['image-redraw']) : await aiConfigStore.available(account, configured.id, ['image-redraw']);
      const apiKey = aiConfig.decrypt(row, CREDENTIALS_KEY);
      const model = aiConfig.modelForCapability(row.model, 'image-redraw');
      const exchanges = [{ kind: '生图请求', method: 'POST', url: String(row.base_url || '') + (row.protocol === 'openai-image' ? '/images/edits' : '/v1/api/generate'), request: '模型：' + model + '\n参考图：' + images.length + ' 张\n完整提示词：\n' + prompt, status: 0, response: '等待提交…' }];
      const input = { capability: 'image-redraw', image: images[0], prompt: prompt, options: { aspectRatio: String(body.aspectRatio || '1:1') } };
      if (images.length > 1) input.referenceImages = images;
      const started = await aiProvider.generateImage({ configuration: row, apiKey, input });
      exchanges[exchanges.length - 1] = { ...exchanges[exchanges.length - 1], status: started.httpStatus || 200, response: '任务号 ' + (started.taskId || '（直接返回结果）') + '，状态 ' + started.state };
      let outcome = started;
      let waited = 0;
      while (outcome.state !== 'succeeded' && waited < 300000) {
        await new Promise(done => setTimeout(done, 10000));
        waited += 10000;
        if (outcome.state === 'succeeded' || !started.taskId) break;
        outcome = await aiProvider.pollImage({ configuration: row, apiKey, taskId: started.taskId });
        exchanges.push({ kind: '异步查询 #' + Math.round(waited / 10000), method: 'GET', url: String(row.base_url || '') + '/v1/api/result?id=' + started.taskId, request: '任务号 ' + started.taskId, status: 200, response: '状态 ' + outcome.state + (outcome.progress ? '，进度 ' + outcome.progress + '%' : '') + (outcome.resultUrl ? '，已返回图片地址' : '') });
      }
      if (outcome.state !== 'succeeded' || !outcome.resultUrl) {
        return sendJson(res, 504, { error: 'ai_image_result_pending', exchanges, message: waited >= 300000 ? '等待 GRS AI 出图超过 5 分钟，本次未完成（请到 GRS 控制台核对任务，勿直接重试）' : 'GRS AI 本次没有返回可用图片' });
      }
      const downloaded = await aiProvider.downloadImage(outcome.resultUrl);
      exchanges.push({ kind: '候选图下载', method: 'GET', url: outcome.resultUrl.slice(0, 160), request: '', status: 200, response: downloaded.mime + '，' + Math.round(downloaded.buffer.length / 1024) + ' KB，已转回页面显示' });
      await authStore.writeAudit(authStore.pool, account, 'ai.image.generate', 'ai_configuration', row.id, 'success', { model, seconds: Math.round(waited / 1000), promptChars: prompt.length, references: images.length });
      return sendJson(res, 200, { ok: true, exchanges, model, taskId: started.taskId || null, seconds: Math.round(waited / 1000), prompt, imageUrl: 'data:' + downloaded.mime + ';base64,' + downloaded.buffer.toString('base64') });
    } catch (error) {
      const code = error.publicCode || 'ai_image_generate_failed';
      const detail = error.publicCode ? error.message : '生图失败：' + String(error.code || error.message || '未知错误').slice(0, 200);
      console.error('[ai-image-generate] 失败', code, detail.slice(0, 240));
      return sendJson(res, error.status || (error.publicCode ? 400 : 502), { error: code, message: detail });
    }
  }

  if (pathname === '/api/domain/commands/ai-image-task' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!requireCsrf(req, res)) return;
    if (!authStore.hasPermission(account, 'products.write')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try {
      const body = await readJsonBody(req, res, 8 * 1024); if (!body) return;
      const taskId = String(body.taskId || '').trim();
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) return sendJson(res, 400, { error: 'invalid_ai_image_task', message: '任务号格式不正确' });
      if (!STANDALONE_MODE) await authStore.requireAiEditEntitlement(account);
      const listed = await aiConfigStore.list(account);
      const configured = listed.rows.find(item => item.template === 'grsai-image');
      if (!configured && !STANDALONE_MODE) return sendJson(res, 409, { error: 'ai_configuration_unavailable', message: '请先保存已启用、已通过功能测试且有密钥的 GRS AI 配置' });
      const row = STANDALONE_MODE ? await aiConfigStore.availableDefault(account, ['image-redraw']) : await aiConfigStore.available(account, configured.id, ['image-redraw']);
      const outcome = await aiProvider.pollImage({ configuration: row, apiKey: aiConfig.decrypt(row, CREDENTIALS_KEY), taskId });
      if (outcome.state !== 'succeeded' || !outcome.resultUrl) return sendJson(res, 409, { error: 'ai_image_task_not_ready', message: '该任务还没有可用结果（状态：' + outcome.state + (outcome.progress ? '，进度 ' + outcome.progress + '%' : '') + '）' });
      const downloaded = await aiProvider.downloadImage(outcome.resultUrl);
      await authStore.writeAudit(authStore.pool, account, 'ai.image.task.fetch', 'ai_configuration', row.id, 'success', { taskId, kb: Math.round(downloaded.buffer.length / 1024) });
      return sendJson(res, 200, { ok: true, taskId, kb: downloaded.buffer.length / 1024, imageUrl: 'data:' + downloaded.mime + ';base64,' + downloaded.buffer.toString('base64') });
    } catch (error) {
      console.error('[ai-image-task] 失败', error.publicCode || error.code || '', String(error.message || '').slice(0, 200));
      return sendJson(res, error.status || (error.publicCode ? 400 : 502), { error: error.publicCode || 'ai_image_task_failed', message: error.publicCode ? error.message : '取回失败：' + String(error.code || error.message || '未知错误').slice(0, 200) });
    }
  }

  if (pathname === '/api/integrations/ai/status' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (account.memberType !== 'owner') return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有该操作的权限，请联系管理员授权。' });
    try {
      const listed = await aiConfigStore.list(account);
      return sendJson(res, 200, { configured: listed.rows.length > 0, tested: listed.rows.filter(row => row.test_status === 'passed').length, productConfigurations: listed.rows.filter(row => row.section === 'product').length, imageConfigurations: listed.rows.filter(row => row.section === 'image').length });
    } catch (error) { return sendJson(res, error.status || 500, { error: error.publicCode || 'ai_status_failed', message: userErrorText(error, "本次操作未成功，请重试；若仍然失败请联系系统管理员。")}); }
  }

  // 大盘总览：获取缓存数据（需认证）
  if (pathname === '/api/overview' && req.method === 'GET') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!authStore.hasPermission(account, 'selection.read')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有查看选品大盘的权限，请联系管理员授权。' });
    fs.readFile(path.join(DATA_DIR, 'overview.json'), 'utf8', function (err, raw) {
      if (err) return sendJson(res, 200, { source: 'web', last_update: null, period_count: { week: { sales: 0, sales_amount: 0, sales_amount_cny: '0' }, month: { sales: 0, sales_amount: 0, sales_amount_cny: '0' }, quarter: { sales: 0, sales_amount: 0, sales_amount_cny: '0' }, year: { sales: 0, sales_amount: 0, sales_amount_cny: '0' } }, charts: { month_sales: [], brand: [], source: [] } });
      try { sendJson(res, 200, parseJsonStrict(raw)); }
      catch (e) { sendJson(res, 200, { source: 'web', last_update: null, period_count: null, charts: null }); }
    });
    return;
  }

  // 大盘总览：手动同步（需认证，触发后台刷新）
  if (pathname === '/api/overview/sync' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!authStore.hasPermission(account, 'selection.manage') && !authStore.hasPermission(account, 'sync.run')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有更新选品大盘的权限，请联系管理员授权。' });
    if (!requireCsrf(req, res)) return;
    const started = runOverviewSync(function (err, stdout, stderr) {
      if (err) { console.error('sync error:', err.message); return; }
      console.log('sync stdout:', String(stdout || '').slice(0, 500));
      if (stderr) console.error('sync stderr:', String(stderr || '').slice(0, 500));
    });
    return sendJson(res, started ? 202 : 200, { ok: true, message: started ? '同步任务已启动，请稍后刷新页面查看' : '同步任务已在执行中，请稍后刷新页面查看' });
  }

  // 大盘总览：手动导入数据（需认证）
  if (pathname === '/api/overview/import' && req.method === 'POST') {
    const account = await authenticate(req);
    if (!account) return sendJson(res, 401, { error: 'unauthorized', message: '登录状态已失效或未登录，请重新登录后再试。' });
    if (!authStore.hasPermission(account, 'selection.manage') && !authStore.hasPermission(account, 'overview.import')) return sendJson(res, 403, { error: 'permission_denied', message: '当前账号没有导入选品大盘数据的权限，请联系管理员授权。' });
    if (!requireCsrf(req, res)) return;
    const declaredSize = Number(req.headers['content-length'] || 0);
    if (declaredSize > 4 * 1024 * 1024) return sendJson(res, 413, { error: 'overview_import_too_large', message: '概览导入文件过大，请减少数据量后分批导入。' });
    const body = await readJsonBody(req, res, 4 * 1024 * 1024);
    if (!body) return;
    if (typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'overview_import_invalid', message: '概览导入内容格式不正确，请重新导出后再导入。' });
    if (overviewSyncTask.isRunning()) return sendJson(res, 409, { error: 'overview_sync_in_progress', message: '经营概览同步正在运行，请完成后再导入。' }, { 'Retry-After': '10' });
    try { saveJson(path.join(DATA_DIR, 'overview.json'), body); sendJson(res, 200, { ok: true }); }
    catch (e) {
      console.error('导入大盘数据失败:', e.message);
      sendJson(res, 500, { error: 'overview_import_failed', message: '概览数据导入失败，服务端已记录原因，请稍后重试。' });
    }
    return;
  }
  sendJson(res, 404, { error: 'not found', message: '未找到请求的页面内容，请刷新页面后重试。' });
}

function productEditCall(dataAccount, target) {
  const call = async (endpoint, body) => {
        const actor = await authStore.productEditActor(dataAccount.tenantId, dataAccount.userId);
        const scope = actor && await authStore.listAllowedShops(actor);
        if (!actor || !actor.enabled || !authStore.hasPermission(actor, 'products.write') || scope !== null && !scope.some(shop => String(shop.externalShopId) === target.clientId)) {
          throw productEdit.problem('shop_scope_denied', '操作账号或店铺授权已失效', 403);
        }
        const retryAfter = consumeOzonRateLimit(dataAccount, target.clientId);
        if (retryAfter) throw productEdit.problem('ozon_proxy_rate_limited', '请求过于频繁，请稍后查询结果', 429);
        const document = await authStore.getDocument(dataAccount, 'erp_shops_data');
        const shops = document ? decryptShopCredentials(document.payload, CREDENTIALS_KEY, dataAccount.tenantId) : [];
        const shop = Array.isArray(shops) && shops.find(item => String(item.clientId) === target.clientId);
        if (!shop || !shop.apiKey) throw productEdit.problem('shop_credentials_not_found', '店铺接口凭据不可用', 404);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(OZON_API_BASE_URL + endpoint, { method: 'POST', signal: controller.signal,
            headers: { 'Client-Id': target.clientId, 'Api-Key': String(shop.apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
          const chunks = []; let size = 0;
          for await (const chunk of response.body) { size += chunk.length; if (size > 10 * 1024 * 1024) throw new Error('Ozon 返回内容超过允许大小，请缩小查询范围后重试。'); chunks.push(Buffer.from(chunk)); }
          const text = Buffer.concat(chunks).toString('utf8');
          if (!response.ok) throw Object.assign(productEdit.problem('ozon_request_failed', 'Ozon 返回 HTTP ' + response.status, 502), { definiteRejection: response.status >= 400 && response.status < 500 });
          return JSON.parse(text);
        } catch (error) {
          if (error.publicCode) throw error;
          throw productEdit.problem('ozon_transport_failed', 'Ozon 网络或响应异常，请查询处理结果', 502);
        } finally { clearTimeout(timer); }
      };
  call.findVerifiedOption = (request, valueId) => optionEvidence.find(dataAccount, target.clientId, request, valueId);
  return call;
}

async function publishSkuImagesForOzon(items) {
  if (!Array.isArray(items) || !items.length) throw productEdit.problem('sku_image_sync_empty', '没有可提交到 Ozon 的图片，请重新打开图片编辑后保存', 409);
  return items.map(item => skuImagePublisher.sign(item).url);
}

const server = http.createServer(async (req, res) => {
  const requestStartedAt = Date.now();
  const requestId = crypto.randomUUID();
  const requestPath = String(req.url || '').split('?')[0].slice(0, 300) || '/';
  res.setHeader('X-Request-ID', requestId);
  res.once('finish', () => {
    const durationMs = Date.now() - requestStartedAt;
    if (durationMs >= 500 || res.statusCode >= 400) {
      const diagnostic = `[HTTP诊断] 请求=${requestId} 方法=${String(req.method || '')} 路径=${requestPath} 状态=${res.statusCode} 耗时=${durationMs}ms`;
      console.warn(diagnostic);
      runtimeDiagnostic(res.statusCode >= 500 ? 'ERROR' : 'WARN', diagnostic);
    }
  });
  try {
    const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/health/live') {
      return sendJson(res, 200, { status: 'ok', ...appVersionPayload() }, { 'Cache-Control': 'no-store' });
    }
    if (req.method === 'GET' && pathname === '/health/ready') {
      try {
        await authStore.healthcheck();
        return sendJson(res, 200, { status: 'ready', ...appVersionPayload() }, { 'Cache-Control': 'no-store' });
      } catch (error) {
        return sendJson(res, 503, { status: 'unavailable', ...appVersionPayload() }, { 'Cache-Control': 'no-store' });
      }
    }
    if (!servesBusinessRequests(ERP_NODE_ROLE)) {
      return sendJson(res, 503, { error: 'worker_only', message: '后台任务节点不对外提供业务请求。' }, { 'Cache-Control': 'no-store' });
    }
    const publishedSkuImageMatch = pathname.match(/^\/public\/sku-images\/([0-9a-f-]{36})$/i);
    if (req.method === 'GET' && publishedSkuImageMatch) {
      const item = await authStore.getPublishedSkuImageObject(publishedSkuImageMatch[1]);
      if (!item || !skuImagePublisher.verify(item, url.searchParams.get('exp'), url.searchParams.get('sig'))) {
        return sendJson(res, 403, { error: 'sku_image_publish_link_invalid', message: '图片临时访问链接无效或已过期。' }, { 'Cache-Control': 'no-store' });
      }
      const body = await privateObjectStore.readEncryptedBuffer(item.private_object_key);
      if (body.length !== Number(item.size_bytes) || crypto.createHash('sha256').update(body).digest('hex') !== String(item.sha256)) {
        return sendJson(res, 409, { error: 'sku_image_integrity_failed', message: '图片完整性校验失败，无法提供给平台读取。' }, { 'Cache-Control': 'no-store' });
      }
      const headers = securityHeaders();
      delete headers['Content-Security-Policy'];
      res.writeHead(200, Object.assign(headers, { 'Content-Type': item.mime_type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }));
      res.end(body);
      return;
    }
    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
      return;
    }
    if (req.method === 'GET') return await serveStatic(req, res, pathname);
    sendJson(res, 405, { error: 'method not allowed', message: '该请求方式不被支持，请刷新页面后重试。' });
  } catch (error) {
    const diagnostic = `[HTTP异常] 请求=${requestId} 方法=${String(req.method || '')} 路径=${requestPath} 原因=${String(error && error.message || '未知错误').slice(0, 1200)}`;
    console.error(diagnostic);
    runtimeDiagnostic('ERROR', diagnostic);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message: '服务器内部错误，本次操作未完成，请稍后重试或联系管理员。' });
    else if (!res.writableEnded) res.end();
  }
});

validateRuntimeConfig();
authStore = new PostgresAuthStore({
  sessionAbsoluteMs: SESSION_ABSOLUTE_MS,
  sessionIdleMs: SESSION_IDLE_MS,
  csrfSecret: CSRF_SECRET_CONFIG.secret
});
aiConfigStore = createAiConfigStore(authStore.pool, authStore.writeAudit.bind(authStore), { standaloneMode: STANDALONE_MODE });
aiBeanStore = createAiBeanStore(authStore.pool);
aiPricingStore = createAiPricingStore(authStore.pool, authStore.writeAudit.bind(authStore));
skuImageAiEnqueuer = createSkuImageAiEnqueuer({ authStore, aiBeanStore, imageCostBean: () => aiPricingStore.effective('image'), createJobId: createSkuImageJobId });
aiPromptStore = createAiPromptStore(authStore.pool, authStore.writeAudit.bind(authStore));
aiProductRuleStore = createAiProductRuleStore(authStore.pool, authStore.writeAudit.bind(authStore));
ozonShopScheduler = createOzonShopScheduler({ maxConcurrent: 2 });
productEditQueue = createProductEditQueue({ store: authStore, callFor: productEditCall, imagePublisher: publishSkuImagesForOzon, shopScheduler: ozonShopScheduler, onError: error => console.error('商品编辑队列暂时异常:', error.publicCode || 'storage_unavailable') });
productCreateQueue = createProductCreateQueue({ store: authStore, callFor: productEditCall, shopScheduler: ozonShopScheduler, onError: error => console.error('商品新增队列暂时异常:', error.publicCode || 'storage_unavailable') });
apiMonitor = createApiMonitor({
  stateFile: path.join(DATA_DIR, 'system', 'api-monitor.json'),
  localOrigin: 'http://127.0.0.1:' + (ERP_NODE_ROLE === 'worker' ? (process.env.ERP_CLUSTER_ENTRY_PORT || PORT) : PORT),
  mailer: bugMailer, taskStore: authStore, getAdminAccount: getSystemAdminMonitorAccount
});
userSecurityMonitor = createUserSecurityMonitor({
  pool: authStore.pool, taskStore: authStore, mailer: bugMailer, deviceSecret: CSRF_SECRET_CONFIG.secret
});
persistentBackgroundWorker = createPersistentBackgroundWorker({
  store: authStore,
  handlers: { bug_email: sendPersistedBugEmail, category_attributes: runPersistedCategoryAttributes, shops_sync: runPersistedShopSync, products_sync: runPersistedProductSync, orders_sync: runPersistedOrderSync, sku_image_ai: runPersistedSkuImageAi },
  onError: (error, job) => console.error('持久后台任务失败:', job && job.type || 'worker', error && (error.publicCode || error.message) || 'unknown')
});
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(TENANTS_DIR, { recursive: true });
fs.mkdirSync(LOGISTICS_TARIFF_DIR, { recursive: true });
if (RUN_BACKGROUND_JOBS) {
  setInterval(cleanupExpiredSessions, 15 * 60 * 1000).unref();
  setTimeout(expireUnusedActivationCodes, 5000).unref();
  setInterval(expireUnusedActivationCodes, 60 * 1000).unref();
  setTimeout(reconcileMembershipPeriods, 10000).unref();
  setInterval(reconcileMembershipPeriods, 60 * 1000).unref();
  setTimeout(reconcileAgentMonthlySales, 60 * 1000).unref();
  setInterval(reconcileAgentMonthlySales, 5 * 60 * 1000).unref();
  setTimeout(reconcileAgentFinancialControls, 75 * 1000).unref();
  setInterval(reconcileAgentFinancialControls, 5 * 60 * 1000).unref();
  setTimeout(cleanupBackgroundJobs, 30000).unref();
  setInterval(cleanupBackgroundJobs, 6 * 60 * 60 * 1000).unref();
  setTimeout(cleanupExpiredProductDrafts, 2 * 60 * 1000).unref();
  setInterval(cleanupExpiredProductDrafts, 60 * 60 * 1000).unref();
  setInterval(() => userSecurityMonitor.autoUnfreeze().catch(error => console.error('用户安全自动解封失败:', error.message)), 5 * 60 * 1000).unref();
  setInterval(() => userSecurityMonitor.cleanup(), 5 * 60 * 1000).unref();
}
setInterval(cleanupLoginFailures, LOGIN_WINDOW_MS).unref();
setInterval(cleanupAuthAbuseControls, 60000).unref();
setInterval(cleanupOzonRateLimits, 60000).unref();
setInterval(sampleRuntimeContention, 30000).unref();
// 私有对象存储配置检查：开发环境仅警告（图片接口会 503），正式环境缺失密钥直接拒绝启动
if (!privateObjectStore.encryptionAvailable()) {
  const storageMessage = '[sku-image] 私有对象加密密钥未就绪（配置 ERP_PRIVATE_OBJECT_KEY 或 ERP_PRIVATE_OBJECT_KEY_FILE，start.ps1 已自动设置）';
  if (IS_PRODUCTION) throw new Error(storageMessage);
  console.warn(storageMessage + '；图片上传/处理接口将返回 503');
}
authStore.healthcheck().then(() => {
  server.listen(PORT, HOST, () => {
    console.log('网研ERP ' + APP_VERSION.displayVersion);
    console.log('网研ERP 数据服务已启动: http://' + HOST + ':' + PORT);
    console.log('身份与权限存储: PostgreSQL');
reportPrivateObjectStore();
    console.log('租户数据目录: ' + TENANTS_DIR);
    if (RUN_BACKGROUND_JOBS) {
      productEditQueue.start();
      productCreateQueue.start();
      // 单实例旧模式保留8765/production门禁；显式worker节点负责唯一后台任务。
      if (ERP_NODE_ROLE === 'worker' || process.env.NODE_ENV === 'production' || PORT === 8765) persistentBackgroundWorker.start();
      if (ERP_NODE_ROLE === 'worker' || process.env.NODE_ENV === 'production' || PORT === 8765) {
        setTimeout(cleanupStaleSkuAiCandidates, 90 * 1000).unref();
        setInterval(cleanupStaleSkuAiCandidates, 24 * 60 * 60 * 1000).unref();
      }
      refreshGlobalCnyRubRate();
      setInterval(refreshGlobalCnyRubRate, 5 * 60 * 1000).unref();
      console.log('全部自动订单处理已暂停；订单页手动同步入口继续可用。');
      // Standalone mode never runs the SaaS overview auto refresh.
      if (!STANDALONE_MODE) {
        maybeAutoSyncOverview();
        setInterval(maybeAutoSyncOverview, 6 * 60 * 60 * 1000).unref();
      }
      if (process.env.NODE_ENV !== 'test' || process.env.ERP_API_MONITOR_AUTOSTART === '1') {
        setTimeout(() => apiMonitor.tick().catch(error => console.error('接口监控启动检测失败:', error.message)), 10000).unref();
        setInterval(() => apiMonitor.tick().catch(error => console.error('接口监控定时检测失败:', error.message)), 60 * 1000).unref();
      }
    }
  });
}).catch(error => {
  console.error('PostgreSQL 连接失败:', error.message);
  process.exitCode = 1;
});

async function shutdown() {
  if (persistentBackgroundWorker) persistentBackgroundWorker.stop();
  server.close(async () => {
    await Promise.all([productEditQueue.stop(), productCreateQueue.stop()]);
    await authStore.close().catch(() => {});
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);