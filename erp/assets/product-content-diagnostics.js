(function (root) {
  'use strict';
  function node(tag, text) { var element = document.createElement(tag); if (text != null) element.textContent = text; return element; }
  function scope() {
    var storage = root.erpStorage || {};
    return JSON.stringify([storage.getCurrentUser ? storage.getCurrentUser() : '', storage.getSelectedTenantId ? storage.getSelectedTenantId() : '']);
  }
  function attach(container, id, request) {
    if (!container) return;
    var previous = container.querySelector('[data-content-diagnostic]');
    if (previous) previous.remove();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) return;
    var sourceScope = scope(), row = node('span', ' 请求编号：' + id + ' '), link = node('a', '查看本次处理记录');
    row.dataset.contentDiagnostic = id; link.href = '#'; row.append(link); container.append(row); container.hidden = false;
    link.addEventListener('click', function (event) {
      event.preventDefault();
      var dialog = node('dialog'), header = node('header'), close = node('button', '关闭'), body = node('div', '正在读取处理记录…');
      dialog.className = document.querySelector('.ai-config-page') ? 'ai-test-log' : 'product-translation-dialog'; close.type = 'button';
      header.append(node('h2', '商品内容处理记录'), close); dialog.append(header, body); document.body.append(dialog);
      close.addEventListener('click', function () { dialog.close(); });
      dialog.addEventListener('close', function () { dialog.remove(); }); dialog.showModal();
      if (scope() !== sourceScope) { body.textContent = '账号或工作空间已变化，请返回原工作空间后查看处理记录。'; return; }
      Promise.resolve().then(function () { return request('/api/domain/product-content-diagnostics/' + encodeURIComponent(id)); }).then(function (data) {
        if (!dialog.open) return;
        if (scope() !== sourceScope) { body.textContent = '账号或工作空间已变化，未显示原工作空间的处理记录。'; return; }
        body.replaceChildren();
        var labels = { title: '商品标题', tags: '主题标签', summary: '商品简介', attribute: '商品属性', attributes: '商品属性', sellingPoints: '卖点提炼', richTitle: '图文标题', richDescription: '图文描述' };
        body.append(node('p', '请求编号：' + id), node('p', '时间：' + (data.createdAt || '未提供')), node('p', '字段：' + (Array.isArray(data.fields) ? data.fields.map(function (field) { return labels[field] || '商品内容'; }).join('、') : '未提供')), node('p', '处理状态：' + (data.statusText || '未提供')));
        (Array.isArray(data.reasons) ? data.reasons : []).forEach(function (reason) { if (reason.message) body.append(node('p', reason.message)); });
        if (Array.isArray(data.materialMatches) && data.materialMatches.length) {
          body.append(node('h3', '材料英文放行依据'));
          data.materialMatches.forEach(function (match) {
            body.append(node('p', '词条：' + String(match.term || '未提供')));
            body.append(node('p', '来源：' + (match.source === 'title' ? '原标题' : match.source === 'attributes' ? '材质属性' : '未提供')));
            if (match.source === 'attributes' && match.field) body.append(node('p', '材质字段：' + String(match.field)));
            body.append(node('p', '依据原文：' + String(match.evidence || '未提供')));
          });
        }
        var responseTitle = data.rawRedacted === true ? '模型原始返回（敏感信息已脱敏）' : '原始模型返回';
        body.append(node('h3', responseTitle));
        if (data.rawRedacted === true) body.append(node('p', '以下内容已隐藏敏感信息，不是未经处理的原始响应字节。'));
        if (typeof data.rawResponse === 'string') { var raw = node('textarea', data.rawResponse); raw.readOnly = true; raw.rows = 12; raw.setAttribute('aria-label', responseTitle); body.append(raw); }
        else body.append(node('p', data.rawComplete === false && data.rawBytes > 0 ? '原始响应未完整保存，无法查看正文；响应大小：' + data.rawBytes + ' 字节。' : '本次记录没有可查看的原始模型响应。'));
      }).catch(function (error) { if (dialog.open) body.textContent = error && typeof error.serverMessage === 'string' && /[\u3400-\u9fff]/.test(error.serverMessage) ? error.serverMessage : '处理记录读取失败，请检查网络后重试。'; });
    });
  }
  root.WYERP_PRODUCT_CONTENT_DIAGNOSTICS = { attach: attach };
})(window);
