'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 10;
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

const INTERNAL_APIS = [
  ['GET', '/health/live', '服务进程存活检查'], ['GET', '/health/ready', '服务与 PostgreSQL 就绪检查'],
  ['GET', '/api/auth/captcha', '获取系统管理员图形验证码'], ['POST', '/api/auth/email/send', '发送普通用户注册邮箱验证码'], ['POST', '/api/auth/register', '邮箱验证码注册主账号和租户'],
  ['POST', '/api/auth/login', '普通用户邮箱密码登录或系统管理员账号登录'], ['POST', '/api/auth/login/verify', '首次、新设备或自动异常邮箱二次验证'],
  ['POST', '/api/auth/recovery/send', '发送忘记密码登录验证码'], ['POST', '/api/auth/recovery/login', '忘记密码邮箱验证码登录'], ['GET', '/api/auth/me', '读取当前登录账号'], ['POST', '/api/auth/logout', '退出当前会话'],
  ['POST', '/api/auth/password', '修改当前账号密码'], ['POST', '/api/auth/logout-all', '撤销账号全部会话'],
  ['GET', '/api/sync-tasks', '查询任务中心记录'], ['POST', '/api/sync-tasks', '新增或更新同步任务'],
  ['GET', '/api/tenant/members', '查询租户子账号'], ['POST', '/api/tenant/members', '创建租户子账号'],
  ['GET', '/api/tenant/permissions', '查询权限列表'], ['GET', '/api/tenant/audit', '查询审计日志'], ['GET', '/api/tenant/audit/export', '导出审计日志'],
  ['GET', '/api/tenant/shops', '查询租户店铺'], ['POST', '/api/tenant/members/:id/status', '启用或停用子账号'],
  ['POST', '/api/tenant/members/:id/permissions', '配置子账号权限'], ['POST', '/api/integrations/ozon/commands', '执行服务端 Ozon 领域命令'],
  ['POST', '/api/source-categories/match', '匹配 1688 货源类目或返回待核对候选'],
  ['POST', '/api/product-category-mappings/match', '批量匹配货源商品到Ozon三级类目'],
  ['POST', '/api/product-category-mappings/feedback', '保存人工类目修正并形成租户训练样本'],
  ['POST', '/api/domain/commands/source-boundary', '事务化维护订单与商品货源边界'],
  ['POST', '/api/domain/commands/finance-settings', '事务化更新汇率与贴单费设置'],
  ['GET', '/api/exchange-rates/cny-rub', '读取当天人民币兑卢布官方汇率'],
  ['POST', '/api/category-attributes/sync', '启动三级类目属性同步'], ['GET', '/api/category-attributes/status', '查询类目属性同步状态'],
  ['GET', '/api/category-attributes/category', '按三级类目读取必填和可选属性'], ['GET', '/api/system/tenants', '系统管理员查询全部租户'],
  ['GET', '/api/system/api-monitor', '系统管理员查询接口列表与检测状态'], ['POST', '/api/system/api-monitor/check', '系统管理员手动启动全量接口检测'],
  ['GET', '/api/system/queue-metrics', '系统管理员查询后台队列聚合指标'],
  ['POST', '/api/system/clear-page-data', '系统管理员清理页面同步数据'], ['GET/PATCH', '/api/pricing-settings', '读取或保存租户定价设置'], ['GET', '/api/logistics-configs', '查询物流资费表版本'],
  ['POST', '/api/logistics-configs', '上传并解析物流资费表'], ['POST', '/api/logistics-preferences', '保存默认物流偏好'],
  ['POST', '/api/logistics-plan-profiles', '保存物流方案和子账号绑定'], ['POST', '/api/logistics-configs/:id/activate', '启用物流表版本'],
  ['GET', '/api/logistics-configs/:id/file', '下载物流资费表原文件'], ['POST', '/api/bug-attachments', '上传 BUG 图片或视频'],
  ['POST', '/api/bug-reports/notify', '发送 BUG 邮件通知'], ['GET', '/api/bug-attachments/:report/:file', '读取 BUG 附件'],
  ['GET/POST/DELETE', '/api/data/:key', '读写或删除租户业务文档'], ['GET', '/api/notices', '读取系统版本公告'],
  ['GET', '/api/integrations/1688/status', '查询 1688 接入状态'], ['GET', '/api/integrations/ai/status', '查询 AI 服务配置状态'],
  ['PUT', '/api/integrations/ai/official-prompts/:key', '系统管理员维护官方图片提示词正文'], ['PUT', '/api/integrations/ai/official-prompts/:key/readable', '系统管理员设置官方图片提示词租户可读状态'],
  ['GET', '/api/overview', '读取大盘总览缓存'], ['POST', '/api/overview/sync', '同步大盘总览'], ['POST', '/api/overview/import', '导入大盘总览数据'],
  ['POST', '/api/shop-analysis/seerfar', '按店铺分页读取Seerfar近30天分析数据并结算AI豆']
];

