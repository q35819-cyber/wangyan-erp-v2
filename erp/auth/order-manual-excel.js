'use strict';

const ExcelJS = require('exceljs');
const crypto = require('crypto');
const orderOperations = require('../assets/order-operations');

const FORMAT_MARKER = 'WYERP_ORDER_MANUAL_DATA_V1';
const FORMAT_ERROR_MESSAGE = 'Excel格式不正确，请先导出订单手动数据获取格式。';
const MAX_ORDERS = 10000;
const MAX_DETAIL_ROWS = 50000;
const MAX_SHEETS = 8, MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MANUAL_COLUMNS = [
  ['spec', '规格中文'], ['specRu', '规格俄文'], ['src', '货源地址'],
  ['srcPrice', '货源价格'], ['srcRemark', '货源备注'], ['purchasePrice', '采购价格'],
  ['purchaseChannel', '采购渠道'], ['domesticShipping', '国内运费'],
  ['purchaseExpress', '快递单号'], ['purchaseNo', '采购订单号'],
  ['returnFee', '退货快递费'], ['remark', '订单备注']
];
const STOCK_COLUMNS = [
  ['qty', '入仓数量'], ['purchasePrice', '入仓采购价'], ['domesticShipping', '入仓国内运费'],
  ['purchaseChannel', '入仓采购渠道'], ['purchaseNo', '入仓订单编号'],
  ['purchaseExpress', '入仓快递单号'], ['remark', '入仓备注']
];
const COMBINE_COLUMNS = [
  ['src', '货源地址'], ['srcPrice', '货源价格'], ['srcRemark', '货源备注'],
  ['purchasePrice', '采购价格'], ['domesticShipping', '国内运费'],
  ['purchaseChannel', '采购渠道'], ['purchaseNo', '订单编号'],
  ['purchaseExpress', '快递单号'], ['remark', '订单备注']
];
const DECIMAL_FIELDS = new Set(['srcPrice', 'purchasePrice', 'domesticShipping', 'returnFee']);
function versionOf(order) { return crypto.createHash('sha256').update(JSON.stringify(order || {})).digest('hex'); }

function problem(code, message) {
  return Object.assign(new Error(message || 'Excel 订单操作失败，请检查文件内容并重试。'), { publicCode: code });
}
function zipPreflight(buffer) {
  const start = Math.max(0, buffer.length - 65557); let eocd = -1;
  for (let i = buffer.length - 22; i >= start; i -= 1) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw problem('manual_excel_invalid_file', 'Excel 文件不是有效压缩包。');
  const count = buffer.readUInt16LE(eocd + 10), offset = buffer.readUInt32LE(eocd + 16);
  if (count > 2000 || offset >= buffer.length) throw problem('manual_excel_resource_limit', 'Excel 文件包含过多内容，无法安全导入。');
  let at = offset, total = 0;
  for (let i = 0; i < count; i += 1) { if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw problem('manual_excel_invalid_file', 'Excel 文件目录损坏。'); total += buffer.readUInt32LE(at + 24); if (total > MAX_UNCOMPRESSED_BYTES) throw problem('manual_excel_resource_limit', 'Excel 解压后内容过大，无法安全导入。'); at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32); }
}

function text(value, max = 2000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function cellText(cell, max = 2000) {
  if (!cell) return '';
  const value = cell.value;
  if (value && typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'formula') || Object.prototype.hasOwnProperty.call(value, 'sharedFormula')) {
      throw problem('manual_excel_formula_forbidden', `第 ${cell.row} 行“${cell.worksheet.getColumn(cell.col).header || cell.col}”不能使用公式`);
    }
    if (Array.isArray(value.richText)) return text(value.richText.map(item => item.text || '').join(''), max);
    if (Object.prototype.hasOwnProperty.call(value, 'text')) return text(value.text, max);
  }
  if (value instanceof Date) return value.toISOString();
  return text(value, max);
}

