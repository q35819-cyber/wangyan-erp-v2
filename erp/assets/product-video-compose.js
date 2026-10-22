(function () {
  'use strict';

  var dialog = document.getElementById('skuVideoEditorDialog');
  var variantBody = document.getElementById('variantBody');
  var saveButton = document.getElementById('saveBtn');
  if (!dialog || !variantBody || !window.erpStorage || typeof window.erpStorage.request !== 'function') return;

  var sessionId = (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
  var state = { rowIndex: -1, images: [], taskId: '', pollToken: 0, generatedVideoId: '', sessionId: sessionId };

  function el(id) { return document.getElementById(id); }
  function rows() { return Array.from(variantBody.querySelectorAll('tr[data-index]')); }
  function activeRow() { return rows().find(function (row) { return Number(row.dataset.index) === state.rowIndex; }) || null; }
  function field(row, name) { var input = row && row.querySelector('[data-field="' + name + '"]'); return input ? String(input.value || '').trim() : ''; }
  function privateVideoId(value) { var match = String(value || '').match(/\/api\/private-objects\/product-videos\/([0-9a-f-]{36})(?:[?#]|$)/i); return match ? match[1] : ''; }
  function isPrivateVideo(value) { return Boolean(privateVideoId(value)); }
  function safeVariantRef(value, fallback) { value = String(value || '').trim(); return /^[A-Za-z0-9._:-]{1,180}$/.test(value) ? value : fallback; }
  function target() {
    var row = activeRow(); if (!row) return null;
    var shop = el('shop') ? String(el('shop').value || '').trim() : '';
    var params = new URLSearchParams(location.search), productId = String(params.get('draftId') || params.get('productId') || '').trim() || ('session_' + state.sessionId);
    var fallbackRef = 'row_' + (state.rowIndex + 1);
    var variantRef = safeVariantRef(field(row, 'offerId') || field(row, 'sku'), fallbackRef);
    return { clientId: shop || 'session', productId: productId, variantRef: variantRef };
  }
  function privateImageId(value) { var match = String(value || '').match(/^\/api\/private-objects\/sku-images\/([0-9a-f-]{36})(?:[?#].*)?$/i); return match ? match[1] : ''; }
  function currentImageUrls() {
    var list = [];
    if (typeof window.erpProductDetailVariantImages === 'function') { try { list = window.erpProductDetailVariantImages(state.rowIndex) || []; } catch (ignored) { list = []; } }
    if (!Array.isArray(list) || !list.length) {
      var row = activeRow(); list = Array.from(row ? row.querySelectorAll('.variant-media-grid img') : []).map(function (img) { return String(img.getAttribute('src') || '').trim(); }).filter(Boolean);
      var cover = field(row, 'image'); if (cover && list.indexOf(cover) < 0) list.unshift(cover);
    }
    var seen = new Set();
    return list.map(function (item) { return typeof item === 'string' ? item.trim() : String(item && (item.url || item.src || item.file_name_url) || '').trim(); }).filter(function (url) { if (!url || seen.has(url)) return false; seen.add(url); return true; }).slice(0, 30);
  }
  function sourceOf(url) { var objectId = privateImageId(url); if (objectId) return { kind:'object', objectId:objectId }; if (/^https:\/\//i.test(String(url || ''))) return { kind:'url', url:String(url) }; return null; }
  function api(url, options) {
    return window.erpStorage.request(url, options || {}).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) { var error = new Error(data && data.message || '请求失败，请稍后重试。'); error.code = data && data.error || ''; error.status = response.status; throw error; }
        return data;
      });
    });
  }
  function setStatus(message, error) {
    var node = el('skuVideoComposeStatus'); if (!node) return; node.textContent = message || ''; node.setAttribute('data-state', error ? 'error' : 'info');
  }
  function selectedCount() { return state.images.filter(function (item) { return item.selected; }).length; }
  function ensurePanel() {
    var panel = el('skuVideoComposePanel'); if (panel) return panel;
    panel = document.createElement('section'); panel.id = 'skuVideoComposePanel'; panel.hidden = true; panel.className = 'sku-video-compose-panel';
    panel.innerHTML = '<header class="sku-video-compose-head"><div><strong>图片合成短视频</strong><small>直接使用当前页面 SKU 图片，无需先保存草稿，也不要求先有货号或 SKU 编号。</small></div><span id="skuVideoComposeCount">已选 0 张</span></header>' +
      '<div class="sku-video-compose-layout"><section class="sku-video-compose-source"><div class="sku-video-compose-section-head"><strong>选择图片</strong><span>2–8 张 · 顺序就是视频顺序</span></div><div class="sku-video-compose-grid" id="skuVideoComposeImages"></div></section>' +
      '<aside class="sku-video-compose-settings"><div class="sku-video-compose-section-head"><strong>视频参数</strong><span>8–20 秒</span></div><label><span>时长</span><select id="skuVideoComposeDuration"><option value="8">8 秒</option><option value="10" selected>10 秒</option><option value="15">15 秒</option><option value="20">20 秒</option></select></label><label><span>过渡</span><select id="skuVideoComposeTransition"><option value="cut">直接切换</option><option value="fade" selected>淡入淡出</option></select></label><label class="sku-video-compose-toggle"><input id="skuVideoComposeMotion" type="checkbox" checked><span>轻微动态</span></label><div class="sku-video-compose-actions"><button class="wy-btn wy-btn-primary" id="skuVideoComposeStart" type="button">生成短视频</button><button class="wy-btn wy-btn-ghost" id="skuVideoComposeDelete" type="button" hidden>删除本次生成</button></div></aside></div>' +
      '<p class="sku-video-compose-status" id="skuVideoComposeStatus">打开视频编辑后会读取当前页面 SKU 图片。</p>';
    var rules = el('skuVideoEditorRules'); if (rules && rules.parentNode) rules.insertAdjacentElement('afterend', panel);
    panel.addEventListener('change', function (event) { var box = event.target.closest('[data-video-image-check]'); if (!box) return; var index = Number(box.dataset.videoImageCheck); if (!state.images[index]) return; state.images[index].selected = box.checked; renderImages(); });
    panel.addEventListener('click', function (event) { var move = event.target.closest('[data-video-image-move]'); if (!move) return; event.preventDefault(); event.stopPropagation(); moveImage(Number(move.dataset.videoImageIndex), Number(move.dataset.videoImageMove)); });
    el('skuVideoComposeStart').addEventListener('click', startCompose); el('skuVideoComposeDelete').addEventListener('click', deleteGenerated); return panel;
  }
  function renderImages() {
    var grid = el('skuVideoComposeImages'); if (!grid) return; grid.replaceChildren();
    state.images.forEach(function (item, index) {
      var card = document.createElement('article'); card.className = 'sku-video-compose-card' + (item.selected ? ' on' : '');
      var check = document.createElement('input'); check.type = 'checkbox'; check.checked = item.selected; check.dataset.videoImageCheck = String(index); check.setAttribute('aria-label', '选择第' + (index + 1) + '张图片');
      var preview = document.createElement('div'); preview.className = 'sku-video-compose-preview'; var img = document.createElement('img'); img.src = item.url; img.alt = ''; img.loading = index < 6 ? 'eager' : 'lazy'; var order = document.createElement('b'); order.textContent = String(index + 1); preview.append(img, order);
      var foot = document.createElement('div'); foot.className = 'sku-video-compose-card-foot'; var label = document.createElement('span'); label.textContent = item.selected ? '已选' : '未选'; var tools = document.createElement('span'); tools.className = 'sku-video-compose-order';
      var up = document.createElement('button'); up.type = 'button'; up.textContent = '↑'; up.title = '上移'; up.dataset.videoImageMove = '-1'; up.dataset.videoImageIndex = String(index); up.disabled = index === 0;
      var down = document.createElement('button'); down.type = 'button'; down.textContent = '↓'; down.title = '下移'; down.dataset.videoImageMove = '1'; down.dataset.videoImageIndex = String(index); down.disabled = index === state.images.length - 1; tools.append(up, down); foot.append(label, tools); card.append(check, preview, foot);
      card.addEventListener('click', function (event) { if (event.target.closest('button') || event.target === check) return; check.checked = !check.checked; state.images[index].selected = check.checked; renderImages(); }); grid.appendChild(card);
    });
    var count = el('skuVideoComposeCount'); if (count) count.textContent = '已选 ' + selectedCount() + ' 张'; var start = el('skuVideoComposeStart'); if (start && !state.taskId) start.disabled = selectedCount() < 2 || selectedCount() > 8;
    if (!state.images.length) { var empty = document.createElement('p'); empty.className = 'sku-video-compose-empty'; empty.textContent = '当前 SKU 没有可用于合成的视频图片。'; grid.appendChild(empty); }
  }
  function loadImages() {
    var urls = currentImageUrls(), skipped = 0;
    state.images = urls.map(function (url, index) { var source = sourceOf(url); if (!source) { skipped += 1; return null; } return { url:url, source:source, selected:index < Math.min(8, urls.length) }; }).filter(Boolean); renderImages();
    if (state.images.length >= 2) setStatus('已读取当前页面 ' + state.images.length + ' 张 SKU 图片；默认选择前 ' + Math.min(8, state.images.length) + ' 张，可直接勾选和调整顺序。' + (skipped ? ' 另有 ' + skipped + ' 张本地临时图暂不支持直接合成。' : ''));
    else setStatus('当前 SKU 至少需要 2 张可读取图片才能生成视频。', true);
  }
  function moveImage(index, direction) { if (!Number.isInteger(index) || !state.images[index]) return; var next = index + (direction < 0 ? -1 : 1); if (next < 0 || next >= state.images.length) return; var moved = state.images.splice(index, 1)[0]; state.images.splice(next, 0, moved); renderImages(); }
  function previewGenerated(url) {
    var input = el('skuVideoUrlInput'); if (!input) return; input.value = url; input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function poll(taskId, token) {
    if (token !== state.pollToken || !dialog.open) return;
    api('/api/domain/queries/product-video-compose?taskId=' + encodeURIComponent(taskId)).then(function (data) {
      if (token !== state.pollToken) return; var task = data && data.task || {}, result = task.result;
      if (task.state === 'done' && result && result.url) {
        state.generatedVideoId = String(result.videoId || ''); state.taskId = ''; previewGenerated(String(result.url));
        el('skuVideoComposeStart').disabled = selectedCount() < 2; el('skuVideoComposeDelete').hidden = !state.generatedVideoId;
        setStatus('视频已生成：' + result.durationSeconds + ' 秒 · ' + result.width + '×' + result.height + '。点击下方“确认”后写回当前页面；无需提前保存草稿。'); return;
      }
      if (['failed','cancelled','unknown'].indexOf(task.state) >= 0) { state.taskId = ''; el('skuVideoComposeStart').disabled = false; setStatus('视频合成未完成，请到任务中心查看失败原因后重试。', true); return; }
      setStatus(task.state === 'retry' ? '本次合成暂时失败，服务器正在自动重试…' : '视频正在后台合成，可继续停留本页查看进度…');
      setTimeout(function () { poll(taskId, token); }, 1200);
    }).catch(function (error) { if (token !== state.pollToken) return; el('skuVideoComposeStart').disabled = false; setStatus(error.message || '读取视频合成进度失败，请稍后重试。', true); });
  }
  function startCompose() {
    var current = target(); if (!current) { setStatus('当前 SKU 行不可用，请重新打开视频编辑。', true); return; }
    var selected = state.images.filter(function (item) { return item.selected; });
    if (selected.length < 2 || selected.length > 8) { setStatus('请选择 2 到 8 张商品图片。', true); return; }
    el('skuVideoComposeStart').disabled = true; el('skuVideoComposeDelete').hidden = true; state.generatedVideoId = '';
    var payload = Object.assign({}, current, { imageSources: selected.map(function (item) { return item.source; }), durationSeconds: Number(el('skuVideoComposeDuration').value) || 10, transition: el('skuVideoComposeTransition').value === 'fade' ? 'fade' : 'cut', motion: el('skuVideoComposeMotion').checked });
    setStatus('正在提交视频合成任务…');
    api('/api/domain/commands/product-video-compose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(function (data) {
      state.taskId = data && data.task && data.task.id || ''; if (!state.taskId) throw new Error('服务器未返回视频合成任务编号。');
      var token = ++state.pollToken; poll(state.taskId, token);
    }).catch(function (error) { state.taskId = ''; el('skuVideoComposeStart').disabled = false; setStatus(error.message || '视频合成任务提交失败，请稍后重试。', true); });
  }
  function deleteGenerated() {
    var id = state.generatedVideoId || privateVideoId(el('skuVideoUrlInput') && el('skuVideoUrlInput').value); if (!id) return;
    var button = el('skuVideoComposeDelete'); button.disabled = true;
    api('/api/domain/commands/product-video-compose/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
      state.generatedVideoId = ''; if (isPrivateVideo(el('skuVideoUrlInput').value)) previewGenerated(''); button.hidden = true; setStatus('本次生成视频已删除。');
    }).catch(function (error) { setStatus(error.message || '删除已生成视频失败，请稍后重试。', true); }).finally(function () { button.disabled = false; });
  }
  function activateFromTrigger(trigger) {
    var row = trigger && trigger.closest('tr[data-index]'); if (!row) return; state.rowIndex = Number(row.dataset.index); state.pollToken++; state.taskId = ''; state.images = [];
    var mode = String(trigger.dataset.videoMedia || ''); var panel = ensurePanel(); panel.hidden = mode !== 'video'; if (mode !== 'video') return;
    var existing = el('skuVideoUrlInput') ? String(el('skuVideoUrlInput').value || '') : ''; state.generatedVideoId = privateVideoId(existing); el('skuVideoComposeDelete').hidden = !state.generatedVideoId;
    setTimeout(loadImages, 0);
  }
  document.addEventListener('click', function (event) { if (event.target.closest('[data-video-play]')) return; var trigger = event.target.closest('[data-video-media]'); if (trigger) activateFromTrigger(trigger); }, true);
  document.addEventListener('keydown', function (event) { if (event.key !== 'Enter' && event.key !== ' ') return; var trigger = event.target.closest('[data-video-media]'); if (trigger) activateFromTrigger(trigger); }, true);
  function pageStatus(message) { var note = el('saveState'); if (!note) return; note.textContent = message; note.classList.add('error'); }
  function composeTargetRow() {
    var all = rows(), selected = all.filter(function (row) { var box = row.querySelector('.variant-col-select input[type="checkbox"]'); return box && box.checked; });
    if (selected.length === 1) return selected[0];
    if (!selected.length && all.length === 1) return all[0];
    pageStatus(selected.length > 1 ? '图片合成视频一次只能处理一个SKU，请只勾选一个SKU。' : '请先勾选一个SKU，再点击“图片合成视频”。');
    return null;
  }
  function openComposeFromToolbar() {
    var row = composeTargetRow(); if (!row) return;
    var trigger = row.querySelector('[data-video-media="video"]'); if (!trigger) { pageStatus('当前SKU没有可用的视频编辑入口。'); return; }
    trigger.click();
  }
  var toolbarEntry = el('composeVariantVideoBtn'); if (toolbarEntry) toolbarEntry.addEventListener('click', openComposeFromToolbar);
  dialog.addEventListener('close', function () { state.pollToken++; state.taskId = ''; });
  if (saveButton) saveButton.addEventListener('click', function (event) {
    var privateInput = Array.from(variantBody.querySelectorAll('[data-field="video"]')).find(function (input) { return isPrivateVideo(input.value); });
    if (!privateInput) return; event.preventDefault(); event.stopImmediatePropagation();
    var note = el('saveState'); if (note) { note.textContent = '本地生成视频已安全保存在ERP；Ozon视频上传适配尚未完成真实验收，当前不会提交这个私有视频地址。'; note.classList.add('error'); }
  }, true);
})();