function internalApiPurpose(endpoint) {
  if (endpoint.startsWith('/api/domain/commands/sku-image') || endpoint.startsWith('/api/domain/queries/sku-image')) return 'SKU图片编辑与AI处理接口';
  if (endpoint.startsWith('/api/domain/commands/product-') || endpoint.startsWith('/api/domain/queries/product-') || endpoint.startsWith('/api/domain/product-content')) return '商品领域业务接口';
  if (endpoint.startsWith('/api/integrations/ai/') || endpoint.startsWith('/api/domain/commands/ai-')) return 'AI服务与模型集成接口';
  if (endpoint.startsWith('/api/domain/ai-beans/') || endpoint.startsWith('/api/system/ai-beans/')) return 'AI豆账户与流水接口';
  if (endpoint.startsWith('/api/membership/') || endpoint.startsWith('/api/system/membership-')) return '会员与权益接口';
  if (endpoint.startsWith('/api/agent/') || endpoint.startsWith('/api/system/agent')) return '代理商业务接口';
  if (endpoint.startsWith('/api/auth/profile')) return '账号资料与邮箱接口';
  if (endpoint.startsWith('/api/system/')) return '系统管理员接口';
  if (endpoint.startsWith('/api/orders/')) return '订单同步接口';
  if (endpoint.startsWith('/api/products/')) return '商品同步接口';
  if (endpoint.startsWith('/api/shops/')) return '店铺同步与连接测试接口';
  if (endpoint.startsWith('/api/integrations/ozon/')) return 'Ozon集成接口';
  if (endpoint.startsWith('/api/integrations/seerfar/')) return 'Seerfar数据接口';
  if (endpoint.startsWith('/api/notifications')) return '系统通知接口';
  if (endpoint.startsWith('/api/payment-evidence')) return '付款凭证接口';
  return '网研ERP内部业务接口';
}

