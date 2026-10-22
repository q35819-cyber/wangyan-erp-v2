(function (root) {
  'use strict';
  function canTranslate(field, attribute) {
    field = field || {}; attribute = attribute || {};
    if (field.readOnly || field.disabled || field.choiceInput || Number(attribute.dictionaryId || attribute.dictionary_id) > 0) return false;
    if (field.type && !/^(text|search|textarea)$/i.test(field.type)) return false;
    if (attribute.type && !/^(string|text)$/i.test(attribute.type)) return false;
    if (/^(sourceNote|colorName|name|sku|offerId|barcode|richContent)$/i.test(field.key || '') || String(attribute.id) === '10097') return false;
    var label = [field.label, attribute.name, attribute.nameRu, attribute.nameEn, attribute.format].filter(Boolean).join(' ');
    if (/货源备注|颜色名称|sku\s*名称|数字|数值|代码|编码|编号|货号|条[形码]*码|文件|附件|链接|网址|数量|价格|重量|长度|宽度|高度|尺寸|容量|电压|功率|日期|时间|型号|\b(pdf|url|uri|json|xml|html|sku|code|id|ean|gtin|isbn|upc|file|number|numeric|integer|decimal|float|date|time|model)\b|файл|код|артикул|штрихкод|название цвета|название sku|количество|размер|длина|ширина|высота|объ[её]м|мощность|напряжение/i.test(label)) return false;
    var value = String(field.value == null ? '' : field.value).trim();
    if (value && (/^[\d\s.,+\-/%×x:()]+$/i.test(value) || /^(?=.*[a-z])(?=.*\d)[a-z\d._\-/]+$/i.test(value) || /^(https?:\/\/|www\.|\{|\[|<)/i.test(value) || /\.pdf(?:[?#\s]|$)/i.test(value))) return false;
    return true;
  }
  function create(settings) {
    var controls = [], generation = 0, current = null, sourceLanguage = 'ru', targetLanguage = 'zh', bilingualPairs = new WeakMap(), bilingualByKey = new Map(), BILINGUAL_MAX_AGE = 3 * 24 * 60 * 60 * 1000;
    function node(tag, className, text) { var el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; }
    function button(text, handler, className) { var el = node('button', className || 'btn', text); el.type = 'button'; el.addEventListener('click', handler); return el; }
    var dialog = node('dialog', 'product-translation-dialog');
    dialog.setAttribute('aria-labelledby', 'productTranslationTitle');
    var title = node('h2', '', '翻译'), original = node('textarea'), result = node('textarea');
    title.id = 'productTranslationTitle'; original.readOnly = true; result.readOnly = true;
    original.setAttribute('aria-label', '翻译原文'); result.setAttribute('aria-label', '翻译结果');
    var reviewRisk = node('p', 'product-translation-status'); reviewRisk.style.color = 'var(--red)';
    var status = node('p', 'product-translation-status'), actions = node('div', 'product-translation-actions'); status.setAttribute('role', 'status');
    var sourceButtons = [], targetButtons = [];
    function languageGroup(caption, source) {
      var group = node('div', 'product-translation-languages'), label = node('span', '', caption); group.append(label);
      [['zh','中文'],['ru','俄文'],['en','英文']].forEach(function (language) {
        var el = button(language[1], function () { if (source) sourceLanguage = language[0]; else targetLanguage = language[0]; updateLanguages(); run(); });
        el.setAttribute('aria-label', caption + language[1]); el.dataset.language = language[0]; group.append(el);
        (source ? sourceButtons : targetButtons).push(el);
      }); return group;
    }
    function updateLanguages() {
      sourceButtons.forEach(function (el) { el.setAttribute('aria-pressed', String(el.dataset.language === sourceLanguage)); });
      targetButtons.forEach(function (el) { el.setAttribute('aria-pressed', String(el.dataset.language === targetLanguage)); });
    }
    function fieldKey(input, attribute) {
      if (input && input.id) return 'field:' + input.id;
      var id = attribute && (attribute.id || attribute.attribute_id);
      return id ? 'attribute:' + String(id) : '';
    }
    function validPair(pair) { return pair && typeof pair.zh === 'string' && pair.zh.trim() && typeof pair.ru === 'string' && pair.ru.trim() && Number.isFinite(Number(pair.savedAt)) && Date.now() - Number(pair.savedAt) <= BILINGUAL_MAX_AGE; }
    function pairContext() { return settings.pairContext ? settings.pairContext() : settings.context(); }
    function identityContext() { return JSON.stringify({ identity: settings.identityFacts ? settings.identityFacts() || {} : {}, compatibilityEvidence: settings.compatibilityEvidence ? settings.compatibilityEvidence() : null }); }
    function rememberPair(input, attribute, zh, ru, savedAt) {
      var key = fieldKey(input, attribute);
      if (!key || !String(zh || '').trim() || !String(ru || '').trim()) return false;
      var pair = { zh: String(zh).trim(), ru: String(ru).trim(), savedAt: Number(savedAt) || Date.now(), context: pairContext(), identity: identityContext() };
      bilingualPairs.set(input, pair); bilingualByKey.set(key, pair); return true;
    }
    function valid() { return current && current.input.isConnected && !current.input.disabled && current.input.value === current.original && settings.context() === current.context && identityContext() === current.identity; }
    function run() {
      var ticket = ++generation; apply.disabled = true; result.value = ''; retry.disabled = true;
      var diagnosticId = '', reviewData = null;
      function showDiagnostic() { if (root.WYERP_PRODUCT_CONTENT_DIAGNOSTICS && settings.diagnosticRequest) root.WYERP_PRODUCT_CONTENT_DIAGNOSTICS.attach(status, diagnosticId, settings.diagnosticRequest); }
      if (!current) return;
      if (!settings.translator.isConfigured()) { status.textContent = settings.translator.unavailableMessage; return; }
      status.textContent = '正在翻译…';
      settings.translator.translate(current.original, { source: sourceLanguage, target: targetLanguage, attribute: current.attribute, fieldKey: contentFieldKey(current.input.id, current.attribute), identityFacts: settings.identityFacts ? settings.identityFacts() : undefined, compatibilityEvidence: settings.compatibilityEvidence ? settings.compatibilityEvidence() : undefined, force: true,
        onDiagnostic: function (id) { diagnosticId = id; }, onReview: function (data) { reviewData = data; },
        alive: function () { return ticket === generation && dialog.open && valid(); }
      }).then(function (text) {
        if (ticket !== generation || !dialog.open) return;
        result.value = text; apply.disabled = !valid();
        if (valid() && sourceLanguage === 'ru' && targetLanguage === 'zh') rememberPair(current.input, current.attribute, text, current.original);
        else if (valid() && sourceLanguage === 'zh' && targetLanguage === 'ru') rememberPair(current.input, current.attribute, current.original, text);
        status.textContent = valid() ? '请核对译文，再点击“填入文本框”。原内容尚未改变。' : '原字段或类目已变化，未覆盖新内容，请重新打开翻译。';
        if (valid() && settings.onReview && reviewData) settings.onReview(contentFieldKey(current.input.id, current.attribute), reviewData);
        showDiagnostic();
      }).catch(function (error) {
        if (ticket !== generation || !dialog.open) return;
        status.textContent = /[\u3400-\u9fff]/.test(error.message || '') ? error.message : '翻译失败，原文已保留，请稍后重试。';
        diagnosticId = error.diagnosticId || diagnosticId; showDiagnostic();
      }).finally(function () { if (ticket === generation) retry.disabled = false; });
    }
    var retry = button('重新翻译', run);
    var apply = button('填入文本框', function () {
      if (!valid()) { apply.disabled = true; status.textContent = '原字段或类目已变化，未覆盖新内容，请重新打开翻译。'; return; }
      current.input.value = result.value;
      current.input.dispatchEvent(new Event('input', { bubbles: true }));
      current.input.dispatchEvent(new Event('change', { bubbles: true }));
      dialog.close();
    }, 'btn btn-primary');
    actions.append(button('取消', function () { dialog.close(); }), retry, apply);
    dialog.append(title, node('p', 'product-translation-note', '仅翻译当前字段当前内容；通过服务器AI配置执行，不使用 Edge 翻译，不会自动覆盖或提交到 Ozon。'), languageGroup('原文语言：', true), original, languageGroup('翻译为：', false), result, reviewRisk, status, actions);
    dialog.addEventListener('close', function () { generation++; current = null; original.value = ''; result.value = ''; apply.hidden = false; retry.hidden = false; });
    document.body.append(dialog);
    var actionTip = node('div', 'product-field-action-tooltip'), activeAction = null;
    actionTip.id = 'productFieldActionTooltip'; actionTip.setAttribute('role', 'tooltip'); actionTip.hidden = true; document.body.append(actionTip);
    function hideActionTip() { if (activeAction) activeAction.removeAttribute('aria-describedby'); activeAction = null; actionTip.hidden = true; }
    function showActionTip(event) {
      var action = event.target.closest && event.target.closest('#productForm [data-action-tooltip]');
      if (!action) return;
      hideActionTip(); activeAction = action; actionTip.textContent = action.dataset.actionTooltip; actionTip.hidden = false;
      var rect = action.getBoundingClientRect(), width = actionTip.offsetWidth, height = actionTip.offsetHeight;
      var left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
      var below = rect.top < height + 18;
      actionTip.classList.toggle('below', below);
      actionTip.style.left = left + 'px'; actionTip.style.top = (below ? rect.bottom + 10 : rect.top - height - 10) + 'px';
      actionTip.style.setProperty('--tip-arrow-left', Math.max(10, Math.min(width - 10, rect.left + rect.width / 2 - left)) + 'px');
      action.setAttribute('aria-describedby', actionTip.id);
    }
    document.addEventListener('pointerover', showActionTip);
    document.addEventListener('focusin', showActionTip);
    document.addEventListener('pointerout', function (event) { if (activeAction && activeAction.contains(event.target) && !activeAction.contains(event.relatedTarget)) hideActionTip(); });
    document.addEventListener('focusout', function (event) { if (activeAction && activeAction.contains(event.target)) hideActionTip(); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape') hideActionTip(); });
    document.addEventListener('scroll', hideActionTip, true); window.addEventListener('resize', hideActionTip);

    function attach(input, label, attribute) {
      if (!input) return;
      function eligible() { return canTranslate({ key: input.dataset.field || input.id, label: label, type: input.type, readOnly: input.readOnly, disabled: input.disabled, choiceInput: input.dataset.choiceInput, value: input.value }, attribute); }
      // Help stays beside its input; translation follows it without moving either existing node.
      var wrapper = input.closest('.field-help-control'), help = wrapper && wrapper.querySelector('.field-help-trigger');
      if (!wrapper || !help) return;
      if (!canTranslate({ key: input.dataset.field || input.id, label: label, type: input.type, readOnly: input.readOnly, disabled: input.disabled, choiceInput: input.dataset.choiceInput }, attribute)) return;
      var trigger = button('翻译', function () {
        if (!eligible()) return;
        var context = settings.context(), saved = bilingualPairs.get(input) || bilingualByKey.get(fieldKey(input, attribute));
        if (saved && !validPair(saved)) { bilingualByKey.delete(fieldKey(input, attribute)); saved = null; }
        title.textContent = '翻译' + label;
        var risks = settings.reviewWarnings ? settings.reviewWarnings(contentFieldKey(input.id, attribute)) : []; reviewRisk.textContent = risks.join('；'); reviewRisk.hidden = !risks.length;
        if (saved && saved.context === pairContext() && saved.identity === identityContext() && input.value === saved.ru) {
          current = { input: input, attribute: attribute || {}, original: input.value, context: context, identity: identityContext(), bilingual: saved };
          sourceLanguage = 'ru'; targetLanguage = 'zh'; original.value = saved.ru; result.value = saved.zh;
          updateLanguages(); apply.hidden = true; retry.hidden = true;
          status.textContent = '俄语已写入商品字段；中文仅作为翻译对照保存，不会回写正式商品字段。';
          dialog.showModal(); return;
        }
        current = { input: input, attribute: attribute || {}, original: input.value, context: context, identity: identityContext() };
        original.value = input.value; apply.hidden = false; retry.hidden = false;
        sourceLanguage = settings.translator.source(input.value); targetLanguage = sourceLanguage === 'zh' ? 'ru' : 'zh';
        updateLanguages(); dialog.showModal(); run();
      }, 'btn product-translate-button');
      var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true'); icon.setAttribute('focusable', 'false');
      var strokes = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      strokes.setAttribute('d', 'M3 5h12M9 3v2M6 5c0 5 3 8 7 10M12 5c0 5-3 8-7 10M14 21l4-10 4 10M15.5 17h5');
      icon.append(strokes);
      trigger.textContent = ''; trigger.append(icon); trigger.classList.add('product-translate-icon-only', 'product-field-action');
      trigger.setAttribute('aria-label', '翻译并预览' + label); trigger.dataset.actionTooltip = '翻译预览：中文⇄俄文'; help.after(trigger);
      function update() { trigger.hidden = !eligible(); wrapper.classList.toggle('product-translation-enabled', !trigger.hidden); }
      input.addEventListener('input', update); input.addEventListener('change', update); update();
      controls.push({ wrapper: wrapper, input: input, attribute: attribute || {}, trigger: trigger, update: update });
      var restored = bilingualByKey.get(fieldKey(input, attribute)); if (restored && validPair(restored)) bilingualPairs.set(input, restored);
    }
    function clear() { controls.forEach(function (item) { item.input.removeEventListener('input', item.update); item.input.removeEventListener('change', item.update); item.trigger.remove(); item.wrapper.classList.remove('product-translation-enabled'); }); controls = []; }
    function refresh(attributes, bindings) {
      clear();
      var added = new Set();
      function field(input, label, a) { if (!input || added.has(input)) return; added.add(input); attach(input, label, a); }
      [['title','标题'],['brand','品牌'],['description','简介'],['hashtags','主题标签']].forEach(function (pair) { field(document.getElementById(pair[0]), pair[1]); });
      document.querySelectorAll('[data-attribute-index]').forEach(function (input) {
        var a = attributes[Number(input.dataset.attributeIndex)];
        if (a && (!a.type || /^(string|text)$/i.test(a.type))) field(input, a.name || '属性', a);
      });
    }
    function rememberBilingual(inputOrId, pair) {
      var input = typeof inputOrId === 'string' ? document.getElementById(inputOrId) : inputOrId;
      return input ? rememberPair(input, {}, pair && pair.zh, pair && pair.ru, pair && pair.savedAt) : false;
    }
    function exportState() {
      var pairs = {}, now = Date.now();
      bilingualByKey.forEach(function (pair, key) { if (validPair(pair) && pair.context === pairContext() && pair.identity === identityContext() && now - Number(pair.savedAt) <= BILINGUAL_MAX_AGE) pairs[key] = { zh: pair.zh, ru: pair.ru, savedAt: Number(pair.savedAt), identity: pair.identity, context: pair.context }; });
      return { version: 1, pairs: pairs };
    }
    function restoreState(state) {
      bilingualByKey.clear(); bilingualPairs = new WeakMap();
      var pairs = state && state.pairs && typeof state.pairs === 'object' ? state.pairs : {};
      Object.keys(pairs).forEach(function (key) { var pair = pairs[key]; if (validPair(pair)) bilingualByKey.set(key, { zh: pair.zh.trim(), ru: pair.ru.trim(), savedAt: Number(pair.savedAt), context: typeof pair.context === 'string' ? pair.context : '', identity: typeof pair.identity === 'string' ? pair.identity : '{}' }); });
      controls.forEach(function (item) { var pair = bilingualByKey.get(fieldKey(item.input, item.attribute)); if (pair) bilingualPairs.set(item.input, pair); });
    }
    return { currentPair: function (id) { var input = document.getElementById(id), pair = bilingualByKey.get('field:' + id); return input && validPair(pair) && pair.context === pairContext() ? {zh:pair.zh,ru:input.value} : null; }, clear: clear, refresh: refresh, rememberBilingual: rememberBilingual, exportState: exportState, restoreState: restoreState };
  }
  function contentFieldKey(id, attribute) {
    var attributeId = String(attribute && (attribute.id || attribute.attribute_id) || '');
    if (id === 'title' || attributeId === '4180') return 'title';
    if (id === 'hashtags' || attributeId === '23171') return 'tags';
    if (id === 'description' || attributeId === '4191') return 'summary';
    return 'attribute';
  }
  var api = { create: create, canTranslate: canTranslate, contentFieldKey: contentFieldKey };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_PRODUCT_TRANSLATION_CONTROLS = api;
})(typeof window !== 'undefined' ? window : this);
