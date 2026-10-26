/* 网研ERP — 常驻功能页签工作台 */
(function () {
  'use strict';
  if (!document.body.classList.contains('workspace-shell')) return;

  var STORAGE_KEY = 'wyerp_workspace_tabs_v1';
  var BUG_SOURCE_KEY = 'wyerp_bug_source_route_v1';
  var tabsEl = document.getElementById('workspaceTabs');
  var deckEl = document.getElementById('workspaceDeck');
  var titleEl = document.getElementById('workspaceTitle');
  var breadcrumbEl = document.getElementById('workspaceBreadcrumb');
  var navEl = document.querySelector('.sidebar nav.menu');
  var memberBtn = document.getElementById('headerMemberBtn');
  var beanBtn = document.getElementById('headerBeanBtn');
  var tabs = [];
  var activeKey = '';
  var frontendVersionState = { version: '', shellVersion: '', pendingShellVersion: '', pendingVersion: '', checking: false, lastCheckAt: 0, snoozeUntil: 0, timer: null };
  var frontendUpdateNotice = null;
  var frameLoadingEl = null;

  function cleanText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function safeRoute(value) {
    var url;
    try { url = new URL(String(value || '/index.html'), location.origin); } catch (error) { return '/index.html'; }
    if (url.origin !== location.origin || /^\/login\.html$/i.test(url.pathname) || /^\/workspace\.html$/i.test(url.pathname)) return '/index.html';
    url.searchParams.delete('workspace');
    var pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    return pathname + (url.search ? url.search : '') + (url.hash ? url.hash : '');
  }
  function routeKey(route) {
    try { return new URL(route, location.origin).pathname.toLowerCase(); } catch (error) { return '/index.html'; }
  }
  function embeddedRoute(route) {
    var url = new URL(safeRoute(route), location.origin);
    url.searchParams.set('workspace', '1');
    return url.pathname + url.search + url.hash;
  }
  function menuLabel(route) {
    var path = routeKey(route);
    var found = '';
    (window.WYERP_MENU || []).some(function (item) {
      if (item.items) {
        return item.items.some(function (sub) {
          if (routeKey(sub.href) === path) { found = sub.label; return true; }
          return false;
        });
      }
      if (routeKey(item.href) === path) { found = item.label; return true; }
      return false;
    });
    return found || (path === '/index.html' ? '概览' : '功能页面');
  }
  function rememberBugSource(targetKey) {
    if (targetKey !== '/pages/bug-feedback.html' || !activeKey || activeKey === targetKey) return '';
    var sourceItem = tabs.find(function (tab) { return tab.key === activeKey; });
    if (!sourceItem) return '';
    var sourceRoute = safeRoute(sourceItem.route);
    try { sessionStorage.setItem(BUG_SOURCE_KEY, sourceRoute); } catch (error) {}
    return sourceRoute;
  }
  function loadSaved() {
    try {
      var parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || !Array.isArray(parsed.tabs)) return;
      tabs = parsed.tabs.slice(0, 12).map(function (item) {
        var route = safeRoute(item.route);
        return { key: routeKey(route), route: route, title: cleanText(item.title) || menuLabel(route), frame: null };
      }).filter(function (item, index, all) { return all.findIndex(function (other) { return other.key === item.key; }) === index; });
      activeKey = String(parsed.activeKey || '');
    } catch (error) { tabs = []; activeKey = ''; }
  }
  function save() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        activeKey: activeKey,
        tabs: tabs.map(function (item) { return { route: item.route, title: item.title }; })
      }));
    } catch (error) {}
  }
  function frameIsSyncing(frame) {
    try {
      var progress = frame && frame.contentWindow && frame.contentWindow.WYERP_SYNC_STREAM && frame.contentWindow.WYERP_SYNC_STREAM.progress;
      return !!(progress && progress.isActive());
    } catch (error) { return false; }
  }
  function frameHasPendingWork(item) {
    if (!item || !item.frame || !item.frame.isConnected) return false;
    if (item.loading || frameIsSyncing(item.frame)) return true;
    try {
      var checker = item.frame.contentWindow && item.frame.contentWindow.WYERP_WORKSPACE_DIRTY;
      if (checker && typeof checker.hasPending === 'function') return Boolean(checker.hasPending());
      if (item.key === '/pages/product-detail.html') return true;
      var sku = item.frame.contentWindow && item.frame.contentWindow.wyerpSkuImage;
      return Boolean(sku && typeof sku.hasPending === 'function' && sku.hasPending());
    } catch (error) { return true; }
  }
  function protectedFrontendTabs() {
    return tabs.filter(function (item) { return item.frame && item.frame.isConnected && frameHasPendingWork(item); });
  }
  function ensureFrontendUpdateNotice() {
    if (frontendUpdateNotice && frontendUpdateNotice.isConnected) return frontendUpdateNotice;
    var box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.style.cssText = 'position:fixed;z-index:20000;top:72px;right:20px;max-width:520px;padding:12px 14px;border:1px solid #d9a400;border-radius:10px;background:#fff9db;color:#5f4b00;box-shadow:0 12px 32px rgba(15,23,42,.18);font-size:13px;line-height:1.6;display:none';
    var text = document.createElement('span');
    text.dataset.role = 'text';
    var actions = document.createElement('span');
    actions.style.cssText = 'display:inline-flex;gap:8px;margin-left:12px;vertical-align:middle';
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重新检查';
    retry.style.cssText = 'border:1px solid #c79a00;border-radius:7px;background:#fff;color:#6b5200;padding:4px 10px;cursor:pointer';
    retry.addEventListener('click', function () { frontendVersionState.snoozeUntil = 0; checkFrontendVersion(true); });
    var later = document.createElement('button');
    later.type = 'button';
    later.textContent = '稍后';
    later.style.cssText = 'border:0;background:transparent;color:#7a681f;padding:4px 6px;cursor:pointer';
    later.addEventListener('click', function () { frontendVersionState.snoozeUntil = Date.now() + 5 * 60 * 1000; box.style.display = 'none'; });
    actions.append(retry, later);
    box.append(text, actions);
    document.body.append(box);
    frontendUpdateNotice = box;
    return box;
  }
  function showFrontendUpdateNotice(message) {
    if (Date.now() < frontendVersionState.snoozeUntil) return;
    var box = ensureFrontendUpdateNotice();
    var text = box.querySelector('[data-role="text"]');
    if (text) text.textContent = message;
    box.style.display = 'block';
  }
  function hideFrontendUpdateNotice() {
    if (frontendUpdateNotice) frontendUpdateNotice.style.display = 'none';
  }
  function refreshFrameForVersion(item, version) {
    if (!item) return;
    item.staleVersion = '';
    item.frontendVersion = version || frontendVersionState.version;
    if (!item.frame || !item.frame.isConnected) return;
    navigateFrame(item, item.frontendVersion);
  }
  function attemptPendingFrontendUpdate() {
    if (frontendVersionState.pendingShellVersion) {
      var protectedTabs = protectedFrontendTabs();
      if (!protectedTabs.length) {
        save();
        location.reload();
        return;
      }
      showFrontendUpdateNotice('系统前端已更新；' + protectedTabs.length + ' 个页签有未保存内容或任务正在运行，为避免数据丢失暂不自动刷新。保存完成后会自动更新。');
      return;
    }
    var blocked = [];
    tabs.forEach(function (item) {
      if (!item.staleVersion) return;
      if (frameHasPendingWork(item)) { blocked.push(item); return; }
      refreshFrameForVersion(item, item.staleVersion);
    });
    if (blocked.length) showFrontendUpdateNotice('前端已更新；安全页签已自动刷新，仍有 ' + blocked.length + ' 个页签存在未保存内容或运行中的任务，保存后会自动刷新。');
    else hideFrontendUpdateNotice();
  }
  function acceptFrontendVersion(data) {
    if (!data || !/^[a-f0-9]{24}$/i.test(String(data.version || '')) || !/^[a-f0-9]{24}$/i.test(String(data.shellVersion || ''))) return;
    if (!frontendVersionState.version) {
      frontendVersionState.version = String(data.version);
      frontendVersionState.shellVersion = String(data.shellVersion);
      tabs.forEach(function (item) { if (!item.frontendVersion) item.frontendVersion = frontendVersionState.version; });
      return;
    }
    if (String(data.shellVersion) !== frontendVersionState.shellVersion) {
      frontendVersionState.pendingShellVersion = String(data.shellVersion);
      frontendVersionState.pendingVersion = String(data.version);
      attemptPendingFrontendUpdate();
      return;
    }
    if (String(data.version) !== frontendVersionState.version) {
      frontendVersionState.version = String(data.version);
      tabs.forEach(function (item) {
        if (!item.frame || !item.frame.isConnected) { item.frontendVersion = frontendVersionState.version; item.staleVersion = ''; return; }
        if (item.frontendVersion !== frontendVersionState.version) item.staleVersion = frontendVersionState.version;
      });
    }
    attemptPendingFrontendUpdate();
  }
  function checkFrontendVersion(force) {
    var now = Date.now();
    if (frontendVersionState.checking || !force && now - frontendVersionState.lastCheckAt < 5000) { attemptPendingFrontendUpdate(); return; }
    frontendVersionState.checking = true;
    frontendVersionState.lastCheckAt = now;
    fetch('/api/system/frontend-version', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }).then(function (response) {
      if (response.status === 401) {
        location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash));
        return null;
      }
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    }).then(function (data) { if (data) acceptFrontendVersion(data); }).catch(function () {
      // 版本检查失败不影响业务操作，下次聚焦窗口或定时检查会自动重试。
    }).finally(function () { frontendVersionState.checking = false; });
  }
  function startFrontendVersionWatch() {
    checkFrontendVersion(true);
    if (!frontendVersionState.timer) frontendVersionState.timer = window.setInterval(function () { checkFrontendVersion(false); }, 45000);
    window.addEventListener('focus', function () { checkFrontendVersion(false); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkFrontendVersion(false); });
  }
  function updateMenu(path) {
    if (!navEl) return;
    navEl.querySelectorAll('a.menu-item').forEach(function (link) {
      var linkPath = '';
      try { linkPath = new URL(link.href, location.origin).pathname.toLowerCase(); } catch (error) {}
      link.classList.toggle('active', linkPath === path);
    });
  }
  function renderTabs() {
    tabsEl.innerHTML = tabs.map(function (item) {
      return '<button type="button" class="workspace-tab' + (item.key === activeKey ? ' active' : '') + '" data-key="' + encodeURIComponent(item.key) + '" aria-label="' + item.title.replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; }) + '">' +
        '<span class="workspace-tab-label">' + item.title.replace(/[&<>]/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;' })[c]; }) + '</span>' +
        (tabs.length > 1 ? '<span class="workspace-tab-close" data-close="1" aria-label="关闭页签">×</span>' : '') + '</button>';
    }).join('');
  }
  function ensureFrameLoading() {
    if (frameLoadingEl && frameLoadingEl.isConnected) return frameLoadingEl;
    var box = document.createElement('div');
    box.className = 'workspace-frame-loading';
    box.hidden = true;
    var text = document.createElement('span');
    text.textContent = '正在打开页面…';
    box.appendChild(text);
    deckEl.appendChild(box);
    frameLoadingEl = box;
    return box;
  }
  function showFrameLoading(title) {
    var box = ensureFrameLoading();
    var text = box.querySelector('span');
    if (text) text.textContent = '正在打开' + (title ? '「' + title + '」' : '页面') + '…';
    box.hidden = false;
  }
  function hideFrameLoading() {
    if (frameLoadingEl) frameLoadingEl.hidden = true;
  }
  function revealFrame(item) {
    if (!item || !item.frame || !item.frame.isConnected || item.key !== activeKey) return;
    tabs.forEach(function (tab) {
      if (tab.frame && tab.frame.isConnected) tab.frame.hidden = tab.key !== activeKey;
    });
    item.frame.hidden = false;
    hideFrameLoading();
    try { if (item.frame.contentWindow) item.frame.contentWindow.postMessage({ type: 'wyerp-workspace-activated', route: item.route }, location.origin); } catch (error) {}
  }
  function ensureFrame(item) {
    if (item.frame && item.frame.isConnected) return item.frame;
    var frame = document.createElement('iframe');
    frame.className = 'workspace-frame';
    frame.name = 'wyerp-' + item.key.replace(/[^a-z0-9]+/g, '-');
    frame.setAttribute('aria-label', item.title);
    frame.removeAttribute('title');
    item.loading = true;
    item.ready = false;
    item.loadingVersion = frontendVersionState.version || item.frontendVersion || '';
    frame.addEventListener('load', function () {
      item.loading = false;
      if (item.loadingVersion) item.frontendVersion = item.loadingVersion;
      item.loadingVersion = '';
      if (!item.ready) item.ready = true;
      try {
        var current = new URL(frame.contentWindow.location.href);
        if (current.origin === location.origin && current.pathname === '/login.html') {
          var next = '/workspace.html?open=' + encodeURIComponent(item.route);
          location.replace('/login.html?next=' + encodeURIComponent(next));
        }
        if (item.key === activeKey) revealFrame(item);
        attemptPendingFrontendUpdate();
      } catch (error) {}
    });
    frame.src = embeddedRoute(item.route);
    frame.hidden = true;
    deckEl.appendChild(frame);
    item.frame = frame;
    return frame;
  }
  function navigateFrame(item, targetVersion) {
    if (!item.frame) return;
    item.loading = true;
    item.ready = false;
    item.loadingVersion = targetVersion || frontendVersionState.version || item.frontendVersion || '';
    if (item.key === activeKey) {
      item.frame.hidden = true;
      showFrameLoading(item.title);
    }
    item.frame.src = embeddedRoute(item.route);
  }
  function frameRouteChanged(item) {
    // A child can navigate without changing iframe.src. Repair only a finished,
    // mismatched document; switching tabs must not reload a valid editor.
    if (!item.frame || item.loading) return false;
    try {
      var current = new URL(item.frame.contentWindow.location.href);
      if (current.origin !== location.origin || current.pathname === '/login.html') return false;
      return current.searchParams.get('workspace') !== '1' ||
        safeRoute(current.pathname + current.search) !== item.route.split('#')[0];
    } catch (error) { return false; }
  }
  function activate(key, updateHistory) {
    var item = tabs.find(function (tab) { return tab.key === key; });
    if (!item) return;
    if (item.staleVersion && !frameHasPendingWork(item)) refreshFrameForVersion(item, item.staleVersion);
    if (frameRouteChanged(item)) navigateFrame(item);
    activeKey = item.key;
    var activeFrame = ensureFrame(item);
    tabs.forEach(function (tab) { if (tab.frame && tab.frame.isConnected) tab.frame.hidden = true; });
    if (item.ready) revealFrame(item);
    else showFrameLoading(item.title);
    titleEl.textContent = item.title;
    breadcrumbEl.textContent = item.title;
    ['title', 'data-wy-tooltip', 'data-wy-native-title', 'data-ana-tip', 'data-ai-tip', 'data-beans-tip'].forEach(function (name) {
      titleEl.removeAttribute(name);
      breadcrumbEl.removeAttribute(name);
    });
    document.title = item.title + ' - 网研ERP';
    updateMenu(item.key);
    renderTabs();
    save();
    if (updateHistory !== false) history.replaceState(null, '', '/workspace.html?open=' + encodeURIComponent(item.route));
    checkFrontendVersion(false);
  }
  function open(route, title) {
    route = safeRoute(route);
    var key = routeKey(route);
    var bugSource = rememberBugSource(key);
    var item = tabs.find(function (tab) { return tab.key === key; });
    if (!item) {
      item = { key: key, route: route, title: cleanText(title) || menuLabel(route), frame: null };
      tabs.push(item);
    } else if (item.route !== route) {
      item.route = route;
      navigateFrame(item);
    }
    if (cleanText(title) && cleanText(title).length <= 24) item.title = cleanText(title);
    activate(key, true);
    if (bugSource && item.frame && item.frame.contentWindow) {
      item.frame.contentWindow.postMessage({ type: 'wyerp-bug-source', route: bugSource }, location.origin);
    }
  }
  function close(key) {
    var index = tabs.findIndex(function (tab) { return tab.key === key; });
    if (index < 0 || tabs.length <= 1) return;
    var item = tabs[index];
    if (frameIsSyncing(item.frame) && !confirm('该功能仍有同步任务正在运行，关闭页签会停止后续同步。确定关闭吗？')) return;
    if (item.frame && item.frame.parentNode) item.frame.parentNode.removeChild(item.frame);
    tabs.splice(index, 1);
    if (activeKey === key) {
      var next = tabs[Math.min(index, tabs.length - 1)];
      activate(next.key, true);
    } else { renderTabs(); save(); }
  }

  function loadMembershipLabel() {
    if (!memberBtn) return;
    fetch('/api/membership/current', { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function (response) {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    }).then(function (payload) {
      var label = memberBtn.querySelector('.header-quick-label');
      var remaining = memberBtn.querySelector('.header-member-remaining');
      var membership = payload && payload.membership;
      if (label) label.textContent = membership && membership.label || '尚未开通会员';
      if (remaining) {
        var days = membership && membership.remainingDays;
        remaining.hidden = !(Number.isInteger(days) && days >= 0);
        remaining.textContent = remaining.hidden ? '' : '剩余 ' + days + ' 天';
      }
    }).catch(function () {
      var label = memberBtn.querySelector('.header-quick-label');
      if (label) label.textContent = '会员状态读取失败';
      var remaining = memberBtn.querySelector('.header-member-remaining');
      if (remaining) { remaining.hidden = true; remaining.textContent = ''; }
    });
  }

  function startWorkspace() {
    loadSaved();
    var requested = safeRoute(new URLSearchParams(location.search).get('open') || '/index.html');
    var requestedKey = routeKey(requested);
    var requestedItem = tabs.find(function (item) { return item.key === requestedKey; });
    if (!requestedItem) tabs.push({ key: requestedKey, route: requested, title: menuLabel(requested), frame: null });
    else requestedItem.route = requested;
    activeKey = requestedKey;
    activate(activeKey, false);
    loadMembershipLabel();
    startFrontendVersionWatch();

    tabsEl.addEventListener('click', function (event) {
      var tab = event.target.closest('.workspace-tab');
      if (!tab) return;
      var key = decodeURIComponent(tab.getAttribute('data-key') || '');
      if (event.target.closest('[data-close]')) close(key);
      else activate(key, true);
    });
    if (memberBtn) memberBtn.addEventListener('click', function () { open('/pages/membership.html', '会员中心'); });
    if (beanBtn) beanBtn.addEventListener('click', function () { open('/pages/ai-beans.html', 'AI豆管理'); });
    if (navEl) navEl.addEventListener('click', function (event) {
      var link = event.target.closest('a.menu-item');
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (link.target === '_blank' || link.dataset.external === '1') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      open(link.href, cleanText(link.textContent));
    }, true);
    window.addEventListener('message', function (event) {
      if (event.origin !== location.origin || !event.data) return;
      var item = tabs.find(function (tab) { return tab.frame && tab.frame.contentWindow === event.source; });
      if (!item) return;
      if (event.data.type === 'wyerp-workspace-open') open(event.data.route, event.data.title);
      if (event.data.type === 'wyerp-workspace-frame-ready') {
        if (safeRoute(event.data.route).split('#')[0] !== item.route.split('#')[0]) return;
        item.ready = true;
        if (item.key === activeKey) revealFrame(item);
      }
      if (event.data.type === 'wyerp-workspace-route-replace') {
        var replacement = safeRoute(event.data.route);
        if (routeKey(replacement) === item.key) {
          item.route = replacement;
          save();
          if (item.key === activeKey) history.replaceState(null, '', '/workspace.html?open=' + encodeURIComponent(item.route));
        }
      }
      if (event.data.type === 'wyerp-workspace-product-close' && item.key === '/pages/product-detail.html') {
        open('/pages/goods-online.html', '在线商品');
        if (event.data.queueTaskId) {
          var taskTab = tabs.find(function (tab) { return tab.key === '/pages/task-center.html'; });
          if (taskTab && taskTab.frame) taskTab.frame.contentWindow.postMessage({ type: 'wyerp-product-edit-queued' }, location.origin);
        }
        close(item.key);
      }
      if (event.data.type === 'wyerp-workspace-ready') {
        // Ignore ready messages from a previous product/mode or a nested frame.
        if (safeRoute(event.data.route).split('#')[0] !== item.route.split('#')[0]) return;
        item.ready = true;
        if (item.key === activeKey) revealFrame(item);
        var title = cleanText(event.data.title);
        if (item && title && title.length <= 24) {
          item.title = title;
          item.frame.setAttribute('aria-label', title);
          item.frame.removeAttribute('title');
          if (item.key === activeKey) { titleEl.textContent = title; breadcrumbEl.textContent = title; document.title = title + ' - 网研ERP'; }
          renderTabs(); save();
        }
      }
    });
    new MutationObserver(function () {
      tabs.forEach(function (item) {
        try {
          if (item.frame && item.frame.contentDocument && item.frame.contentDocument.body) {
            var frameDark = document.body.classList.contains('theme-dark');
            item.frame.contentDocument.documentElement.classList.toggle('theme-dark', frameDark);
            item.frame.contentDocument.body.classList.toggle('theme-dark', frameDark);
          }
        } catch (error) {}
      });
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  if (window.erpStorage && typeof window.erpStorage.init === 'function') {
    window.erpStorage.init([]).then(startWorkspace).catch(startWorkspace);
  } else startWorkspace();
})();