const REGISTERED_INTERNAL_APIS = [
  ['GET/POST', '/api/agent/activation-codes'],
  ['GET/POST', '/api/agent/application'],
  ['GET', '/api/agent/overview'],
  ['GET/POST', '/api/auth/profile'],
  ['GET/POST', '/api/auth/profile/avatar'],
  ['POST', '/api/auth/profile/email/confirm'],
  ['POST', '/api/auth/profile/email/send'],
  ['GET', '/api/category-attributes/catalog'],
  ['GET', '/api/domain/ai-beans/balance'],
  ['GET', '/api/domain/ai-beans/events'],
  ['GET', '/api/domain/ai-pricing'],
  ['POST', '/api/domain/commands/ai-image-generate'],
  ['POST', '/api/domain/commands/ai-image-task'],
  ['POST', '/api/domain/commands/ai-prompt-fuse'],
  ['POST', '/api/domain/commands/business-rows'],
  ['POST', '/api/domain/commands/collection-source'],
  ['POST', '/api/domain/commands/product-ai-candidate'],
  ['POST', '/api/domain/commands/product-content-candidates'],
  ['POST', '/api/domain/commands/product-content-recheck'],
  ['GET/POST', '/api/domain/commands/product-create'],
  ['GET/POST', '/api/domain/commands/product-edit'],
  ['POST', '/api/domain/commands/product-video-compose'],
  ['DELETE', '/api/domain/commands/product-video-compose/:videoId'],
  ['POST', '/api/domain/commands/combination-reference-image'],
  ['POST', '/api/domain/commands/product-field-translate'],
  ['POST', '/api/domain/commands/product-option-auto-map'],
  ['POST', '/api/domain/commands/sku-image-ai'],
  ['POST', '/api/domain/commands/sku-image-ai-adopt'],
  ['POST', '/api/domain/commands/sku-image-ai-batch'],
  ['GET', '/api/domain/commands/sku-image-ai-prompt-details'],
  ['GET/POST', '/api/domain/commands/sku-image-candidates'],
  ['POST', '/api/domain/commands/sku-image-copy'],
  ['GET', '/api/domain/commands/sku-image-download'],
  ['POST', '/api/domain/commands/sku-image-download-external'],
  ['POST', '/api/domain/commands/sku-image-import'],
  ['GET/POST', '/api/domain/commands/sku-image-links'],
  ['POST', '/api/domain/commands/sku-image-process'],
  ['POST', '/api/domain/commands/sku-image-upload'],
  ['POST', '/api/domain/commands/sku-image-upload-ticket'],
  ['POST', '/api/domain/queries/sku-image-links'],
  ['GET/POST', '/api/domain/commands/sku-redraw-selling-points-attempt'],
  ['GET', '/api/domain/product-content-diagnostics'],
  ['GET', '/api/domain/queries/collection-sources'],
  ['GET', '/api/domain/queries/product-combinations'],
  ['POST', '/api/domain/queries/online-product-costs'],
  ['GET', '/api/domain/queries/product-listing-records'],
  ['GET', '/api/domain/queries/product-video-compose'],
  ['GET', '/api/domain/queries/sku-image-collection-sources'],
  ['GET', '/api/private-objects/product-videos/:videoId'],
  ['GET', '/api/private-objects/combination-references/:imageId'],
  ['GET/POST', '/api/integrations/ai/configurations'],
  ['DELETE/POST', '/api/integrations/ai/grsai'],
  ['GET', '/api/integrations/ai/grsai/credits'],
  ['GET', '/api/integrations/ai/grsai/models'],
  ['GET/POST', '/api/integrations/ai/prompts'],
  ['GET', '/api/integrations/ai/ui-preferences'],
  ['GET/POST', '/api/integrations/ozon/cookie-bindings'],
  ['POST', '/api/integrations/seerfar/ozon/product'],
  ['POST', '/api/membership/activate'],
  ['GET', '/api/membership/activation-records'],
  ['GET', '/api/membership/current'],
  ['GET', '/api/membership/devices'],
  ['GET', '/api/membership/plans'],
  ['GET', '/api/membership/referral'],
  ['GET', '/api/notifications'],
  ['POST', '/api/notifications/read-all'],
  ['GET/POST', '/api/order-advertising'],
  ['POST', '/api/orders/sync'],
  ['POST', '/api/orders/sync/cancel'],
  ['POST', '/api/payment-evidence'],
  ['POST', '/api/products/sync'],
  ['POST', '/api/shops/sync'],
  ['POST', '/api/shops/test-connection'],
  ['GET/POST', '/api/system/activation-codes'],
  ['GET', '/api/system/agent-activation-codes'],
  ['GET', '/api/system/agents'],
  ['POST', '/api/system/agents/assign'],
  ['GET', '/api/system/ai-beans/account'],
  ['POST', '/api/system/ai-beans/adjust'],
  ['GET', '/api/system/ai-beans/events'],
  ['POST', '/api/system/ai-beans/recharge'],
  ['GET/POST', '/api/system/ai/pricing'],
  ['GET/POST', '/api/system/ai/product-rules'],
  ['GET', '/api/system/contracts'],
  ['POST', '/api/system/contracts/agent-version'],
  ['GET', '/api/system/frontend-version'],
  ['GET/POST', '/api/system/membership-campaigns'],
  ['GET', '/api/system/membership-payments'],
  ['GET', '/api/system/payment-evidence'],
  ['GET', '/api/system/user-monitor']
].map(row => [row[0], row[1], internalApiPurpose(row[1])]);

