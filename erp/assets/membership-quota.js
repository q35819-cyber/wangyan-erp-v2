/* 网研ERP — 会员数量额度统一展示（任务中心同款进度条） */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_MEMBERSHIP_QUOTA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var ORDER = ['shops', 'dailySku', 'collectionBox', 'favorites', 'childAccounts'];

  function numberValue(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function normalize(value, fallbackKey) {
    value = value && typeof value === 'object' ? value : {};
    var unlimited = value.unlimited === true || value.limit === null;
    var usage = numberValue(value.usage);
    var limit = unlimited ? null : numberValue(value.limit);
    return {
      key: String(value.key || fallbackKey || ''),
      label: String(value.label || ''),
      unit: String(value.unit || '个'),
      usage: usage,
      limit: limit,
      unlimited: unlimited,
      remaining: unlimited ? null : Math.max(0, limit - usage),
      overLimit: !unlimited && usage > limit
    };
  }

  function percent(value) {
    var item = normalize(value);
    if (item.unlimited || item.limit <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round(item.usage / item.limit * 100)));
  }

  function quotaText(value) {
    var item = normalize(value);
    return item.usage + ' / ' + (item.unlimited ? '不限' : item.limit);
  }

  function metaText(value) {
    var item = normalize(value);
    if (item.unlimited) return '已用 ' + item.usage + item.unit + ' · 当前会员不限额度';
    if (item.overLimit) return '已用 ' + item.usage + item.unit + ' · 历史数据超出当前额度 ' + (item.usage - item.limit) + item.unit;
    return '剩余 ' + item.remaining + item.unit;
  }

  function create(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function render(host, value, options) {
    if (!host) return null;
    options = options || {};
    var item = normalize(value, options.key);
    host.classList.add('membership-quota-card');
    if (options.compact) host.classList.add('membership-quota-compact');
    host.classList.toggle('is-unlimited', item.unlimited);
    host.classList.toggle('is-over-limit', item.overLimit);
    host.replaceChildren();

    var head = create('div', 'membership-quota-head');
    head.appendChild(create('span', 'membership-quota-label', options.label || item.label || '会员额度'));
    head.appendChild(create('strong', 'membership-quota-value', quotaText(item)));
    host.appendChild(head);

    var progress = create('progress', 'erp-progress');
    progress.max = 100;
    progress.value = percent(item);
    progress.setAttribute('aria-label', (options.label || item.label || '会员额度') + '使用进度');
    host.appendChild(progress);

    var meta = create('div', 'membership-quota-meta');
    meta.appendChild(create('span', '', metaText(item)));
    if (options.note) meta.appendChild(create('span', 'membership-quota-note', options.note));
    host.appendChild(meta);
    return item;
  }

  function renderFromPayload(host, payload, key, options) {
    var quotas = payload && payload.quotas || {};
    return render(host, quotas[key], Object.assign({ key: key }, options || {}));
  }

  function renderGroup(host, payload, keys) {
    if (!host) return;
    host.replaceChildren();
    (keys && keys.length ? keys : ORDER).forEach(function (key) {
      var slot = document.createElement('div');
      slot.dataset.membershipQuota = key;
      host.appendChild(slot);
      renderFromPayload(slot, payload, key);
    });
  }

  function currentUrl() {
    var tenantId = root && root.erpStorage && typeof root.erpStorage.getSelectedTenantId === 'function'
      ? String(root.erpStorage.getSelectedTenantId() || '') : '';
    return '/api/membership/current' + (tenantId ? '?tenantId=' + encodeURIComponent(tenantId) : '');
  }

  function load() {
    var requester = root && root.erpStorage && typeof root.erpStorage.request === 'function'
      ? root.erpStorage.request.bind(root.erpStorage)
      : function (url) { return fetch(url, { credentials: 'same-origin' }); };
    return requester(currentUrl()).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error(payload.message || '会员额度读取失败，请稍后重试。');
        return payload;
      });
    });
  }

  return {
    ORDER: ORDER,
    normalize: normalize,
    percent: percent,
    quotaText: quotaText,
    metaText: metaText,
    render: render,
    renderFromPayload: renderFromPayload,
    renderGroup: renderGroup,
    currentUrl: currentUrl,
    load: load
  };
});
