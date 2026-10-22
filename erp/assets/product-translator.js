(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { var instance = api.create(); instance.create = api.create; root.WYERP_PRODUCT_TRANSLATOR = instance; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var unavailableMessage = '翻译服务尚未接入，后续可接入 DeepSeek 或其他翻译服务。原文已保留。';
  function source(value) { return /[\u0400-\u04ff]/.test(value) ? 'ru' : /[\u3400-\u9fff]/.test(value) ? 'zh' : 'en'; }
  function create(settings) {
    settings = settings || {};
    // Reserved for a future authenticated server adapter. No browser model or vendor API is used here.
    function isConfigured() { return typeof settings.request === 'function'; }
    function translate(value, options) {
      options = options || {}; value = String(value == null ? '' : value);
      var from = options.source || source(value), to = options.target || 'zh';
      if (!value.trim()) return Promise.reject(new Error('请先填写需要翻译的内容'));
      if (value.length > 20000) return Promise.reject(new Error('每次最多翻译 20000 个字符，请缩短内容后重试'));
      if (['ru','en','zh'].indexOf(from) < 0 || ['ru','en','zh'].indexOf(to) < 0) return Promise.reject(new Error('请选择中文、俄文或英文'));
      if (options.alive && !options.alive()) return Promise.reject(new Error('字段或类目已变化，请重新翻译'));
      if (!isConfigured()) return Promise.reject(new Error(unavailableMessage));
      var controller = new AbortController(), timeout;
      var request = Promise.resolve().then(function () {
        if (options.alive && !options.alive()) throw new Error('字段或类目已变化，请重新翻译');
        return settings.request({ text: value, source: from, target: to, fieldKey: options.fieldKey, identityFacts: options.identityFacts, compatibilityEvidence: options.compatibilityEvidence, onDiagnostic: options.onDiagnostic, onReview: options.onReview, publicMapping: options.publicMapping === true, evidenceToken: options.evidenceToken, signal: controller.signal });
      });
      var deadline = new Promise(function (_, reject) {
        timeout = setTimeout(function () { controller.abort(); reject(new Error('翻译超时，原文已保留，请重试')); }, 30000);
      });
      return Promise.race([request, deadline]).then(function (text) {
        if (options.alive && !options.alive()) throw new Error('字段或类目已变化，请重新翻译');
        if (typeof text !== 'string' || !text.trim()) throw new Error('翻译没有返回内容，已保留原文');
        return text.trim();
      }).finally(function () { clearTimeout(timeout); });
    }
    function setRequest(request) { settings.request = typeof request === 'function' ? request : null; }
    return { translate: translate, source: source, isConfigured: isConfigured, setRequest: setRequest, unavailableMessage: unavailableMessage };
  }
  return { create: create, source: source };
});