const OZON_APIS = [
  ['/v4/product/info/limit', '查询商品创建和更新额度'], ['/v1/roles', '查询店铺 API Key 角色权限'],
  ['/v2/warehouse/list', '查询店铺仓库'], ['/v2/delivery-method/list', '查询仓库配送方式'],
  ['/v1/description-category/tree', '获取完整描述类目树'], ['/v1/description-category/attribute', '获取三级类目属性'],
  ['/v1/description-category/attribute/values', '分页获取类目字典属性值'], ['/v1/description-category/attribute/values/search', '搜索类目字典属性值'],
  ['/v3/product/list', '分页获取商品列表'], ['/v3/product/info/list', '批量获取商品详情'],
  ['/v4/product/info/attributes', '获取商品属性、重量和尺寸'], ['/v5/product/info/prices', '获取销售价、划线价、最低价和促销价'],
  ['/v3/product/import', '新增或更新商品'], ['/v1/product/import/info', '查询商品导入任务结果'],
  ['/v1/product/import/prices', '更新商品价格'], ['/v2/products/stocks', '更新仓库库存'],
  ['/v1/product/archive', '归档商品'], ['/v1/product/unarchive', '恢复归档商品'], ['/v1/product/info/description', '获取商品描述'],
  ['/v1/analytics/data', '读取店铺基础分析数据'], ['/v1/analytics/turnover/stocks', '读取库存周转分析数据'],
  ['/v3/posting/fbs/list', '分页获取 FBS/rFBS 订单（现有同步链）'], ['/v4/posting/fbs/list', '按订单号核对CPO对应FBS/rFBS货件身份'], ['/v3/posting/fbs/get', '获取单个订单详情'], ['/v3/posting/fbo/list', '核对CPO对应FBO/WHD货件身份'],
  ['/v4/posting/fbs/unfulfilled/list', '分页获取待履约 FBS/rFBS 订单'],
  ['/v1/returns/list', '查询退货列表'], ['/v2/returns/rfbs/list', '查询 rFBS 退货列表'], ['/v2/returns/rfbs/get', '查询 rFBS 退货详情'],
  ['/v1/finance/accrual/types', '查询结算费用类型'], ['/v1/finance/accrual/postings', '查询订单结算明细'],
  ['/v1/finance/accrual/by-day', '按天查询财务计提和广告费用'], ['/v1/finance/realization/posting', '查询月度结算货件明细'],
  ['/v1/actions/products/update', '促销活动商品通用添加/移除（新版逻辑）'], ['/v2/actions/products/deactivate', '强制从促销码活动移除商品'],
  ['/v2/actions/products', '查询促销活动中的商品信息'], ['/v2/actions/candidates', '查询可参加促销活动的候选商品'],
  ['/v2/actions/auto-add/products/update', '配置自动加入促销活动商品'], ['/v2/actions/auto-add/products/delete', '删除自动加入促销计划商品'],
  ['/v2/actions/auto-add/products/list', '查询自动加入促销活动商品'], ['/v2/actions/auto-add/products/candidates', '查询自动促销候选商品']
];

// 2026-09-19 #53：接口级检测周期。时检=服务可用性、登录会话、任务与业务文档读写等动态链路；
// 日检=类目与属性字典、配置、会员权限、审计、物流资费、汇率等静态数据类接口（用户规则："有些接口本来只需要一天检测一次"）。
// OZON 目录行不参与联网检测：外部只读监控须另行授权范围、权限与限流，禁止携带生产写凭证（见 项目接口文档.md 3.9）。
const HOURLY_ENDPOINTS = new Set([
  'GET /health/live', 'GET /health/ready', 'GET /api/auth/captcha', 'POST /api/auth/login', 'GET /api/auth/me',
  'GET /api/sync-tasks', 'POST /api/sync-tasks', 'POST /api/integrations/ozon/commands', 'GET/POST/DELETE /api/data/:key'
]);