function decimal(value, label) {
  const cleaned = text(value, 80).replace(/,/g, '');
  if (!cleaned || cleaned === '--') return '';
  if (!/^\d+(?:\.\d{1,2})?$/.test(cleaned)) throw problem('manual_excel_invalid_number', `${label}必须是大于等于 0、最多两位小数的数字`);
  return cleaned;
}

function positiveInteger(value, label) {
  const cleaned = text(value, 40);
  if (!cleaned) return '';
  if (!/^\d+$/.test(cleaned) || Number(cleaned) <= 0) throw problem('manual_excel_invalid_quantity', `${label}必须是大于 0 的整数`);
  return cleaned;
}

function valueForExport(value) {
  if (value == null || value === '--') return '';
  return typeof value === 'object' ? JSON.stringify(value) : value;
}

function styleSheet(sheet, widths) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  sheet.getRow(1).eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  sheet.getRow(1).height = 24;
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
  });
}

async function buildWorkbook(input = {}) {
  const tenantId = text(input.tenantId, 64);
  const snapshot = orderOperations.createManualOrderSnapshot(input.orders);
  const rawByPosting = new Map((input.orders || []).map(order => [text(order && order.posting, 180), order]));
  snapshot.forEach(order => (order.items || []).forEach((item, index) => {
    const raw = rawByPosting.get(text(order.posting, 180));
    const rawItem = raw && raw.items && raw.items[index];
    item.qty = rawItem && (rawItem.qty || rawItem.quantity) || '';
  }));
  if (snapshot.length > MAX_ORDERS) throw problem('manual_excel_order_limit', '手动数据订单数超过 10000 条');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '网研ERP';
  workbook.created = input.exportedAt instanceof Date ? input.exportedAt : new Date();
  workbook.calcProperties.fullCalcOnLoad = false;

  const info = workbook.addWorksheet('说明', { properties: { tabColor: { argb: 'FFD4AF37' } } });
  info.addRows([
    ['格式标识', FORMAT_MARKER], ['租户编号', tenantId], ['导出时间', workbook.created.toISOString()],
    ['当前订单数', Number(input.integrity && input.integrity.currentOrders || 0)],
    ['保护账本订单数', Number(input.integrity && input.integrity.protectedOrders || 0)],
    ['当前订单与保护账本不一致数', Number(input.integrity && input.integrity.mismatchedCurrentOrders || 0)],
    ['说明', '本文件只包含订单人工维护字段。导入仅覆盖文件中货件的人工字段，不修改 Ozon 状态、金额、买家、费用等平台数据。'],
    ['操作提示', '请勿修改工作表名称、表头、格式标识或租户编号。货件编号和商品序号用于定位数据。']
  ]);
  info.getColumn(1).width = 18; info.getColumn(2).width = 105;
  info.getColumn(1).font = { bold: true, color: { argb: 'FF1F4E78' } };
  info.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; });

  const orders = workbook.addWorksheet('订单');
  orders.columns = ['货件编号', '采购成本', '订单版本', '合包组数量'].map(header => ({ header }));
  const items = workbook.addWorksheet('商品');
  items.columns = ['货件编号', '商品序号', 'Offer ID', 'SKU', '数量']
    .concat(MANUAL_COLUMNS.map(column => column[1]), STOCK_COLUMNS.map(column => column[1]))
    .map(header => ({ header }));
  const combines = workbook.addWorksheet('合包组');
  combines.columns = ['货件编号', '组序号'].concat(COMBINE_COLUMNS.map(column => column[1])).map(header => ({ header }));

  let itemRows = 0; let combineRows = 0;
  snapshot.forEach(order => {
    const groups = Array.isArray(order.combine) ? order.combine : [];
    orders.addRow([order.posting, valueForExport(order.finance && order.finance.purchaseCost), versionOf(rawByPosting.get(text(order.posting, 180))), groups.length]);
    (order.items || []).forEach((item, index) => {
      itemRows += 1;
      const stock = item.stockIn && typeof item.stockIn === 'object' ? item.stockIn : {};
      items.addRow([order.posting, index + 1, item.offerId || '', item.sku || '', item.qty || item.quantity || '']
        .concat(MANUAL_COLUMNS.map(column => valueForExport(item[column[0]])))
        .concat(STOCK_COLUMNS.map(column => valueForExport(stock[column[0]]))));
    });
    groups.forEach((group, index) => {
      combineRows += 1;
      combines.addRow([order.posting, index + 1].concat(COMBINE_COLUMNS.map(column => valueForExport(group && group[column[0]]))));
    });
  });
  if (itemRows > MAX_DETAIL_ROWS || combineRows > MAX_DETAIL_ROWS) throw problem('manual_excel_detail_limit', '手动数据明细超过 50000 行');
  styleSheet(orders, [24, 16, 66, 14]);
  styleSheet(items, [24, 12, 24, 20, 12].concat(MANUAL_COLUMNS.map(column => /备注|地址/.test(column[1]) ? 28 : 18), STOCK_COLUMNS.map(() => 18)));
  styleSheet(combines, [24, 12].concat(COMBINE_COLUMNS.map(column => /备注|地址/.test(column[1]) ? 28 : 18)));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function assertHeaders(sheet, expected) {
  if (!sheet) throw problem('manual_excel_sheet_missing', FORMAT_ERROR_MESSAGE);
  expected.headers.forEach((header, index) => {
    if (cellText(sheet.getRow(1).getCell(index + 1), 100) !== header) {
      throw problem('manual_excel_header_invalid', FORMAT_ERROR_MESSAGE);
    }
  });
}

