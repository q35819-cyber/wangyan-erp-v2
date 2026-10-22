(function (root) {
  'use strict';
  function create(settings) {
    var checks = {}, sources = {}, bindings = {}, views = {}, chineseViews = {}, revisions = {};
    function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
    function snapshot(field) { return JSON.stringify({context: settings.context(), pair: settings.pair(field), facts: settings.facts(field, sources[field])}); }
    function complete(pair) { return pair && typeof pair.ru === 'string' && pair.ru.trim(); }
    function chineseMessages(field) { var check = checks[field]; return (check && check.warnings || []).filter(function (item) { return item.language === 'zh' || item.language === 'both'; }).map(function (item) { return item.message; }); }
    function render(field) {
      if (chineseViews[field]) { var chinese = chineseMessages(field); chineseViews[field].textContent = (chinese.length && checks[field].status === 'pending' ? '内容已修改，待重新核对；' : '') + chinese.join('；'); chineseViews[field].hidden = !chinese.length; }
      var view = views[field]; if (!view) return;
      var check = checks[field], warnings = check && Array.isArray(check.warnings) ? check.warnings.filter(function (item) { return item.language !== 'zh'; }) : [];
      view.box.hidden = !(warnings.length || check && (check.status === 'failed' || check.failure));
      view.text.replaceChildren();
      var messages = [];
      if (!check) messages.push('尚未核对');
      else if (check.status === 'pending') messages.push(check.message || '内容已修改，待重新核对');
      else if (check.status === 'passed' && check.scope === 'pair') messages.push('当前双语内容已核对');
      else if (check.status === 'failed') messages.push(check.failure && check.failure.message || check.message || '内容未通过核对，当前文字已保留');
      if (warnings.length) messages.push('发现 ' + warnings.length + ' 项风险');
      warnings.forEach(function (item) { if (item && typeof item.message === 'string') messages.push(item.message); });
      messages.forEach(function (message) { var line = document.createElement('div'); line.textContent = message; view.text.appendChild(line); });
      view.text.style.color = !check || check.status !== 'passed' || warnings.length ? 'var(--red)' : '';
    }
    function changed(field) {
      (field ? [field] : Array.from(new Set(Object.keys(views).concat(Object.keys(checks))))).forEach(function (key) {
        if (bindings[key] && bindings[key].snapshot === snapshot(key)) return;
        if (checks[key]) checks[key] = Object.assign({}, checks[key], {status:'pending', message:'内容已修改，待重新核对'});
        revisions[key] = (revisions[key] || 0) + 1; render(key);
      });
      if (settings.onChange) settings.onChange();
    }
    function adopt(field, data) {
      var check = data && data.checks && data.checks[field];
      if (!check) { delete checks[field]; delete bindings[field]; render(field); return; }
      var checkedLanguage = check.scope === 'ru' ? 'ru' : check.scope === 'translation' ? data.target : '';
      var previousWarnings = checks[field] && checks[field].warnings || [], preserved = [];
      if (checkedLanguage === 'ru' || checkedLanguage === 'zh') {
        var uncheckedLanguage = checkedLanguage === 'ru' ? 'zh' : 'ru';
        preserved = previousWarnings.filter(function (item) { return item.language === uncheckedLanguage || item.language === 'both'; }).map(function (item) { return Object.assign({}, item, {language:uncheckedLanguage}); });
      } else if (check.scope === 'translation') preserved = copy(previousWarnings);
      checks[field] = copy(check);
      preserved.forEach(function (item) {
        var warnings = checks[field].warnings || (checks[field].warnings = []);
        if (!warnings.some(function (existing) { return existing.code === item.code && existing.message === item.message && existing.language === item.language; })) warnings.push(item);
      });
      if (data.reviewSource) sources[field] = copy(data.reviewSource);
      bindings[field] = {context: settings.context(), snapshot: snapshot(field), checkHash:check.checkHash};
      revisions[field] = (revisions[field] || 0) + 1; render(field);
      if (settings.onChange) settings.onChange();
    }
    async function recheck(field) {
      var view = views[field], pair = settings.pair(field);
      if (!complete(pair)) { view.message.textContent = '当前俄语内容为空，请填写后重新核对；已有风险已保留。'; return; }
      var captured = snapshot(field), revision = revisions[field] || 0, pairs = {}, diagnosticIds = {};
      pairs[field] = {ru:pair.ru}; if (typeof pair.zh === 'string' && pair.zh.trim()) pairs[field].zh = pair.zh;
      if (checks[field] && checks[field].diagnosticId) diagnosticIds[field] = checks[field].diagnosticId;
      view.button.disabled = true; view.message.textContent = '正在重新核对，不会调用模型…';
      try {
        var result = await settings.request('/api/domain/commands/product-content-recheck', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({clientId:settings.clientId(), facts:settings.facts(field, sources[field]), pairs:pairs, diagnosticIds:diagnosticIds})});
        if (captured !== snapshot(field) || revision !== (revisions[field] || 0) || settings.alive && !settings.alive()) { view.message.textContent = '内容或原始资料已变化，已保留当前风险，请重新核对。'; return; }
        if (!result.checks || !result.checks[field]) { view.message.textContent = '未返回该字段的核对结果，已有风险已保留，请重试。'; return; }
        adopt(field, result); view.message.textContent = '';
      } catch (error) { view.message.textContent = error && typeof error.serverMessage === 'string' && /[\u3400-\u9fff]/.test(error.serverMessage) ? error.serverMessage : '重新核对失败，请检查网络后重试；已有风险已保留。'; }
      finally { view.button.disabled = false; }
    }
    function attach(field, host) {
      var box = document.createElement('div'), text = document.createElement('div'), button = document.createElement('button'), message = document.createElement('p');
      box.dataset.contentRisk = field; if (host.classList.contains('field')) box.style.gridColumn = '2 / -1'; text.setAttribute('role','status'); button.type = 'button'; button.className = 'btn'; button.textContent = '重新核对'; message.setAttribute('role','status');
      button.addEventListener('click', function () { recheck(field); }); box.append(text, button, message); host.appendChild(box);
      views[field] = {box:box,text:text,button:button,message:message}; render(field); return box;
    }
    function restore(state, local) {
      checks = copy(state && state.fields || {}); sources = copy(local && local.sources || {}); bindings = copy(local && local.bindings || {});
      Object.keys(checks).forEach(function (field) { if (bindings[field] && bindings[field].context !== settings.context()) { delete checks[field]; delete bindings[field]; } else if (!bindings[field]) { checks[field] = Object.assign({}, checks[field], {status:'pending', message:'内容已修改，待重新核对'}); } else if (bindings[field].checkHash !== checks[field].checkHash) { checks[field] = Object.assign({}, checks[field], {status:'pending', message:'内容已修改，待重新核对'}); } });
      changed(); Object.keys(views).forEach(render);
    }
    function failure(field, message) { if (views[field] && message) { views[field].box.hidden = false; views[field].message.textContent = message; views[field].message.style.color = 'var(--red)'; } }
    function attachChinese(field, host) { var box = document.createElement('p'); box.style.color = 'var(--red)'; box.setAttribute('role','status'); host.appendChild(box); chineseViews[field] = box; render(field); }
    return {attachChinese:attachChinese, chineseMessages:chineseMessages, failure:failure, attach:attach, adopt:adopt, changed:changed, recheck:recheck, restore:restore, state:function () { return {schemaVersion:1,fields:copy(checks)}; }, local:function () { return {sources:copy(sources),bindings:copy(bindings)}; }};
  }
  var api = {create:create}; if (typeof module === 'object' && module.exports) module.exports = api; else root.WYERP_PRODUCT_CONTENT_REVIEW = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