const CATALOG = INTERNAL_APIS.map((row, index) => ({ id: `erp-${index + 1}`, provider: '网研ERP', method: row[0], endpoint: row[1], purpose: row[2],
  checkFrequency: HOURLY_ENDPOINTS.has(row[0] + ' ' + row[1]) ? 'hourly' : 'daily', probeMode: '仅检查本机服务健康，不代表该业务接口已验证' }))
  .concat(OZON_APIS.map((row, index) => ({ id: `ozon-${index + 1}`, provider: 'OZON', method: 'POST', endpoint: row[0], purpose: row[1],
    checkFrequency: 'none', probeMode: '不参与联网检测：只维护接口目录；外部只读监控须另行授权范围、权限与限流' })));

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temporary, file);
}

function reasonText(error) {
  return error && error.monitorSafe === true ? error.message : '本机服务健康检查失败，请查看服务器日志后重试。';
}

function createApiMonitor(options = {}) {
  const stateFile = options.stateFile;
  const catalog = Array.isArray(options.catalog) && options.catalog.length ? options.catalog : CATALOG;
  let state = { version: 3, lastHourlyCheckAt: null, nextHourlyCheckAt: null, lastDailyCheckAt: null, nextDailyCheckAt: null, items: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch (error) {}
  if (!state.items || typeof state.items !== 'object') state.items = {};
  if (Number(state.version) < 3) Object.values(state.items).forEach(record => {
    if (record && record.lastError) record.lastError = '历史检测错误详情已隐藏，请重新检查本机服务健康状态。';
    if (record && record.emailReason) record.emailReason = '历史邮件失败详情已隐藏，请检查邮件配置。';
  });
  state.version = 3;
  // #53 状态枚举纠偏："已暂停"是调度暂停标记被错当检测状态持久化，加载时清回"尚未检测"，不再冒充新鲜检测。
  Object.keys(state.items).forEach(id => { if (state.items[id] && state.items[id].status === '已暂停') delete state.items[id]; });
  let running = null;
  const internalConcurrency = Number.isInteger(options.internalConcurrency) ? Math.max(1, options.internalConcurrency) : 2;
  const externalConcurrency = Number.isInteger(options.externalConcurrency) ? Math.max(1, options.externalConcurrency) : 6;

  function save() { atomicJson(stateFile, state); }
  function publicState() {
    return {
      running: Boolean(running), lastHourlyCheckAt: state.lastHourlyCheckAt, nextHourlyCheckAt: state.nextHourlyCheckAt,
      lastDailyCheckAt: state.lastDailyCheckAt, nextDailyCheckAt: state.nextDailyCheckAt,
      retryIntervalHours: 1, maximumAttempts: MAX_ATTEMPTS,
      items: catalog.map(item => ({ ...item, ...(state.items[item.id] || { status: '尚未检测', consecutiveFailures: 0 }) }))
    };
  }

  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const started = Date.now();
    try { const response = await fetch(url, { ...init, signal: controller.signal }); return { response, latencyMs: Date.now() - started }; }
    catch (error) {
      const timedOut = controller.signal.aborted || error && error.name === 'AbortError';
      throw Object.assign(new Error(timedOut ? '本机服务健康检查超时，请稍后重试。' : '无法连接本机服务健康检查地址，请检查服务运行状态。'),
        { code: timedOut ? 'monitor_health_timeout' : 'monitor_health_network_failed', monitorSafe: true });
    }
    finally { clearTimeout(timer); }
  }

  async function probe(item) {
    if (item.provider === '网研ERP') {
      const result = await fetchWithTimeout(options.localOrigin + (item.endpoint === '/health/live' ? '/health/live' : '/health/ready'), { method: 'GET' });
      if (!result.response.ok) {
        const status = result.response.status;
        if (status === 429) throw Object.assign(new Error('本机服务健康检查被限流，请稍后重试。'), { code: 'monitor_health_rate_limited', monitorSafe: true, httpStatus: status });
        if (status === 401 || status === 403) throw Object.assign(new Error('本机服务拒绝健康检查，请核对本机服务配置。'), { code: 'monitor_health_denied', monitorSafe: true, httpStatus: status });
        if (status === 404) throw Object.assign(new Error('本机服务没有该健康检查地址，请核对服务版本。'), { code: 'monitor_health_not_found', monitorSafe: true, httpStatus: status });
        if (status >= 500) throw Object.assign(new Error('本机服务内部异常，健康检查未通过。'), { code: 'monitor_health_server_error', monitorSafe: true, httpStatus: status });
        throw Object.assign(new Error('本机服务返回失败状态，健康检查未通过。'), { code: 'monitor_health_failed', monitorSafe: true, httpStatus: status });
      }
      return { httpStatus: result.response.status, latencyMs: result.latencyMs };
    }
    // 兜底防线：不参与检测的目录行绝不允许走到联网探测，OZON 目录只维护、不使用店铺凭证发起请求。
    throw Object.assign(new Error('该接口不参与联网检测'), { notConfigured: true });
  }

  async function writeTask(item, record, success) {
    const account = await options.getAdminAccount();
    if (!account || !record.taskId) return false;
    await options.taskStore.upsertSyncTask(account, {
      id: record.taskId, type: 'sync', status: success ? 'done' : (record.consecutiveFailures >= MAX_ATTEMPTS ? 'failed' : 'running'),
      value: success ? 100 : Math.min(100, record.consecutiveFailures * 10), name: `本机健康检查 · ${item.endpoint}（目录项）`,
      label: success ? '本机服务健康检查已恢复正常' : `第 ${record.consecutiveFailures}/${MAX_ATTEMPTS} 次本机健康检查失败，${record.consecutiveFailures < MAX_ATTEMPTS ? '1 小时以后重新验证该接口' : '已停止自动重试'}`,
      reason: success ? '' : record.lastError, startedAt: record.outageStartedAt
    });
    return true;
  }

  async function notify(item, record) {
    if (record.notifiedAt) return;
    let result;
    try { result = await options.mailer.sendSystemAlert('本机服务健康检查连续 10 次失败', '以下目录项对应的本机健康检查已连续失败 10 次，次数包含手动检测。尚未逐一验证目录中的业务接口。请检查 ERP 服务、PostgreSQL 和服务器网络。', [{
      name: item.provider + ' ' + item.endpoint + '（目录项）', endpoint: item.method + ' ' + item.endpoint, purpose: item.purpose,
      reason: record.lastError, attempts: record.consecutiveFailures, lastCheckedAt: record.lastCheckedAt
    }]); }
    catch (error) { result = { sent: false, reason: 'send_failed' }; }
    record.emailAttemptedAt = new Date().toISOString(); record.emailSent = Boolean(result && result.sent);
    record.emailReason = result && result.sent ? '' : result && result.reason === 'smtp_not_configured'
      ? '系统管理员告警邮箱尚未配置，邮件未发送。' : '管理员告警邮件未发出，请检查邮件配置和服务日志。';
    if (record.emailSent) record.notifiedAt = record.emailAttemptedAt;
  }

  async function check(item) {
    if (item.checkFrequency === 'none') return; // #53：目录行不参与检测，不写状态、不刷新检测时间
    const now = new Date().toISOString();
    const previous = state.items[item.id] || {};
    const record = { ...previous, lastCheckedAt: now };
    try {
      const result = await probe(item);
      record.status = '正常'; record.httpStatus = result.httpStatus; record.latencyMs = result.latencyMs;
      record.lastSuccessAt = now; record.lastError = ''; record.errorCode = null; record.consecutiveFailures = 0; record.nextRetryAt = null; record.notifiedAt = null;
      let taskClosed = true;
      if (previous.taskId) {
        try { taskClosed = await writeTask(item, record, true); }
        catch (error) { taskClosed = false; console.error('本机健康检查任务中心记录失败:', error && error.code || 'storage_unavailable'); }
      }
      record.taskId = taskClosed ? null : previous.taskId;
      record.outageStartedAt = taskClosed ? null : previous.outageStartedAt;
    } catch (error) {
      if (error.notConfigured) {
        record.status = '未配置'; record.lastError = error.message; record.nextRetryAt = null; record.consecutiveFailures = 0;
      } else {
        record.status = '异常'; record.lastFailureAt = now; record.lastError = reasonText(error);
        record.errorCode = error && error.monitorSafe === true ? error.code : 'monitor_health_unknown';
        record.httpStatus = error && error.httpStatus || null;
        record.consecutiveFailures = Math.min(MAX_ATTEMPTS, Number(previous.consecutiveFailures || 0) + 1);
        record.outageStartedAt = previous.outageStartedAt || now;
        record.taskId = previous.taskId || `api-monitor-${crypto.createHash('sha1').update(item.id + record.outageStartedAt).digest('hex').slice(0, 24)}`;
        record.nextRetryAt = record.consecutiveFailures < MAX_ATTEMPTS ? new Date(Date.now() + RETRY_MS).toISOString() : null;
        try { await writeTask(item, record, false); }
        catch (taskError) { console.error('本机健康检查任务中心记录失败:', taskError && taskError.code || 'storage_unavailable'); }
        if (record.consecutiveFailures >= MAX_ATTEMPTS) await notify(item, record);
      }
    }
    state.items[item.id] = record; save();
  }

  function frequencyMs(item) { return item.checkFrequency === 'hourly' ? HOUR_MS : DAY_MS; }
  function checkableItems() { return catalog.filter(item => item.checkFrequency !== 'none'); }
  function dueItems(nowMs) {
    return checkableItems().filter(item => {
      const record = state.items[item.id];
      if (record && record.status === '异常' && record.nextRetryAt) return false; // 异常项由每小时重试链负责
      return !record || !record.lastCheckedAt || nowMs - new Date(record.lastCheckedAt).getTime() >= frequencyMs(item);
    });
  }

  async function execute(items) {
    const internalItems = items.filter(item => item.provider !== 'OZON');
    const externalItems = items.filter(item => item.provider === 'OZON');
    for (let index = 0; index < internalItems.length; index += internalConcurrency) await Promise.all(internalItems.slice(index, index + internalConcurrency).map(check));
    for (let index = 0; index < externalItems.length; index += externalConcurrency) {
      await Promise.all(externalItems.slice(index, index + externalConcurrency).map(check));
    }
    const now = new Date();
    ['hourly', 'daily'].forEach(frequency => {
      if (!items.some(item => (item.checkFrequency || 'daily') === frequency)) return;
      const suffix = frequency === 'hourly' ? 'Hourly' : 'Daily';
      state['last' + suffix + 'CheckAt'] = now.toISOString();
      state['next' + suffix + 'CheckAt'] = new Date(now.getTime() + (frequency === 'hourly' ? HOUR_MS : DAY_MS)).toISOString();
    });
    save();
    return publicState();
  }

  // force=true：立即检测全部参与检测的接口（手动"立即检测"）；否则只跑各自周期到期的接口。
  function runSweep(force) {
    if (running) return running;
    const items = force ? checkableItems() : dueItems(Date.now());
    if (!items.length) return Promise.resolve(publicState());
    running = execute(items).finally(() => { running = null; });
    return running;
  }

  function runDaily(force) { return runSweep(Boolean(force)); }

  function runRetries() {
    if (running) return running;
    const due = checkableItems().filter(item => {
      const record = state.items[item.id];
      return record && record.status === '异常' && record.consecutiveFailures < MAX_ATTEMPTS && record.nextRetryAt && new Date(record.nextRetryAt).getTime() <= Date.now();
    });
    if (!due.length) return Promise.resolve(publicState());
    running = execute(due).finally(() => { running = null; });
    return running;
  }

  function tick() { return runSweep(false).then(() => runRetries()); }
  return { catalog, getState: publicState, runDaily, runSweep, runRetries, tick, constants: { DAY_MS, HOUR_MS, RETRY_MS, MAX_ATTEMPTS, internalConcurrency } };
}

module.exports = { CATALOG, createApiMonitor, DAY_MS, HOUR_MS, RETRY_MS, MAX_ATTEMPTS };
