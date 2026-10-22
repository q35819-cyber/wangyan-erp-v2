/* 网研ERP — BUG 反馈 */
(function () {
  'use strict';
  var KEY = 'erp_bug_reports';
  var BUG_SOURCE_KEY = 'wyerp_bug_source_route_v1';
  var reports = [];
  var selectedFiles = [];
  var accountIdentity = { kind: 'unknown', raw: '', masked: '当前账号' };
  var accountUserId = '';
  var $ = function (id) { return document.getElementById(id); };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
    });
  }
  function clean(value, maximum) { return String(value == null ? '' : value).trim().slice(0, maximum); }
  function trustedMessage(value, fallback) {
    var message = typeof value === 'string' ? value.trim() : '';
    return message.length <= 200 && /[\u3400-\u9fff]/.test(message) && !/[A-Za-z_\\/\r\n]|\b[1-5]\d{2}\b/.test(message)
      ? message : fallback;
  }
  function timeText(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '--';
    return date.toLocaleString('zh-CN', { hour12: false });
  }
  function severityText(value) { return value === 'high' ? '严重' : value === 'low' ? '轻微' : '一般'; }
  function identity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unknown', raw: '', masked: '历史未记录' };
    var masked = clean(value.masked, 160), raw = clean(value.raw, 240), kind = clean(value.kind, 40);
    return masked ? { kind: kind || 'unknown', raw: raw, masked: masked } : { kind: 'unknown', raw: '', masked: '历史未记录' };
  }
  function normalize(item) {
    item = item && typeof item === 'object' ? item : {};
    return {
      id: clean(item.id, 80), title: clean(item.title, 120), module: clean(item.module, 40) || '其他',
      severity: ['high', 'medium', 'low'].indexOf(item.severity) >= 0 ? item.severity : 'medium',
      page: clean(item.page, 240), description: clean(item.description, 2000), steps: clean(item.steps, 2000),
      expected: clean(item.expected, 1000), createdByUserId: clean(item.createdByUserId, 80), createdByIdentity: identity(item.createdByIdentity),
      createdAt: item.createdAt || new Date().toISOString(), browser: clean(item.browser, 300),
      attachments: (Array.isArray(item.attachments) ? item.attachments : []).slice(0, 6).map(function (attachment) {
        return {
          id: clean(attachment && attachment.id, 80), name: clean(attachment && attachment.name, 160) || '附件',
          type: clean(attachment && attachment.type, 80), size: Math.max(0, Number(attachment && attachment.size) || 0),
          url: clean(attachment && attachment.url, 360)
        };
      }).filter(function (attachment) { return attachment.id && attachment.url; })
    };
  }
  function attachmentHtml(item) {
    if (!item.attachments.length) return '';
    return '<div class="bug-attachments">' + item.attachments.map(function (attachment) {
      var title = esc(attachment.name + ' · ' + sizeText(attachment.size));
      if (attachment.type.indexOf('image/') === 0) return '<a class="bug-attachment" href="' + esc(attachment.url) + '" target="_blank" rel="noopener" title="' + title + '"><img src="' + esc(attachment.url) + '" alt="' + esc(attachment.name) + '"></a>';
      return '<div class="bug-attachment video" title="' + title + '"><video controls preload="metadata" src="' + esc(attachment.url) + '"></video></div>';
    }).join('') + '</div>';
  }
  function render() {
    var keyword = clean($('keyword').value, 160).toLowerCase(), severity = $('severityFilter').value;
    $('totalCount').textContent = reports.length;
    $('highCount').textContent = reports.filter(function (item) { return item.severity === 'high'; }).length;
    $('mineCount').textContent = reports.filter(function (item) { return accountUserId && item.createdByUserId === accountUserId; }).length;
    var rows = reports.filter(function (item) {
      if (severity && item.severity !== severity) return false;
      if (!keyword) return true;
      return [item.title, item.module, item.description, item.steps, item.expected, item.createdByIdentity.raw, item.createdByIdentity.masked, item.page]
        .join(' ').toLowerCase().indexOf(keyword) >= 0;
    });
    $('bugList').innerHTML = rows.length ? rows.map(function (item) {
      return '<article class="bug-item"><div class="bug-title-row"><div class="bug-title list-ellipsis list-ellipsis-lg" title="' + esc(item.title) + '">' + esc(item.title) + '</div><span class="bug-id">' + esc(item.id) + '</span></div>' +
        '<div class="bug-tags"><span class="badge severity-' + item.severity + '">' + severityText(item.severity) + '</span><span class="badge badge-gray">' + esc(item.module) + '</span></div>' +
        '<div class="bug-text">' + esc(item.description) + '</div>' +
        (item.steps ? '<div class="bug-text"><b>复现步骤：</b>' + esc(item.steps) + '</div>' : '') +
        (item.expected ? '<div class="bug-text"><b>期望结果：</b>' + esc(item.expected) + '</div>' : '') + attachmentHtml(item) +
        '<div class="bug-meta"><span class="username-ellipsis" title="' + esc(item.createdByIdentity.raw || item.createdByIdentity.masked) + '">提交用户：' + esc(item.createdByIdentity.masked) + '</span><span>提交时间：' + esc(timeText(item.createdAt)) + '</span>' +
        (item.page ? '<span class="list-ellipsis" title="' + esc(item.page) + '">问题页面：' + esc(item.page) + '</span>' : '') + '</div></article>';
    }).join('') : '<div class="bug-empty">暂无符合条件的 BUG 反馈</div>';
  }
  function save() { return window.erpStorage.set(KEY, reports); }
  function sizeText(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }
  function renderSelectedFiles() {
    $('selectedFiles').innerHTML = selectedFiles.map(function (file, index) {
      return '<div class="selected-file"><span class="selected-file-name" title="' + esc(file.name) + '">' + esc(file.name) + '</span><span class="selected-file-size">' + sizeText(file.size) + '</span><button class="remove-file" type="button" data-file-index="' + index + '" title="移除附件">×</button></div>';
    }).join('');
    $('uploadStatus').textContent = selectedFiles.length ? '已选择 ' + selectedFiles.length + ' 个附件，提交 BUG 时上传到服务器。' : '';
    $('uploadStatus').classList.remove('error');
  }
  function validateFile(file) {
    var image = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(file.type) >= 0;
    var video = ['video/mp4', 'video/webm', 'video/quicktime'].indexOf(file.type) >= 0;
    if (!image && !video) return '不支持“' + file.name + '”的文件格式';
    if (image && file.size > 10 * 1024 * 1024) return '图片“' + file.name + '”超过 10MB';
    if (video && file.size > 100 * 1024 * 1024) return '视频“' + file.name + '”超过 100MB';
    return '';
  }
  function addFiles(fileList) {
    var incoming = Array.prototype.slice.call(fileList || []), message = '';
    incoming.forEach(function (file) {
      if (selectedFiles.length >= 6) { message = '每条反馈最多上传 6 个附件'; return; }
      var error = validateFile(file);
      if (error) { message = error; return; }
      selectedFiles.push(file);
    });
    renderSelectedFiles();
    if (message) { $('uploadStatus').textContent = message; $('uploadStatus').classList.add('error'); }
  }
  function uploadFile(reportId, file) {
    var url = '/api/bug-attachments?reportId=' + encodeURIComponent(reportId) + '&name=' + encodeURIComponent(file.name);
    return window.erpStorage.request(url, { method: 'POST', headers: { 'Content-Type': file.type }, body: file }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          throw new Error(trustedMessage(data.message, '附件上传失败，请重新选择图片或视频后再试。'));
        }
        return data.attachment;
      });
    }, function () { throw new Error('附件上传失败，请检查网络连接后重试。'); });
  }
  function notifyDeveloper(reportId) {
    return window.erpStorage.request('/api/bug-reports/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportId: reportId })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) throw new Error(trustedMessage(data.message, '通知开发人员失败，请稍后重试。'));
        return data.email || {};
      });
    });
  }
  function normalizeSourcePage(value) {
    try {
      var source = new URL(String(value || ''), location.origin);
      if (source.origin !== location.origin) return '';
      if (/\/workspace\.html$/i.test(source.pathname)) {
        return normalizeSourcePage(source.searchParams.get('open'));
      }
      if (/\/bug-feedback\.html$/i.test(source.pathname)) return '';
      source.searchParams.delete('workspace');
      return source.pathname + source.search + source.hash;
    } catch (error) { return ''; }
  }
  function setSourcePage(value) {
    var requested = new URLSearchParams(location.search).get('source');
    var stored = '';
    try { stored = sessionStorage.getItem(BUG_SOURCE_KEY) || ''; } catch (error) {}
    var source = normalizeSourcePage(value || requested || stored || document.referrer);
    if (source) $('bugPage').value = source;
  }
  function prefillFromQuery() {
    var params = new URLSearchParams(location.search);
    var title = clean(params.get('title'), 120);
    var description = clean(params.get('description'), 2000);
    if (title && !$('bugTitle').value.trim()) $('bugTitle').value = title;
    if (description && !$('bugDescription').value.trim()) $('bugDescription').value = description;
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin || event.source !== window.parent || !event.data || event.data.type !== 'wyerp-bug-source') return;
    setSourcePage(event.data.route);
  });

  $('bugFiles').addEventListener('change', function () {
    addFiles(this.files);
    this.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (name) {
    $('uploadBox').addEventListener(name, function (event) { event.preventDefault(); this.classList.add('dragging'); });
  });
  ['dragleave', 'drop'].forEach(function (name) {
    $('uploadBox').addEventListener(name, function (event) { event.preventDefault(); this.classList.remove('dragging'); });
  });
  $('uploadBox').addEventListener('drop', function (event) { addFiles(event.dataTransfer && event.dataTransfer.files); });
  $('selectedFiles').addEventListener('click', function (event) {
    var button = event.target.closest('[data-file-index]');
    if (!button) return;
    selectedFiles.splice(Number(button.dataset.fileIndex), 1);
    renderSelectedFiles();
  });
  $('bugForm').addEventListener('reset', function () {
    selectedFiles = [];
    renderSelectedFiles();
    setTimeout(setSourcePage, 0);
  });
  $('bugForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var title = clean($('bugTitle').value, 120), description = clean($('bugDescription').value, 2000);
    if (!title || !description) return;
    var now = new Date();
    var item = normalize({
      id: 'BUG-' + now.getTime().toString(36).toUpperCase(), title: title, module: $('bugModule').value,
      severity: $('bugSeverity').value, page: $('bugPage').value, description: description,
      steps: $('bugSteps').value, expected: $('bugExpected').value, createdByUserId: accountUserId, createdByIdentity: accountIdentity,
      createdAt: now.toISOString(), browser: navigator.userAgent
    });
    var filesToUpload = selectedFiles.slice(), emailMessage = '';
    reports.unshift(item);
    reports = reports.slice(0, 500);
    $('submitBtn').disabled = true;
    $('submitBtn').textContent = filesToUpload.length ? '正在保存…' : '提交中…';
    $('uploadStatus').textContent = filesToUpload.length ? '正在保存反馈并准备上传附件…' : '正在保存反馈…';
    save().then(function () {
      var attachments = [], failed = [];
      return filesToUpload.reduce(function (chain, file, index) {
        return chain.then(function () {
          $('submitBtn').textContent = '上传 ' + (index + 1) + '/' + filesToUpload.length;
          $('uploadStatus').textContent = '正在上传：' + file.name;
          return uploadFile(item.id, file).then(function (attachment) { attachments.push(attachment); })
            .catch(function (error) { failed.push(file.name + '：' + (error.message || '上传失败')); });
        });
      }, Promise.resolve()).then(function () {
        item.attachments = attachments;
        return attachments.length ? save() : null;
      }).then(function () {
        return notifyDeveloper(item.id).then(function (email) {
          emailMessage = email.sent ? '反馈已保存，邮件已通知开发人员。' : '反馈已保存；服务器尚未配置邮件发送，反馈记录不受影响。';
        }).catch(function () { emailMessage = '反馈已保存，但邮件通知发送失败，请稍后由管理员检查邮件配置。'; });
      }).then(function () {
        $('bugForm').reset();
        render();
        if (failed.length) {
          $('uploadStatus').textContent = emailMessage + ' 部分附件失败：' + failed.join('；');
          $('uploadStatus').classList.add('error');
        } else $('uploadStatus').textContent = emailMessage;
      });
    }).catch(function (error) {
      $('uploadStatus').textContent = '反馈保存失败：' + (error.message || '请稍后重试');
      $('uploadStatus').classList.add('error');
    }).finally(function () { $('submitBtn').disabled = false; $('submitBtn').textContent = '提交BUG'; });
  });
  $('keyword').addEventListener('input', render);
  $('severityFilter').addEventListener('change', render);

  window.erpStorage.init([KEY]).then(function () {
    accountIdentity = window.erpStorage.getCurrentIdentity ? window.erpStorage.getCurrentIdentity() : { kind: 'unknown', raw: '', masked: '当前账号' };
    accountUserId = window.erpStorage.getCurrentUserId ? String(window.erpStorage.getCurrentUserId() || '') : '';
    reports = (Array.isArray(window.erpStorage.get(KEY)) ? window.erpStorage.get(KEY) : []).map(normalize)
      .sort(function (left, right) { return Date.parse(right.createdAt) - Date.parse(left.createdAt); });
    setSourcePage();
    prefillFromQuery();
    render();
  });
})();