function rowsWithPosting(sheet) {
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    const posting = cellText(row.getCell(1), 180);
    if (!posting) throw problem('manual_excel_posting_required', `“${sheet.name}”第 ${rowNumber} 行缺少货件编号`);
    rows.push({ row, rowNumber, posting });
  }
  return rows;
}

async function parseWorkbook(buffer, input = {}) {
  zipPreflight(buffer);
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); }
  catch (error) { throw problem('manual_excel_invalid_file', 'Excel 文件无法读取或已经损坏'); }
  if (workbook.worksheets.length > MAX_SHEETS) throw problem('manual_excel_resource_limit', 'Excel 工作表过多，无法安全导入。');
  const info = workbook.getWorksheet('说明');
  const ordersSheet = workbook.getWorksheet('订单');
  const itemsSheet = workbook.getWorksheet('商品');
  const combinesSheet = workbook.getWorksheet('合包组');
  if (!info || cellText(info.getCell('B1'), 100) !== FORMAT_MARKER) throw problem('manual_excel_format_invalid', FORMAT_ERROR_MESSAGE);
  const tenantId = cellText(info.getCell('B2'), 64);
  if (!tenantId || tenantId !== text(input.tenantId, 64)) throw problem('manual_excel_tenant_mismatch', 'Excel 文件所属租户与当前选择的租户不一致');

  const orderHeaders = ['货件编号', '采购成本', '订单版本', '合包组数量'];
  if (ordersSheet && cellText(ordersSheet.getRow(1).getCell(3), 100) !== '订单版本') throw problem('manual_excel_version_required', 'Excel 模板缺少订单版本列，请先重新导出后再导入');
  const itemHeaders = ['货件编号', '商品序号', 'Offer ID', 'SKU', '数量'].concat(MANUAL_COLUMNS.map(column => column[1]), STOCK_COLUMNS.map(column => column[1]));
  const combineHeaders = ['货件编号', '组序号'].concat(COMBINE_COLUMNS.map(column => column[1]));
  assertHeaders(ordersSheet, { sheet: '订单', headers: orderHeaders });
  if (itemsSheet && cellText(itemsSheet.getRow(1).getCell(5), 100) !== '数量') throw problem('manual_excel_quantity_column_required', '旧版文件缺少商品数量，请重新导出后填写。');
  assertHeaders(itemsSheet, { sheet: '商品', headers: itemHeaders });
  assertHeaders(combinesSheet, { sheet: '合包组', headers: combineHeaders });

  const orderRows = rowsWithPosting(ordersSheet);
  const itemRows = rowsWithPosting(itemsSheet);
  const combineRows = rowsWithPosting(combinesSheet);
  if (orderRows.length > MAX_ORDERS) throw problem('manual_excel_order_limit', '手动数据订单数超过 10000 条');
  if (itemRows.length > MAX_DETAIL_ROWS || combineRows.length > MAX_DETAIL_ROWS) throw problem('manual_excel_detail_limit', '手动数据明细超过 50000 行');

  const byPosting = new Map();
  orderRows.forEach(({ row, rowNumber, posting }) => {
    if (byPosting.has(posting)) throw problem('manual_excel_duplicate_order', `“订单”第 ${rowNumber} 行货件编号重复`);
    const purchaseCost = decimal(cellText(row.getCell(2), 80), `“订单”第 ${rowNumber} 行采购成本`);
    const version = cellText(row.getCell(3), 80); if (!/^[a-f0-9]{64}$/i.test(version)) throw problem('manual_excel_version_required', `“订单”第 ${rowNumber} 行缺少有效订单版本，请先重新导出后再导入`);
    const order = { posting, items: [], version };
    if (purchaseCost !== '') order.finance = { purchaseCost };
    byPosting.set(posting, order);
  });

  const itemKeys = new Set();
  itemRows.forEach(({ row, rowNumber, posting }) => {
    const order = byPosting.get(posting);
    if (!order) throw problem('manual_excel_unknown_order', `“商品”第 ${rowNumber} 行的货件编号不在“订单”工作表中`);
    const sequenceText = cellText(row.getCell(2), 20);
    if (!sequenceText) throw problem('manual_excel_item_sequence_required', `“商品”第 ${rowNumber} 行缺少商品序号`);
    const sequence = positiveInteger(sequenceText, `“商品”第 ${rowNumber} 行商品序号`);
    const key = posting + '\u0000' + sequence;
    if (itemKeys.has(key)) throw problem('manual_excel_duplicate_item', `“商品”第 ${rowNumber} 行商品序号重复`);
    itemKeys.add(key);
    const qty = positiveInteger(cellText(row.getCell(5), 40), `“商品”第 ${rowNumber} 行数量`);
    if (!qty) throw problem('manual_excel_item_quantity_required', `“商品”第 ${rowNumber} 行缺少数量`);
    const item = { idx: Number(sequence) - 1, offerId: cellText(row.getCell(3), 240), sku: cellText(row.getCell(4), 240), qty };
    if (!item.sku) throw problem('manual_excel_item_sku_required', `“商品”第 ${rowNumber} 行缺少 SKU`);
    let columnIndex = 6;
    MANUAL_COLUMNS.forEach(([field, label]) => {
      const value = cellText(row.getCell(columnIndex), 2000);
      const parsed = DECIMAL_FIELDS.has(field) ? decimal(value, `“商品”第 ${rowNumber} 行${label}`) : value;
      if (parsed !== '') item[field] = parsed;
      columnIndex += 1;
    });
    const stock = {};
    STOCK_COLUMNS.forEach(([field, label]) => {
      const value = cellText(row.getCell(columnIndex), 2000);
      const parsed = field === 'qty' ? positiveInteger(value, `“商品”第 ${rowNumber} 行${label}`)
        : DECIMAL_FIELDS.has(field) ? decimal(value, `“商品”第 ${rowNumber} 行${label}`) : value;
      if (parsed !== '') stock[field] = parsed;
      columnIndex += 1;
    });
    const hasStock = Object.values(stock).some(value => value !== '');
    if (hasStock && !stock.qty) throw problem('manual_excel_stock_quantity_required', `“商品”第 ${rowNumber} 行填写入仓信息时必须填写入仓数量`);
    if (hasStock) item.stockIn = stock;
    order.items.push(item);
  });

  const combineKeys = new Set();
  combineRows.forEach(({ row, rowNumber, posting }) => {
    const order = byPosting.get(posting);
    if (!order) throw problem('manual_excel_unknown_order', `“合包组”第 ${rowNumber} 行的货件编号不在“订单”工作表中`);
    const sequenceText = cellText(row.getCell(2), 20);
    if (!sequenceText) throw problem('manual_excel_combine_sequence_required', `“合包组”第 ${rowNumber} 行缺少组序号`);
    const sequence = positiveInteger(sequenceText, `“合包组”第 ${rowNumber} 行组序号`);
    const key = posting + '\u0000' + sequence;
    if (combineKeys.has(key)) throw problem('manual_excel_duplicate_combine', `“合包组”第 ${rowNumber} 行组序号重复`);
    combineKeys.add(key);
    const group = {};
    COMBINE_COLUMNS.forEach(([field, label], index) => {
      const value = cellText(row.getCell(index + 3), 2000);
      group[field] = DECIMAL_FIELDS.has(field) ? decimal(value, `“合包组”第 ${rowNumber} 行${label}`) : value;
    });
    (order.combine || (order.combine = [])).push({ sequence: Number(sequence), value: group });
  });

  for (const order of byPosting.values()) {
    order.items.sort((a, b) => a.idx - b.idx);
    if (order.combine) { order.combine.sort((a, b) => a.sequence - b.sequence); order.combine = order.combine.map(item => item.value); }
  }
  return Array.from(byPosting.values());
}

