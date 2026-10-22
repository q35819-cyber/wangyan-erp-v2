/* 网研ERP · 天眼 inject (MAIN world，在页面上下文运行)
 *  inject.js：监听 postMessage，补丁 Ozon Seller Vue $store 的 premium 状态
 * 注意：此文件以 world:'MAIN' 注入，能访问 #app.__vue__.$store
 */
(function() {
  'use strict';
  if (window.__wyerp_skyeye_injected_main) return;
  window.__wyerp_skyeye_injected_main = true;

  const PASSIVE_PATHS = new Set([
    '/api/site/seller-analytics/charts/table',
    '/api/site/seller-analytics/charts/graph',
    '/api/site/seller-analytics/metrics/daily',
    '/api/site/seller-analytics/what_to_sell/data/v3',
    '/api/site/seller-analytics/traffic'
  ]);

  const KNOWN_KEYS = new Set([
    'ordered_units','revenue',
    'session_view','session_view_search','session_view_pdp',
    'hits_view_search','hits_view_pdp','hits_view',
    'hits_tocart_search','hits_tocart_pdp','hits_tocart',
    'conv_tocart','conv_tocart_search','conv_tocart_pdp',
    'returns','cancellations','position_category'
  ]);

  let latestAnalyticsTableFetch = null;
  let latestAnalyticsRequestFetch = null;

  function passivePath(url) {
    try {
      const parsed = new URL(String(url || ''), location.href);
      return parsed.pathname.startsWith('/api/site/seller-analytics/') ? parsed.pathname : '';
    } catch (_) { return ''; }
  }

  function parseRequestBody(body) {
    if (typeof body !== 'string' || !body || body.length > 300000) return null;
    try {
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) { return null; }
  }

  function scalar(value) {
    return value == null || ['string', 'number', 'boolean'].includes(typeof value);
  }

  function identityFromObject(value) {
    const row = {};
    ['sku','offer_id','offerId','product_id','productId','id','name','title','product_name','productName'].forEach(key => {
      if (value && scalar(value[key]) && value[key] !== undefined) row[key] = value[key];
    });
    const dimension = Array.isArray(value && value.dimensions) ? value.dimensions[0] : null;
    if (dimension && typeof dimension === 'object') {
      if (!row.sku && scalar(dimension.id)) row.sku = dimension.id;
      if (!row.name && scalar(dimension.name)) row.name = dimension.name;
    }
    return row;
  }

  function collectCandidateShopIds(value) {
    const out = new Set();
    let visited = 0;
    function walk(item, depth) {
      if (++visited > 6000 || depth > 8 || item == null) return;
      if (Array.isArray(item)) {
        item.slice(0, 200).forEach(child => walk(child, depth + 1));
        return;
      }
      if (typeof item !== 'object') return;
      Object.keys(item).slice(0, 120).forEach(key => {
        const child = item[key];
        if (/^(?:client_?id|company_?id|seller_?id|shop_?id)$/i.test(key) && /^[1-9]\d{2,19}$/.test(String(child || ''))) {
          out.add(String(child));
        } else {
          walk(child, depth + 1);
        }
      });
    }
    walk(value, 0);
    return Array.from(out).slice(0, 8);
  }

  function scanAnalyticsJson(json, request) {
    const knownKeys = new Set();
    const knownRows = [];
    const objectSamples = [];
    const fieldPaths = new Set();
    const requestedMetrics = Array.isArray(request && request.metrics)
      ? request.metrics.map(String).filter(key => KNOWN_KEYS.has(key))
      : [];

    let visited = 0;
    function walk(value, path, depth) {
      if (++visited > 30000 || depth > 11 || value == null) return;
      if (Array.isArray(value)) {
        value.slice(0, 600).forEach((item, index) => walk(item, path + '[' + index + ']', depth + 1));
        return;
      }
      if (typeof value !== 'object') return;

      const keys = Object.keys(value);
      keys.slice(0, 150).forEach(key => {
        if (fieldPaths.size < 500) fieldPaths.add(path ? path + '.' + key : key);
      });

      const matched = keys.filter(key => KNOWN_KEYS.has(key));
      matched.forEach(key => knownKeys.add(key));

      if (matched.length && knownRows.length < 300) {
        const row = identityFromObject(value);
        matched.forEach(key => {
          if (scalar(value[key])) row[key] = value[key];
        });
        row.__path = path;
        knownRows.push(row);
      }

      if (requestedMetrics.length && Array.isArray(value.metrics) && knownRows.length < 300) {
        const row = identityFromObject(value);
        let added = false;
        requestedMetrics.forEach((key, index) => {
          if (index < value.metrics.length && scalar(value.metrics[index])) {
            row[key] = value.metrics[index];
            knownKeys.add(key);
            added = true;
          }
        });
        if (added) {
          row.__path = path;
          knownRows.push(row);
        }
      }

      if (objectSamples.length < 30 && (
        matched.length ||
        Array.isArray(value.metrics) ||
        keys.some(key => /^(?:metrics|dimensions|rows|data|items|columns|totals|result)$/i.test(key))
      )) {
        objectSamples.push({ path: path, keys: keys.slice(0, 100) });
      }

      keys.slice(0, 150).forEach(key => walk(value[key], path ? path + '.' + key : key, depth + 1));
    }

    walk(json, '$', 0);
    return {
      knownKeys: Array.from(knownKeys),
      knownRows: knownRows,
      objectSamples: objectSamples,
      fieldPaths: Array.from(fieldPaths).slice(0, 500),
      requestedMetrics: requestedMetrics
    };
  }

  function emitPassive(url, status, requestBody, text) {
    const path = passivePath(url);
    if (!path || status < 200 || status >= 300 || typeof text !== 'string' || !text || text.length > 2500000) return;
    let json;
    try { json = JSON.parse(text); } catch (_) { return; }
    if (!json || typeof json !== 'object') return;

    const request = parseRequestBody(requestBody);
    const scan = scanAnalyticsJson(json, request);
    window.postMessage({
      type: 'wyerp-tianyan-passive-capture',
      payload: {
        schemaVersion: 2,
        path: path,
        status: status,
        timestamp: new Date().toISOString(),
        responseSize: text.length,
        topKeys: Object.keys(json).slice(0, 80),
        request: request,
        candidateShopIds: collectCandidateShopIds({ request: request, response: json }),
        knownKeys: scan.knownKeys,
        knownRows: scan.knownRows,
        requestedMetrics: scan.requestedMetrics,
        objectSamples: scan.objectSamples,
        fieldPaths: scan.fieldPaths,
        responseSample: text.slice(0, 180000)
      }
    }, '*');
  }

  function installPassiveCapture() {
    const mark = '__wyerp_tianyan_passive_capture_v2';

    if (window.fetch && !window.fetch[mark]) {
      const originalFetch = window.fetch.bind(window);
      const wrappedFetch = function(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const path = passivePath(url);
        const requestBody = init && typeof init.body === 'string' ? init.body : '';
        if ((path === '/api/site/seller-analytics/charts/table' || path === '/api/site/seller-analytics/charts/graph') && requestBody) {
          try {
            const templateInit = Object.assign({}, init || {});
            if (init && init.headers) templateInit.headers = new Headers(init.headers);
            if (Object.prototype.hasOwnProperty.call(templateInit, 'signal')) delete templateInit.signal;
            latestAnalyticsRequestFetch = { init: templateInit };
            if (path === '/api/site/seller-analytics/charts/table') {
              latestAnalyticsTableFetch = { url: url || '/api/site/seller-analytics/charts/table', init: templateInit };
            }
          } catch (_) {}
        }
        const result = originalFetch(input, init);
        if (path && result && typeof result.then === 'function') {
          result.then(response => {
            try {
              if (!response || !response.ok) return;
              response.clone().text()
                .then(text => emitPassive(url, response.status, requestBody, text))
                .catch(() => {});
            } catch (_) {}
          }).catch(() => {});
        }
        return result;
      };
      wrappedFetch[mark] = true;
      window.fetch = wrappedFetch;
    }

    if (window.XMLHttpRequest && !XMLHttpRequest.prototype[mark]) {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSend = XMLHttpRequest.prototype.send;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

      XMLHttpRequest.prototype.open = function(method, url) {
        this.__wyerp_passive_url = url;
        this.__wyerp_passive_method = method;
        this.__wyerp_passive_headers = Object.create(null);
        return originalOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        try {
          var key = String(name || '');
          var next = String(value == null ? '' : value);
          if (key) {
            var previous = this.__wyerp_passive_headers && this.__wyerp_passive_headers[key];
            if (!this.__wyerp_passive_headers) this.__wyerp_passive_headers = Object.create(null);
            this.__wyerp_passive_headers[key] = previous ? (previous + ', ' + next) : next;
          }
        } catch (_) {}
        return originalSetRequestHeader.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function(body) {
        const requestBody = typeof body === 'string' ? body : '';
        const url = this.__wyerp_passive_url || '';
        const path = passivePath(url);
        if ((path === '/api/site/seller-analytics/charts/table' || path === '/api/site/seller-analytics/charts/graph') && requestBody) {
          try {
            const headers = new Headers();
            const captured = this.__wyerp_passive_headers || {};
            Object.keys(captured).forEach(function(name) { headers.set(name, captured[name]); });
            const templateInit = { method: this.__wyerp_passive_method || 'POST', headers: headers, credentials: 'include' };
            latestAnalyticsRequestFetch = { init: templateInit };
            if (path === '/api/site/seller-analytics/charts/table') {
              latestAnalyticsTableFetch = { url: url || '/api/site/seller-analytics/charts/table', init: templateInit };
            }
          } catch (_) {}
        }
        if (path) {
          this.addEventListener('loadend', function() {
            try {
              if (this.status < 200 || this.status >= 300) return;
              let text = '';
              if (!this.responseType || this.responseType === 'text') text = String(this.responseText || '');
              else if (this.responseType === 'json' && this.response && typeof this.response === 'object') text = JSON.stringify(this.response);
              if (text) emitPassive(url, this.status, requestBody, text);
            } catch (_) {}
          }, { once: true });
        }
        return originalSend.apply(this, arguments);
      };

      XMLHttpRequest.prototype[mark] = true;
    }
  }

  installPassiveCapture();

  function respond(requestId, success, payload) {
    window.postMessage(Object.assign({ type: 'wyerp-skyeye-page', requestId: requestId, success: success }, payload || {}), '*');
  }

  function tryPatch(requestId, attempt) {
    var app = document.querySelector('#app');
    var store = app && app.__vue__ && app.__vue__.$store;
    if (!store) {
      if (attempt < 15) {
        setTimeout(function() { tryPatch(requestId, attempt + 1); }, 500);
      } else {
        respond(requestId, false, { error: '未找到 Ozon $store（重试 15 次超时）' });
      }
      return;
    }
    var p = store.state && store.state.analytics && store.state.analytics.premium;
    if (!p) {
      // premium 对象可能还没初始化，也重试
      if (attempt < 15) {
        setTimeout(function() { tryPatch(requestId, attempt + 1); }, 500);
      } else {
        respond(requestId, false, { error: '未找到 store.state.analytics.premium（重试 15 次超时）' });
      }
      return;
    }
    if (p.isPremiumSeller) {
      respond(requestId, true, { skipped: true });
      return;
    }
    try {
      // 补丁：假装是 Premium 卖家，只到明天过期（临时开一下）
      p.isPremiumSeller = true;
      p.isPremiumLiteSeller = true;
      p.subscription = 'PREMIUM';
      var tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      p.periodEnd = tomorrow.toISOString();
      console.log('[网研ERP 天眼] 补丁成功', p);
      respond(requestId, true);
    } catch (err) {
      respond(requestId, false, { error: err && err.message ? err.message : String(err) });
    }
  }

  function rangeMetricGroups() {
    return [
      ['ordered_units','revenue','session_view','session_view_pdp','conv_tocart_pdp','cancellations','returns','position_category'],
      ['session_view_search','hits_view_search','hits_view_pdp','hits_view','hits_tocart_search','hits_tocart_pdp','hits_tocart','conv_tocart'],
      ['conv_tocart_search']
    ];
  }

  function validRangeDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
  }

  function rangeDayCount(dateFrom, dateTo) {
    var start = Date.parse(String(dateFrom || '') + 'T00:00:00Z');
    var end = Date.parse(String(dateTo || '') + 'T00:00:00Z');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return Math.floor((end - start) / 86400000) + 1;
  }

  function addRangeDays(dateText, delta) {
    var date = new Date(String(dateText || '') + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime())) return '';
    date.setUTCDate(date.getUTCDate() + Number(delta || 0));
    return date.toISOString().slice(0, 10);
  }

  function cloneAnalyticsRequestInit(template, body) {
    var requestInit = Object.assign({}, template && template.init || {});
    requestInit.method = 'POST';
    requestInit.credentials = 'include';
    requestInit.body = JSON.stringify(body);
    try {
      requestInit.headers = new Headers(template && template.init && template.init.headers || {});
      if (!requestInit.headers.has('Accept')) requestInit.headers.set('Accept', 'application/json');
      if (!requestInit.headers.has('Content-Type')) requestInit.headers.set('Content-Type', 'application/json');
    } catch (_) {
      requestInit.headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    }
    return requestInit;
  }

  async function fetchAnalyticsTimeline(requestTemplate, dateFrom, dateTo) {
    var days = rangeDayCount(dateFrom, dateTo);
    var granularity = days === 1 ? 'hour' : 'day';
    var metrics = ['ordered_units','revenue','session_view','session_view_pdp','hits_view','hits_tocart','cancellations','returns'];
    var slices = [];
    if (granularity === 'hour') {
      for (var hour = 0; hour < 24; hour += 1) {
        var hh = String(hour).padStart(2, '0');
        slices.push({
          key: dateFrom + 'T' + hh,
          label: hh + ':00',
          from: dateFrom + ' ' + hh + ':00:00',
          to: dateFrom + ' ' + hh + ':59:59'
        });
      }
    } else {
      for (var dayIndex = 0; dayIndex < days; dayIndex += 1) {
        var day = addRangeDays(dateFrom, dayIndex);
        slices.push({
          key: day,
          label: day.slice(5),
          from: day + ' 00:00:00',
          to: day + ' 23:59:59'
        });
      }
    }

    async function fetchSlice(slice) {
      try {
        var body = {
          date_from: slice.from,
          date_to: slice.to,
          filters: [],
          group_by: 'SKU',
          limit: '1',
          metrics: metrics,
          offset: '0',
          sort: [{ key: 'ordered_units', order: 'DESC' }],
          use_realization_price: true
        };
        var response = await fetch('/api/site/seller-analytics/charts/table', cloneAnalyticsRequestInit(requestTemplate, body));
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var json = await response.json();
        var totals = Array.isArray(json && json.result && json.result.totals) ? json.result.totals : [];
        var values = {};
        metrics.forEach(function(metric, index) {
          values[metric] = index < totals.length ? totals[index] : null;
        });
        return { key: slice.key, label: slice.label, values: values };
      } catch (error) {
        return { key: slice.key, label: slice.label, values: {}, error: String(error && error.message || error).slice(0, 120) };
      }
    }

    var points = new Array(slices.length);
    var cursor = 0;
    async function worker() {
      while (true) {
        var index = cursor++;
        if (index >= slices.length) return;
        points[index] = await fetchSlice(slices[index]);
        if (index + 1 < slices.length) await new Promise(function(resolve) { setTimeout(resolve, 90); });
      }
    }
    var workers = [];
    var workerCount = Math.min(4, slices.length);
    for (var wi = 0; wi < workerCount; wi += 1) workers.push(worker());
    await Promise.all(workers);
    return {
      granularity: granularity,
      points: points,
      failedPoints: points.filter(function(point) { return point && point.error; }).length
    };
  }

  async function fetchRangeAnalytics(requestId, dateFrom, dateTo, messageType, datePreset) {
    var metricGroups = rangeMetricGroups();
    var allMetrics = metricGroups.reduce(function(out, group) { return out.concat(group); }, []);
    try {
      dateFrom = String(dateFrom || '').slice(0, 10);
      dateTo = String(dateTo || '').slice(0, 10);
      var days = rangeDayCount(dateFrom, dateTo);
      if (!validRangeDate(dateFrom) || !validRangeDate(dateTo) || days < 1 || days > 90) {
        throw new Error('天眼日期范围无效，只支持1至90天');
      }

      var limit = 30;
      var expectedTotal = null;
      var maxPageCount = 0;
      var merged = new Map();
      var rowOrder = [];
      var summaryValues = {};
      var requestTemplateForIdentity = latestAnalyticsTableFetch || latestAnalyticsRequestFetch || null;
      if (!requestTemplateForIdentity) throw new Error('尚未捕获 Ozon 分析页真实请求模板，请刷新“我的分析”页面后重试');

      var resolvedShopId = 'unknown';
      try {
        var identityHeaders = new Headers(requestTemplateForIdentity && requestTemplateForIdentity.init && requestTemplateForIdentity.init.headers || {});
        identityHeaders.forEach(function(value, name) {
          if (resolvedShopId !== 'unknown') return;
          var key = String(name || '').toLowerCase();
          var candidate = String(value || '').trim();
          if (/(?:company|seller|client)[-_]?id/.test(key) && /^[1-9]\d{2,19}$/.test(candidate)) resolvedShopId = candidate;
        });
      } catch (_) {}

      async function fetchGroup(metrics, groupIndex) {
        var offset = 0;
        var totalCount = null;
        var pages = 0;
        var rows = [];
        var totals = null;
        while (pages < 40 && (totalCount === null || offset < totalCount)) {
          var body = {
            date_from: dateFrom + ' 00:00:00',
            date_to: dateTo + ' 23:59:59',
            filters: [],
            group_by: 'SKU',
            limit: String(limit),
            metrics: metrics,
            offset: String(offset),
            sort: [{ key: 'ordered_units', order: 'DESC' }],
            use_realization_price: true
          };
          var response = await fetch('/api/site/seller-analytics/charts/table', cloneAnalyticsRequestInit(requestTemplateForIdentity, body));
          if (!response.ok) throw new Error('天眼第' + (groupIndex + 1) + '组接口返回 HTTP ' + response.status);
          var json = await response.json();
          var result = json && json.result || {};
          var data = Array.isArray(result.data) ? result.data : [];
          if (totals === null && Array.isArray(result.totals)) totals = result.totals.slice();
          var reportedTotal = Number(result.totalCount);
          if (Number.isFinite(reportedTotal) && reportedTotal >= 0) totalCount = reportedTotal;
          data.forEach(function(item) {
            var dimension = Array.isArray(item && item.dimensions) ? (item.dimensions[0] || {}) : {};
            var metricValues = Array.isArray(item && item.metrics) ? item.metrics : [];
            var values = {};
            metrics.forEach(function(metric, index) { values[metric] = index < metricValues.length ? metricValues[index] : null; });
            rows.push({
              sku: String(dimension.sellerId || ''),
              product: String(dimension.name || ''),
              productId: String(dimension.id || ''),
              values: values
            });
          });
          pages += 1;
          if (!data.length) break;
          offset += data.length;
          if (data.length < limit && (totalCount === null || offset >= totalCount)) break;
          if (offset < totalCount) await new Promise(function(resolve) { setTimeout(resolve, 160); });
        }
        return { rows: rows, totalCount: totalCount === null ? rows.length : totalCount, pageCount: pages, totals: totals || [] };
      }

      for (var groupIndex = 0; groupIndex < metricGroups.length; groupIndex += 1) {
        var groupMetrics = metricGroups[groupIndex];
        var result = await fetchGroup(groupMetrics, groupIndex);
        if (expectedTotal === null) expectedTotal = result.totalCount;
        else if (Number(result.totalCount) !== Number(expectedTotal)) throw new Error('天眼各指标组商品总数不一致');
        if (result.rows.length < result.totalCount) throw new Error('天眼第' + (groupIndex + 1) + '组数据不完整');
        maxPageCount = Math.max(maxPageCount, result.pageCount);
        groupMetrics.forEach(function(metric, index) {
          if (index < result.totals.length) summaryValues[metric] = result.totals[index];
        });
        result.rows.forEach(function(row) {
          var key = row.sku || ('product:' + row.productId);
          if (!key) return;
          var current = merged.get(key);
          if (!current) {
            current = { sku: row.sku, product: row.product, productId: row.productId, values: {}, raw: [] };
            merged.set(key, current);
            if (groupIndex === 0) rowOrder.push(key);
          }
          if (!current.product && row.product) current.product = row.product;
          if (!current.productId && row.productId) current.productId = row.productId;
          Object.assign(current.values, row.values);
        });
        if (groupIndex < metricGroups.length - 1) await new Promise(function(resolve) { setTimeout(resolve, 300); });
      }

      var rows = rowOrder.map(function(key) { return merged.get(key); }).filter(Boolean);
      if (rows.length !== expectedTotal) throw new Error('天眼合并后商品数不完整：' + rows.length + '/' + expectedTotal);
      rows.forEach(function(row) {
        row.raw = allMetrics.map(function(metric) {
          return Object.prototype.hasOwnProperty.call(row.values, metric) ? row.values[metric] : null;
        });
      });

      var timeline = await fetchAnalyticsTimeline(requestTemplateForIdentity, dateFrom, dateTo);
      window.postMessage({
        type: messageType || 'wyerp-skyeye-range-data',
        requestId: requestId,
        success: true,
        payload: {
          schemaVersion: 1,
          datePreset: String(datePreset || 'range'),
          dateFrom: dateFrom,
          dateTo: dateTo,
          shopId: resolvedShopId,
          sourceUrl: location.href,
          capturedAt: new Date().toISOString(),
          headers: allMetrics,
          rows: rows,
          summary: summaryValues,
          timeline: timeline,
          totalCount: expectedTotal === null ? rows.length : expectedTotal,
          pageCount: maxPageCount
        }
      }, '*');
    } catch (error) {
      window.postMessage({
        type: messageType || 'wyerp-skyeye-range-data',
        requestId: requestId,
        success: false,
        error: error && error.message ? error.message : String(error)
      }, '*');
    }
  }

  async function fetchYesterdayAnalytics(requestId) {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date());
    var map = {};
    parts.forEach(function(item) { map[item.type] = item.value; });
    var calendar = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)));
    calendar.setUTCDate(calendar.getUTCDate() - 1);
    var yesterday = calendar.toISOString().slice(0, 10);
    return fetchRangeAnalytics(requestId, yesterday, yesterday, 'wyerp-skyeye-yesterday-data', 'yesterday');
  }
  window.addEventListener('message', function(ev) {
    var data = ev.data;
    if (!data || data.type !== 'wyerp-skyeye-chore' || !data.detail) return;
    var detail = data.detail;
    if (detail.type === 'WyerpApplySkyEyePremium') {
      var requestId = detail.requestId;
      console.log('[网研ERP 天眼] 收到补丁请求', requestId);
      tryPatch(requestId, 0);
      return;
    }
    if (detail.type === 'WyerpFetchYesterdayAnalytics') {
      fetchYesterdayAnalytics(detail.requestId);
      return;
    }
    if (detail.type === 'WyerpFetchRangeAnalytics') {
      fetchRangeAnalytics(detail.requestId, detail.dateFrom, detail.dateTo, 'wyerp-skyeye-range-data', 'range');
      return;
    }
  });

  console.log('[网研ERP 天眼] inject.js 已就绪');
})();
