/* 网研ERP — 统一侧边栏：菜单数据 + 渲染 + 折叠 + 主题切换 */
(function () {
  // ── 恢复上次主题偏好 ──
  try {
    var savedTheme = localStorage.getItem('erp_theme');
    if (savedTheme === 'dark') {
      document.documentElement.classList.add('theme-dark');
      document.body.classList.add('theme-dark');
    }
  } catch (e) {}
  // 品牌配置
  var brand = window.WYERP_BRAND || { name: '网研ERP', platform: 'OZON版' };
  var brandDisplay = brand.name + ' \u00b7 ' + brand.platform;
  var serverNotices = [];
  var userNotifications = [];
  var unreadNotificationCount = 0;
  var identityDisplayPromise = null;
  function ensureIdentityDisplay() {
    if (window.WYERP_IDENTITY_DISPLAY) return Promise.resolve(window.WYERP_IDENTITY_DISPLAY);
    if (identityDisplayPromise) return identityDisplayPromise;
    identityDisplayPromise = new Promise(function (resolve) {
      var script = document.createElement('script');
      script.src = '/assets/identity-display.js?v=20261006-id01';
      script.dataset.wyerpIdentityDisplay = '1';
      script.onload = function () { resolve(window.WYERP_IDENTITY_DISPLAY || null); };
      script.onerror = function () { resolve(null); };
      document.head.appendChild(script);
    });
    return identityDisplayPromise;
  }
  function displayedIdentity(source) {
    var api = window.WYERP_IDENTITY_DISPLAY;
    if (api && typeof api.displayIdentity === 'function') return api.displayIdentity(source || {});
    return { kind: 'unknown', raw: '', masked: '当前账号' };
  }
  function renderHeaderIdentity(source) {
    var headerRight = document.querySelector('.header-right');
    if (!headerRight) return;
    var node = headerRight.querySelector('.user-name');
    if (!node) return;
    var identity = displayedIdentity(source || {});
    node.textContent = identity.masked || '当前账号';
    node.title = identity.raw || '当前登录账号';
  }
  function listDateTimeParts(value) {
    var raw = String(value || '').trim();
    if (!raw || raw === '--' || raw === '仍在线' || raw === '登录时未记录') return null;
    var direct = raw.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[ T\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (direct) return { date: direct[1] + '-' + String(direct[2]).padStart(2, '0') + '-' + String(direct[3]).padStart(2, '0'), time: String(direct[4]).padStart(2, '0') + ':' + direct[5] + ':' + (direct[6] || '00') };
    var zh = raw.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (zh) return { date: zh[1] + '-' + String(zh[2]).padStart(2, '0') + '-' + String(zh[3]).padStart(2, '0'), time: String(zh[4]).padStart(2, '0') + ':' + zh[5] + ':' + (zh[6] || '00') };
    if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) return null;
    var parsed = new Date(raw);
    if (!Number.isFinite(parsed.getTime())) return null;
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return { date: parsed.getFullYear() + '-' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate()), time: pad(parsed.getHours()) + ':' + pad(parsed.getMinutes()) + ':' + pad(parsed.getSeconds()) };
  }
  function formatListTableTimes(root) {
    var scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('table').forEach(function (table) {
      var headers = Array.prototype.slice.call(table.querySelectorAll('thead th'));
      var indexes = headers.map(function (th, index) { return /时间|日期/.test(String(th.textContent || '')) ? index : -1; }).filter(function (index) { return index >= 0; });
      if (!indexes.length) return;
      table.querySelectorAll('tbody tr').forEach(function (row) {
        indexes.forEach(function (index) {
          var cell = row.cells && row.cells[index];
          if (!cell || cell.dataset.wyDateTimeFormatted === '1' || cell.childElementCount) return;
          var parts = listDateTimeParts(cell.textContent);
          if (!parts) return;
          var date = document.createElement('span'), time = document.createElement('span');
          date.className = 'wy-list-date'; date.textContent = parts.date;
          time.className = 'wy-list-time'; time.textContent = parts.time;
          cell.textContent = ''; cell.classList.add('wy-list-datetime'); cell.append(date, time); cell.dataset.wyDateTimeFormatted = '1';
        });
      });
    });
  }
  var listTimeFormatScheduled = false;
  function scheduleListTimeFormatting() {
    if (listTimeFormatScheduled) return;
    listTimeFormatScheduled = true;
    window.requestAnimationFrame(function () { listTimeFormatScheduled = false; formatListTableTimes(document); });
  }
  function startListTimeFormatting() {
    scheduleListTimeFormatting();
    if ('MutationObserver' in window && document.body) new MutationObserver(scheduleListTimeFormatting).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) startListTimeFormatting(); else document.addEventListener('DOMContentLoaded', startListTimeFormatting, { once: true });
  function loadServerNotices() {
    fetch('/api/notices').then(function (r) { return r.json(); }).then(function (arr) {
      if (Array.isArray(arr)) { serverNotices = arr; refreshNotifPanel(); }
    }).catch(function () {});
  }
  function loadUserNotifications() {
    if (!window.erpStorage || typeof window.erpStorage.request !== 'function') return Promise.resolve();
    return window.erpStorage.request('/api/notifications?limit=20').then(function (response) {
      if (!response.ok) throw new Error('通知列表读取失败，请稍后刷新页面重试。');
      return response.json();
    }).then(function (result) {
      userNotifications = Array.isArray(result.items) ? result.items : [];
      unreadNotificationCount = Math.max(0, Number(result.unreadCount) || 0);
      refreshNotifPanel();
    }).catch(function () {});
  }
  function refreshNotifPanel() {
    var wrap = document.querySelector('.notif-wrap');
    if (wrap) renderNotifications(wrap, wrap.querySelector('.bell-badge'));
  }
  var logoEl = document.querySelector('.logo');
  if (logoEl) {
    logoEl.innerHTML = brand.name.replace(/ERP$/, '') + '<span>ERP \u00b7 ' + brand.platform + '</span>';
  }
  if (document.title) {
    document.title = document.title.split(' - ')[0] + ' - ' + brandDisplay;
  }
  var MENU = [
    { label: '概览', href: 'index.html', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>' },
    { label: '任务中心', href: 'pages/task-center.html', icon: '<svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>' },
    { group: '商品', icon: '<svg viewBox="0 0 24 24"><path d="M21 8 12 3 3 8l9 5 9-5Z"/><path d="M3 8v8l9 5 9-5V8"/></svg>', items: [
      { label: '在线商品', href: 'pages/goods-online.html', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-5"/></svg>' },
      { label: '采集箱', href: 'pages/goods.html', icon: '<svg viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>' },
      { label: '上架记录', href: 'pages/goods-onlist.html', icon: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/></svg>' },
      { label: '下架重上', href: 'pages/goods-relist.html', icon: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>' },
      { label: '收藏夹', href: 'pages/goods-favorites.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>' }
    ]},
    { group: '选品', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="m16.24 7.76-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z"/></svg>', items: [
      { label: '大盘总览', href: 'pages/analytics.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/></svg>' },
      { label: '类目分析', href: 'pages/category.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="m12 2 10 6-10 6L2 8l10-6Z"/><path d="m2 12 10 6 10-6"/><path d="m2 17 10 6 10-6"/></svg>' },
      { label: '榜单选品', href: 'pages/ranking.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15v-6M12 15V7M17 15v-3"/></svg>' },
      { label: '标签查询', href: 'pages/tag-search.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M20.59 13.41 11 4H4v7l9.41 9.41a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.83Z"/><circle cx="7" cy="7" r="1"/></svg>' }
    ]},
    { group: '促销', icon: '<svg viewBox="0 0 24 24"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>', items: [
      { label: 'OZON促销活动', href: 'pages/promo-ozon.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>' },
      { label: '自动删促销', href: 'pages/promo-auto.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' }
    ]},
    { group: '订单', icon: '<svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 12h6M9 16h6"/></svg>', items: [
      { label: '我的订单', href: 'pages/orders.html', icon: '<svg viewBox="0 0 24 24"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>' },
      { label: '订单统计', href: 'pages/order-statistics.html', icon: '<svg viewBox="0 0 24 24"><path d="M4 19V9M10 19V5M16 19v-7M22 19V3"/><path d="M2 21h20"/></svg>' },
      { label: '买家黑名单', href: 'pages/blacklist.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5M22 8l-5 5"/></svg>' },
      { label: '数据大屏', href: 'pages/dashboard.html', external: true, icon: '<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>' }
    ]},
    { group: '消息', icon: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>', items: [
      { label: '消息模板', href: 'pages/msg-templates.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8"/></svg>' },
      { label: '发送记录', href: 'pages/msg-sendlog.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M22 2 14 22"/><path d="m14 2-7 7 7 7"/></svg>' }
    ]},
    { group: '店铺', icon: '<svg viewBox="0 0 24 24"><path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7z"/><path d="M14 2v5"/><path d="M9 17v-5"/></svg>', items: [
      { label: '店铺列表', href: 'pages/shops.html', icon: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>' },
      { label: '店铺分组', href: 'pages/shop-groups.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>' }
      ,{ label: '子账号管理', href: 'pages/accounts.html', permission: 'tenant.members.read,tenant.roles.read', icon: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M16 11h6"/></svg>' }
      ,{ label: '账号安全', href: 'pages/account-security.html', permission: 'authenticated', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' }
      ,{ label: '审计日志', href: 'pages/audit-log.html', permission: 'audit.read', icon: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>' }
    ]},
    { group: '充值中心', icon: '<svg viewBox="0 0 24 24"><path d="M3 6h18l-2 12H5L3 6Z"/><path d="m7 6 2 5 3-5 3 5 2-5"/><path d="M8 15h8"/></svg>', items: [
      { label: '会员中心', href: 'pages/membership.html', permission: 'authenticated', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>' },
      { label: 'AI豆管理', href: 'pages/ai-beans.html', permission: 'authenticated', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>' },
      { label: '代理商中心', href: 'pages/agent-center.html', permission: 'membership.agent', icon: '<svg viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 11 2 2 4-4"/></svg>' },
      { label: '会员系统管理', href: 'pages/membership-admin.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="M9 12h6M12 9v6"/></svg>' }
    ]},
    { label: '分析', href: 'pages/shop-analysis.html', icon: '<svg viewBox="0 0 24 24"><path d="M4 20V10M10 20V4M16 20v-8M22 20V8"/></svg>' },
    { group: '货源', icon: '<svg viewBox="0 0 24 24"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/></svg>', items: [
      { label: '1688账号授权', href: 'pages/source-auth.html', permission: 'system.admin', unavailable: '尚未实现', icon: '<svg viewBox="0 0 24 24"><path d="M20 13c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9"/></svg>' },
      { label: '1688铺货选品', href: 'pages/source-pick.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><circle cx="8" cy="8" r="6"/><path d="M21 21l-4.35-4.35"/></svg>' }
    ]},
    { group: '设置', icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.5 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.08A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.12.6.65 1.02 1.27 1.02H21a2 2 0 1 1 0 4h-.09c-.62 0-1.15.42-1.51 1z"/></svg>', items: [
      { label: 'AI配置', href: 'pages/ai-config.html', permission: 'owner', icon: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="14" rx="3"/><path d="M9 10h.01M15 10h.01M8 15h8M12 2v3"/></svg>' },
      { label: '物流配置', href: 'pages/logistics-config.html', permission: 'authenticated', icon: '<svg viewBox="0 0 24 24"><path d="M3 6h11v11H3zM14 10h4l3 3v4h-7z"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>' },
      { label: '定价设置', href: 'pages/pricing-settings.html', permission: 'authenticated', icon: '<svg viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
      { label: '接口列表', href: 'pages/api-monitor.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="7" cy="6" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="7" cy="18" r="1"/></svg>' },
      { label: '用户监控', href: 'pages/user-monitor.html', permission: 'system.admin', icon: '<svg viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>' },
    ]},
    { group: '工具', icon: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>', items: [
      { label: '定价工具', href: 'pages/pricing.html', icon: '<svg viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>' },
      { label: '利润计算器', href: 'pages/profit.html', icon: '<svg viewBox="0 0 24 24"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8M8 10h8M8 14h4"/></svg>' },
      { label: '水印管理', href: 'pages/watermark.html', icon: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>' },
      { label: '全球物流查询', href: 'https://www.17track.net/zh-cn', permission: 'tools.use', external: true, icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/><path d="m16 8 3-3m0 0v3m0-3h-3"/></svg>' },
      { label: 'BUG反馈', href: 'pages/bug-feedback.html', permission: 'authenticated', icon: '<svg viewBox="0 0 24 24"><path d="m8 2 1.5 2h5L16 2"/><rect x="5" y="4" width="14" height="16" rx="7"/><path d="M3 10h4M17 10h4M3 16h4M17 16h4M12 8v8"/></svg>' }
    ]}
  ];
  window.WYERP_MENU = MENU;

  var standaloneDashboard = location.pathname === '/pages/dashboard.html';
  var workspaceEmbedded = window.top !== window && new URLSearchParams(location.search).get('workspace') === '1';
  if (workspaceEmbedded) {
    document.body.classList.add('workspace-embedded');
    document.addEventListener('click', function (event) {
      var link = event.target.closest && event.target.closest('a[href]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || link.hasAttribute('download')) return;
      var raw = link.getAttribute('href') || '';
      if (!raw || raw.charAt(0) === '#' || /^javascript:/i.test(raw)) return;
      var target;
      try { target = new URL(link.href, location.href); } catch (error) { return; }
      if (target.origin !== location.origin || /^\/login\.html(?:$|[?#])/i.test(target.pathname)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      window.parent.postMessage({ type: 'wyerp-workspace-open', route: target.pathname + target.search + target.hash, title: (link.textContent || '').trim() }, location.origin);
    }, true);
    window.parent.postMessage({
      type: 'wyerp-workspace-ready',
      route: location.pathname + location.search + location.hash,
      title: ((document.querySelector('.header-left strong') || {}).textContent || document.title || '').trim()
    }, location.origin);
  } else if (location.pathname !== '/workspace.html' && !standaloneDashboard) {
    var standaloneRoute = location.pathname === '/' ? '/index.html' : location.pathname;
    location.replace('/workspace.html?open=' + encodeURIComponent(standaloneRoute + location.search + location.hash));
    return;
  }

  var PAGE_PERMISSION = {
    'pages/goods-online.html':'products.read','pages/product-detail.html':'products.read','pages/goods.html':'collection.read','pages/goods-onlist.html':'products.read','pages/goods-relist.html':'products.read','pages/goods-favorites.html':'selection.read',
    'pages/analytics.html':'selection.read','pages/category.html':'selection.read','pages/ranking.html':'selection.read','pages/tag-search.html':'selection.read','pages/source-pick.html':'selection.read',
    'pages/promo-ozon.html':'promotions.read','pages/promo-auto.html':'promotions.read','pages/msg-templates.html':'messages.read','pages/msg-sendlog.html':'messages.read','pages/dashboard.html':'dashboard.read','pages/shop-analysis.html':'analytics.read',
    'pages/orders.html':'orders.read','pages/order-statistics.html':'orders.read','pages/blacklist.html':'orders.read','pages/shops.html':'shops.read','pages/shop-groups.html':'shops.read',
    'pages/pricing.html':'tools.use','pages/profit.html':'tools.use','pages/watermark.html':'products.write','pages/ai-config.html':'authenticated','pages/logistics-config.html':'authenticated','pages/pricing-settings.html':'authenticated','pages/api-monitor.html':'system.admin','pages/user-monitor.html':'system.admin','pages/accounts.html':'tenant.members.read','pages/account-security.html':'authenticated','pages/audit-log.html':'audit.read',
    'pages/membership.html':'authenticated','pages/ai-beans.html':'authenticated','pages/agent-center.html':'membership.agent','pages/membership-admin.html':'system.admin'
  };

  function rootHref(href) {
    return href === 'index.html' ? '/' : '/' + String(href || '').replace(/^\/+/, '');
  }
  function menuHref(item) {
    return item && item.external ? String(item.href || '') : rootHref(item && item.href);
  }
  function menuExternalAttrs(item) {
    return item && item.external ? ' target="_blank" rel="noopener noreferrer" data-external="1"' : '';
  }

  function loadSyncProgress() {
    if (window.WYERP_SYNC_STREAM) {
      window.WYERP_SYNC_STREAM.progress.restore();
      return;
    }
    var script = document.createElement('script');
    script.src = '/assets/sync-stream.js';
    script.onload = function () { if (window.WYERP_SYNC_STREAM) window.WYERP_SYNC_STREAM.progress.restore(); };
    document.head.appendChild(script);
  }

  function keepSyncPageAlive(nav) {
    nav.addEventListener('click', function (event) {
      var link = event.target.closest('a.menu-item');
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      var progress = window.WYERP_SYNC_STREAM && window.WYERP_SYNC_STREAM.progress;
      if (!progress || !progress.isActive()) return;
      event.preventDefault();
      var opened = window.open(link.href, '_blank');
      if (!opened) {
        alert('同步仍在进行。浏览器拦截了新标签页，请允许弹出窗口后重试；直接离开会停止剩余同步。');
        return;
      }
      try { opened.focus(); } catch (error) {}
    });
  }

  // ── 渲染菜单 ──
  var sidebarEl = document.querySelector('.sidebar');
  if (sidebarEl && !workspaceEmbedded) {
    var nav = sidebarEl.querySelector('nav.menu') || document.createElement('nav');
    nav.className = 'menu';
    var html = '';
    MENU.forEach(function (item) {
      if (item.group) {
        html += '<div class="menu-group collapsed"><div class="group-title">' + item.icon + ' ' + item.group + '</div>';
        item.items.forEach(function (sub) {
          var active = window.location.pathname.includes(sub.href) ? ' active' : '';
          var permission = sub.permission || PAGE_PERMISSION[sub.href] || '';
          var unavailable = sub.unavailable ? ' menu-item-unavailable' : '';
          var note = sub.unavailable ? '<span class="menu-item-note">' + sub.unavailable + '</span>' : '';
          var disabledAttr = sub.unavailable ? ' aria-disabled="true"' : '';
          html += '<a class="menu-item sub' + active + unavailable + '"' + disabledAttr + ' data-permission="' + permission + '" href="' + menuHref(sub) + '"' + menuExternalAttrs(sub) + '>' + sub.icon + ' ' + sub.label + note + '</a>';
        });
        html += '</div>';
      } else {
        var active = window.location.pathname.includes(item.href) ? ' active' : '';
        html += '<a class="menu-item' + active + '" data-permission="' + (item.permission || (item.href === 'index.html' ? 'authenticated' : (PAGE_PERMISSION[item.href] || ''))) + '" href="' + menuHref(item) + '"' + menuExternalAttrs(item) + '>' + item.icon + ' ' + item.label + '</a>';
      }
    });
    nav.innerHTML = html;
    if (!sidebarEl.querySelector('nav.menu')) sidebarEl.appendChild(nav);
    keepSyncPageAlive(nav);
    nav.querySelectorAll('.menu-group').forEach(function (group) { group.classList.add('collapsed'); });
    nav.querySelectorAll('.group-title').forEach(function (title) {
      title.addEventListener('click', function () {
        var current = title.parentElement;
        var willOpen = current.classList.contains('collapsed');
        nav.querySelectorAll('.menu-group').forEach(function (group) { group.classList.add('collapsed'); });
        if (willOpen) current.classList.remove('collapsed');
      });
    });
    Promise.all([
      fetch('/api/auth/me', { credentials: 'same-origin' }).then(function (res) { return res.ok ? res.json() : null; }),
      fetch('/api/membership/current', { credentials: 'same-origin' }).then(function (res) { return res.ok ? res.json() : null; })
    ]).then(function (values) {
      var account = values[0];
      var membership = values[1] && values[1].membership;
      if (!account) return;
      nav.querySelectorAll('a.menu-item[data-permission="system.admin"]').forEach(function (link) { if (!account.isSystemAdmin) link.remove(); });
      nav.querySelectorAll('a.menu-item[data-permission="membership.agent"]').forEach(function (link) {
        if (account.memberType !== 'owner' || !membership || !membership.agent) link.remove();
      });
      nav.querySelectorAll('.menu-group').forEach(function (group) {
        if (!group.querySelector('a.menu-item')) group.remove();
      });
      if (account.isSystemAdmin || account.memberType === 'owner') return;
      var allowed = account.permissions || [];
      nav.querySelectorAll('a.menu-item').forEach(function (link) {
        var required = link.getAttribute('data-permission');
        var codes = required ? required.split(',') : [];
        if (required !== 'authenticated' && (!codes.length || codes.some(function (code) { return allowed.indexOf(code) < 0; }))) link.remove();
      });
      nav.querySelectorAll('.menu-group').forEach(function (group) {
        if (!group.querySelector('a.menu-item')) group.remove();
      });
    }).catch(function () {});
  }

  // ── 通知面板 ──
  function buildNotificationItems() {
    var items = [];
    try {
      var shops = (window.erpStorage && window.erpStorage.get) ? (window.erpStorage.get('erp_shops_data') || []) : [];
      var bad = shops.filter(function (it) { return it && (it.keyExp === '已过期' || it.keyExp === '即将过期'); });
      if (bad.length) {
        var names = bad.slice(0, 3).map(function (it) { return it.name || ''; }).filter(Boolean).join('、');
        var state = bad.some(function (it) { return it.keyExp === '已过期'; }) ? '已过期' : '即将过期';
        items.push({ title: 'API 密钥提醒', body: bad.length + ' 家店铺密钥' + state + (names ? '：' + names : '') + '，请及时续期。', time: '今天' });
      }
    } catch (e) {}
    return items.slice(0, 8);
  }
  function notificationTime(value) {
    var date = new Date(value || '');
    return isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
  }
  function markNotificationRead(item) {
    if (!item || !item.id || item.readAt || !window.erpStorage || typeof window.erpStorage.request !== 'function') return Promise.resolve();
    return window.erpStorage.request('/api/notifications/' + encodeURIComponent(item.id) + '/read', { method: 'POST' }).then(function (response) {
      if (!response.ok) throw new Error('通知已读状态更新失败，请稍后重试。');
      return response.json();
    }).then(function (result) {
      item.readAt = result.item && result.item.readAt || new Date().toISOString();
      unreadNotificationCount = Math.max(0, unreadNotificationCount - 1);
      refreshNotifPanel();
    }).catch(function () {});
  }
  function markAllNotificationsRead() {
    if (!unreadNotificationCount || !window.erpStorage || typeof window.erpStorage.request !== 'function') return Promise.resolve();
    return window.erpStorage.request('/api/notifications/read-all', { method: 'POST' }).then(function (response) {
      if (!response.ok) throw new Error('通知一键已读失败，请稍后重试。');
      return response.json();
    }).then(function (result) {
      var readAt = result.readAt || new Date().toISOString();
      userNotifications.forEach(function (item) { if (item.id && !item.readAt) item.readAt = readAt; });
      unreadNotificationCount = 0;
      refreshNotifPanel();
    }).catch(function () {});
  }
  function ensureNotificationDialog() {
    var dialog = document.getElementById('erp-notification-detail-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog'); dialog.id = 'erp-notification-detail-dialog'; dialog.className = 'notif-detail-dialog';
    var box = document.createElement('div'); box.className = 'notif-detail-box';
    var head = document.createElement('div'); head.className = 'notif-detail-head';
    var title = document.createElement('strong'); title.className = 'notif-detail-title';
    var close = document.createElement('button'); close.type = 'button'; close.className = 'notif-detail-close'; close.setAttribute('aria-label', '关闭通知'); close.textContent = '×'; close.addEventListener('click', function () { dialog.close(); });
    head.appendChild(title); head.appendChild(close);
    var body = document.createElement('div'); body.className = 'notif-detail-body';
    var time = document.createElement('div'); time.className = 'notif-detail-time';
    box.appendChild(head); box.appendChild(body); box.appendChild(time); dialog.appendChild(box); document.body.appendChild(dialog);
    dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close(); });
    return dialog;
  }
  function showNotificationDetail(item) {
    var dialog = ensureNotificationDialog();
    dialog.querySelector('.notif-detail-title').textContent = String(item && item.title || '通知');
    dialog.querySelector('.notif-detail-body').textContent = String(item && item.body || '');
    dialog.querySelector('.notif-detail-time').textContent = item && item.createdAt ? notificationTime(item.createdAt) : String(item && item.time || '');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function appendNotification(panel, item) {
    var node = document.createElement('button');
    node.type = 'button';
    node.className = 'notif-item' + (item.id && !item.readAt ? ' unread' : '');
    node.addEventListener('click', function () { if (item.id) markNotificationRead(item); showNotificationDetail(item); });
    var title = document.createElement('b');
    title.textContent = String(item.title || '通知');
    title.title = String(item.title || '通知');
    var body = document.createElement('p');
    body.textContent = String(item.body || ''); body.title = String(item.body || '');
    var time = document.createElement('span');
    time.textContent = item.createdAt ? notificationTime(item.createdAt) : String(item.time || '');
    node.appendChild(title); node.appendChild(body); node.appendChild(time);
    panel.appendChild(node);
  }
  function renderNotifications(wrap, badge) {
    var panel = wrap.querySelector('.notif-panel');
    var items = userNotifications.concat(buildNotificationItems(), serverNotices);
    if (panel) {
      panel.replaceChildren();
      var head = document.createElement('div'); head.className = 'notif-head';
      var headTitle = document.createElement('span'); headTitle.textContent = '通知中心'; head.appendChild(headTitle);
      var readAll = document.createElement('button'); readAll.type = 'button'; readAll.className = 'notif-read-all'; readAll.textContent = '一键已读'; readAll.disabled = unreadNotificationCount < 1;
      readAll.addEventListener('click', function (event) { event.stopPropagation(); markAllNotificationsRead(); }); head.appendChild(readAll); panel.appendChild(head);
      if (!items.length) {
        var empty = document.createElement('div');
        empty.className = 'notif-empty'; empty.textContent = '暂无通知'; panel.appendChild(empty);
      } else items.forEach(function (item) { appendNotification(panel, item); });
    }
    if (badge) { badge.textContent = String(unreadNotificationCount); badge.style.display = unreadNotificationCount ? 'inline-flex' : 'none'; }
  }
  function ensureLogoutBtn(headerRight) {
    if (document.getElementById('erp-logout-btn')) return;
    var btn = document.createElement('button');
    btn.id = 'erp-logout-btn';
    btn.type = 'button';
    btn.textContent = '退出';
    btn.addEventListener('click', function () {
      if (window.erpStorage && typeof window.erpStorage.logout === 'function') {
        window.erpStorage.logout().catch(function () {});
        return;
      }
      if (window.top !== window) {
        try { window.top.location.replace('/login.html'); return; } catch (error) {}
      }
      location.replace('/login.html');
    });
    headerRight.appendChild(btn);
  }
  function initHeaderRight() {
    var headerRight = document.querySelector('.header-right');
    if (!headerRight) return;
    loadServerNotices();
    loadUserNotifications();
    var username = '';
    try { username = localStorage.getItem('erp_auth_username') || ''; } catch (e) {}
    var userNameEl = headerRight.querySelector('.user-name');
    if (userNameEl) { userNameEl.textContent = '当前账号'; userNameEl.title = '当前登录账号'; }
    ensureIdentityDisplay().then(function () {
      if (profile) renderHeaderIdentity(profile);
      else renderHeaderIdentity({ username: username });
    });
    ensureLogoutBtn(headerRight);
    var existingWrap = headerRight.querySelector(':scope > .notif-wrap');
    if (existingWrap) {
      renderNotifications(existingWrap, existingWrap.querySelector('.bell-badge'));
      return;
    }
    var bellBtn = headerRight.querySelector(':scope > button.icon-btn:not(#erp-theme-icon)');
    if (!bellBtn) return;
    bellBtn.id = bellBtn.id || 'erp-notification-btn';
    bellBtn.setAttribute('aria-label', '打开通知中心');
    bellBtn.setAttribute('data-notification-button', '1');
    var wrap = document.createElement('div');
    wrap.className = 'notif-wrap';
    bellBtn.parentNode.insertBefore(wrap, bellBtn);
    wrap.appendChild(bellBtn);
    bellBtn.setAttribute('data-notif-ready', '1');
    var badge = document.createElement('span');
    badge.className = 'bell-badge';
    bellBtn.appendChild(badge);
    var panel = document.createElement('div');
    panel.className = 'notif-panel';
    wrap.appendChild(panel);
    renderNotifications(wrap, badge);
    bellBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      loadUserNotifications();
      renderNotifications(wrap, badge);
      wrap.classList.toggle('open');
    });
    document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) wrap.classList.remove('open'); });
  }
  function refresh() {
    var headerRight = document.querySelector('.header-right');
    if (!headerRight) return;
    var username = '';
    try { username = localStorage.getItem('erp_auth_username') || ''; } catch (e) {}
    renderHeaderIdentity(profile || { username: username });
    ensureLogoutBtn(headerRight);
    var wrap = headerRight.querySelector('.notif-wrap');
    if (wrap) renderNotifications(wrap, wrap.querySelector('.bell-badge'));
  }

  // ── 主题切换 ──
  function initThemeToggle() {
    var sb = document.querySelector('.sidebar');
    if (!sb) return;
    var footer = sb.querySelector('.sidebar-footer');
    if (!footer) { footer = document.createElement('div'); footer.className = 'sidebar-footer'; sb.appendChild(footer); }
    if (document.getElementById('erp-theme-toggle')) return;
    var btn = document.createElement('button');
    btn.id = 'erp-theme-toggle';
    btn.className = 'theme-toggle-btn';
    var isDark = document.body.classList.contains('theme-dark');
    btn.innerHTML = '<span class="toggle-icon">' + (isDark ? '☀️' : '🌙') + '</span><span class="toggle-label">' + (isDark ? '切换浅色模式' : '切换深色模式') + '</span><span class="toggle-hint">' + (isDark ? '商务浅色版' : '科技深空蓝') + '</span>';
    btn.addEventListener('click', function () {
      document.body.classList.toggle('theme-dark');
      var dark = document.body.classList.contains('theme-dark');
      document.documentElement.classList.toggle('theme-dark', dark);
      try { localStorage.setItem('erp_theme', dark ? 'dark' : 'light'); } catch (e) {}
      btn.innerHTML = '<span class="toggle-icon">' + (dark ? '☀️' : '🌙') + '</span><span class="toggle-label">' + (dark ? '切换浅色模式' : '切换深色模式') + '</span><span class="toggle-hint">' + (dark ? '商务浅色版' : '科技深空蓝') + '</span>';
      var iconBtn = document.getElementById('erp-theme-icon');
      if (iconBtn) iconBtn.textContent = dark ? '☀️' : '🌙';
    });
    footer.appendChild(btn);
  }
  function initVersionDisplay() {
    var sb = document.querySelector('.sidebar');
    if (!sb) return;
    var footer = sb.querySelector('.sidebar-footer');
    if (!footer) { footer = document.createElement('div'); footer.className = 'sidebar-footer'; sb.appendChild(footer); }
    if (document.getElementById('erp-version-info')) return;
    var info = document.createElement('div');
    info.id = 'erp-version-info';
    info.className = 'erp-version-info';
    info.textContent = '网研ERP · 版本读取中';
    info.title = '正在读取当前运行版本';
    footer.appendChild(info);
    if (!window.fetch) {
      info.textContent = '网研ERP · 版本未知';
      info.title = '当前浏览器不支持读取运行版本';
      return;
    }
    window.fetch('/health/live', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('版本接口请求失败');
        return response.json();
      })
      .then(function (payload) {
        var displayVersion = String(payload && payload.displayVersion || '').trim();
        if (!displayVersion) throw new Error('版本接口缺少显示版本');
        info.textContent = '网研ERP ' + displayVersion;
        info.title = '当前运行版本：' + displayVersion;
      })
      .catch(function () {
        info.textContent = '网研ERP · 版本读取失败';
        info.title = '无法从当前服务读取版本，请确认ERP服务状态';
      });
  }
  function initThemeIcon() {
    var headerRight = document.querySelector('.header-right');
    if (!headerRight) return;
    if (document.getElementById('erp-theme-icon')) return;
    var btn = document.createElement('button');
    btn.id = 'erp-theme-icon';
    btn.className = 'icon-btn theme-icon-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', '切换主题');
    btn.title = '切换主题';
    var isDark = document.body.classList.contains('theme-dark');
    btn.textContent = isDark ? '☀️' : '🌙';
    var quickActions = headerRight.querySelector(':scope > .header-quick-actions');
    headerRight.insertBefore(btn, quickActions ? quickActions.nextSibling : headerRight.firstChild);
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      headerRight.querySelectorAll('.notif-wrap.open').forEach(function (wrap) { wrap.classList.remove('open'); });
      document.body.classList.toggle('theme-dark');
      var dark = document.body.classList.contains('theme-dark');
      document.documentElement.classList.toggle('theme-dark', dark);
      try { localStorage.setItem('erp_theme', dark ? 'dark' : 'light'); } catch (e) {}
      btn.textContent = dark ? '☀️' : '🌙';
      var toggleBtn = document.getElementById('erp-theme-toggle');
      if (toggleBtn) {
        toggleBtn.innerHTML = '<span class="toggle-icon">' + (dark ? '☀️' : '🌙') + '</span><span class="toggle-label">' + (dark ? '切换浅色模式' : '切换深色模式') + '</span><span class="toggle-hint">' + (dark ? '商务浅色版' : '科技深空蓝') + '</span>';
      }
    });
  }

  // ── 基础信息栏：点击头像打开居中大面板（2026-09-21 用户直令） ──
  // 头像字符与可编辑性只认服务端 /api/auth/profile：子账号显示主账号头像且打不开面板。
  var profile = null;
  var profileMask = null;
  var profileCsrf = '';
  var profileCodeTimer = null;
  var profileAutoCloseTimer = null;
  var PROFILE_PANEL_HTML = '<div class="profile-box" role="dialog" aria-modal="true" aria-labelledby="wyerpProfileTitle">' +
    '<div class="profile-head"><strong id="wyerpProfileTitle">基础信息</strong><button type="button" class="profile-close" data-profile-close aria-label="关闭基础信息">&times;</button></div>' +
    '<div class="profile-body">' +
    '<div class="profile-identity"><span class="profile-avatar" id="pfAvatar">&nbsp;</span><div>' +
    '<div class="profile-identity-name" id="pfIdentityName"></div>' +
    '<div class="profile-identity-meta"><span id="pfAccountLine"></span><span id="pfRoleLine"></span><span id="pfTenantLine"></span></div>' +
    '<small class="profile-hint" id="pfAvatarHint"></small>' +
    '</div></div>' +
    '<input type="file" id="pfAvatarFile" class="profile-avatar-file" accept="image/png,image/jpeg,image/webp,image/gif">' +
    '<div class="profile-hint">带 <span class="profile-req">*</span> 为基础信息必填项</div>' +
    '<div class="profile-hint" id="pfTrialBonus">正在读取完善资料赠送状态…</div>' +
    '<div class="profile-grid">' +
    '<label class="profile-field"><span class="profile-label">姓名<span class="profile-req">*</span></span><span class="profile-control"><span class="profile-input-wrap"><input id="pfName" maxlength="60" autocomplete="name"><span class="profile-flag" id="pfNameFlag" aria-hidden="true"></span></span></span></label>' +
    '<label class="profile-field"><span class="profile-label">性别</span><span class="profile-control"><select id="pfGender"><option value="">保密</option><option value="male">男</option><option value="female">女</option></select></span></label>' +
    '<label class="profile-field"><span class="profile-label">手机号<span class="profile-req">*</span></span><span class="profile-control"><span class="profile-input-wrap"><input id="pfPhone" maxlength="20" inputmode="tel" autocomplete="tel" placeholder="11 位中国大陆手机号，如 13800138000"><span class="profile-flag" id="pfPhoneFlag" aria-hidden="true"></span></span><small class="profile-hint">当前仅校验手机号格式，暂未开通短信验证</small></span></label>' +
    '<label class="profile-field"><span class="profile-label">邮箱<span class="profile-req">*</span></span><span class="profile-control"><span class="profile-email-row"><span class="profile-input-wrap"><input id="pfEmail" maxlength="240" inputmode="email" autocomplete="email" placeholder="name@example.com"><span class="profile-flag" id="pfEmailFlag" aria-hidden="true"></span></span><button type="button" class="btn" id="pfSendCode">获取验证码</button><span class="profile-badge todo" id="pfEmailBadge"></span></span><small class="profile-hint" id="pfEmailHint"></small></span></label>' +
    '<label class="profile-field"><span class="profile-label">邮箱验证码</span><span class="profile-control"><span class="profile-email-row"><input id="pfCode" maxlength="6" inputmode="numeric"><button type="button" class="btn" id="pfConfirmCode">确认验证</button></span><small class="profile-hint">验证码 10 分钟内有效，错误次数过多需重新获取</small></span></label>' +
    '<label class="profile-field" id="pfTenantNameField"><span class="profile-label">公司名称<span class="profile-req">*</span></span><span class="profile-control"><span class="profile-input-wrap"><input id="pfTenantName" maxlength="160" placeholder="至少包含一个中文，如 某某跨境电商有限公司"><span class="profile-flag" id="pfTenantNameFlag" aria-hidden="true"></span></span><small class="profile-hint" id="pfTenantNameHint"></small></span></label>' +
    '<label class="profile-field"><span class="profile-label">个性签名</span><span class="profile-control"><textarea id="pfSignature" maxlength="200"></textarea><small class="profile-hint">可不填，最多 200 字</small></span></label>' +
    '</div>' +
    '<div class="profile-state" id="pfState" role="status"></div>' +
    '</div>' +
    '<div class="profile-foot"><button type="button" class="btn" data-profile-close>关闭</button><button type="button" class="btn btn-primary" id="pfSave">保存基础信息</button></div>' +
    '</div>';

  function profileField(id) { return document.getElementById(id); }

  // 基础信息格式校验与服务端同一口径（2026-09-21 用户直令）：手机号只校验中国大陆格式不发短信，
  // 邮箱校验语法，公司名称必须含中文；公司名称只在真的要改名时才卡格式，避免历史名称锁死保存。
  var PROFILE_PHONE_RE = /^1[3-9]\d{9}$/;
  var PROFILE_EMAIL_RE = /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
  var PROFILE_TENANT_NAME_RE = /^[\u4e00-\u9fffA-Za-z0-9（）()《》【】·．.、，,&+_\- ]{2,160}$/;
  var PROFILE_HAN_RE = /[\u4e00-\u9fff]/;
  var PROFILE_INVALID_IDS = ['pfName', 'pfPhone', 'pfEmail', 'pfTenantName'];
  // 2026-09-21 用户直令：必填文本框末尾加状态标识，格式对打钩、错打叉，保存前必须全对。
  var PROFILE_FLAG_IDS = { pfName: 'pfNameFlag', pfPhone: 'pfPhoneFlag', pfEmail: 'pfEmailFlag', pfTenantName: 'pfTenantNameFlag' };
  var profileSaveAttempted = false;

  function profilePhoneDigits(value) {
    return String(value || '').replace(/[^\d+]/g, '').replace(/^\+?86(?=1\d{10}$)/, '');
  }

  function profileEmailOk(value) {
    var email = String(value || '').trim();
    return email.length <= 240 && email.indexOf('..') < 0 && PROFILE_EMAIL_RE.test(email);
  }

  function profileTenantNameOk(value) {
    var name = String(value || '').replace(/\s+/g, ' ').trim();
    return PROFILE_TENANT_NAME_RE.test(name) && PROFILE_HAN_RE.test(name);
  }

  // 公司名称只在"可编辑且真的要改名"时参与校验，历史非中文名空间不得被锁死。
  function profileTenantNameParticipates() {
    var field = profileField('pfTenantName');
    if (!field || field.disabled) return false;
    return String(field.value || '').replace(/\s+/g, ' ').trim() !== String(profile ? profile.tenantName : '').replace(/\s+/g, ' ').trim();
  }

  // 'ok' 打钩、'bad' 打叉、'' 中性（必填项还没填且用户尚未尝试保存，或该字段不参与校验）。
  function profileFieldState(id) {
    var field = profileField(id);
    if (!field) return '';
    if (id === 'pfTenantName') {
      if (!profileTenantNameParticipates()) return '';
      return profileTenantNameOk(field.value) ? 'ok' : 'bad';
    }
    var value = id === 'pfPhone' ? profilePhoneDigits(field.value) : String(field.value || '').trim();
    if (!value) return profileSaveAttempted ? 'bad' : '';
    if (id === 'pfName') return value.length >= 2 && value.length <= 60 ? 'ok' : 'bad';
    if (id === 'pfPhone') return PROFILE_PHONE_RE.test(value) ? 'ok' : 'bad';
    return profileEmailOk(value) ? 'ok' : 'bad';
  }

  function renderProfileFlags() {
    Object.keys(PROFILE_FLAG_IDS).forEach(function (id) {
      var flag = profileField(PROFILE_FLAG_IDS[id]);
      if (!flag) return;
      var state = profileFieldState(id);
      flag.textContent = state === 'ok' ? '✓' : (state === 'bad' ? '✕' : '');
      flag.className = state ? 'profile-flag ' + state : 'profile-flag';
    });
  }

  // 返回第一条中文错误并把不合规字段标红；全部合规时返回 null。
  function validateProfileFields() {
    var problems = [];
    var name = profileField('pfName') ? profileField('pfName').value.trim() : '';
    var phone = profileField('pfPhone') ? profilePhoneDigits(profileField('pfPhone').value) : '';
    var email = profileField('pfEmail') ? profileField('pfEmail').value.trim() : '';
    var tenantInput = profileField('pfTenantName');
    if (name.length < 2 || name.length > 60) problems.push(['pfName', '姓名需为 2-60 个字符']);
    if (!PROFILE_PHONE_RE.test(phone)) problems.push(['pfPhone', '手机号格式不正确，请填写 11 位中国大陆手机号']);
    if (!email) problems.push(['pfEmail', '请填写邮箱地址']);
    else if (!profileEmailOk(email)) problems.push(['pfEmail', '邮箱格式不正确，请填写有效邮箱地址']);
    if (profileTenantNameParticipates() && !profileTenantNameOk(tenantInput.value)) {
      problems.push(['pfTenantName', '公司名称需为 2-160 个字符且至少包含一个中文字符']);
    }
    PROFILE_INVALID_IDS.forEach(function (id) {
      var field = profileField(id);
      if (!field) return;
      var bad = problems.some(function (item) { return item[0] === id; });
      field.classList.toggle('invalid', bad);
    });
    renderProfileFlags();
    return problems.length ? problems[0] : null;
  }

  function requireProfileEmailFormat() {
    var field = profileField('pfEmail');
    var email = field ? field.value.trim() : '';
    var ok = profileEmailOk(email);
    if (field) field.classList.toggle('invalid', !ok);
    if (!ok) {
      profileState('邮箱格式不正确，请填写有效邮箱地址', true);
      if (field) field.focus();
    }
    renderProfileFlags();
    return ok ? email : '';
  }

  function profileRequest(url, options) {
    if (window.erpStorage && typeof window.erpStorage.request === 'function') return window.erpStorage.request(url, options);
    options = options || {};
    options.credentials = 'same-origin';
    return fetch(url, options);
  }

  function profilePost(url, payload) {
    var body = JSON.stringify(payload || {});
    if (window.erpStorage && typeof window.erpStorage.request === 'function') {
      return window.erpStorage.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
    }
    function send(token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers['X-CSRF-Token'] = token;
      return fetch(url, { method: 'POST', credentials: 'same-origin', headers: headers, body: body });
    }
    if (profileCsrf) return send(profileCsrf);
    return fetch('/api/auth/me', { credentials: 'same-origin' }).then(function (response) {
      return response.json().catch(function () { return {}; });
    }).then(function (me) {
      profileCsrf = String((me && me.csrfToken) || '');
      return send(profileCsrf);
    });
  }

  function profileJson(response) {
    return response.json().catch(function () { return {}; }).then(function (data) {
      if (!response.ok) {
        var error = new Error(String(data.message || '基础信息操作未完成，请稍后重试。'));
        error.retryAfterSeconds = Number(data.retryAfterSeconds) || 0;
        throw error;
      }
      return data;
    });
  }

  function profileState(message, failed) {
    var node = profileField('pfState');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('failed', failed === true);
  }

  // 头像上传走原始字节，避免 Base64 膨胀；CSRF 取用方式与 profilePost 一致。
  var PROFILE_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
  var PROFILE_AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  // 服务端只存字节不做缩放，所以大图必须在本机先压成预览图，否则小圆里只剩看不清的裁切块。
  var PROFILE_AVATAR_MAX_SIDE = 256;
  var PROFILE_AVATAR_KEEP_BYTES = 200 * 1024;

  function loadAvatarImage(file) {
    return new Promise(function (resolve, reject) {
      if (typeof Image !== 'function' || typeof document === 'undefined') { reject(new Error('当前浏览器不支持图片处理')); return; }
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = function () { URL.revokeObjectURL(url); reject(new Error('图片无法解码，请换一张')); };
      image.src = url;
    });
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      if (!canvas || typeof canvas.toBlob !== 'function') { reject(new Error('当前浏览器不支持图片导出')); return; }
      canvas.toBlob(function (blob) {
        if (blob && blob.size) resolve(blob);
        else reject(new Error('图片导出为空，请重试'));
      }, type, quality);
    });
  }

  // GIF 保留动画原样上传；其余按最长边 256 等比缩放，不裁剪，保证整张图都能看见。
  async function prepareAvatarUpload(file) {
    var type = String(file.type || '').toLowerCase();
    if (type === 'image/gif') return { blob: file, contentType: 'image/gif' };
    var image = await loadAvatarImage(file);
    var width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('图片尺寸无效，请重新选择文件');
    var scale = Math.min(1, PROFILE_AVATAR_MAX_SIDE / Math.max(width, height));
    if (scale >= 1 && file.size <= PROFILE_AVATAR_KEEP_BYTES) return { blob: file, contentType: type };
    var outputType = type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    var context = canvas.getContext ? canvas.getContext('2d') : null;
    if (!context) throw new Error('浏览器无法处理图片，请换一张');
    if (outputType === 'image/jpeg') { context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height); }
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    var blob = await canvasToBlob(canvas, outputType, 0.9);
    return { blob: blob, contentType: String(blob.type || outputType) };
  }

  function profilePostRaw(url, blob, contentType) {
    function send(token) {
      var headers = { 'Content-Type': contentType };
      if (token) headers['X-CSRF-Token'] = token;
      return profileRequest(url, { method: 'POST', headers: headers, body: blob });
    }
    if (profileCsrf) return send(profileCsrf);
    return profileRequest('/api/auth/me').then(function (response) {
      return response.json().catch(function () { return {}; });
    }).then(function (me) {
      profileCsrf = String((me && me.csrfToken) || '');
      return send(profileCsrf);
    });
  }

  // 头像显示：有图片用同源鉴权地址的 <img>，没有图片回落服务端首字符，绝不把任何值拼进 HTML。
  function setAvatarNode(node, url, letter) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
    if (url) {
      var img = document.createElement('img');
      img.className = 'profile-avatar-img';
      img.alt = '头像';
      img.src = url;
      node.appendChild(img);
    } else {
      node.textContent = letter || '研';
    }
  }

  function clearAvatarInput() {
    var input = profileField('pfAvatarFile');
    if (input) input.value = '';
  }

  function uploadProfileAvatar(file) {
    if (!file) { clearAvatarInput(); return; }
    if (PROFILE_AVATAR_TYPES.indexOf(String(file.type || '').toLowerCase()) < 0) {
      profileState('头像只支持 PNG、JPG、WebP 或 GIF 图片', true);
      clearAvatarInput();
      return;
    }
    if (!file.size) {
      profileState('头像图片为空，请重新选择文件', true);
      clearAvatarInput();
      return;
    }
    if (file.size > PROFILE_AVATAR_MAX_BYTES) {
      profileState('头像图片不得超过 2MB', true);
      clearAvatarInput();
      return;
    }
    profileState('正在处理并上传头像…');
    prepareAvatarUpload(file).then(function (prepared) {
      if (prepared.blob.size > PROFILE_AVATAR_MAX_BYTES) throw new Error('图片压缩后仍超过 2MB，请换一张更小的图');
      return profilePostRaw('/api/auth/profile/avatar', prepared.blob, prepared.contentType).then(profileJson);
    }).then(function (data) {
      profile = data.profile || profile;
      renderHeaderIdentity(profile || {});
      applyProfileAvatar();
      renderProfileMeta();
      profileState('头像已更新');
    }).catch(function (error) {
      profileState(error.message, true);
    }).then(clearAvatarInput);
  }

  function openAvatarPicker() {
    if (!profile || profile.canEdit !== true) return;
    var input = profileField('pfAvatarFile');
    if (input) input.click();
  }

  function applyProfileAvatar() {
    var headerRight = document.querySelector('.header-right');
    if (!headerRight || !profile) return;
    var avatar = headerRight.querySelector('.avatar');
    if (!avatar) return;
    setAvatarNode(avatar, profile.displayAvatarUrl || '', profile.avatarLetter);
    if (profile.canEdit) {
      avatar.setAttribute('data-profile-openable', '1');
      avatar.setAttribute('role', 'button');
      avatar.setAttribute('tabindex', '0');
      avatar.setAttribute('aria-label', '打开基础信息');
      var identity = displayedIdentity(profile);
      avatar.title = '基础信息：' + (identity.raw || identity.masked || '当前账号');
    } else {
      avatar.removeAttribute('data-profile-openable');
      avatar.removeAttribute('role');
      avatar.removeAttribute('tabindex');
      avatar.removeAttribute('aria-label');
      avatar.title = '子账号的基础信息由主账号维护';
    }
  }

  function profileRoleText() {
    if (profile.isSystemAdmin) return '系统管理员';
    return profile.memberType === 'owner' ? '主账号' : '子账号';
  }

  // 只刷新身份区、徽章和提示文字，绝不写回任何输入框的值。
  // 2026-09-21 用户报BUG：点“获取验证码”后邮箱被清空——因为发送成功后整表回填，
  // 把用户刚输入、还没成为 pendingEmail 的邮箱覆盖成了服务器旧值。
  function renderProfileMeta() {
    if (!profile) return;
    var big = profileField('pfAvatar');
    var canEditProfile = profile.canEdit === true;
    setAvatarNode(big, profile.avatarUrl, profile.avatarLetter);
    if (big) {
      if (canEditProfile) {
        big.setAttribute('data-avatar-openable', '1');
        big.setAttribute('role', 'button');
        big.setAttribute('tabindex', '0');
        big.setAttribute('aria-label', '上传头像');
        big.title = '点击上传头像（PNG/JPG/WebP/GIF，不超过 2MB）';
      } else {
        big.removeAttribute('data-avatar-openable');
        big.removeAttribute('role');
        big.removeAttribute('tabindex');
        big.removeAttribute('aria-label');
        big.removeAttribute('title');
      }
    }
    var avatarHint = profileField('pfAvatarHint');
    if (avatarHint) {
      avatarHint.textContent = canEditProfile
        ? '点击头像可上传图片（PNG/JPG/WebP/GIF，不超过 2MB），未上传时显示姓名首字符'
        : '头像由本空间主账号维护，子账号默认显示主账号头像';
    }
    var identity = displayedIdentity(profile);
    var nameLine = profileField('pfIdentityName');
    if (nameLine) { nameLine.textContent = identity.masked || '当前账号'; nameLine.title = identity.raw || ''; }
    var accountLine = profileField('pfAccountLine');
    if (accountLine) { accountLine.textContent = '账号：' + (identity.masked || '当前账号'); accountLine.title = identity.raw || ''; }
    var roleLine = profileField('pfRoleLine');
    if (roleLine) roleLine.textContent = '账号身份：' + profileRoleText();
    var tenantLine = profileField('pfTenantLine');
    if (tenantLine) tenantLine.textContent = '客户空间：' + profile.tenantName;
    var canRenameTenant = profile.canRenameTenant === true;
    var tenantInput = profileField('pfTenantName');
    if (tenantInput) {
      tenantInput.disabled = !canRenameTenant;
      tenantInput.readOnly = !canRenameTenant;
    }
    var tenantField = profileField('pfTenantNameField');
    if (tenantField) tenantField.classList.toggle('locked', !canRenameTenant);
    var tenantHint = profileField('pfTenantNameHint');
    if (tenantHint) tenantHint.textContent = canRenameTenant ? '必须包含中文，可含字母、数字和常见括号' : '公司名称由本空间主账号维护';
    var badge = profileField('pfEmailBadge');
    if (badge) {
      badge.textContent = profile.email ? '已验证' : (profile.pendingEmail ? '待验证' : '未验证');
      badge.className = 'profile-badge ' + (profile.email ? 'ok' : 'todo');
    }
    var hint = profileField('pfEmailHint');
    if (hint) hint.textContent = profile.email
      ? '已验证时间：' + profile.emailVerifiedAt.replace('T', ' ').slice(0, 16) + '（UTC）'
      : '填写邮箱后点“获取验证码”，验证通过才计入基础信息';
    var trialBonus = profile.trialBonus || {};
    var trialBonusNode = profileField('pfTrialBonus');
    if (trialBonusNode) {
      var bonusPrefix = '完善资料赠送：';
      if (trialBonus.justGranted === true) trialBonusNode.textContent = bonusPrefix + (trialBonus.message || ('已赠送 ' + Number(trialBonus.grantedDays || 0) + ' 天'));
      else if (trialBonus.reason === 'claimed') trialBonusNode.textContent = bonusPrefix + '已领取；注册与完善资料赠送合计最多 ' + Number(trialBonus.capDays || 30) + ' 天。';
      else if (trialBonus.reason === 'profile_incomplete') trialBonusNode.textContent = bonusPrefix + '填写真实姓名并完成邮箱验证后，可再赠 ' + Number(trialBonus.bonusDays || 15) + ' 天。';
      else trialBonusNode.textContent = bonusPrefix + (trialBonus.message || '状态暂不可用，请稍后重新打开基础信息。');
    }
    renderProfileFlags();
  }

  function profileFormFullName() {
    if (!profile) return '';
    var saved = String(profile.profileFullName || '').trim();
    if (saved) return saved;
    // 兼容历史资料：旧版本可能已经把主账号/系统管理员姓名写入成员显示名，但 user_profiles.full_name 仍为空。
    // 只允许可编辑账号回退，且账号名本身不能冒充真实姓名；子账号继续只认 profileFullName。
    var fallback = profile.canEdit === true ? String(profile.fullName || '').trim() : '';
    var username = String(profile.username || '').trim();
    return fallback && fallback !== username ? fallback : '';
  }

  function renderProfileForm() {
    if (!profile) return;
    renderProfileMeta();
    if (profileField('pfName')) profileField('pfName').value = profileFormFullName();
    if (profileField('pfPhone')) profileField('pfPhone').value = profile.phone || '';
    if (profileField('pfEmail')) profileField('pfEmail').value = profile.pendingEmail || profile.email || '';
    if (profileField('pfGender')) profileField('pfGender').value = profile.gender || '';
    if (profileField('pfSignature')) profileField('pfSignature').value = profile.signature || '';
    var tenantInput = profileField('pfTenantName');
    if (tenantInput) tenantInput.value = profile.tenantName || '';
    PROFILE_INVALID_IDS.forEach(function (id) {
      var field = profileField(id);
      if (field) field.classList.remove('invalid');
    });
    renderProfileFlags();
  }

  function loadProfile(keepState) {
    return Promise.all([
      profileRequest('/api/auth/profile').then(profileJson),
      ensureIdentityDisplay()
    ]).then(function (values) {
      profile = values[0].profile || null;
      renderHeaderIdentity(profile || {});
      applyProfileAvatar();
      renderProfileForm();
      if (!keepState) profileState('');
      return profile;
    }).catch(function (error) {
      profileState(error.message, true);
      return null;
    });
  }

  function openProfilePanel() {
    if (!profileMask) return;
    if (profileAutoCloseTimer) { clearTimeout(profileAutoCloseTimer); profileAutoCloseTimer = null; }
    profileSaveAttempted = false;
    profileMask.classList.add('show');
    loadProfile(true);
    var first = profileField('pfName');
    if (first) setTimeout(function () { first.focus(); }, 30);
  }

  function closeProfilePanel() {
    if (!profileMask) return;
    profileMask.classList.remove('show');
    if (profileCodeTimer) {
      clearInterval(profileCodeTimer);
      profileCodeTimer = null;
      var sendButton = profileField('pfSendCode');
      if (sendButton) { sendButton.disabled = false; sendButton.textContent = '重新发送'; }
    }
    if (profileAutoCloseTimer) { clearTimeout(profileAutoCloseTimer); profileAutoCloseTimer = null; }
  }

  function startCodeCountdown(seconds) {
    var button = profileField('pfSendCode');
    if (!button) return;
    if (profileCodeTimer) { clearInterval(profileCodeTimer); profileCodeTimer = null; }
    var left = Math.max(1, Number(seconds) || 60);
    button.disabled = true;
    function tick() {
      button.textContent = left > 0 ? left + ' 秒后重发' : '重新发送';
      if (left <= 0) {
        clearInterval(profileCodeTimer);
        profileCodeTimer = null;
        button.disabled = false;
        return;
      }
      left -= 1;
    }
    tick();
    profileCodeTimer = setInterval(tick, 1000);
  }

  function saveProfile() {
    profileSaveAttempted = true;
    var problem = validateProfileFields();
    if (problem) {
      profileState(problem[1], true);
      var badField = profileField(problem[0]);
      if (badField) badField.focus();
      return;
    }
    var payload = {
      fullName: profileField('pfName').value,
      phone: profileField('pfPhone').value,
      gender: profileField('pfGender').value,
      signature: profileField('pfSignature').value
    };
    // 系统管理员在客户空间里是成员，不提交公司名称，避免误改他人空间。
    if (profile && profile.canRenameTenant === true) payload.tenantName = profileField('pfTenantName').value;
    profilePost('/api/auth/profile', payload).then(profileJson).then(function (data) {
      profile = data.profile || profile;
      renderHeaderIdentity(profile || {});
      applyProfileAvatar();
      renderProfileForm();
      profileState('基础信息已保存，正在关闭…');
      // 2026-09-21 用户直令："保存后就自动关闭这个页面"——留 800ms 让状态行可见再关。
      if (profileAutoCloseTimer) clearTimeout(profileAutoCloseTimer);
      profileAutoCloseTimer = setTimeout(function () {
        profileAutoCloseTimer = null;
        closeProfilePanel();
      }, 800);
    }).catch(function (error) { profileState(error.message, true); });
  }

  function sendEmailCode() {
    var email = requireProfileEmailFormat();
    if (!email) return;
    var button = profileField('pfSendCode');
    if (button && button.disabled) return;
    if (button) {
      button.disabled = true;
      button.textContent = '正在发送…';
    }
    profileState('正在发送邮箱验证码…');
    profilePost('/api/auth/profile/email/send', { email: email }).then(profileJson).then(function (data) {
      profile = data.profile || profile;
      startCodeCountdown(data.retryAfterSeconds || 60);
      profileState('验证码已发送至 ' + data.email + '，10 分钟内有效。');
      // 只刷新徽章与提示：整表回填会把刚输入的邮箱和未保存的姓名、手机号一起清掉
      renderProfileMeta();
    }).catch(function (error) {
      profileState(error.retryAfterSeconds ? error.message + '（' + error.retryAfterSeconds + ' 秒后可重试）' : error.message, true);
      if (error.retryAfterSeconds) startCodeCountdown(error.retryAfterSeconds);
      else if (button) {
        button.disabled = false;
        button.textContent = '获取验证码';
      }
    });
  }

  function confirmEmailCode() {
    var email = requireProfileEmailFormat();
    if (!email) return;
    var code = profileField('pfCode').value.trim();
    if (!/^\d{6}$/.test(code)) {
      profileState('请输入服务端发送的 6 位数字验证码', true);
      profileField('pfCode').focus();
      return;
    }
    profilePost('/api/auth/profile/email/confirm', { email: email, code: code }).then(profileJson).then(function (data) {
      profile = data.profile || profile;
      renderHeaderIdentity(profile || {});
      applyProfileAvatar();
      renderProfileMeta();
      // 验证成功只允许把邮箱这一格换成服务器已确认的地址，其它输入保持用户当前内容
      if (profileField('pfEmail')) profileField('pfEmail').value = profile.email || email;
      if (profileField('pfCode')) profileField('pfCode').value = '';
      renderProfileFlags();
      profileState('邮箱已验证并绑定。');
    }).catch(function (error) { profileState(error.message, true); });
  }

  function initProfilePanel() {
    if (workspaceEmbedded || !document.body) return;
    profileMask = document.createElement('div');
    profileMask.className = 'profile-mask';
    profileMask.id = 'wyerpProfileMask';
    profileMask.innerHTML = PROFILE_PANEL_HTML;
    document.body.appendChild(profileMask);
    profileMask.addEventListener('click', function (event) {
      if (event.target === profileMask || (event.target.closest && event.target.closest('[data-profile-close]'))) closeProfilePanel();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && profileMask.classList.contains('show')) closeProfilePanel();
    });
    profileField('pfSave').addEventListener('click', saveProfile);
    profileField('pfSendCode').addEventListener('click', sendEmailCode);
    profileField('pfConfirmCode').addEventListener('click', confirmEmailCode);
    PROFILE_INVALID_IDS.forEach(function (id) {
      var field = profileField(id);
      if (!field) return;
      field.addEventListener('input', function () {
        field.classList.remove('invalid');
        renderProfileFlags();
      });
    });
    var avatarNode = profileField('pfAvatar');
    if (avatarNode) {
      avatarNode.addEventListener('click', openAvatarPicker);
      avatarNode.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openAvatarPicker();
      });
    }
    var avatarInput = profileField('pfAvatarFile');
    if (avatarInput) avatarInput.addEventListener('change', function () { uploadProfileAvatar(avatarInput.files && avatarInput.files[0]); });
    document.addEventListener('click', function (event) {
      var avatar = event.target && event.target.closest ? event.target.closest('.header-right .avatar') : null;
      if (!avatar || !profile || !profile.canEdit) return;
      openProfilePanel();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var avatar = event.target && event.target.closest ? event.target.closest('.header-right .avatar') : null;
      if (!avatar || !profile || !profile.canEdit) return;
      event.preventDefault();
      openProfilePanel();
    });
    loadProfile();
  }

  if (!workspaceEmbedded) {
    initHeaderRight();
    initThemeToggle();
    initVersionDisplay();
    initThemeIcon();
  }
  initProfilePanel();
  loadSyncProgress();
  (function loadTablePagination() {
    if (window.WYERP_TABLE_PAGINATION) { window.WYERP_TABLE_PAGINATION.scan(); return; }
    if (document.querySelector('script[data-wyerp-table-pagination]')) return;
    var script = document.createElement('script');
    script.src = '/assets/table-pagination.js?v=20260925-1';
    script.dataset.wyerpTablePagination = '1';
    document.head.appendChild(script);
  })();
  window.WYERP_HEADER = window.WYERP_HEADER || {};
  window.WYERP_HEADER.init = initHeaderRight;
  window.WYERP_HEADER.refresh = refresh;
  window.WYERP_THEME = { init: initThemeToggle, refresh: initThemeIcon };
})();
