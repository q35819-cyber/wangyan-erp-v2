'use strict';
(() => {
  const C = WyCapture;
  const $ = id => document.getElementById(id);
  const records = new Map();
  const sourceTabs = new Map();
  const selectedMedia = new Set();
  let currentKey = null;
  let port = null;
  let lastActivity = Date.now();
  let reviewDirty = false;
  const current = () => records.get(currentKey);
  const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const priceText = item => !item ? '未单独采集' : (item.amount ?? (item.min !== null ? item.min + ' – ' + item.max : '待核实')) + (item.currency ? ' ' + item.currency : '（币种未知）');
  const labels = { display: '页面展示', card: '卡价/会员条件', bank: '指定银行条件', original: '划线原价', structured_offer: '结构化报价', range: '价格范围', tier: '阶梯价', sku: '规格价格', main: '主图', detail: '详情', variant: '规格图', video_cover: '视频封面' };
  const variantKey = C.variantKey;
  function table(id, rows, empty, columns) {
    const tbody = $(id); tbody.replaceChildren();
    if (!rows.length) { const tr = node('tr'); const td = node('td', empty); td.colSpan = columns; tr.append(td); tbody.append(tr); return; }
    for (const cells of rows) { const tr = node('tr'); for (const value of cells) { const td = node('td'); if (value instanceof Node) td.append(value); else td.textContent = String(value ?? ''); td.title = td.textContent; tr.append(td); } tbody.append(tr); }
  }
  function link(value, text) { const a = node('a', text); a.href = value; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }
  function rememberReview() {
    if (!current() || !reviewDirty) return true;
    const amount = $('shipping-amount').value.trim(); const currency = $('shipping-currency').value; const quantity = $('quantity').value.trim();
    if (amount && (!/^\d{1,12}(\.\d{1,4})?$/.test(amount) || !currency)) { status('人工运费须是非负数字，并选择币种；未知请留空。', true); return false; }
    if (quantity !== '1') { status('本期仅核对每个SKU买1件的运费。', true); return false; }
    const variantReviews = [];
    for (const row of $('sku-review').querySelectorAll('tr[data-variant-key]')) {
      const fee = row.querySelector('[data-field="fee"]').value.trim(); const feeCurrency = row.querySelector('[data-field="currency"]').value; const grams = row.querySelector('[data-field="grams"]').value.trim();
      if (fee && (!/^\d{1,12}(\.\d{1,4})?$/.test(fee) || !feeCurrency)) { status('SKU单件运费须为非负数字，并选择对应币种。', true); return false; }
      if (grams && (!/^\d{1,12}(\.\d{1,4})?$/.test(grams) || /^0+(?:\.0+)?$/.test(grams))) { status('SKU包装重量须大于0克；未知请留空。', true); return false; }
      const sizeText = row.querySelector('[data-field="dimensions"]').value.trim(); const size = C.dimensions(sizeText ? sizeText + 'mm' : '');
      if (sizeText && size.lengthMm === null) { status('SKU包装尺寸请按长×宽×高填写正数，单位毫米；未知请留空。', true); return false; }
      variantReviews.push({ variantKey: row.dataset.variantKey, label: row.dataset.label, unitShipping: { quantity: 1, amount: fee || null, currency: feeCurrency || null }, packagingWeight: { grams: grams || null }, packagingDimensions: size, provenance: 'user_note_unverified' });
    }
    current().review = { destinationCity: C.cleanText($('city').value, 80), quantity: '1', shippingAmount: amount ? C.decimal(amount, currency) : null, shippingCurrency: currency || null, variants: variantReviews, notes: C.cleanText($('notes').value, 2000), provenance: 'user_note_unverified', updatedAt: new Date().toISOString() };
    reviewDirty = false; $('review-status').textContent = '已应用，仅用于本次导出'; return true;
  }
  function renderList() {
    $('records').replaceChildren(); $('count').textContent = records.size + ' / 20'; $('export-all').disabled = records.size === 0;
    for (const [key, record] of records) { const button = node('button', undefined, 'record' + (currentKey === key ? ' selected' : '')); button.title = record.title; button.append(node('strong', record.title), node('span', record.source.platform.toUpperCase() + ' · ' + record.source.productId)); button.addEventListener('click', () => { if (!rememberReview()) return; currentKey = key; selectedMedia.clear(); render(); }); $('records').append(button); }
  }
  function render() {
    renderList(); const record = current(); $('empty').hidden = !!record; $('detail').hidden = !record; if (!record) return;
    $('platform').textContent = record.source.platform.toUpperCase() + ' / 待核实'; $('title').textContent = record.title; $('source').href = record.source.url; $('captured').textContent = '采集时间：' + record.source.capturedAt + ' · 适配器 ' + record.adapterVersion;
    $('store-binding').textContent = record.source.platform === 'ozon' ? (record.storeBinding?.status === 'candidate' ? '卖家店铺候选：' + record.storeBinding.storeId + '（仅浏览器会话确认，正式权限由ERP服务端复核）' : '卖家店铺：尚未绑定；请登录seller.ozonru.cn / seller.ozon.ru后使用网页右侧绑定按钮。') : '';
    $('open-sidebar').hidden = record.source.platform !== 'ozon';
    $('open-sidebar').disabled = !sourceTabs.has(currentKey);
    $('metrics').replaceChildren();
    for (const [label, value] of [['主图', record.media.filter(item => item.kind === 'image' && item.role === 'main').length], ['详情图', record.media.filter(item => item.kind === 'image' && item.role === 'detail').length], ['视频', record.media.filter(item => item.kind === 'video').length], ['可见规格', record.variants.length], ['属性', record.attributes.length]]) { const metric = node('div', undefined, 'metric'); metric.append(node('strong', value), node('span', label)); $('metrics').append(metric); }
    $('warnings').replaceChildren(...record.warnings.map(item => node('li', item)));
    table('prices', record.prices.map(item => [labels[item.kind] || item.kind, item.raw, item.currency || '未知', priceText(item), item.quantityText || '未标注']), '价格未读取；请登录或选择规格后重新采集。', 5);
    $('minimum').textContent = '起订条件：' + (record.minimumOrderText || '未读取') + ' · 混批原文：' + (record.purchaseConditions?.mixedBatchText || '未读取');
    table('variants', record.variants.map(item => [item.label, item.skuId || item.id, item.price ? item.price.raw + ' (' + (item.price.currency || '未知币种') + ')' : '未知，不复用页面价', item.stockText || '未知', item.url ? link(item.url, '打开关联商品 ↗') : '当前DOM行']), '未读取到规格行；不能据此认定商品为单规格。', 5);
    $('options').textContent = record.variationOptions.map(group => group.name + '：' + group.values.join(' / ')).join('；') || '只显示已加载规格，不生成笛卡尔积，不访问隐藏接口。';
    table('attributes', record.attributes.map(item => [item.name, item.value]), '未读取到属性；请展开参数后重新采集。', 2);
    $('supplier').textContent = '店铺/供应商：' + (record.supplier.name || '未读取') + (record.categoryPath.length ? ' · 类目：' + record.categoryPath.join(' / ') : '');
    $('shipping').textContent = '页面运费原文：' + (record.shipping.rawText || '未知') + '（未完成地区/数量核价）';
    const review = record.review || {}; $('city').value = review.destinationCity || ''; $('quantity').value = '1'; $('shipping-amount').value = review.shippingAmount ?? ''; $('shipping-currency').value = review.shippingCurrency || ''; $('notes').value = review.notes || ''; $('review-status').textContent = review.updatedAt ? '已应用，仅用于本次导出' : ''; reviewDirty = false;
    renderSkuReview(record);
    $('description').textContent = (record.descriptionText || '未读取到详情文字') + (record.structuredDescriptionText && record.structuredDescriptionText !== record.descriptionText ? '\n\n商品结构化描述：\n' + record.structuredDescriptionText : ''); $('measurements').textContent = record.measurements.length ? '包装/重量原文（未自动换算）：\n' + record.measurements.map(item => item.name + '：' + item.value).join('\n') : '未读取到包装尺寸或重量';
    renderMedia();
  }
  function renderSkuReview(record) {
    $('sku-review').replaceChildren();
    if (!record.variants.length) { table('sku-review', [], '尚未识别SKU，不能分配单件运费、重量或尺寸。', 6); return; }
    for (const variant of record.variants) {
      const key = variantKey(variant, record); const saved = record.review?.variants?.find(item => item.variantKey === key);
      const row = node('tr'); row.dataset.variantKey = key; row.dataset.label = variant.label;
      const labelCell = node('td', variant.label); labelCell.title = variant.label;
      const feeRaw = node('td', variant.unitShipping?.status === 'below_minimum_order' ? '起批量>1，单件未核价' : variant.unitShipping?.rawText || '未知'); feeRaw.title = feeRaw.textContent;
      const weightRaw = node('td', (variant.packagingWeight?.rawText || '未知') + (variant.packagingWeight?.grams ? ' → ' + variant.packagingWeight.grams + 'g' : '')); weightRaw.title = weightRaw.textContent;
      const feeCell = node('td'); const fee = node('input'); fee.inputMode = 'decimal'; fee.maxLength = 20; fee.dataset.field = 'fee'; fee.placeholder = '未知'; fee.setAttribute('aria-label', variant.label + ' 单件运费'); fee.value = saved?.unitShipping?.amount ?? '';
      const currency = node('select'); currency.dataset.field = 'currency'; currency.setAttribute('aria-label', variant.label + ' 运费币种'); for (const code of ['', 'CNY', 'RUB', 'BYN', 'KZT']) { const option = node('option', code || '币种'); option.value = code; currency.append(option); } currency.value = saved?.unitShipping?.currency || variant.unitShipping?.currency || '';
      feeCell.append(fee, currency);
      const weightCell = node('td'); const weight = node('input'); weight.inputMode = 'decimal'; weight.maxLength = 20; weight.dataset.field = 'grams'; weight.placeholder = '未知（g）'; weight.setAttribute('aria-label', variant.label + ' 包装重量克'); weight.value = saved?.packagingWeight?.grams ?? ''; weightCell.append(weight);
      const dimensionsCell = node('td'); const dimensions = node('input'); dimensions.maxLength = 60; dimensions.dataset.field = 'dimensions'; dimensions.placeholder = '未知；长×宽×高'; dimensions.setAttribute('aria-label', variant.label + ' 包装尺寸毫米'); const savedDimensions = saved?.packagingDimensions; dimensions.value = savedDimensions?.lengthMm ? [savedDimensions.lengthMm, savedDimensions.widthMm, savedDimensions.heightMm].join('×') : ''; dimensionsCell.append(dimensions, node('small', variant.packagingDimensions?.rawText || '源页尺寸未知'));
      row.append(labelCell, feeRaw, weightRaw, feeCell, weightCell, dimensionsCell); $('sku-review').append(row);
    }
  }
  function renderMedia() {
    $('media').replaceChildren();
    for (const item of current().media) {
      const card = node('div', undefined, 'media-card' + (selectedMedia.has(item.id) ? ' selected' : ''));
      if (item.kind === 'image') { const img = node('img'); img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.alt = (labels[item.role] || item.role) + ' ' + item.id; img.src = item.url; img.addEventListener('error', () => { img.replaceWith(node('div', '预览不可用，请打开原始链接', 'video-placeholder')); }, { once: true }); card.append(img); }
      else card.append(node('div', 'VIDEO / 原始视频链接', 'video-placeholder'));
      const label = node('label'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedMedia.has(item.id); checkbox.setAttribute('aria-label', '选择素材 ' + item.id);
      checkbox.addEventListener('change', () => { if (checkbox.checked) selectedMedia.add(item.id); else selectedMedia.delete(item.id); card.classList.toggle('selected', checkbox.checked); });
      label.append(checkbox, node('span', (item.kind === 'video' ? '视频' : labels[item.role]) + ' · ' + item.id.replace('media-', ''))); card.append(label, link(item.url, '打开原始素材 ↗')); $('media').append(card);
    }
    if (!current().media.length) $('media').append(node('p', '暂无可下载素材', 'hint'));
  }
  async function exportBlob(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    try { await chrome.downloads.download({ url, filename, saveAs: true }); status('已提交导出下载，请在浏览器下载列表确认文件保存成功。'); }
    catch (_) { status('导出被取消或下载失败，当前数据仍在，可重新导出。', true); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  }
  const exportRecords = items => exportBlob(JSON.stringify({ format: 'wyerp-source-capture', schemaVersion: 1, exportedAt: new Date().toISOString(), records: items }, null, 2), 'wyerp-capture-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', 'application/json');
  $('open-sidebar').addEventListener('click', () => {
    const tabId = sourceTabs.get(currentKey); if (!Number.isInteger(tabId)) return;
    // Call directly inside the user gesture, before awaiting any browser action.
    try {
      chrome.sidePanel.open({ tabId }).then(() => chrome.tabs.update(tabId, { active: true })).catch(() => status('侧栏未能打开，请确认Edge支持侧栏，并回到来源页重新采集后再试。', true));
    } catch (_) { status('此浏览器未提供侧栏接口。采集和导出仍可使用。', true); }
  });
  $('export-all').addEventListener('click', () => { if (rememberReview()) exportRecords([...records.values()]); });
  $('export-one').addEventListener('click', () => { if (rememberReview()) exportRecords([current()]); });
  $('export-csv').addEventListener('click', () => { if (rememberReview()) exportBlob(C.csv([...records.values()]), 'wyerp-capture-summary.csv', 'text/csv;charset=utf-8'); });
  $('export-sku-csv').addEventListener('click', () => { if (rememberReview()) exportBlob(C.variantsCsv([...records.values()]), 'wyerp-capture-skus.csv', 'text/csv;charset=utf-8'); });
  $('export-links').addEventListener('click', () => exportBlob(current().media.map(item => item.kind + '\t' + item.role + '\t' + item.url).join('\r\n'), 'wyerp-' + current().source.productId + '-media.txt', 'text/plain;charset=utf-8'));
  $('select-images').addEventListener('click', () => { for (const item of current().media) if (item.kind === 'image') selectedMedia.add(item.id); renderMedia(); });
  $('clear-selection').addEventListener('click', () => { selectedMedia.clear(); renderMedia(); });
  $('download-media').addEventListener('click', async () => {
    const record = current(); const items = record.media.filter(item => selectedMedia.has(item.id));
    if (!items.length) { status('请先勾选要下载的素材。', true); return; }
    if (items.length > 100) { status('单次最多下载100个素材，请分批选择。', true); return; }
    $('download-media').disabled = true; let submitted = 0; let failed = 0;
    try { for (const item of items) { if (!C.mediaUrl(item.url, record.source.url)) { failed++; continue; } try { await chrome.downloads.download({ url: item.url, filename: C.mediaFilename(item, record, record.media.indexOf(item)), conflictAction: 'uniquify', saveAs: false }); submitted++; } catch (_) { failed++; } } }
    finally { $('download-media').disabled = false; status('已提交' + submitted + '个下载任务，' + failed + '个提交失败。实际完成状态请查看浏览器下载列表。', failed > 0); }
  });
  $('remove').addEventListener('click', () => { records.delete(currentKey); currentKey = records.keys().next().value || null; selectedMedia.clear(); reviewDirty = false; render(); status('已移出本次内存列表；未修改服务器数据或已导出的文件。'); });
  $('review-form').addEventListener('input', () => { reviewDirty = true; $('review-status').textContent = '尚未应用'; });
  $('review-form').addEventListener('submit', event => { event.preventDefault(); if (rememberReview()) status('人工核对信息已应用到本次导出。'); });
  function receive(message) {
    if (message?.type === 'capture-error') { status(message.message, true); return; }
    if (message?.type !== 'capture-result') return;
    const record = message.record;
    if (!C.sourceUrl(record?.source?.url) || record.schemaVersion !== 1 || JSON.stringify(record).length > 1500000) { status('拒绝不符合格式的采集结果。', true); return; }
    const key = record.source.platform + ':' + record.source.productId;
    if (records.size >= 20 && !records.has(key)) { status('本次列表已达20件，请先导出并移出部分商品，然后重新采集。', true); return; }
    // Preserve unfinished review values before switching records.
    if (!rememberReview()) { status('收到新采集，但人工运费/数量格式有误，请先修正后重新采集。', true); return; }
    const previous = records.get(key); if (previous?.review) record.review = previous.review;
    if (Number.isInteger(message.sourceTabId) && !message.sidebarUnavailable) sourceTabs.set(key, message.sourceTabId);
    else sourceTabs.delete(key);
    records.set(key, record); currentKey = key; selectedMedia.clear(); lastActivity = Date.now(); render();
    status((previous ? '已更新本次快照，保留人工备注。' : '已采集到本次列表。') + '请核对缺失项；尚未保存到ERP。');
  }
  function connect() {
    try { port = chrome.runtime.connect({ name: 'capture-workspace' }); port.onMessage.addListener(receive); port.onDisconnect.addListener(() => { port = null; }); port.postMessage({ type: 'ready' }); }
    catch (_) { status('插件连接已失效，请导出已有资料，再关闭此页并重新点击插件。', true); }
  }
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { lastActivity = Date.now(); });
  setInterval(() => {
    if (records.size && Date.now() - lastActivity >= 1800000) { records.clear(); sourceTabs.clear(); currentKey = null; selectedMedia.clear(); reviewDirty = false; render(); status('30分钟未操作，已清空内存采集资料。请重新采集。'); }
    if (!port) connect();
  }, 10000);
  window.addEventListener('beforeunload', event => { if (records.size) { event.preventDefault(); event.returnValue = ''; } });
  connect(); render();
})();
