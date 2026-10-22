/* Download the displayed statistics snapshot; no requests or business writes. */
(function (root, factory) {
  'use strict';
  var api = factory(typeof module === 'object' && module.exports ? require('exceljs') : root.ExcelJS,
    typeof module === 'object' && module.exports ? require('./order-statistics') : root.WYERP_ORDER_STATISTICS);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ORDER_STATISTICS_EXPORT = api;
})(typeof window !== 'undefined' ? window : null, function (ExcelJS, statistics) {
  'use strict';
  var columns = [
    ['totalCount', '总订单数（单）', 'count'], ['salesRub', '总销售额（RUB）'], ['salesCny', '总销售额（CNY）'], ['costCny', '总垫资成本（CNY）'], ['manualFeeCny', '总贴单费（CNY）'], ['advertisingFeeRub', '广告费（RUB）'], ['advertisingFeeCny', '广告费（CNY）'], ['platformFeeRub', '总计费（RUB）'], ['platformFeeCny', '总计费（CNY）'], ['platformFeeMissingCount', '费用待同步订单数（单）', 'count'], ['periodNetProfitCny', '周期净利润（CNY）'],
    ['unsignedCount', '未签收订单数（单）', 'count'], ['unsignedSalesRub', '未签收销售额（RUB）'], ['unsignedSalesCny', '未签收销售额（CNY）'], ['unsignedCostCny', '未签收垫资成本（CNY）'], ['unsignedManualFeeCny', '未签收贴单费（CNY）'], ['unsignedEstimatedProfitCny', '未签收预估利润（CNY）'],
    ['signedCount', '已签收订单数（单）', 'count'], ['signedSalesRub', '已签收销售额（RUB）'], ['signedSalesCny', '已签收销售额（CNY）'], ['signedCostCny', '已签收垫资成本（CNY）'], ['signedManualFeeCny', '已签收贴单费（CNY）'], ['signedProfitCny', '已签收利润（CNY）'], ['marginRatio', '已签收利润率', 'percent'], ['roiRatio', '签收投产比', 'ratio'],
    ['cancelledCount', '已取消订单数（单）', 'count'], ['cancelledCostCny', '取消订单成本（CNY）'],
    ['warehouseCount', 'WHD仓库订单数（单）', 'count'], ['warehouseCostCny', 'WHD仓库垫资成本（CNY）'], ['warehouseFeeRub', 'WHD在库已发生费用（RUB）'], ['warehouseFeeCny', 'WHD在库已发生费用（CNY）']
  ];
  function numeric(value, digits) {
    return typeof value === 'number' && isFinite(value) ? Number(value.toFixed(digits)) : '—';
  }
  function ratio(value, percent) {
    if (typeof value !== 'number' || !isFinite(value)) return '—';
    // Preserve 1:x as text so spreadsheet software does not parse it as a time.
    return percent ? value : '1:' + value.toFixed(2);
  }
  function stamp(date) {
    function pad(value) { return String(value).padStart(2, '0'); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + '_' + pad(date.getHours()) + '-' + pad(date.getMinutes()) + '-' + pad(date.getSeconds());
  }
  function downloadTime(date) {
    var offset = -date.getTimezoneOffset(), absolute = Math.abs(offset);
    var zone = 'UTC' + (offset >= 0 ? '+' : '-') + String(Math.floor(absolute / 60)).padStart(2, '0') + ':' + String(absolute % 60).padStart(2, '0');
    var text = stamp(date);
    return text.slice(0, 10) + ' ' + text.slice(11).replace(/-/g, ':') + ' (' + zone + ')';
  }
  function orderDateRange(orders) {
    var result = { start: '', end: '', missing: 0 };
    (orders || []).forEach(function (order) {
      var day = String(order && order.orderTime || '').slice(0, 10);
      var parsed = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(day + 'T00:00:00Z') : null;
      if (!parsed || !isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) { result.missing++; return; }
      if (!result.start || day < result.start) result.start = day;
      if (!result.end || day > result.end) result.end = day;
    });
    return result;
  }
  function remarks(snapshot, label, now) {
    var period = snapshot.period || {}, actual = period.actual || {};
    var selected = !period.from && !period.to ? '全部时间（未设置日期筛选）' : (period.from || '不限开始日期') + ' 至 ' + (period.to || '不限结束日期');
    var dates = actual.start && actual.end ? actual.start + ' 至 ' + actual.end : snapshot.summary.totalCount === 0 ? '无匹配订单' : '订单日期缺失或未记录，无法确定';
    var rows = [
      ['备注说明（以下不参与数据统计）'],
      ['下载时间', downloadTime(now)], ['导出内容', label],
      ['统计范围', period.allOrders === true ? '全部订单（当前页面已加载范围）' : '当前筛选结果（当前页面已加载范围）'],
      ['统计时间段（日期筛选）', selected], ['实际订单日期范围', dates],
      ['缺失或无效下单日期的订单数（单）', numeric(actual.missing, 0)],
      ['统计店铺数（家，含零订单店铺）', numeric(snapshot.shops.length, 0)],
      ['有订单店铺数（家）', numeric(snapshot.shops.filter(function (shop) { return shop.stats.totalCount > 0; }).length, 0)],
      ['统计订单数（单）', numeric(snapshot.summary.totalCount, 0)]
    ];
    (snapshot.filters || []).forEach(function (filter) { rows.push(['筛选项：' + String(filter[0]), String(filter[1])]); });
    [['sales', '销售额完整度'], ['signedSales', '已签收销售额完整度'], ['unsignedSales', '未签收销售额完整度'], ['cancelledSales', '取消销售额完整度'], ['signedProfit', '已签收利润完整度'], ['unsignedProfit', '未签收预估利润完整度'], ['cancelledProfit', '取消利润完整度']].forEach(function (entry) {
      rows.push([entry[1], statistics.completenessText(snapshot.summary, entry[0]) || '金额完整']);
    });
    var pendingFeeCount = Number(snapshot.summary.platformFeeMissingCount);
    rows.push(['总计费完整度', Number.isFinite(pendingFeeCount) && pendingFeeCount > 0 ? String(Math.round(pendingFeeCount)) + ' 单费用待同步；费用合计仅包含已确认的金额' : '当前统计范围内无待同步的平台费用']);
    if (label === '店铺统计') snapshot.shops.forEach(function (shop) {
      var notes = [['sales', '销售额'], ['signedProfit', '已签收利润'], ['unsignedProfit', '未签收预估利润']].map(function (entry) {
        var note = statistics.completenessText(shop.stats, entry[0]);
        return note ? entry[1] + '：' + note : '';
      }).filter(Boolean);
      if (notes.length) rows.push(['店铺完整度：' + String(shop.name), notes.join('；')]);
    });
    (snapshot.summary.advertisingBreakdown || []).forEach(function (entry) {
      rows.push(['广告费分类：' + String(entry.chargeLabel || '其它推广费用') + ' / ' + String(entry.label || '广告推广费'), numeric(entry.amountRub, 2) + ' RUB / ' + numeric(entry.amountCny, 2) + ' CNY；' + numeric(entry.count, 0) + ' 笔']);
    });
    var periodDeductions = [];
    if (Number(snapshot.summary.warehouseFeeCny) > 0) periodDeductions.push('WHD在库已发生平台费用 ' + numeric(snapshot.summary.warehouseFeeCny, 2) + ' CNY');
    if (Number(snapshot.summary.unallocatedAdvertisingFeeCny) > 0) periodDeductions.push('无法可靠归属单笔订单的 CPC/CPO/CPM 广告费 ' + numeric(snapshot.summary.unallocatedAdvertisingFeeCny, 2) + ' CNY');
    if (Number(snapshot.summary.pendingCpoAdvertisingFeeCny) > 0) periodDeductions.push('待订单匹配的 CPO ' + numeric(snapshot.summary.pendingCpoAdvertisingFeeCny, 2) + ' CNY');
    if (periodDeductions.length) rows.push(['周期净利润口径', '已签收实际利润再扣除：' + periodDeductions.join('；')]);
    rows.push(['计算汇率（1 CNY→RUB）', String(snapshot.rate)], ['每单贴单费（CNY）', numeric(snapshot.manualFee, 2)],
      ['时间说明', '下载时间为当前设备时间；统计日期按订单下单日期，实际日期范围不包含缺失或无效日期。'],
      ['统计口径', '完整度按已签收、未签收、已取消分别计数；未签收单量不含已取消订单。垫资成本已含贴单费；当前未签收成本仍包含部分已发货取消订单成本，取消订单实际费用口径待接口数据核对，不能据此推定快递费金额。未签收利润为预估；—表示未提供指标、无可计算订单或无分母。合计不完整时金额只包含已知数据，利润率和投产比只使用可计算利润订单。']);
    if (snapshot.simulation) rows.push(['数据说明', '仅模拟：订单、店铺及金额均为虚构，不代表真实业务数据。']);
    return rows;
  }
  async function createXlsx(snapshot, kind, date) {
    if (!snapshot || !snapshot.summary || !Array.isArray(snapshot.shops)) throw Error('统计尚未加载完成');
    var labels = { summary: '总览', status: '状态明细', shops: '店铺统计' };
    if (!Object.prototype.hasOwnProperty.call(labels, kind)) throw Error('请选择要下载的统计类型');
    if (!ExcelJS) throw Error('Excel 组件未加载，请刷新页面后重试');
    var now = date || new Date(), stats = snapshot.summary;
    var title = '订单统计_' + labels[kind] + (snapshot.simulation ? '（仅模拟）' : '');
    var rows;
    if (kind === 'summary') {
      rows = [['总订单数（单）', '总销售额（RUB）', '总销售额（CNY）', '总垫资成本（CNY）', '总贴单费（CNY）', '广告费（RUB）', '广告费（CNY）', '总计费（RUB）', '总计费（CNY）', '费用待同步订单数（单）', 'WHD仓库订单数（单）', 'WHD在库已发生费用（RUB）', 'WHD在库已发生费用（CNY）', '周期净利润（CNY）'],
        [numeric(stats.totalCount, 0), numeric(stats.salesRub, 2), numeric(stats.salesCny, 2), numeric(stats.costCny, 2), numeric(stats.manualFeeCny, 2), numeric(stats.advertisingFeeRub, 2), numeric(stats.advertisingFeeCny, 2), numeric(stats.platformFeeRub, 2), numeric(stats.platformFeeCny, 2), numeric(stats.platformFeeMissingCount, 0), numeric(stats.warehouseCount, 0), numeric(stats.warehouseFeeRub, 2), numeric(stats.warehouseFeeCny, 2), numeric(stats.periodNetProfitCny, 2)]];
    } else if (kind === 'status') {
      rows = [['订单状态', '订单数（单）', '销售额（RUB）', '销售额（CNY）', '垫资成本（CNY）', '贴单费（CNY）', '广告费（RUB）', '广告费（CNY）', '总计费（RUB）', '总计费（CNY）', '费用待同步订单数（单）', 'WHD已发生费用（RUB）', 'WHD已发生费用（CNY）', '利润（CNY，未签收为预估）', '利润率', '投产比']];
      ['unsigned', 'signed', 'cancelled'].forEach(function (state, index) {
        var cancelled = state === 'cancelled', signed = state === 'signed';
        rows.push([
          ['未签收', '已签收', '已取消'][index], numeric(stats[state + 'Count'], 0),
          cancelled ? '—' : numeric(stats[state + 'SalesRub'], 2), cancelled ? '—' : numeric(stats[state + 'SalesCny'], 2),
          numeric(stats[state + 'CostCny'], 2), cancelled ? '—' : numeric(stats[state + 'ManualFeeCny'], 2),
          numeric(stats[state + 'AdvertisingFeeRub'], 2), numeric(stats[state + 'AdvertisingFeeCny'], 2),
          numeric(stats[state + 'PlatformFeeRub'], 2), numeric(stats[state + 'PlatformFeeCny'], 2), numeric(stats[state + 'PlatformFeeMissingCount'], 0),
          '—', '—',
          cancelled ? '—' : numeric(stats[signed ? 'signedProfitCny' : 'unsignedEstimatedProfitCny'], 2),
          signed ? ratio(stats.marginRatio, true) : '—', signed ? ratio(stats.roiRatio, false) : '—'
        ]);
      });
      rows.push(['WHD仓库', numeric(stats.warehouseCount, 0), 0, 0, numeric(stats.warehouseCostCny, 2), numeric(stats.warehouseManualFeeCny, 2),
        numeric(stats.warehouseAdvertisingFeeRub, 2), numeric(stats.warehouseAdvertisingFeeCny, 2), numeric(stats.warehousePlatformFeeRub, 2), numeric(stats.warehousePlatformFeeCny, 2), numeric(stats.warehousePlatformFeeMissingCount, 0), numeric(stats.warehouseFeeRub, 2), numeric(stats.warehouseFeeCny, 2), '—', '—', '—']);
    } else {
      rows = [['店铺'].concat(columns.map(function (column) { return column[1]; }))];
      snapshot.shops.forEach(function (shop) {
        rows.push([String(shop.name)].concat(columns.map(function (column) {
          var value = shop.stats[column[0]];
          if (column[2] === 'percent' || column[2] === 'ratio') return ratio(value, column[2] === 'percent');
          return numeric(value, column[2] === 'count' ? 0 : 2);
        })));
      });
    }
    if (snapshot.simulation) rows[0][0] += '（仅模拟）';
    var workbook = new ExcelJS.Workbook();
    workbook.creator = '网研ERP'; workbook.created = now; workbook.modified = now;
    var sheet = workbook.addWorksheet(labels[kind], {
      views: [{ state: 'frozen', ySplit: 1, xSplit: kind === 'shops' ? 1 : 0, showGridLines: false }]
    });
    var formats = kind === 'summary' ? ['count', 'money', 'money', 'money', 'money', 'money', 'money', 'count', 'money', 'money', 'money'] :
      kind === 'status' ? ['text', 'count', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'percent', 'ratio'] :
      ['text'].concat(columns.map(function (column) { return column[2] || 'money'; }));
    var navy = 'FF334155', line = 'FFDCE3EC';
    function fill(color) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; }
    // Approximate visual width for Chinese and Latin text; Excel cannot autofit merged rows.
    function height(value, width) {
      var lines = String(value == null ? '' : value).split(/\r\n|\r|\n/).reduce(function (count, text) {
        var units = Array.from(text).reduce(function (sum, char) { return sum + (char.codePointAt(0) > 255 ? 2 : 1); }, 0);
        return count + Math.max(1, Math.ceil(units / Math.max(1, width - 4)));
      }, 0);
      return Math.min(409, Math.max(30, lines * 18 + 12));
    }
    formats.forEach(function (type, index) {
      sheet.getColumn(index + 1).width = type === 'count' ? 18 : type === 'text' ? 28 : 24;
    });
    rows.forEach(function (values, index) {
      var row = sheet.addRow(values), rowHeight = index ? 30 : 48;
      row.eachCell(function (cell, column) {
        cell.font = { name: 'Microsoft YaHei', size: 11, bold: !index, color: { argb: index ? navy : 'FFFFFFFF' } };
        cell.fill = fill(index ? (index % 2 ? 'FFFFFFFF' : 'FFF3F6FA') : navy);
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        cell.border = { bottom: { style: 'thin', color: { argb: line } } };
        if (index) {
          cell.numFmt = formats[column - 1] === 'percent' ? '0.0%' : formats[column - 1] === 'money' ? '#,##0.00;[Red]-#,##0.00;0.00' : formats[column - 1] === 'count' ? '#,##0' : '@';
          rowHeight = Math.max(rowHeight, height(cell.value, sheet.getColumn(column).width));
        }
      });
      row.height = rowHeight;
    });
    // The filter stops before the blank separator and remarks, even for zero shops.
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length, column: formats.length } };
    sheet.getRow(rows.length + 1).height = 14;
    var noteRow = rows.length + 2;
    var labelWidth = sheet.getColumn(1).width + sheet.getColumn(2).width;
    var valueWidth = sheet.getColumn(3).width + sheet.getColumn(4).width + sheet.getColumn(5).width;
    remarks(snapshot, labels[kind], now).forEach(function (note, index) {
      var row = sheet.getRow(noteRow++);
      if (!index) {
        sheet.mergeCells(row.number, 1, row.number, 5);
        row.getCell(1).value = note[0];
      } else {
        sheet.mergeCells(row.number, 1, row.number, 2);
        sheet.mergeCells(row.number, 3, row.number, 5);
        row.getCell(1).value = note[0]; row.getCell(3).value = note[1];
      }
      [1, 3].forEach(function (column) {
        if (!index && column === 3) return;
        var cell = row.getCell(column);
        cell.font = { name: 'Microsoft YaHei', size: 11, bold: column === 1, color: { argb: index ? navy : 'FFFFFFFF' } };
        cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true, indent: 1 };
        cell.fill = fill(!index ? navy : column === 1 ? 'FFE9EEF5' : 'FFF8FAFC');
        cell.border = { bottom: { style: 'thin', color: { argb: line } } };
        cell.numFmt = typeof cell.value === 'number' ? (note[0] === '每单贴单费（CNY）' ? '0.00' : '#,##0') : '@';
      });
      row.height = index ? Math.max(height(note[0], labelWidth), height(note[1], valueWidth)) : 34;
    });
    // All cells are primitive numbers/strings; user text never becomes an Excel formula.
    var buffer = await workbook.xlsx.writeBuffer();
    return { buffer: buffer, filename: title + '_' + stamp(now) + '.xlsx' };
  }
  async function download(snapshot, kind) {
    var file = await createXlsx(snapshot, kind);
    var url = URL.createObjectURL(new Blob([file.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    try {
      var anchor = document.createElement('a');
      anchor.href = url; anchor.download = file.filename;
      anchor.click();
    } finally {
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    }
    return file.filename;
  }
  return { createXlsx: createXlsx, download: download, orderDateRange: orderDateRange };
});
