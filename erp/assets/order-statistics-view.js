/* Order statistics presentation only; calculations stay in order-statistics.js. */
(function () {
  'use strict';
  var moneyFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  var countFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
  function node(tag, className, text) {
    var element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  }
  function money(value, currency) { if (value == null || !isFinite(value)) return '—'; return currency === 'RUB' ? moneyFormat.format(value) + ' ₽' : '¥' + moneyFormat.format(value); }
  function completeness(parent, stats, key) {
    var text = window.WYERP_ORDER_STATISTICS.completenessText(stats, key);
    if (text) parent.appendChild(node('span', 'stats-secondary', text));
  }
  function value(parent, text, secondary) {
    var line = node('span', secondary ? 'stats-number stats-secondary' : 'stats-number', text);
    line.title = text;
    parent.appendChild(line);
  }
  function amount(parent, rub, cny) { value(parent, money(rub, 'RUB')); value(parent, money(cny), true); }
  function cell(row, field, label) {
    var item = node('td');
    item.dataset.metric = field;
    item.setAttribute('aria-label', label);
    row.appendChild(item);
    return item;
  }
  function countCell(row, field, number, label) { value(cell(row, field, label), countFormat.format(number)); }
  function moneyCell(row, field, number, label, stats, coverageKey) {
    var item = cell(row, field, label);
    if (number < 0) item.classList.add('stats-negative');
    value(item, money(number));
    if (coverageKey) completeness(item, stats, coverageKey);
  }
  function salesCell(row, field, rub, cny, label, stats) { var item = cell(row, field, label); amount(item, rub, cny); completeness(item, stats, field); }
  function dualMoneyCell(row, field, rub, cny, label) { var item = cell(row, field, label); amount(item, rub, cny); }
  function platformFeeCell(row, field, rub, cny, label, missingCount) { var item = cell(row, field, label); amount(item, rub, cny); if (Number(missingCount) > 0) item.appendChild(node('span', 'stats-secondary', Number(missingCount) + ' 单费用待同步')); }
  function ratioCell(row, field, number, roi, label) {
    value(cell(row, field, label), number == null ? '—' : roi ? '1:' + number.toFixed(2) : (number * 100).toFixed(1) + '%');
  }
  function unavailable(row, label) { var item = node('td', 'stats-unavailable', '—'); item.title = label + '：当前统计口径未提供此项'; row.appendChild(item); }
  function totalHeading(row, label, meta, detailOverride) {
    var heading = node('th', 'stats-detail-label'); heading.scope = 'row';
    heading.appendChild(node('span', 'stats-status-label', label));
    var detail = detailOverride || meta && meta.scopeText;
    if (detail) heading.appendChild(node('span', 'stats-secondary', detail));
    row.appendChild(heading);
  }
  function fixedTotalRow() { var row = node('tr', 'stats-total-row'); row.dataset.paginationFixed = '1'; return row; }
  function shopHeading(row, label, total) {
    var heading = node(total ? 'th' : 'td', 'stats-shop-cell');
    if (total) heading.scope = 'row';
    var text = label || '未关联店铺';
    var name = node('span', 'list-ellipsis stats-shop-label', text); name.title = text;
    heading.appendChild(name); row.appendChild(heading);
  }
  function statusTotalRow(stats, meta) {
    var row = fixedTotalRow(); row.dataset.status = 'total'; row.dataset.shop = meta && meta.shopLabel || '全部店铺';
    shopHeading(row, meta && meta.shopLabel || '全部店铺', true); totalHeading(row, '筛选范围总计', meta);
    countCell(row, 'totalCount', stats.totalCount, '筛选范围订单总数');
    salesCell(row, 'sales', stats.salesRub, stats.salesCny, '筛选范围总销售额', stats);
    moneyCell(row, 'costCny', stats.costCny, '筛选范围总垫资成本');
    moneyCell(row, 'manualFeeCny', stats.manualFeeCny, '筛选范围总贴单费');
    dualMoneyCell(row, 'advertisingFee', stats.advertisingFeeRub, stats.advertisingFeeCny, '筛选范围总广告费');
    platformFeeCell(row, 'platformFee', stats.platformFeeRub, stats.platformFeeCny, '筛选范围实际总计费', stats.platformFeeMissingCount);
    moneyCell(row, 'periodNetProfitCny', stats.periodNetProfitCny, '筛选范围周期净利润');
    moneyCell(row, 'signedProfitCny', stats.signedProfitCny, '筛选范围已签收利润', stats, 'signedProfit');
    ratioCell(row, 'marginRatio', stats.marginRatio, false, '筛选范围已签收利润率');
    ratioCell(row, 'roiRatio', stats.roiRatio, true, '筛选范围签收投产比');
    return row;
  }
  function metric(label, field, primary, secondary) {
    var card = node('article', 'metric');
    card.dataset.metric = field;
    card.appendChild(node('div', 'label', label));
    var body = node('div', 'value'); value(body, primary);
    if (secondary != null) value(body, secondary, true);
    card.appendChild(body);
    return card;
  }
  function periodProfitNote(stats) {
    var parts = [];
    if (Number(stats && stats.warehouseFeeCny) > 0) parts.push('已扣WHD在库已发生平台费用 ' + money(stats.warehouseFeeCny));
    if (Number(stats && stats.unallocatedAdvertisingFeeCny) > 0) parts.push('已扣无法归属订单的点击/展示广告费 ' + money(stats.unallocatedAdvertisingFeeCny));
    if (Number(stats && stats.pendingCpoAdvertisingFeeCny) > 0) parts.push('已扣待订单匹配的CPO ' + money(stats.pendingCpoAdvertisingFeeCny));
    return parts.length ? parts.join('；') : '基于已签收实际利润';
  }
  function statusKindRow(stats, kind, shopName) {
    var cancelled = kind === 'cancelled', signed = kind === 'signed';
    var label = cancelled ? '已取消' : signed ? '已签收' : '未签收';
    var row = node('tr'); row.dataset.status = kind; row.dataset.shop = shopName || '';
    shopHeading(row, shopName, false);
    var heading = node('th', 'stats-detail-label'); heading.scope = 'row';
    heading.appendChild(node('span', 'stats-status-label', label));
    heading.appendChild(node('span', 'stats-secondary', cancelled ? '含WHD首次销售；费用不与WHD重复' : signed ? '已签收利润' : '未签收预估利润'));
    row.appendChild(heading);
    countCell(row, kind + 'Count', stats[kind + 'Count'], label + '订单');
    if (cancelled) unavailable(row, label + '销售额');
    else salesCell(row, kind + 'Sales', stats[kind + 'SalesRub'], stats[kind + 'SalesCny'], label + '销售额', stats);
    moneyCell(row, kind + 'CostCny', stats[kind + 'CostCny'], label + '垫资成本');
    if (cancelled) unavailable(row, '贴单费'); else moneyCell(row, kind + 'ManualFeeCny', stats[kind + 'ManualFeeCny'], label + '贴单费');
    dualMoneyCell(row, kind + 'AdvertisingFee', stats[kind + 'AdvertisingFeeRub'], stats[kind + 'AdvertisingFeeCny'], label + '广告费');
    platformFeeCell(row, kind + 'PlatformFee', stats[kind + 'PlatformFeeRub'], stats[kind + 'PlatformFeeCny'], label + '实际总计费', stats[kind + 'PlatformFeeMissingCount']);
    unavailable(row, label + '周期净利润');
    if (cancelled) unavailable(row, '利润'); else { var profitField = signed ? 'signedProfitCny' : 'unsignedEstimatedProfitCny'; moneyCell(row, profitField, stats[profitField], signed ? '已签收利润' : '未签收预估利润', stats, kind + 'Profit'); }
    if (signed) { ratioCell(row, 'marginRatio', stats.marginRatio, false, '已签收利润率'); ratioCell(row, 'roiRatio', stats.roiRatio, true, '签收投产比'); } else { unavailable(row, '利润率'); unavailable(row, '投产比'); }
    return row;
  }
  function warehouseStatusRow(stats, shopName) {
    var row = node('tr'); row.dataset.status = 'warehouse'; row.dataset.shop = shopName || '';
    shopHeading(row, shopName, false);
    var heading = node('th', 'stats-detail-label'); heading.scope = 'row';
    heading.appendChild(node('span', 'stats-status-label', 'WHD仓库'));
    heading.appendChild(node('span', 'stats-secondary', stats.warehouseFeeMissingCount ? '首次销售已计入已取消；当前费用仍有待同步' : '首次销售已计入已取消；当前在仓库费用独立统计'));
    row.appendChild(heading);
    countCell(row, 'warehouseCount', stats.warehouseCount, 'WHD仓库订单'); dualMoneyCell(row, 'warehouseSales', 0, 0, 'WHD仓库销售额');
    moneyCell(row, 'warehouseCostCny', stats.warehouseCostCny, 'WHD仓库垫资成本'); moneyCell(row, 'warehouseManualFeeCny', stats.warehouseManualFeeCny, 'WHD仓库贴单费');
    dualMoneyCell(row, 'warehouseAdvertisingFee', stats.warehouseAdvertisingFeeRub, stats.warehouseAdvertisingFeeCny, 'WHD仓库广告费');
    platformFeeCell(row, 'warehousePlatformFee', stats.warehousePlatformFeeRub, stats.warehousePlatformFeeCny, 'WHD仓库实际总计费', stats.warehousePlatformFeeMissingCount);
    moneyCell(row, 'warehousePeriodImpactCny', -Number(stats.warehouseFeeCny || 0), 'WHD仓库已发生平台费用对周期净利润的影响'); unavailable(row, 'WHD仓库利润'); unavailable(row, 'WHD仓库利润率'); unavailable(row, 'WHD仓库投产比');
    return row;
  }
  function renderStatusBreakdown(stats, meta, groups) {
    var body = document.getElementById('statusBody'); if (!body) return;
    var rows = [statusTotalRow(stats, meta)];
    (Array.isArray(groups) ? groups : []).forEach(function (group) {
      var item = group && group.stats || {};
      ['unsigned','signed','cancelled'].forEach(function (kind) { if (Number(item[kind + 'Count']) > 0) rows.push(statusKindRow(item, kind, group.name)); });
      if (Number(item.warehouseCount) > 0) rows.push(warehouseStatusRow(item, group.name));
    });
    body.replaceChildren.apply(body, rows);
  }
  function renderSummary(stats, advertisingStats, meta, groups) {
    var sales = metric('总销售额', 'sales', money(stats.salesRub, 'RUB'), money(stats.salesCny)); completeness(sales, stats, 'sales');
    var total = metric('总订单量', 'totalCount', countFormat.format(stats.totalCount) + ' 单', '已签收 ' + countFormat.format(stats.signedCount) + ' · 已取消 ' + countFormat.format(stats.cancelledCount) + ' · 未签收 ' + countFormat.format(stats.unsignedCount));
    var signedSales = metric('已签收销售额', 'signedSales', money(stats.signedSalesRub, 'RUB'), money(stats.signedSalesCny)); completeness(signedSales, stats, 'signedSales');
    var cost = metric('总垫资成本', 'costCny', money(stats.costCny), '其中贴单费 ' + money(stats.manualFeeCny));
    var platform = metric(stats.platformFeeMissingCount ? '已知实际总计费' : '实际总计费', 'platformFee', money(stats.platformFeeRub, 'RUB'), stats.platformFeeMissingCount ? money(stats.platformFeeCny) + ' · ' + stats.platformFeeMissingCount + ' 单费用待同步' : money(stats.platformFeeCny));
    var warehouse = metric('WHD当前在库', 'warehouseCount', countFormat.format(stats.warehouseCount || 0) + ' 单', '已发生费用 ' + money(stats.warehouseFeeCny));
    document.getElementById('metrics').replaceChildren(total,sales,signedSales,metric('周期净利润','periodNetProfitCny',money(stats.periodNetProfitCny),periodProfitNote(stats)),metric('未签收预估利润','unsignedEstimatedProfitCny',money(stats.unsignedEstimatedProfitCny),'按当前未签收订单费用模型估算'),metric('已签收利润','signedProfitCny',money(stats.signedProfitCny),stats.marginRatio==null?'利润率 —':'利润率 '+(Number(stats.marginRatio)*100).toFixed(1)+'%'),cost,platform,metric('广告推广费','advertisingFee',money((advertisingStats||stats).advertisingFeeRub,'RUB'),money((advertisingStats||stats).advertisingFeeCny)),warehouse);
    renderAdvertisingBreakdown(advertisingStats || stats, meta, groups);
    renderStatusBreakdown(stats, meta, groups);
  }
  function advertisingRow(shopName, entry) {
    var row = node('tr'); row.dataset.shop = shopName || ''; shopHeading(row, shopName, false);
    var charge = node('td', 'stats-detail-label', entry.chargeLabel || '其它推广费用');
    charge.title = entry.pendingCpo ? '按订单付费，当前尚未完成订单号匹配；匹配成功后会进入对应订单利润' : entry.orderAttributable === false ? '不分摊到单笔订单利润' : '可随订单费用计入单笔利润';
    row.appendChild(charge);
    value(cell(row, 'advertisingLabel', '广告费用类型'), entry.label || '广告推广费');
    value(cell(row, 'advertisingAttribution', '订单归属'), entry.pendingCpo ? '待订单匹配' : entry.orderAttributable === false ? '无法归属单笔订单' : entry.orderAttributable === true ? '已归属订单' : '—');
    if (window.WYERP_ORDER_STATISTICS_SHOW_TYPE_ID === true) value(cell(row, 'advertisingType', 'Ozon 广告费用类型'), String(entry.type || '—'));
    value(cell(row, 'advertisingCount', '费用笔数'), countFormat.format(entry.count || 0)); amount(cell(row, 'advertisingAmount', '广告费'), entry.amountRub, entry.amountCny);
    return row;
  }
  function renderAdvertisingBreakdown(stats, meta, groups) {
    var body = document.getElementById('advertisingBody'); if (!body) return;
    var total = fixedTotalRow(), totalCount = (stats.advertisingBreakdown || []).reduce(function (sum, entry) { return sum + (Number(entry && entry.count) || 0); }, 0);
    total.dataset.shop = meta && meta.shopLabel || '全部店铺'; shopHeading(total, meta && meta.shopLabel || '全部店铺', true);
    totalHeading(total, '筛选范围总计', meta, meta && meta.advertisingScopeText ? meta.advertisingScopeText + ' · 缺失/对账状态见明细' : '当前完整筛选范围');
    value(cell(total, 'advertisingLabel', '广告费用类型'), '全部广告费用'); value(cell(total, 'advertisingAttribution', '订单归属'), '完整筛选范围');
    if (window.WYERP_ORDER_STATISTICS_SHOW_TYPE_ID === true) value(cell(total, 'advertisingType', 'Ozon 广告费用类型'), '—');
    value(cell(total, 'advertisingCount', '费用笔数'), countFormat.format(totalCount)); amount(cell(total, 'advertisingAmount', '广告费'), stats.advertisingFeeRub, stats.advertisingFeeCny);
    var rows = [total], detailGroups = Array.isArray(groups) ? groups : [];
    detailGroups.forEach(function (group) { var source = group && (group.advertisingStats || group.stats) || {}; (source.advertisingBreakdown || []).forEach(function (entry) { rows.push(advertisingRow(group.name, entry)); }); });
    if (rows.length === 1) { var row = node('tr'), empty = node('td', 'empty', '当前筛选范围没有已同步的广告推广费用'); empty.colSpan = window.WYERP_ORDER_STATISTICS_SHOW_TYPE_ID === true ? 7 : 6; row.appendChild(empty); rows.push(row); }
    body.replaceChildren.apply(body, rows);
  }
  function shopRow(stats, label, meta, total) {
    var row = total ? fixedTotalRow() : node('tr');
    var heading = node('th', 'stats-row-label'); heading.scope = 'row';
    var name = node('span', 'list-ellipsis stats-shop-label', label); name.title = label; heading.appendChild(name);
    if (total && meta && meta.scopeText) heading.appendChild(node('span', 'stats-secondary', meta.scopeText));
    row.appendChild(heading);
    countCell(row, 'totalCount', stats.totalCount, '总订单数');
    salesCell(row, 'sales', stats.salesRub, stats.salesCny, '总销售额', stats);
    moneyCell(row, 'costCny', stats.costCny, '总垫资成本');
    moneyCell(row, 'manualFeeCny', stats.manualFeeCny, '总贴单费');
    dualMoneyCell(row, 'advertisingFee', stats.advertisingFeeRub, stats.advertisingFeeCny, '总广告费');
    platformFeeCell(row, 'platformFee', stats.platformFeeRub, stats.platformFeeCny, '实际总计费', stats.platformFeeMissingCount);
    moneyCell(row, 'periodNetProfitCny', stats.periodNetProfitCny, '周期净利润');
    countCell(row, 'unsignedCount', stats.unsignedCount, '未签收订单数');
    salesCell(row, 'unsignedSales', stats.unsignedSalesRub, stats.unsignedSalesCny, '未签收销售额', stats);
    moneyCell(row, 'unsignedCostCny', stats.unsignedCostCny, '未签收垫资成本');
    moneyCell(row, 'unsignedManualFeeCny', stats.unsignedManualFeeCny, '未签收贴单费');
    moneyCell(row, 'unsignedEstimatedProfitCny', stats.unsignedEstimatedProfitCny, '未签收预估利润', stats, 'unsignedProfit');
    countCell(row, 'signedCount', stats.signedCount, '已签收订单数');
    salesCell(row, 'signedSales', stats.signedSalesRub, stats.signedSalesCny, '已签收销售额', stats);
    moneyCell(row, 'signedCostCny', stats.signedCostCny, '已签收垫资成本');
    moneyCell(row, 'signedManualFeeCny', stats.signedManualFeeCny, '已签收贴单费');
    moneyCell(row, 'signedProfitCny', stats.signedProfitCny, '已签收利润', stats, 'signedProfit');
    ratioCell(row, 'marginRatio', stats.marginRatio, false, '已签收利润率');
    ratioCell(row, 'roiRatio', stats.roiRatio, true, '签收投产比');
    countCell(row, 'cancelledCount', stats.cancelledCount, '已取消订单数');
    moneyCell(row, 'cancelledCostCny', stats.cancelledCostCny, '取消订单成本');
    return row;
  }
  function renderShops(groups, totalStats, meta) {
    var body = document.getElementById('shopBody');
    var rows = totalStats ? [shopRow(totalStats, '筛选范围总计', meta, true)] : [];
    rows = rows.concat(groups.map(function (group) { return shopRow(group.stats, group.name, meta, false); }));
    if (rows.length === (totalStats ? 1 : 0)) { var row = node('tr'), empty = node('td', 'empty', '尚未配置店铺'); empty.colSpan = 22; row.appendChild(empty); rows.push(row); }
    body.replaceChildren.apply(body, rows);
  }
  window.WYERP_ORDER_STATISTICS_VIEW = { renderSummary: renderSummary, renderAdvertisingBreakdown: renderAdvertisingBreakdown, renderShops: renderShops };
})();
