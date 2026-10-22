/* 网研ERP — 租户同步任务中心 */
(function () {
  'use strict';
  var tasks = [];
  var completedProductTasks = new Set();
  var page = 1, pageSize = 200, total = 0, serverSummary = { running: 0, done: 0, failed: 0 };
  var timer = null;
  var refreshing = null;
  var lastServerSignature = '';
  var unchangedRefreshes = 0;
  var rowEntries = new Map();
  var expandedBatches = new Set();
  var batchChildren = new Map();
  var batchChildRequests = new Map();
  var BATCH_CHILD_PAGE_SIZE = 50;
  var emptyRow = null;
  var aiPromptRequest = 0;
  var actionIcons = window.WYERP_INLINE_ACTION_ICONS;
  var $ = function (id) { return document.getElementById(id); };
  function shopNameForTask(task) {
    var shopId = String(task && (task.clientId || task.client_id || task.shopId || task.shop_id || task.article) || '').trim();
    var shops = erpStorage.get('erp_shops_data', []);
    var found = Array.isArray(shops) && shops.find(function (shop) { return String(shop && shop.clientId || '').trim() === shopId; });
    return String(found && found.name || '').trim() || shopId || '未知';
  }

  function timestamp(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return value;
    var parsed = Date.parse(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  function timeParts(value) {
    var time = timestamp(value);
    if (!time) return { date: '--', time: '' };
    var date = new Date(time), pad = function (number) { return number < 10 ? '0' + number : number; };
    return {
      date: date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()),
      time: pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    };
  }
  function renderTaskTime(node, value) {
    var parts = timeParts(value);
    node.replaceChildren();
    node.title = parts.time ? parts.date + ' ' + parts.time : parts.date;
    var dateLine = document.createElement('span'); dateLine.className = 'date-line'; dateLine.textContent = parts.date; node.appendChild(dateLine);
    if (parts.time) { var timeLine = document.createElement('span'); timeLine.className = 'time-line'; timeLine.textContent = parts.time; node.appendChild(timeLine); }
  }
  function durationText(task) {
    var start = timestamp(task.startedAt), end = task.hasRunningChildren ? Date.now() : timestamp(task.endedAt || task.updatedAt) || Date.now();
    if (!start) return '--';
    var seconds = Math.max(0, Math.floor((end - start) / 1000));
    if (seconds < 60) return seconds + ' 秒';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
    return Math.floor(seconds / 3600) + ' 小时 ' + Math.floor(seconds % 3600 / 60) + ' 分';
  }
  function displayStatus(task) {
    if (task.status === 'running' && !task.serverOwned && !/^product-(?:edit|create)-/.test(String(task.id)) && Date.now() - timestamp(task.updatedAt) > 3 * 60 * 1000) return 'failed';
    return task.status || 'failed';
  }
  function bilingualReason(chinese, original) {
    var zh = String(chinese || '').trim();
    var raw = String(original || '').trim();
    if (!raw) return zh;
    if (/原始报错[:：]/.test(raw) || /中文说明[:：]/.test(raw)) return raw;
    if (/[\u3400-\u9fff]/.test(raw)) return raw;
    return '中文说明：' + zh + '\n原始报错：' + raw;
  }
  function chineseReason(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    // 新版服务端会直接保存“中文说明 + 原始报错”，任务中心必须完整展示，不能再次覆盖原文。
    if (/原始报错[:：]/.test(raw) || /中文说明[:：]/.test(raw)) return raw;
    // ERP 自己的业务错误已经是中文，保持纯中文，不重复制造“原始报错”。
    if (/[\u3400-\u9fff]/.test(raw)) return raw;
    // 旧版本只落库内部代号时，也保留原始代号，方便历史问题排查。
    if (/^[a-z][a-z0-9_.:-]{3,}$/.test(raw)) {
      return bilingualReason('该记录由旧版本产生，未保存更具体的中文失败原因；请重新同步该任务获取新的完整错误信息。', raw);
    }
    var lower = raw.toLowerCase();
    if (/429|too many|rate.?limit|слишком много запросов/.test(lower)) return bilingualReason('接口请求过于频繁，平台正在限流，请稍后重试。', raw);
    if (/401|unauthorized|session.*(?:expired|invalid)|authentication|не авторизован|авторизац/.test(lower)) return bilingualReason('外部接口身份验证失败，请重新登录或检查接口授权。', raw);
    if (/403|forbidden|permission|access denied|api access disabled|доступ запрещ/.test(lower)) return bilingualReason('外部接口拒绝访问，请检查接口权限、店铺授权或平台侧 API 状态。', raw);
    if (/404|not found|не найден/.test(lower)) return bilingualReason('外部接口没有找到请求的数据或资源，请检查目标是否仍然有效。', raw);
    if (/409|conflict|version mismatch|конфликт/.test(lower)) return bilingualReason('外部接口返回数据冲突，请刷新后重新发起任务。', raw);
    if (/408|timeout|timed out|etimedout|request timeout|истекло время/.test(lower)) return bilingualReason('外部接口请求超时，请检查网络后重试。', raw);
    if (/failed to fetch|network|offline|econn|socket|dns|сеть|соединен/.test(lower)) return bilingualReason('无法连接外部接口，请检查网络或平台服务状态。', raw);
    if (/abort|cancel/.test(lower)) return bilingualReason('任务请求被中断或取消。', raw);
    if (/bad json|unexpected token|parse|invalid response|malformed|некоррект.*ответ/.test(lower)) return bilingualReason('外部接口返回的数据格式异常，系统暂时无法解析。', raw);
    if (/credential|api.?key|secret|token expired|ключ api/.test(lower)) return bilingualReason('外部接口凭证缺失、无效或已过期，请检查配置。', raw);
    if (/image|picture|photo/.test(lower)) return bilingualReason('外部图片接口或图片资源处理失败，请根据原始报错进一步核对。', raw);
    if (/5\d\d|internal server|service unavailable|bad gateway|gateway timeout|внутренняя ошибка/.test(lower)) return bilingualReason('外部平台服务暂时异常，请稍后重试。', raw);
    if (/разница между текущей ценой и ценой до скидки слишком маленькая/i.test(raw)) return bilingualReason('Ozon 拒绝操作：当前售价与折前价的差额太小，请调整价格后重试。', raw);
    if (/[\u0400-\u04ff]/.test(raw)) return bilingualReason('外部平台返回俄文错误，当前系统未匹配到更具体的业务说明，请结合原始报错排查。', raw);
    return bilingualReason('同步任务收到未识别的外部错误，请结合原始报错排查；若持续失败请提交 BUG 反馈。', raw);
  }
  function reasonOf(task) {
    if (task.status === 'running' && displayStatus(task) === 'failed') return '任务长时间没有更新，页面可能已关闭或执行已中断';
    if (/^client-order-/.test(String(task.id || ''))) {
      var reason = String(task.reason || '').trim();
      if (!reason && displayStatus(task) !== 'failed') return '';
      return /[\u3400-\u9fff]/.test(reason) && !/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.test(reason) && !/\bHTTP(?:\/\d+(?:\.\d+)?)?\s*[:：-]?\s*[1-5]\d\d\b/i.test(reason) && !/\b[1-5]\d\d\s+(?:Forbidden|Unauthorized|Internal Server Error|Bad Gateway|Service Unavailable|Not Found|Bad Request)\b/i.test(reason)
        ? reason
        : '订单同步失败，具体原因未记录，请重新同步或联系管理员查看任务日志。';
    }
    return chineseReason(task.reason);
  }
  function isQueueSubmission(task) {
    return displayStatus(task) === 'done' && /已(?:加入|进入)服务器队列/.test(String(task.label || ''));
  }
  function normalizedSyncName(task) {
    return String(task && task.name || '').replace(/^(在线|所选)/, '').replace(/提交$/, '').trim();
  }
  function summarizeGroups(list) {
    var summary = { running: 0, done: 0, failed: 0 };
    list.forEach(function (task) { var status = displayStatus(task); if (summary[status] != null) summary[status] += 1; });
    return summary;
  }
  function aggregateBatch(parent, children) {
    var states = { running: 0, done: 0, failed: 0 };
    children.forEach(function (child) { var status = displayStatus(child); if (states[status] != null) states[status] += 1; });
    var resources = ['用户资源', '服务器资源'].filter(function (resource) {
      return children.some(function (child) { return String(child.name || '').endsWith('（' + resource + '）'); });
    });
    var parentFailed = parent.status === 'failed';
    var status = parentFailed || states.failed ? 'failed' : states.running ? 'running' : 'done';
    var values = children.map(function (child) { return Math.max(0, Math.min(100, Number(child.value) || 0)); });
    var value = values.length ? Math.floor(values.reduce(function (sum, current) { return sum + current; }, 0) / values.length) : Number(parent.value) || 0;
    var starts = [parent].concat(children).map(function (task) { return timestamp(task.startedAt); }).filter(Boolean);
    var ends = [parent].concat(children).map(function (task) { return timestamp(task.endedAt || task.updatedAt); }).filter(Boolean);
    return Object.assign({}, parent, {
      isBatch: true, batchChildren: children, status: status, value: value,
      serverOwned: children.some(function (child) { return child.serverOwned; }),
      name: resources.length ? String(parent.name || '订单同步') + '（' + resources.join('、') + '）' : parent.name,
      hasRunningChildren: states.running > 0,
      label: (parentFailed ? (parent.label || '批次提交失败') + '；已接受 ' : '共 ') + children.length + ' 家店铺 · 成功 ' + states.done + ' · 进行中 ' + states.running + ' · 失败 ' + states.failed,
      reason: [parentFailed ? parent.reason || '批次未全部成功，请核对提交结果' : '', states.failed ? states.failed + ' 家店铺同步失败，展开查看详情' : ''].filter(Boolean).join('；'),
      startedAt: starts.length ? Math.min.apply(Math, starts) : parent.startedAt,
      endedAt: states.running || !ends.length ? null : Math.max.apply(Math, ends),
      updatedAt: ends.length ? Math.max.apply(Math, ends) : parent.updatedAt
    });
  }
  function groupTasks(source) {
    var list = source || [], byId = {}, childrenByParent = {}, consumed = new Set();
    list.forEach(function (task) { if (task && task.id) byId[String(task.id)] = task; });
    list.forEach(function (task) {
      var parentId = String(task && task.parentTaskId || '');
      if (!parentId || !byId[parentId]) return;
      (childrenByParent[parentId] || (childrenByParent[parentId] = [])).push(task);
      consumed.add(String(task.id));
    });
    list.filter(isQueueSubmission).forEach(function (parent) {
      var parentId = String(parent.id);
      if (childrenByParent[parentId] && childrenByParent[parentId].length) return;
      var parentTime = timestamp(parent.startedAt);
      list.forEach(function (child) {
        if (!child || consumed.has(String(child.id)) || child === parent || isQueueSubmission(child) || child.parentTaskId) return;
        if (!/^sync-(?:shop-|products-|orders-)/.test(String(child.id))) return;
        if (String(child.actorUsername || '') !== String(parent.actorUsername || '')) return;
        if (normalizedSyncName(child) !== normalizedSyncName(parent)) return;
        if (Math.abs(timestamp(child.startedAt) - parentTime) > 15000) return;
        (childrenByParent[parentId] || (childrenByParent[parentId] = [])).push(child);
        consumed.add(String(child.id));
      });
    });
    return list.filter(function (task) { return !consumed.has(String(task.id)); }).map(function (task) {
      var children = childrenByParent[String(task.id)] || [];
      children.sort(function (left, right) { return timestamp(left.startedAt) - timestamp(right.startedAt); });
      return children.length ? aggregateBatch(task, children) : task;
    });
  }
  function childSummaryOf(task) {
    var source = task && task.childSummary;
    if (!source || typeof source !== 'object') return null;
    var totalChildren = Number(source.total != null ? source.total : source.count);
    if (!Number.isFinite(totalChildren) || totalChildren < 0) return null;
    var result = {
      total: Math.floor(totalChildren),
      running: Math.max(0, Math.floor(Number(source.running) || 0)),
      done: Math.max(0, Math.floor(Number(source.done) || 0)),
      failed: Math.max(0, Math.floor(Number(source.failed) || 0)),
      value: Number(source.value)
    };
    if (Array.isArray(source.failedDetails) && source.failedDetails.length) result.failedDetails = source.failedDetails;
    return result;
  }
  function batchFailureReason(summary) {
    var details = summary && Array.isArray(summary.failedDetails) ? summary.failedDetails : [];
    if (!details.length) return '';
    var parts = details.slice(0, 3).map(function (detail) {
      var shop = shopNameForTask({ article: detail && detail.article });
      var reason = chineseReason(detail && (detail.reason || detail.label));
      return shop + '：' + (reason || '同步失败');
    });
    if (details.length > 3) parts.push('另有 ' + (details.length - 3) + ' 家店铺失败，展开查看');
    return parts.join('；');
  }
  function decorateBatchParent(task) {
    var summary = childSummaryOf(task);
    if (!summary) return task;
    var id = String(task.id), cached = batchChildren.get(id), children = cached && Array.isArray(cached.items) ? cached.items : [];
    var recoveringImages = id.indexOf('sync-sku-ai-') === 0 && ['failed', 'cancelled'].indexOf(task.backgroundState) !== -1 && summary.running > 0 && summary.failed === 0;
    var recoveredImages = id.indexOf('sync-sku-ai-') === 0 && ['failed', 'cancelled'].indexOf(task.backgroundState) !== -1 && summary.total > 0 && summary.done === summary.total;
    var parentFailed = task.status === 'failed' && !recoveringImages && !recoveredImages;
    var allChildrenDone = summary.total > 0 && summary.done === summary.total && summary.failed === 0;
    var status = recoveringImages ? 'running' : parentFailed || summary.failed ? 'failed' : summary.running ? 'running' : allChildrenDone ? 'done' : task.status;
    var rawProgress = Number.isFinite(summary.value) ? summary.value : Number(task.value) || 0;
    // 任务中心状态和百分比必须一致：全部子任务成功才显示100%，仍有子任务运行不能提前100%。
    var value = status === 'done' ? 100 : status === 'running' ? Math.min(99, Math.max(0, rawProgress)) : Math.max(0, Math.min(100, rawProgress));
    return Object.assign({}, task, {
      isBatch: true,
      batchChildren: children,
      childSummary: summary,
      status: status,
      value: value,
      hasRunningChildren: summary.running > 0,
      label: (recoveringImages ? '父任务异常，子任务正在恢复处理；共 ' : parentFailed ? (task.label || '批次提交失败') + '；已接受 ' : '共 ') + summary.total + ' 项 · 成功 ' + summary.done + ' · 进行中 ' + summary.running + ' · 失败 ' + summary.failed,
      reason: [parentFailed ? task.reason || '批次未全部成功，请核对提交结果' : '', summary.failed ? (batchFailureReason(summary) || summary.failed + ' 项子任务失败，展开查看详情') : ''].filter(Boolean).join('；')
    });
  }
  function decorateBatchParents(list) {
    return (list || []).map(decorateBatchParent);
  }
  function discardHiddenBatchCaches(list) {
    var visible = new Set((list || []).map(function (task) { return String(task.id); }));
    batchChildren.forEach(function (_cache, id) {
      if (!visible.has(id)) { batchChildren.delete(id); batchChildRequests.delete(id); expandedBatches.delete(id); }
    });
  }
  var LOCAL_PROGRESS_GRACE_MS = 15000;
  function isRecentLocalRunningTask(task, now) {
    var updated = timestamp(task && (task.updatedAt || task.startedAt));
    return updated > 0 && updated <= now && now - updated <= LOCAL_PROGRESS_GRACE_MS;
  }
  function mergeLocal(serverTasks) {
    var byId = {};
    (serverTasks || []).forEach(function (task) { if (task && task.id) byId[task.id] = task; });
    try {
      var registry = JSON.parse(localStorage.getItem(window.WYERP_SYNC_STREAM.progress.key) || 'null');
      var now = Date.now();
      Object.keys(registry && registry.tasks || {}).forEach(function (id) {
        var local = registry.tasks[id];
        if (!local || local.status !== 'running') return;
        // 服务端任务状态是权威结果。本地流只补刚入队、服务端尚未返回的短暂空档，
        // 不能把旧的 running 状态重新覆盖已完成或已失败的任务。
        if (byId[id] || !isRecentLocalRunningTask(local, now)) return;
        byId[id] = Object.assign({}, local, {
          actorUsername: erpStorage.displayUsername(erpStorage.getCurrentUser()),
          startedAt: local.startedAt
        });
      });
    } catch (error) {}
    return Object.keys(byId).map(function (id) { return byId[id]; }).sort(function (left, right) {
      return timestamp(right.startedAt || right.updatedAt) - timestamp(left.startedAt || left.updatedAt);
    });
  }
  function text(element, value) {
    var next = String(value == null ? '' : value);
    if (element.textContent !== next) element.textContent = next;
  }
  function titledText(element, value) {
    text(element, value);
    if (element.title !== element.textContent) element.title = element.textContent;
  }
  function taskActorIdentity(task) {
    var api = window.WYERP_IDENTITY_DISPLAY;
    var identity = api && typeof api.displayIdentity === 'function'
      ? api.displayIdentity({ profileFullName: task && task.actorProfileFullName, email: task && task.actorEmail, isSystemAdmin: task && task.actorIsSystemAdmin })
      : { kind: 'unknown', raw: '', masked: '' };
    return identity.kind === 'unknown' ? { raw: '', masked: String(task && task.actorLabel || '历史未记录') } : identity;
  }
  function titledIdentity(element, task) {
    var identity = taskActorIdentity(task);
    text(element, identity.masked || '历史未记录');
    var title = identity.raw || identity.masked || '历史未记录';
    if (element.title !== title) element.title = title;
  }
  function isSkuImageAiTask(task) {
    return String(task && task.id || '').startsWith('sku-image-ai-') && /^AI图片重绘(?:\s*·|$)/.test(String(task && task.name || ''));
  }
  function isSkuImageAiBatchTask(task) {
    return String(task && task.id || '').startsWith('sync-sku-ai-') && /^AI图片批量重绘(?:\s*·|$)/.test(String(task && task.name || ''));
  }
  function taskIdentifierText(task) {
    var value = String(task && task.article || '').trim();
    if (!value) return '';
    return (isSkuImageAiTask(task) || isSkuImageAiBatchTask(task) ? '商品ID：' : '货号：') + value;
  }
  function batchChildLeadText(task) {
    if (isSkuImageAiTask(task)) return '商品ID ' + (String(task && task.article || '').trim() || '—');
    return '店铺 ' + shopNameForTask(task);
  }
  function detailText(value) {
    if (value == null || value === '') return '未记录';
    return String(value);
  }
  function billingDetail(value) {
    var item = value && typeof value === 'object' ? value : {};
    return 'state：' + detailText(item.state) + '\nkeyHash：' + detailText(item.keyHash) + '\nreplayed：' + detailText(item.replayed) + '\nerrorCode：' + detailText(item.errorCode) + '\nbalanceBefore：' + detailText(item.balanceBefore) + '\nfrozenBefore：' + detailText(item.frozenBefore) + '\nbalanceAfter：' + detailText(item.balanceAfter) + '\nfrozenAfter：' + detailText(item.frozenAfter);
  }
  function addDetailMeta(list, label, value, className) {
    var item = document.createElement('div'), term = document.createElement('dt'), description = document.createElement('dd');
    item.className = 'ai-prompt-meta-item' + (className ? ' ' + className : '');
    text(term, label); text(description, value); item.appendChild(term); item.appendChild(description); list.appendChild(item);
  }
  function jsonFieldsDetail(value) {
    if (!Array.isArray(value)) return '未记录';
    if (!value.length) return '[]';
    return value.map(function (field) { return detailText(field && field.name) + '：' + detailText(field && field.type); }).join('\n');
  }
  function fieldNumbersDetail(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '未记录';
    var names = Object.keys(value);
    if (!names.length) return '{}';
    return names.map(function (name) { return name + '：' + (Array.isArray(value[name]) ? value[name].length ? value[name].map(function (item) { return detailText(item); }).join('、') : '[]' : detailText(value[name])); }).join('\n');
  }
  function pollingTraceDetail(value) {
    if (!Array.isArray(value)) return '未记录';
    if (!value.length) return '[]';
    return value.map(function (entry, index) {
      var item = entry && typeof entry === 'object' ? entry : {};
      return '#' + (index + 1) + '\nat：' + detailText(item.at) + '\nhttpStatus：' + detailText(item.httpStatus) + '\nrequestId：' + detailText(item.requestId) + '\nstate：' + detailText(item.state) + '\nprogress：' + detailText(item.progress) + '\nerrorCode：' + detailText(item.errorCode);
    }).join('\n\n');
  }
  function snapshotSummary(snapshots) {
    var labels = { template: '官方模板', sellingPoints: '确认卖点', rawResponse: '文字原始结果', finalPrompt: '最终图片提示词' };
    return Object.keys(labels).map(function (name) {
      var item = snapshots && snapshots[name];
      if (!item) return labels[name] + '：尚未生成';
      return labels[name] + '：' + detailText(item.chars) + ' 字符 / ' + detailText(item.size) + ' 字节 / ' + detailText(item.createdAt);
    }).join('\n');
  }
  function renderAiPromptDetails(data) {
    var diagnostic = data.diagnostic && typeof data.diagnostic === 'object' ? data.diagnostic : {};
    var textCall = diagnostic.textCall || {}, provider = diagnostic.providerHttp || {}, response = diagnostic.response || {}, validation = diagnostic.validation || {}, rendered = diagnostic.rendered || {}, imagePost = diagnostic.imagePost || {}, polling = diagnostic.polling || {}, billing = diagnostic.billing || {};
    var failure = ['错误码：' + detailText(validation.errorCode), '字段：' + detailText(validation.field), '违规数字/单位 token：' + detailText(validation.invalidNumber)].join('\n');
    var meta = $('aiPromptDetailsMeta'); meta.replaceChildren();
    addDetailMeta(meta, '任务名称', detailText(data.taskName));
    addDetailMeta(meta, '完整任务ID', detailText(data.taskId));
    addDetailMeta(meta, '任务状态 / 当前阶段', detailText(data.state) + ' / ' + detailText(data.phase));
    addDetailMeta(meta, '诊断归属', 'taskId：' + detailText(diagnostic.taskId) + '\nbusinessRef：' + detailText(diagnostic.businessRef) + '\ntenantId：' + detailText(diagnostic.tenantId) + '\nactorUserId：' + detailText(diagnostic.actorUserId));
    addDetailMeta(meta, '具体失败字段 / token', failure);
    addDetailMeta(meta, '文字调用', 'state：' + detailText(textCall.state) + '\nstartedAt：' + detailText(textCall.startedAt) + '\nendedAt：' + detailText(textCall.endedAt) + '\nconfigurationId：' + detailText(textCall.configurationId) + '\nprotocol：' + detailText(textCall.protocol) + '\nmodel：' + detailText(textCall.model) + '\nerrorCode：' + detailText(textCall.errorCode));
    addDetailMeta(meta, '文字供应商 HTTP', 'state：' + detailText(provider.state) + '\nstatus：' + detailText(provider.status) + '\nrequestId：' + detailText(provider.requestId) + '\nerrorCode：' + detailText(provider.errorCode));
    addDetailMeta(meta, '文字响应', 'sha256：' + detailText(response.sha256) + '\nchars：' + detailText(response.chars) + '\njsonFields：\n' + jsonFieldsDetail(response.jsonFields));
    addDetailMeta(meta, '逐字段数字 / 单位 token', fieldNumbersDetail(diagnostic.fieldNumbers));
    addDetailMeta(meta, '校验诊断', 'stage：' + detailText(validation.stage) + '\nfield：' + detailText(validation.field) + '\ninvalidNumber：' + detailText(validation.invalidNumber) + '\nerrorCode：' + detailText(validation.errorCode));
    addDetailMeta(meta, '模板渲染', 'sha256：' + detailText(rendered.sha256) + '\nchars：' + detailText(rendered.chars));
    addDetailMeta(meta, '图片提交', 'state：' + detailText(imagePost.state) + '\nconfigurationId：' + detailText(imagePost.configurationId) + '\nprotocol：' + detailText(imagePost.protocol) + '\nmodel：' + detailText(imagePost.model) + '\nhttpStatus：' + detailText(imagePost.httpStatus) + '\nproviderRequestId：' + detailText(imagePost.providerRequestId) + '\nproviderTaskId：' + detailText(imagePost.providerTaskId) + '\nstartedAt：' + detailText(imagePost.startedAt) + '\nendedAt：' + detailText(imagePost.endedAt) + '\nresult：' + detailText(imagePost.result) + '\nerrorCode：' + detailText(imagePost.errorCode) + '\nattemptCount：' + detailText(imagePost.attemptCount));
    addDetailMeta(meta, '轮询汇总', 'state：' + detailText(polling.state) + '\nstartedAt：' + detailText(polling.startedAt) + '\nendedAt：' + detailText(polling.endedAt) + '\ntimedOutAt：' + detailText(polling.timedOutAt) + '\ncallCount：' + detailText(polling.callCount) + '\nfinalState：' + detailText(polling.finalState));
    addDetailMeta(meta, '轮询完整 trace', pollingTraceDetail(polling.trace), 'ai-prompt-meta-wide ai-prompt-trace');
    addDetailMeta(meta, '任务尝试 / 调用计数', 'jobAttemptCount：' + detailText(diagnostic.jobAttemptCount) + '\nretryCount：' + detailText(diagnostic.retryCount) + '\nrecoveryCount：' + detailText(diagnostic.recoveryCount) + '\ntextCallCount：' + detailText(diagnostic.textCallCount) + '\nimageSubmitCount：' + detailText(diagnostic.imageSubmitCount) + '\npollCount：' + detailText(diagnostic.pollCount));
    addDetailMeta(meta, '计费总览', 'amount：' + detailText(billing.amount) + '\nunit：' + detailText(billing.unit));
    addDetailMeta(meta, '冻结账务', billingDetail(billing.freeze));
    addDetailMeta(meta, '结算账务', billingDetail(billing.settle));
    addDetailMeta(meta, '释放账务', billingDetail(billing.release));
    addDetailMeta(meta, '诊断时间', 'startedAt：' + detailText(diagnostic.startedAt) + '\nendedAt：' + detailText(diagnostic.endedAt));
    addDetailMeta(meta, '四份快照', snapshotSummary(data.snapshots || {}));
    [['aiPromptSnapshotTemplate', 'template'], ['aiPromptSnapshotSellingPoints', 'sellingPoints'], ['aiPromptSnapshotRawResponse', 'rawResponse'], ['aiPromptSnapshotFinalPrompt', 'finalPrompt']].forEach(function (pair) {
      var snapshot = data.snapshots && data.snapshots[pair[1]];
      text($(pair[0]), snapshot && typeof snapshot.content === 'string' && snapshot.content ? snapshot.content : snapshot ? '快照内容为空（服务端未返回正文）' : '尚未生成');
    });
    text($('aiPromptDetailsTaskId'), '任务ID：' + detailText(data.taskId));
    $('aiPromptDetailsState').hidden = true; $('aiPromptDetailsContent').hidden = false;
  }
  function aiPromptError(status, code, message) {
    var chinese = String(message || '').trim();
    if (/[\u3400-\u9fff]/.test(chinese)) return chinese;
    if (status === 401) return '登录会话已失效，请重新登录后再查看处理详情。';
    if (status === 403 || code === 'permission_denied') return '无权查看：当前账号不是该任务的原操作者或系统管理员，或缺少商品编辑权限。';
    if (status === 404) return '任务不存在、已移除，或不属于当前租户。';
    return '处理详情接口请求失败，未展示任何推测内容；请稍后重试，若持续失败请提交 BUG 反馈。';
  }
  function openAiPromptDetails(taskId) {
    var dialog = $('aiPromptDetailsDialog'), requestId = ++aiPromptRequest;
    text($('aiPromptDetailsTaskId'), '任务ID：' + taskId);
    text($('aiPromptDetailsState'), '正在加载处理详情…');
    $('aiPromptDetailsState').classList.remove('is-error'); $('aiPromptDetailsState').hidden = false; $('aiPromptDetailsContent').hidden = true;
    if (!dialog.open) dialog.showModal();
    erpStorage.request('/api/domain/commands/sku-image-ai-prompt-details?taskId=' + encodeURIComponent(taskId), { cache: 'no-store' }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) { return { response: response, body: body }; });
    }).then(function (result) {
      if (requestId !== aiPromptRequest || !dialog.open) return;
      if (!result.response.ok) throw { status: result.response.status, code: result.body && result.body.error, message: result.body && result.body.message };
      renderAiPromptDetails(result.body || {});
    }).catch(function (error) {
      if (requestId !== aiPromptRequest || !dialog.open) return;
      text($('aiPromptDetailsState'), aiPromptError(error && error.status, error && error.code, error && error.message));
      $('aiPromptDetailsState').classList.add('is-error'); $('aiPromptDetailsState').hidden = false; $('aiPromptDetailsContent').hidden = true;
    });
  }
  function closeAiPromptDetails() {
    aiPromptRequest += 1;
    if ($('aiPromptDetailsDialog').open) $('aiPromptDetailsDialog').close();
  }
  function createRow(id) {
    var row = document.createElement('tr');
    row.dataset.taskId = id;
    // Only the static shell uses HTML. All server values go through text/DOM APIs.
    row.innerHTML = '<td><div class="task-name"><button type="button" class="batch-toggle" data-batch-toggle="" title="展开店铺明细" aria-label="展开店铺明细" hidden>+</button><span class="task-name-text" title=""></span><button type="button" class="task-ai-details" data-task-ai-details="" title="查看提示词/处理详情" hidden>查看提示词/处理详情</button><button type="button" class="inline-icon-btn task-sku-copy" data-task-sku="" title="复制完整SKU" aria-label="复制完整SKU" hidden></button></div><div class="task-id"></div><div class="task-label"></div></td>' +
      '<td><span class="task-type"></span></td><td class="reason-cell"><div class="task-reason" hidden></div><span class="task-reason-empty">—</span></td>' +
      '<td><span class="username-ellipsis" title=""></span></td><td><span class="task-time task-start"></span></td><td><span class="task-time task-end"></span></td><td><span class="task-duration"></span></td>' +
      '<td><div class="progress-cell"><div class="progress-head"><span class="task-progress-label"></span><b class="task-percent"></b></div><progress class="erp-progress" aria-label="任务进度" max="100" value="0"></progress></div></td>' +
      '<td><span class="status-pill"></span></td>';
    var detailRow = document.createElement('tr'), detailCell = document.createElement('td'), detailList = document.createElement('div');
    detailRow.className = 'task-batch-detail-row'; detailCell.colSpan = 9; detailList.className = 'batch-detail-list';
    detailCell.appendChild(detailList); detailRow.appendChild(detailCell);
    var entry = { row: row, detailRow: detailRow, detailList: detailList };
    ['batch-toggle', 'task-name-text', 'task-ai-details', 'task-sku-copy', 'task-id', 'task-label', 'task-type', 'task-reason', 'task-reason-empty', 'username-ellipsis', 'task-start', 'task-end', 'task-duration', 'task-progress-label', 'task-percent', 'erp-progress', 'status-pill'].forEach(function (name) {
      entry[name] = row.querySelector('.' + name);
    });
    entry['task-sku-copy'].innerHTML = actionIcons.copy();
    return entry;
  }
  function renderBatchDetails(entry, task) {
    var parentId = String(task.id), cache = batchChildren.get(parentId), children = cache && Array.isArray(cache.items) ? cache.items : (task.batchChildren || []), summary = childSummaryOf(task);
    var childTotal = cache && Number.isFinite(Number(cache.total)) ? Number(cache.total) : (summary ? summary.total : children.length);
    var expanded = expandedBatches.has(parentId);
    entry['batch-toggle'].hidden = !(task.isBatch || childTotal > 0 || children.length);
    entry['batch-toggle'].textContent = expanded ? '-' : '+';
    entry['batch-toggle'].title = expanded ? '收起子任务明细' : '展开子任务明细';
    entry['batch-toggle'].setAttribute('aria-expanded', expanded ? 'true' : 'false');
    entry.detailList.replaceChildren();
    if (!expanded) return;
    if (!cache || cache.loading) {
      var loading = document.createElement('div'); loading.className = 'batch-detail-item'; text(loading, '正在读取子任务明细…'); entry.detailList.appendChild(loading); return;
    }
    if (cache.error) {
      var failed = document.createElement('div'); failed.className = 'batch-detail-item'; text(failed, '子任务明细读取失败，请收起后重新展开。'); entry.detailList.appendChild(failed); return;
    }
    children.forEach(function (child) {
      var status = displayStatus(child), item = document.createElement('div'), resource = String(child.name || '').match(/（(用户资源|服务器资源)）$/);
      item.className = 'batch-detail-item';
      [['batch-shop', batchChildLeadText(child) + (resource ? ' · ' + resource[1] : '')], ['batch-progress', child.label || '等待更新'], ['batch-percent', Math.max(0, Math.min(100, Math.floor(Number(child.value) || 0))) + '%'], ['batch-reason', reasonOf(child) || '—'], ['status-pill status-' + status, status === 'running' ? '进行中' : status === 'done' ? '成功' : '失败']].forEach(function (part) {
        var span = document.createElement('span'); span.className = part[0]; titledText(span, part[1]); item.appendChild(span);
      });
      entry.detailList.appendChild(item);
    });
    if (!children.length) {
      var empty = document.createElement('div'); empty.className = 'batch-detail-item'; text(empty, '该批次暂无子任务记录'); entry.detailList.appendChild(empty);
    }
    var pages = Math.max(1, Math.ceil(childTotal / BATCH_CHILD_PAGE_SIZE));
    if (pages > 1) {
      var pager = document.createElement('div'); pager.className = 'batch-detail-item';
      var previous = document.createElement('button'), next = document.createElement('button'), label = document.createElement('span');
      previous.type = 'button'; previous.textContent = '上一页'; previous.dataset.batchChildPage = 'previous'; previous.dataset.batchParentId = parentId; previous.disabled = cache.page <= 1;
      next.type = 'button'; next.textContent = '下一页'; next.dataset.batchChildPage = 'next'; next.dataset.batchParentId = parentId; next.disabled = cache.page >= pages;
      text(label, '子任务第 ' + cache.page + ' / ' + pages + ' 页 · 共 ' + childTotal + ' 项'); pager.append(previous, label, next); entry.detailList.appendChild(pager);
    }
  }
  function updateRow(entry, task) {
    var status = displayStatus(task), percent = Math.max(0, Math.min(100, Math.floor(Number(task.value) || 0)));
    var queueSubmission = isQueueSubmission(task);
    var typeText = task.isBatch ? '批量同步' : queueSubmission ? '同步提交' : ({ sync: '同步', create: '新增', edit: '修改', archive: '归档/恢复' }[task.type || 'sync'] || '同步');
    var reason = reasonOf(task), copy = entry['task-sku-copy'], aiDetails = entry['task-ai-details'], aiTask = isSkuImageAiTask(task);
    titledText(entry['task-name-text'], task.name || '任务');
    titledText(entry['task-id'], '任务ID：' + String(task.id));
    var identifier = taskIdentifierText(task);
    titledText(entry['task-label'], identifier);
    if (entry['task-label'].hidden !== !identifier) entry['task-label'].hidden = !identifier;
    if (copy.hidden !== !task.sku) copy.hidden = !task.sku;
    if (copy.dataset.taskSku !== String(task.sku || '')) copy.dataset.taskSku = task.sku || '';
    if (aiDetails.hidden !== !aiTask) aiDetails.hidden = !aiTask;
    if (aiDetails.dataset.taskAiDetails !== (aiTask ? String(task.id) : '')) aiDetails.dataset.taskAiDetails = aiTask ? String(task.id) : '';
    text(entry['task-type'], typeText);
    titledText(entry['task-reason'], reason);
    if (entry['task-reason'].hidden !== !reason) entry['task-reason'].hidden = !reason;
    if (entry['task-reason-empty'].hidden !== Boolean(reason)) entry['task-reason-empty'].hidden = Boolean(reason);
    titledIdentity(entry['username-ellipsis'], task);
    renderTaskTime(entry['task-start'], task.startedAt);
    renderTaskTime(entry['task-end'], status === 'running' || task.hasRunningChildren ? null : (task.endedAt || task.updatedAt));
    titledText(entry['task-duration'], durationText(task));
    titledText(entry['task-progress-label'], task.label || '等待更新');
    text(entry['task-percent'], percent + '%');
    if (entry['erp-progress'].value !== percent) entry['erp-progress'].value = percent;
    text(entry['status-pill'], queueSubmission ? '提交成功' : status === 'running' ? String(task.id).startsWith('product-edit-') && percent === 0 ? '排队中' : '进行中' : status === 'done' ? '成功' : '失败');
    var statusClass = 'status-pill status-' + status;
    if (entry['status-pill'].className !== statusClass) entry['status-pill'].className = statusClass;
    renderBatchDetails(entry, task);
  }
  function shouldShowBatchDetails(task) {
    return expandedBatches.has(String(task.id)) && (task.isBatch || batchChildren.has(String(task.id)));
  }
  function reconcileRows(tasks) {
    var body = $('taskBody'), wanted = new Set(tasks.map(function (task) { return String(task.id); }));
    rowEntries.forEach(function (entry, id) {
      if (!wanted.has(id)) { entry.row.remove(); entry.detailRow.remove(); rowEntries.delete(id); }
    });
    if (!tasks.length) {
      if (!emptyRow) {
        emptyRow = document.createElement('tr');
        emptyRow.innerHTML = '<td colspan="9" class="empty-task">暂无符合条件的任务记录</td>';
      }
      if (!emptyRow.parentNode) body.appendChild(emptyRow);
      return;
    }
    if (emptyRow) emptyRow.remove();
    var cursor = body.firstElementChild;
    tasks.forEach(function (task) {
      var id = String(task.id), entry = rowEntries.get(id);
      if (!entry) { entry = createRow(id); rowEntries.set(id, entry); }
      updateRow(entry, task);
      // Do not detach/reinsert rows already at the right position: retain hover/focus.
      if (entry.row !== cursor) body.insertBefore(entry.row, cursor);
      cursor = entry.row.nextElementSibling;
      if (shouldShowBatchDetails(task)) {
        if (entry.detailRow !== cursor) body.insertBefore(entry.detailRow, cursor);
        cursor = entry.detailRow.nextElementSibling;
      } else entry.detailRow.remove();
    });
  }
  function render() {
    var keyword = $('keyword').value.trim().toLowerCase(), wanted = $('statusFilter').value, wantedType = $('typeFilter').value;
    $('totalCount').textContent = total;
    $('runningCount').textContent = serverSummary.running || 0;
    $('doneCount').textContent = serverSummary.done || 0;
    $('failedCount').textContent = serverSummary.failed || 0;
    var rows = tasks.filter(function (task) {
      var status = displayStatus(task);
      if (wanted && status !== wanted) return false;
      if (wantedType && (task.type || 'sync') !== wantedType) return false;
      if (!keyword) return true;
      var actor = taskActorIdentity(task);
      return [task.name, task.article, task.sku, task.label, reasonOf(task), actor.raw, actor.masked].join(' ').toLowerCase().indexOf(keyword) >= 0;
    });
    var pages = Math.max(1, Math.ceil(total / pageSize));
    if (page > pages) page = pages;
    reconcileRows(rows);
    $('pageText').textContent = '第 ' + page + ' / ' + pages + ' 页 · 每页 ' + pageSize + ' 条';
    $('prevPage').disabled = page <= 1;
    $('nextPage').disabled = page >= pages;
  }
  function hasRunningTask() {
    return Number(serverSummary.running) > 0 || tasks.some(function (task) { return displayStatus(task) === 'running' || task.hasRunningChildren; });
  }
  function hasRecentLocalRunningTask() {
    if (!window.WYERP_SYNC_STREAM || !window.WYERP_SYNC_STREAM.progress) return false;
    try {
      var registry = JSON.parse(localStorage.getItem(window.WYERP_SYNC_STREAM.progress.key) || 'null');
      var now = Date.now();
      return Object.keys(registry && registry.tasks || {}).some(function (id) {
        var task = registry.tasks[id];
        return task && task.status === 'running' && isRecentLocalRunningTask(task, now);
      });
    } catch (error) { return false; }
  }
  function refreshIfRunning() {
    if (!hasRunningTask() && !hasRecentLocalRunningTask()) { scheduleRefresh(); return Promise.resolve(); }
    unchangedRefreshes = 0;
    return refresh();
  }
  function scheduleRefresh() {
    if (timer) { clearTimeout(timer); timer = null; }
    var delay = window.WYERP_TASK_REFRESH_POLICY.delay({ running: hasRunningTask(), hidden: document.hidden, unchanged: unchangedRefreshes });
    if (delay != null) {
      $('refreshNote').textContent = '有进行中任务 · ' + (delay / 1000).toFixed(delay % 1000 ? 1 : 0) + ' 秒后刷新';
      timer = setTimeout(refresh, delay);
    } else if (document.hidden && hasRunningTask()) {
      $('refreshNote').textContent = '页面在后台 · 已暂停自动刷新';
    } else {
      $('refreshNote').textContent = '当前无进行中任务 · 已停止自动刷新';
    }
  }
  function renderBatchChildrenOnly(parentId) {
    // Expanding one batch should not redraw all 200 parent rows.
    var id = String(parentId), entry = rowEntries.get(id);
    if (!entry || !entry.row.parentNode) return;
    var task = tasks.find(function (item) { return String(item.id) === id; });
    if (!task) return;
    renderBatchDetails(entry, task);
    if (expandedBatches.has(id)) {
      if (entry.detailRow.previousElementSibling !== entry.row) entry.row.after(entry.detailRow);
    } else {
      entry.detailRow.remove();
    }
  }
  function loadBatchChildren(parentId, wantedPage) {
    var id = String(parentId), current = batchChildren.get(id) || {}, pageNo = Math.max(1, Number(wantedPage) || 1);
    if (current.loading) return current.loading;
    var requestId = (batchChildRequests.get(id) || 0) + 1;
    batchChildRequests.set(id, requestId);
    var pending = Object.assign({}, current, { page: pageNo, loading: true, error: '' });
    batchChildren.set(id, pending); renderBatchChildrenOnly(id);
    var offset = (pageNo - 1) * BATCH_CHILD_PAGE_SIZE;
    pending.loading = erpStorage.request('/api/sync-tasks?parentTaskId=' + encodeURIComponent(id) + '&limit=' + BATCH_CHILD_PAGE_SIZE + '&offset=' + offset).then(function (response) {
      if (!response.ok) throw new Error('子任务列表读取失败');
      return response.json();
    }).then(function (data) {
      if (!expandedBatches.has(id) || batchChildRequests.get(id) !== requestId) return;
      batchChildren.set(id, { items: Array.isArray(data.items) ? data.items : [], total: Number.isFinite(Number(data.total)) ? Number(data.total) : 0, page: pageNo, loading: null, error: '' });
      renderBatchChildrenOnly(id);
    }).catch(function () {
      if (!expandedBatches.has(id) || batchChildRequests.get(id) !== requestId) return;
      batchChildren.set(id, { items: [], total: Number(current.total) || 0, page: pageNo, loading: null, error: true });
      renderBatchChildrenOnly(id);
    });
    return pending.loading;
  }
  function refresh() {
    if (refreshing) return refreshing;
    if (document.hidden) { scheduleRefresh(); return Promise.resolve(); }
    if (timer) { clearTimeout(timer); timer = null; }
    $('refreshNote').textContent = '正在刷新…';
    var type = $('typeFilter').value;
    var offset = (page - 1) * pageSize;
    refreshing = erpStorage.request('/api/sync-tasks?limit=' + pageSize + '&offset=' + offset + (type ? '&type=' + encodeURIComponent(type) : '')).then(function (response) {
      if (!response.ok) throw new Error('任务列表读取失败，请刷新页面后重试；若持续失败请提交 BUG 反馈。');
      return response.json();
    }).then(function (data) {
      var signature = JSON.stringify((data.items || []).map(function (task) { return [task.id, task.status, task.value, task.updatedAt]; }));
      unchangedRefreshes = signature === lastServerSignature ? unchangedRefreshes + 1 : 0;
      lastServerSignature = signature;
      tasks = decorateBatchParents(groupTasks(mergeLocal(data.items || [])));
      discardHiddenBatchCaches(tasks);
      var productsChanged = false;
      (data.items || []).forEach(function (task) {
        if (String(task.id).startsWith('product-edit-') && task.status !== 'running' && !completedProductTasks.has(task.id)) {
          completedProductTasks.add(task.id); productsChanged = true;
        }
      });
      if (productsChanged) erpStorage.notifyServerChange('erp_online_products');
      total = Number.isFinite(Number(data.total)) ? Number(data.total) : tasks.length;
      serverSummary = data.summary && typeof data.summary === 'object' ? data.summary : summarizeGroups(tasks);
      render();
      scheduleRefresh();
    }).catch(function (error) {
      $('refreshNote').textContent = '刷新失败，请手动重试';
      if (timer) { clearTimeout(timer); timer = null; }
    }).finally(function () {
      refreshing = null;
    });
    return refreshing;
  }
  $('keyword').addEventListener('input', render);
  $('statusFilter').addEventListener('change', render);
  $('typeFilter').addEventListener('change', function () { page = 1; refresh(); });
  $('refreshBtn').addEventListener('click', refresh);
  $('prevPage').addEventListener('click', function () { if (page > 1) { page -= 1; refresh(); } });
  $('nextPage').addEventListener('click', function () { if (page * pageSize < total) { page += 1; refresh(); } });
  $('taskBody').addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-batch-toggle]');
    if (toggle) {
      var taskId = String(toggle.closest('tr').dataset.taskId || '');
      if (expandedBatches.has(taskId)) {
        expandedBatches.delete(taskId);
        batchChildren.delete(taskId);
        batchChildRequests.delete(taskId);
      } else {
        expandedBatches.add(taskId);
        loadBatchChildren(taskId, 1);
        return;
      }
      render(); return;
    }
    var aiDetails = event.target.closest('[data-task-ai-details]');
    if (aiDetails && aiDetails.dataset.taskAiDetails) { openAiPromptDetails(aiDetails.dataset.taskAiDetails); return; }
    var button = event.target.closest('[data-task-sku]');
    if (!button || !navigator.clipboard) return;
    navigator.clipboard.writeText(button.dataset.taskSku).then(function () {
      button.title = '完整SKU已复制';
      window.setTimeout(function () { button.title = '复制完整SKU'; }, 1600);
    });
  });
  $('aiPromptDetailsClose').addEventListener('click', closeAiPromptDetails);
  $('aiPromptDetailsDone').addEventListener('click', closeAiPromptDetails);
  $('aiPromptDetailsDialog').addEventListener('close', function () { aiPromptRequest += 1; });
  erpStorage.init(['erp_shops_data']).then(function () {
    return refresh();
  });
  document.addEventListener('erp-storage-audit-updated', function (event) {
    if (event && event.detail && event.detail.key === 'erp_shops_data') render();
  });
  window.addEventListener('storage', function (event) {
    if (window.WYERP_SYNC_STREAM && event.key === window.WYERP_SYNC_STREAM.progress.key && !timer) refreshIfRunning();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) scheduleRefresh();
    else if (!timer) refreshIfRunning();
  });
  window.addEventListener('focus', function () { if (!timer) refreshIfRunning(); });
  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin || event.source !== window.parent || !event.data) return;
    if (event.data.type === 'wyerp-product-edit-queued') { page = 1; unchangedRefreshes = 0; refresh(); return; }
    if (event.data.type === 'wyerp-workspace-activated') { refreshIfRunning(); }
  });
  window.addEventListener('beforeunload', function () { if (timer) clearTimeout(timer); });
})();
