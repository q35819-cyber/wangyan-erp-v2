'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const fields = ['currency', 'sale', 'purchase', 'domestic', 'international', 'other', 'commission', 'advertising'];
  let record = null; let calculation = null; let lastActivity = Date.now(); let port; let reconnectTimer = null; let heartbeatTimer = null;
  const status = text => { $('status').textContent = text; };
  const clear = text => { record = null; calculation = null; $('product').hidden = true; $('calculator').reset(); $('calculation').textContent = '尚未计算'; $('metrics').replaceChildren(); status(text); };
  const input = () => Object.fromEntries(fields.map(key => [key, $(key).value.trim()]));
  function receive(message) {
    if (message?.type === 'sidebar-loading') { clear(message.message || '正在读取当前Ozon商品…'); return; }
    if (message?.type === 'capture-error' || message?.type === 'sidebar-clear') { clear(message.message); return; }
    const item = message?.record; const valid = WyCapture.sourceUrl(item?.source?.url);
    if (message?.type !== 'capture-result' || valid?.platform !== 'ozon' || valid.productId !== item.source.productId) return;
    if (record?.source.productId !== item.source.productId) $('calculator').reset();
    calculation = null; $('calculation').textContent = '数据已更新，请重新计算'; record = item; lastActivity = Date.now(); $('product').hidden = false;
    $('title').textContent = item.title; $('source').href = valid.url; $('captured').textContent = 'SKU ' + valid.productId + ' · ' + item.source.capturedAt;
    $('store-binding').textContent = item.storeBinding?.status === 'candidate' ? '卖家店铺候选：' + item.storeBinding.storeId + '。Cookie原值未保存；ERP服务端仍需复核店铺权限。' : '未绑定卖家店铺。请登录seller.ozonru.cn / seller.ozon.ru并使用网页右侧绑定按钮。';
    const analytics = item.analytics;
    const sources = (analytics?.sources || []).map(item => item.label || (item.id === 'seerfar_ozon_market' ? 'Seerfar' : item.id === 'ozon_public_product_page' ? 'Ozon公开页' : item.id === 'ozon_official_seller_api' ? 'Ozon官方' : '')).filter(Boolean);
    $('metric-source').textContent = sources.length ? '来源：' + sources.join(' + ') + '。官方数据只覆盖绑定店铺有权访问的商品；公开页与第三方兼容值按字段标注。' : '未获取：公开页没有这些字段，且当前没有可用的绑定店铺官方Seller API结果。';
    $('metrics').replaceChildren();
    for (const [key, label] of WyAnalytics.compatibilityDefinitions || WyAnalytics.definitions) {
      const metric = analytics?.metrics?.find(value => value.key === key); const row = document.createElement('div'); const dt = document.createElement('dt'); dt.textContent = label;
      const dd = document.createElement('dd'); dd.textContent = metric?.raw ?? metric?.value ?? '未获取';
      if (key === 'commission' && metric?.raw) { const rates = metric.raw.match(/\d+(?:[.,]\d+)?%/g); if (rates?.length > 1) dd.textContent = rates.join(' / '); }
      if (metric) { const note = document.createElement('small'); const kind = metric.source === 'ozon_official_seller_api' ? (metric.trust === 'official_derived' ? '官方数据推导' : 'Ozon官方') : metric.source === 'ozon_public_product_page' ? '公开页' : '第三方兼容参考'; note.textContent = (metric.period?.label || '当前快照') + ' · ' + kind; dd.append(note); }
      row.append(dt, dd); $('metrics').append(row);
    }
    const warning = (analytics?.warnings || []).find(value => /Seerfar|ERP|读取失败|未配置|超时/.test(String(value)));
    const hasMetrics = (analytics?.metrics || []).some(metric => metric && (metric.raw != null || metric.value != null));
    status(warning ? '部分数据未获取：' + String(warning).slice(0, 180) : hasMetrics ? '商品资料已读取；未获取的指标保留未知。' : '尚未获取有效指标，请确认ERP已登录及Seerfar服务可用。');
  }
  $('calculator').addEventListener('input', () => { calculation = null; $('calculation').textContent = '输入已改变，请重新计算'; });
  $('calculator').addEventListener('submit', event => {
    event.preventDefault(); calculation = WyAnalytics.calculate(input());
    $('calculation').classList.toggle('error', calculation.status !== 'estimate');
    $('calculation').textContent = calculation.status !== 'estimate' ? calculation.message : '佣金：' + calculation.commissionFee + ' ' + calculation.currency + '\n广告费：' + calculation.advertisingFee + '\n总成本：' + calculation.totalCost + '\n单件利润：' + calculation.profit + '\n利润率：' + calculation.marginPercent + '%\n' + calculation.disclaimer;
  });
  $('export').addEventListener('click', async () => {
    if (!record) return;
    const snapshot = { format: 'wyerp-ozon-sidebar', schemaVersion: 1, adapterVersion: WyCapture.VERSION, source: record.source, analytics: record.analytics, calculator: { input: input(), result: calculation, provenance: 'manual_estimate_only' }, exportedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    try { await chrome.downloads.download({ url, filename: 'wyerp-ozon-' + record.source.productId + '-sidebar.json', saveAs: true }); status('导出任务已提交，请查看浏览器下载列表。'); }
    catch (_) { status('下载失败或取消，内存数据仍在，可重试。'); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  });
  function connectPort() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    try {
      const next = chrome.runtime.connect({ name: 'capture-sidebar' }); port = next;
      next.onMessage.addListener(receive);
      next.onDisconnect.addListener(() => {
        if (port !== next) return; port = null;
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        status(record ? '后台连接暂时休眠；当前数据已保留，正在重新连接。' : '后台连接暂时休眠，正在重新连接当前页面。');
        reconnectTimer = setTimeout(connectPort, 500);
      });
      next.postMessage(record ? { type: 'restore', record } : { type: 'ready' });
      heartbeatTimer = setInterval(() => { if (port === next) try { next.postMessage({ type: 'heartbeat' }); } catch (_) { /* onDisconnect handles reconnect */ } }, 15000);
    } catch (_) {
      status(record ? '当前数据已保留；后台尚未恢复，正在重试连接。' : '无法连接扩展，正在重试。');
      reconnectTimer = setTimeout(connectPort, 2000);
    }
  }
  connectPort();
  for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, () => { lastActivity = Date.now(); });
  setInterval(() => { if (record && Date.now() - lastActivity > 1800000) clear('30分钟未操作，内存已清空，请返回Ozon商品页重新打开侧栏。'); }, 10000);
})();
