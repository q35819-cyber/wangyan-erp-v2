(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_LOGISTICS_QUOTE_FORM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function text(error) {
    if (!error) return '';
    if (error === 'missing_package_data') return '请先填写完整的商品重量和包装长宽高。';
    if (error === 'no_logistics_match') return '当前重量/尺寸没有匹配到可用物流规则，请检查物流方案或包装数据。';
    return '国际运费匹配失败，请检查物流配置。';
  }
  function init(options) {
    options = options || {};
    var doc = options.document || document;
    var quoteModel = options.quoteModel || (typeof window !== 'undefined' ? window.WYERP_LOGISTICS_QUOTE : null);
    var request = options.request || function (url) {
      if (typeof window !== 'undefined' && window.erpStorage && window.erpStorage.request) return window.erpStorage.request(url);
      return fetch(url);
    };
    var ids = options.ids || {};
    var defaultIds = { weight:'weight', length:'length', width:'width', height:'height', shipping:'shipping', override:'override', status:'status' };
    var el = {};
    ['weight','length','width','height','shipping','override','status'].forEach(function (key) { el[key] = doc.getElementById(ids[key] || defaultIds[key]); });
    if (!quoteModel || !el.shipping || !el.status) throw new Error('物流报价表单组件缺少必要模块或控件');
    var config = null, loading = null, timer = null, lastResult = null;
    function packageValues() {
      return {
        weightG: el.weight && el.weight.value,
        lengthMm: el.length && el.length.value,
        widthMm: el.width && el.width.value,
        heightMm: el.height && el.height.value,
        market: typeof options.market === 'function' ? options.market() : options.market || '俄罗斯',
        scheme: typeof options.scheme === 'function' ? options.scheme() : options.scheme || (config && config.defaultScheme) || ''
      };
    }
    function setStatus(message, kind, title) {
      el.status.textContent = message;
      el.status.dataset.state = kind || '';
      el.status.title = title || message;
    }
    function manual() { return Boolean(el.override && el.override.checked); }
    function syncInputMode() {
      el.shipping.readOnly = !manual();
      el.shipping.dataset.freightMode = manual() ? 'manual' : 'auto';
      if (manual()) setStatus('已启用手动覆盖国际运费；自动报价不会改写当前金额。', 'manual');
    }
    function load() {
      if (config) return Promise.resolve(config);
      if (loading) return loading;
      setStatus('正在读取当前物流方案…', 'loading');
      loading = Promise.resolve(request('/api/logistics-configs')).then(function (response) {
        if (!response || !response.ok) throw new Error('物流配置读取失败，请稍后重试。');
        return response.json();
      }).then(function (payload) {
        config = payload || {};
        loading = null;
        return config;
      }).catch(function (error) {
        loading = null;
        setStatus('物流配置读取失败，请刷新后重试。', 'error');
        throw error;
      });
      return loading;
    }
    function applyResult(result) {
      lastResult = result;
      if (!result || !result.ok) {
        if (!manual()) el.shipping.value = '';
        setStatus(text(result && result.error), 'error');
        if (typeof options.onQuote === 'function') options.onQuote(result);
        return result;
      }
      var recommended = result.recommended;
      if (!manual()) el.shipping.value = Number(recommended.freightCny).toFixed(2);
      var summary = '自动匹配：' + quoteModel.describe(recommended);
      var candidates = (result.candidates || []).map(function (item, index) { return (index + 1) + '. ' + quoteModel.describe(item); }).join('\n');
      setStatus(summary + (result.candidates.length > 1 ? '（共 ' + result.candidates.length + ' 个可用渠道，已取最低合法运费）' : ''), 'ok', candidates || summary);
      if (typeof options.onQuote === 'function') options.onQuote(result);
      return result;
    }
    function refresh() {
      syncInputMode();
      if (manual()) {
        lastResult = { ok: true, manual: true, freightCny: Number(el.shipping.value || 0) };
        if (typeof options.onQuote === 'function') options.onQuote(lastResult);
        return Promise.resolve(lastResult);
      }
      var values = packageValues();
      var missing = quoteModel.packageInput(values);
      if (missing.error) {
        lastResult = missing;
        if (!manual()) el.shipping.value = '';
        setStatus(text(missing.error), 'waiting');
        if (typeof options.onQuote === 'function') options.onQuote(missing);
        return Promise.resolve(missing);
      }
      return load().then(function (payload) {
        values.scheme = values.scheme || payload.defaultScheme || '';
        return applyResult(quoteModel.quote(payload, values));
      }).catch(function () { return null; });
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(refresh, Number(options.delayMs) >= 0 ? Number(options.delayMs) : 180);
    }
    [el.weight,el.length,el.width,el.height].filter(Boolean).forEach(function (input) {
      input.addEventListener('input', schedule);
      input.addEventListener('change', schedule);
    });
    if (el.override) el.override.addEventListener('change', function () { syncInputMode(); if (!manual()) refresh(); });
    syncInputMode();
    if (options.loadImmediately !== false) load().then(function () { refresh(); }).catch(function () {});
    return { refresh: refresh, load: load, getResult: function () { return lastResult; }, isManual: manual };
  }
  return { init: init, errorText: text };
});
