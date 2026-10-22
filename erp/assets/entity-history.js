/* 网研ERP — 商品/订单/店铺逐条操作记录展示 */
(function (global) {
  'use strict';
  var fieldLabels = {
    name: '名称', article: '货号', sku: 'SKU', status: '状态', statusReason: '状态说明', archived: '归档状态',
    ozonStatusCode: 'OZON状态', ozonErrorCodes: 'OZON错误信息', _manual: '人工维护标记',
    priceSell: '销售价', price: '价格', priceOriginal: '划线价', priceLowest: '最低价', pricePromo: '促销价', priceCurrency: '价格币种',
    stock: '库存', stockWarehouseId: '库存仓库编号', stockWarehouseName: '库存仓库名称',
    purchasePrice: '采购价', domesticShipping: '快递费', srcUrl: '货源地址', srcPrice: '货源价格', srcNote: '货源备注',
    commission: '佣金', acquiring: '收单业务费', rfbs: '配送方案', fulfillmentSchema: '履约方案', warehouseNames: '配送仓库',
    items: '商品明细', finance: '财务信息', bought: '采购状态', cancelled: '取消状态', deliveredDate: '签收日期',
    ret: '退货状态', retRel: '关联退货单号', updateTime: '更新时间', combine: '合包信息', track: '物流单号',
    clientId: '店铺编号', apiKey: 'API密钥', remark: '备注', wm: '水印', warehouse: '仓库数量', limit: '商品限额', cookie: '授权状态',
    defaultWarehouseId: '默认仓库编号', defaultWarehouseName: '默认仓库名称', fulfillmentWarehouseNames: '履约仓库', warehouseOptions: '可选仓库'
  };
  function fieldLabel(field, index) {
    return fieldLabels[field] || ('其他信息' + (index + 1));
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }
  function time(value) {
    if (!value) return '--';
    var date = new Date(value);
    return isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
  }
  function operator(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { raw: '', masked: '' };
    return { raw: String(value.raw || ''), masked: String(value.masked || '') };
  }
  function ensureModal() {
    if (document.getElementById('erp-entity-history-modal')) return;
    var modal = document.createElement('div');
    modal.id = 'erp-entity-history-modal';
    modal.className = 'entity-history-mask';
    modal.innerHTML = '<div class="entity-history-box"><div class="entity-history-head"><strong id="erp-entity-history-title">操作记录</strong><button type="button" aria-label="关闭">×</button></div><div class="entity-history-list" id="erp-entity-history-list"></div></div>';
    modal.onclick = function (event) { if (event.target === modal || event.target.closest('.entity-history-head button')) modal.classList.remove('show'); };
    document.body.appendChild(modal);
  }
  function summary(entity, attribute, value) {
    var identity = operator(entity && entity.lastOperatorIdentity);
    if (!identity.masked) return '<div class="entity-audit">历史数据，暂无操作记录</div>';
    return '<div class="entity-audit"><span class="entity-audit-main">' + esc(entity.lastOperation || '修改') + ' · <span class="username-ellipsis" title="' + esc(identity.raw || identity.masked) + '">' + esc(identity.masked) + '</span></span><span class="entity-audit-meta"><span>' + esc(time(entity.lastOperatedAt)) + '</span><span role="button" tabindex="0" class="entity-audit-btn" ' + attribute + '="' + esc(value) + '">最近记录</span></span></div>';
  }
  function open(entity, title) {
    ensureModal();
    var rows = entity && Array.isArray(entity.changeLog) ? entity.changeLog.slice(-10).reverse() : [];
    document.getElementById('erp-entity-history-title').textContent = (title || '数据') + ' · 最近 ' + rows.length + ' 条操作记录';
    document.getElementById('erp-entity-history-list').innerHTML = rows.length ? rows.map(function (row) {
      var fields = (row.changedFields || []).map(fieldLabel);
      var identity = operator(row.operatorIdentity), masked = identity.masked || '历史未记录';
      return '<div class="entity-history-item"><div class="entity-history-action">' + esc(row.action || '修改') + '</div><div class="entity-history-meta"><b class="username-ellipsis" title="' + esc(identity.raw || masked) + '">' + esc(masked) + '</b>　' + esc(time(row.operatedAt)) + (fields.length ? '<br>变更内容：' + esc(fields.join('、')) : '') + '</div></div>';
    }).join('') : '<div class="entity-history-empty">该条数据暂无可追溯的操作记录</div>';
    document.getElementById('erp-entity-history-modal').classList.add('show');
  }
  document.addEventListener('keydown', function (event) {
    var target = event.target;
    if (!target || !target.classList || !target.classList.contains('entity-audit-btn')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    target.click();
  });
  if (document.body) ensureModal();
  else document.addEventListener('DOMContentLoaded', ensureModal, { once: true });
  global.WYERP_ENTITY_HISTORY = { summary: summary, open: open, formatTime: time };
})(window);
