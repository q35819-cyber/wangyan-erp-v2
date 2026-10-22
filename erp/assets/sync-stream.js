/* 网研ERP — 同步结果渐进填充工具 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_SYNC_STREAM = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';

  function defaultSchedule(callback) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
    else setTimeout(callback, 0);
  }

  function each(items, onItem, onPaint, options) {
    var list = Array.isArray(items) ? items : [];
    var settings = options || {};
    var firstRows = Math.max(0, Number(settings.firstRows == null ? 1 : settings.firstRows) || 0);
    var batchSize = Math.max(1, Number(settings.batchSize == null ? 20 : settings.batchSize) || 1);
    var schedule = settings.schedule || defaultSchedule;
    var index = 0;

    return new Promise(function (resolve, reject) {
      function frame() {
        try {
          var count = index < firstRows ? 1 : batchSize;
          var end = Math.min(list.length, index + count);
          while (index < end) {
            onItem(list[index], index, list.length);
            index += 1;
          }
          var painted = onPaint && index ? onPaint(index, list.length) : null;
          Promise.resolve(painted).then(function () {
            if (index >= list.length) { resolve(index); return; }
            schedule(frame);
          }, reject);
        } catch (error) { reject(error); }
      }
      if (!list.length) { resolve(0); return; }
      schedule(frame);
    });
  }

  function createThrottle(options) {
    var settings = options || {};
    var minDelay = Math.max(0, Number(settings.minDelay == null ? 30000 : settings.minDelay) || 0);
    var maxDelay = Math.max(minDelay, Number(settings.maxDelay == null ? 60000 : settings.maxDelay) || minDelay);
    var now = settings.now || Date.now;
    var random = settings.random || Math.random;
    var sleep = settings.sleep || function (milliseconds) {
      return milliseconds ? new Promise(function (resolve) { setTimeout(resolve, milliseconds); }) : Promise.resolve();
    };
    var queue = Promise.resolve();
    var nextAt = 0;

    var pending = 0;

    return function waitTurn(onWait) {
      var gap = minDelay + Math.floor(random() * (maxDelay - minDelay + 1));
      var ahead = pending;
      pending += 1;
      if (typeof onWait === 'function') onWait({ phase: 'queued', ahead: ahead, waitMs: 0 });
      queue = queue.then(function () {
        var wait = Math.max(0, nextAt - now());
        if (typeof onWait === 'function') onWait({ phase: wait > 0 ? 'waiting' : 'ready', ahead: 0, waitMs: wait });
        var timer = null;
        if (wait > 1000 && typeof onWait === 'function' && typeof setInterval === 'function') {
          var startedAt = now();
          timer = setInterval(function () {
            onWait({ phase: 'waiting', ahead: 0, waitMs: Math.max(0, wait - (now() - startedAt)) });
          }, 1000);
        }
        return Promise.resolve(sleep(wait)).then(function () {
          if (timer) clearInterval(timer);
          nextAt = now() + gap;
          pending = Math.max(0, pending - 1);
        }, function (error) {
          if (timer) clearInterval(timer);
          pending = Math.max(0, pending - 1);
          throw error;
        });
      });
      return queue;
    };
  }

  function createThrottlePool(options) {
    var throttles = {};
    return function waitTurn(key, onWait) {
      var normalized = String(key == null ? '' : key);
      if (!throttles[normalized]) throttles[normalized] = createThrottle(options);
      return throttles[normalized](onWait);
    };
  }

  function retryAfterMilliseconds(value, now) {
    if (value == null || String(value).trim() === '') return 0;
    var text = String(value).trim();
    var seconds = Number(text);
    if (isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    var timestamp = Date.parse(text);
    if (!isNaN(timestamp)) return Math.max(0, timestamp - (typeof now === 'function' ? now() : Date.now()));
    return 0;
  }

  function responseHeader(response, name) {
    return response && response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : null;
  }

  function trustedMessage(value) {
    var message = typeof value === 'string' ? value.trim() : '';
    return message.length <= 200 && /[\u3400-\u9fff]/.test(message) && !/[A-Za-z_\\/\r\n]|\b[1-5]\d{2}\b/.test(message)
      ? message : '同步请求未完成，请稍后重试；若持续失败请提交 BUG 反馈。';
  }

  function rateLimitDelay(response, data, attempt, options) {
    var settings = options || {};
    var message = String(data && data.message || '');
    var code = String(data && data.error || '');
    var limited = response && Number(response.status) === 429;
    var circuitOpen = /circle is open|circuit is open|rate.?limit|too many requests|слишком много запросов/i.test(message)
      || /^(?:circuit_open|circle_is_open|rate_limited|ozon_proxy_rate_limited)$/.test(code);
    var transient = response && Number(response.status) >= 500;
    if (!limited && !circuitOpen && !transient) return 0;
    var headerDelay = retryAfterMilliseconds(responseHeader(response, 'Retry-After'), settings.now);
    var bodyDelay = retryAfterMilliseconds(data && (data.retryAfter != null ? data.retryAfter : data.retry_after), settings.now);
    if (headerDelay || bodyDelay) return Math.max(1000, headerDelay || bodyDelay);
    var schedule = settings.backoff || [5000, 10000, 20000, 40000, 60000];
    var index = Math.min(Math.max(0, Number(attempt) || 0), schedule.length - 1);
    return Math.max(1000, Number(schedule[index]) || 5000);
  }

  function countdown(milliseconds, onStage, options) {
    var settings = options || {};
    var sleep = settings.sleep || function (delay) { return new Promise(function (resolve) { setTimeout(resolve, delay); }); };
    var remaining = Math.max(0, Number(milliseconds) || 0);
    function tick() {
      if (typeof onStage === 'function') onStage({ phase: 'backoff', waitMs: remaining, attempt: settings.attempt || 1 });
      if (!remaining) return Promise.resolve();
      var slice = Math.min(1000, remaining);
      return Promise.resolve(sleep(slice)).then(function () { remaining -= slice; return tick(); });
    }
    return tick();
  }

  function requestJsonWithRetry(makeRequest, options) {
    var settings = options || {};
    var maxRetries = Math.max(0, Number(settings.maxRetries == null ? 5 : settings.maxRetries) || 0);
    var attempt = 0;
    function run() {
      return Promise.resolve(makeRequest(attempt)).then(function (response) {
        return response.json().catch(function () { return null; }).then(function (data) {
          if (response.ok) return data;
          var delay = rateLimitDelay(response, data, attempt, settings);
          if (delay && attempt < maxRetries) {
            attempt += 1;
            return countdown(delay, settings.onStage, {
              attempt: attempt,
              sleep: settings.sleep
            }).then(run);
          }
          var message = trustedMessage(data && data.message);
          var error = new Error(message);
          error.status = response.status;
          error.data = data;
          throw error;
        });
      });
    }
    return run();
  }

  function taskPercent(completedTasks, currentRatio, totalTasks) {
    var total = Math.max(1, Number(totalTasks) || 1);
    var completed = Math.max(0, Number(completedTasks) || 0);
    var ratio = Math.max(0, Math.min(1, Number(currentRatio) || 0));
    return Math.max(0, Math.min(100, Math.floor((completed + ratio) / total * 100)));
  }

  var PROGRESS_KEY = 'wyerp_sync_progress_v1';
  var ACTIVE_TTL_MS = 2 * 60 * 1000;
  var DONE_VISIBLE_MS = 10000;
  var progressTimer = null;
  var heartbeatTimer = null;
  var ownedTasks = {};
  var defaultTaskId = '';
  var progressChannel = null;
  var workspaceReconcileTimer = null;
  var workspaceReconcilePending = null;
  var persistTimers = {};
  var pendingPersist = {};

  function emptyRegistry() { return { version: 2, tasks: {} }; }
  function isTerminalStatus(status) { return status === 'done' || status === 'failed'; }

  function normalizeRegistry(value) {
    if (!value || typeof value !== 'object') return emptyRegistry();
    if (value.tasks && typeof value.tasks === 'object') return { version: 2, tasks: value.tasks };
    if (value.status) return { version: 2, tasks: { legacy: value } };
    return emptyRegistry();
  }

  function readProgressState() {
    if (typeof localStorage === 'undefined') return emptyRegistry();
    try {
      return normalizeRegistry(JSON.parse(localStorage.getItem(PROGRESS_KEY) || 'null'));
    } catch (error) { return emptyRegistry(); }
  }

  function cleanRegistry(registry) {
    var now = Date.now();
    Object.keys(registry.tasks).forEach(function (id) {
      var task = registry.tasks[id];
      var age = now - Number(task && task.updatedAt || 0);
      if (!task || (task.status === 'running' ? age > ACTIVE_TTL_MS : age > DONE_VISIBLE_MS)) delete registry.tasks[id];
    });
    return registry;
  }

  function saveLocalRegistry(registry) {
    if (typeof localStorage !== 'undefined') {
      try {
        var serialized = JSON.stringify(registry);
        // 多标签页持有相同进度时绝不重复写 storage，避免广播回声与冗余磁盘操作。
        if (localStorage.getItem(PROGRESS_KEY) !== serialized) localStorage.setItem(PROGRESS_KEY, serialized);
      } catch (error) {}
    }
  }

  function writeProgressState(registry) {
    saveLocalRegistry(registry);
    if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
      try {
        if (!progressChannel) progressChannel = new BroadcastChannel(PROGRESS_KEY);
        progressChannel.postMessage(registry);
      } catch (error) {}
    }
  }

  function mergeProgressState(incoming) {
    var current = readProgressState();
    var other = normalizeRegistry(incoming);
    Object.keys(other.tasks).forEach(function (id) {
      var candidate = other.tasks[id];
      var existing = current.tasks[id];
      // 同一任务的终态不可被跨页晚到的 running 快照复活，否则右下角浮层会反复显示/隐藏。
      if (existing && isTerminalStatus(existing.status) && !isTerminalStatus(candidate && candidate.status)) return;
      // 服务端最终确认失败优先于早到的完成提示；旧标签页的 done 不可覆盖 failed。
      if (existing && existing.status === 'failed' && candidate && candidate.status !== 'failed') return;
      if (existing && existing.status === 'done' && candidate && candidate.status === 'failed') {
        current.tasks[id] = candidate;
        return;
      }
      if (!existing || (isTerminalStatus(candidate && candidate.status) && !isTerminalStatus(existing.status)) || Number(candidate && candidate.updatedAt || 0) >= Number(existing.updatedAt || 0)) current.tasks[id] = candidate;
    });
    cleanRegistry(current);
    saveLocalRegistry(current);
    return current;
  }

  function isActiveProgress(state) {
    var current = cleanRegistry(normalizeRegistry(state || readProgressState()));
    return Object.keys(current.tasks).some(function (id) { return current.tasks[id].status === 'running'; });
  }
  function ensureProgress() {
    if (typeof document === 'undefined') return null;
    // 工作台主窗口统一显示跨页任务浮层；嵌入页继续更新任务状态，不重复绘制。
    try {
      if (root && root.parent && root.parent !== root && root.parent.document &&
          root.parent.document.body && root.parent.document.body.classList.contains('workspace-shell')) return null;
    } catch (error) { /* 跨源 iframe 无法访问父页面时，保留当前页浮层。 */ }
    var element = document.getElementById('erp-sync-progress');
    if (element) return element;
    element = document.createElement('div');
    element.id = 'erp-sync-progress';
    element.innerHTML = '<div class="sync-progress-title">同步任务</div><div class="sync-progress-list"></div>';
    document.body.appendChild(element);
    return element;
  }

  // 单个任务的行和原生进度条必须跨轮询复用，避免每次跨页消息都卸载/重建控件而闪动。
  var progressRows = new Map();
  function paintProgress(registry) {
    var element = ensureProgress();
    if (!element) return;
    clearTimeout(progressTimer);
    var current = cleanRegistry(normalizeRegistry(registry));
    var tasks = Object.keys(current.tasks).map(function (id) { return current.tasks[id]; }).filter(function (task) {
      // 浮层只显示进行中；终态保留在任务中心。
      return task && task.status === 'running';
    }).sort(function (a, b) {
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    }).slice(0, 6);
    var list = element.querySelector('.sync-progress-list');
    if (!tasks.length) {
      element.classList.remove('show');
      if (list.children.length) list.replaceChildren();
      progressRows.clear();
      return;
    }
    var wanted = new Set();
    var rows = [];
    tasks.forEach(function (task) {
      var id = String(task.id);
      var percent = Math.max(0, Math.min(100, Math.floor(Number(task.value) || 0)));
      var labelText = task.label || '正在同步…';
      wanted.add(id);
      var entry = progressRows.get(id);
      if (!entry) {
        var row = document.createElement('div');
        row.className = 'sync-progress-task';
        var head = document.createElement('div');
        head.className = 'sync-progress-head';
        var label = document.createElement('span');
        label.className = 'sync-progress-label';
        var value = document.createElement('span');
        value.className = 'sync-progress-value';
        var progress = document.createElement('progress');
        progress.className = 'erp-progress';
        progress.max = 100;
        progress.setAttribute('aria-label', '同步进度');
        head.append(label, value);
        row.append(head, progress);
        entry = { row: row, label: label, value: value, progress: progress };
        progressRows.set(id, entry);
      }
      if (entry.label.textContent !== labelText) {
        entry.label.textContent = labelText;
        entry.label.title = labelText;
      }
      if (entry.value.textContent !== percent + '%') entry.value.textContent = percent + '%';
      if (entry.progress.value !== percent) entry.progress.value = percent;
      rows.push(entry.row);
    });
    progressRows.forEach(function (entry, id) { if (!wanted.has(id)) progressRows.delete(id); });
    var previousRows = Array.from(list.children);
    var keptRows = previousRows.filter(function (row) { return rows.indexOf(row) >= 0; });
    var addedRows = rows.filter(function (row) { return previousRows.indexOf(row) < 0; });
    // 成员不变时绝不重排；新任务置顶，旧任务的位置在不断更新进度时保持稳定。
    if (addedRows.length || keptRows.length !== previousRows.length) {
      list.replaceChildren.apply(list, addedRows.concat(keptRows));
    }
    element.classList.add('show');
  }

  function reconcileRunningProgress(registry, retry) {
    var current = cleanRegistry(normalizeRegistry(registry || readProgressState()));
    var ids = Object.keys(current.tasks).filter(function (id) { return current.tasks[id] && current.tasks[id].status === 'running'; });
    if (!ids.length || !root) return Promise.resolve(current);
    if (!root.erpStorage || typeof root.erpStorage.request !== 'function') {
      if ((retry || 0) < 5 && typeof setTimeout === 'function') setTimeout(function () { reconcileRunningProgress(current, (retry || 0) + 1); }, 500);
      return Promise.resolve(current);
    }
    return root.erpStorage.request('/api/sync-tasks?limit=100&ids=' + encodeURIComponent(ids.join(',')), { cache: 'no-store' }).then(function (response) {
      if (!response.ok) throw new Error('同步任务状态校准失败，请稍后刷新页面重试。');
      return response.json();
    }).then(function (data) {
      var byId = {};
      (data && data.items || []).forEach(function (task) { if (task && task.id) byId[String(task.id)] = task; });
      // 请求发出后任务可能已在另一个回调/标签页进入终态；旧 running 响应不得覆盖新终态。
      var latestRegistry = cleanRegistry(readProgressState());
      ids.forEach(function (id) {
        var server = byId[id], local = current.tasks[id];
        var latest = latestRegistry.tasks[id];
        if (latest && isTerminalStatus(latest.status)) { current.tasks[id] = latest; return; }
        if (!server || !local) return;
        var children = server.childSummary;
        var state = server.status === 'done' ? 'done' : server.status === 'failed' ? 'failed' : 'running';
        var rawValue = Number(server.value != null ? server.value : local.value) || 0;
        if (children && Number(children.total) > 0) {
          var running = Number(children.running) || 0, failed = Number(children.failed) || 0;
          var done = Number(children.done) || 0, count = Number(children.total);
          state = running > 0 || done + failed < count ? 'running' : failed > 0 ? 'failed' : 'done';
          if (Number.isFinite(Number(children.value))) rawValue = Number(children.value);
        }
        local.status = state;
        local.value = state === 'done' ? 100 : state === 'running' ? Math.min(99, Math.max(0, rawValue)) : Math.max(0, Math.min(100, rawValue));
        local.label = state === 'done' ? '同步完成' : server.label || local.label;
        local.reason = server.reason || '';
        local.updatedAt = Date.now();
        if (isTerminalStatus(state) && ownedTasks[id]) settleOwnedTask(id, local);
      });
      cleanRegistry(current);
      saveLocalRegistry(current);
      paintProgress(current);
      return current;
    }).catch(function () { return current; });
  }

  function newTaskId() {
    return 'sync-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function taskName(label) {
    var text = String(label || '同步任务');
    return (text.split(/[：:]/)[0] || text).slice(0, 160);
  }

  function sendPersistedTask(id) {
    var task = pendingPersist[id];
    delete pendingPersist[id];
    if (persistTimers[id]) { clearTimeout(persistTimers[id]); delete persistTimers[id]; }
    if (!task || !root || !root.erpStorage || typeof root.erpStorage.request !== 'function') return;
    root.erpStorage.request('/api/sync-tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task)
    }).catch(function () {});
  }

  function persistTask(task, immediate) {
    if (!task) return;
    pendingPersist[task.id] = {
      id: task.id, type: task.type || 'sync', name: task.name, label: task.label, value: task.value,
      article: task.article || '', sku: task.sku || '',
      status: task.status, reason: task.reason || '', startedAt: task.startedAt
    };
    if (immediate) { sendPersistedTask(task.id); return; }
    if (!persistTimers[task.id]) persistTimers[task.id] = setTimeout(function () { sendPersistedTask(task.id); }, 1200);
  }

  function settleOwnedTask(id, settled) {
    if (!ownedTasks[id] || !isTerminalStatus(settled && settled.status)) return;
    ownedTasks[id] = Object.assign({}, ownedTasks[id], settled);
    delete pendingPersist[id];
    if (persistTimers[id]) { clearTimeout(persistTimers[id]); delete persistTimers[id]; }
  }

  function ensureHeartbeat() {
    if (heartbeatTimer || typeof setInterval !== 'function') return;
    heartbeatTimer = setInterval(function () {
      var ids = Object.keys(ownedTasks).filter(function (id) { return ownedTasks[id].status === 'running'; });
      if (!ids.length) { clearInterval(heartbeatTimer); heartbeatTimer = null; return; }
      var registry = readProgressState();
      ids.forEach(function (id) {
        // 其它标签页/工作台已经确认结束的任务，不能被旧iframe的心跳复活。
        if (registry.tasks[id] && isTerminalStatus(registry.tasks[id].status)) { settleOwnedTask(id, registry.tasks[id]); return; }
        ownedTasks[id].updatedAt = Date.now();
        registry.tasks[id] = ownedTasks[id];
        persistTask(ownedTasks[id], false);
      });
      cleanRegistry(registry);
      writeProgressState(registry);
    }, 30000);
  }

  function updateTask(id, value, label) {
    var previous = ownedTasks[id] || {};
    // Promise/轮询的晚到回调在 finish/fail 后可能继续 update；终态必须单向，不得重新变回 running。
    if (isTerminalStatus(previous.status)) return previous;
    var authoritative = readProgressState().tasks[id];
    if (authoritative && isTerminalStatus(authoritative.status)) { settleOwnedTask(id, authoritative); return ownedTasks[id]; }
    var percent = Math.max(1, Math.min(99, Math.floor(Number(value) || 1)));
    var nextLabel = label || previous.label || '正在同步…';
    var task = {
      id: id, type: previous.type || 'sync', name: previous.name || taskName(nextLabel), article: previous.article || '', sku: previous.sku || '', value: percent, label: nextLabel,
      status: 'running', reason: '', startedAt: previous.startedAt || new Date().toISOString(), updatedAt: Date.now()
    };
    ownedTasks[id] = task;
    var registry = readProgressState();
    registry.tasks[id] = task;
    cleanRegistry(registry);
    writeProgressState(registry);
    paintProgress(registry);
    persistTask(task, false);
    ensureHeartbeat();
  }

  function finishTask(id, label, status, reason) {
    var previous = ownedTasks[id] || {};
    var registry = readProgressState();
    var stored = registry.tasks[id];
    // 跨页已确认失败时，不允许较旧的当前页面把结果写回成功。
    if (stored && stored.status === 'failed') {
      settleOwnedTask(id, stored);
      return stored;
    }
    // done 之后仅允许同一任务明确的 fail 升级；其它终态保持幂等。
    if (previous.status === 'failed' || (previous.status === 'done' && status !== 'failed')) return previous;
    var task = {
      id: id, type: previous.type || 'sync', name: previous.name || taskName(label), article: previous.article || '', sku: previous.sku || '', value: status === 'failed' ? (previous.value || 1) : 100,
      label: label || previous.label || (status === 'failed' ? '同步失败' : '同步完成'),
      status: status === 'failed' ? 'failed' : 'done', reason: String(reason || ''),
      startedAt: previous.startedAt || new Date().toISOString(), updatedAt: Date.now()
    };
    ownedTasks[id] = task;
    registry.tasks[id] = task;
    cleanRegistry(registry);
    writeProgressState(registry);
    paintProgress(registry);
    persistTask(task, true);
    if (!Object.keys(ownedTasks).some(function (taskId) { return ownedTasks[taskId].status === 'running'; }) && heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function beginProgress(label, options) {
    var id = newTaskId();
    options = options || {};
    ownedTasks[id] = {
      type: ['sync', 'create', 'edit', 'archive'].indexOf(options.type) >= 0 ? options.type : 'sync',
      article: String(options.article || ''), sku: String(options.sku || '')
    };
    updateTask(id, 1, label || '正在准备同步…');
    persistTask(ownedTasks[id], true);
    return {
      id: id,
      update: function (value, nextLabel) { updateTask(id, value, nextLabel); },
      finish: function (nextLabel) { finishTask(id, nextLabel, 'done', ''); },
      fail: function (nextLabel, reason) { finishTask(id, nextLabel, 'failed', reason || nextLabel); }
    };
  }

  function updateProgress(value, label) {
    if (!defaultTaskId) defaultTaskId = newTaskId();
    updateTask(defaultTaskId, value, label);
  }

  function finishProgress(label) {
    if (!defaultTaskId) defaultTaskId = newTaskId();
    finishTask(defaultTaskId, label, 'done', '');
    defaultTaskId = '';
  }

  // 只有工作台主窗口做低频服务器终态校准；嵌入页仍由自己的订单同步监控推进。
  // 上一轮为阻断storage回声而停止自动校准后，切页/关闭iframe可能留下本地running状态。
  function workspaceOwnsProgress() {
    try { return !!(root && root.document && root.document.body && root.document.body.classList.contains('workspace-shell')); }
    catch (error) { return false; }
  }
  function scheduleWorkspaceReconcile(delay) {
    if (!workspaceOwnsProgress() || workspaceReconcileTimer || workspaceReconcilePending || !isActiveProgress()) return;
    workspaceReconcileTimer = setTimeout(function () {
      workspaceReconcileTimer = null;
      if (!isActiveProgress()) return;
      workspaceReconcilePending = reconcileRunningProgress(readProgressState(), 0).then(function () {}, function () {}).then(function () {
        workspaceReconcilePending = null;
        if (isActiveProgress()) scheduleWorkspaceReconcile(12000);
      });
    }, delay);
  }

  function restoreProgress() {
    var registry = cleanRegistry(readProgressState());
    saveLocalRegistry(registry);
    paintProgress(registry);
    if (typeof setTimeout === 'function') setTimeout(function () { reconcileRunningProgress(registry, 0); }, 0);
    scheduleWorkspaceReconcile(12000);
    return registry;
  }

  async function watchTasks(items, options) {
    options = options || {};
    var ids = Array.from(new Set((items || []).map(function (item) { return String(item.id || ''); })));
    if (!ids.length || ids.length > 100 || ids.some(function (id) { return !/^[A-Za-z0-9._:-]{1,120}$/.test(id); })) throw new Error('服务器未返回有效的同步任务编号');
    var request = options.request || function (url) { return root.erpStorage.request(url); };
    var wait = options.wait || function () { return new Promise(function (resolve) { setTimeout(resolve, 3000); }); };
    var failures = 0, missingReads = 0;
    while (true) {
      var tasks;
      try {
        var response = await request('/api/sync-tasks?limit=100&ids=' + encodeURIComponent(ids.join(',')));
        if (!response.ok) { var statusFailure = new Error('同步状态读取失败，请稍后重试；若持续失败请提交 BUG 反馈。'); statusFailure.status = response.status; throw statusFailure; }
        var data = await response.json();
        tasks = ids.map(function (id) { return (data.items || []).find(function (task) { return String(task.id) === id; }); });
        if (tasks.some(function (task) { return task && ['running', 'done', 'failed'].indexOf(task.status) < 0; })) throw new Error('服务器同步任务状态无效');
        failures = 0;
      } catch (error) {
        failures += 1;
        if (failures >= 3) throw error;
        await wait();
        continue;
      }
      if (tasks.some(function (task) { return !task; })) {
        // The legacy in-memory queue creates a visible row only when its worker starts.
        missingReads += 1;
        if (missingReads >= 100) throw new Error('部分同步任务状态持续不可见，请到任务中心核对');
        await wait();
        continue;
      }
      missingReads = 0;
      if (options.onChange) await options.onChange(tasks);
      if (tasks.every(function (task) { return task.status !== 'running'; })) return tasks;
      await wait();
    }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('storage', function (event) {
      if (event.key !== PROGRESS_KEY) return;
      // 跨页消息只刷新本地UI；不回写storage，也不为同一条消息重新请求数据库。
      // 完整状态校准仍由页面初次restore及主动同步任务watchTasks负责。
      paintProgress(cleanRegistry(readProgressState()));
      scheduleWorkspaceReconcile(4000);
    });
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        progressChannel = new BroadcastChannel(PROGRESS_KEY);
        progressChannel.onmessage = function (event) { paintProgress(mergeProgressState(event.data)); scheduleWorkspaceReconcile(4000); };
      } catch (error) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', restoreProgress);
    else setTimeout(restoreProgress, 0);
  }

  return {
    each: each,
    createThrottle: createThrottle,
    createThrottlePool: createThrottlePool,
    retryAfterMilliseconds: retryAfterMilliseconds,
    rateLimitDelay: rateLimitDelay,
    requestJsonWithRetry: requestJsonWithRetry,
    taskPercent: taskPercent,
    watchTasks: watchTasks,
    progress: {
      begin: beginProgress,
      update: updateProgress,
      finish: finishProgress,
      restore: restoreProgress,
      isActive: isActiveProgress,
      key: PROGRESS_KEY
    }
  };
});
