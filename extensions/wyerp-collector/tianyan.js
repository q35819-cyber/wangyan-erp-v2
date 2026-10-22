/* 网研ERP · 天眼 toggle + inject loader (content script, ISOLATED world)
 *   1. 动态加载 inject.js 到 MAIN world，等 onload 后再插 toggle
 *   2. SPA 路由 hook（pushState/replaceState）+ popstate + DOM 观察
 *   3. 锚点查找：100ms × 30 次重试 + MutationObserver
 */
(function(){
  'use strict';
  if (window.__wyerp_skyeye_toggle_injected) return;
  window.__wyerp_skyeye_toggle_injected = true;

  var chrome = window.chrome;
  var active = false;
  var loading = false;
  var slotEl = null;
  var observer = null;
  var retryTimer = null;
  var injectReady = false;
  var injectLoading = false;
  var injectWaiters = [];
  var lastError = '';
  var yesterdayCacheTimer = null;
  var yesterdayCacheStatus = '';
  var yesterdayCacheLastSignature = '';
  var yesterdayApiBusy = false;

  // ========== 第一步：稳定加载 inject.js ==========
  function finishInjectLoad(ok) {
    injectLoading = false;
    injectReady = ok === true;
    var waiters = injectWaiters.splice(0);
    waiters.forEach(function(cb) { try { cb(injectReady); } catch (_) {} });
  }

  function loadInject(cb) {
    if (injectReady) { cb && cb(true); return; }
    if (cb) injectWaiters.push(cb);
    if (injectLoading) return;
    injectLoading = true;

    if (!chrome || !chrome.runtime || !chrome.runtime.getURL) {
      console.warn('[网研ERP 天眼] chrome.runtime 不可用');
      finishInjectLoad(false);
      return;
    }

    var existing = document.getElementById('wyerp-inject-script');
    if (existing && existing.dataset.loaded === '1') {
      finishInjectLoad(true);
      return;
    }
    if (existing) {
      try { existing.remove(); } catch (_) {}
    }

    try {
      var url = chrome.runtime.getURL('inject.js');
      if (!url) {
        console.warn('[网研ERP 天眼] getURL 返回空');
        finishInjectLoad(false);
        return;
      }
      var script = document.createElement('script');
      script.id = 'wyerp-inject-script';
      script.type = 'text/javascript';
      script.src = url;
      var settled = false;
      var loadTimer = setTimeout(function() {
        if (settled) return;
        settled = true;
        console.warn('[网研ERP 天眼] inject.js 加载超时');
        finishInjectLoad(false);
      }, 4000);
      script.onload = function() {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        script.dataset.loaded = '1';
        console.log('[网研ERP 天眼] inject.js 加载成功');
        finishInjectLoad(true);
      };
      script.onerror = function() {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        console.error('[网研ERP 天眼] inject.js 加载失败');
        finishInjectLoad(false);
      };
      (document.head || document.documentElement).appendChild(script);
    } catch (e) {
      console.error('[网研ERP 天眼] 加载 inject.js 异常:', e);
      finishInjectLoad(false);
    }
  }

  // ========== 第二步：找锚点 ==========
  function findAnchor() {
    var buttons = document.querySelectorAll('button[type="button"]');
    var updateBtn = null, prevBtn = null;
    for (var i = 0; i < buttons.length; i++) {
      var txt = (buttons[i].textContent || '').trim();
      if (!updateBtn && txt.indexOf('更新版本') >= 0) updateBtn = buttons[i];
      else if (!prevBtn && txt.indexOf('前一版本') >= 0) prevBtn = buttons[i];
      if (updateBtn && prevBtn) break;
    }
    if (!updateBtn) return null;
    if (prevBtn) {
      var p = updateBtn.parentElement;
      while (p && !p.contains(prevBtn)) p = p.parentElement;
      if (p && p.parentElement instanceof HTMLElement) return p.parentElement;
    }
    var parent = updateBtn.parentElement;
    return parent && parent.parentElement instanceof HTMLElement ? parent.parentElement : null;
  }

  // ========== 第三步：创建 slot + toggle ==========
  function createSlot() {
    if (slotEl && document.body.contains(slotEl)) return true;
    var anchor = findAnchor();
    if (!anchor) return false;
    slotEl = document.createElement('div');
    slotEl.id = 'wyerp-skyeye-toolbar-slot';
    slotEl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:12px;height:44px;padding:0 20px;background:#fff;border:1px solid #ebeef5;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.06);box-sizing:border-box;';
    anchor.appendChild(slotEl);
    renderToggle();
    return true;
  }

  function renderToggle() {
    if (!slotEl) return;
    slotEl.replaceChildren();

    var logo = document.createElement('span');
    logo.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;height:18px;font-size:13px;font-weight:700;color:#2563EB;letter-spacing:-.5px;flex-shrink:0;';
    logo.textContent = '网研ERP';

    var label = document.createElement('span');
    label.style.cssText = 'font-size:14px;line-height:1;color:#1d2129;white-space:nowrap;font-weight:500;';
    var activeLabel = yesterdayCacheStatus ? ('天眼已开启 · ' + yesterdayCacheStatus) : '天眼已开启';
    label.textContent = loading ? '正在开启天眼…' : (active ? activeLabel : (lastError ? '开启失败，点击重试' : '开启天眼'));

    var switchWrap = document.createElement('label');
    switchWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;width:36px;height:20px;cursor:pointer;flex-shrink:0;';
    switchWrap.setAttribute('role', 'switch');
    switchWrap.setAttribute('aria-checked', active ? 'true' : 'false');
    switchWrap.innerHTML = '<input type="checkbox" style="opacity:0;width:0;height:0;position:absolute;">' +
      '<span style="position:absolute;inset:0;background:' + (active ? '#22c55e' : '#c0c4cc') + ';border-radius:20px;transition:background .2s ease;"></span>' +
      '<span style="position:absolute;top:2px;left:' + (active ? '18px' : '2px') + ';width:16px;height:16px;background:#fff;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:left .2s ease;"></span>';

    if (loading) switchWrap.style.opacity = '0.6';

    switchWrap.addEventListener('click', function(e) {
      e.preventDefault();
      toggleSkyEye();
    });

    slotEl.appendChild(logo);
    slotEl.appendChild(label);
    slotEl.appendChild(switchWrap);
  }

  // ========== 第四步：toggle 触发补丁 ==========
  function toggleSkyEye() {
    if (loading || active) return;
    loading = true;
    lastError = '';
    renderToggle();

    loadInject(function(ready) {
      if (!ready) {
        loading = false;
        active = false;
        lastError = '注入脚本加载失败';
        renderToggle();
        return;
      }

      var requestId = Date.now() + '-' + Math.random();
      var responded = false;
      var timeout = setTimeout(function() {
        if (responded) return;
        responded = true;
        loading = false;
        active = false;
        lastError = '开启超时，请重试';
        window.removeEventListener('message', onMsg);
        console.warn('[网研ERP 天眼] 开启超时（10秒）');
        renderToggle();
      }, 10000);

      function onMsg(ev) {
        if (ev.source !== window) return;
        var data = ev.data;
        if (!data || data.type !== 'wyerp-skyeye-page' || data.requestId !== requestId) return;
        responded = true;
        clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        loading = false;
        if (data.success) {
          active = true;
          lastError = '';
          console.log('[网研ERP 天眼] 补丁成功' + (data.skipped ? '（已是 Premium）' : ''));
          setTimeout(switchToYesterdayAndCache, 1200);
        } else {
          active = false;
          lastError = String(data.error || '开启失败');
          console.warn('[网研ERP 天眼] 补丁失败:', data.error);
        }
        renderToggle();
      }

      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'wyerp-skyeye-chore', detail: { type: 'WyerpApplySkyEyePremium', requestId: requestId } }, '*');
    });
  }

  function findYesterdayControl() {
    var candidates = Array.from(document.querySelectorAll('button,[role="button"],a,label,span,div'));
    var exact = candidates.filter(function(el) {
      if (cleanCellText(el.textContent) !== '昨天') return false;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (_) { return false; }
      return rect && rect.width > 0 && rect.height > 0;
    });
    exact.sort(function(a, b) {
      var ar = a.getBoundingClientRect();
      var br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });
    if (!exact.length) return null;

    var el = exact[0];
    var clickable = el.closest && el.closest('button,[role="button"],a,label');
    if (clickable) return clickable;

    var current = el;
    for (var depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      try {
        var text = cleanCellText(current.textContent);
        var rect = current.getBoundingClientRect();
        var style = window.getComputedStyle ? window.getComputedStyle(current) : null;
        if (text === '昨天' && rect.width > 0 && rect.height > 0 &&
            (current.tabIndex >= 0 || (style && style.cursor === 'pointer') || typeof current.onclick === 'function')) {
          return current;
        }
      } catch (_) {}
    }
    return el;
  }

  function clickYesterdayControl(control) {
    if (!control) return false;
    try {
      if (typeof control.focus === 'function') control.focus({ preventScroll: true });
    } catch (_) {}
    try {
      control.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      control.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      control.click();
      return true;
    } catch (error) {
      console.warn('[网研ERP 天眼] 点击“昨天”失败:', error);
      return false;
    }
  }

  function switchToYesterdayAndCache() {
    if (!active || !isAnalyticsPage()) return;

    var expectedDate = moscowDateTextLocal(-1);
    var finished = false;
    var pollTimer = null;
    var clickTimer = null;
    var failTimer = null;
    var lastClickAt = 0;

    function cleanup() {
      if (pollTimer) clearInterval(pollTimer);
      if (clickTimer) clearInterval(clickTimer);
      if (failTimer) clearTimeout(failTimer);
      window.removeEventListener('message', onPassiveCapture);
    }

    function completeSwitch() {
      if (finished) return;
      finished = true;
      cleanup();
      yesterdayCacheStatus = '已切换昨天';
      renderToggle();
      setTimeout(requestYesterdayAnalyticsAndCache, 350);
    }

    function onPassiveCapture(ev) {
      if (ev.source !== window) return;
      var data = ev.data;
      if (!data || data.type !== 'wyerp-tianyan-passive-capture' || !data.payload) return;
      var payload = data.payload;
      var path = String(payload.path || '');
      if (!/\/api\/site\/seller-analytics\/charts\/(?:graph|table)$/.test(path)) return;
      var request = payload.request && typeof payload.request === 'object' ? payload.request : {};
      var dateFrom = String(request.date_from || request.dateFrom || '');
      var dateTo = String(request.date_to || request.dateTo || '');
      if (dateFrom.slice(0, 10) === expectedDate && dateTo.slice(0, 10) === expectedDate) {
        console.log('[网研ERP 天眼] 已确认 Ozon 切换到昨天:', expectedDate, path);
        completeSwitch();
      }
    }

    if (isYesterdayPreset()) {
      completeSwitch();
      return;
    }

    yesterdayCacheStatus = '正在切换昨天';
    renderToggle();
    window.addEventListener('message', onPassiveCapture);

    function tryClickYesterday() {
      if (finished || isYesterdayPreset()) {
        if (isYesterdayPreset()) completeSwitch();
        return;
      }
      var now = Date.now();
      if (now - lastClickAt < 650) return;
      var control = findYesterdayControl();
      if (!control) return;
      if (clickYesterdayControl(control)) lastClickAt = now;
    }

    tryClickYesterday();
    clickTimer = setInterval(tryClickYesterday, 250);
    pollTimer = setInterval(function() {
      if (isYesterdayPreset()) completeSwitch();
    }, 200);

    failTimer = setTimeout(function() {
      if (finished) return;
      finished = true;
      cleanup();
      yesterdayCacheStatus = '昨天切换失败';
      console.warn('[网研ERP 天眼] 等待 Ozon 切换到昨天超时');
      renderToggle();
    }, 8000);
  }

  function detectCurrentSellerStoreId() {
    try {
      var api = globalThis.WySellerBinding;
      var candidate = api && typeof api.detectStoreId === 'function' ? String(api.detectStoreId(document) || '').trim() : '';
      return /^[1-9]\d{2,19}$/.test(candidate) ? candidate : 'unknown';
    } catch (_) { return 'unknown'; }
  }

  function requestYesterdayAnalyticsAndCache() {
    if (!active || yesterdayApiBusy || !isAnalyticsPage()) return;
    yesterdayApiBusy = true;
    if (yesterdayCacheTimer) {
      clearTimeout(yesterdayCacheTimer);
      yesterdayCacheTimer = null;
    }
    yesterdayCacheStatus = '正在缓存昨天';
    renderToggle();

    var requestId = 'yesterday-' + Date.now() + '-' + Math.random();
    var finished = false;
    var timeout = setTimeout(function() {
      if (finished) return;
      finished = true;
      yesterdayApiBusy = false;
      window.removeEventListener('message', onYesterdayData);
      yesterdayCacheStatus = '昨天缓存超时';
      console.warn('[网研ERP 天眼] 昨天全量数据读取超时');
      renderToggle();
    }, 45000);

    function onYesterdayData(ev) {
      if (ev.source !== window) return;
      var data = ev.data;
      if (!data || data.type !== 'wyerp-skyeye-yesterday-data' || data.requestId !== requestId) return;
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      window.removeEventListener('message', onYesterdayData);

      if (!data.success || !data.payload) {
        yesterdayApiBusy = false;
        var readError = String(data.error || '未知错误').slice(0, 80);
        yesterdayCacheStatus = '昨天缓存失败：' + readError;
        console.warn('[网研ERP 天眼] 昨天全量数据读取失败:', data.error);
        renderToggle();
        return;
      }

      var payload = data.payload;
      var detectedShopId = detectCurrentSellerStoreId();
      if (detectedShopId !== 'unknown') payload.shopId = detectedShopId;
      var rowCount = Array.isArray(payload.rows) ? payload.rows.length : 0;
      var totalCount = Number(payload.totalCount);
      if (Number.isFinite(totalCount) && totalCount > rowCount) {
        yesterdayApiBusy = false;
        yesterdayCacheStatus = '昨天缓存不完整';
        console.warn('[网研ERP 天眼] 昨天数据不完整:', rowCount, '/', totalCount);
        renderToggle();
        return;
      }

      yesterdayCacheStatus = '昨天缓存写入中';
      renderToggle();
      chrome.runtime.sendMessage({ type: 'wyerp-tianyan-cache-yesterday', payload: payload }, function(response) {
        var runtimeError = chrome.runtime.lastError;
        yesterdayApiBusy = false;
        if (runtimeError || !response || response.ok !== true) {
          var writeError = String(runtimeError && runtimeError.message || response && response.message || 'unknown').slice(0, 80);
          yesterdayCacheStatus = '昨天缓存失败：' + writeError;
          console.warn('[网研ERP 天眼] 昨天缓存写入失败:', writeError);
          renderToggle();
          return;
        }
        var savedCount = Number(response.status && response.status.rowCount || rowCount);
        yesterdayCacheStatus = '昨天已缓存 ' + savedCount + ' 条';
        console.log('[网研ERP 天眼] 昨天全量缓存完成:', savedCount, '条');
        renderToggle();
      });
    }

    window.addEventListener('message', onYesterdayData);
    window.postMessage({
      type: 'wyerp-skyeye-chore',
      detail: { type: 'WyerpFetchYesterdayAnalytics', requestId: requestId }
    }, '*');
  }

  function runNativeAnalyticsDiagnosticOnce() {
    if (!isAnalyticsPage()) return;
    var mark = 'wyerp_tianyan_native_diag_v1';
    try { if (sessionStorage.getItem(mark)) return; sessionStorage.setItem(mark, '1'); } catch (_) {}
    setTimeout(function() {
      try {
        chrome.runtime.sendMessage({ type: 'fetch-ozon-native-analytics' }, function(resp) {
          var err = chrome.runtime.lastError;
          var record = { at: new Date().toISOString(), page: location.href, ok: !err && !!resp, error: err ? String(err.message || err) : '', response: resp || null };
          try { chrome.storage.local.set({ wyerp_tianyan_diagnostic_last: record }); } catch (_) {}
        });
      } catch (error) {
        try { chrome.storage.local.set({ wyerp_tianyan_diagnostic_last: { at: new Date().toISOString(), page: location.href, ok: false, error: String(error && error.message || error), response: null } }); } catch (_) {}
      }
    }, 1500);
  }



  function moscowDateTextLocal(offsetDays) {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var map = {};
    parts.forEach(function(item) { map[item.type] = item.value; });
    var date = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day)));
    date.setUTCDate(date.getUTCDate() + Number(offsetDays || 0));
    return date.toISOString().slice(0, 10);
  }

  function isYesterdayPreset() {
    try { return new URL(location.href).searchParams.get('datePreset') === 'yesterday'; }
    catch (_) { return false; }
  }

  function cleanCellText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, 500);
  }

  function resolveHeaderKey(text, headerMap) {
    var clean = cleanCellText(text);
    if (headerMap[clean]) return headerMap[clean];
    var labels = Object.keys(headerMap).filter(function(label) { return label !== '商品'; }).sort(function(a, b) { return b.length - a.length; });
    for (var i = 0; i < labels.length; i += 1) {
      var label = labels[i];
      if (clean.indexOf(label) >= 0 && clean.length <= label.length + 80) return headerMap[label];
    }
    return '';
  }

  function semanticTableMatrices() {
    var selectors = 'table,[role="table"],[role="grid"],[role="treegrid"]';
    var rowSelector = 'tr,[role="row"]';
    var cellSelector = 'th,td,[role="columnheader"],[role="cell"],[role="gridcell"],[role="rowheader"]';
    var tables = Array.from(document.querySelectorAll(selectors));
    if (!tables.length) tables = [document.body];
    return tables.map(function(table) {
      var rows = Array.from(table.querySelectorAll(rowSelector)).slice(0, 2000);
      return rows.map(function(row) {
        return Array.from(row.querySelectorAll(cellSelector))
          .filter(function(cell) {
            var owner = cell.closest(rowSelector);
            return !owner || owner === row;
          })
          .map(function(cell) { return cleanCellText(cell.textContent); })
          .filter(function(text) { return text !== ''; });
      }).filter(function(row) { return row.length; });
    }).filter(function(matrix) { return matrix.length; });
  }


  function geometryTableCandidate(headerMap, advancedKeys) {
    var entries = [];
    var elements = Array.from(document.querySelectorAll('div,span,a,td,th,button')).slice(0, 30000);
    elements.forEach(function(el) {
      var text = cleanCellText(el.textContent);
      if (!text || text.length > 500) return;
      var interesting = Boolean(resolveHeaderKey(text, headerMap)) || /货号\s*[^\s]+/i.test(text) || /^[\d\s.,%₽+\-]+$/.test(text);
      if (!interesting) return;
      var rect;
      try { rect = el.getBoundingClientRect(); } catch (_) { return; }
      if (!rect || rect.width < 1 || rect.height < 1 || rect.width > 900 || rect.height > 120) return;
      entries.push({
        text: text,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2,
        area: rect.width * rect.height
      });
    });

    var headerEntries = entries.filter(function(entry) { return Boolean(resolveHeaderKey(entry.text, headerMap)); });
    if (!headerEntries.length) return null;
    headerEntries.sort(function(a, b) { return a.top - b.top || a.left - b.left; });

    var clusters = [];
    headerEntries.forEach(function(entry) {
      var cluster = clusters.find(function(item) { return Math.abs(item.top - entry.top) <= 12; });
      if (!cluster) {
        cluster = { top: entry.top, entries: [] };
        clusters.push(cluster);
      }
      cluster.entries.push(entry);
    });

    var headerCluster = null;
    var bestScore = -1;
    clusters.forEach(function(cluster) {
      var byKey = new Map();
      cluster.entries.forEach(function(entry) {
        var key = resolveHeaderKey(entry.text, headerMap);
        var existing = byKey.get(key);
        if (!existing || entry.area < existing.area) byKey.set(key, entry);
      });
      var keys = Array.from(byKey.keys());
      var advancedCount = keys.filter(function(key) { return advancedKeys.has(key); }).length;
      if (keys.length < 5 || !advancedCount) return;
      var score = keys.length * 100 + advancedCount * 10;
      if (score > bestScore) {
        bestScore = score;
        headerCluster = Array.from(byKey.values()).sort(function(a, b) { return a.left - b.left; });
      }
    });
    if (!headerCluster) return null;

    var headers = headerCluster.map(function(entry) { return entry.text; });
    var normalized = headers.map(function(text) { return headerMap[text] || text; });
    var centers = headerCluster.map(function(entry) { return entry.cx; });
    var bounds = centers.map(function(center, index) {
      var left = index === 0 ? -Infinity : (centers[index - 1] + center) / 2;
      var right = index === centers.length - 1 ? Infinity : (center + centers[index + 1]) / 2;
      return [left, right];
    });
    var headerTop = Math.min.apply(null, headerCluster.map(function(entry) { return entry.top; }));

    var products = entries.filter(function(entry) {
      return /货号\s*[^\s]+/i.test(entry.text) && entry.top > headerTop + 8;
    }).sort(function(a, b) {
      return a.top - b.top || a.area - b.area;
    });

    var uniqueProducts = [];
    products.forEach(function(entry) {
      var skuMatch = entry.text.match(/货号\s*([^\s]+)/i);
      var sku = skuMatch ? cleanCellText(skuMatch[1]) : '';
      if (!sku) return;
      var duplicate = uniqueProducts.some(function(existing) {
        return existing.sku === sku && Math.abs(existing.entry.cy - entry.cy) <= 10;
      });
      if (!duplicate) uniqueProducts.push({ sku: sku, entry: entry });
    });

    var rows = [];
    uniqueProducts.forEach(function(item) {
      var productEntry = item.entry;
      var raw = [];
      var values = {};
      headerCluster.forEach(function(headerEntry, index) {
        var value = '';
        if (normalized[index] === 'product') {
          value = productEntry.text;
        } else {
          var range = bounds[index];
          var candidates = entries.filter(function(entry) {
            if (resolveHeaderKey(entry.text, headerMap)) return false;
            if (/货号\s*[^\s]+/i.test(entry.text)) return false;
            return entry.cx >= range[0] && entry.cx < range[1] &&
              Math.abs(entry.cy - productEntry.cy) <= Math.max(20, productEntry.height * 0.7);
          }).sort(function(a, b) { return a.area - b.area; });
          value = candidates.length ? candidates[0].text : '';
        }
        raw.push(value);
        values[normalized[index]] = value;
      });
      rows.push({
        sku: item.sku,
        product: productEntry.text,
        values: values,
        raw: raw
      });
    });

    return rows.length ? { headers: headers, normalized: normalized, rows: rows.slice(0, 1500) } : null;
  }

  function collectYesterdaySnapshot() {
    if (!isYesterdayPreset()) return null;
    var headerMap = {
      '商品': 'product',
      '订购商品数量': 'ordered_units',
      '订购金额': 'revenue',
      '唯一身份访问者，总计': 'unique_visitors_total',
      '查看过商品卡片的唯一身份访问者': 'card_unique_visitors',
      '从商品卡片到购物车的转化率': 'card_to_cart_conversion',
      '商品已取消': 'cancellations',
      '商品已退回': 'returns',
      '搜索和目录中的位置': 'position_category',
      '搜索结果和目录中的展示次数': 'search_impressions'
    };
    var advancedKeys = new Set(['unique_visitors_total','card_unique_visitors','card_to_cart_conversion','cancellations','returns','position_category','search_impressions']);
    var best = null;

    semanticTableMatrices().forEach(function(matrix) {
      matrix.forEach(function(row, index) {
        var normalized = row.map(function(text) { return resolveHeaderKey(text, headerMap); });
        var known = normalized.filter(Boolean);
        var advanced = known.filter(function(key) { return advancedKeys.has(key); });
        if (known.length < 5 || !advanced.length) return;
        var score = known.length * 100 + matrix.length;
        if (!best || score > best.score) best = { matrix: matrix, headerIndex: index, headers: row, normalized: normalized, score: score };
      });
    });
    if (!best) {
      var geometry = geometryTableCandidate(headerMap, advancedKeys);
      if (!geometry) return null;
      var geometryYesterday = moscowDateTextLocal(-1);
      return {
        schemaVersion: 1,
        datePreset: 'yesterday',
        dateFrom: geometryYesterday,
        dateTo: geometryYesterday,
        shopId: 'unknown',
        sourceUrl: location.href,
        capturedAt: new Date().toISOString(),
        headers: geometry.headers.slice(0, 40),
        rows: geometry.rows
      };
    }

    var productIndex = best.normalized.indexOf('product');
    if (productIndex < 0) productIndex = 0;
    var rows = [];
    for (var i = best.headerIndex + 1; i < best.matrix.length; i += 1) {
      var raw = best.matrix[i];
      if (!Array.isArray(raw) || !raw.length) continue;
      var product = cleanCellText(raw[productIndex] || '');
      var skuMatch = product.match(/货号\s*([^\s]+)/i);
      if (!skuMatch && !product) continue;
      var values = {};
      best.headers.forEach(function(header, column) {
        var key = best.normalized[column] || cleanCellText(header);
        if (key) values[key] = cleanCellText(raw[column] || '');
      });
      rows.push({
        sku: skuMatch ? cleanCellText(skuMatch[1]) : '',
        product: product,
        values: values,
        raw: raw.slice(0, 40).map(cleanCellText)
      });
      if (rows.length >= 1500) break;
    }
    if (!rows.length) return null;

    var yesterday = moscowDateTextLocal(-1);
    return {
      schemaVersion: 1,
      datePreset: 'yesterday',
      dateFrom: yesterday,
      dateTo: yesterday,
      shopId: 'unknown',
      sourceUrl: location.href,
      capturedAt: new Date().toISOString(),
      headers: best.headers.slice(0, 40),
      rows: rows
    };
  }

  function scheduleYesterdayCache(delayMs, attempt) {
    if (!isYesterdayPreset() || !chrome || !chrome.runtime || !chrome.runtime.sendMessage) return;
    if (yesterdayCacheTimer) clearTimeout(yesterdayCacheTimer);
    var currentAttempt = Number(attempt || 0);
    yesterdayCacheTimer = setTimeout(function() {
      yesterdayCacheTimer = null;
      var snapshot = collectYesterdaySnapshot();
      if (!snapshot) {
        if (currentAttempt < 10) {
          scheduleYesterdayCache(1200, currentAttempt + 1);
        } else {
          yesterdayCacheStatus = '昨天缓存等待表格';
          renderToggle();
        }
        return;
      }
      var signature = snapshot.dateFrom + '|' + snapshot.rows.length + '|' + JSON.stringify(snapshot.headers) + '|' + JSON.stringify(snapshot.rows).length;
      if (signature === yesterdayCacheLastSignature) return;
      yesterdayCacheStatus = '昨天缓存写入中';
      renderToggle();
      chrome.runtime.sendMessage({ type: 'wyerp-tianyan-cache-yesterday', payload: snapshot }, function(response) {
        var err = chrome.runtime.lastError;
        if (err || !response || response.ok !== true) {
          console.warn('[网研ERP 天眼] 昨天缓存写入失败:', err && err.message || response && response.message || 'unknown');
          if (currentAttempt < 10) scheduleYesterdayCache(1500, currentAttempt + 1);
          else { yesterdayCacheStatus = '昨天缓存失败'; renderToggle(); }
          return;
        }
        yesterdayCacheLastSignature = signature;
        yesterdayCacheStatus = '昨天已缓存 ' + Number(response.status && response.status.rowCount || snapshot.rows.length) + ' 条';
        console.log('[网研ERP 天眼] ' + yesterdayCacheStatus);
        renderToggle();
      });
    }, Math.max(0, Number(delayMs || 0)));
  }

  function passiveCaptureShopId(payload) {
    try {
      var nodes = document.querySelectorAll('[data-clipboard-text]');
      for (var i = 0; i < nodes.length; i++) {
        var value = String(nodes[i].getAttribute('data-clipboard-text') || '').trim();
        if (/^[1-9]\d{4,19}$/.test(value)) return value;
      }
    } catch (_) {}
    var candidates = payload && Array.isArray(payload.candidateShopIds) ? payload.candidateShopIds.filter(function(value) { return /^[1-9]\d{2,19}$/.test(String(value || '')); }) : [];
    return candidates.length === 1 ? String(candidates[0]) : 'unknown';
  }

  function storePassiveCapture(payload) {
    if (!payload || typeof payload !== 'object' || !chrome || !chrome.storage || !chrome.storage.local) return;
    var record = {
      schemaVersion: 1,
      shopId: passiveCaptureShopId(payload),
      page: location.href,
      path: String(payload.path || '').slice(0, 200),
      status: Number(payload.status) || 0,
      timestamp: String(payload.timestamp || new Date().toISOString()).slice(0, 60),
      responseSize: Number(payload.responseSize) || 0,
      topKeys: Array.isArray(payload.topKeys) ? payload.topKeys.slice(0, 60).map(String) : [],
      request: payload.request && typeof payload.request === 'object' ? payload.request : null,
      candidateShopIds: Array.isArray(payload.candidateShopIds) ? payload.candidateShopIds.slice(0, 8).map(String) : [],
      knownKeys: Array.isArray(payload.knownKeys) ? payload.knownKeys.slice(0, 40).map(String) : [],
      knownRows: Array.isArray(payload.knownRows) ? payload.knownRows.slice(0, 250) : [],
      requestedMetrics: Array.isArray(payload.requestedMetrics) ? payload.requestedMetrics.slice(0, 40).map(String) : [],
      objectSamples: Array.isArray(payload.objectSamples) ? payload.objectSamples.slice(0, 20) : [],
      fieldPaths: Array.isArray(payload.fieldPaths) ? payload.fieldPaths.slice(0, 500).map(String) : [],
      responseSample: String(payload.responseSample || '').slice(0, 120000)
    };
    chrome.storage.local.get(['wyerp_tianyan_passive_history'], function(existing) {
      var err = chrome.runtime && chrome.runtime.lastError;
      if (err) return;
      var history = Array.isArray(existing && existing.wyerp_tianyan_passive_history) ? existing.wyerp_tianyan_passive_history.slice(-7) : [];
      history.push(record);
      chrome.storage.local.set({
        wyerp_tianyan_passive_latest: record,
        wyerp_tianyan_passive_history: history
      }, function() {
        if (chrome.runtime && chrome.runtime.lastError) return;
        console.log('[网研ERP 天眼] 已被动记录分析响应:', record.path, record.knownKeys.join(', ') || '(待解析)');
      });
    });
  }

  window.addEventListener('message', function(ev) {
    if (ev.source !== window) return;
    var data = ev.data;
    if (!data || data.type !== 'wyerp-tianyan-passive-capture' || !data.payload) return;
    storePassiveCapture(data.payload);
  });


  // ========== ERP分析页按当前时间范围读取天眼 ==========
  function rangeRequestTimeout(dateFrom, dateTo) {
    var start = Date.parse(String(dateFrom || '') + 'T00:00:00Z');
    var end = Date.parse(String(dateTo || '') + 'T00:00:00Z');
    var days = Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.floor((end - start) / 86400000) + 1 : 1;
    if (days <= 1) return 75000;
    if (days <= 7) return 110000;
    return 180000;
  }

  function fetchRangeForErp(input, sendResponse) {
    var dateFrom = String(input && input.dateFrom || '').slice(0, 10);
    var dateTo = String(input && input.dateTo || '').slice(0, 10);
    var clientId = String(input && input.clientId || '').trim();
    if (!isAnalyticsPage()) {
      sendResponse({ ok: false, message: '请保持 Ozon Seller“我的分析”页面打开后重试。' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      sendResponse({ ok: false, message: '天眼日期范围无效。' });
      return;
    }

    var settled = false;
    function finish(result) {
      if (settled) return;
      settled = true;
      try { sendResponse(result); } catch (_) {}
    }

    loadInject(function(ready) {
      if (!ready) {
        finish({ ok: false, message: '天眼页面注入脚本未就绪，请刷新 Ozon“我的分析”页面后重试。' });
        return;
      }

      var patchId = 'range-patch-' + Date.now() + '-' + Math.random();
      var patchTimer = setTimeout(function() {
        window.removeEventListener('message', onPatch);
        finish({ ok: false, message: '开启天眼状态超时，请刷新 Ozon“我的分析”页面后重试。' });
      }, 12000);

      function onPatch(ev) {
        if (ev.source !== window) return;
        var data = ev.data;
        if (!data || data.type !== 'wyerp-skyeye-page' || data.requestId !== patchId) return;
        clearTimeout(patchTimer);
        window.removeEventListener('message', onPatch);
        if (!data.success) {
          finish({ ok: false, message: String(data.error || '当前 Ozon 会话无法开启天眼').slice(0, 240) });
          return;
        }

        active = true;
        lastError = '';
        renderToggle();

        var requestId = 'range-' + Date.now() + '-' + Math.random();
        var timer = setTimeout(function() {
          window.removeEventListener('message', onRangeData);
          finish({ ok: false, message: '读取当前天眼周期超时，请稍后重试。' });
        }, rangeRequestTimeout(dateFrom, dateTo));

        function onRangeData(event) {
          if (event.source !== window) return;
          var result = event.data;
          if (!result || result.type !== 'wyerp-skyeye-range-data' || result.requestId !== requestId) return;
          clearTimeout(timer);
          window.removeEventListener('message', onRangeData);
          if (!result.success || !result.payload) {
            finish({ ok: false, message: String(result.error || '天眼周期读取失败').slice(0, 240) });
            return;
          }
          var payload = result.payload;
          if (/^[1-9]\d{2,19}$/.test(clientId)) payload.shopId = clientId;
          finish({ ok: true, data: payload });
        }

        window.addEventListener('message', onRangeData);
        window.postMessage({
          type: 'wyerp-skyeye-chore',
          detail: { type: 'WyerpFetchRangeAnalytics', requestId: requestId, dateFrom: dateFrom, dateTo: dateTo }
        }, '*');
      }

      window.addEventListener('message', onPatch);
      window.postMessage({
        type: 'wyerp-skyeye-chore',
        detail: { type: 'WyerpApplySkyEyePremium', requestId: patchId }
      }, '*');
    });
  }

  if (chrome && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function(input, sender, sendResponse) {
      if (!input || input.type !== 'wyerp-tianyan-range-fetch') return;
      fetchRangeForErp(input, sendResponse);
      return true;
    });
  }

  // ========== 启动 ==========
  function tryMount(attempt) {
    if (createSlot()) return;
    var n = attempt || 0;
    if (n < 30) {
      retryTimer = setTimeout(function() { tryMount(n + 1); }, 100);
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function(mutations) {
      if (slotEl && Array.isArray(mutations) && mutations.length && mutations.every(function(mutation) {
        return mutation.target === slotEl || slotEl.contains(mutation.target);
      })) return;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(function() { tryMount(0); }, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // SPA 路由 hook：pushState/replaceState 变化时自动 sync
  var _origPush = history.pushState;
  var _origReplace = history.replaceState;
  function hookHistory() {
    if (!history.pushState.__wyerp_hooked) {
      history.pushState = function() {
        var r = _origPush.apply(this, arguments);
        setTimeout(sync, 0);
        return r;
      };
      history.pushState.__wyerp_hooked = true;
    }
    if (!history.replaceState.__wyerp_hooked) {
      history.replaceState = function() {
        var r = _origReplace.apply(this, arguments);
        setTimeout(sync, 0);
        return r;
      };
      history.replaceState.__wyerp_hooked = true;
    }
  }

  function isAnalyticsPage() {
    return /\/app\/analytics\/graphs/.test(location.pathname);
  }

  function sync() {
    if (isAnalyticsPage()) {
      hookHistory();
      tryMount();
      startObserver();
      loadInject();
    } else {
      if (slotEl) { slotEl.remove(); slotEl = null; }
      if (observer) { observer.disconnect(); observer = null; }
    }
  }

  sync();
  setInterval(sync, 2000);
  window.addEventListener('popstate', sync);
})();