function mergeSnapshots(existing, imported) {
  const merged = new Map(orderOperations.normalizeManualOrderSnapshot(existing).map(order => [text(order && order.posting, 180), order]));
  orderOperations.normalizeManualOrderSnapshot(imported).forEach(order => {
    const posting = text(order && order.posting, 180);
    if (posting) merged.set(posting, order);
  });
  return Array.from(merged.values());
}

function manualSnapshot(orders) {
  const snapshot = orderOperations.createManualOrderSnapshot(orders);
  const rawByPosting = new Map((orders || []).map(order => [text(order && order.posting, 180), order]));
  snapshot.forEach(order => (order.items || []).forEach((item, index) => {
    const raw = rawByPosting.get(text(order.posting, 180));
    item.qty = raw && raw.items && (raw.items[index].qty || raw.items[index].quantity) || '';
  }));
  return snapshot;
}

function itemKey(item) {
  return text(item && item.sku, 240) + '\u0000' + positiveInteger(item && (item.qty || item.quantity), '订单商品数量');
}

function applyImport(currentOrders, importedOrders) {
  const currentByPosting = new Map((currentOrders || []).map(order => [text(order && order.posting, 180), order]));
  const fields = MANUAL_COLUMNS.map(column => column[0]).concat(['stockIn']);
  (importedOrders || []).forEach(imported => {
    const current = currentByPosting.get(text(imported && imported.posting, 180));
    if (!current) throw problem('manual_excel_order_not_found', `货件“${text(imported && imported.posting, 180)}”不在当前订单中，导入未开始`);
    const currentByKey = new Map(), ambiguous = new Set();
    (current.items || []).forEach(item => {
      const key = itemKey(item);
      if (!key || currentByKey.has(key)) throw problem('manual_excel_item_match_ambiguous', `货件“${current.posting}”存在重复 SKU 与数量，导入未开始`);
      currentByKey.set(key, item);
    });
    const importedItems = Array.isArray(imported.items) ? imported.items : [];
    const used = new Set();
    importedItems.forEach(item => {
      const key = itemKey(item), target = currentByKey.get(key);
      if (!target || ambiguous.has(key) || used.has(key)) throw problem('manual_excel_item_match_ambiguous', `货件“${current.posting}”的 SKU 与数量无法唯一匹配，导入未开始`);
      used.add(key); fields.forEach(field => { if (Object.prototype.hasOwnProperty.call(item, field)) target[field] = item[field]; });
    });
    if (Object.prototype.hasOwnProperty.call(imported, 'combine')) current.combine = imported.combine;
    if (imported.finance && Object.prototype.hasOwnProperty.call(imported.finance, 'purchaseCost')) {
      current.finance = current.finance || {}; current.finance.purchaseCost = imported.finance.purchaseCost;
    }
  });
  return currentOrders;
}

module.exports = { FORMAT_MARKER, buildWorkbook, parseWorkbook, mergeSnapshots, manualSnapshot, applyImport, versionOf };
