(function () {
  var el = document.querySelector('#headerBeanBtn .header-bean-value');
  if (!el) return;
  function refresh() {
    var storage = window.erpStorage;
    // The selected tenant is authoritative only for a system administrator.
    // Normal accounts must not send tenantId and bypass their own scope.
    fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('登录状态验证失败，请重新登录后查看余额。'); return response.json(); })
      .then(function (account) {
        var selected = account && account.isSystemAdmin && storage && typeof storage.getSelectedTenantId === 'function'
          ? String(storage.getSelectedTenantId() || '') : '';
        var url = '/api/domain/ai-beans/balance' + (selected ? '?tenantId=' + encodeURIComponent(selected) : '');
        return fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      })
      .then(function (response) { if (!response.ok) throw new Error('AI豆余额读取失败，请稍后重试。'); return response.json(); })
      .then(function (data) {
        el.textContent = data && Number.isFinite(data.balanceBean) ? data.balanceBean.toLocaleString() : '—';
      })
      .catch(function () { el.textContent = '—'; });
  }
  refresh();
})();
