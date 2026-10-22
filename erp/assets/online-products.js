/* 网研ERP — 在线商品页：筛选、同步、手工字段覆盖与管理员清理 */
(function () {
  'use strict';
  var PRODUCT_KEY = 'erp_online_products';
  var SHOP_KEY = 'erp_shops_data';
  var CATEGORY_KEY = 'erp_online_categories';
  var MANUAL_KEY = 'erp_online_product_manual';
  var ORDER_KEY = 'erp_orders_data';
  var RATE_KEY = 'erp_rate';
  var MANUAL_FEE_KEY = 'erp_fee_manual';
  var DEFAULT_FULFILLMENT_SCHEMA = 'rFBS';
  var all = [], filtered = [], status = 'all', page = 1, size = 10, myLogisticsScheme = '', logisticsConfig = null;
  var financeRate = 1 / 12, financeManualFee = 0;
  var pricingSettings = { damageLossPct: 6, advertisingPct: 2 };
  var currentAccount = null, canWriteProducts = false;
  var editing = null, editInitialWarehouseId = '', syncMode = 'all', syncing = false, lastTask = '当前没有同步任务';
  var productCreatorsByProduct = new Map(), productCreatorsByOffer = new Map();
  var operationQueue = Promise.resolve();
  var editWatchTimer = null, editWatchBusy = false, editWatchNotified = new Set(), editWatchDelay = 3000;
  var statusLabel = { all: '所有', active: '销售中', ready: '准备出售', error: '错误', pending: '待修改', offline: '已下架', archived: '已归档' };
  var manualModel = window.WYERP_ONLINE_MANUAL;
  var statusModel = window.WYERP_ONLINE_STATUS;
  var entityHistory = window.WYERP_ENTITY_HISTORY;
  var syncStream = window.WYERP_SYNC_STREAM;
  var syncProgress = syncStream.progress;
  var inputRules = window.WYERP_INPUT_RULES;
  var productFormat = window.WYERP_ONLINE_FORMAT;
  var productSyncMap = window.WYERP_ONLINE_SYNC_MAP;
  var profitModel = window.WYERP_ONLINE_PROFIT;
  var costView = window.WYERP_ONLINE_COST_VIEW;
  var actionIcons = window.WYERP_INLINE_ACTION_ICONS;
  var skuMask = window.WYERP_SKU_MASK;
  var ozonProductLink = window.WYERP_OZON_PRODUCT_LINK;
  var navRef = window.WYERP_NAV_REF;
  var sourceLink = window.WYERP_PRODUCT_SOURCE_LINK;
  var permissionModel = window.WYERP_ONLINE_PRODUCT_PERMISSIONS;
  var activeStatusTrigger = null, statusHideTimer = null;
  var ozonWait = syncStream.createThrottlePool({ minDelay: 2000, maxDelay: 4000 });
  var stockUpdateAt = {};
  var orderHistoryPayload = null, orderHistoryMap = new Map(), orderHistoryLoading = false, orderHistoryError = '';
  var $ = function (id) { return document.getElementById(id); };
  if (!inputRules) throw new Error('人工输入规则模块加载失败');
  if (!productFormat) throw new Error('在线商品格式化模块加载失败');
  if (!productSyncMap) throw new Error('在线商品同步映射模块加载失败');
  if (!profitModel) throw new Error('在线商品预估利润模块加载失败');
  if (!costView) throw new Error('在线商品订单历史视图模块加载失败');
  if (!actionIcons || !skuMask || !ozonProductLink || !sourceLink || !permissionModel) throw new Error('行内图标、SKU掩码、Ozon商品链接、货源关联或在线商品权限模块加载失败');
  inputRules.bind(document);
  applyProductWritePermission(null);

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function serverChineseMessage(data, fallback) {
    var message = data && typeof data.message === 'string' ? data.message.trim() : '';
    return message.length <= 200 && /[\u3400-\u9fff]/.test(message) && !/[A-Za-z_\\\/<>]/.test(message.replace(/Ozon/g, '')) ? message : fallback;
  }
  function serverFailure(data, fallback) {
    var error = new Error(serverChineseMessage(data, fallback));
    error.trustedMessage = true;
    return error;
  }
  function copyText(value, label, button) {
    var text = String(value == null ? '' : value);
    function success() {
      if (button) {
        button.classList.add('copied');
        window.setTimeout(function () { button.classList.remove('copied'); }, 900);
      }
      toast((label || '内容') + '已复制');
    }
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); success(); } catch (error) { toast('复制失败，请重试'); }
      document.body.removeChild(area);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(success, fallback);
    else fallback();
  }
  function toast(message) {
    var element = document.createElement('div');
    element.className = 'toast';
    element.textContent = message;
    document.body.appendChild(element);
    setTimeout(function () { element.remove(); }, 3500);
  }
  function accountCanWriteProducts(account) { return permissionModel.canWriteProducts(account); }
  function applyProductWritePermission(account) {
    currentAccount = account || null;
    canWriteProducts = accountCanWriteProducts(currentAccount);
    document.body.classList.toggle('products-readonly', !canWriteProducts);
    document.querySelectorAll('.write-action').forEach(function (node) { node.hidden = !canWriteProducts; });
    if ($('autoSyncBtn')) $('autoSyncBtn').hidden = !(currentAccount && currentAccount.isSystemAdmin);
    if (!canWriteProducts && $('batchWrap')) $('batchWrap').classList.remove('open');
  }
  function requireProductWrite() {
    if (canWriteProducts) return true;
    toast('当前账号只有商品查看权限，没有商品修改权限，请联系管理员授权。');
    return false;
  }
  function money(value) {
    return esc(productFormat.money(value));
  }
  function logisticsCommissionLabel(product) {
    var scheme = productFormat.normalizeSchema(myLogisticsScheme);
    if (!scheme) return { scheme: '方案待加载', percent: '佣金待同步', title: '方案来源：物流配置 → 我的方案' };
    var storedScheme = productFormat.normalizeSchema(product && product.commissionSchema);
    var percent = storedScheme === scheme ? productFormat.percentage(product && product.commissionPercent) : '';
    return {
      scheme: scheme,
      percent: percent ? percent + '%' : '佣金待同步',
      title: '方案来源：物流配置 → 我的方案；佣金比例来源：Ozon 商品信息 commissions.percent'
    };
  }
  function cny(value, missingText) {
    if (value == null || !Number.isFinite(Number(value))) return missingText || '待计算';
    return '￥' + Number(value).toFixed(2);
  }
  function costMissingText(result) {
    var missing = [];
    if (result.purchasePriceCny == null || result.purchasePriceCny <= 0) missing.push('采购成本');
    if (result.domesticShippingCny == null) missing.push('国内快递费');
    if (result.commissionCny == null) missing.push('佣金比例');
    if (result.internationalCny == null) missing.push('国际物流报价');
    return '待补' + (missing.length ? missing.join('、') : '费用数据');
  }
  function refreshFinanceSettings() {
    var storedRate = Number(erpStorage.get(RATE_KEY));
    var storedManualFee = Number(erpStorage.get(MANUAL_FEE_KEY));
    financeRate = storedRate > 0 ? storedRate : 1 / 12;
    financeManualFee = storedManualFee >= 0 ? storedManualFee : 0;
  }
  function isDisplayedZero(value) {
    return value != null && Number.isFinite(Number(value)) && Math.abs(Number(value)) < 0.005;
  }
  function pushCostTitleLine(lines, label, value, displayText, suffix) {
    if (isDisplayedZero(value)) return;
    lines.push(label + displayText + (suffix || ''));
  }
  function estimatedProfitHtml(product) {
    var result = profitModel.calculate(product, logisticsConfig, {
      rate: financeRate,
      manualFee: financeManualFee,
      market: '俄罗斯',
      orders: erpStorage.get(ORDER_KEY) || [],
      damageLossPct: pricingSettings.damageLossPct,
      advertisingPct: pricingSettings.advertisingPct
    });
    var profit = result.ready ? cny(result.profitCny) : '待计算';
    var margin = result.ready && result.margin != null ? Number(result.margin).toFixed(1) + '%' : '--';
    var commission = cny(result.commissionCny, '待补佣金比例');
    var international = cny(result.internationalCny, '待补国际物流报价');
    var totalCost = cny(result.totalCostCny, costMissingText(result));
    var otherFees = cny(result.otherFeesCny, '待补收单业务费');
    var quote = result.quote && result.quote.ready ? result.quote : null;
    var title = [
      '预估利润：' + profit,
      '利润率：' + margin,
      '计价收入：' + cny(result.saleCny, '待补促销价或币种') + '（' + (result.saleSource || 'Ozon 当前促销价') + '）',
      '总成本：' + totalCost
    ];
    pushCostTitleLine(title, '采购价：', result.purchasePriceCny, cny(result.purchasePriceCny, '待补采购价'), '（免费商品请填0.1）');
    pushCostTitleLine(title, '国内快递费：', result.domesticShippingCny, cny(result.domesticShippingCny, '待补国内快递费（无费用请填0）'));
    pushCostTitleLine(title, '采购成本合计：', result.purchaseCostCny, cny(result.purchaseCostCny, '待补采购成本'));
    pushCostTitleLine(title, 'Ozon佣金：', result.commissionCny, commission, '（' + (result.commissionSource || '待同步') + '）');
    pushCostTitleLine(title, '国际运费：', result.internationalCny, international, quote
      ? '（' + [quote.provider, quote.version, quote.scheme, quote.group, quote.transportMode, quote.channel, '计费重' + Number(quote.chargeableKg).toFixed(3) + 'kg'].filter(Boolean).join(' · ') + '）'
      : '（' + ((result.quote && result.quote.reason) || '物流报价条件不完整') + '）');
    pushCostTitleLine(title, '尾程配送费：', result.lastMileCny, cny(result.lastMileCny, '待补促销价'), '（预估：max(销售额×2%, 15 RUB)，上限200 RUB）');
    pushCostTitleLine(title, '收单业务费：', result.acquiringCny, cny(result.acquiringCny, '待补订单金额'));
    pushCostTitleLine(title, '退货处理费：', result.returnHandlingCny, cny(result.returnHandlingCny, '待补退货处理样本'), '（' + (result.returnHandlingSource || '预估样本待补充') + '）');
    pushCostTitleLine(title, '提现费：', result.withdrawalCny, cny(result.withdrawalCny, '待补促销价'), '（连连提现1%）');
    pushCostTitleLine(title, '货损预估：', result.damageLossCny, cny(result.damageLossCny, '待计算'), '（主账号定价设置 ' + Number(result.damageLossPct || 0).toFixed(1) + '%）');
    pushCostTitleLine(title, '广告预算：', result.advertisingCny, cny(result.advertisingCny, '待计算'), '（主账号定价设置 ' + Number(result.advertisingPct || 0).toFixed(1) + '%）');
    pushCostTitleLine(title, '贴单费：', result.manualFeeCny, cny(result.manualFeeCny, '待补贴单费'));
    pushCostTitleLine(title, '其它费用合计：', result.otherFeesCny, otherFees);
    if (!isDisplayedZero(result.acquiringCny)) title.push(result.acquiringSource || '收单业务费预估样本待补充');
    title.push('汇率：1 CNY = ' + window.WYERP_EXCHANGE_RATE.display(window.WYERP_EXCHANGE_RATE.rubPerCny(result.rate || financeRate)) + ' RUB');
    if (!result.ready) title.unshift('待计算原因：' + (result.reason || '数据不完整'));
    var cls = result.ready ? (result.profitCny < 0 ? ' profit-negative' : ' profit-positive') : ' profit-pending';
    return '<div class="money-stack profit-breakdown' + cls + '" title="' + esc(title.join('\n')) + '">' +
      '<div class="money-row"><span>销售价</span><b>' + esc(cny(result.saleCny, '待补')) + '</b></div>' +
      '<div class="money-row"><span>采购总成本</span><b>' + esc(cny(result.purchaseCostCny, '待补')) + '</b></div>' +
      '<div class="money-row"><span>总费用</span><b>' + esc(totalCost) + '</b></div>' +
      '<div class="money-row"><span>利润</span><b>' + esc(profit) + '</b></div>' +
      '<small>利润率 ' + esc(margin) + (result.ready ? ' · 预估' : '') + '</small>' +
      (!result.ready ? '<small>' + esc(result.reason || '数据不完整') + '</small>' : '') + '</div>';
  }
  function orderHistoryHtml(product) {
    if (orderHistoryLoading && !orderHistoryPayload) return '<div class="shop-history shop-history-loading"><span>近30天 --单 / --件</span><span>历史 --单 / --件</span></div>';
    var item = costView.lookup(orderHistoryMap, product, getShops());
    if (!item) return '<div class="shop-history"' + (orderHistoryError ? ' title="' + esc(orderHistoryError) + '"' : '') + '><span>近30天 0单 / 0件</span><span>历史 0单 / 0件</span></div>';
    var recentOrders = Number(item.matchedOrderCount || 0), recentQty = Number(item.soldQuantity || 0);
    var historyOrders = Number(item.historicalMatchedOrderCount || 0), historyQty = Number(item.historicalSoldQuantity || 0);
    var notes = [];
    if (Number(item.unknownAllocationOrderCount || 0) > 0) notes.push('近30天有 ' + Number(item.unknownAllocationOrderCount || 0) + ' 单商品数量缺失，件数仅统计已知数量');
    if (item.historicalSoldQuantityComplete === false) notes.push(costView.historicalMessage(item));
    return '<div class="shop-history"' + (notes.length ? ' title="' + esc(notes.join('；')) + '"' : '') + '>' +
      '<span>近30天 ' + recentOrders + '单 / ' + recentQty + '件</span>' +
      '<span>历史 ' + historyOrders + '单 / ' + historyQty + '件</span></div>';
  }
  function loadOrderHistory() {
    if (orderHistoryLoading) return Promise.resolve();
    orderHistoryLoading = true; orderHistoryError = ''; renderTable();
    return erpStorage.request('/api/domain/queries/online-product-costs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: 30 })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error('订单历史统计读取失败，请稍后重试。');
        orderHistoryPayload = payload || { items: [] }; orderHistoryMap = costView.index(orderHistoryPayload);
      });
    }).catch(function (error) {
      orderHistoryError = error && error.message || '订单历史统计读取失败，请稍后重试。';
    }).finally(function () { orderHistoryLoading = false; renderTable(); });
  }
  function productKey(product) {
    return manualModel.key(product);
  }
  function normalizeStatus(product) {
    var text = String(product.status || product.ozonStatusName || product.ozonStatus || '').toLowerCase();
    if (product.archived || /归档|archiv/.test(text)) return 'archived';
    if (/下架|禁售|offline|disabled|banned/.test(text)) return 'offline';
    if (/错误|失败|error|failed|rejected/.test(text)) return 'error';
    if (/待修改|pending/.test(text)) return 'pending';
    if (/准备|ready|variant_wait|new/.test(text)) return 'ready';
    if (/销售中|在售|active|moderated|price_sent|продается/.test(text)) return 'active';
    return 'pending';
  }
  function statusHtml(product) {
    var key = normalizeStatus(product);
    var info = statusModel.display({ key: key, status: product.status, reason: product.statusReason,
      codes: product.ozonErrorCodes || [], action: product.statusAction });
    return '<button type="button" class="status-badge status-trigger status-' + key + '" data-status-label="' + esc(info.label) +
      '" data-status-reason="' + esc(info.reason) + '" data-status-action="' + esc(info.action) +
      '" data-status-codes="' + esc((info.codes || []).join('、')) + '" data-status-help-url="' + esc(info.sellerPortal || '') +
      '" aria-label="查看' + esc(info.label) + '状态说明" aria-expanded="false">' + esc(info.label) + '</button>';
  }

  function statusTooltipContent(tip, trigger) {
    tip.innerHTML = '';
    var head = document.createElement('div');
    head.className = 'status-tip-head';
    var dot = document.createElement('span'); dot.className = 'status-tip-dot ' + Array.from(trigger.classList).filter(function (name) { return /^status-(active|ready|error|pending|offline|archived)$/.test(name); }).join(' ');
    var title = document.createElement('strong'); title.textContent = '商品状态详情';
    head.appendChild(dot); head.appendChild(title); tip.appendChild(head);
    function section(label, value, list) {
      if (!value) return;
      var block = document.createElement('div'); block.className = 'status-tip-section';
      var name = document.createElement('div'); name.className = 'status-tip-label'; name.textContent = label; block.appendChild(name);
      if (list) {
        var ul = document.createElement('ul');
        String(value).split('；').filter(Boolean).forEach(function (item) { var li = document.createElement('li'); li.textContent = item; ul.appendChild(li); });
        block.appendChild(ul);
      } else { var content = document.createElement('div'); content.className = 'status-tip-text'; content.textContent = value; block.appendChild(content); }
      tip.appendChild(block);
    }
    section('当前状态', trigger.dataset.statusLabel, false);
    section('状态说明', trigger.dataset.statusReason, true);
    section('建议处理', trigger.dataset.statusAction, false);
    section('平台错误代码', trigger.dataset.statusCodes, false);
    if (trigger.dataset.statusHelpUrl) {
      var help = document.createElement('div'); help.className = 'status-tip-section status-tip-help';
      var helpLabel = document.createElement('div'); helpLabel.className = 'status-tip-label'; helpLabel.textContent = 'OZON 卖家后台';
      var helpText = document.createElement('div'); helpText.className = 'status-tip-text';
      helpText.textContent = '卖家后台就是管理 OZON 店铺、商品和订单的官方网页。';
      var link = document.createElement('a'); link.href = trigger.dataset.statusHelpUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = '打开 OZON 中国卖家后台（seller.ozonru.cn）';
      var backupLink = document.createElement('a');
      backupLink.href = window.WYERP_ONLINE_STATUS && window.WYERP_ONLINE_STATUS.sellerPortalBackup || 'https://seller.ozon.ru/';
      backupLink.target = '_blank'; backupLink.rel = 'noopener noreferrer';
      backupLink.textContent = '俄罗斯卖家后台（备用）';
      var errorCodes = trigger.dataset.statusCodes || '未获取到错误代码';
      var feedbackDescription = '在线商品出现未收录的 OZON 错误代码：' + errorCodes + '。请补充商品货号，并上传 OZON 卖家后台的错误截图，方便系统管理员适配中文说明。';
      var feedback = document.createElement('a'); feedback.href = '/pages/bug-feedback.html?source=' + encodeURIComponent('/pages/goods-online.html') +
        '&title=' + encodeURIComponent('在线商品出现未收录的 OZON 错误代码') + '&description=' + encodeURIComponent(feedbackDescription);
      feedback.className = 'status-feedback-link'; feedback.textContent = '提交 BUG 反馈，请系统管理员适配';
      help.appendChild(helpLabel); help.appendChild(helpText); help.appendChild(link); help.appendChild(backupLink); help.appendChild(feedback); tip.appendChild(help);
    }
  }

  function showStatusTooltip(trigger) {
    var tip = $('statusTooltip');
    if (!tip || !trigger) return;
    if (statusHideTimer) { window.clearTimeout(statusHideTimer); statusHideTimer = null; }
    if (activeStatusTrigger && activeStatusTrigger !== trigger) activeStatusTrigger.setAttribute('aria-expanded', 'false');
    activeStatusTrigger = trigger;
    statusTooltipContent(tip, trigger);
    tip.classList.add('show'); trigger.setAttribute('aria-expanded', 'true');
    var rect = trigger.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight, gap = 10;
    var left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.left + rect.width / 2 - width / 2));
    var top = rect.bottom + gap;
    if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - gap);
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }

  function hideStatusTooltip(trigger, delayed) {
    var tip = $('statusTooltip');
    if (statusHideTimer) window.clearTimeout(statusHideTimer);
    function closeTip() {
      if (tip) tip.classList.remove('show');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
      if (!trigger || activeStatusTrigger === trigger) activeStatusTrigger = null;
      statusHideTimer = null;
    }
    if (delayed) statusHideTimer = window.setTimeout(closeTip, 120); else closeTip();
  }
  function getShops() {
    var value = erpStorage.get(SHOP_KEY);
    return Array.isArray(value) ? value : [];
  }
  function productShop(product) {
    return getShops().find(function (shop) { return shop && shop.name === product.shop; }) || {};
  }
  function warehouseOptions(shop, product) {
    var options = Array.isArray(shop.warehouseOptions) ? shop.warehouseOptions.slice() : [];
    var currentId = String(product.stockWarehouseId || '');
    var currentName = String(product.stockWarehouseName || '');
    if ((currentId || currentName) && !options.some(function (option) {
      return (currentId && String(option.id || '') === currentId) || (currentName && option.name === currentName);
    })) options.unshift({ id: currentId, name: currentName || '当前仓库' });
    return options;
  }
  function manualMap() {
    var value = erpStorage.get(MANUAL_KEY);
    var map = {};
    (Array.isArray(value) ? value : []).forEach(function (item) { if (item && item.key) map[item.key] = item; });
    return map;
  }
  function rememberManual(product) {
    erpStorage.set(MANUAL_KEY, manualModel.capture(erpStorage.get(MANUAL_KEY), product));
  }
  function applyManual(product) {
    return manualModel.apply(product, erpStorage.get(MANUAL_KEY));
  }
  function mergeOrderSources(products) {
    sourceLink.applyOrdersToProducts(products, erpStorage.get(ORDER_KEY));
    return products;
  }
  function renderShops() {
    var names = {}, current = $('shopFilter').value;
    var shopReadFailure = erpStorage.getLoadFailure && erpStorage.getLoadFailure(SHOP_KEY);
    if (shopReadFailure) {
      $('shopFilter').innerHTML = '<option value="">店铺读取失败，请刷新重试</option>';
      return;
    }
    getShops().forEach(function (shop) { if (shop && shop.name) names[shop.name] = true; });
    $('shopFilter').innerHTML = '<option value="">全部店铺</option>' + Object.keys(names).sort().map(function (name) {
      return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
    }).join('');
    $('shopFilter').value = names[current] ? current : '';
  }
  function renderTabs(filters) {
    var count = { all: 0, active: 0, ready: 0, error: 0, pending: 0, offline: 0, archived: 0 };
    filters = filters || filterContext();
    var scoped = all.filter(function (product) { return matchesBaseFilters(product, filters); });
    scoped.forEach(function (product) { count[normalizeStatus(product)] += 1; });
    count.all = scoped.filter(function (product) { return normalizeStatus(product) !== 'archived'; }).length;
    $('statusBar').innerHTML = Object.keys(statusLabel).map(function (key) {
      return '<button class="status-tab' + (key === status ? ' on' : '') + '" data-status="' + key + '">' + statusLabel[key] + ' <strong>' + count[key] + '</strong></button>';
    }).join('');
    var archiveBatchButton = document.querySelector('[data-batch="archive"]');
    if (archiveBatchButton) archiveBatchButton.textContent = status === 'archived' ? '批量恢复' : '批量归档';
  }
  // #52 口径：销量=本地订单副本中非“已取消”订单（order-sync-map.js 中文状态）按 SKU 匹配的 qty 合计；
  // 货源=srcUrl/srcPrice 至少一项非空；最低价=priceLowest 非空；成本=采购价>0 且国内快递费已填写（与 online-product-profit.js 采购成本判定同口径）。
  function salesCountBySku() {
    var map = {};
    var orders = erpStorage.get(ORDER_KEY);
    (Array.isArray(orders) ? orders : []).forEach(function (order) {
      if (!order || order.status === '已取消') return;
      (Array.isArray(order.items) ? order.items : []).forEach(function (item) {
        var key = sourceLink.sku(item && item.sku);
        if (!key) return;
        map[key] = (map[key] || 0) + (item && item.qty != null ? Number(item.qty) || 0 : 1);
      });
    });
    return map;
  }
  function filledValue(value) {
    var text = String(value == null ? '' : value).trim();
    return text !== '' && text !== '--';
  }
  function toNumber(value) {
    if (!filledValue(value)) return null;
    var parsed = Number(String(value).replace(/[,，\s￥¥₽$€]|RUB|CNY|RMB/gi, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  var rangeWarned = {};
  var rangeInvalid = {};
  function captureRangeInput(event) {
    var target = event.target;
    if (!target || !/^(salesMinFilter|salesMaxFilter|commissionMinFilter|commissionMaxFilter)$/.test(target.id) || event.isComposing) return;
    var raw = String(target.value || '').trim();
    var integer = target.id.indexOf('sales') === 0;
    rangeInvalid[target.id] = Boolean(raw) && !(integer ? /^[0-9０-９]+$/.test(raw) : /^[0-9０-９]+(?:[.．。][0-9０-９]{0,2})?$/.test(raw));
    if (!rangeInvalid[target.id]) delete rangeWarned[target.id + ':invalid'];
  }
  function warnOnce(key, message) {
    if (rangeWarned[key]) return;
    rangeWarned[key] = true;
    toast(message);
  }
  function rangeBoundary(id, label) {
    var raw = String($(id).value || '').trim();
    if (rangeInvalid[id]) {
      warnOnce(id + ':invalid', label + '的输入必须是大于等于0的' + (id.indexOf('sales') === 0 ? '整数' : '数字') + '，本次该条件未生效');
      return null;
    }
    if (!raw) return null;
    var parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      warnOnce(id + '=' + raw, label + '的输入必须是大于等于0的数字，本次该条件未生效');
      return null;
    }
    return parsed;
  }
  function rangeConflict(minId, maxId, min, max, label) {
    if (min == null || max == null || min <= max) return false;
    warnOnce(minId + '>' + maxId + '=' + min + '/' + max, label + '的“大于”值高于“小于”值，本次区间条件未生效');
    return true;
  }
  function filterContext() {
    var salesMin = rangeBoundary('salesMinFilter', '销售量');
    var salesMax = rangeBoundary('salesMaxFilter', '销售量');
    if (rangeConflict('salesMinFilter', 'salesMaxFilter', salesMin, salesMax, '销售量')) salesMin = salesMax = null;
    var commissionMin = rangeBoundary('commissionMinFilter', '类目佣金比例');
    var commissionMax = rangeBoundary('commissionMaxFilter', '类目佣金比例');
    if (rangeConflict('commissionMinFilter', 'commissionMaxFilter', commissionMin, commissionMax, '类目佣金比例')) commissionMin = commissionMax = null;
    var salesMode = $('existSalesFilter').value;
    return {
      keyword: $('keywordFilter').value.trim().toLowerCase(), shop: $('shopFilter').value,
      salesMode: salesMode, sourceMode: $('existSourceFilter').value,
      lowestMode: $('existLowestFilter').value, costMode: $('existCostFilter').value,
      salesMin: salesMin, salesMax: salesMax, commissionMin: commissionMin, commissionMax: commissionMax,
      salesMap: salesMode || salesMin != null || salesMax != null ? salesCountBySku() : null
    };
  }
  function matchesBaseFilters(product, filters) {
    if (filters.shop && product.shop !== filters.shop) return false;
    if (filters.keyword && (String(product.sku || '') + ' ' + String(product.article || '')).toLowerCase().indexOf(filters.keyword) < 0) return false;
    if (filters.salesMap) {
      var total = filters.salesMap[sourceLink.sku(product.sku)] || 0;
      if (filters.salesMode === 'has' && total <= 0) return false;
      if (filters.salesMode === 'none' && total > 0) return false;
      if (filters.salesMin != null && !(total > filters.salesMin)) return false;
      if (filters.salesMax != null && !(total < filters.salesMax)) return false;
    }
    var hasSource = filledValue(product.srcUrl) || filledValue(product.srcPrice);
    if (filters.sourceMode === 'has' && !hasSource) return false;
    if (filters.sourceMode === 'none' && hasSource) return false;
    var hasLowest = filledValue(product.priceLowest);
    if (filters.lowestMode === 'has' && !hasLowest) return false;
    if (filters.lowestMode === 'none' && hasLowest) return false;
    var purchase = toNumber(product.purchasePrice);
    var shipping = toNumber(product.domesticShipping);
    var hasCost = purchase != null && purchase > 0 && shipping != null && shipping >= 0;
    if (filters.costMode === 'has' && !hasCost) return false;
    if (filters.costMode === 'none' && hasCost) return false;
    if (filters.commissionMin != null || filters.commissionMax != null) {
      var percent = toNumber(product.commissionPercent);
      if (percent == null) return false;
      if (filters.commissionMin != null && !(percent > filters.commissionMin)) return false;
      if (filters.commissionMax != null && !(percent < filters.commissionMax)) return false;
    }
    return true;
  }
  function applyFilter(filters) {
    filters = filters || filterContext();
    filtered = all.filter(function (product) {
      var productStatus = normalizeStatus(product);
      if (status === 'all' && productStatus === 'archived') return false;
      if (status !== 'all' && productStatus !== status) return false;
      return matchesBaseFilters(product, filters);
    }).sort(function (left, right) {
      var leftTime = Date.parse(left && left.createdAt || '') || 0;
      var rightTime = Date.parse(right && right.createdAt || '') || 0;
      return rightTime - leftTime;
    });
    page = Math.min(page, Math.max(1, Math.ceil(filtered.length / size)));
    renderTable();
  }
  function refreshFilteredView() {
    var filters = filterContext();
    renderTabs(filters);
    applyFilter(filters);
  }
  function productInfo(product, index) {
    var image = product.img || product.image || product.imageUrl || '';
    var imageHtml = image
      ? '<img class="product-image" src="' + esc(image) + '" alt="" onerror="this.style.visibility=\'hidden\'">'
      : '<div class="product-image image-empty">◇</div>';
    var name = product.name || '未命名商品';
    var article = product.article || '--';
    var sku = product.sku || product.id || '--';
    var maskedSku = skuMask.mask(sku);
    var category = productFormat.categoryPath(product, typeof translateCat === 'function' ? translateCat : null);
    return '<div class="product-cell">' + imageHtml + '<div>' + ozonProductLink.titleHtml(product, name, { className: 'product-name product-title-ellipsis ozon-product-title-link' }) +
      '<div class="product-meta"><div class="product-meta-line meta-copy-line"><span class="meta-copy-value" title="货号: ' + esc(article) + '"><b>货号:</b> ' + esc(article) + '</span><button type="button" class="inline-icon-btn meta-copy-btn" data-inline-copy="' + esc(article) + '" data-copy-label="货号" title="复制货号" aria-label="复制货号">' + actionIcons.copy() + '</button></div><div class="product-meta-line meta-copy-line"><span class="meta-copy-value" title="SKU: ' + esc(maskedSku) + '"><b>SKU:</b> ' + esc(maskedSku) + '</span><button type="button" class="inline-icon-btn meta-copy-btn" data-inline-copy="' + esc(sku) + '" data-copy-label="SKU" title="复制SKU" aria-label="复制SKU">' + actionIcons.copy() + '</button></div>' +
      '<div class="product-meta-line" title="类目: ' + esc(category) + '"><b>类目:</b> ' + esc(category) + '</div></div>' +
      ((product.mergedCount || typeof product.variants === 'number' && product.variants) ? '<span class="merged" title="已合并(' + esc(product.mergedCount || product.variants) + ')">已合并(' + esc(product.mergedCount || product.variants) + ')</span>' : '') +
      entityHistory.summary(product, 'data-product-history', index) + '</div></div>';
  }
  function creatorKey(clientId, value) {
    clientId = String(clientId || '').trim(); value = String(value == null ? '' : value).trim();
    return clientId && value ? clientId + '\u0000' + value : '';
  }
  function indexProductCreators(items) {
    productCreatorsByProduct = new Map(); productCreatorsByOffer = new Map();
    (Array.isArray(items) ? items : []).forEach(function (item) {
      if (!item || item.source !== 'product_create_submit' || item.status !== '新增成功') return;
      var api = window.WYERP_IDENTITY_DISPLAY;
      var actor = api && typeof api.displayIdentity === 'function'
        ? api.displayIdentity({ profileFullName: item.actorProfileFullName, email: item.actorEmail, isSystemAdmin: item.actorIsSystemAdmin })
        : { kind: 'unknown', raw: '', masked: '' };
      if (actor.kind === 'unknown') actor = { kind: 'unknown', raw: '', masked: '历史未记录' };
      var productKey = creatorKey(item.clientId, item.productId);
      var offerKey = creatorKey(item.clientId, item.offerId);
      if (productKey) productCreatorsByProduct.set(productKey, actor);
      if (offerKey) productCreatorsByOffer.set(offerKey, actor);
    });
  }
  function loadProductCreators() {
    return erpStorage.request('/api/domain/queries/product-listing-records').then(function (response) {
      if (!response || !response.ok) return { items: [] };
      return response.json().catch(function () { return { items: [] }; });
    }).then(function (payload) { indexProductCreators(payload && payload.items); })
      .catch(function () { indexProductCreators([]); });
  }
  function productCreator(product) {
    var clientId = product && (product.clientId || product.shopId) || '';
    var productId = product && (product.id || product.productId) || '';
    var offerId = product && (product.article || product.offer_id) || '';
    return productCreatorsByProduct.get(creatorKey(clientId, productId)) || productCreatorsByOffer.get(creatorKey(clientId, offerId)) || { kind: 'unknown', raw: '', masked: '--' };
  }
  function syncKeywordClearButton() {
    var button = $('keywordClearBtn');
    if (button) button.hidden = !$('keywordFilter').value;
  }
  function renderTable() {
    var start = (page - 1) * size;
    var rows = filtered.slice(start, start + size);
    $('productBody').innerHTML = rows.length ? rows.map(function (product) {
      var index = all.indexOf(product);
      var commissionLabel = logisticsCommissionLabel(product);
      var packageInfo = productFormat.packageSummary(product);
      var created = productFormat.dateTime(product.createdAt || product.updatedAt);
      var createdHtml = created === '--'
        ? '<span class="date-line">--</span>'
        : created.split(/\s+/).map(function (part) { return '<span class="date-line">' + esc(part) + '</span>'; }).join('');
      var safeSourceUrl = sourceLink.safeSupplierUrl(product.srcUrl);
      var lifecycleAction = !canWriteProducts ? '' : normalizeStatus(product) === 'archived'
        ? '<button class="action-btn restore" data-restore="' + index + '" title="将商品从 OZON 归档中恢复" aria-label="恢复商品">恢复</button>'
        : '<button class="action-btn" data-archive="' + index + '">归档</button>';
      return '<tr><td class="check-col">' + (canWriteProducts ? '<input class="row-check" type="checkbox" data-index="' + index + '">' : '') + '</td><td>' + productInfo(product, index) + '</td>' +
        '<td><div class="commission"><div class="truncate-line commission-scheme-rate" title="' + esc(commissionLabel.title) + '"><span>' + esc(commissionLabel.scheme) + '：</span><b>' + esc(commissionLabel.percent) + '</b></div><div class="truncate-line" title="佣金金额：' + money(product.commission) + '"><span>佣金金额：</span>' + money(product.commission) + '</div><div class="truncate-line" title="收单：' + money(product.acquiring) + '"><span>收单：</span>' + money(product.acquiring) + '</div></div></td>' +
        '<td class="shop-cell"><span class="shop-link" title="' + esc(product.shop || '--') + '">[' + esc(product.shop || '--') + ']</span>' + orderHistoryHtml(product) + '</td><td class="status-cell">' + statusHtml(product) + '</td>' +
        '<td><div class="prices"><div class="truncate-line" title="销售价：' + money(product.priceSell != null ? product.priceSell : product.price) + '"><span>销售价：</span><b class="price-sale">' + money(product.priceSell != null ? product.priceSell : product.price) + '</b></div><div class="truncate-line" title="划线价：' + money(product.priceOriginal) + '"><span>划线价：</span><span class="price-old">' + money(product.priceOriginal) + '</span></div><div class="truncate-line" title="最低价：' + money(product.priceLowest) + '"><span>最低价：</span>' + money(product.priceLowest) + '</div><div class="truncate-line" title="促销价：' + money(product.pricePromo) + '"><span>促销价：</span><b class="price-promo">' + money(product.pricePromo) + '</b></div></div></td><td class="estimated-profit">' + estimatedProfitHtml(product) + '</td>' +
        '<td><div class="stock-edit-line"><span title="库存：' + esc(product.stock == null ? '--' : product.stock) + '">' + esc(product.stock == null ? '--' : product.stock) + '</span>' + (canWriteProducts ? '<button type="button" class="inline-icon-btn quick-edit-btn" data-quick-edit="stock" data-index="' + index + '" title="编辑库存" aria-label="编辑库存">' + actionIcons.edit() + '</button>' : '') + '</div></td><td class="package-summary-cell" title="重量：' + esc(packageInfo.weight) + '；尺寸：' + esc(packageInfo.size) + '"><div class="package-summary"><span class="package-weight">重量：' + esc(packageInfo.weight) + '</span><span class="package-size">尺寸：' + esc(packageInfo.size) + '</span></div></td>' +
        '<td><div class="source"><div class="source-edit-head"><span>货源信息</span>' + (canWriteProducts ? '<button type="button" class="inline-icon-btn source-edit-btn" data-source-edit="' + index + '" title="编辑货源信息" aria-label="编辑货源信息">' + actionIcons.edit() + '</button>' : '') + '</div>' + (safeSourceUrl ? '<a href="' + esc(safeSourceUrl) + '" target="_blank" rel="noopener" title="货源地址：' + esc(safeSourceUrl) + '">货源地址：' + esc(safeSourceUrl) + '</a>' : '<div class="truncate-line" title="货源地址：--"><span>货源地址：--</span></div>') + '<div class="truncate-line" title="货源价格：' + money(product.srcPrice) + '"><span>货源价格：</span>' + money(product.srcPrice) + '</div><div class="truncate-line" title="货源备注：' + esc(product.srcNote || '--') + '"><span>货源备注：</span>' + esc(product.srcNote || '--') + '</div><div class="truncate-line" title="采购价格：' + money(product.purchasePrice) + '"><span>采购价格：</span>' + money(product.purchasePrice) + '</div><div class="truncate-line" title="快递费：' + money(product.domesticShipping) + '"><span>快递费：</span>' + money(product.domesticShipping) + '</div></div></td>' +
        '<td class="creator-cell" title="' + esc(productCreator(product).raw || productCreator(product).masked) + '">' + esc(productCreator(product).masked) + '</td><td class="date-cell" title="' + esc(created) + '">' + createdHtml + '</td><td><div class="actions">' + (canWriteProducts ? '<button class="action-btn edit" data-edit="' + index + '">编辑</button>' : '') + '<a class="action-btn detail" href="' + esc(productDetailsHrefWithParam(product, 'load=full')) + '">全部信息</a>' + lifecycleAction + '</div></td></tr>';
    }).join('') : '<tr><td class="empty" colspan="13">' + (erpStorage.getLoadFailure && erpStorage.getLoadFailure(PRODUCT_KEY)
      ? esc(erpStorage.getLoadFailure(PRODUCT_KEY)) + '<br>请先恢复服务器数据读取，再刷新本页；不会自动清空已保存商品。'
      : '暂无在线商品数据<br>请先在右上方同步已授权店铺的商品') + '</td></tr>';
    $('totalText').textContent = '共 ' + filtered.length + ' 条记录';
    $('checkAll').checked = false;
    renderPager();
  }
  function renderPager() {
    var pages = Math.max(1, Math.ceil(filtered.length / size));
    var html = '<button class="page-btn" data-page="' + (page - 1) + '"' + (page <= 1 ? ' disabled' : '') + '>‹</button>';
    var from = Math.max(1, page - 2), to = Math.min(pages, from + 4);
    from = Math.max(1, to - 4);
    for (var i = from; i <= to; i += 1) html += '<button class="page-btn' + (i === page ? ' on' : '') + '" data-page="' + i + '">' + i + '</button>';
    html += '<button class="page-btn" data-page="' + (page + 1) + '"' + (page >= pages ? ' disabled' : '') + '>›</button>';
    $('pager').innerHTML = html;
  }
  function selected() {
    return Array.prototype.map.call(document.querySelectorAll('.row-check:checked'), function (checkbox) {
      return all[Number(checkbox.dataset.index)];
    }).filter(Boolean);
  }
  function save(options) {
    var pending = erpStorage.set(PRODUCT_KEY, all, options);
    renderShops();
    refreshFilteredView();
    return pending;
  }
  function openEdit(index, focusField) {
    editing = all[index];
    if (!editing) return;
    openProductEditor(editing, focusField);
    return;
    var shop = productShop(editing);
    var options = warehouseOptions(shop, editing);
    var selectedId = String((focusField === 'stock' && shop.defaultWarehouseId) || editing.stockWarehouseId || shop.defaultWarehouseId || '');
    var selectedName = String((focusField === 'stock' && shop.defaultWarehouseName) || editing.stockWarehouseName || shop.defaultWarehouseName || '');
    $('editSummary').innerHTML = '<b>' + esc(editing.name || '未命名商品') + '</b><br>货号 ' + esc(editing.article || '--') + '　SKU ' + esc(skuMask.mask(editing.sku || editing.id || '--'));
    $('editWarehouse').innerHTML = options.length ? ((!selectedId && !selectedName ? '<option value="">请选择库存仓库</option>' : '') + options.map(function (option) {
      var value = String(option.id || option.name || '');
      var label = option.name || ('仓库 ' + value);
      if (String(shop.defaultWarehouseId || '') === String(option.id || '') || (!shop.defaultWarehouseId && shop.defaultWarehouseName === option.name)) label += '（默认）';
      return '<option value="' + esc(value) + '" data-name="' + esc(option.name || '') + '">' + esc(label) + '</option>';
    }).join('')) : '<option value="">请先到店铺列表绑定默认仓库</option>';
    if (options.some(function (option) { return String(option.id || option.name || '') === selectedId; })) $('editWarehouse').value = selectedId;
    else if (selectedName) {
      var named = options.find(function (option) { return option.name === selectedName; });
      if (named) $('editWarehouse').value = String(named.id || named.name || '');
    }
    editInitialWarehouseId = focusField === 'stock' ? String(editing.stockWarehouseId || '') : $('editWarehouse').value;
    $('editWarehouseHint').textContent = shop.defaultWarehouseName ? '店铺默认仓库：' + shop.defaultWarehouseName + '；本次可改选其他仓库' : '当前店铺尚未绑定默认仓库';
    $('editPrice').value = inputRules.decimal(editing.priceSell || '');
    $('editOriginalPrice').value = inputRules.decimal(editing.priceOriginal || '');
    $('editLowestPrice').value = inputRules.decimal(editing.priceLowest || '');
    $('editPromoPrice').value = inputRules.decimal(editing.pricePromo || '');
    $('editStock').value = inputRules.integer(editing.stock == null ? '' : editing.stock);
    $('editModal').classList.add('show');
    if (focusField) window.setTimeout(function () {
      var input = $('editStock');
      if (input) { input.focus(); input.select(); }
    }, 0);
  }
  function openSourceEdit(index) {
    editing = all[index];
    if (!editing) return;
    openProductEditor(editing, 'source');
    return;
    $('sourceSummary').innerHTML = '<b>' + esc(editing.name || '未命名商品') + '</b><br>货号 ' + esc(editing.article || '--') + '　SKU ' + esc(skuMask.mask(editing.sku || editing.id || '--'));
    $('editPurchase').value = inputRules.decimal(editing.purchasePrice || '');
    $('editSource').value = editing.srcUrl || '';
    $('editSourcePrice').value = inputRules.decimal(editing.srcPrice || '');
    $('editNote').value = editing.srcNote || '';
    $('editShipping').value = inputRules.decimal(editing.domesticShipping || '');
    $('sourceModal').classList.add('show');
    window.setTimeout(function () { $('editSource').focus(); }, 0);
  }
  function close(id) { $(id).classList.remove('show'); }
  function productTaskName(action, product) {
    var article = String(product && product.article || '--');
    var sku = String(product && (product.sku || product.id) || '');
    return '在线商品' + action + ' · 货号 ' + article + (sku ? ' · SKU ' + skuMask.mask(sku) : '');
  }
  function productHistoryName(product) {
    var article = String(product && product.article || '--');
    var sku = String(product && (product.sku || product.id) || '');
    return '货号 ' + article + (sku ? ' · SKU ' + skuMask.mask(sku) : '');
  }
  function productDetailsHref(product) {
    if (!navRef) return '/pages/product-detail.html';
    return navRef.href('/pages/product-detail.html', { kind: 'product-detail', productId: String(product && product.id || ''), sku: String(product && product.sku || ''), shop: String(product && product.shop || ''), clientId: String(product && (product.clientId || product.shopId) || '') });
  }
  function productDetailsHrefWithParam(product, param) {
    var href = productDetailsHref(product);
    return href + (href.indexOf('?') === -1 ? '?' : '&') + param;
  }
  function openProductEditor(product, focusField) {
    var route = focusField ? productDetailsHrefWithParam(product, 'focus=' + encodeURIComponent(focusField)) : productDetailsHref(product);
    if (window.parent !== window && new URLSearchParams(location.search).get('workspace') === '1') {
      window.parent.postMessage({ type: 'wyerp-workspace-open', route: route, title: '商品编辑' }, location.origin);
    } else window.location.href = route;
  }
  function enqueueOperation(type, name, runner, metadata) {
    var task = syncProgress.begin(name + '：排队中', Object.assign({ type: type }, metadata || {}));
    operationQueue = operationQueue.catch(function () {}).then(function () {
      task.update(5, name + '：正在执行');
      return runner(task);
    }).then(function (message) {
      task.finish(message || (name + '：已完成'));
    }).catch(function (error) {
      var reason = error && error.message || '任务执行失败';
      task.fail(name + '：失败', reason);
    });
    toast(name + '已加入任务中心队列');
    return operationQueue;
  }
  function callOzon(shop, endpoint, body) {
    var command = erpStorage.ozonCommandForEndpoint(endpoint);
    var idempotencyKey = command.writes ? erpStorage.createIdempotencyKey() : '';
    return syncStream.requestJsonWithRetry(function () {
      return ozonWait(shop.clientId).then(function () {
        return erpStorage.request('/api/integrations/ozon/commands', {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
          body: JSON.stringify({ clientId: String(shop.clientId), command: command.name, body: body || {} })
        });
      });
    }, {
      maxRetries: 5,
      onStage: function (stage) {
        if (stage.phase === 'backoff') paintSyncProgress('OZON限流，' + Math.max(1, Math.ceil(stage.waitMs / 1000)) + ' 秒后自动重试');
      }
    }).catch(function (error) {
      error.message = endpoint + '：' + (error.message || 'OZON 请求失败');
      throw error;
    });
  }
  function priceValues(product) {
    var price = product && product._ozonPrice || {};
    return {
      sell: price.retail_price || product.price || '',
      original: price.old_price || product.old_price || '',
      lowest: price.min_price || product.min_ozon_price || product.min_price || '',
      promo: price.marketing_price || price.marketing_seller_price || product.marketing_price || product.marketing_seller_price || product.premium_price || '',
      currency: price.currency_code || product.priceCurrency || ''
    };
  }
  function updateOzonPrice(product, prices) {
    var shop = productShop(product);
    if (!shop.clientId || !shop.credentialsConfigured) return Promise.reject(new Error('当前商品所属店铺未配置有效凭证'));
    if (product.id == null || product.id === '') return Promise.reject(new Error('当前商品缺少 OZON 商品编号'));
    var payload = {
      product_id: Number(product.id),
      price: String(prices.sell),
      old_price: String(prices.original),
      min_price: String(prices.lowest),
      currency_code: 'CNY'
    };
    return callOzon(shop, '/v1/product/import/prices', { prices: [payload] }).then(function (data) {
      var rows = data && Array.isArray(data.result) ? data.result : [];
      var row = rows[0];
      if (row && row.updated === true) {
        return callOzon(shop, '/v5/product/info/prices', {
          filter: { product_id: [Number(product.id)], visibility: 'ALL' }, limit: 1, cursor: ''
        }).then(function (current) {
          return { update: row, currentPrice: current && current.items && current.items[0] && current.items[0].price || null };
        }).catch(function () { return { update: row, currentPrice: null }; });
      }
      var reasons = row && Array.isArray(row.errors) ? row.errors.map(function (error) { return error.message || error.code; }).filter(Boolean) : [];
      throw new Error(reasons.join('；') || 'OZON 未确认价格更新');
    });
  }
  function updateOzonStock(product, stock, warehouseId) {
    var shop = productShop(product);
    if (!shop.clientId || !shop.credentialsConfigured) return Promise.reject(new Error('当前商品所属店铺未配置有效凭证'));
    if (!warehouseId) return Promise.reject(new Error('请先选择库存仓库'));
    var throttleKey = String(shop.clientId) + '::' + String(warehouseId);
    var elapsed = Date.now() - Number(stockUpdateAt[throttleKey] || 0);
    if (elapsed < 120000) return Promise.reject(new Error('OZON 限制同一仓库库存 2 分钟内只能更新一次，请 ' + Math.ceil((120000 - elapsed) / 1000) + ' 秒后重试'));
    var payload = {
      offer_id: String(product.article || ''),
      stock: Number(stock),
      warehouse_id: Number(warehouseId)
    };
    if (product.id != null && product.id !== '') payload.product_id = Number(product.id);
    return callOzon(shop, '/v2/products/stocks', { stocks: [payload] }).then(function (data) {
      var rows = data && Array.isArray(data.result) ? data.result : [];
      var row = rows[0];
      if (row && row.updated === true) { stockUpdateAt[throttleKey] = Date.now(); return row; }
      var reasons = row && Array.isArray(row.errors) ? row.errors.map(function (error) { return error.message || error.code; }).filter(Boolean) : [];
      throw new Error(reasons.join('；') || 'OZON 未确认库存更新');
    });
  }
  function changeOzonArchiveState(items, restoring, task) {
    var grouped = {}, missing = [];
    items.forEach(function (item) {
      var shop = productShop(item);
      if (!shop.clientId || !shop.credentialsConfigured || item.id == null || item.id === '') {
        missing.push(item.name || item.sku || '商品');
        return;
      }
      (grouped[String(shop.clientId)] || (grouped[String(shop.clientId)] = { shop: shop, items: [] })).items.push(item);
    });
    if (missing.length) return Promise.reject(new Error('以下商品缺少店铺凭证或 OZON 商品编号：' + missing.join('、')));
    var groups = Object.keys(grouped).map(function (key) { return grouped[key]; });
    var action = restoring ? '恢复' : '归档';
    var endpoint = restoring ? '/v1/product/unarchive' : '/v1/product/archive';
    if (task) task.update(15, '正在向 OZON 提交商品' + action);
    return Promise.all(groups.map(function (group) {
      return callOzon(group.shop, endpoint, {
        product_id: group.items.map(function (item) { return Number(item.id); })
      }).then(function (data) {
        if (!data || data.result !== true) throw new Error('OZON 未确认商品' + action);
        return { successes: group.items, errors: [] };
      }).catch(function (error) {
        return { successes: [], errors: [group.shop.name + '：' + (error.message || action + '失败')] };
      });
    })).then(function (results) {
      var successes = [], errors = [];
      results.forEach(function (result) { successes = successes.concat(result.successes); errors = errors.concat(result.errors); });
      successes.forEach(function (item) {
        if (restoring) {
          item.archived = false;
          item.is_archived = false;
          item.status = item.statusBeforeArchive || '准备出售';
          item.statusReason = 'OZON 已确认从归档中恢复；恢复后仍需补充库存，销售状态以下次同步结果为准。';
          delete item.statusBeforeArchive;
        } else {
          if (item.status && item.status !== '已归档') item.statusBeforeArchive = item.status;
          item.archived = true;
          item.is_archived = true;
          item.status = '已归档';
        }
      });
      if (task) task.update(88, 'OZON 已处理，正在保存' + action + '状态');
      return (successes.length ? save() : Promise.resolve()).then(function () {
        var message = '商品' + action + '完成：成功 ' + successes.length + ' 件';
        if (errors.length) throw new Error(message + '，失败 ' + errors.length + ' 家店铺；' + errors.join('；'));
        return message;
      });
    });
  }
  function archiveOzonProducts(items, task) { return changeOzonArchiveState(items, false, task); }
  function restoreOzonProducts(items, task) { return changeOzonArchiveState(items, true, task); }
  function batchUpdateOzonStock(items, stock, task) {
    var missing = [], grouped = {};
    items.forEach(function (item) {
      var shop = productShop(item);
      if (!shop.clientId || !shop.credentialsConfigured || !shop.defaultWarehouseId) {
        missing.push(item.shop || '未知店铺');
        return;
      }
      var key = String(shop.clientId) + '::' + String(shop.defaultWarehouseId);
      (grouped[key] || (grouped[key] = { key: key, shop: shop, warehouseId: String(shop.defaultWarehouseId), warehouseName: shop.defaultWarehouseName || '', items: [] })).items.push(item);
    });
    if (missing.length) {
      return Promise.reject(new Error('批量修改库存前，请先为这些店铺绑定默认仓库：' + missing.filter(function (name, index, values) { return values.indexOf(name) === index; }).join('、')));
    }
    var groups = Object.keys(grouped).map(function (key) { return grouped[key]; });
    var cooling = groups.find(function (group) { return Date.now() - Number(stockUpdateAt[group.key] || 0) < 120000; });
    if (cooling) {
      var wait = Math.ceil((120000 - (Date.now() - Number(stockUpdateAt[cooling.key] || 0))) / 1000);
      return Promise.reject(new Error('店铺「' + cooling.shop.name + '」默认仓库刚更新过库存，请 ' + wait + ' 秒后重试'));
    }
    if (task) task.update(15, '正在按店铺默认仓库批量更新 OZON 库存');
    return Promise.all(groups.map(function (group) {
      var payload = group.items.map(function (item) {
        var row = { offer_id: String(item.article || ''), stock: Number(stock), warehouse_id: Number(group.warehouseId) };
        if (item.id != null && item.id !== '') row.product_id = Number(item.id);
        return row;
      });
      return callOzon(group.shop, '/v2/products/stocks', { stocks: payload }).then(function (data) {
        var rows = data && Array.isArray(data.result) ? data.result : [];
        var successes = [], errors = [];
        rows.forEach(function (row) {
          var product = group.items.find(function (item) {
            return (row.offer_id && String(item.article || '') === String(row.offer_id)) || (row.product_id != null && String(item.id) === String(row.product_id));
          });
          if (row.updated === true && product) successes.push(product);
          else {
            var reasons = Array.isArray(row.errors) ? row.errors.map(function (error) { return error.message || error.code; }).filter(Boolean) : [];
            errors.push((row.offer_id || row.product_id || '商品') + '：' + (reasons.join('；') || '更新失败'));
          }
        });
        if (!rows.length) errors.push(group.shop.name + '：OZON 未返回更新结果');
        if (successes.length) stockUpdateAt[group.key] = Date.now();
        return { group: group, successes: successes, errors: errors };
      }).catch(function (error) {
        return { group: group, successes: [], errors: [group.shop.name + '：' + (error.message || '更新失败')] };
      });
    })).then(function (results) {
      var successes = [], errors = [];
      results.forEach(function (result) {
        result.successes.forEach(function (item) {
          item._manual = item._manual || {};
          item.stock = Number(stock);
          item.stockWarehouseId = result.group.warehouseId;
          item.stockWarehouseName = result.group.warehouseName;
          item._manual.stock = item._manual.stockWarehouseId = item._manual.stockWarehouseName = true;
          rememberManual(item);
          successes.push(item);
        });
        errors = errors.concat(result.errors);
      });
      var pending = successes.length ? save() : Promise.resolve();
      return pending.then(function () {
        var message = '批量库存更新完成：成功 ' + successes.length + ' 件';
        if (errors.length) message += '，失败 ' + errors.length + ' 件；' + errors.join('；');
        if (errors.length) throw new Error(message);
        return message;
      });
    });
  }
  function batchUpdateOzonPrice(items, price, task) {
    var grouped = {}, missing = [];
    items.forEach(function (item) {
      var shop = productShop(item);
      if (!shop.clientId || !shop.credentialsConfigured || item.id == null || item.id === '') {
        missing.push(item.name || item.sku || '商品');
        return;
      }
      (grouped[String(shop.clientId)] || (grouped[String(shop.clientId)] = { shop: shop, items: [] })).items.push(item);
    });
    if (missing.length) return Promise.reject(new Error('以下商品缺少店铺凭证或 OZON 商品编号：' + missing.join('、')));
    var groups = Object.keys(grouped).map(function (key) { return grouped[key]; });
    if (task) task.update(15, '正在按店铺批量更新 OZON 销售价');
    return Promise.all(groups.map(function (group) {
      var payload = group.items.map(function (item) {
        return {
          product_id: Number(item.id), price: String(price),
          old_price: String(item.priceOriginal || ''), min_price: String(item.priceLowest || ''),
          currency_code: 'CNY'
        };
      });
      return callOzon(group.shop, '/v1/product/import/prices', { prices: payload }).then(function (data) {
        var rows = data && Array.isArray(data.result) ? data.result : [], successes = [], errors = [];
        rows.forEach(function (row) {
          var product = group.items.find(function (item) {
            return (row.offer_id && String(item.article || '') === String(row.offer_id)) || (row.product_id != null && String(item.id) === String(row.product_id));
          });
          if (row.updated === true && product) successes.push(product);
          else {
            var reasons = Array.isArray(row.errors) ? row.errors.map(function (error) { return error.message || error.code; }).filter(Boolean) : [];
            errors.push((row.offer_id || row.product_id || '商品') + '：' + (reasons.join('；') || '价格更新失败'));
          }
        });
        if (!rows.length) errors.push(group.shop.name + '：OZON 未返回价格更新结果');
        return { successes: successes, errors: errors };
      }).catch(function (error) { return { successes: [], errors: [group.shop.name + '：' + (error.message || '更新失败')] }; });
    })).then(function (results) {
      var successes = [], errors = [];
      results.forEach(function (result) {
        result.successes.forEach(function (item) {
          item._manual = item._manual || {};
          item.priceSell = String(price);
          item._manual.priceSell = true;
          rememberManual(item);
          successes.push(item);
        });
        errors = errors.concat(result.errors);
      });
      return (successes.length ? save() : Promise.resolve()).then(function () {
        var message = '批量售价更新完成：成功 ' + successes.length + ' 件';
        if (errors.length) throw new Error(message + '，失败 ' + errors.length + ' 件；' + errors.join('；'));
        return message;
      });
    });
  }
  function mapOzonStatus(product) {
    return statusModel.derive(product);
  }
  function convert(shop, product, old) {
    return productSyncMap.convert(shop, product, old, {
      category: erpStorage.get(CATEGORY_KEY) || {},
      logisticsScheme: myLogisticsScheme,
      manualEntries: erpStorage.get(MANUAL_KEY),
      orders: erpStorage.get(ORDER_KEY)
    });
  }  function paintSyncProgress(message) {
    renderShops();
    refreshFilteredView();
    if (message) lastTask = message;
  }
  function fetchProductIds(shop, visibility) {
    var ids = [], seen = {}, lastId = '', pageCount = 0;
    function next() {
      return callOzon(shop, '/v3/product/list', {
        filter: { visibility: visibility }, last_id: lastId, limit: 1000
      }).then(function (data) {
        var result = data && data.result || {};
        var items = Array.isArray(result.items) ? result.items : [];
        items.forEach(function (item) {
          var id = item && item.product_id;
          if (id != null && !seen[String(id)]) { seen[String(id)] = true; ids.push(id); }
        });
        var nextId = String(result.last_id || '');
        pageCount += 1;
        if (items.length && nextId && nextId !== lastId && pageCount < 100) {
          lastId = nextId;
          return next();
        }
        return ids;
      });
    }
    return next();
  }
  function syncShop(shop, ids, onProgress) {
    var originalAll = all.slice();
    var archivedIdMap = {};
    var warehousePromise = callOzon(shop, '/v2/warehouse/list', { limit: 200 }).then(function (data) {
      var mode = productFormat.warehouseMode((data && (data.warehouses || data.result)) || [], DEFAULT_FULFILLMENT_SCHEMA);
      shop.fulfillmentSchema = mode.schema || DEFAULT_FULFILLMENT_SCHEMA;
      shop.fulfillmentWarehouseNames = mode.names;
      shop.warehouseOptions = mode.options;
      shop.warehouse = mode.options.length;
      if (shop.defaultWarehouseId && !mode.options.some(function (option) { return String(option.id) === String(shop.defaultWarehouseId); })) {
        shop.defaultWarehouseId = '';
        shop.defaultWarehouseName = '';
      }
      return erpStorage.set(SHOP_KEY, getShops()).then(function () { return shop.fulfillmentSchema; });
    }).catch(function () {
      shop.fulfillmentSchema = shop.fulfillmentSchema || DEFAULT_FULFILLMENT_SCHEMA;
      return shop.fulfillmentSchema;
    });
    return warehousePromise.then(function () {
      if (ids && ids.length) return ids;
      return fetchProductIds(shop, 'ALL').then(function (currentIds) {
        paintSyncProgress('正在同步 ' + shop.name + '，正在获取已归档商品…');
        return fetchProductIds(shop, 'ARCHIVED').then(function (archivedIds) {
          var seen = {};
          archivedIds.forEach(function (id) { archivedIdMap[String(id)] = true; });
          return currentIds.concat(archivedIds).filter(function (id) {
            if (seen[String(id)]) return false;
            seen[String(id)] = true;
            return true;
          });
        });
      });
    }).then(function (productIds) {
      var oldMap = {}, seenKeys = {}, received = 0, processed = 0, chain = Promise.resolve();
      all.forEach(function (item) { oldMap[productKey(item)] = item; });
      if (!ids) {
        paintSyncProgress('正在同步 ' + shop.name + '，等待商品详情…');
      }
      for (var i = 0; i < productIds.length; i += 100) {
        (function (batch) {
          chain = chain.then(function () {
            var needsPrices = batch.some(function (id) { return !archivedIdMap[String(id)]; });
            return Promise.all([
              callOzon(shop, '/v3/product/info/list', { product_id: batch, limit: 100, sort_dir: 'ASC' }),
              needsPrices
                ? callOzon(shop, '/v5/product/info/prices', { filter: { product_id: batch, visibility: 'ALL' }, limit: 100, cursor: '' }).catch(function () { return { items: [] }; })
                : Promise.resolve({ items: [] }),
              callOzon(shop, '/v4/product/info/attributes', { filter: { product_id: batch, visibility: 'ALL' }, limit: 100, last_id: '', sort_dir: 'ASC' }).catch(function () { return { result: [] }; })
            ]).then(function (responses) {
              var items = responses[0].items || [];
              var priceItems = responses[1].items || [];
              var attributeItems = responses[2].result || responses[2].items || [];
              var pricesById = {}, pricesByOffer = {}, attributesById = {}, attributesByOffer = {};
              priceItems.forEach(function (item) {
                if (item.product_id != null) pricesById[String(item.product_id)] = item.price || {};
                if (item.offer_id) pricesByOffer[String(item.offer_id)] = item.price || {};
              });
              attributeItems.forEach(function (item) {
                if (item.id != null) attributesById[String(item.id)] = item;
                if (item.offer_id) attributesByOffer[String(item.offer_id)] = item;
              });
              return syncStream.each(items, function (item) {
                processed += 1;
                if (!statusModel.shouldInclude(item)) {
                  all = all.filter(function (current) {
                    return !(current.shop === shop.name && String(current.id) === String(item.id));
                  });
                  return;
                }
                item._ozonPrice = pricesById[String(item.id)] || pricesByOffer[String(item.offer_id)] || {};
                item._ozonAttributes = attributesById[String(item.id)] || attributesByOffer[String(item.offer_id)] || null;
                var converted = convert(shop, item, oldMap[shop.name + '::' + String(item.id)]);
                var key = productKey(converted);
                seenKeys[key] = true;
                var existingIndex = all.findIndex(function (current) { return productKey(current) === key; });
                if (existingIndex >= 0) all[existingIndex] = converted;
                else all.push(converted);
                received += 1;
              }, function () {
                var message = '正在同步 ' + shop.name + '：已处理 ' + processed + '/' + productIds.length + '，已显示 ' + received + ' 个商品';
                return erpStorage.set(PRODUCT_KEY, all, { source: 'sync' }).then(function () {
                  paintSyncProgress(message);
                  if (onProgress) onProgress(processed, productIds.length, message);
                });
              });
            });
          });
        })(productIds.slice(i, i + 100));
      }
      return chain.then(function () {
        if (!ids) {
          all = all.filter(function (item) { return item.shop !== shop.name || seenKeys[productKey(item)]; });
        }
        return erpStorage.set(PRODUCT_KEY, all, { source: 'sync' }).then(function () { return received; });
      });
    }).catch(function (error) {
      all = originalAll;
      return erpStorage.set(PRODUCT_KEY, all, { source: 'sync' }).then(function () {
        paintSyncProgress('同步 ' + shop.name + ' 失败，已恢复同步前数据');
        throw error;
      });
    });
  }
  function openSync(mode) {
    syncMode=mode;
    var items=selected(),wanted={};
    if(mode==='selected'){
      if(!items.length){toast('请先勾选要同步的商品');return;}
      items.forEach(function(item){wanted[item.shop]=true;});
    }
    var shops=getShops().filter(function(shop){return shop&&shop.clientId&&(mode==='all'||wanted[shop.name]);});
    if(!shops.length){toast('没有可同步的店铺，请先在店铺管理中添加 Ozon 店铺');return;}
    $('shopModalTitle').textContent=mode==='all'?'选择要同步的店铺':'同步所选商品';
    $('shopChoices').innerHTML=shops.map(function(shop){
      var resource=shop.credentialsConfigured?'官方API服务器同步':'需配置Ozon API密钥';
      return '<label class="shop-option"><input type="checkbox" value="'+esc(shop.name)+'" checked><span>'+esc(shop.name)+'</span><small>'+esc(resource)+'</small></label>';
    }).join('');
    $('shopAll').checked=true;
    $('shopModal').classList.add('show');
  }
  function startSync() {
    if (syncing) return;
    var names = Array.prototype.map.call($('shopChoices').querySelectorAll('input:checked'), function (checkbox) { return checkbox.value; });
    if (!names.length) { toast('请选择至少一个店铺'); return; }
    close('shopModal');
    var byShop = {};
    selected().forEach(function (item) { (byShop[item.shop] || (byShop[item.shop] = [])).push(String(item.id)); });
    var entries = [];
    for (var i = 0; i < names.length; i += 1) {
      var shop = getShops().find(function (item) { return item.name === names[i]; });
      if (!shop || !shop.clientId) { toast('所选店铺已变化，请重新选择店铺'); return; }
      var ids = syncMode === 'selected' ? (byShop[shop.name] || []) : [];
      if (syncMode === 'selected' && !ids.length) { toast('所选商品与店铺范围不一致，请重新选择商品'); return; }
      entries.push({ shop: shop, clientId: String(shop.clientId), productIds: ids });
    }
    syncing = true;
    lastTask = '商品同步进行中';
    $('syncAllBtn').disabled = $('syncSelectedBtn').disabled = true;
    var progressButton = syncMode === 'selected' ? $('syncSelectedBtn') : $('syncAllBtn');
    var taskProgress = syncProgress.begin('在线商品同步：正在提交官方API服务器任务');
    progressButton.textContent = '正在提交服务器任务';
    var serverItems = entries.filter(function (entry) { return entry.shop.credentialsConfigured === true; })
      .map(function (entry) { return { clientId: entry.clientId, productIds: entry.productIds }; });
    var unavailable = entries.filter(function (entry) { return entry.shop.credentialsConfigured !== true; })
      .map(function (entry) { return entry.shop.name + '：请先在店铺管理配置Ozon官方API密钥'; });
    var serverTasks = [], serverSkipped = [], serverEnqueueError = '';
    return Promise.resolve().then(function () {
      if (!serverItems.length) throw new Error('所选店铺均未配置Ozon官方API密钥，请先到店铺管理完成配置。');
      return erpStorage.request('/api/products/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: syncMode, items: serverItems, batchId: taskProgress.id })
      });
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        serverSkipped = Array.isArray(data.skipped) ? data.skipped : [];
        serverTasks = Array.isArray(data.items) ? data.items : [];
        if (!response.ok && !serverTasks.length) throw serverFailure(data, '服务器商品同步入队失败，请到任务中心查看。');
        if (!response.ok && serverTasks.length) {
          serverEnqueueError = serverChineseMessage(data, '部分店铺未能进入服务器同步队列，请检查店铺授权。');
          unavailable.push(serverEnqueueError);
        }
        if (!serverTasks.length && serverSkipped.length) return;
        if (!serverTasks.length) throw serverFailure(data, '服务器没有返回同步任务，请到任务中心核对。');
        taskProgress.update(10, '正在使用官方API同步 ' + serverTasks.length + ' 家店铺');
        return syncStream.watchTasks(serverTasks, { onChange: function (tasks) {
          var done = tasks.filter(function (task) { return task && task.status !== 'running'; }).length;
          taskProgress.update(10 + Math.floor(done / Math.max(1, tasks.length) * 85),
            '官方API同步：已完成 ' + done + '/' + tasks.length + ' 家店铺');
        } }).then(function (tasks) {
          tasks.filter(function (task) { return task && task.status === 'failed'; })
            .forEach(function (task) {
              unavailable.push('店铺：' + serverChineseMessage({ message: task.reason }, '服务器同步失败，请到任务中心核对。'));
            });
        });
      });
    }).then(function () {
      return erpStorage.reload([PRODUCT_KEY]).then(function () {
        var readFailure = erpStorage.getLoadFailure && erpStorage.getLoadFailure(PRODUCT_KEY);
        if (readFailure) throw new Error('在线商品数据重新读取失败：' + readFailure);
      });
    }).then(function () {
      if (serverSkipped.length) unavailable = unavailable.concat(serverSkipped.map(function (item) {
        return '店铺：' + serverChineseMessage({ message: item.reason }, '服务器暂不可用，请检查店铺授权。');
      }));
      all = Array.isArray(erpStorage.get(PRODUCT_KEY)) ? erpStorage.get(PRODUCT_KEY) : all;
      renderShops(); refreshFilteredView();
      var summary = '在线商品同步完成（官方API）：' + serverTasks.length + ' 家店铺';
      if (unavailable.length) {
        lastTask = summary + '，未完成 ' + unavailable.length + ' 家';
        taskProgress.fail(lastTask, unavailable.join('；'));
        toast(lastTask + (serverEnqueueError ? '，仍有未入队店铺，请查看任务中心' : ''));
      } else {
        lastTask = summary + '，已完成';
        taskProgress.finish(lastTask);
        toast(lastTask);
      }
    }).catch(function (error) {
      lastTask = '商品同步失败';
      var reason = serverChineseMessage({ message: error && error.message }, '商品同步入队请求失败，请检查网络后重试或到任务中心核对。');
      taskProgress.fail(lastTask, reason);
      toast(lastTask + '：' + reason);
    }).finally(function () {
      syncing = false;
      $('syncAllBtn').disabled = $('syncSelectedBtn').disabled = false;
      $('syncAllBtn').textContent = '⇅ 同步所有商品';
      $('syncSelectedBtn').textContent = '☁ 同步所选商品';
    });
  }
  function batch(kind) {
    var items = selected();
    if (!items.length) { toast('请先勾选商品'); return; }
    if (kind === 'archive') {
      var archivedCount = items.filter(function (item) { return normalizeStatus(item) === 'archived'; }).length;
      if (archivedCount && archivedCount !== items.length) { toast('归档商品与在线商品不能混合操作'); return; }
      var restoring = archivedCount === items.length;
      var action = restoring ? '恢复' : '归档';
      if (!confirm('确定' + action + '选中的 ' + items.length + ' 件商品？')) return;
      enqueueOperation('archive', '在线商品批量' + action + ' · ' + items.length + ' 件', function (task) {
        return restoring ? restoreOzonProducts(items, task) : archiveOzonProducts(items, task);
      });
      return;
    }
    var label = kind === 'price' ? '售价' : '库存';
    var value = prompt('请输入新的' + label);
    if (value == null || String(value).trim() === '') return;
    value = kind === 'price' ? inputRules.decimal(value) : inputRules.integer(value);
    if (value === '') { toast(kind === 'price' ? '售价必须是数字，最多两位小数' : '库存必须是非负整数'); return; }
    if (kind === 'stock') {
      enqueueOperation('edit', '在线商品批量库存修改 · ' + items.length + ' 件', function (task) {
        return batchUpdateOzonStock(items, Number(value), task);
      });
      return;
    }
    enqueueOperation('edit', '在线商品批量售价修改 · ' + items.length + ' 件', function (task) {
      return batchUpdateOzonPrice(items, value, task);
    });
  }
  function clearSyncedData() {
    if (!confirm('确定清除在线商品同步/测试数据？货源地址、货源价格、货源备注、采购价、快递费以及标记为手工修改的售价和库存会单独保留，重新同步后自动写回。')) return;
    var cleared = manualModel.clearSynced(all, erpStorage.get(MANUAL_KEY));
    erpStorage.set(MANUAL_KEY, cleared.manual).then(function () {
      return erpStorage.request('/api/system/clear-page-data', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 'online-products' })
      });
    }).then(function (response) {
      if (!response.ok) return response.json().catch(function () { return {}; }).then(function (data) { throw serverFailure(data, '页面数据清除失败或结果无法确认，请刷新页面核对后重试。'); });
      location.reload();
    }).catch(function (error) { toast(error && error.trustedMessage === true ? error.message : '页面数据清除未完成或结果无法确认，请刷新页面核对后重试。'); });
  }
  function bindEvents() {
    var zoomEl = document.createElement('div');
    zoomEl.id = 'img-zoom';
    document.body.appendChild(zoomEl);
    function moveZoom(event) {
      if (zoomEl.style.display !== 'block') return;
      var previewSize = 400, padding = 12;
      var left = event.clientX + 18, top = event.clientY + 18;
      if (left + previewSize > window.innerWidth - padding) left = event.clientX - previewSize - 18;
      if (top + previewSize > window.innerHeight - padding) top = event.clientY - previewSize - 18;
      zoomEl.style.left = Math.max(padding, left) + 'px';
      zoomEl.style.top = Math.max(padding, top) + 'px';
    }
    $('productBody').addEventListener('mouseover', function (event) {
      var image = event.target.closest && event.target.closest('img.product-image');
      if (!image || !image.src) return;
      var preview = image.cloneNode(false);
      preview.removeAttribute('onerror');
      zoomEl.innerHTML = '';
      zoomEl.appendChild(preview);
      zoomEl.style.display = 'block';
      moveZoom(event);
    });
    $('productBody').addEventListener('mouseout', function (event) {
      if (event.target.closest && event.target.closest('img.product-image')) zoomEl.style.display = 'none';
    });
    $('productBody').addEventListener('mousemove', moveZoom);
    $('productBody').addEventListener('mouseover', function (event) {
      var trigger = event.target.closest && event.target.closest('.status-trigger');
      if (trigger && !trigger.contains(event.relatedTarget)) showStatusTooltip(trigger);
    });
    $('productBody').addEventListener('mouseout', function (event) {
      var trigger = event.target.closest && event.target.closest('.status-trigger');
      if (trigger && !trigger.contains(event.relatedTarget) && !$('statusTooltip').contains(event.relatedTarget)) hideStatusTooltip(trigger, true);
    });
    $('productBody').addEventListener('focusin', function (event) { var trigger = event.target.closest && event.target.closest('.status-trigger'); if (trigger) showStatusTooltip(trigger); });
    $('productBody').addEventListener('focusout', function (event) { var trigger = event.target.closest && event.target.closest('.status-trigger'); if (trigger && !$('statusTooltip').contains(event.relatedTarget)) hideStatusTooltip(trigger, true); });
    $('statusTooltip').addEventListener('mouseenter', function () { if (statusHideTimer) { window.clearTimeout(statusHideTimer); statusHideTimer = null; } });
    $('statusTooltip').addEventListener('mouseleave', function () { hideStatusTooltip(activeStatusTrigger, true); });
    $('statusTooltip').addEventListener('focusout', function (event) { if (!this.contains(event.relatedTarget)) hideStatusTooltip(activeStatusTrigger, true); });
    document.querySelector('.table-wrap').addEventListener('scroll', function () { hideStatusTooltip(); }, { passive: true });
    $('searchBtn').onclick = function () { page = 1; refreshFilteredView(); };
    $('keywordFilter').onkeydown = function (event) { if (event.key === 'Enter') $('searchBtn').click(); };
    // 本地数据列表：输入即模糊筛选（规范 6.1），查询按钮与回车仍然保留。
    $('keywordFilter').addEventListener('input', function () { page = 1; syncKeywordClearButton(); refreshFilteredView(); });
    $('keywordClearBtn').onclick = function () { $('keywordFilter').value = ''; page = 1; syncKeywordClearButton(); refreshFilteredView(); $('keywordFilter').focus(); };
    syncKeywordClearButton();
    $('shopFilter').onchange = function () { page = 1; refreshFilteredView(); };
    $('pageSize').onchange = function () { size = Number(this.value); page = 1; applyFilter(); };
    $('checkAll').onchange = function () { var checked = this.checked; document.querySelectorAll('.row-check').forEach(function (box) { box.checked = checked; }); };
    $('statusBar').onclick = function (event) {
      var tab = event.target.closest('[data-status]');
      if (tab) { status = tab.dataset.status; page = 1; refreshFilteredView(); }
    };
    $('autoSyncBtn').onclick = function () { toast('自动同步任务将在任务中心启用，当前不会伪造后台任务。'); };
    ['existSalesFilter', 'existSourceFilter', 'existLowestFilter', 'existCostFilter'].forEach(function (id) {
      $(id).onchange = function () { page = 1; refreshFilteredView(); };
    });
    ['salesMinFilter', 'salesMaxFilter', 'commissionMinFilter', 'commissionMaxFilter'].forEach(function (id) {
      $(id).onchange = function () { page = 1; refreshFilteredView(); };
      $(id).addEventListener('keydown', function (event) { if (event.key === 'Enter') $('searchBtn').click(); });
    });
    document.addEventListener('input', captureRangeInput, true);
    document.addEventListener('compositionend', captureRangeInput, true);
    $('pager').onclick = function (event) { var button = event.target.closest('[data-page]'); if (button && !button.disabled) { page = Number(button.dataset.page); renderTable(); } };
    $('productBody').onclick = function (event) {
      var inlineCopy = event.target.closest('[data-inline-copy]');
      if (inlineCopy) { copyText(inlineCopy.dataset.inlineCopy, inlineCopy.dataset.copyLabel, inlineCopy); return; }
      var quickEdit = event.target.closest('[data-quick-edit]');
      if (quickEdit) { if (requireProductWrite()) openEdit(Number(quickEdit.dataset.index), quickEdit.dataset.quickEdit); return; }
      var sourceEdit = event.target.closest('[data-source-edit]');
      if (sourceEdit) { if (requireProductWrite()) openSourceEdit(Number(sourceEdit.dataset.sourceEdit)); return; }
      var edit = event.target.closest('[data-edit]'), archive = event.target.closest('[data-archive]'), restore = event.target.closest('[data-restore]'), historyButton = event.target.closest('[data-product-history]');
      if (historyButton) {
        var historyProduct = all[Number(historyButton.dataset.productHistory)];
        if (historyProduct) entityHistory.open(historyProduct, productHistoryName(historyProduct));
        return;
      }
      if (edit && requireProductWrite()) openEdit(Number(edit.dataset.edit));
      if (archive && requireProductWrite()) {
        var product = all[Number(archive.dataset.archive)];
        if (product && confirm('确定归档商品【' + (product.name || product.sku) + '】？')) {
          enqueueOperation('archive', productTaskName('归档', product), function (task) {
            return archiveOzonProducts([product], task);
          }, { article: product.article || '', sku: product.sku || product.id || '' });
        }
      }
      if (restore && requireProductWrite()) {
        var archivedProduct = all[Number(restore.dataset.restore)];
        if (archivedProduct && confirm('确定恢复商品【' + (archivedProduct.name || archivedProduct.sku) + '】？恢复后仍需补充库存才能重新销售。')) {
          enqueueOperation('archive', productTaskName('恢复', archivedProduct), function (task) {
            return restoreOzonProducts([archivedProduct], task);
          }, { article: archivedProduct.article || '', sku: archivedProduct.sku || archivedProduct.id || '' });
        }
      }
    };
    $('saveEditBtn').onclick = function () {
      if (!requireProductWrite() || !editing) return;
      var warehouseOption = $('editWarehouse').options[$('editWarehouse').selectedIndex];
      var warehouseId = warehouseOption ? warehouseOption.value : '';
      var warehouseName = warehouseOption ? (warehouseOption.dataset.name || warehouseOption.textContent.replace(/（默认）$/, '')) : '';
      var stockText = inputRules.integer($('editStock').value);
      var stock = Number(stockText);
      if (!Number.isFinite(stock) || stock < 0) { toast('库存必须是非负整数'); return; }
      var desiredPrices = {
        sell: inputRules.decimal($('editPrice').value),
        original: inputRules.decimal($('editOriginalPrice').value),
        lowest: inputRules.decimal($('editLowestPrice').value)
      };
      var priceChanged = desiredPrices.sell !== inputRules.decimal(editing.priceSell || '') ||
        desiredPrices.original !== inputRules.decimal(editing.priceOriginal || '') ||
        desiredPrices.lowest !== inputRules.decimal(editing.priceLowest || '');
      if (priceChanged && !desiredPrices.sell) { toast('销售价不能为空'); return; }
      var stockChanged = stock !== Number(editing.stock) || warehouseId !== editInitialWarehouseId;
      if (stockChanged && !warehouseId) { toast('修改库存前请先选择仓库'); return; }
      if (!priceChanged && !stockChanged) { close('editModal'); toast('价格与库存没有变化'); return; }
      var target = editing;
      close('editModal');
      enqueueOperation('edit', productTaskName('修改', target), function (task) {
        task.update(15, '正在向 OZON 提交价格和库存变更');
        var priceTask = priceChanged ? updateOzonPrice(target, desiredPrices).then(function (value) { return { type: 'price', ok: true, value: value }; }).catch(function (error) { return { type: 'price', ok: false, error: error }; }) : Promise.resolve({ type: 'price', ok: true, skipped: true });
        var stockTask = stockChanged ? updateOzonStock(target, stock, warehouseId).then(function (value) { return { type: 'stock', ok: true, value: value }; }).catch(function (error) { return { type: 'stock', ok: false, error: error }; }) : Promise.resolve({ type: 'stock', ok: true, skipped: true });
        return Promise.all([priceTask, stockTask]).then(function (results) {
          var priceResult = results[0], stockResult = results[1], failures = [];
          target._manual = target._manual || {};
          if (priceChanged && priceResult.ok) {
            [['priceSell', 'sell'], ['priceOriginal', 'original'], ['priceLowest', 'lowest']].forEach(function (pair) {
              if (inputRules.decimal(target[pair[0]] || '') !== desiredPrices[pair[1]]) target._manual[pair[0]] = true;
              target[pair[0]] = desiredPrices[pair[1]];
            });
            if (priceResult.value && priceResult.value.currentPrice) {
              target.pricePromo = priceResult.value.currentPrice.marketing_price || priceResult.value.currentPrice.marketing_seller_price || '';
              target.priceCurrency = priceResult.value.currentPrice.currency_code || target.priceCurrency || '';
            }
          } else if (!priceResult.ok) failures.push('价格：' + (priceResult.error.message || '更新失败'));
          if (stockChanged && stockResult.ok) {
            target.stock = stock;
            target._manual.stock = true;
            target.stockWarehouseId = warehouseId;
            target.stockWarehouseName = warehouseName;
            target._manual.stockWarehouseId = target._manual.stockWarehouseName = true;
          } else if (!stockResult.ok) failures.push('库存：' + (stockResult.error.message || '更新失败'));
          var hasSuccess = (priceChanged && priceResult.ok) || (stockChanged && stockResult.ok);
          if (hasSuccess) rememberManual(target);
          task.update(88, 'OZON 已处理，正在保存 ERP 数据');
          return (hasSuccess ? save() : Promise.resolve()).then(function () {
            if (failures.length) throw new Error(failures.join('；'));
            if (priceChanged && stockChanged) return 'OZON 价格与库存均已更新';
            if (priceChanged) return 'OZON 价格已更新';
            return 'OZON 库存已更新';
          });
        });
      }, { article: target.article || '', sku: target.sku || target.id || '' });
    };
    $('saveSourceBtn').onclick = function () {
      if (!requireProductWrite() || !editing) return;
      var sourceButton = $('saveSourceBtn');
      sourceButton.disabled = true;
      var profile = {
        purchasePrice: inputRules.decimal($('editPurchase').value), srcUrl: $('editSource').value.trim(),
        srcPrice: inputRules.decimal($('editSourcePrice').value), srcNote: $('editNote').value.trim(),
        domesticShipping: inputRules.decimal($('editShipping').value)
      };
      erpStorage.request('/api/domain/commands/source-boundary', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update-product-source', clientId: editing.clientId || editing.shopId || editing.shop || '', productId: editing.id || editing.productId || editing.article || editing.offer_id || '', sku: editing.sku || '', profile: profile })
      }).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw serverFailure(data, '货源信息保存失败或结果无法确认，请刷新列表核对后重试。');
          list = erpStorage.acceptServerPayload(PRODUCT_KEY, data.products || [], data.versions && data.versions.erp_online_products);
          erpStorage.acceptServerPayload(ORDER_KEY, data.orders || [], data.versions && data.versions.erp_orders_data);
          render();
          return Number(data.result && data.result.linkedOrders || 0);
        });
      }).then(function (linkedCount) {
        close('sourceModal');
        toast(linkedCount ? '货源信息已保存，同SKU订单货源已对应' : '货源信息已保存');
      }).catch(function (error) {
        toast(error && error.trustedMessage === true ? error.message : '货源信息保存失败或结果无法确认，请刷新列表核对后重试。');
      }).then(function () { sourceButton.disabled = false; });
    };
    document.querySelectorAll('[data-close]').forEach(function (button) { button.onclick = function () { close(this.dataset.close); }; });
    $('syncAllBtn').onclick = function () { if (requireProductWrite()) openSync('all'); };
    $('syncSelectedBtn').onclick = function () { if (requireProductWrite()) openSync('selected'); };
    $('confirmSyncBtn').onclick = function () { if (requireProductWrite()) startSync(); };
    $('shopAll').onchange = function () { var checked = this.checked; $('shopChoices').querySelectorAll('input').forEach(function (box) { box.checked = checked; }); };
    $('batchBtn').onclick = function () { if (requireProductWrite()) $('batchWrap').classList.toggle('open'); };
    $('batchWrap').onclick = function (event) { var button = event.target.closest('[data-batch]'); if (button && requireProductWrite()) { $('batchWrap').classList.remove('open'); batch(button.dataset.batch); } };
    $('adminClearBtn').onclick = clearSyncedData;
    document.addEventListener('click', function (event) { if (!$('batchWrap').contains(event.target)) $('batchWrap').classList.remove('open'); });
  }
  function applyNavigationTarget() {
    var search = new URLSearchParams(location.search), target = navRef ? navRef.fromSearch(location.search) : null;
    if ((!target || target.kind !== 'online-product-filter') && search.get('sku')) {
      target = { kind: 'online-product-filter', sku: String(search.get('sku') || '') };
      if (navRef) { var safeRoute = navRef.href(location.pathname, target); if (safeRoute) history.replaceState(null, '', safeRoute); }
    }
    if (!target || target.kind !== 'online-product-filter') return;
    var keyword = String(target.sku || target.productId || '').trim();
    if (keyword && $('keywordFilter')) $('keywordFilter').value = keyword;
  }
  function activeEditRows() {
    return all.filter(function (item) {
      var state = item && item.ozonEdit;
      return state && state.queueId && ['queued','preparing','submitting','pending'].indexOf(state.phase) >= 0 &&
        String(item.clientId || item.shopId || '') && String(item.id || item.productId || '');
    });
  }
  function scheduleEditWatch(delay) {
    if (editWatchTimer) clearTimeout(editWatchTimer);
    editWatchTimer = null;
    if (document.visibilityState === 'hidden') return;
    if (!activeEditRows().length) { editWatchDelay = 3000; return; }
    editWatchTimer = setTimeout(refreshEditStates, delay == null ? editWatchDelay : delay);
  }
  function refreshEditStates() {
    if (editWatchBusy) return;
    var pending = activeEditRows().slice(0, 8);
    if (!pending.length) return;
    editWatchBusy = true;
    Promise.all(pending.map(function (item) {
      var clientId = String(item.clientId || item.shopId || ''), productId = String(item.id || item.productId || '');
      return erpStorage.request('/api/domain/commands/product-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read', target: { clientId: clientId, productId: productId } }) })
        .then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.message || '商品状态读取失败'); return data.item || null; }); })
        .catch(function () { return null; });
    })).then(function (items) {
      var finished = [];
      items.forEach(function (item) {
        var state = item && item.ozonEdit;
        if (!state || !state.queueId || ['queued','preparing','submitting','pending'].indexOf(state.phase) >= 0) return;
        if (editWatchNotified.has(state.queueId)) return;
        editWatchNotified.add(state.queueId);
        finished.push(state);
      });
      if (!finished.length) { editWatchDelay = editWatchDelay === 3000 ? 5000 : 10000; return; }
      editWatchDelay = 3000;
      return erpStorage.reload([PRODUCT_KEY]);
    }).finally(function () {
      editWatchBusy = false;
      scheduleEditWatch();
    });
  }
  bindEvents();
  document.addEventListener('erp-storage-audit-updated', function (event) {
    if (!event.detail) return;
    if ([RATE_KEY, MANUAL_FEE_KEY].indexOf(event.detail.key) >= 0) {
      refreshFinanceSettings();
      renderTable();
      return;
    }
    if (event.detail.key === SHOP_KEY) { renderShops(); refreshFilteredView(); return; }
    if ([PRODUCT_KEY, ORDER_KEY].indexOf(event.detail.key) < 0) return;
    var value = erpStorage.get(PRODUCT_KEY);
    all = Array.isArray(value) ? mergeOrderSources(value.map(applyManual)) : [];
    renderShops(); refreshFilteredView();
    loadProductCreators().then(renderTable).catch(function () {});
    loadOrderHistory();
    scheduleEditWatch(200);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') scheduleEditWatch(100);
    else if (editWatchTimer) { clearTimeout(editWatchTimer); editWatchTimer = null; }
  });
  erpStorage.init([PRODUCT_KEY, SHOP_KEY, CATEGORY_KEY, MANUAL_KEY, ORDER_KEY, RATE_KEY, MANUAL_FEE_KEY]).then(function () {
    var value = erpStorage.get(PRODUCT_KEY);
    all = Array.isArray(value) ? mergeOrderSources(value.map(applyManual)) : [];
    refreshFinanceSettings();
    applyNavigationTarget();
    renderShops();
    refreshFilteredView();
    var sourceReadFailure = (erpStorage.getLoadFailure && (erpStorage.getLoadFailure(SHOP_KEY) || erpStorage.getLoadFailure(PRODUCT_KEY))) || '';
    if (sourceReadFailure) toast(sourceReadFailure);
    return Promise.all([erpStorage.request('/api/auth/me'), erpStorage.request('/api/logistics-configs'), erpStorage.request('/api/pricing-settings')]);
  }).then(function (responses) {
    return Promise.all([
      responses[0] && responses[0].ok ? responses[0].json() : null,
      responses[1] && responses[1].ok ? responses[1].json() : null,
      responses[2] && responses[2].ok ? responses[2].json() : null
    ]);
  }).then(function (data) {
    var account = data[0], logistics = data[1], pricing = data[2];
    applyProductWritePermission(account);
    logisticsConfig = logistics || null;
    pricingSettings = pricing && pricing.settings ? pricing.settings : pricingSettings;
    myLogisticsScheme = logistics && logistics.defaultScheme ? String(logistics.defaultScheme) : DEFAULT_FULFILLMENT_SCHEMA;
    renderTable();
    loadOrderHistory();
    scheduleEditWatch(3000);
    if (account && account.isSystemAdmin) {
      $('adminClearBtn').hidden = false;
      $('adminClearBtn').style.removeProperty('display');
    }
  }).catch(function () {});
})();
