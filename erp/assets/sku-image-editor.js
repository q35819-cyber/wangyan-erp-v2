'use strict';
// SKU 图片编辑器功能装配（渐进增强，不改界面）
// 数据来源优先级：服务端 sku-image-links 记录 → 平台记录 variants.images → 行内缩略图（最多3张）
// 写操作沿用功能版同一套接口：GET/POST /api/domain/commands/sku-image-links、POST sku-image-upload
// 界面一律复用验收版已有控件与隐藏钩子：不新增、不删除、不改样式。
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  if (params.get('skuStatic') === '1') return;

  function $(id) { return document.getElementById(id); }
  function status(text) { var box = $('skuImageState'); if (box) box.textContent = text; }

  // ── 编辑器弹窗统一外壳（尺寸/头部/按钮/卡片/进度条/灯箱），样式在 assets/sku-image-editor.css ──
  function wyEl(tag, className) { var node = document.createElement(tag); if (className) node.className = className; return node; }
  // 统一弹窗外壳：size=lg（功能弹窗 1080×86vh）/ md / sm
  function wyShell(options) {
    var oldNode = document.getElementById(options.id);
    if (oldNode) oldNode.remove();
    var dialog = wyEl('dialog', 'wy-modal ' + (options.size === 'sm' ? 'wy-sm' : options.size === 'md' ? 'wy-md' : 'wy-lg'));
    dialog.id = options.id;
    var root = wyEl('div', 'wy-dlg');
    var head = wyEl('header', 'wy-dlg-head');
    var h2 = wyEl('h2', 'wy-dlg-title');
    h2.textContent = options.title || '';
    var expand = wyEl('button', 'wy-dlg-icon');
    expand.type = 'button'; expand.textContent = '\u26F6'; expand.setAttribute('aria-label', '全屏或还原弹窗');
    expand.addEventListener('click', function () { dialog.classList.toggle('wy-full'); });
    var closeBtn = wyEl('button', 'wy-dlg-icon');
    closeBtn.type = 'button'; closeBtn.textContent = '\u00D7'; closeBtn.setAttribute('aria-label', options.closeLabel || '关闭弹窗');
    closeBtn.addEventListener('click', function () { dialog.close(); });
    head.append(h2, expand, closeBtn);
    if (options.noExpand) expand.remove();
    var body = wyEl('div', 'wy-dlg-body');
    if (options.bodyPad === false) body.classList.add('no-pad');
    var foot = wyEl('footer', 'wy-dlg-foot');
    root.append(head, body, foot);
    dialog.append(root);
    document.body.append(dialog);
    return {
      dialog: dialog, head: head, body: body, foot: foot, titleEl: h2,
      open: function () { if (dialog.open) return; if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); },
      close: function () { dialog.close(); }
    };
  }
  function wyBtn(text, variant) {
    var b = wyEl('button', 'wy-btn ' + (variant === 'primary' ? 'wy-btn-primary' : 'wy-btn-ghost'));
    b.type = 'button'; b.textContent = text; return b;
  }
  // 可点选大卡片：返回 {el, select, isSelected}
  function wyPick(titleText, descText, badge) {
    var card = wyEl('button', 'wy-pick');
    card.type = 'button';
    var t = wyEl('span', 't');
    if (badge) { var b = wyEl('i', 'wy-badge ' + (badge.cls || 'wy-badge-gray')); b.textContent = badge.text; t.append(document.createTextNode(titleText), b); }
    else t.textContent = titleText;
    var d = wyEl('span', 'd'); d.textContent = descText || '';
    var radio = wyEl('i', 'radio');
    card.append(t, d, radio);
    var api = { el: card, on: false, select: function (flag) { api.on = flag; card.classList.toggle('on', flag); } };
    card.addEventListener('click', function () { if (!card.classList.contains('disabled') && typeof api.onSelect === 'function') api.onSelect(); });
    return api;
  }
  function wyProgress() {
    var wrap = wyEl('div', 'wy-progress-wrap');
    var labelRow = wyEl('div', 'wy-progress-label');
    var label = wyEl('span', ''); var cnt = wyEl('span', 'cnt');
    labelRow.append(label, cnt);
    var track = wyEl('div', 'wy-progress'); var fill = document.createElement('i'); track.append(fill);
    var hint = wyEl('p', 'wy-progress-hint');
    wrap.append(labelRow, track, hint);
    return { el: wrap, hint: hint, set: function (done, total, text) { label.textContent = text || ''; cnt.textContent = done + '/' + total; fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%'; } };
  }
  function wyCheckLine(text, initial) {
    var line = wyEl('label', 'wy-checkline' + (initial ? ' on' : ''));
    var box = wyEl('i', 'box'); var span = wyEl('span', ''); span.textContent = text;
    line.append(box, span);
    var api = { el: line, value: !!initial, set: function (flag) { api.value = flag; line.classList.toggle('on', flag); } };
    line.addEventListener('click', function (e) { e.preventDefault(); if (line.dataset.locked === '1') return; api.set(!api.value); if (typeof api.onChange === 'function') api.onChange(api.value); });
    return api;
  }
  // 灯箱放大：独立顶层弹窗，Esc / 点遮罩只关灯箱，不会连带关闭业务弹窗
  function wyLightbox(src, alt) {
    var existing = document.getElementById('wySkuLightbox');
    if (existing) { try { if (existing.open) existing.close(); } catch (ignored) { void ignored; } existing.remove(); }
    var box = wyEl('dialog', 'wy-lightbox-modal'); box.id = 'wySkuLightbox';
    var img = document.createElement('img'); img.alt = alt || ''; img.src = src;
    var x = wyEl('button', 'x'); x.type = 'button'; x.textContent = '\u00D7'; x.setAttribute('aria-label', '关闭预览');
    x.addEventListener('click', function () { box.close(); });
    box.addEventListener('click', function (e) { if (e.target === box) box.close(); });
    box.addEventListener('close', function () { box.remove(); });
    box.append(x, img);
    document.body.appendChild(box);
    box.showModal();
  }

  function errorMessage(data, status2) {
    return (data && data.message) || '图片处理请求未完成（HTTP ' + (status2 || 0) + '），请稍后重试。';
  }
  function tenantScopedApiUrl(url) {
    var raw = String(url || '');
    var explicitTenant = String(params.get('tenantId') || '').trim();
    var selected = /^[0-9]+$/.test(explicitTenant) ? explicitTenant : (window.erpStorage && typeof window.erpStorage.getSelectedTenantId === 'function') ? String(window.erpStorage.getSelectedTenantId() || '') : '';
    if (!selected || !raw || raw.indexOf('/api/') !== 0) return raw;
    try {
      var parsed = new URL(raw, location.origin);
      if (parsed.origin !== location.origin) return raw;
      if (!parsed.searchParams.has('tenantId')) parsed.searchParams.set('tenantId', selected);
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (error) { return raw; }
  }
  async function api(url, options) {
    options = options || {};
    if (!window.erpStorage || typeof window.erpStorage.request !== 'function') throw new Error('存储组件未加载，无法访问服务器');
    var headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    var response = await window.erpStorage.request(tenantScopedApiUrl(url), { method: options.method || 'GET', headers: headers, body: options.body });
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(errorMessage(data, response.status));
    return data;
  }
  function idempotencyKey(action) {
    return 'sku-image-' + action + '-' + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
  }

  function variantRows() { return Array.prototype.slice.call(document.querySelectorAll('#variantBody tr[data-index]')); }
  function rowAt(index) { return variantRows().filter(function (row) { return Number(row.dataset.index) === Number(index); })[0] || null; }
  function fieldValue(row, name) { var input = row && row.querySelector('[data-field="' + name + '"]'); return input ? String(input.value || '').trim() : ''; }
  function normalizeImageEntry(entry) {
    if (typeof entry === 'string') return entry.trim();
    if (entry && typeof entry === 'object') return String(entry.file_name_url || entry.url || entry.src || entry.big_url || '').trim();
    return '';
  }
  function recordsOf(key) { try { var value = window.erpStorage && window.erpStorage.get(key, []); return Array.isArray(value) ? value : []; } catch (error) { return []; } }
  function productDataOf(record) {
    if (!record || typeof record !== 'object') return null;
    if (record.payload && typeof record.payload === 'object') return record.payload;
    if (record.product && typeof record.product === 'object') return record.product;
    return record;
  }
  function productIdOf(data) { return String(data && (data.productId || data.product_id || data.id || data.draftId || data.draft_id) || '').trim(); }
  function selectedShopId() { return String($('shop') && $('shop').value || '').trim(); }
  function productShopId(data, record) {
    return String(data && (data.clientId || data.client_id || data.shopId || data.shop_id || data.shop) || record && (record.clientId || record.client_id || record.shopId || record.shop_id || record.shop) || '').trim();
  }
  function variantMatchesRow(variant, row) {
    var sku = fieldValue(row, 'sku'), offer = fieldValue(row, 'offerId');
    var vsku = String(variant && variant.sku || '').trim();
    var voffer = String(variant && (variant.offerId || variant.article) || '').trim();
    // 同时有 SKU 和货号时两项都必须一致，避免任一字段巧合相同而取到另一变体。
    return Boolean((sku || offer) && (!sku || vsku === sku) && (!offer || voffer === offer));
  }
  function productMatchesRow(data, row) {
    var variants = Array.isArray(data && data.variants) ? data.variants : [];
    return variants.some(function (variant) { return variantMatchesRow(variant, row); });
  }
  // 真实商品页的标题等字段可能尚未挂到编辑控件；优先使用已加载的当前商品记录，DOM 只作补充。
  function currentProductData(row) {
    var pageProductId = (params.get('productId') || params.get('draftId') || '').trim();
    var best = null;
    ['erp_online_products', 'erp_product_drafts'].some(function (key) {
      return recordsOf(key).some(function (record) {
        var data = productDataOf(record);
        if (!data) return false;
        var shop = selectedShopId();
        if (!shop || productShopId(data, record) !== shop) return false;
        if (pageProductId ? productIdOf(data) === pageProductId : productMatchesRow(data, row)) { best = data; return true; }
        return false;
      });
    });
    return best;
  }
  function storedImagesFor(row) {
    return platformSnapshotFor(row).map(function (item) { return item.url; });
  }
  // 已有商品的图片快照必须从当前页面对应的商品和变体读取。不能用页面行号或其它商品的同名 SKU
  // 猜测来源，否则确认导入时会被服务端的来源校验拒绝，甚至会关联到错误变体。
  function platformSnapshotFor(row) {
    var product = currentProductData(row);
    var variants = Array.isArray(product && product.variants) ? product.variants : [];
    var variantIndex = -1;
    variants.some(function (variant, index) {
      if (!variantMatchesRow(variant, row)) return false;
      variantIndex = index;
      return true;
    });
    if (variantIndex < 0) return [];
    var source = variants[variantIndex] || {};
    var urls = [];
    function append(value) {
      var url = normalizeImageEntry(value);
      if (url && urls.indexOf(url) < 0) urls.push(url);
    }
    // 平台封面必须保持在第一位；其余图片维持同步快照原有顺序。
    append(source.image || source.primary_image || source.img);
    (Array.isArray(source.images) ? source.images : []).forEach(append);
    return urls.slice(0, 30).map(function (url, sourceIndex) {
      return {
        url: url,
        platformSnapshot: true,
        pendingImportSource: {
          sourceType: 'online', sourceId: String(sourceIndex),
          sourceVariantIndex: String(variantIndex), sourceUrl: url
        }
      };
    });
  }
  function imageIdentity(item) {
    // 私有转存图没有可反查的平台原始 URL，不能拿缩略图内容或文件名猜测同源。
    // 只对明确给出的同一 URL 去重，剩余项保持两种来源，避免误删已有编辑图。
    return String(item && (item.sourceUrl || item.originalUrl || item.url || item.preview) || '').trim();
  }
  function platformSourceRef(item) {
    var source = item && (item.pendingImportSource || item.pendingImport);
    return source && source.sourceType === 'online'
      ? 'online:' + String(source.sourceVariantIndex) + ':' + String(source.sourceId)
      : '';
  }
  function ensureLocalImageKey(item) {
    if (!item) return '';
    if (!item.localImageKey) item.localImageKey = 'img-' + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
    return item.localImageKey;
  }
  function imageOrderToken(item) {
    return String(item && item.id || platformSourceRef(item) || imageIdentity(item) || ensureLocalImageKey(item));
  }
  function currentImageOrderSignature() {
    return linkItems.map(imageOrderToken).join('|');
  }
  function aiSourceTarget(item, target) {
    if (!item || !target) return null;
    if (item.id && Number.isInteger(Number(item.associationVersion))) return Object.assign({}, target, { linkId: item.id, associationVersion: Number(item.associationVersion) });
    var source = item.pendingImportSource || item.pendingImport;
    if (source && source.sourceType === 'online') return Object.assign({}, target, {
      sourceType: 'online', sourceVariantIndex: String(source.sourceVariantIndex), sourceId: String(source.sourceId), sourceUrl: String(source.sourceUrl || item.url || '')
    });
    return null;
  }
  function mergePlatformSnapshot(serverItems, snapshotItems) {
    var known = {};
    (serverItems || []).forEach(function (item) { var url = imageIdentity(item); if (url) known[url] = true; });
    var merged = (serverItems || []).slice(0, 30);
    (snapshotItems || []).forEach(function (item) {
      var url = imageIdentity(item);
      if (!url || known[url] || merged.length >= 30) return;
      known[url] = true;
      merged.push(item);
    });
    return merged;
  }
  function stagePlatformImport(item) {
    if (!item || !item.platformSnapshot) return true;
    if (!item.pendingImportSource) {
      status('这张平台快照缺少可核对的来源信息，不能保存为编辑图片；服务器关联保持不变');
      return false;
    }
    item.pendingImport = Object.assign({}, item.pendingImportSource);
    item.platformSnapshot = false;
    return true;
  }
  function targetOf(row) {
    var shop = $('shop') ? String($('shop').value || '').trim() : '';
    var sku = fieldValue(row, 'sku'), offer = fieldValue(row, 'offerId');
    if (!shop || (!sku && !offer)) return null;
    // 商品目标必须来自页面上下文：草稿页用 draftId，编辑页用当前商品 id（URL productId）。
    // 不能拿变体 sku 当商品 id——真实 Ozon 商品 id（payload.id）与变体 sku 是不同编号，服务端按商品 id 校验会 404。
    var draftId = (params.get('draftId') || '').trim();
    var pageProductId = (params.get('productId') || '').trim();
    var productId = draftId || pageProductId || productIdOf(currentProductData(row));
    if (!productId) return null;
    return { clientId: shop, productId: productId, variantRef: offer || sku };
  }
  function targetError(row) {
    if (!$('shop') || !String($('shop').value || '').trim()) return '请先选择当前商品的上架店铺，再解析卖点';
    if (!row || (!fieldValue(row, 'sku') && !fieldValue(row, 'offerId'))) return '当前变体编号缺失，无法定位已保存的图片关联';
    return '当前商品尚未保存或图片关联未加载，无法定位商品、店铺和变体；请保存后重新打开图片编辑';
  }
  function linksUrl() { return '/api/domain/queries/sku-image-links'; }
  // 系统管理员跨租户管理时，私有对象读取必须带选中租户，否则服务端按会话租户（管理员自身租户）查不到图。
  function imageUrlOf(item) {
    // 图片处理弹窗“确认”后只在浏览器本地替换：卡片、放大、预览、再次处理都优先用本地处理结果
    if (item && item.localBlobUrl) return item.localBlobUrl;
    var url = String((item && (item.url || item.preview)) || '');
    if (!url || url.indexOf('/api/private-objects/') !== 0) return url;
    var selected = (typeof window.erpStorage.getSelectedTenantId === 'function') ? window.erpStorage.getSelectedTenantId() : '';
    if (!selected) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'tenantId=' + encodeURIComponent(selected);
  }

  function previewUrlOf(item) {
    var url = imageUrlOf(item);
    if (!url || item && item.localBlobUrl || !item.width || !item.height || url.indexOf('/api/private-objects/sku-images/') !== 0) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'preview=1';
  }
  // 卡片预览只读 360px 私有缩略图；浏览器仅做当前页面内存复用，不写 Cache Storage / IndexedDB。
  // 列表超过首屏时由 IntersectionObserver 按可视区域加载，放大、裁剪和图片处理继续读取高清原图。
  var previewLoadQueue = [], previewLoadsActive = 0, previewRenderGeneration = 0;
  var previewObserver = null, previewBlobCache = new Map(), previewBlobRequests = new Map(), previewMemoryScope = null;
  var PREVIEW_LOAD_CONCURRENCY = 4, PREVIEW_LOAD_TIMEOUT_MS = 5000, PREVIEW_MEMORY_LIMIT = 80;
  function drainPreviewLoads() {
    while (previewLoadsActive < PREVIEW_LOAD_CONCURRENCY && previewLoadQueue.length) {
      previewLoadsActive += 1;
      previewLoadQueue.shift()(function () { previewLoadsActive -= 1; drainPreviewLoads(); });
    }
  }
  function queuePreviewLoad(start) { previewLoadQueue.push(start); drainPreviewLoads(); }
  function clearPreviewMemoryCache() {
    previewBlobCache.forEach(function (url) { try { URL.revokeObjectURL(url); } catch (ignored) { void ignored; } });
    previewBlobCache.clear();
    previewBlobRequests.clear();
    previewMemoryScope = null;
  }
  window.addEventListener('pagehide', clearPreviewMemoryCache);
  function ensurePreviewMemoryScope() {
    var scope = (window.erpStorage && typeof window.erpStorage.getSelectedTenantId === 'function') ? String(window.erpStorage.getSelectedTenantId() || '') : '';
    if (previewMemoryScope !== null && previewMemoryScope !== scope) clearPreviewMemoryCache();
    previewMemoryScope = scope;
  }
  function isPrivatePreviewUrl(src) {
    return /^\/api\/private-objects\/sku-images\/[0-9a-f-]{36}(?:\?|$)/i.test(String(src || '')) && /(?:\?|&)preview=1(?:&|$)/.test(String(src || ''));
  }
  function rememberPreviewBlob(key, url) {
    if (previewBlobCache.has(key)) {
      try { URL.revokeObjectURL(url); } catch (ignored) { void ignored; }
      return previewBlobCache.get(key);
    }
    previewBlobCache.set(key, url);
    while (previewBlobCache.size > PREVIEW_MEMORY_LIMIT) {
      var oldest = previewBlobCache.keys().next().value;
      var oldUrl = previewBlobCache.get(oldest);
      previewBlobCache.delete(oldest);
      try { URL.revokeObjectURL(oldUrl); } catch (ignored2) { void ignored2; }
    }
    return url;
  }
  function resolveCardPreviewSrc(src) {
    src = String(src || '');
    if (!isPrivatePreviewUrl(src) || !window.erpStorage || typeof window.erpStorage.request !== 'function') return Promise.resolve(src);
    ensurePreviewMemoryScope();
    if (previewBlobCache.has(src)) return Promise.resolve(previewBlobCache.get(src));
    if (previewBlobRequests.has(src)) return previewBlobRequests.get(src);
    var request = window.erpStorage.request(src, { method: 'GET' }).then(function (response) {
      if (!response || !response.ok) throw new Error('缩略图读取失败');
      return response.blob();
    }).then(function (blob) {
      if (!blob || !String(blob.type || '').startsWith('image/')) throw new Error('缩略图格式不正确');
      return rememberPreviewBlob(src, URL.createObjectURL(blob));
    }).finally(function () { previewBlobRequests.delete(src); });
    previewBlobRequests.set(src, request);
    return request;
  }
  function previewIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return null;
    if (!previewObserver) previewObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        previewObserver.unobserve(entry.target);
        var start = entry.target.__wyPreviewStart;
        entry.target.__wyPreviewStart = null;
        if (start) start();
      });
    }, { root: null, rootMargin: '280px 0px' });
    return previewObserver;
  }
  function imageDimensionText(item) {
    return item.width && item.height
      ? item.width + '×' + item.height + (item.extension ? ' · ' + String(item.extension).replace('.', '').toUpperCase() : '')
      : '读取中…';
  }
  function loadCardPreview(image, size, item, src, generation) {
    function retryLabel(kind) {
      if (generation !== previewRenderGeneration) return;
      size.textContent = kind === 'timeout' ? '图片读取超时，点击重试' : '图片加载失败，点击重试';
      size.title = '点击重新读取这张图片';
      size.onclick = function (event) { event.stopPropagation(); size.onclick = null; loadCardPreview(image, size, item, src, generation); };
    }
    size.textContent = imageDimensionText(item);
    size.title = '';
    size.onclick = null;
    if (!src) { retryLabel('error'); return; }
    queuePreviewLoad(function (release) {
      if (generation !== previewRenderGeneration) { release(); return; }
      var settled = false, timeout = 0;
      var originalSrc = imageUrlOf(item);
      function finish(kind) {
        if (settled) return;
        settled = true;
        if (timeout) window.clearTimeout(timeout);
        image.onload = image.onerror = null;
        if (generation !== previewRenderGeneration) { release(); return; }
        if (kind === 'load') {
          if (!item.width || !item.height) { item.width = image.naturalWidth || 0; item.height = image.naturalHeight || 0; }
          size.textContent = imageDimensionText(item);
          size.title = '';
          size.onclick = null;
        } else retryLabel(kind);
        release();
      }
      function attach(resolved, fallback) {
        if (settled || generation !== previewRenderGeneration) return;
        image.onload = function () { finish('load'); };
        image.onerror = function () {
          image.onload = image.onerror = null;
          if (!fallback && originalSrc && originalSrc !== src) { attach(originalSrc, true); return; }
          finish('error');
        };
        image.src = resolved;
        if (image.complete) window.setTimeout(function () { if (!settled && image.naturalWidth) finish('load'); }, 0);
      }
      timeout = window.setTimeout(function () { finish('timeout'); }, PREVIEW_LOAD_TIMEOUT_MS);
      resolveCardPreviewSrc(src).then(function (resolved) { attach(resolved, false); }).catch(function () {
        if (originalSrc && originalSrc !== src) attach(originalSrc, true); else finish('error');
      });
    });
  }
  function scheduleCardPreview(image, size, item, src, index, generation) {
    var start = function () { loadCardPreview(image, size, item, src, generation); };
    if (index < 6) { start(); return; }
    var observer = previewIntersectionObserver();
    if (!observer) { start(); return; }
    image.__wyPreviewStart = start;
    observer.observe(image);
  }
  function setPreviewBackground(node, item) {
    var previewSrc = previewUrlOf(item), originalSrc = imageUrlOf(item);
    if (!previewSrc) return;
    resolveCardPreviewSrc(previewSrc).then(function (resolved) {
      if (node && node.isConnected) node.style.backgroundImage = cssUrl(resolved);
    }).catch(function () {
      if (node && node.isConnected && originalSrc) node.style.backgroundImage = cssUrl(originalSrc);
    });
  }
  var COLLECTION_STORE_KEY = 'erp_collected_products';
  var openedIndex = -1;
  var linkItems = [], removedIds = [], history = [], future = [];
  var savedOrderIds = '';
  var pendingCopies = [];
  var imageSource = '';
  var SKU_FIXED_IMAGE_ROLES = ['主图', '卖点', '富内容主视觉', '细节', '尺寸', '补充'];
  function firstSkuUsesFixedRoles() { return Number(openedIndex) === 0; }
  function fixedRoleAt(index) { return firstSkuUsesFixedRoles() && index >= 0 && index < SKU_FIXED_IMAGE_ROLES.length ? SKU_FIXED_IMAGE_ROLES[index] : ''; }
  function isFixedRoleIndex(index) { return Boolean(fixedRoleAt(index)); }

  function pushHistory() {
    history.push({ items: linkItems.map(function (item) { return Object.assign({}, item); }), removed: removedIds.slice() });
    if (history.length > 40) history.shift();
    future.length = 0;
  }
  function undoLocal() { undo(); }
  function undo() {
    if (!history.length) { status('没有可撤销的操作'); return; }
    future.push({ items: linkItems.map(function (item) { return Object.assign({}, item); }), removed: removedIds.slice() });
    var snapshot = history.pop();
    linkItems = snapshot.items; removedIds = snapshot.removed;
    render();
    status('已撤销一步（仅恢复本次编辑内的列表）');
  }
  function redo() {
    if (!future.length) { status('没有可重做的操作'); return; }
    history.push({ items: linkItems.map(function (item) { return Object.assign({}, item); }), removed: removedIds.slice() });
    var snapshot = future.pop();
    linkItems = snapshot.items; removedIds = snapshot.removed;
    render();
    status('已重做一步');
  }
  // 勾选结果同时给出“服务端关联 id”和“当前列表下标”：列表来自平台记录时没有 id，也要能正常删除与下载
  function selection() {
    var grid = $('skuImageGrid');
    if (!grid) return { ids: [], indexes: [], total: 0 };
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.sku-image-card'));
    var ids = [], indexes = [];
    cards.forEach(function (card, position) {
      var box = card.querySelector('input[type="checkbox"]');
      if (box && box.checked) { indexes.push(position); if (card.dataset.linkId) ids.push(card.dataset.linkId); }
    });
    return { ids: ids, indexes: indexes, total: cards.length };
  }
  // 单张图片卡片上的“编辑⌄”菜单传入 {singleIndex}：无论外面勾选了多少张，只作用于这一张；
  // 批量菜单（全选旁）不传 scope，按勾选结果走。
  function scopeIndexes(scope) {
    if (scope && Number.isInteger(scope.singleIndex) && scope.singleIndex >= 0 && linkItems[scope.singleIndex]) return [scope.singleIndex];
    return selection().indexes;
  }
  function recount() {
    var box = $('skuImageCount'), grid = $('skuImageGrid');
    if (box && grid) box.textContent = String(grid.querySelectorAll('.sku-image-card').length);
  }
  // ── 拖拽排序：前 6 个业务槽位固定；第 7 张以后才允许自由排序。换位后只有点商品页“保存草稿”或“确定编辑”才写回 ──
  var dragFrom = -1;
  function bindCardDrag(card, index) {
    if (isFixedRoleIndex(index)) {
      card.draggable = false;
      card.title = '固定槽位：' + fixedRoleAt(index) + '。可替换当前图，但不能拖动改变角色';
      return;
    }
    if (!firstSkuUsesFixedRoles() && index === 0) {
      card.draggable = false;
      card.title = '当前SKU主图固定第1位；第2张以后可拖动排序';
      return;
    }
    card.draggable = true;
    card.title = firstSkuUsesFixedRoles() ? '第7张以后为自由图片，可拖动调整顺序' : '第2张以后可拖动调整顺序';
    card.addEventListener('dragstart', function (event) {
      dragFrom = index;
      card.classList.add('is-dragging');
      if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; try { event.dataTransfer.setData('text/plain', String(index)); } catch (error) { void error; } }
    });
    card.addEventListener('dragend', function () { card.classList.remove('is-dragging'); dragFrom = -1; });
    card.addEventListener('dragover', function (event) {
      if (dragFrom < 0 || dragFrom === index) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    });
    card.addEventListener('drop', function (event) {
      event.preventDefault();
      if (dragFrom < 0 || dragFrom === index) return;
      if (firstSkuUsesFixedRoles()) {
        if (dragFrom < SKU_FIXED_IMAGE_ROLES.length || index < SKU_FIXED_IMAGE_ROLES.length) return;
      } else if (dragFrom === 0 || index === 0) return;
      pushHistory();
      var moved = linkItems.splice(dragFrom, 1)[0];
      linkItems.splice(index, 0, moved);
      render();
      status(firstSkuUsesFixedRoles()
        ? '已把自由图片移到第 ' + (index + 1) + ' 位；第一SKU前6个固定槽位未改变，点商品页“保存草稿”或“确定编辑”前不提交服务器'
        : '已把图片移到第 ' + (index + 1) + ' 位；当前SKU主图仍固定第1位，点商品页“保存草稿”或“确定编辑”前不提交服务器');
    });
  }
  function render() {
    var grid = $('skuImageGrid');
    if (!grid) return;
    if (aiRunState && aiRunState.analysisProof && aiRunState.proofScope !== redrawProofScope()) invalidateRedrawProof();
    var renderGeneration = ++previewRenderGeneration;
    previewLoadQueue.length = 0;
    if (previewObserver) previewObserver.disconnect();
    grid.replaceChildren();
    if (!linkItems.length) {
      var empty = document.createElement('p');
      empty.className = 'sku-source-placeholder';
      empty.textContent = '这个SKU还没有已转存的图片：可以先上传，界面与按钮保持原样';
      grid.append(empty);
      recount();
    bindSelectAll();
    syncSelectAllLabel();
      return;
    }
    linkItems.forEach(function (item, index) {
      var card = document.createElement('article');
      card.className = 'sku-image-card' + (index === 0 ? ' is-cover is-selected' : '') + (isFixedRoleIndex(index) ? ' is-fixed-role' : '');
      if (isFixedRoleIndex(index)) card.dataset.fixedRole = fixedRoleAt(index);
      if (item.id) card.dataset.linkId = item.id;
      var preview = document.createElement('div');
      preview.className = 'sku-image-preview';
      var src = previewUrlOf(item);
      var previewImage = document.createElement('img');
      previewImage.alt = '';
      previewImage.decoding = 'async';
      previewImage.fetchPriority = index < 6 ? 'high' : 'low';
      previewImage.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain';
      preview.setAttribute('role', 'img');
      preview.setAttribute('aria-label', '图片' + (index + 1));
      var size = document.createElement('span');
      size.className = 'sku-image-dimension';
      if (isFixedRoleIndex(index)) {
        var roleBadge = document.createElement('span');
        roleBadge.className = 'sku-image-role-badge';
        roleBadge.textContent = (index + 1) + ' · ' + fixedRoleAt(index);
        roleBadge.title = '固定槽位：' + fixedRoleAt(index) + '；允许替换图片，不允许换位';
        preview.appendChild(roleBadge);
      }

      var icons = document.createElement('span');
      icons.className = 'sku-card-icons';
      icons.title = '左半：放大图片　右半：移除该图';
      icons.setAttribute('aria-label', '放大或移除该图片');
      icons.textContent = '⌕ 🗑';
      icons.addEventListener('click', function (event) {
        event.stopPropagation();
        var box = icons.getBoundingClientRect();
        if (event.clientX - box.left > box.width / 2) { removeAt(index); return; }
        zoom(index);
      });
      preview.append(previewImage, size, icons);
      var foot = document.createElement('div');
      foot.className = 'sku-image-card-foot';
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.setAttribute('aria-label', '选择图片' + (index + 1));
      checkbox.addEventListener('click', function (event) {
        event.stopPropagation();
        card.classList.toggle('is-selected', checkbox.checked);
        recount();
      });
      var edit = document.createElement('button');
      edit.type = 'button';
      edit.dataset.staticTool = '编辑图片' + (index + 1);
      edit.setAttribute('aria-expanded', 'false');
      edit.textContent = '编辑⌄';
      foot.append(checkbox, edit);
      card.append(preview, foot);
      card.addEventListener('click', function (event) {
        // 点卡片只切换勾选；设为封面必须走单独的功能键（卡片“编辑⌄”菜单里的“设为封面”或工具栏按钮）
        if (event.target === icons || icons.contains(event.target)) return;
        if (event.target.closest('[data-static-tool]')) return;
        if (event.target === checkbox || checkbox.contains(event.target)) return;
        checkbox.click();
      });
      bindCardDrag(card, index);
      grid.append(card);
      scheduleCardPreview(previewImage, size, item, src, index, renderGeneration);
    });
    recount();
  }
  function fillFromRow(row) {
    var rowIndex = row && row.dataset ? Number(row.dataset.index) : -1;
    var pageImages = [];
    if (rowIndex >= 0 && typeof window.erpProductDetailVariantImages === 'function') {
      try { pageImages = window.erpProductDetailVariantImages(rowIndex) || []; } catch (ignored) { pageImages = []; }
    }
    pageImages = Array.isArray(pageImages) ? pageImages.map(function (url) { return String(url || '').trim(); }).filter(Boolean) : [];
    if (pageImages.length) { imageSource = '当前页面完整SKU图片'; linkItems = pageImages.map(function (url) { return { id: '', url: url }; }); return; }
    var stored = storedImagesFor(row);
    if (stored.length) { imageSource = '平台记录'; linkItems = stored.map(function (url) { return { id: '', url: url }; }); return; }
    var list = Array.prototype.slice.call(row.querySelectorAll('.variant-media-grid img')).map(function (image) { return image.getAttribute('src') || ''; });
    var cover = fieldValue(row, 'image');
    if (cover && list.indexOf(cover) < 0) list.unshift(cover);
    imageSource = '页面缩略图（仅兜底；完整SKU图片未加载）';
    linkItems = list.filter(Boolean).map(function (url) { return { id: '', url: url }; });
  }
  async function loadFromServer(row) {
    var target = targetOf(row);
    if (!target) { imageSource = '未选择上架店铺，读不到服务端关联'; return false; }
    var data = await fetchSkuLinks(target);
    linkItems = (Array.isArray(data.images) ? data.images : []).slice(0, 30);
    imageSource = linkItems.length ? '服务端关联记录' : '服务端关联记录（暂无已转存图片）';
    return linkItems.length > 0;
  }
  async function writeOrder(coverId) {
    if (!requireSavedForWrite()) return;
    var target = targetOf(rowAt(openedIndex));
    if (!target) throw new Error('请先选择上架店铺');
    var withIds = linkItems.filter(function (item) { return item.id; });
    if (!withIds.length) throw new Error('当前列表来自' + imageSource + '，没有服务端关联记录，不能写回顺序');
    var versions = {};
    linkItems.forEach(function (item) { if (item.id) versions[item.id] = item.associationVersion; });
    removedIds.forEach(function (id) { delete versions[id]; });
    var ids = withIds.map(function (item) { return item.id; });
    if (coverId) ids = [coverId].concat(ids.filter(function (id) { return id !== coverId; }));
    await api('/api/domain/commands/sku-image-links', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('links') }, body: JSON.stringify(Object.assign({}, target, { coverLinkId: coverId || (ids[0] || ''), linkIds: ids, linkVersions: versions })) });
  }
  async function fetchSkuLinks(target) {
    return api(linksUrl(), { method: 'POST', body: JSON.stringify(Object.assign({ action: 'read' }, target)) });
  }
  // 删除统一走“逐张解除关联”：服务端排序写回接口要求传入全部剩余关联（不能用于删除），
  // 且每删除一张剩余关联的 associationVersion 会 +1，所以每张 DELETE 前都重新读取最新版本
  async function removeLinksFromServer(target, ids) {
    if (!target) throw new Error('请先选择上架店铺');
    for (var i = 0; i < ids.length; i++) {
      var latest = await fetchSkuLinks(target);
      var victim = null;
      ((latest && latest.images) || []).forEach(function (item) { if (item.id === ids[i]) victim = item; });
      if (!victim) continue;
      await api('/api/domain/commands/sku-image-links/' + ids[i], { method: 'DELETE', headers: { 'Idempotency-Key': idempotencyKey('link-remove-' + ids[i]) }, body: JSON.stringify(Object.assign({}, target, { associationVersion: victim.associationVersion })) });
    }
  }
  // 唯一图片写服务器入口：只能由商品页“保存草稿”或“确定编辑”调用；SKU弹窗确认和图片工具只改当前页面内存。
  // 图片操作全部是本地编辑，只有这里才与服务器交互：
  //   1) 本地处理结果 → 上传为新对象并替换关联（新关联保留原位置，旧关联进删除列表）
  //   2) 被移除的关联 → 逐张 DELETE
  //   3) 顺序 + 封面 → 写回（DELETE 会让剩余关联版本 +1，先重读最新版本再写）
  function pageImageUrl(item) {
    if (!item) return '';
    return String(item.localBlobUrl || item.url || item.preview || item.sourceUrl || (item.pendingImport && item.pendingImport.sourceUrl) || (item.pendingImportSource && item.pendingImportSource.sourceUrl) || '').trim();
  }
  function applyCurrentImagesToPage() {
    if (openedIndex < 0 || typeof window.erpProductDetailApplyVariantImages !== 'function') return 0;
    return window.erpProductDetailApplyVariantImages(openedIndex, linkItems.map(pageImageUrl).filter(Boolean));
  }
  function hasPendingImageChanges() {
    return openedIndex >= 0 && Boolean(rowAt(openedIndex)) && (removedIds.length > 0 || pendingCopies.length > 0 || linkItems.some(function (item) { return item.localProcessed || item.pendingImport || item.pendingProcess; }) || currentImageOrderSignature() !== savedOrderIds);
  }
  async function flushServerChanges(commitReason) {
    if (commitReason !== 'draft' && commitReason !== 'confirm') return { ok: false, message: 'SKU图片只能通过商品页“保存草稿”或“确定编辑”提交服务器' };
    if (openedIndex < 0 || !rowAt(openedIndex)) return { ok: true, skipped: true, changed: false };
    var row = rowAt(openedIndex);
    var target = targetOf(row);
    if (!target) return { ok: false, message: '请先选择上架店铺，无法保存图片变更' };
    if (!hasPendingImageChanges()) return { ok: true, skipped: true, changed: false, variantRef: target.variantRef, clientId: target.clientId, productId: target.productId };
    if (!requireSavedForWrite()) return { ok: false, message: '请先保存当前商品草稿，再提交图片变更' };
    // 通过商品页保存时，必须把仍保留的 Ozon 平台快照一并转存，确保服务器持有完整最终图片集合。
    // 否则只保存少数已编辑图片，后续同步 Ozon 时会把未转存图片误当成已删除。
    for (var stagedIndex = 0; stagedIndex < linkItems.length; stagedIndex += 1) {
      if (linkItems[stagedIndex] && linkItems[stagedIndex].platformSnapshot && !stagePlatformImport(linkItems[stagedIndex])) {
        return { ok: false, message: '平台图片来源不完整，无法形成可安全保存的最终图片集合' };
      }
    }
    var imports = linkItems.filter(function (item) { return item.pendingImport; });
    for (var n = 0; n < imports.length; n++) {
      var imported = imports[n];
      var importedResult = await api('/api/domain/commands/sku-image-import', {
        method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('import') },
        body: JSON.stringify(Object.assign({}, target, imported.pendingImport))
      });
      if (!importedResult || !importedResult.item || !importedResult.item.linkId) throw new Error('来源图片导入后未返回图片关联');
      var importedPosition = linkItems.indexOf(imported);
      linkItems[importedPosition] = Object.assign({}, imported, importedResult.item, {
        id: importedResult.item.linkId, platformSnapshot: false, pendingImport: null,
        wmReplace: imported.localProcessed ? true : Boolean(imported.wmReplace),
        localImageKey: imported.localImageKey || ''
      });
    }
    var processes = linkItems.filter(function (item) { return item.pendingProcess; });
    for (var p = 0; p < processes.length; p++) {
      var processing = processes[p];
      var operation = processing.pendingProcess;
      var processed = await api('/api/domain/commands/sku-image-process', {
        method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('process') },
        body: JSON.stringify(Object.assign({}, target, {
          items: [{ linkId: processing.id, associationVersion: processing.associationVersion }],
          operations: operation.operations, outputFormat: operation.outputFormat,
          restoreOriginal: operation.restoreOriginal === true
        }))
      });
      var freshProcessed = processed && processed.items && processed.items[0];
      if (!freshProcessed) throw new Error('图片修复后未返回新版本，请刷新后检查');
      linkItems[linkItems.indexOf(processing)] = Object.assign({}, processing, freshProcessed, { id: freshProcessed.linkId, pendingProcess: null, localImageKey: processing.localImageKey || '' });
    }
    // 1) 本地处理结果：上传为新对象并替换关联
    var replaced = linkItems.filter(function (item) { return item.localProcessed && item.localBlob; });
    var keepLinkIds = {}; // 上传被服务器去重复用的关联，删除阶段必须保留（新图依赖该关联）
    for (var i = 0; i < replaced.length; i++) {
      var item = replaced[i];
      var blob = item.localBlob;
      var fileName = wyName(extensionOf(item));
      var file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
      var uploadParams = Object.assign({ name: fileName }, target);
      if (item.id && item.wmReplace) {
        uploadParams.linkId = item.id;
        uploadParams.associationVersion = item.associationVersion;
      }
      var ticketData = await api('/api/domain/commands/sku-image-upload-ticket', { method: 'POST', body: JSON.stringify(uploadParams) });
      if (!ticketData || !ticketData.ticket) throw new Error('图片上传准备失败，请重新保存后再试');
      var url = '/api/domain/commands/sku-image-upload?ticket=' + encodeURIComponent(ticketData.ticket);
      var response = await window.erpStorage.request(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'Idempotency-Key': idempotencyKey('replace') }, body: file });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error('处理结果上传失败：' + errorMessage(data, response.status));
      var fresh = data && data.item;
      if (!fresh || !fresh.linkId) throw new Error('处理结果上传后没有返回关联记录');
      var position = linkItems.indexOf(item);
      if (position >= 0) {
        // 注意：上传接口返回的 item.id 是对象 id，关联 id 在 item.linkId（列表字段 id 对应关联 id）
        var previousBlobUrl = item.localBlobUrl;
        linkItems[position] = Object.assign({}, item, fresh, { id: fresh.linkId, localProcessed: false, localBlob: null, localBlobUrl: '', wmReplace: false, localImageKey: item.localImageKey || '' });
        if (previousBlobUrl) { try { URL.revokeObjectURL(previousBlobUrl); } catch (ignored) { void ignored; } }
        if (item.wmReplace) {
          // 替换原图：服务端更新同一关联的对象和版本，不产生新关联，不需要删除旧关联
        } else if (!(fresh.duplicateAssociation && fresh.linkId === item.id)) {
          if (item.id) removedIds.push(item.id);
          // 上传被去重复用了服务器已有 link：该 link 不能删除，否则新图关联丢失
          if (fresh.duplicateAssociation) keepLinkIds[fresh.linkId] = true;
        }
      }
    }
    // 2) 删除被移除的关联（含被替换的旧关联；被去重复用的关联必须保留）
    var toRemove = removedIds.filter(function (id) { return !keepLinkIds[id]; });
    if (toRemove.length) await removeLinksFromServer(target, toRemove);
    removedIds.length = 0;
    // 3) 重读服务器最新版本（DELETE 会让剩余关联版本 +1，本地版本已过时）
    var latest = await fetchSkuLinks(target);
    var versionMap = {};
    ((latest && latest.images) || []).forEach(function (serverItem) { versionMap[serverItem.id] = serverItem.associationVersion; });
    linkItems.forEach(function (item) { if (item.id && versionMap[item.id] != null) item.associationVersion = versionMap[item.id]; });
    // 4) 顺序 + 封面（全删后列表为空时不需要写回）
    if (linkItems.some(function (item) { return item.id; })) await writeOrder(linkItems[0].id);
    while (pendingCopies.length) {
      var pendingCopy = pendingCopies[0];
      var copyLinkIds = Array.isArray(pendingCopy.linkIds) ? pendingCopy.linkIds.slice() : (pendingCopy.imageKeys || []).map(function (key) {
        var sourceItem = linkItems.filter(function (entry) { return entry.localImageKey === key; })[0];
        return sourceItem && sourceItem.id || '';
      }).filter(Boolean);
      if (!copyLinkIds.length || pendingCopy.imageKeys && copyLinkIds.length !== pendingCopy.imageKeys.length) throw new Error('待复制图片在保存过程中发生变化，请重新选择“添加到其它变体”');
      await api('/api/domain/commands/sku-image-copy', {
        method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('copy') },
        body: JSON.stringify(Object.assign({}, target, { linkIds: copyLinkIds, targetVariantRefs: pendingCopy.targetVariantRefs }))
      });
      pendingCopies.shift();
    }
    // 5) 写入排序与封面后再读一次，避免界面显示写序前的旧顺序。
    latest = await fetchSkuLinks(target);
    linkItems = ((latest && latest.images) || []).slice(0, 30);
    savedOrderIds = currentImageOrderSignature();
    removedIds = [];
    imageSource = linkItems.length ? '服务端关联记录' : '服务端关联记录（暂无已转存图片）';
    render();
    return { ok: true, count: linkItems.length, changed: true, commitReason: commitReason, variantRef: target.variantRef, clientId: target.clientId, productId: target.productId };
  }
  // 只允许商品页两个保存按钮调用；没有提交原因时拒绝，防止其它按钮绕过统一保存入口。
  window.wyerpSkuImage = {
    flush: function (commitReason) { return flushServerChanges(commitReason).catch(function (error) { return { ok: false, message: error && error.message ? error.message : '未知原因' }; }); },
    hasPending: hasPendingImageChanges
  };
  async function rawApi(url, options) {
    options = options || {};
    if (!window.erpStorage || typeof window.erpStorage.request !== 'function') throw new Error('存储组件未加载，无法访问服务器');
    var response = await window.erpStorage.request(url, { method: options.method || 'GET', headers: Object.assign({ 'Content-Type': 'application/json' }, options.headers || {}), body: options.body });
    var data = await response.json().catch(function () { return {}; });
    return { status: response.status, data: data };
  }

  async function run(label, work) {
    status(label);
    try { await work(); } catch (error) {
      status('失败：' + (error && error.message ? error.message : '未知原因'));
      if (error && /版本冲突/.test(error.message || '')) {
        try { await loadFromServer(rowAt(openedIndex)); render(); status('失败：图片已被其它操作更新，已重新读取最新列表，请再试一次'); } catch (ignored) { void ignored; }
      }
    }
  }
  async function removeAt(index) {
    var item = linkItems[index];
    if (!item) { status('没有可移除的图片'); return; }
    if (isFixedRoleIndex(index)) { status('第 ' + (index + 1) + ' 张是固定槽位“' + fixedRoleAt(index) + '”，不能直接删除；请用替换图片保持槽位顺序'); return; }
    pushHistory();
    if (item.id) removedIds.push(item.id);
    linkItems.splice(index, 1);
    render();
    status('已移除第 ' + (index + 1) + ' 张（本地移除，点商品页“保存草稿”或“确定编辑”后才同步服务器）');
  }
  async function deleteSelected() {
    var picked = selection();
    if (!picked.total) { status('没有可移除的图片'); return; }
    if (!picked.indexes.length) { status('请先勾选要移除的图片'); return; }
    var fixedIndexes = picked.indexes.filter(isFixedRoleIndex);
    var freeIndexes = picked.indexes.filter(function (index) { return !isFixedRoleIndex(index); });
    if (!freeIndexes.length) { status('前 6 张都是固定用途槽位，不能直接删除；请使用替换图片'); return; }
    if (fixedIndexes.length) {
      picked = { ids: picked.ids, indexes: freeIndexes, total: picked.total };
      status('已自动跳过前 6 个固定槽位，只处理第 7 张以后的自由图片');
    }
    // 批量删除（≥2 张）：弹窗确认，确定才删除
    if (picked.indexes.length >= 2) { openDeleteConfirm(picked); return; }
    await performDelete(picked);
  }
  function openDeleteConfirm(picked) {
    var shell = wyShell({ id: 'skuImageDeleteConfirmDialog', size: 'sm', title: '确认删除图片', closeLabel: '关闭确认弹窗', noExpand: true });
    var tip = document.createElement('p');
    tip.style.cssText = 'margin:0;font-size:13px;line-height:1.7';
    tip.textContent = '将把勾选的 ' + picked.indexes.length + ' 张图片（共 ' + picked.total + ' 张）从列表移除，点商品页“保存草稿”或“确定编辑”后才同步到服务器。';
    var sub = document.createElement('p');
    sub.style.cssText = 'margin:0;font-size:12px;color:var(--text-muted,#64748b);line-height:1.7';
    sub.textContent = '删除后列表会更新；如果误删，可点编辑器底部的“取消”放弃本次编辑（尚未确认的改动不会写回），或重新勾选其他图片。';
    shell.body.append(tip, sub);
    var cancel = wyBtn('取消', 'ghost');
    cancel.addEventListener('click', function () { shell.close(); });
    var go = wyBtn('确定删除', 'primary');
    go.style.background = '#dc2626';
    go.addEventListener('click', function () { shell.close(); performDelete(picked); });
    shell.foot.append(cancel, go);
    shell.open();
  }
  async function performDelete(picked) {
    picked.indexes = picked.indexes.filter(function (index) { return !isFixedRoleIndex(index); });
    if (!picked.indexes.length) { status('前 6 个固定槽位不能直接删除；请使用替换图片'); return; }
    pushHistory();
    var selectedIds = picked.indexes.map(function (position) { var item = linkItems[position]; return item && item.id ? item.id : ''; }).filter(Boolean);
    removedIds = removedIds.concat(selectedIds);
    linkItems = linkItems.filter(function (_item, position) { return picked.indexes.indexOf(position) < 0; });
    render();
    status('已从本次编辑中移除 ' + picked.indexes.length + ' 张（仅本地修改，点商品页“保存草稿”或“确定编辑”后才同步服务器）');
  }
  function zoom(index) {
    if (!linkItems.length) { status('没有可放大的图片'); return; }
    var safe = Math.max(0, Math.min(index, linkItems.length - 1));
    var old = $('skuImageZoomLayer');
    if (old && typeof old.close === 'function') { try { old.close(); } catch (error) { void error; } }
    if (old) old.remove();
    var layer = document.createElement('dialog');
    layer.id = 'skuImageZoomLayer';
    layer.setAttribute('aria-label', '放大查看图片');
    layer.style.cssText = 'border:0;padding:18px;background:rgba(8,11,18,.86);width:100vw;height:100vh;max-width:none;max-height:none';
    var figure = document.createElement('figure');
    figure.style.cssText = 'margin:0;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px';
    var image = document.createElement('img');
    image.src = imageUrlOf(linkItems[safe]);
    image.alt = '图片' + (safe + 1);
    image.style.cssText = [
      'max-width:calc(100vw - 36px)',
      'max-height:calc(100vh - 84px)',
      'min-width:min(60vw,480px)',
      'min-height:min(60vh,480px)',
      'object-fit:contain',
      'border-radius:8px',
      'background:#fff',
      'display:block'
    ].join(';');
    image.addEventListener('error', function () { caption.textContent = '第 ' + (safe + 1) + ' 张 · 这张图打不开（可能尚未安全转存），点任意处关闭'; image.style.border = '1px dashed #94a3b8'; });
    var caption = document.createElement('figcaption');
    caption.style.cssText = 'color:#e5e7eb;font-size:12px';
    caption.textContent = '第 ' + (safe + 1) + ' 张 · 点任意处或按 Esc 关闭';
    figure.append(image, caption);
    layer.append(figure);
    // 放大查看支持滚轮缩放与拖动平移（0.4×—6×，双击回到原始大小）
    var scale = 1, offsetX = 0, offsetY = 0, panning = false, startX = 0, startY = 0;
    function applyTransform() {
      image.style.transformOrigin = 'center center';
      image.style.transform = 'translate(' + offsetX + 'px, ' + offsetY + 'px) scale(' + scale + ')';
      caption.textContent = '第 ' + (safe + 1) + ' 张 · 缩放 ' + Math.round(scale * 100) + '%（滚轮缩放、拖动平移、双击复原），点空白处或按 Esc 关闭';
    }
    layer.addEventListener('wheel', function (event) {
      event.preventDefault();
      event.stopPropagation();
      scale = Math.min(6, Math.max(0.4, scale * (event.deltaY < 0 ? 1.15 : 0.87)));
      applyTransform();
    }, { passive: false });
    image.addEventListener('pointerdown', function (event) {
      panning = true;
      startX = event.clientX - offsetX;
      startY = event.clientY - offsetY;
      if (image.setPointerCapture && event.pointerId != null) { try { image.setPointerCapture(event.pointerId); } catch (error) { void error; } }
      event.preventDefault();
      event.stopPropagation();
    });
    image.addEventListener('pointermove', function (event) {
      if (!panning) return;
      offsetX = event.clientX - startX;
      offsetY = event.clientY - startY;
      applyTransform();
      event.preventDefault();
    });
    window.addEventListener('pointerup', function () { panning = false; });
    image.addEventListener('dblclick', function (event) {
      event.stopPropagation();
      scale = 1; offsetX = 0; offsetY = 0;
      applyTransform();
    });
    layer.addEventListener('click', function (event) { if (event.target === layer) layer.close(); });
    document.body.append(layer);
    if (typeof layer.showModal === 'function') layer.showModal(); else layer.setAttribute('open', '');
  }
  // 浏览器预检脚本（动态图/损坏文件在上传前就地拦截）。验收页 HTML 未内联该脚本，
  // 因此由增强层按需动态加载同一个已审计文件，不新增界面元素、不改验收 HTML。
  var PREFLIGHT_SRC = '../assets/sku-image-upload-preflight.js';
  function ensurePreflight() {
    return new Promise(function (resolve) {
      if (window.WYERP_SKU_IMAGE_UPLOAD_PREFLIGHT) { resolve(true); return; }
      var existing = document.querySelector('script[data-sku-preflight]');
      if (existing) { existing.addEventListener('load', function () { resolve(Boolean(window.WYERP_SKU_IMAGE_UPLOAD_PREFLIGHT)); }); existing.addEventListener('error', function () { resolve(false); }); return; }
      var tag = document.createElement('script');
      tag.src = PREFLIGHT_SRC;
      tag.setAttribute('data-sku-preflight', '1');
      tag.addEventListener('load', function () { resolve(Boolean(window.WYERP_SKU_IMAGE_UPLOAD_PREFLIGHT)); });
      tag.addEventListener('error', function () { resolve(false); });
      document.head.append(tag);
    });
  }
  async function uploadFiles(files) {
    var row = rowAt(openedIndex);
    if (!row) { status('请先打开一个SKU的图片编辑'); return; }
    if (!targetOf(row)) { status('请先选择上架店铺，再上传图片'); return; }
    var list = Array.prototype.slice.call(files || []);
    for (var i = 0; i < list.length; i += 1) {
      var file = list[i];
      if (file.size > 6 * 1024 * 1024) { status(file.name + '：单张不得超过 6 MiB，已跳过'); continue; }
      if (!/\.(jpe?g|png|bmp|gif|webp|avif|heic|heif)$/i.test(file.name)) { status(file.name + '：格式不支持，已跳过'); continue; }
      try {
        await ensurePreflight();
      if (window.WYERP_SKU_IMAGE_UPLOAD_PREFLIGHT && typeof window.WYERP_SKU_IMAGE_UPLOAD_PREFLIGHT.check === 'function') await window.WYERP_SKU_IMAGE_UPLOAD_PREFLIGHT.check(file);
        if (linkItems.length >= 30) throw new Error('这个SKU最多只能放30张图片');
        pushHistory();
        var localBlobUrl = URL.createObjectURL(file);
        linkItems.push({ url: localBlobUrl, localBlobUrl: localBlobUrl, localBlob: file, localProcessed: true, extension: '.' + file.name.split('.').pop().toLowerCase() });
        status('已加入左侧 ' + (i + 1) + '/' + list.length + ' 张；点商品页“保存草稿”或“确定编辑”后才上传服务器');
      } catch (error) {
        status('上传失败：' + (error && error.message ? error.message : '未知原因'));
        return;
      }
    }
    render();
  }
  // 下载文件名统一按老板指定格式：wy_年月日时分秒_2位随机数
  function wyName(extension) {
    var now = new Date();
    function pad(value) { return String(value).padStart(2, '0'); }
    var stamp = String(now.getFullYear()) + pad(now.getMonth() + 1) + pad(now.getDate()) + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds());
    return 'wy_' + stamp + '_' + pad(Math.floor(Math.random() * 100)) + (extension || '.jpg');
  }
  function extensionOf(item) {
    var known = String(item.extension || '').toLowerCase();
    if (/^\.[a-z0-9]{2,5}$/.test(known)) return known;
    var match = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)(?:\?|$)/i.exec(String(item.url || ''));
    if (!match) return '.jpg';
    var suffix = match[1].toLowerCase();
    return suffix === 'jpeg' ? '.jpg' : '.' + suffix;
  }
  function triggerDownload(href, filename) {
    var anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    if (href && href.indexOf('blob:') === 0) setTimeout(function () { try { URL.revokeObjectURL(href); } catch (ignored) { void ignored; } }, 60000);
  }
  // 浏览器本地打包 zip（stored，不压缩；JPG/PNG/WebP 本身已压缩，适合直接打包下载，不依赖服务器）
  var _crcTable = null;
  function crc32(buf) {
    if (!_crcTable) {
      _crcTable = [];
      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crcTable[n] = c >>> 0; }
    }
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function buildZipBlob(entries) {
    // entries: [{ name: string, data: Uint8Array }]
    var encoder = new TextEncoder();
    var parts = [], central = [], offset = 0;
    var now = new Date();
    var dt = (((now.getFullYear() - 1980) & 0x7F) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (var i = 0; i < entries.length; i++) {
      var name = encoder.encode(entries[i].name);
      var data = entries[i].data;
      var crc = crc32(data);
      var lfh = new Uint8Array(30);
      var lv = new DataView(lfh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
      lv.setUint16(10, dt, true); lv.setUint16(12, 0, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
      parts.push(lfh, name, data);
      var cd = new Uint8Array(46);
      var cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, dt, true); cv.setUint16(14, 0, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true); cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true); cv.setUint32(42, offset, true);
      central.push(cd, name);
      offset += 30 + name.length + data.length;
    }
    var cdSize = 0; central.forEach(function (b) { cdSize += b.length; });
    var eocd = new Uint8Array(22);
    var ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
    var all = parts.concat(central, [eocd]);
    var total = 0; all.forEach(function (b) { total += b.length; });
    var out = new Uint8Array(total); var p = 0;
    all.forEach(function (b) { out.set(b, p); p += b.length; });
    return new Blob([out], { type: 'application/zip' });
  }
  // 判断是否是“外部平台图”（采集箱/Ozon 同步的跨域 https 图，浏览器受 CORS 限制读不到，需服务端代理）
  function isExternalImageSrc(item) {
    if (item.localBlobUrl) return false; // 本地处理结果 blob 优先
    if (item.id && item.objectId) return false; // 本站私有对象
    var u = String(item.url || '');
    if (!u || /^blob:|^data:/i.test(u)) return false;
    if (/^\/(api|pages|assets|erp)/.test(u)) return false; // 本站相对路径
    if (/^https?:\/\/127\.0\.0\.1/i.test(u) || /^https?:\/\/localhost/i.test(u)) return false;
    return /^https:\/\//i.test(u);
  }
  // 外部平台图：走服务端代理拉取打包（服务器无 CORS 限制；不落库，只下载）
  async function editableImageSource(item) {
    if (!item) throw new Error('没有可处理的图片');
    if (item.localBlob) return item.localBlob;
    if (!isExternalImageSrc(item)) return imageUrlOf(item);
    if (!window.erpStorage || typeof window.erpStorage.request !== 'function') throw new Error('图片读取组件未加载');
    var response = await window.erpStorage.request('/api/domain/commands/sku-image-download-external', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: [String(item.url || '')] }) });
    if (!response.ok) { var data = await response.json().catch(function () { return {}; }); throw new Error((data && data.message) || (data && data.error) || '外部图片读取失败'); }
    var blob = await response.blob();
    if (!blob || !String(blob.type || '').startsWith('image/')) throw new Error('外部地址返回的不是有效图片');
    return blob;
  }
  async function downloadExternalViaServer(items) {
    var urls = items.map(function (item) { return item.url; }).filter(Boolean).slice(0, 50);
    if (!urls.length) { status('没有可下载的外部图片'); return; }
    var single = items.length === 1;
    status('正在通过服务器拉取 ' + urls.length + ' 张外部图片…');
    try {
      var resp = await window.erpStorage.request('/api/domain/commands/sku-image-download-external', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: urls }) });
      if (!resp.ok) {
        var data = await resp.json().catch(function () { return {}; });
        var msg = (data && data.message) ? String(data.message) : '图片下载失败，请稍后重试；若持续失败请提交 BUG 反馈。';
        if (data && data.failed && data.failed.length) {
          msg += '（第 ' + data.failed.map(function (f) { return f.index; }).join('、') + ' 张：' + (data.failed[0].reason || '') + '）';
        }
        if (resp.status === 429) msg += '，请稍后再试';
        status(msg); return;
      }
      var successCount = Number(resp.headers.get('X-Download-Success-Count') || '0');
      var failedCount = Number(resp.headers.get('X-Download-Failed-Count') || '0');
      var blob = await resp.blob();
      if (single && failedCount === 0) {
        var ext = blob.type === 'image/png' ? '.png' : blob.type === 'image/webp' ? '.webp' : blob.type === 'image/gif' ? '.gif' : blob.type === 'image/avif' ? '.avif' : '.jpg';
        triggerDownload(URL.createObjectURL(blob), wyName(ext));
        status('已开始下载 1 张（服务器代理拉取）');
      } else {
        triggerDownload(URL.createObjectURL(blob), wyName('.zip'));
        status(failedCount > 0 ? '已下载 ' + successCount + ' 张，' + failedCount + ' 张下载失败，失败原因已写入压缩包 download-errors.txt' : '已开始下载 ' + successCount + ' 张（服务器代理拉取打包）');
      }
    } catch (error) {
      status('下载失败：' + (error && error.message ? error.message : '未知原因'));
    }
  }
  // 下载指定位置的一张图（单张）：优先本地处理 blob，其次已转存走私有对象接口，再其次外部图走服务端代理，最后原地址
  async function downloadAt(position) {
    var only = linkItems[position];
    if (!only) { status('没有可下载的图片'); return; }
    var oneName = wyName(extensionOf(only));
    if (only.localBlobUrl) { triggerDownload(only.localBlobUrl, oneName); status('已开始下载 1 张（本地副本）'); return; }
    if (only.id && only.objectId) {
      var singleUrl = imageUrlOf(only);
      triggerDownload(singleUrl + (singleUrl.indexOf('?') >= 0 ? '&' : '?') + 'download=1&filename=' + encodeURIComponent(oneName), oneName);
      status('已开始下载 1 张'); return;
    }
    if (isExternalImageSrc(only)) { await downloadExternalViaServer([only]); return; }
    triggerDownload(only.url || '', oneName); status('已开始下载 1 张'); return;
  }
  async function downloadSelected() {
    var picked = selection();
    var items = linkItems.filter(function (item, position) { return picked.indexes.indexOf(position) >= 0; });
    if (!items.length) { status('没有可下载的图片'); return; }
    if (items.length === 1) { await downloadAt(picked.indexes[0]); return; }
    // 多张：外部平台图走服务端代理；本地/本站图浏览器本地打包。一次点击只触发一个下载
    var external = items.filter(isExternalImageSrc);
    var localable = items.filter(function (item) { return !isExternalImageSrc(item); });
    var mixedDownload = external.length > 0 && localable.length > 0;
    if (external.length) {
      await downloadExternalViaServer(external);
      if (!localable.length) return;
      items = localable;
    }
    // 本地/本站：浏览器本地打包成一个 zip；混合来源时外部图片已在上一步自动开始下载，不再要求用户重新勾选。
    status((mixedDownload ? '外部图片已开始下载；' : '') + '正在准备打包下载 ' + items.length + ' 张本地/已转存图片…');
    var entries = [], skipped = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var name = wyName(extensionOf(item));
      try {
        var src = item.localBlobUrl || (item.id && item.objectId ? imageUrlOf(item) : (item.url || ''));
        if (!src) { skipped.push(name); continue; }
        var resp = await window.erpStorage.request(src, { method: 'GET' });
        if (!resp.ok) { skipped.push(name); continue; }
        var buf = new Uint8Array(await resp.arrayBuffer());
        if (!buf.length) { skipped.push(name); continue; }
        entries.push({ name: name, data: buf });
      } catch (error) { skipped.push(name); }
    }
    if (!entries.length) {
      status(skipped.length ? '这 ' + skipped.length + ' 张图都读不到（' + skipped.join('、') + '），无法打包下载' : '没有可下载的图片');
      return;
    }
    triggerDownload(URL.createObjectURL(buildZipBlob(entries)), wyName('.zip'));
    status(skipped.length ? '已下载 ' + entries.length + ' 张；' + skipped.length + ' 张读不到被跳过（' + skipped.join('、') + '）' : '已开始下载 ' + entries.length + ' 张（浏览器本地打包）');
  }
  function setCover(scope) {
    var picked = selection();
    var position = scope && Number.isInteger(scope.singleIndex) ? scope.singleIndex
      : picked.indexes.length === 1 ? picked.indexes[0] : editAnchorIndex;
    if (position < 0) { status(picked.indexes.length ? '请只勾选一张，或直接从要设封面的那张卡片上点“编辑⌄”' : '请先勾选一张要设为封面的图片'); return; }
    if (position === 0) { status(firstSkuUsesFixedRoles() ? '第一SKU第1张固定槽位已经是主图' : '当前图片已经是这个SKU的主图'); return; }
    if (firstSkuUsesFixedRoles()) {
      status('第一SKU前6张用途已固定，不能通过“设为封面”换位；如需更换主图，请直接替换第1张“主图”槽位');
      return;
    }
    var item = linkItems[position];
    if (!item) { status('没找到勾选的图片'); return; }
    if (!stagePlatformImport(item)) return;
    pushHistory();
    linkItems = [item].concat(linkItems.filter(function (_entry, idx) { return idx !== position; }));
    render();
    if (!item.id) { status('已把该平台图设为封面；点击商品页“保存草稿”或“确定编辑”后才会转存并写入服务器'); return; }
    status('已把该图设为封面（本地调整；点商品页“保存草稿”或“确定编辑”后同步服务器）');
  }

  // 图片打乱：第一SKU承担富内容图片顺序，不执行随机打乱；第2个SKU起只固定各自主图，其余图片可打乱。
  function shuffleImages() {
    if (firstSkuUsesFixedRoles()) { status('第一SKU用于富内容，图片顺序保持不变；请从第2个SKU开始使用图片打乱'); return; }
    var fixedCount = Math.min(1, linkItems.length);
    var free = linkItems.slice(fixedCount);
    if (free.length < 2) { status('当前SKU除主图外的图片不足2张，没有可打乱的内容'); return; }
    pushHistory();
    var fixed = linkItems.slice(0, fixedCount);
    var before = free.map(function (item) { return item.id || item.url; }).join('|');
    for (var attempt = 0; attempt < 8; attempt += 1) {
      for (var i = free.length - 1; i > 0; i -= 1) {
        var j = Math.floor(Math.random() * (i + 1));
        var swap = free[i];
        free[i] = free[j];
        free[j] = swap;
      }
      if (free.map(function (item) { return item.id || item.url; }).join('|') !== before) break;
    }
    linkItems = fixed.concat(free);
    render();
    status('已打乱当前SKU除主图外的 ' + free.length + ' 张图片；主图仍固定第1位，点商品页“保存草稿”或“确定编辑”前不提交服务器');
  }


  // ── 添加到其它变体（服务端 sku-image-copy：linkIds + targetVariantRefs，幂等一次） ──
  function otherVariantRows() {
    return variantRows().filter(function (row) {
      return Number(row.dataset.index) !== Number(openedIndex) && Boolean(variantRefOf(row));
    });
  }
  // 变体标识必须稳定：只用货号/offerId，绝不用行号或序号（换排序、刷新、翻页都会变）
  function variantRefOf(row) { return fieldValue(row, 'offerId') || fieldValue(row, 'sku'); }
  function variantNameOf(row, index) {
    var name = row ? fieldValue(row, 'name') : '';
    return name || ('第 ' + (Number(index) + 1) + ' 个SKU（' + variantRefOf(row) + '）');
  }
  function openCopyDialog(scope) {
    var indexes = scopeIndexes(scope);
    var imageKeys = indexes.map(function (position) { return ensureLocalImageKey(linkItems[position]); }).filter(Boolean);
    if (!imageKeys.length) { status(scope ? '这张图片读不到，暂时不能添加到其它变体' : '请先勾选要复制到其他变体的图片'); return; }
    var rows = otherVariantRows();
    if (!rows.length) { status('这个商品没有其它SKU可变体，无法添加'); return; }
    var shell = wyShell({ id: 'skuImageCopyDialog', size: 'md', title: '添加到其它变体（' + imageKeys.length + ' 张图）' });
    var tipSec = wyEl('section', 'wy-section');
    var tip = wyEl('p', 'wy-section-sub');
    tip.style.margin = '0';
    tip.textContent = '勾选要接收这些图片的SKU；当前SKU不会出现在列表里。平台快照会在商品页保存时先统一转存，再复制到目标SKU。';
    tipSec.append(tip);
    var listSec = wyEl('section', 'wy-section');
    var listTitle = wyEl('h3', 'wy-section-title');
    listTitle.textContent = '选择目标SKU';
    listSec.append(listTitle);
    var checks = [];
    rows.forEach(function (row) {
      var line = wyCheckLine(variantNameOf(row, row.dataset.index), false);
      line.el.dataset.value = variantRefOf(row);
      listSec.append(line.el);
      checks.push(line);
    });
    var statusLine = wyEl('p', 'wy-section-sub');
    statusLine.style.margin = '0'; statusLine.style.minHeight = '18px'; statusLine.style.color = '#dc2626';
    shell.body.append(tipSec, listSec, statusLine);
    var cancel = wyBtn('取消', 'ghost'); cancel.addEventListener('click', function () { shell.close(); });
    var go = wyBtn('添加到勾选的变体', 'primary'); shell.foot.append(cancel, go); shell.open();
    go.addEventListener('click', function () {
      var targets = checks.filter(function (line) { return line.value; }).map(function (line) { return line.el.dataset.value; });
      if (!targets.length) { statusLine.textContent = '请至少勾选一个目标SKU'; return; }
      copyToVariants(imageKeys, targets, statusLine, shell.dialog);
    });
  }
  async function copyToVariants(imageKeys, targets, statusLine, dialog) {
    if (!targetOf(rowAt(openedIndex))) { statusLine.textContent = '请先选择上架店铺'; return; }
    pendingCopies.push({ imageKeys: imageKeys.slice(), targetVariantRefs: targets.slice() });
    if (dialog && dialog.open) dialog.close();
    status('已加入待保存操作：' + imageKeys.length + ' 张图将添加到 ' + targets.length + ' 个SKU；点商品页“保存草稿”或“确定编辑”后才写入服务器');
  }
  // 方案 2：不在打开时拦截，但任何写操作前必须校验店铺与服务器草稿归属
  // （服务器本身也会拒绝：assertSkuImageTarget 查不到目标就报 sku_image_target_not_found）
  function createDraftSaved() {
    var draftId = String(params.get('draftId') || '');
    if (!/^draft_[a-zA-Z0-9_-]+$/.test(draftId)) return false;
    return recordsOf('erp_product_drafts').some(function (row) {
      if (!row) return false;
      return String(row.draftId || row.id || '') === draftId || String(row.productId || '') === draftId;
    });
  }
  function requireSavedForWrite() {
    if (params.get('mode') !== 'create') return true;
    if (!targetOf(rowAt(openedIndex))) { status('失败：请先选择上架店铺'); return false; }
    if (createDraftSaved()) return true;
    status('新增商品还没保存到服务器：请先点“确定编辑”把商品保存（服务端返回草稿号）后再改图片，现在只允许查看');
    return false;
  }
  // ── 店铺绑定的水印：模板来自“工具-文字水印 / 图片水印”，一个店铺只能绑一个，多个店铺可绑同一个 ──
  var WATERMARK_TEMPLATES_SRC = '../assets/watermark-templates.js';
  function ensureWatermarkModule() {
    return new Promise(function (resolve) {
      if (window.WYERP_WATERMARK_TEMPLATES) { resolve(true); return; }
      var existing = document.querySelector('script[data-wm-templates]');
      if (existing) { existing.addEventListener('load', function () { resolve(Boolean(window.WYERP_WATERMARK_TEMPLATES)); }); existing.addEventListener('error', function () { resolve(false); }); return; }
      var tag = document.createElement('script');
      tag.src = WATERMARK_TEMPLATES_SRC;
      tag.setAttribute('data-wm-templates', '1');
      tag.addEventListener('load', function () { resolve(Boolean(window.WYERP_WATERMARK_TEMPLATES)); });
      tag.addEventListener('error', function () { resolve(false); });
      document.head.append(tag);
    });
  }
  var watermarkTemplateCache = null;
  function normalizeTemplates(raw) {
    var list = Array.isArray(raw) ? raw : [];
    return window.WYERP_WATERMARK_TEMPLATES && window.WYERP_WATERMARK_TEMPLATES.normalizeAll ? window.WYERP_WATERMARK_TEMPLATES.normalizeAll(list) : list;
  }
  function watermarkTemplates() {
    var local = recordsOf('erp_watermark_templates');
    if (local.length) return normalizeTemplates(local);
    return normalizeTemplates(watermarkTemplateCache || []);
  }
  // 商品页的存储初始化列表里没有水印键（该文件已验收冻结），所以这里按需向服务器拉一次，
  // 保证“店铺绑定的水印模板”在任何页面都能读到，而不是静默显示为空。
  function ensureWatermarkTemplates() {
    if (recordsOf('erp_watermark_templates').length || watermarkTemplateCache) return Promise.resolve(true);
    if (!window.erpStorage || typeof window.erpStorage.request !== 'function') return Promise.resolve(false);
    // 系统管理员跨租户管理时，店铺与模板在选中租户，必须带 tenantId 读取，否则会按账号自身租户查到空。
    var wmUrl = '/api/data/erp_watermark_templates';
    var selectedTenant = (typeof window.erpStorage.getSelectedTenantId === 'function') ? window.erpStorage.getSelectedTenantId() : '';
    if (selectedTenant) wmUrl += '?tenantId=' + encodeURIComponent(selectedTenant);
    return window.erpStorage.request(wmUrl, { method: 'GET' }).then(function (response) {
      if (!response || !response.ok) return false;
      return response.json();
    }).then(function (data) {
      var list = Array.isArray(data) ? data : (data && (data.payload || data.items || data.value));
      if (!Array.isArray(list)) return false;
      watermarkTemplateCache = list;
      return list.length > 0;
    }).catch(function () { return false; });
  }

  function fetchShopsWithTenant() {
    var url = '/api/data/erp_shops_data';
    var t = (typeof window.erpStorage.getSelectedTenantId === 'function') ? window.erpStorage.getSelectedTenantId() : '';
    if (t) url += '?tenantId=' + encodeURIComponent(t);
    // 读取失败与“列表为空”是两回事：失败时如实返回状态，避免把服务器故障误报成“店铺不存在”。
    return window.erpStorage.request(url, { method: 'GET' }).then(function (response) {
      if (!response || !response.ok) return { ok: false, status: response ? response.status : 0 };
      return response.json().then(function (data) {
        var list = Array.isArray(data) ? data : (data && (data.payload || data.items || data.value));
        return { ok: true, list: Array.isArray(list) ? list : [] };
      });
    }).catch(function () { return { ok: false, status: 0 }; });
  }
  async function boundWatermark() {
    var clientId = targetOf(rowAt(openedIndex)) ? targetOf(rowAt(openedIndex)).clientId : '';
    if (!clientId) return { reason: '请先在上方选择上架店铺，水印按店铺绑定' };
    var shops = recordsOf('erp_shops_data');
    var helper = window.WYERP_PRODUCT_SHOPS;
    var shop = null;
    if (helper && typeof helper.resolve === 'function') shop = helper.resolve(shops, clientId) || null;
    if (!shop && helper && typeof helper.id === 'function') {
      shop = shops.filter(function (item) { return String(helper.id(item)) === String(clientId); })[0] || null;
    }
    if (!shop) shop = shops.filter(function (item) { return String((item && (item.clientId || item.externalShopId || item.id || item.shopId)) || '') === String(clientId); })[0] || null;
    if (!shop) {
      // 系统管理员跨租户查看时，本地店铺列表可能不含目标店铺：带当前租户从服务端读一次再匹配
      var remote = await fetchShopsWithTenant();
      if (!remote.ok) return { reason: '店铺数据暂时读取失败' + (remote.status ? '（HTTP ' + remote.status + '）' : '') + '，请稍后重试；若反复出现，请联系管理员检查服务端日志' };
      shop = remote.list.filter(function (item) { return String((item && (item.clientId || item.externalShopId || item.id || item.shopId)) || '') === String(clientId); })[0] || null;
    }
    if (!shop) return { reason: '找不到当前所选店铺（标识 ' + clientId + '）的记录，请在店铺列表确认该店铺后重新绑定水印' };
    var bound = Array.isArray(shop.wm) && shop.wm.length ? String(shop.wm[0][0]) : '';
    if (!bound) return { reason: '该店铺还没有绑定水印：请到 店铺列表 → 绑定水印 里选择一个模板（只能选一个）' };
    var tpl = watermarkTemplates().filter(function (item) { return item.id === bound; })[0];
    // 模板读不到（多为尚未加载完成）与"模板里没填文字"是两件事，分开提示，避免误报
    if (!tpl) return { reason: '还没读到店铺绑定的水印模板（编号 ' + bound + '）：请重试一次，或到 工具 → 水印管理 确认模板是否存在' };
    var kind = String(tpl.kind) === 'image' ? 'image' : 'text';
    // 模板缺的是文字还是水印图片，取决于模板类型，提示必须说清楚缺哪一项
    if (kind === 'image' ? !String(tpl.logoDataUrl || '').trim() : !String(tpl.content || '').trim()) {
      return { reason: '绑定的' + (kind === 'image' ? '图片' : '文字') + '水印模板“' + tpl.name + '”'
        + (kind === 'image' ? '缺少水印图片（可能被删掉或超过 2MB 上限）' : '没有填写文字')
        + '，请到 工具 → 水印管理 补齐后再试' };
    }
    return { template: tpl, legacy: !tpl.content };
  }
  // 模板位置换算成服务端需要的左上角坐标（用图片真实宽高）
  // 勾选里若含“只有平台地址、还没转存”的图片，先按 采集详情图片 的同一条服务端通道转存，再加水印
  // ── 添加水印：水印只用"工具 → 水印管理"里、当前店铺绑定的那一个模板 ──
  // 弹窗里没有文字/Logo/参数输入：列出当前勾选的图片 → 点"批量处理"全做，或某一行"只处理这张"。
  // 处理只在浏览器本地完成（同地址图能画），结果直接生效，不需要再点上传；本功能不做服务器回退：
  // 跨域图片画不了会明确报错提示改用本地文件。服务端只做最终存储（sku-image-upload 标准化落盘），不再重复叠加水印。
  var LOCAL_WM_SRC = '../assets/watermark-local.js';
  var wmLocal = null, wmLoadPromise = null;
  function ensureLocalWatermarkEngine() {
    if (wmLocal) return Promise.resolve(true);
    if (wmLoadPromise) return wmLoadPromise;
    wmLoadPromise = new Promise(function (resolve) {
      var tag = document.createElement('script');
      tag.src = LOCAL_WM_SRC;
      tag.setAttribute('data-wm-local', '1');
      tag.addEventListener('load', function () { wmLocal = window.WYERP_WATERMARK_LOCAL || null; resolve(Boolean(wmLocal)); });
      tag.addEventListener('error', function () { resolve(false); });
      document.head.append(tag);
    });
    return wmLoadPromise;
  }
  var wmState = { tasks: [], seq: 0, busy: false };
  function formatFromUrl(url) {
    var match = /\.(png|jpe?g|webp)(?:\?|$)/i.exec(String(url || ''));
    if (!match) return 'jpeg';
    var suffix = match[1].toLowerCase();
    return suffix === 'png' ? 'png' : suffix === 'webp' ? 'webp' : 'jpeg';
  }
  // 模板里的字号/宽度是按比例换算的，转成比例后本地与服务端表现一致
  function wmConfigFromTemplate(tpl) {
    var base = {
      position: tpl.position,
      opacity: Math.min(1, Math.max(0.05, Number(tpl.opacity) / 100)),
      marginRatio: 0.02
    };
    // 图片水印模板带 Logo 图（data URL，随模板存在租户文档里），宽度按占原图宽的比例
    if (String(tpl.kind) === 'image') {
      return Object.assign({
        type: 'image',
        watermarkImage: String(tpl.logoDataUrl || ''),
        watermarkWidthRatio: Math.min(0.9, Math.max(0.03, (Number(tpl.widthRatio) || 15) / 100))
      }, base);
    }
    return Object.assign({
      type: 'text',
      text: String(tpl.content || '').trim(),
      textStyle: { fontSizeRatio: Math.min(0.3, Math.max(0.005, Number(tpl.fontSize) || 40) / 1000), color: tpl.color || '#ffffff', fontFamily: tpl.fontFamily || 'yahei' }
    }, base);
  }
  // 水印第一步：只在浏览器本地绘制，产出 blob；此阶段不保存、不替换任何原图。
  async function renderWatermarkLocal(item, config) {
    var name = (item.id ? String(item.id).slice(0, 8) : 'image') + '_wm';
    await ensureLocalWatermarkEngine();
    if (!wmLocal) throw new Error('本地处理引擎未就绪，请刷新页面重试');
    var result;
    try {
      var source = await editableImageSource(item);
      result = await wmLocal.processImage(source, config, { fileName: name, skipValidate: true, format: formatFromUrl(item.url) });
    } catch (error) {
      var tainted = /tainted|SecurityError|跨域|无法解码|broken/i.test((error && (error.code + ' ' + error.message)) || '');
      if (tainted) throw new Error('这张图的地址不允许浏览器本地读取（跨域图片），请把图片下载到本机后处理');
      throw error;
    }
    return { blob: result.blob, fileName: name + (result.format === 'png' ? '.png' : result.format === 'webp' ? '.webp' : '.jpg') };
  }
  // 水印确认只标记 localProcessed + wmReplace，由商品页统一保存入口提交。
  var WM_CONCURRENT = 3; // 批量并发上限：与本地引擎默认并发一致，避免几十张大图同时解码
  async function runWmQueue(tasks, workerFn, onTick) {
    var queue = tasks.slice(), cursor = 0, done = 0;
    async function worker() {
      while (cursor < queue.length) {
        var task = queue[cursor++];
        await workerFn(task);
        done += 1;
        if (onTick) onTick(done, task);
      }
    }
    var workers = [];
    for (var i = 0; i < Math.min(WM_CONCURRENT, queue.length); i += 1) workers.push(worker());
    await Promise.all(workers);
  }
  async function openWatermarkDialog(scope) {
    var target = targetOf(rowAt(openedIndex));
    if (!target) { status('请先选择上架店铺，再添加水印'); return; }
    var picked = { indexes: scopeIndexes(scope) };
    if (!picked.indexes.length) { status('请先勾选要加水印的图片'); return; }
    // 商品页没有把水印模板键加入初始化列表（该文件已验收冻结），所以这里先确保模板加载完成再判断，
    // 否则会误报"模板没有填写文字"。
    await Promise.all([ensureLocalWatermarkEngine(), ensureWatermarkModule(), ensureWatermarkTemplates()]);
    var bound = await boundWatermark();
    if (!bound.template) { status(bound.reason); return; }
    wmState = { tasks: [], seq: wmState.seq || 0, busy: false, config: wmConfigFromTemplate(bound.template), template: bound.template };
    wmState.tasks = picked.indexes.map(function (position) {
      return { id: 'wm-task-' + (wmState.seq++), item: linkItems[position], name: '图片 ' + (position + 1), status: 'pending', chosen: true, blob: null, url: null, fileName: null, error: null, persisted: false };
    });
    var shell = wyShell({ id: 'skuImageWatermarkDialog', size: 'lg', title: '添加水印', closeLabel: '关闭添加水印' });
    var dialog = shell.dialog, body = shell.body, foot = shell.foot;
    function revokeUrls() { wmState.tasks.forEach(function (t) { if (t.url) { URL.revokeObjectURL(t.url); t.url = null; } }); }
    dialog.addEventListener('close', revokeUrls);
    dialog.addEventListener('cancel', revokeUrls);
    function setFoot(buttons) { foot.replaceChildren(); buttons.forEach(function (b) { foot.append(b); }); }
    function busyFoot(text) {
      var c = wyBtn('取消', 'ghost'); c.disabled = true;
      var g = wyBtn(text, 'primary'); g.disabled = true;
      setFoot([c, g]);
    }
    // 视图一：模板与数量确认
    function renderApplyView() {
      body.replaceChildren();
      var section = wyEl('section', 'wy-section');
      var headRow = document.createElement('div');
      headRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
      var t1 = wyEl('h3', 'wy-section-title'); t1.textContent = '选择水印模板';
      headRow.append(t1);
      var tpl = wmState.template;
      var isImageTpl = String(tpl.kind) === 'image';
      var tplCard = wyEl('div', 'wy-tplcard');
      var thumb = wyEl('div', 'wy-tplthumb');
      if (isImageTpl && tpl.logoDataUrl) {
        var logoImg = document.createElement('img');
        logoImg.alt = '水印图片';
        logoImg.src = tpl.logoDataUrl;
        thumb.replaceChildren(logoImg);
      } else thumb.textContent = '▣';
      var main = wyEl('div', 'wy-tplmain');
      var n = wyEl('div', 'n');
      var badge = wyEl('i', 'wy-badge wy-badge-green'); badge.textContent = '当前店铺已绑定';
      n.append(document.createTextNode(tpl.name || '店铺水印'), badge);
      var d = wyEl('div', 'd');
      d.textContent = isImageTpl
        ? '图片水印 · 位置 ' + tpl.position + ' · 宽度占比 ' + tpl.widthRatio + '% · 不透明度 ' + tpl.opacity + '%'
        : '文字“' + (tpl.content || '') + '” · 位置 ' + tpl.position + ' · 字号 ' + tpl.fontSize + ' · 不透明度 ' + tpl.opacity + ' · 颜色 ' + tpl.color;
      main.append(n, d);
      tplCard.append(thumb, main);
      section.append(headRow, tplCard);
      var summary = wyEl('div', 'wy-summary');
      var s1 = document.createElement('div'); s1.innerHTML = '已选择 <b>' + wmState.tasks.length + '</b> 张图片进行水印处理';
      var s2 = document.createElement('div'); s2.textContent = '先在本机浏览器绘制并预览效果，点“确认替换”后才会真正替换原图；取消则原图一张不动。';
      summary.append(s1, s2);
      body.append(section, summary);
      var cancel = wyBtn('取消', 'ghost'); cancel.addEventListener('click', function () { dialog.close(); });
      var apply = wyBtn('应用水印', 'primary'); apply.addEventListener('click', runApplyView);
      setFoot([cancel, apply]);
    }
    // 视图二：进度（绘制阶段总数=全部任务；保存阶段总数=用户勾选的任务，二者不能混用）
    function renderProgressView(label, hint, total) {
      body.replaceChildren();
      var prog = wyProgress();
      prog.set(0, total || wmState.tasks.length, label);
      prog.hint.textContent = hint || '';
      body.append(prog.el);
      busyFoot('处理中…');
      return prog;
    }
    async function runApplyView() {
      if (wmState.busy) return;
      wmState.busy = true;
      var prog = renderProgressView('正在绘制水印…', '全部在本机浏览器完成；跨域读不到的图片会标为失败，本阶段不会改动原图。');
      await runWmQueue(wmState.tasks, async function (task) {
        try {
          var out = await renderWatermarkLocal(task.item, wmState.config);
          task.blob = out.blob; task.fileName = out.fileName;
          task.url = URL.createObjectURL(task.blob);
          task.status = 'success'; task.error = null;
        } catch (error) { task.status = 'failed'; task.chosen = false; task.error = (error && error.message) || '处理失败'; }
      }, function (done) { prog.set(done, wmState.tasks.length, '正在绘制水印…'); });
      wmState.busy = false;
      renderResultView();
    }
    function chosenTasks() { return wmState.tasks.filter(function (t) { return t.status === 'success' && t.chosen && !t.persisted; }); }
    // 视图三：结果预览（可放大、可勾选），确认后才替换外面的内容
    function renderResultView() {
      body.replaceChildren();
      var section = wyEl('section', 'wy-section');
      var t1 = wyEl('h3', 'wy-section-title'); t1.textContent = '水印应用结果预览';
      var okCount = wmState.tasks.filter(function (t) { return t.status === 'success'; }).length;
      var failCount = wmState.tasks.length - okCount;
      var sub = wyEl('p', 'wy-section-sub');
      sub.textContent = '水印模板：' + (wmState.template.name || '') + ' · 成功 ' + okCount + ' 张' + (failCount ? '，失败 ' + failCount + ' 张（不会替换）' : '');
      var headRow = document.createElement('div');
      headRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap';
      var selectAll = wyCheckLine('全选', false);
      function syncSelectAll() {
        var eligible = wmState.tasks.filter(function (t) { return t.status === 'success' && !t.persisted; });
        selectAll.set(eligible.length > 0 && eligible.every(function (t) { return t.chosen; }));
      }
      selectAll.onChange = function (flag) {
        wmState.tasks.forEach(function (t) { if (t.status === 'success' && !t.persisted) t.chosen = flag; });
        syncCards(); syncConfirm();
      };
      headRow.append(sub, selectAll.el);
      var grid = wyEl('div', 'wy-result-grid');
      function cardFor(task) {
        var card = wyEl('div', 'wy-imgcard' + (task.chosen ? ' on' : ''));
        var check = document.createElement('button');
        check.type = 'button';
        check.className = 'wy-imgcheck' + (task.chosen ? '' : ' off');
        check.textContent = task.chosen ? '\u2713' : '';
        check.setAttribute('aria-label', (task.chosen ? '取消选择' : '选择') + task.name);
        if (task.status === 'failed' || task.persisted) { check.disabled = true; check.classList.add('off'); check.textContent = task.persisted ? '\u2713' : ''; }
        check.addEventListener('click', function () {
          if (task.status !== 'success' || task.persisted) return;
          task.chosen = !task.chosen; syncCards(); syncSelectAll(); syncConfirm();
        });
        var thumb = wyEl('div', 'wy-imgthumb' + (task.status === 'success' ? ' zoomable' : ''));
        if (task.status === 'success') {
          thumb.style.backgroundImage = 'url("' + String(task.url || '').replace(/["\\)]/g, encodeURIComponent) + '")';
          var pv = wyEl('span', 'pv'); pv.textContent = '\u25C9 预览';
          thumb.append(pv);
          thumb.addEventListener('click', function () { wyLightbox(task.url, task.name); });
        } else { var err = wyEl('div', 'wy-imgerr'); err.textContent = task.error || '处理失败'; thumb.append(err); }
        var name = wyEl('div', 'wy-imgname'); name.textContent = task.persisted ? task.name + '（已替换）' : task.name;
        card.append(check, thumb, name);
        task._card = card; task._check = check;
        return card;
      }
      function syncCards() {
        wmState.tasks.forEach(function (task) {
          if (!task._card) return;
          task._card.classList.toggle('on', !!task.chosen);
          if (task.status === 'success' && !task.persisted) {
            task._check.classList.toggle('off', !task.chosen);
            task._check.textContent = task.chosen ? '\u2713' : '';
          }
        });
      }
      wmState.tasks.forEach(function (task) { grid.append(cardFor(task)); });
      var confirmBtn = wyBtn('', 'primary');
      function syncConfirm() {
        var n = chosenTasks().length;
        confirmBtn.textContent = n ? '确认替换（' + n + ' 张）' : '没有待替换的图片';
        confirmBtn.disabled = n === 0;
      }
      section.append(t1, headRow, grid);
      body.append(section);
      syncSelectAll(); syncConfirm();
      var back = wyBtn('返回', 'ghost'); back.addEventListener('click', renderApplyView);
      confirmBtn.addEventListener('click', runConfirmView);
      setFoot([back, confirmBtn]);
      async function runConfirmView() {
        var tasks = chosenTasks();
        if (!tasks.length || wmState.busy) return;
        wmState.busy = true;
        var prog = renderProgressView('正在准备水印图片…', '正在把水印后的图片标记为待保存（不会直接上传，请点击保存按钮提交）…', tasks.length);
        var failures = [];
        await runWmQueue(tasks, async function (task) {
          try {
            if (!task.blob) throw new Error('图片尚未处理完成');
            var position = linkItems.indexOf(task.item);
            if (position < 0) throw new Error('图片已不在列表中');
            if (task.item.localBlobUrl) { try { URL.revokeObjectURL(task.item.localBlobUrl); } catch (ignored) { void ignored; } }
            task.item.localProcessed = true;
            task.item.localBlob = task.blob;
            task.item.localBlobUrl = URL.createObjectURL(task.blob);
            task.item.wmReplace = true;
            task.persisted = true;
          } catch (error) { failures.push({ task: task, message: (error && error.message) || '标记失败' }); }
        }, function (done) { prog.set(done, tasks.length, '正在准备水印图片…'); });
        wmState.busy = false;
        if (failures.length) {
          failures.forEach(function (f) { f.task.status = 'failed'; f.task.error = '标记失败：' + f.message; });
          status('部分图片标记失败：' + failures.length + ' 张，可在弹窗里确认后重试');
          renderResultView();
          return;
        }
        var count = tasks.length;
        dialog.close();
        render();
        status('水印已应用到 ' + count + ' 张图片，请点击"保存草稿"或"确定编辑"提交到服务器');
      }
    }
    shell.open();
    renderApplyView();
  }
  function action(name, scope) {
    return function () {
      if (name === '设为封面') { setCover(scope); return; }
      if (name === '删除') { deleteSelected(); return; }
      if (name === '下载') { downloadSelected(); return; }
      if (name === '撤销') { undo(); return; }
      if (name === '重做') { redo(); return; }
      if (name === '添加水印') { openWatermarkDialog(scope); return; }
      if (name === '图片打乱') { shuffleImages(); return; }
      if (name === '添加到其它变体') { openCopyDialog(scope); return; }
      if (name === '图片处理…') { openProcessDialog(null, scope); return; }
      if (AI_CAPABILITIES[name]) { openAiDialog(AI_CAPABILITIES[name], scope); return; }
      status('“' + name + '”正在接入，本阶段不会改动图片数据');
    };
  }

  var MENU_SPECS = {
    edit: [['⛓', '多语言翻译', 'violet'], ['⛓', 'AI重绘', 'blue'], ['—', ''], ['▧', '设为封面'], ['▣', '添加水印'], ['⊕', '添加到其它变体'], ['⇩', '下载'], ['✳', '图片处理…']],
    batch: [['▣', '添加水印'], ['⛓', '象寄批量翻译', 'violet'], ['⛓', '批量AI重绘', 'blue'], ['⊕', '添加到其它变体'], ['⤨', '图片打乱　›'], ['⇩', '下载'], ['♙', '删除'], ['✳', '图片处理…']],
    source: [['⇩', '下载']]
  };
  var menus = {}, anchoredBy = null, editAnchorIndex = -1, ANCHOR = '--sku-menu-anchor';
  function clearAnchor() { if (anchoredBy) { anchoredBy.style.removeProperty('anchor-name'); anchoredBy = null; } }
  function closeMenus() {
    var editor = $('skuImageEditor');
    Object.keys(menus).forEach(function (kind) {
      var menu = menus[kind];
      menu.hidden = true;
      if (editor && menu.parentElement !== editor) editor.appendChild(menu);
    });
    document.querySelectorAll('#skuImageEditor [data-static-tool]').forEach(function (button) { button.setAttribute('aria-expanded', 'false'); });
    clearAnchor();
  }
  function showMenu(kind, anchor) {
    var editor = $('skuImageEditor'), menu = menus[kind];
    if (!menu || !editor) return;
    closeMenus();
    if (menu.parentElement !== editor) editor.appendChild(menu);
    anchor.style.setProperty('anchor-name', ANCHOR);
    anchoredBy = anchor;
    menu.style.position = 'absolute';
    menu.style.positionAnchor = ANCHOR;
    menu.style.top = 'anchor(bottom)';
    menu.style.left = 'anchor(left)';
    menu.style.right = 'auto';
    menu.style.bottom = 'auto';
    menu.style.marginTop = '2px';
    menu.style.positionTryFallbacks = 'flip-inline';
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
  }

  // ── 服务端图片处理（自有 ImageMagick 引擎，不接任何第三方） ──
  // 契约：POST /api/domain/commands/sku-image-process
  //   { clientId, productId, variantRef, items:[{linkId, associationVersion}], operations[], outputFormat, restoreOriginal? }
  //   → { items: [新版本] }；版本不一致返回 409 sku_image_version_conflict（会自动重读关联）
  function drawerNumber(id, fallback) {
    var box = $(id);
    var value = box ? Number(String(box.value || '').trim()) : NaN;
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }
  function drawerValue(id, fallback) {
    var box = $(id);
    var value = box ? String(box.value || '').trim().toLowerCase() : '';
    return value || fallback;
  }
  function outputFormatFromDrawer() {
    var format = drawerValue('skuImageFormat', 'jpg');
    return format.indexOf('png') >= 0 ? 'png' : 'jpeg';
  }
  function fitFromDrawer() {
    var fit = drawerValue('skuImageFit', '');
    if (fit.indexOf('裁剪') >= 0 || fit === 'cover') return 'cover';
    if (fit.indexOf('拉伸') >= 0 || fit === 'stretch') return 'stretch';
    return 'pad';
  }
  // 本地Canvas处理：旋转、缩放、裁剪。返回处理后的Blob。
  async function processImageLocally(operations, item, outputFormat) {
    if (!wmLocal) await ensureLocalWatermarkEngine();
    if (!wmLocal) throw new Error('本地处理引擎未就绪，请刷新页面重试');
    var image = await wmLocal.loadImage(await editableImageSource(item));
    var srcWidth = image.naturalWidth || image.width, srcHeight = image.naturalHeight || image.height;
    var currentWidth = srcWidth, currentHeight = srcHeight;
    var cropBox = null;
    // 先计算最终画布尺寸
    for (var i = 0; i < operations.length; i++) {
      var op = operations[i];
      if (op.type === 'rotate') {
        var temp = currentWidth;
        currentWidth = currentHeight;
        currentHeight = temp;
      } else if (op.type === 'resize') {
        var targetW = op.width, targetH = op.height, fit = op.fit || 'pad';
        if (fit === 'stretch') {
          currentWidth = targetW;
          currentHeight = targetH;
        } else if (fit === 'cover') {
          var scale = Math.max(targetW / currentWidth, targetH / currentHeight);
          currentWidth = targetW;
          currentHeight = targetH;
          // cover模式需要记录源图裁剪区域
          op._srcCrop = {
            x: Math.max(0, (srcWidth - targetW / scale) / 2),
            y: Math.max(0, (srcHeight - targetH / scale) / 2),
            w: targetW / scale,
            h: targetH / scale
          };
        } else {
          // pad模式
          var scale2 = Math.min(targetW / currentWidth, targetH / currentHeight);
          currentWidth = targetW;
          currentHeight = targetH;
          op._srcCrop = {
            x: (srcWidth - currentWidth / scale2) / 2,
            y: (srcHeight - currentHeight / scale2) / 2,
            w: currentWidth / scale2,
            h: currentHeight / scale2
          };
        }
      } else if (op.type === 'crop') {
        cropBox = { x: op.x, y: op.y, width: op.width, height: op.height };
        currentWidth = op.width;
        currentHeight = op.height;
      }
    }
    // 创建最终画布
    var surface = wmLocal.createCanvas(currentWidth, currentHeight);
    var ctx = surface.context;
    // 如果有crop，直接从原图裁剪区域开始
    var drawSrcX = 0, drawSrcY = 0, drawSrcW = srcWidth, drawSrcH = srcHeight;
    if (cropBox) {
      drawSrcX = cropBox.x;
      drawSrcY = cropBox.y;
      drawSrcW = cropBox.width;
      drawSrcH = cropBox.height;
    }
    // 查找resize操作的_srcCrop
    var resizeOp = null;
    for (var j = 0; j < operations.length; j++) {
      if (operations[j].type === 'resize' && operations[j]._srcCrop) {
        resizeOp = operations[j];
        break;
      }
    }
    // 检查是否有旋转
    var hasRotate = operations.some(function (o) { return o.type === 'rotate'; });
    if (resizeOp && resizeOp.fit === 'pad') {
      // pad模式：白底 + 居中缩放图
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, currentWidth, currentHeight);
      var padScale = Math.min(currentWidth / drawSrcW, currentHeight / drawSrcH);
      var drawW = drawSrcW * padScale, drawH = drawSrcH * padScale;
      var drawX = (currentWidth - drawW) / 2, drawY = (currentHeight - drawH) / 2;
      if (hasRotate) {
        ctx.save();
        ctx.translate(currentWidth / 2, currentHeight / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(image, drawSrcX, drawSrcY, drawSrcW, drawSrcH, -drawW / 2, -drawH / 2, drawW, drawH);
        ctx.restore();
      } else {
        ctx.drawImage(image, drawSrcX, drawSrcY, drawSrcW, drawSrcH, drawX, drawY, drawW, drawH);
      }
    } else if (resizeOp && resizeOp.fit === 'cover') {
      // cover模式：填满画布，裁剪源图
      if (hasRotate) {
        ctx.save();
        ctx.translate(currentWidth / 2, currentHeight / 2);
        ctx.rotate(Math.PI / 2);
        ctx.drawImage(image, resizeOp._srcCrop.x, resizeOp._srcCrop.y, resizeOp._srcCrop.w, resizeOp._srcCrop.h, -currentHeight / 2, -currentWidth / 2, currentHeight, currentWidth);
        ctx.restore();
      } else {
        ctx.drawImage(image, resizeOp._srcCrop.x, resizeOp._srcCrop.y, resizeOp._srcCrop.w, resizeOp._srcCrop.h, 0, 0, currentWidth, currentHeight);
      }
    } else if (hasRotate && !cropBox) {
      // 只有旋转，没有裁剪和resize
      ctx.save();
      ctx.translate(currentWidth / 2, currentHeight / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(image, -srcHeight / 2, -srcWidth / 2, srcHeight, srcWidth);
      ctx.restore();
    } else if (hasRotate && cropBox) {
      // 旋转 + 裁剪
      ctx.save();
      ctx.translate(currentWidth / 2, currentHeight / 2);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(image, drawSrcX, drawSrcY, drawSrcW, drawSrcH, -drawSrcH / 2, -drawSrcW / 2, drawSrcH, drawSrcW);
      ctx.restore();
    } else {
      // 简单情况：直接绘制
      ctx.drawImage(image, drawSrcX, drawSrcY, drawSrcW, drawSrcH, 0, 0, currentWidth, currentHeight);
    }
    var mime = outputFormat === 'png' ? 'image/png' : 'image/jpeg';
    var blob = await wmLocal.canvasToBlob(surface.canvas, { mime: mime, quality: 0.92 });
    return { blob: blob, width: currentWidth, height: currentHeight };
  }
  async function runProcess(label, operations, options) {
    var picked = selection();
    if (!picked.indexes.length) { status('请先勾选要处理的图片'); return; }
    var target = targetOf(rowAt(openedIndex));
    if (!target) { status('请先选择上架店铺，再处理图片'); return; }
    options = options || {};
    var outputFormat = options.outputFormat || outputFormatFromDrawer();
    await run(label, async function () {
      pushHistory();
      if (options.restoreOriginal) {
        picked.indexes.forEach(function (position) {
          var item = linkItems[position];
          if (!item) return;
          if (item.id) item.pendingProcess = { operations: [], outputFormat: outputFormat, restoreOriginal: true };
          else {
            if (item.localBlobUrl) { try { URL.revokeObjectURL(item.localBlobUrl); } catch (ignored) { void ignored; } }
            item.localBlob = null; item.localBlobUrl = ''; item.localProcessed = false; item.wmReplace = false; item.pendingProcess = null;
          }
        });
      } else {
        var failures = [];
        for (var i = 0; i < picked.indexes.length; i++) {
          var position = picked.indexes[i];
          var item = linkItems[position];
          if (!item) continue;
          try {
            var result = await processImageLocally(operations || [], item, outputFormat);
            if (item.localBlobUrl) { try { URL.revokeObjectURL(item.localBlobUrl); } catch (ignored2) { void ignored2; } }
            item.localProcessed = true;
            item.localBlob = result.blob;
            item.localBlobUrl = URL.createObjectURL(result.blob);
            item.wmReplace = Boolean(item.id);
          } catch (error) { failures.push({ position: position, message: (error && error.message) || '处理失败' }); }
        }
        if (failures.length) { status('部分图片处理失败：' + failures.map(function (f) { return f.message; }).join('；')); return; }
      }
      render();
      status(label.replace('正在', '').replace('…', '') + '完成：已处理 ' + picked.indexes.length + ' 张，请点击“保存草稿”或“确定编辑”提交到服务器');
    });
  }
  function openSelectionFromHook(mode) {
    var picked = selection();
    var indexes = picked.indexes.slice();
    if (!indexes.length && selectionState.itemKey) {
      var prior = linkItems.findIndex(function (item) { return ensureLocalImageKey(item) === selectionState.itemKey; });
      if (prior >= 0) indexes = [prior];
    }
    if (!indexes.length) { status(mode === 'crop' ? '请先勾选一张要裁剪的图片' : '请先勾选一张要去水印的图片'); return; }
    if (indexes.length > 1) status('将处理勾选中的第 1 张（共勾选 ' + indexes.length + ' 张）；要处理别的图请先只勾选它');
    openSelection(mode, indexes[0]);
  }
  function bindProcessHooks() {
    var rotate = $('skuImageRotate');
    if (rotate) rotate.addEventListener('click', function (event) { event.stopPropagation(); runProcess('正在旋转90°…', [{ type: 'rotate', degrees: 90 }]); });
    var resize = $('skuImageResize');
    if (resize) resize.addEventListener('click', function (event) {
      event.stopPropagation();
      var width = drawerNumber('skuImageWidth', 0), height = drawerNumber('skuImageHeight', 0);
      if (!width || !height) { status('请先在“图片工具”里填写宽度和高度（整数像素）'); return; }
      runProcess('正在调整尺寸…', [{ type: 'resize', width: width, height: height, fit: fitFromDrawer() }]);
    });
    var ratio = $('skuImageRatio');
    if (ratio) ratio.addEventListener('click', function (event) {
      event.stopPropagation();
      var width = $('skuImageWidth'), height = $('skuImageHeight'), fit = $('skuImageFit');
      if (width) width.value = '1200';
      if (height) height.value = '1600';
      if (fit && fit.options && fit.options.length) fit.value = fit.options[0].value || fit.options[0].textContent;
      runProcess('正在生成3:4白底图…', [{ type: 'resize', width: 1200, height: 1600, fit: 'pad' }]);
    });
    var crop = $('skuImageCrop');
    if (crop) crop.addEventListener('click', function (event) { event.stopPropagation(); openSelectionFromHook('crop'); });
    var repair = $('skuImageAiRepair');
    if (repair) repair.addEventListener('click', function (event) { event.stopPropagation(); openSelectionFromHook('repair'); });
    var watermark = $('skuImageWatermark');
    if (watermark) watermark.addEventListener('click', function (event) { event.stopPropagation(); openWatermarkDialog(); });
    var restore = $('skuImageRestore');
    if (restore) restore.addEventListener('click', function (event) { event.stopPropagation(); runProcess('正在恢复原图…', [], { restoreOriginal: true }); });
  }


  // ── 我们自己的“图片处理”弹窗（自有 ImageMagick 引擎，不接第三方） ──
  // 验收页的“图片工具”抽屉只有宽/高/适配/格式四个字段、没有提交入口，
  // 因此把旋转、自定义尺寸、一键3:4、恢复原图统一收进这个弹窗；弹窗用浏览器原生 dialog，走顶层不遮挡编辑器。
  // 布局：左侧操作控件、右侧原图预览；所有操作在弹窗内本地完成并即时预览，点“确认”仅在浏览器本地生成新图替换当前页面里的原图（0 服务端请求），点“取消”放弃。
  var processOps = [];
  var processSource = null;
  var processFormat = 'jpeg';
  var processScopeIndexes = null; // 单张卡片菜单进入时只处理这一张；null=按勾选
  function processCanvas() { return document.getElementById('skuImageProcessPreview'); }
  function processInfoLine() { return document.getElementById('skuImageProcessPreviewInfo'); }
  function processStateLine() { return document.getElementById('skuImageProcessState'); }
  function processState(text, isError) {
    var line = processStateLine();
    if (!line) return;
    line.textContent = text;
    line.style.color = isError ? '#b91c1c' : '#6c5ce7';
  }
  function processOpsSummary() {
    return processOps.map(function (op) {
      if (op.type === 'rotate') return '旋转' + op.degrees + '°';
      if (op.type === 'resize') {
        var fitText = op.fit === 'cover' ? '居中裁剪' : op.fit === 'stretch' ? '直接拉伸' : '白底补边';
        return '尺寸 ' + op.width + '×' + op.height + '（' + fitText + '）';
      }
      return '未知操作';
    }).join('、') || '无';
  }
  function drawProcessOps(source, ops) {
    var cur = source;
    var cw = source.width, ch = source.height;
    ops.forEach(function (op) {
      if (op.type === 'rotate') {
        var deg = ((Number(op.degrees) % 360) + 360) % 360;
        var ncw = cw, nch = ch;
        if (deg === 90 || deg === 270) { ncw = ch; nch = cw; }
        var c = document.createElement('canvas');
        c.width = ncw; c.height = nch;
        var ctx = c.getContext('2d');
        ctx.save();
        ctx.translate(ncw / 2, nch / 2);
        ctx.rotate(deg * Math.PI / 180);
        ctx.drawImage(cur, -cw / 2, -ch / 2);
        ctx.restore();
        cur = c; cw = ncw; ch = nch;
      } else if (op.type === 'resize') {
        var nw = Math.max(1, Math.round(Number(op.width) || 0));
        var nh = Math.max(1, Math.round(Number(op.height) || 0));
        var c2 = document.createElement('canvas');
        c2.width = nw; c2.height = nh;
        var ctx2 = c2.getContext('2d');
        if (op.fit === 'stretch') {
          ctx2.drawImage(cur, 0, 0, nw, nh);
        } else if (op.fit === 'cover') {
          var coverScale = Math.max(nw / cw, nh / ch);
          var sw = cw * coverScale, sh = ch * coverScale;
          ctx2.drawImage(cur, (nw - sw) / 2, (nh - sh) / 2, sw, sh);
        } else {
          ctx2.fillStyle = '#ffffff';
          ctx2.fillRect(0, 0, nw, nh);
          var padScale = Math.min(nw / cw, nh / ch);
          var dw = cw * padScale, dh = ch * padScale;
          ctx2.drawImage(cur, (nw - dw) / 2, (nh - dh) / 2, dw, dh);
        }
        cur = c2; cw = nw; ch = nh;
      }
    });
    return { canvas: cur, width: cw, height: ch };
  }
  var processRenderVersion = 0;
  var processPreviewItems = [];
  var processPresetOps = null;
  function processGrid() { return document.getElementById('skuImageProcessGrid'); }
  function renderProcessPreviewGrid() {
    var grid = processGrid(), info = processInfoLine();
    if (!grid) return;
    var version = ++processRenderVersion;
    grid.replaceChildren();
    var items = processPreviewItems.slice();
    if (!items.length) { info.textContent = '没有可预览的图片'; return; }
    info.textContent = '共 ' + items.length + ' 张：' + (processOps.length ? '待应用 ' + processOpsSummary() : (items.some(function (item) { return item.localProcessed; }) ? '已本地应用，可继续选择操作或点“取消”退出' : '已加载原图，未改动：选择左侧操作开始预览'));
    processState(processOps.length ? '已预览，未改动原图：点“确认”才处理全部勾选图片，点“取消”放弃' : '已加载原图，未改动：选择左侧操作开始预览', false);
    var queue = items.slice();
    async function worker() {
      while (queue.length) {
        var item = queue.shift();
        var position = items.indexOf(item);
        var card = processPreviewCard(item, position, items.length > 1);
        grid.append(card);
        var src = imageUrlOf(item);
        if (!src) { card.dim.textContent = '无可用地址'; continue; }
        try {
          var img = await loadProcessImage(src);
          if (version !== processRenderVersion) return;
          var out = drawProcessOps(img, processOps);
          if (version !== processRenderVersion) return;
          var maxSide = 300;
          var scale = Math.min(1, maxSide / Math.max(out.width, out.height));
          var pc = document.createElement('canvas');
          pc.width = Math.max(1, Math.round(out.width * scale));
          pc.height = Math.max(1, Math.round(out.height * scale));
          pc.getContext('2d').drawImage(out.canvas, 0, 0, pc.width, pc.height);
          card.holder.append(pc);
          card.dim.textContent = '原图 ' + img.naturalWidth + '×' + img.naturalHeight + (processOps.length ? ' → ' + out.width + '×' + out.height : '');
        } catch (error) {
          if (version !== processRenderVersion) return;
          card.dim.textContent = '图片地址读不到';
        }
      }
    }
    Promise.all([worker(), worker()]);
  }
  function zoomProcessCard(item, index) {
    var old = document.getElementById('skuProcessZoomLayer');
    if (old) old.remove();
    var layer = document.createElement('dialog');
    layer.id = 'skuProcessZoomLayer';
    layer.setAttribute('aria-label', '放大预览图片');
    layer.style.cssText = 'border:0;padding:18px;background:rgba(8,11,18,.86);width:100vw;height:100vh;max-width:none;max-height:none';
    var figure = document.createElement('figure');
    figure.style.cssText = 'margin:0;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px';
    var caption = document.createElement('figcaption');
    caption.style.cssText = 'color:#e5e7eb;font-size:12px';
    caption.textContent = '第 ' + (index + 1) + ' 张 · 正在加载大图…';
    figure.append(caption);
    layer.append(figure);
    document.body.append(layer);
    if (typeof layer.showModal === 'function') layer.showModal(); else layer.setAttribute('open', '');
    var canvas = null;
    var src = imageUrlOf(item);
    if (!src) { caption.textContent = '第 ' + (index + 1) + ' 张 · 这张图打不开（可能尚未安全转存），点任意处关闭'; }
    else {
      loadProcessImage(src).then(function (img) {
        var out = drawProcessOps(img, processOps);
        canvas = out.canvas;
        canvas.style.cssText = [
          'max-width:calc(100vw - 36px)',
          'max-height:calc(100vh - 84px)',
          'min-width:min(60vw,480px)',
          'min-height:min(60vh,480px)',
          'object-fit:contain',
          'border-radius:8px',
          'background:#fff',
          'display:block'
        ].join(';');
        figure.insertBefore(canvas, caption);
        caption.textContent = '第 ' + (index + 1) + ' 张 · 缩放 ' + Math.round(scale * 100) + '%（滚轮缩放、拖动平移、双击复原），点空白处或按 Esc 关闭';
      }).catch(function () { caption.textContent = '第 ' + (index + 1) + ' 张 · 这张图打不开（可能尚未安全转存），点任意处关闭'; });
    }
    // 放大查看支持滚轮缩放与拖动平移（0.4×—6×，双击回到原始大小）
    var scale = 1, offsetX = 0, offsetY = 0, panning = false, startX = 0, startY = 0;
    function applyTransform() {
      if (!canvas) return;
      canvas.style.transformOrigin = 'center center';
      canvas.style.transform = 'translate(' + offsetX + 'px, ' + offsetY + 'px) scale(' + scale + ')';
      caption.textContent = '第 ' + (index + 1) + ' 张 · 缩放 ' + Math.round(scale * 100) + '%（滚轮缩放、拖动平移、双击复原），点空白处或按 Esc 关闭';
    }
    layer.addEventListener('wheel', function (event) {
      event.preventDefault();
      event.stopPropagation();
      scale = Math.min(6, Math.max(0.4, scale * (event.deltaY < 0 ? 1.15 : 0.87)));
      applyTransform();
    }, { passive: false });
    layer.addEventListener('pointerdown', function (event) {
      if (event.target !== canvas) return;
      panning = true;
      startX = event.clientX - offsetX;
      startY = event.clientY - offsetY;
      canvas.style.cursor = 'grabbing';
      event.preventDefault();
    });
    window.addEventListener('pointermove', function (event) {
      if (!panning) return;
      offsetX = event.clientX - startX;
      offsetY = event.clientY - startY;
      applyTransform();
    });
    window.addEventListener('pointerup', function () {
      panning = false;
      if (canvas) canvas.style.cursor = 'grab';
    });
    layer.addEventListener('dblclick', function (event) {
      if (event.target !== canvas) return;
      scale = 1; offsetX = 0; offsetY = 0;
      applyTransform();
    });
    layer.addEventListener('click', function (event) { if (event.target === layer) layer.close(); });
    layer.addEventListener('close', function () { layer.remove(); });
  }
  function processPreviewCard(item, index, canRemove) {
    var card = document.createElement('div');
    card.style.cssText = 'width:150px;flex:none;border-radius:12px;padding:8px;background:#fff;border:1.5px solid #e6e8f0;display:flex;flex-direction:column;gap:5px;position:relative';
    var zoomBtn = document.createElement('button');
    zoomBtn.type = 'button';
    zoomBtn.setAttribute('aria-label', '放大预览第' + (index + 1) + '张');
    zoomBtn.textContent = '\u25CE';
    zoomBtn.title = '放大预览';
    zoomBtn.style.cssText = 'position:absolute;top:6px;left:6px;z-index:3;width:22px;height:22px;line-height:20px;border:1.5px solid #d5dae6;border-radius:50%;background:rgba(255,255,255,.92);color:#5b6478;font-size:11px;cursor:pointer';
    zoomBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      zoomProcessCard(item, index);
    });
    card.append(zoomBtn);
    if (canRemove) {
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.setAttribute('aria-label', '移除第' + (index + 1) + '张（本次不处理）');
      removeBtn.textContent = '×';
      removeBtn.style.cssText = 'position:absolute;top:6px;right:6px;z-index:3;width:22px;height:22px;line-height:20px;border:1.5px solid #f3c2c2;border-radius:50%;background:rgba(255,255,255,.92);color:#dc2626;font-size:13px;cursor:pointer';
      removeBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        processPreviewItems.splice(index, 1);
        renderProcessPreviewGrid();
      });
      card.append(removeBtn);
    }
    var holder = document.createElement('div');
    holder.style.cssText = 'width:134px;height:134px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:8px;overflow:hidden';
    var meta = document.createElement('div');
    meta.style.cssText = 'font-size:11px;color:#5b6478;text-align:center';
    meta.textContent = '第 ' + (index + 1) + ' 张';
    var dim = document.createElement('div');
    dim.style.cssText = 'font-size:10px;color:#8a93a6;min-height:24px;line-height:1.3;text-align:center';
    card.append(holder, meta, dim);
    card.holder = holder;
    card.dim = dim;
    return card;
  }
  function pushProcessOp(op, successTip) {
    if (op.type === 'rotate') {
      // 旋转合并：所有旋转角度累加，0° 则移除；合并后放在原第一个旋转的位置，避免重复显示
      var total = 0, firstIndex = -1;
      for (var i = 0; i < processOps.length; i++) {
        if (processOps[i].type === 'rotate') {
          if (firstIndex < 0) firstIndex = i;
          total = (total + Number(processOps[i].degrees || 0)) % 360;
        }
      }
      processOps = processOps.filter(function (entry) { return entry.type !== 'rotate'; });
      total = ((total + Number(op.degrees || 0)) % 360 + 360) % 360;
      if (total !== 0) {
        var merged = { type: 'rotate', degrees: total };
        if (firstIndex < 0) processOps.push(merged);
        else processOps.splice(firstIndex, 0, merged);
      }
    } else if (op.type === 'resize') {
      // 尺寸覆盖：只保留最后一次尺寸操作（预览以最后一次为准）
      processOps = processOps.filter(function (entry) { return entry.type !== 'resize'; });
      processOps.push(op);
    } else {
      processOps.push(op);
    }
    renderProcessPreviewGrid();
    if (successTip) processState(successTip + '（已加入待应用列表，点“确认”生效）', false);
  }
  function popProcessOp() {
    if (!processOps.length) { processState('没有可撤销的处理步骤', true); return; }
    processOps.pop();
    renderProcessPreviewGrid();
    processState('已撤销上一步，当前待应用：' + processOpsSummary(), false);
  }
  function clearProcessOps() {
    processOps.length = 0;
    renderProcessPreviewGrid();
    processState('已恢复原图预览（待应用操作已清空；点“确认”则不做任何处理）', false);
  }
  function initProcessPreviewGrid() {
    processOps.length = 0;
    processSource = null;
    var positions = (processScopeIndexes && processScopeIndexes.length) ? processScopeIndexes.slice() : selection().indexes.slice();
    processPreviewItems = positions.map(function (position) { return linkItems[position]; }).filter(Boolean);
    renderProcessPreviewGrid();
  }
  function processDialogBody() {
    var layout = document.createElement('div');
    layout.style.cssText = 'display:flex;gap:14px;padding:14px 16px;min-height:0;flex:1';
    var left = document.createElement('div');
    left.style.cssText = 'flex:0 0 400px;min-width:0;display:flex;flex-direction:column;gap:14px;overflow:auto';
    var right = document.createElement('div');
    right.style.cssText = 'flex:1;min-width:0;display:flex;flex-direction:column;gap:10px';
    var previewBox = document.createElement('div');
    previewBox.style.cssText = 'flex:1;min-height:0;border:1px solid var(--line,#e6e8f0);border-radius:12px;background:#f6f7fa;overflow:auto;position:relative';
    var previewTag = document.createElement('span');
    previewTag.textContent = '批量预览';
    previewTag.style.cssText = 'position:sticky;top:8px;left:8px;z-index:2;font-size:11px;color:#5b6478;background:rgba(255,255,255,.92);padding:2px 10px;border-radius:6px;border:1px solid #e0e4ee;width:max-content;margin:8px 0 0 8px';
    previewBox.append(previewTag);
    var grid = document.createElement('div');
    grid.id = 'skuImageProcessGrid';
    grid.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;padding:4px 12px 12px;align-content:flex-start';
    previewBox.append(grid);
    var info = document.createElement('p');
    info.id = 'skuImageProcessPreviewInfo';
    info.style.cssText = 'margin:0;font-size:12px;color:var(--text-muted,#64748b)';
    right.append(previewBox, info);
    var wrap = left;
    var count = document.createElement('p');
    count.style.cssText = 'margin:0;font-size:12px;color:var(--text-muted,#64748b)';
    var processCount = (processScopeIndexes && processScopeIndexes.length) ? processScopeIndexes.length : (selection().ids.length || selection().indexes.length);
    count.textContent = (processScopeIndexes ? '单张编辑：只处理这 1 张图片，不会动其它已勾选图片；' : '将处理 ' + processCount + ' 张勾选图片；') + '所有操作在弹窗内本地完成，点“确认”在本地替换原图并关闭，点“取消”放弃（不产生服务端请求）';
    wrap.append(count);
    [
      { title: '旋转', buttons: [['顺时针90°', function () { pushProcessOp({ type: 'rotate', degrees: 90 }, '已预览旋转90°'); }], ['180°', function () { pushProcessOp({ type: 'rotate', degrees: 180 }, '已预览旋转180°'); }], ['270°', function () { pushProcessOp({ type: 'rotate', degrees: 270 }, '已预览旋转270°'); }]] },
      { title: '一键比例', buttons: [['3:4 白底 1200×1600', function () { pushProcessOp({ type: 'resize', width: 1200, height: 1600, fit: 'pad' }, '已预览3:4白底'); }], ['1:1 方图 1200×1200', function () { pushProcessOp({ type: 'resize', width: 1200, height: 1200, fit: 'pad' }, '已预览1:1方图'); }]] },
      { title: '自定义尺寸', custom: true }
    ].forEach(function (group) {
      var box = document.createElement('div');
      box.style.cssText = 'border:1px solid var(--line,#e2e8f0);border-radius:10px;padding:12px 14px;background:var(--card,#fff)';
      var label = document.createElement('strong');
      label.textContent = group.title;
      label.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:10px';
      var dot = document.createElement('i');
      dot.style.cssText = 'width:3px;height:13px;border-radius:2px;background:var(--accent,#d4a017);display:inline-block';
      label.prepend(dot);
      box.append(label);
      if (group.custom) {
        function dimField(labelText, input, unitText) {
          var lab = document.createElement('label');
          lab.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted,#64748b)';
          lab.append(document.createTextNode(labelText), input, document.createTextNode(unitText));
          return lab;
        }
        var width = document.createElement('input');
        width.type = 'number'; width.min = '1'; width.value = '1200';
        width.setAttribute('aria-label', '目标宽度（像素）');
        var height = document.createElement('input');
        height.type = 'number'; height.min = '1'; height.value = '1600';
        height.setAttribute('aria-label', '目标高度（像素）');
        var fit = document.createElement('select');
        fit.setAttribute('aria-label', '适配方式');
        [['pad', '白底补边'], ['cover', '居中裁剪'], ['stretch', '直接拉伸']].forEach(function (option2) {
          var o = document.createElement('option');
          o.value = option2[0]; o.textContent = option2[1];
          fit.append(o);
        });
        var format = document.createElement('select');
        format.setAttribute('aria-label', '输出格式');
        [['jpeg', 'JPG'], ['png', 'PNG']].forEach(function (option2) {
          var o = document.createElement('option');
          o.value = option2[0]; o.textContent = option2[1];
          format.append(o);
        });
        [width, height, fit, format].forEach(function (field) {
          field.style.cssText = 'height:30px;padding:0 8px;border:1px solid var(--line,#cbd5e1);border-radius:7px;background:var(--card,#fff);color:var(--text,#111);font-size:13px;width:110px';
        });
        width.style.width = '86px'; height.style.width = '86px';
        var dimRow = document.createElement('div');
        dimRow.style.cssText = 'display:flex;gap:12px;align-items:center;margin-bottom:8px;flex-wrap:wrap';
        dimRow.append(dimField('宽', width, 'px'), dimField('高', height, 'px'));
        box.append(dimRow);
        function selLabel(text, sel) {
          var lab = document.createElement('label');
          lab.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-muted,#64748b)';
          lab.append(document.createTextNode(text), sel);
          return lab;
        }
        var apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'btn btn-primary';
        apply.textContent = '应用尺寸';
        apply.addEventListener('click', function () {
          var w = Number(width.value), h = Number(height.value);
          if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) { processState('宽高必须是正整数像素', true); return; }
          if (w > 12000 || h > 12000 || w * h > 40000000) { processState('超出处理上限（单边≤12000、总像素≤4000万）', true); return; }
          processFormat = format.value;
          pushProcessOp({ type: 'resize', width: w, height: h, fit: fit.value }, '已预览自定义尺寸 ' + w + '×' + h + 'px');
          applyProcessNow();
        });
        var optsRow = document.createElement('div');
        optsRow.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
        optsRow.append(selLabel('适配', fit), selLabel('格式', format), apply);
        box.append(optsRow);
        var hint = document.createElement('p');
        hint.style.cssText = 'margin:8px 0 0;font-size:11px;color:var(--text-muted,#64748b)';
        hint.textContent = '上限：单边 12000px、总像素 4000 万';
        box.append(hint);
      } else {
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center';
        group.buttons.forEach(function (pair) {
          var button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn';
          button.textContent = pair[0];
          button.style.cssText = 'flex:1;height:32px;justify-content:center';
          button.addEventListener('click', pair[1]);
          row.append(button);
        });
        var applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'btn btn-primary';
        applyBtn.textContent = '应用';
        applyBtn.style.cssText = 'flex:0 0 56px;height:32px;justify-content:center';
        applyBtn.setAttribute('aria-label', '应用' + group.title + '操作并直接处理图片');
        applyBtn.addEventListener('click', function () { applyProcessNow(); });
        row.append(applyBtn);
        box.append(row);
      }
      wrap.append(box);
    });
    var state = document.createElement('p');
    state.id = 'skuImageProcessState';
    state.style.cssText = 'margin:0;font-size:12px;min-height:18px;padding:8px 10px;border-radius:8px;background:var(--bg-muted,#f1f5f9)';
    wrap.append(state);
    var note = document.createElement('p');
    note.style.cssText = 'margin:0;font-size:11px;color:var(--text-muted,#64748b)';
    note.textContent = '裁剪与去水印需要框选区域，选区弹窗使用页面已有的“图片选区”对话框，正在接入；这里先提供不依赖选区的处理。';
    wrap.append(note);
    layout.append(left, right);
    setTimeout(function () {
      initProcessPreviewGrid();
      if (processPresetOps && processPresetOps.length) {
        processOps = processPresetOps.slice();
        processPresetOps = null;
        renderProcessPreviewGrid();
        processState('已预置：' + processOpsSummary() + '；点“确认”处理全部勾选图片，点“取消”放弃', false);
      }
    }, 0);
    return layout;
  }
  function openProcessDialog(presetOps, scope) {
    processScopeIndexes = scope && Number.isInteger(scope.singleIndex) ? [scope.singleIndex] : null;
    var picked = { indexes: scopeIndexes(scope) };
    if (!picked.indexes.length) { status(scope ? '这张图片读不到，无法处理' : '请先勾选要处理的图片'); return; }
    processPresetOps = Array.isArray(presetOps) ? presetOps : null;
    var shell = wyShell({ id: 'skuImageProcessDialog', size: 'lg', title: '图片处理' });
    shell.body.style.padding = '0';
    shell.body.style.gap = '0';
    shell.body.append(processDialogBody());
    var cancel = wyBtn('取消', 'ghost');
    cancel.addEventListener('click', function () { shell.close(); });
    var confirm = wyBtn('确认（替换原图）', 'primary');
    confirm.addEventListener('click', function () { confirmProcessDialog(shell.dialog); });
    shell.foot.append(cancel, confirm);
    shell.open();
  }
  function loadProcessImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.addEventListener('load', function () { resolve(img); });
      img.addEventListener('error', function () { reject(new Error('原图读不到，无法本地处理')); });
      img.src = src;
    });
  }
  function canvasToBlob(canvas, format) {
    return new Promise(function (resolve, reject) {
      var mime = format === 'png' ? 'image/png' : 'image/jpeg';
      var quality = format === 'png' ? undefined : 0.92;
      canvas.toBlob(function (blob) { if (blob) resolve(blob); else reject(new Error('生成图片失败')); }, mime, quality);
    });
  }
  // 确认时纯本地处理：加载该图当前显示内容 → 应用操作栈 → 生成 Blob → 替换该图在页面里的显示，0 服务端请求
  async function applyProcessToItem(item) {
    try {
      var src = imageUrlOf(item);
      if (!src) throw new Error('该图没有可处理的地址');
      var img = await loadProcessImage(src);
      var result = drawProcessOps(img, processOps);
      var blob = await canvasToBlob(result.canvas, processFormat);
      if (item.localBlobUrl) { try { URL.revokeObjectURL(item.localBlobUrl); } catch (ignored) { void ignored; } }
      item.localBlobUrl = URL.createObjectURL(blob);
      item.localBlob = blob;
      item.width = result.width;
      item.height = result.height;
      item.localProcessed = true;
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error && error.message ? error.message : '未知原因' };
    }
  }
  async function confirmProcessDialog(dialog) {
    if (!processOps.length) {
      // 没有待应用操作：若已经用“应用”处理过，确认只是关闭（替换已完成）；否则提示先选操作
      if (processPreviewItems.some(function (item) { return item.localProcessed; })) {
        dialog.close();
        status('已完成本地替换 ' + processPreviewItems.length + ' 张（未上传服务器）');
        return;
      }
      processState('还没有任何处理操作：先在左侧选择旋转或尺寸；不需要处理就直接点“取消”', true); return;
    }
    var items = processPreviewItems.slice();
    if (!items.length) { processState('请先勾选要处理的图片（弹窗内可点卡片右上角 × 移除多余的图）', true); return; }
    var summary = processOpsSummary();
    processState('正在本地处理 ' + items.length + ' 张：' + summary + '…', false);
    status('正在本地处理图片…');
    if (!items.length) { processState('没有可处理的图片', true); return; }
    var okCount = 0, failMessages = [];
    try {
      pushHistory();
      var queue = items.slice();
      async function worker() {
        while (queue.length) {
          var item = queue.shift();
          var result = await applyProcessToItem(item);
          if (result.ok) okCount += 1; else failMessages.push(result.message);
        }
      }
      await Promise.all([worker(), worker()]);
    } catch (error) {
      var message = error && error.message ? error.message : '未知原因';
      processState('本地处理失败：' + message + '（原图未被改动，可重试或点“取消”退出）', true);
      status('失败：' + message);
      return;
    }
    render();
    dialog.close();
    var suffix = failMessages.length ? '，失败 ' + failMessages.length + ' 张：' + failMessages.join('；') : '';
    if (okCount) {
      status('已本地处理 ' + okCount + ' 张：' + summary + '（仅当前页面替换原图，未上传服务器；刷新或重新进入会恢复服务器原图）' + suffix);
      processState('完成：已本地替换 ' + okCount + ' 张，未上传服务器' + (failMessages.length ? '；失败项仍保留原图：' + failMessages.join('；') : ''), failMessages.length > 0);
    } else {
      processState('处理失败，原图未改动：' + failMessages.join('；'), true);
      status('失败：' + failMessages.join('；'));
    }
  }
  // 组内“应用”按钮：把当前待应用的操作直接处理到全部勾选图（本地替换），不关弹窗
  async function applyProcessNow() {
    if (!processOps.length) { processState('请先在左侧选择旋转或尺寸，再点“应用”', true); return; }
    var items = processPreviewItems.slice();
    if (!items.length) { processState('请先勾选要处理的图片（弹窗内可点卡片右上角 × 移除多余的图）', true); return; }
    var summary = processOpsSummary();
    processState('正在应用并处理 ' + items.length + ' 张：' + summary + '…', false);
    status('正在本地应用 ' + summary + '…');
    var okCount = 0, failMessages = [];
    try {
      pushHistory();
      var queue = items.slice();
      async function worker() {
        while (queue.length) {
          var item = queue.shift();
          var result = await applyProcessToItem(item);
          if (result.ok) okCount += 1; else failMessages.push(result.message);
        }
      }
      await Promise.all([worker(), worker()]);
    } catch (error) {
      var message = error && error.message ? error.message : '未知原因';
      processState('本地处理失败：' + message + '（原图未被改动，可重试或点“取消”退出）', true);
      status('失败：' + message);
      return;
    }
    processOps.length = 0;
    processSource = null;
    renderProcessPreviewGrid();
    var suffix = failMessages.length ? '，失败 ' + failMessages.length + ' 张：' + failMessages.join('；') : '';
    if (okCount) {
      status('已应用 ' + okCount + ' 张：' + summary + '（仅当前页面替换原图，未上传服务器）' + suffix);
      processState('已应用 ' + okCount + ' 张：' + summary + '，可继续选择操作或点“取消”退出' + (failMessages.length ? '；失败项：' + failMessages.join('；') : ''), failMessages.length > 0);
    } else {
      processState('处理失败，原图未改动：' + failMessages.join('；'), true);
      status('失败：' + failMessages.join('；'));
    }
  }


  // ── 选区弹窗：复用验收页已有的 #skuImageSelectionDialog（工具条/画布/撤销/清空/取消/应用都在） ──
  // 矩形、椭圆、多边形、自由套索、画笔与橡皮统一生成选区蒙版；服务端仍负责PNG蒙版和像素边界校验。
  // 用途两种：裁剪 → crop(x,y,w,h)；去水印/修复 → watermark + PNG 蒙版（服务端为中值修补，且要求单帧、≤2048 边、≤400 万像素、≤512KB）
  var selectionState = { mode: '', image: null, shapes: [], redo: [], tool: 'rect', stroke: null, dragging: null, polygonDraft: null, natural: { width: 0, height: 0 }, display: { width: 0, height: 0 }, itemKey: '' };

  function selectionCanvas() { return $('skuSelectionCanvas'); }
  function selectionImageEl() { return $('skuSelectionImage'); }
  function selectionHelp() { return $('skuSelectionHelp'); }

  function paintShape(ctx, shape, kx, ky) {
    ctx.beginPath();
    if (shape.type === 'ellipse') { ctx.ellipse((shape.x1 + shape.x2) / 2 * kx, (shape.y1 + shape.y2) / 2 * ky, Math.abs(shape.x2 - shape.x1) / 2 * kx, Math.abs(shape.y2 - shape.y1) / 2 * ky, 0, 0, Math.PI * 2); ctx.fill(); return; }
    if (shape.type === 'polygon') {
      var polygonPoints = shape.points || [];
      if (polygonPoints.length < 3) return;
      ctx.moveTo(polygonPoints[0][0] * kx, polygonPoints[0][1] * ky);
      polygonPoints.slice(1).forEach(function (point) { ctx.lineTo(point[0] * kx, point[1] * ky); });
      ctx.closePath(); ctx.fill(); return;
    }
    if (shape.type === 'stroke') {
      ctx.lineWidth = Math.max(1, (shape.size || 14) * ((kx + ky) / 2));
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = shape.color || '#ffffff';
      var points = shape.points || [];
      if (points.length < 2) { ctx.arc(points[0][0] * kx, points[0][1] * ky, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); return; }
      ctx.moveTo(points[0][0] * kx, points[0][1] * ky);
      points.forEach(function (point, position) { if (position) ctx.lineTo(point[0] * kx, point[1] * ky); });
      ctx.stroke();
      return;
    }
    ctx.rect(Math.min(shape.x1, shape.x2) * kx, Math.min(shape.y1, shape.y2) * ky, Math.abs(shape.x2 - shape.x1) * kx, Math.abs(shape.y2 - shape.y1) * ky);
    ctx.fill();
  }
  function replayShapes(ctx, kx, ky, eraseToTransparent) {
    selectionState.shapes.forEach(function (shape) {
      if (shape.type === 'stroke') { ctx.globalCompositeOperation = shape.erase ? (eraseToTransparent ? 'destination-out' : 'destination-out') : 'source-over'; ctx.strokeStyle = shape.color || '#ffffff'; ctx.fillStyle = shape.color || '#ffffff'; }
      else { ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#ffffff'; }
      paintShape(ctx, shape, kx, ky);
    });
    ctx.globalCompositeOperation = 'source-over';
  }
  function drawSelection() {
    var canvas = selectionCanvas();
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    selectionState.shapes.forEach(function (shape) {
      ctx.strokeStyle = shape.erase ? '#ef4444' : '#7562ed';
      ctx.fillStyle = shape.erase ? 'rgba(239,68,68,.22)' : 'rgba(117,98,237,.28)';
      paintShape(ctx, Object.assign({}, shape, { type: shape.type === 'stroke' ? 'stroke' : shape.type }), 1, 1);
    });
    if (selectionState.polygonDraft && selectionState.polygonDraft.length) {
      var draft = selectionState.polygonDraft;
      ctx.save(); ctx.strokeStyle = '#7562ed'; ctx.fillStyle = 'rgba(117,98,237,.10)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(draft[0][0], draft[0][1]); draft.slice(1).forEach(function (point) { ctx.lineTo(point[0], point[1]); }); ctx.stroke();
      draft.forEach(function (point) { ctx.beginPath(); ctx.arc(point[0], point[1], 3, 0, Math.PI * 2); ctx.fill(); }); ctx.restore();
    }
  }


  function shapeBox(shape) {
    if (shape.type === 'polygon') {
      var px = shape.points.map(function (point) { return point[0]; }), py = shape.points.map(function (point) { return point[1]; });
      return { x1: Math.min.apply(null, px), y1: Math.min.apply(null, py), x2: Math.max.apply(null, px), y2: Math.max.apply(null, py) };
    }
    if (shape.type === 'stroke') {
      var xs = shape.points.map(function (point) { return point[0]; }), ys = shape.points.map(function (point) { return point[1]; });
      var half = (shape.size || 16) / 2;
      return { x1: Math.min.apply(null, xs) - half, y1: Math.min.apply(null, ys) - half, x2: Math.max.apply(null, xs) + half, y2: Math.max.apply(null, ys) + half };
    }
    return { x1: Math.min(shape.x1, shape.x2), y1: Math.min(shape.y1, shape.y2), x2: Math.max(shape.x1, shape.x2), y2: Math.max(shape.y1, shape.y2) };
  }
  function selectionBounds() {
    if (!selectionState.shapes.length) return null;
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    selectionState.shapes.forEach(function (shape) {
      var box = shapeBox(shape);
      x1 = Math.min(x1, box.x1); y1 = Math.min(y1, box.y1);
      x2 = Math.max(x2, box.x2); y2 = Math.max(y2, box.y2);
    });
    var canvas = selectionCanvas(), rect = canvas.getBoundingClientRect();
    var nw = selectionState.natural.width, nh = selectionState.natural.height;
    var sx = nw / (rect.width || 1), sy = nh / (rect.height || 1);
    var box = {
      x: Math.max(0, Math.floor(x1 * sx)), y: Math.max(0, Math.floor(y1 * sy)),
      width: Math.min(nw, Math.ceil((x2 - x1) * sx)), height: Math.min(nh, Math.ceil((y2 - y1) * sy))
    };
    box.width = Math.max(1, Math.min(box.width, nw - box.x));
    box.height = Math.max(1, Math.min(box.height, nh - box.y));
    return box;
  }

  function buildMaskDataUrl(box) {
    var canvas = selectionCanvas();
    var rect = canvas.getBoundingClientRect();
    var base = Math.max(rect.width || 1, rect.height || 1, box && box.width || 1, box && box.height || 1);
    var scale = Math.min(1, 2048 / base, Math.sqrt(3600000 / Math.max(1, (rect.width || 1) * (rect.height || 1))));
    var mask = document.createElement('canvas');
    mask.width = Math.max(1, Math.round((rect.width || 1) * scale));
    mask.height = Math.max(1, Math.round((rect.height || 1) * scale));
    var ctx = mask.getContext('2d');
    replayShapes(ctx, mask.width / Math.max(1, rect.width || 1), mask.height / Math.max(1, rect.height || 1), true);
    return mask.toDataURL('image/png');
  }

  function bindSelectionDrawing() {
    var canvas = selectionCanvas();
    if (!canvas || canvas.dataset.enhBound) return;
    canvas.dataset.enhBound = '1';
    var current = 'rect';
    document.querySelectorAll('#skuImageSelectionDialog [data-selection-tool]').forEach(function (button) {
      button.addEventListener('click', function () {
        var tool = button.getAttribute('data-selection-tool');
        var names = { rectangle: 'rect', ellipse: 'ellipse', brush: 'brush', eraser: 'eraser', polygon: 'polygon', lasso: 'lasso' };
        var picked2 = names[tool] || 'rect';
        if (selectionState.polygonDraft && picked2 !== 'polygon') { selectionState.polygonDraft = null; drawSelection(); }
        current = picked2;
        selectionState.tool = picked2;
        document.querySelectorAll('#skuImageSelectionDialog [data-selection-tool]').forEach(function (other) { other.classList.toggle('on', other === button); });
        if (selectionHelp()) selectionHelp().textContent = {
          rect: '在图片上拖动绘制矩形选区', ellipse: '在图片上拖动绘制椭圆选区',
          polygon: '逐点点击绘制多边形；双击或点击起点附近完成闭合', lasso: '按住拖动自由套索，松开后自动闭合',
          brush: '按住拖动涂抹要修补的区域（画笔）', eraser: '按住拖动擦除涂错的部分（橡皮）'
        }[picked2] || '选择一种选区工具';
      });
    });
    function point(event) {
      var rect = canvas.getBoundingClientRect();
      var source = event.touches && event.touches[0] ? event.touches[0] : event;
      return { x: Math.min(rect.width, Math.max(0, source.clientX - rect.left)), y: Math.min(rect.height, Math.max(0, source.clientY - rect.top)) };
    }
    function finishPolygon() {
      var points = selectionState.polygonDraft;
      if (!points || points.length < 3) { if (selectionHelp()) selectionHelp().textContent = '多边形至少需要3个点'; return false; }
      selectionState.shapes.push({ type: 'polygon', points: points.slice() }); selectionState.polygonDraft = null; selectionState.redo.length = 0; drawSelection();
      if (selectionHelp()) selectionHelp().textContent = '已框选 ' + selectionState.shapes.length + ' 处，点“应用选区”提交处理';
      return true;
    }
    function start(event) {
      if (!selectionState.image) return;
      if (current === 'polygon') return;
      event.preventDefault();
      var p = point(event);
      selectionState.redo.length = 0;
      if (current === 'brush' || current === 'eraser') {
        selectionState.dragging = { type: 'stroke', erase: current === 'eraser', color: '#ffffff', size: 16, points: [[p.x, p.y]] };
      } else if (current === 'lasso') {
        selectionState.dragging = { type: 'polygon', lasso: true, points: [[p.x, p.y]] };
      } else {
        selectionState.dragging = { type: current, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      }
      selectionState.shapes.push(selectionState.dragging);
      drawSelection();
    }
    function move(event) {
      if (!selectionState.dragging) return;
      event.preventDefault();
      var p = point(event);
      if (selectionState.dragging.type === 'stroke') { selectionState.dragging.points.push([p.x, p.y]); }
      else if (selectionState.dragging.type === 'polygon') {
        var last = selectionState.dragging.points[selectionState.dragging.points.length - 1];
        if (!last || Math.hypot(p.x - last[0], p.y - last[1]) >= 2) selectionState.dragging.points.push([p.x, p.y]);
      } else { selectionState.dragging.x2 = p.x; selectionState.dragging.y2 = p.y; }
      drawSelection();
    }
    function end(event) {
      if (!selectionState.dragging) return;
      void event;
      var shape = selectionState.dragging;
      selectionState.dragging = null;
      var tooSmall = shape.type === 'stroke' ? (shape.points || []).length < 2
        : shape.type === 'polygon' ? (shape.points || []).length < 3 || (function () { var box = shapeBox(shape); return box.x2 - box.x1 < 4 || box.y2 - box.y1 < 4; })()
        : (Math.abs(shape.x2 - shape.x1) < 4 || Math.abs(shape.y2 - shape.y1) < 4);
      if (tooSmall) {
        selectionState.shapes.pop();
        drawSelection();
        if (selectionHelp()) selectionHelp().textContent = '选区太小，已忽略；请按住拖动框出要处理的区域';
        return;
      }
      if (selectionHelp()) selectionHelp().textContent = '已框选 ' + selectionState.shapes.length + ' 处，点“应用选区”提交处理';
    }
    canvas.addEventListener('click', function (event) {
      if (current !== 'polygon' || !selectionState.image) return;
      event.preventDefault(); var p = point(event); var draft = selectionState.polygonDraft || [];
      if (draft.length >= 3) { var first = draft[0]; if (Math.hypot(p.x - first[0], p.y - first[1]) <= 10) { finishPolygon(); return; } }
      draft.push([p.x, p.y]); selectionState.polygonDraft = draft; selectionState.redo.length = 0; drawSelection();
      if (selectionHelp()) selectionHelp().textContent = draft.length < 3 ? '已添加 ' + draft.length + ' 个点；多边形至少需要3个点' : '已添加 ' + draft.length + ' 个点；双击或点击起点附近完成闭合';
    });
    canvas.addEventListener('dblclick', function (event) { if (current === 'polygon') { event.preventDefault(); finishPolygon(); } });
    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    window.addEventListener('mouseup', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    var clear = $('skuSelectionClear');
    if (clear) clear.addEventListener('click', function () { selectionState.shapes = []; selectionState.redo = []; selectionState.polygonDraft = null; drawSelection(); if (selectionHelp()) selectionHelp().textContent = '已清空选区'; });
    var undoTool = $('skuSelectionUndo');
    if (undoTool) undoTool.addEventListener('click', function () {
      if (!selectionState.shapes.length) { status('没有可撤销的选区'); return; }
      selectionState.redo = selectionState.redo || [];
      selectionState.redo.push(selectionState.shapes.pop());
      drawSelection();
      if (selectionHelp()) selectionHelp().textContent = selectionState.shapes.length ? '已撤销一步选区，剩 ' + selectionState.shapes.length + ' 处，可点“重做选区”恢复' : '已撤销全部选区，可点“重做选区”恢复';
    });
    var redoTool = $('skuSelectionRedo');
    if (redoTool) redoTool.addEventListener('click', function () {
      if (!selectionState.redo || !selectionState.redo.length) { status('没有可重做的选区操作'); return; }
      selectionState.shapes.push(selectionState.redo.pop());
      drawSelection();
      if (selectionHelp()) selectionHelp().textContent = '已重做一步选区';
    });
    var close = $('skuSelectionClose'), cancel = $('skuSelectionCancel');
    [close, cancel].forEach(function (button) { if (button) button.addEventListener('click', function () { var dialog = $('skuImageSelectionDialog'); if (dialog && dialog.open) dialog.close(); }); });
    var expandSel = $('skuSelectionExpand');
    if (expandSel) expandSel.addEventListener('click', function () { var dialog = $('skuImageSelectionDialog'); if (dialog) dialog.classList.toggle('wy-full'); });
    var apply = $('skuSelectionApply');
    if (apply) apply.addEventListener('click', function () { applySelection(); });
  }

  function openSelection(mode, position) {
    var dialog = $('skuImageSelectionDialog'), image = selectionImageEl();
    if (!dialog || !image) { status('页面里没有“图片选区”对话框，无法框选处理'); return; }
    var item = linkItems[position];
    if (!item) { status('请先勾选一张要处理的图片'); return; }
    selectionState = { mode: mode, image: item, shapes: [], redo: [], tool: 'rect', stroke: null, dragging: null, natural: { width: 0, height: 0 }, display: { width: 0, height: 0 }, itemKey: ensureLocalImageKey(item) };
    bindSelectionDrawing();
    function measure() {
      if (!image.naturalWidth || !image.naturalHeight) {
        selectionState.natural = { width: 0, height: 0 };
        if (selectionHelp()) selectionHelp().textContent = '图片还在载入，请稍候再框选';
        return;
      }
      selectionState.natural = { width: image.naturalWidth, height: image.naturalHeight };
      var canvas = selectionCanvas();
      if (canvas) {
        var rect = image.getBoundingClientRect();
        if (!rect.width || !rect.height) rect = { width: image.clientWidth, height: image.clientHeight };
        canvas.width = Math.max(1, Math.round(rect.width));
        canvas.height = Math.max(1, Math.round(rect.height));
        canvas.style.width = canvas.width + 'px';
        canvas.style.height = canvas.height + 'px';
        drawSelection();
      }
      if (selectionHelp()) selectionHelp().textContent = (mode === 'crop' ? '拖动框出要保留的区域' : '拖动框出要修补（去水印）的区域') + '，原图尺寸 ' + image.naturalWidth + '×' + image.naturalHeight;
    }
    image.onload = measure;
    image.src = imageUrlOf(item);
    window.setTimeout(measure, 0);
    window.setTimeout(measure, 240);
    var title = $('skuImageSelectionTitle');
    if (title) title.textContent = mode === 'crop' ? '图片选区 · 裁剪' : '图片选区 · 去水印（修补）';
    if (!dialog.open) dialog.showModal();
  }
  async function applySelection() {
    if (!selectionState.natural.width || !selectionState.natural.height) { status('图片还没载入完成，请稍候再框选提交'); return; }
    var box = selectionBounds();
    if (!box || box.width < 2 || box.height < 2) { status('请先在图片上拖动框出足够大的区域（至少 2×2 像素）'); return; }
    var dialog = $('skuImageSelectionDialog');
    var target = targetOf(rowAt(openedIndex));
    if (!target) { status('请先选择上架店铺，再处理图片'); return; }
    var item = linkItems.filter(function (entry) { return ensureLocalImageKey(entry) === selectionState.itemKey; })[0];
    if (!item) { status('当前图片已经变化，请重新选择'); return; }
    if (dialog && dialog.open) dialog.close();
    var outputFormat = outputFormatFromDrawer();
    await run('正在处理选区…', async function () {
      pushHistory();
      if (selectionState.mode === 'crop') {
        var result = await processImageLocally([{ type: 'crop', x: box.x, y: box.y, width: box.width, height: box.height }], item, outputFormat);
        if (item.localBlobUrl) { try { URL.revokeObjectURL(item.localBlobUrl); } catch (ignored) { void ignored; } }
        item.localProcessed = true;
        item.localBlob = result.blob;
        item.localBlobUrl = URL.createObjectURL(result.blob);
        item.wmReplace = Boolean(item.id);
        render();
        status('裁剪完成：区域 ' + box.width + '×' + box.height + '，请点击“保存草稿”或“确定编辑”提交到服务器');
      } else {
        item.pendingProcess = { operations: [{ type: 'watermark', x: box.x, y: box.y, width: box.width, height: box.height, mask: buildMaskDataUrl(box) }], outputFormat: outputFormat };
        render();
        status('去水印修补已加入待保存操作；点商品页“保存草稿”或“确定编辑”后才写入服务器');
      }
    });
  }

  // ── 图片来源页签：两个“采集”页签都只读采集箱，不读取 Ozon/平台快照 ──
  // 采集SKU图片 → capture.skuImages / capture.variants[].imageUrl / primarySkuImage（按共用解析器分流）
  // 采集详情图片 → capture.media 中除视频、规格图、重复SKU图以外的其它采集图片
  // 非采集箱进入（无 collectionId / 找不到采集记录）时，两页签固定为空。
  var sourceTab = 'sku';
  var sourceRenderGeneration = 0;
  var sourcePreviewObserver = null;
  var aiHistoryCacheKey = '';
  var aiHistoryCacheItems = null;
  var collectionSourceRemote = { id: '', ready: false, sku: [], detail: [], promise: null };
  function collectionSourceId() {
    // 采集来源只属于“从采集箱进入的新增商品”流程；修改已有商品必须为空。
    if (!createModeFromUrl()) return '';
    var direct = String(params.get('collectionId') || '').trim();
    if (direct) return direct;
    var draftId = String(params.get('draftId') || '').trim();
    if (!draftId) return '';
    var drafts = recordsOf('erp_product_drafts');
    for (var i = 0; i < drafts.length; i += 1) {
      var draft = productDataOf(drafts[i]);
      if (draft && productIdOf(draft) === draftId && String(draft.collectionId || '').trim()) return String(draft.collectionId).trim();
    }
    return '';
  }
  function fetchCollectionSources(collectionId) {
    collectionId = String(collectionId || '').trim();
    if (!collectionId) return Promise.resolve(null);
    if (collectionSourceRemote.id === collectionId && collectionSourceRemote.ready) return Promise.resolve(collectionSourceRemote);
    if (collectionSourceRemote.id === collectionId && collectionSourceRemote.promise) return collectionSourceRemote.promise;
    collectionSourceRemote = { id: collectionId, ready: false, sku: [], detail: [], promise: null };
    var sourceUrl = '/api/domain/queries/sku-image-collection-sources?collectionId=' + encodeURIComponent(collectionId);
    var explicitTenant = String(params.get('tenantId') || '').trim();
    var selectedTenant = /^[0-9]+$/.test(explicitTenant) ? explicitTenant : (window.erpStorage && typeof window.erpStorage.getSelectedTenantId === 'function') ? String(window.erpStorage.getSelectedTenantId() || '') : '';
    if (selectedTenant) sourceUrl += '&tenantId=' + encodeURIComponent(selectedTenant);
    collectionSourceRemote.promise = api(sourceUrl).then(function (data) {
      if (collectionSourceRemote.id !== collectionId) return null;
      collectionSourceRemote.sku = Array.isArray(data && data.sku) ? data.sku : [];
      collectionSourceRemote.detail = Array.isArray(data && data.detail) ? data.detail : [];
      collectionSourceRemote.ready = true;
      collectionSourceRemote.promise = null;
      return collectionSourceRemote;
    }).catch(function (error) {
      if (collectionSourceRemote.id === collectionId) collectionSourceRemote.promise = null;
      throw error;
    });
    return collectionSourceRemote.promise;
  }
  function sourceImagesForCollection(group) {
    var collectionId = collectionSourceId();
    if (!collectionId || collectionSourceRemote.id !== collectionId || !collectionSourceRemote.ready) return [];
    var sourceGroup = group === 'detail' ? 'detail' : 'sku';
    var list = sourceGroup === 'detail' ? collectionSourceRemote.detail : collectionSourceRemote.sku;
    return (list || []).map(function (item, index) {
      return Object.assign({}, item, {
        pendingImportSource: { sourceType: 'collection', sourceId: collectionId, sourceGroup: sourceGroup, sourceIndex: index, sourceUrl: item.url }
      });
    });
  }
  function createModeFromUrl() { return params.get('mode') === 'create'; }
  function collectionIdFromUrl() { return collectionSourceId(); }
  function sourceTargetKey() {
    var target = targetOf(rowAt(openedIndex));
    return target ? [target.clientId, target.productId, target.variantRef].join('|') : '';
  }
  function sourceSelectionKey(url, source) {
    var sourceUrl = String(source && source.sourceUrl || url || '').trim();
    if (source && source.sourceType === 'collection') return ['collection', source.sourceId || '', source.sourceGroup || 'sku', source.sourceIndex == null ? '' : source.sourceIndex, sourceUrl].join('|');
    if (source && source.sourceType) return [source.sourceType, source.sourceId || '', sourceUrl].join('|');
    return sourceUrl ? 'url|' + sourceUrl : '';
  }
  function linkItemSourceKey(item) {
    var source = item && (item.pendingImportSource || item.pendingImport);
    return sourceSelectionKey(imageIdentity(item), source);
  }
  function sourceSelectionIndex(url, source) {
    var key = sourceSelectionKey(url, source), sourceUrl = String(source && source.sourceUrl || url || '').trim();
    return linkItems.findIndex(function (item) {
      var itemKey = linkItemSourceKey(item);
      if (key && itemKey && key === itemKey) return true;
      return Boolean(sourceUrl && imageIdentity(item) === sourceUrl);
    });
  }
  function sourcePreviewIntersectionObserver() {
    if (!('IntersectionObserver' in window)) return null;
    if (!sourcePreviewObserver) sourcePreviewObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        sourcePreviewObserver.unobserve(entry.target);
        var start = entry.target.__wySourcePreviewStart;
        entry.target.__wySourcePreviewStart = null;
        if (start) start();
      });
    }, { root: null, rootMargin: '280px 0px' });
    return sourcePreviewObserver;
  }
  function scheduleSourcePreview(image, index, start) {
    if (index < 6) { start(); return; }
    var observer = sourcePreviewIntersectionObserver();
    if (!observer) { start(); return; }
    image.__wySourcePreviewStart = start;
    observer.observe(image);
  }
  function sourceCardAfterLoad(list, sourceItem, index, generation) {
    var url = sourceItem && typeof sourceItem === 'object' ? sourceItem.url : sourceItem;
    if (!url) return;
    var tabAtStart = sourceTab;
    if (generation !== sourceRenderGeneration || sourceTab !== tabAtStart || !list.isConnected) return;
    var source = sourceItem && sourceItem.pendingImportSource;
    var selected = sourceSelectionIndex(url, source) >= 0;
    var card = document.createElement('article');
    card.className = 'sku-image-card' + (selected ? ' is-source-selected' : '');
    card.setAttribute('aria-pressed', selected ? 'true' : 'false');
    var preview = document.createElement('div');
    preview.className = 'sku-image-preview';
    preview.dataset.previewState = 'pending';
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', (tabAtStart === 'sku' ? '采集图片 ' : '详情图片 ') + (index + 1));
    var previewUrl = String(sourceItem && sourceItem.previewUrl || url);
    var sourceImage = document.createElement('img');
    sourceImage.alt = '';
    sourceImage.decoding = 'async';
    sourceImage.referrerPolicy = 'no-referrer';
    sourceImage.fetchPriority = index < 6 ? 'high' : 'low';
    sourceImage.className = 'sku-source-preview-image';
    preview.append(sourceImage);
    var number = document.createElement('span');
    number.className = 'sku-source-number';
    number.textContent = String(index + 1);
    preview.append(number);
    if (selected) {
      var selectedMark = document.createElement('span');
      selectedMark.className = 'sku-source-selected-mark';
      selectedMark.textContent = '已选';
      preview.append(selectedMark);
    }
    var foot = document.createElement('div');
    foot.className = 'sku-image-card-foot';
    var label = document.createElement('span');
    label.textContent = sourceItem && sourceItem.label ? String(sourceItem.label) : (tabAtStart === 'sku' ? '采集 ' : '详情 ') + (index + 1);
    var importButton = document.createElement('button');
    importButton.type = 'button';
    importButton.textContent = selected ? '撤回' : '加入';
    importButton.addEventListener('click', function (event) { event.stopPropagation(); importImage(url, index, source); });
    foot.append(label, importButton);
    card.append(preview, foot);
    card.addEventListener('click', function () { importImage(url, index, source); });
    list.append(card);
    scheduleSourcePreview(sourceImage, index, function () {
      queuePreviewLoad(function (release) {
        if (generation !== sourceRenderGeneration || sourceTab !== tabAtStart || !card.isConnected) { release(); return; }
        var settled = false, timeout = 0;
        function finish(kind) {
          if (settled) return;
          settled = true;
          if (timeout) window.clearTimeout(timeout);
          sourceImage.onload = sourceImage.onerror = null;
          if (generation === sourceRenderGeneration && sourceTab === tabAtStart && card.isConnected) {
            preview.dataset.previewState = kind === 'load' ? 'ready' : 'failed';
            if (kind !== 'load') {
              var failed = preview.querySelector('.sku-source-preview-error');
              if (!failed) { failed = document.createElement('span'); failed.className = 'sku-source-preview-error'; preview.append(failed); }
              failed.textContent = kind === 'timeout' ? '预览超时' : '预览失败';
              preview.title = '采集箱图片链接已保留，可尝试导入';
            }
          }
          release();
        }
        function attach(candidate, fallback) {
          if (settled) return;
          sourceImage.onload = function () { finish('load'); };
          sourceImage.onerror = function () {
            sourceImage.onload = sourceImage.onerror = null;
            if (!fallback && previewUrl !== url) { attach(url, true); return; }
            finish('error');
          };
          sourceImage.src = candidate;
          if (sourceImage.complete) window.setTimeout(function () { if (!settled && sourceImage.naturalWidth) finish('load'); }, 0);
        }
        timeout = window.setTimeout(function () { finish('timeout'); }, PREVIEW_LOAD_TIMEOUT_MS);
        attach(previewUrl, false);
      });
    });
  }
  function networkUrlsFrom(text) {
    var seen = {};
    return String(text || '').split(/\r?\n/).map(function (value) { return value.trim(); }).filter(function (value) {
      if (!value || seen[value]) return false;
      seen[value] = true;
      return true;
    });
  }
  function queueNetworkImages(textarea) {
    var urls = networkUrlsFrom(textarea && textarea.value);
    if (!urls.length) { status('请先粘贴至少一个 HTTPS 图片链接，一行一个'); return; }
    var invalidAt = -1;
    urls.some(function (url, index) {
      try { var parsed = new URL(url); if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || url.length > 2048) { invalidAt = index; return true; } }
      catch (error) { invalidAt = index; return true; }
      return false;
    });
    if (invalidAt >= 0) { status('第 ' + (invalidAt + 1) + ' 行不是完整的公网 HTTPS 图片链接，请修改后再导入'); return; }
    var existing = {};
    linkItems.forEach(function (item) { var key = imageIdentity(item); if (key) existing[key] = true; });
    urls = urls.filter(function (url) { return !existing[url]; });
    if (!urls.length) { status('这些网络图片已经在当前SKU图片列表中，无需重复添加'); return; }
    var remaining = Math.max(0, 30 - linkItems.length);
    if (remaining <= 0) { status('当前SKU图片已达到30张上限，本次链接已全部丢弃'); if (textarea) textarea.value = ''; return; }
    var discarded = Math.max(0, urls.length - remaining);
    urls = urls.slice(0, remaining);
    pushHistory();
    urls.forEach(function (url, index) {
      linkItems.push({
        url: url,
        pendingImport: { sourceType: 'network', sourceId: 'manual-link-' + (index + 1), sourceUrl: url }
      });
    });
    if (textarea) textarea.value = '';
    render();
    status('已加入 ' + urls.length + ' 张网络图片' + (discarded ? '，超出上限的 ' + discarded + ' 张已丢弃' : '') + '；点商品页“保存草稿”或“确定编辑”后才由服务器安全读取并转存');
  }
  function renderNetworkPanel(list) {
    list.classList.add('sku-network-source-list');
    var panel = document.createElement('div');
    panel.className = 'sku-network-panel';
    var textarea = document.createElement('textarea');
    textarea.id = 'skuNetworkImageUrls';
    textarea.setAttribute('aria-label', '网络图片链接');
    textarea.placeholder = '每行粘贴一个 HTTPS 图片链接\n例如：https://example.com/image.jpg';
    var button = document.createElement('button');
    button.className = 'btn';
    button.type = 'button';
    button.textContent = '导入链接';
    button.addEventListener('click', function () { queueNetworkImages(textarea); });
    panel.append(textarea, button);
    list.append(panel);
  }
  function aiHistorySignature(items) {
    return (items || []).map(function (item) { return [item.id, item.adopted ? 1 : 0, item.width || 0, item.height || 0, item.capability || '', item.taskId || ''].join(':'); }).join('|');
  }
  function renderAiCandidateItems(list, items) {
    list.replaceChildren();
    (items || []).forEach(function (item) { list.append(candidateRow(item)); });
  }
  function renderSourceList() {
    var list = document.getElementById('skuImageCollectionList');
    if (!list) return;
    var generation = ++sourceRenderGeneration;
    if (sourcePreviewObserver) sourcePreviewObserver.disconnect();

    list.classList.remove('sku-ai-candidate-list', 'sku-network-source-list');
    list.replaceChildren();
    var retry = $('skuImageRetry');
    if (retry) retry.hidden = true;
    if (sourceTab === 'web') {
      renderNetworkPanel(list);
      return;
    }
    if (sourceTab === 'ai') {
      renderAiHistory(list, generation);
      return;
    }
    var collectionTab = sourceTab === 'detail' || sourceTab === 'sku';
    if (collectionTab) {
      var collectionId = collectionSourceId();
      if (!collectionId) return;
      if (collectionSourceRemote.id !== collectionId || !collectionSourceRemote.ready) {
        var tabAtLoad = sourceTab;
        fetchCollectionSources(collectionId).then(function () {
          if (generation === sourceRenderGeneration && sourceTab === tabAtLoad) renderSourceList();
        }).catch(function (error) {
          if (generation !== sourceRenderGeneration || sourceTab !== tabAtLoad) return;
          list.textContent = '采集图片读取失败，请重试';
          status(error && error.message ? error.message : '采集图片读取失败，请重试');
        });
        return;
      }
    }
    var images = sourceImagesForCollection(sourceTab === 'detail' ? 'detail' : 'sku');
    if (!images.length) return;
    images.forEach(function (sourceItem, index) { sourceCardAfterLoad(list, sourceItem, index, generation); });
  }
  function importImage(url, index, onlineSource) {
    if (!/^https:\/\//i.test(String(url))) { status('服务端只允许导入 https 图片地址，这张不行'); return; }
    var source = onlineSource ? Object.assign({}, onlineSource)
      : sourceTab === 'sku'
        ? { sourceType: 'collection', sourceId: collectionIdFromUrl(), sourceGroup: 'sku', sourceIndex: index, sourceUrl: url }
        : sourceTab === 'detail'
          ? { sourceType: 'collection', sourceId: collectionIdFromUrl(), sourceGroup: 'detail', sourceIndex: index, sourceUrl: url }
          : null;
    if (!source) { status('当前商品平台图片快照不完整，不能确认导入来源；服务器关联保持不变'); return; }
    var existingIndex = sourceSelectionIndex(url, source);
    if (existingIndex >= 0) {
      if (isFixedRoleIndex(existingIndex)) { status('这张来源图当前位于固定槽位“' + fixedRoleAt(existingIndex) + '”，不能撤回导致其它图片前移；如需更换请直接替换该槽位'); return; }
      pushHistory();
      var existing = linkItems[existingIndex];
      if (existing && existing.id && removedIds.indexOf(existing.id) < 0) removedIds.push(existing.id);
      if (existing && existing.localBlobUrl) { try { URL.revokeObjectURL(existing.localBlobUrl); } catch (ignored) { void ignored; } }
      linkItems.splice(existingIndex, 1);
      render();
      renderSourceList();
      status('已从左侧撤回这张图片；同一张来源图不会重复');
      return;
    }
    if (linkItems.length >= 30) { status('这个SKU最多只能放30张图片'); return; }
    pushHistory();
    linkItems.push({ url: url, sourceUrl: url, pendingImportSource: Object.assign({}, source), pendingImport: Object.assign({}, source) });
    render();
    renderSourceList();
    status('已加入左侧第 ' + linkItems.length + ' 张；再次点击同一来源图可撤回');
  }
  function renderAiHistory(list, generation) {
    list.classList.add('sku-ai-candidate-list');
    var key = sourceTargetKey();
    var cached = key && aiHistoryCacheKey === key && Array.isArray(aiHistoryCacheItems) ? aiHistoryCacheItems : null;
    if (cached) renderAiCandidateItems(list, cached);
    fetchCandidates().then(function (items) {
      if (generation !== sourceRenderGeneration || sourceTab !== 'ai' || !list.isConnected) return;
      var nextSignature = aiHistorySignature(items);
      var currentSignature = cached ? aiHistorySignature(cached) : '';
      aiHistoryCacheKey = key;
      aiHistoryCacheItems = items;
      if (!cached || nextSignature !== currentSignature) renderAiCandidateItems(list, items);
    }).catch(function (error) {
      if (generation !== sourceRenderGeneration || sourceTab !== 'ai') return;
      if (!cached) status('AI生图记录读取失败，请稍后重试；若持续失败请检查当前租户权限或服务日志');
    });
  }
  function candidateSourcePosition(item) {
    if (item && item.linkId) {
      var linked = linkItems.findIndex(function (entry) { return entry.id === item.linkId; });
      if (linked >= 0) return linked;
    }
    if (item && item.sourceKind === 'platform_snapshot' && item.sourceRef) {
      return linkItems.findIndex(function (entry) { return platformSourceRef(entry) === item.sourceRef; });
    }
    return -1;
  }
  async function addCandidateToLeft(item, mode) {
    mode = mode === 'replace' ? 'replace' : 'append';
    if (mode === 'append' && linkItems.length >= 30) { status('这个SKU最多只能放30张图片'); return; }
    var url = imageUrlOf(item);
    if (!url) { status('这张AI图片没有可读取的地址，请重试加载记录'); return; }
    await run('正在读取AI图片…', async function () {
      var response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('AI图片读取失败，请重试或检查当前租户');
      var blob = await response.blob();
      if (!blob.type.startsWith('image/')) throw new Error('AI图片文件格式不正确');
      if (mode === 'append' && linkItems.length >= 30) throw new Error('这个SKU最多只能放30张图片');
      pushHistory();
      var localBlobUrl = URL.createObjectURL(blob);
      if (mode === 'replace') {
        var position = candidateSourcePosition(item);
        if (position < 0) { URL.revokeObjectURL(localBlobUrl); throw new Error('原图已变化，请重新打开图片编辑器'); }
        linkItems[position] = Object.assign({}, linkItems[position], { url: localBlobUrl, localBlobUrl: localBlobUrl, localBlob: blob, localProcessed: true, wmReplace: true, width: item.width, height: item.height });
      } else {
        linkItems.push({ url: localBlobUrl, localBlobUrl: localBlobUrl, localBlob: blob, localProcessed: true, width: item.width, height: item.height });
      }
      render();
      status('AI图片已在左侧' + (mode === 'replace' ? '替换原图' : '追加为新图') + '；点商品页“保存草稿”或“确定编辑”后才写入服务器');
    });
  }
  function candidateRow(item) {
    var card = document.createElement('article');
    card.className = 'sku-image-card sku-ai-candidate-card';
    if (item.taskId) { card.dataset.taskId = String(item.taskId); card.title = 'AI任务：' + String(item.taskId); }
    var preview = document.createElement('div');
    preview.className = 'sku-image-preview';
    setPreviewBackground(preview, item);
    preview.style.backgroundSize = 'contain';
    preview.style.backgroundRepeat = 'no-repeat';
    preview.style.backgroundPosition = 'center';
    preview.setAttribute('role', 'img');
    preview.setAttribute('aria-label', 'AI候选图');
    var size = document.createElement('span');
    size.className = 'sku-image-dimension';
    size.textContent = (item.width && item.height ? item.width + '×' + item.height : '候选') + (item.adopted ? ' · 已采用' : '');
    var icons = document.createElement('span');
    icons.className = 'sku-card-icons';
    icons.title = '放大图片';
    icons.setAttribute('aria-label', '放大图片');
    icons.textContent = '⌕';
    icons.addEventListener('click', function (event) {
      event.stopPropagation();
      wyLightbox(imageUrlOf(item), 'AI候选图');
    });
    card.addEventListener('click', function () { addCandidateToLeft(item); });
    preview.append(size, icons);
    var foot = document.createElement('div');
    foot.className = 'sku-image-card-foot';
    var label = document.createElement('span');
    var directionLabel = item.sourceLanguage === 'zh' && item.targetLanguage === 'ru' ? '中文→俄文' : item.sourceLanguage === 'en' && item.targetLanguage === 'ru' ? '英文→俄文' : '';
    label.textContent = item.capability === 'image-translation'
      ? '翻译候选' + (directionLabel ? ' · ' + directionLabel : '')
      : item.capability === 'image-repair' ? '修复候选' : '重绘候选' + (item.templateKey ? ' · ' + templateLabel(item.templateKey) : '');
    foot.append(label);
    if (!item.adopted) {
      var canReplaceSource = Boolean(item.linkId && Number.isInteger(Number(item.associationVersion)) && Number(item.associationVersion) >= 1) || item.sourceKind === 'platform_snapshot' && /^online:\d+:\d+$/.test(String(item.sourceRef || ''));
      if (!canReplaceSource) {
        var legacy = document.createElement('span');
        legacy.textContent = '候选缺少可定位的原图来源，请重新生成后采用';
        foot.append(legacy);
      } else ['replace', 'append'].forEach(function (mode) {
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = mode === 'replace' ? '替换原图' : '采用为新图';
        button.addEventListener('click', function (event) {
          event.stopPropagation();
          addCandidateToLeft(item, mode);
        });
        foot.append(button);
      });
    } else {
      var done = document.createElement('span');
      done.textContent = '已采用';
      foot.append(done);
    }
    card.append(preview, foot);
    return card;
  }
  function bindSourceTabs() {
    document.querySelectorAll('[data-static-tab]').forEach(function (button) {
      button.addEventListener('click', function () {
        sourceTab = button.getAttribute('data-static-tab') === 'detail' ? 'detail' : button.getAttribute('data-static-tab') === 'web' ? 'web' : button.getAttribute('data-static-tab') === 'ai' ? 'ai' : 'sku';
        document.querySelectorAll('[data-static-tab]').forEach(function (other) {
          var on = other === button;
          other.classList.toggle('on', on);
          other.setAttribute('aria-selected', String(on));
        });
        renderSourceList();
      });
    });
    var retry = $('skuImageRetry');
    if (retry) retry.addEventListener('click', function () { renderSourceList(); status('已重新读取图片来源'); });
  }


  // ── AI 生图（官方/自己的密钥通道，统一服务端持久任务；浏览器不轮询供应商） ──
  // 提交：POST /api/domain/commands/sku-image-ai → 202 {state,taskId}；后续只读任务中心/AI生图记录
  // 采用：POST /api/domain/commands/sku-image-ai-adopt {candidateId,linkId,associationVersion,mode:'replace'|'append'}
  // 历史候选：GET sku-image-candidates（图片来源面板的“AI 记录”页读取）。
  var imageConfigIds = {};
  var AI_CAPABILITIES = { 'AI重绘': 'image-redraw', '批量AI重绘': 'image-redraw', '图片翻译': 'image-translation', '多语言翻译': 'image-translation', '象寄批量翻译': 'image-translation', 'AI修复': 'image-repair', '去水印': 'image-repair' };

  async function resolveImageConfigId(capability) {
    var required = String(capability || aiRunState.capability || '');
    if (imageConfigIds[required]) return imageConfigIds[required];
    var data = await api('/api/integrations/ai/configurations');
    var rows = (data && Array.isArray(data.configurations) ? data.configurations : (data && Array.isArray(data.rows) ? data.rows : []));
    var hit = rows.filter(function (row) { return row && row.section === 'image' && row.enabled && (!required || Array.isArray(row.capabilities) && row.capabilities.indexOf(required) >= 0); })[0];
    if (!hit) throw new Error('还没启用支持当前图片能力的AI配置，请到 AI 配置页保存密钥并选择对应图片模型');
    imageConfigIds[required] = String(hit.id);
    return imageConfigIds[required];
  }

  // 卖点解析只在用户明确点击后调用；官方配置和权限由服务端按任务能力选择。
  async function requestSellPointSummary(pageText, target, attemptId, evidence) {
    var response;
    try {
      response = await rawApi('/api/domain/commands/product-ai-candidate', {
        method: 'POST',
        body: JSON.stringify({ intent: 'sku_redraw_selling_points', attemptId: attemptId, compatibilityEvidence: evidence && evidence.compatibilityEvidence, identityFacts: evidence && evidence.identityFacts, packageDimensionsMm: evidence && evidence.packageDimensionsMm, packageDimensionSources: evidence && evidence.packageDimensionSources, mode: 'optimize-ru', target: target, fields: { sellingPoints: pageText.slice(0, 5000) } })
      });
    } catch (error) {
      error.sellPointAttemptRecovery = true; // 仅传输未确认时转为只读查询，绝不重发 POST。
      throw error;
    }
    var data = response.data || {};
    if (data.state === 'processing' || (response.status === 409 && data.error === 'sku_redraw_analysis_processing')) return { state: 'processing' };
    if (response.status < 200 || response.status >= 300) { var failure = new Error(errorMessage(data, response.status)); failure.diagnosticId = data.diagnosticId; throw failure; }
    var text = String(data && data.candidate && data.candidate.sellingPoints != null ? data.candidate.sellingPoints : '');
    if (!text) throw new Error('AI 没有返回可用的卖点内容');
    if (!completeSellPointPair(data.sellingPointsBilingual)) { var invalid = new Error('AI未返回完整中俄双语卖点，已保留当前内容，请重新提炼。'); invalid.diagnosticId = data.diagnosticId; throw invalid; }
    if (!data.analysisProof || !data.expiresAt || !data.sourceHash) throw new Error('AI 返回的卖点验证信息不完整，请重新点击“解析卖点”');
    var expiresAt = Date.parse(String(data.expiresAt));
    if (!Number.isFinite(expiresAt)) throw new Error('AI 返回的卖点验证有效期无效，请重新点击“解析卖点”');
    return { text: text, analysisProof: String(data.analysisProof), expiresAt: expiresAt, sourceHash: String(data.sourceHash), pair: data.sellingPointsBilingual, reviewData:data, diagnosticId: data.diagnosticId };
  }
  function completeSellPointPair(pair) { return Boolean(pair && typeof pair.zh === 'string' && pair.zh.trim() && typeof pair.ru === 'string' && pair.ru.trim()); }
  var SELL_POINT_FORMAT_ERROR = '无卖点或者卖点格式有误；如果不会写卖点，可以使用“解析卖点”。';
  function validateSellingPointFormat(value) {
    var lines = String(value || '').split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
    var count = 0, hasChineseOrRussian = false;
    for (var i = 0; i < lines.length; i += 1) {
      if (/^(?:中文|俄语|俄文)\s*[:：]\s*$/.test(lines[i])) continue;
      var match = /^(?:[1-9]\d?)[.、)）．]\s*(.+)$/.exec(lines[i]);
      if (!match || !String(match[1] || '').trim()) return { ok: false, count: count };
      if (/[\u4e00-\u9fff\u0400-\u04ff]/.test(match[1])) hasChineseOrRussian = true;
      count += 1;
    }
    return { ok: count >= 2 && hasChineseOrRussian, count: count };
  }
  var SELL_POINT_ATTEMPT_MAX_POLLS = 6;
  var SELL_POINT_ATTEMPT_POLL_MS = 5000;
  var sellPointAttemptTimer = null;
  var sellPointAttemptToken = 0;
  function sellPointAttemptScope(target) {
    return [target.clientId, target.productId, target.variantRef].join('|');
  }
  function sellPointAttemptRequest(target, attemptId) {
    return { method: 'POST', body: JSON.stringify({ clientId: target.clientId, productId: target.productId, variantRef: target.variantRef, attemptId: attemptId || '' }) };
  }
  function stopSellPointAttemptRecovery() {
    sellPointAttemptToken++;
    if (sellPointAttemptTimer) clearTimeout(sellPointAttemptTimer);
    sellPointAttemptTimer = null;
  }
  function isCurrentSellPointAttempt(target, token) {
    return token === sellPointAttemptToken && aiRunState.shell && aiRunState.shell.dialog && aiRunState.shell.dialog.open && redrawProofScope() === sellPointAttemptScope(target);
  }
  function sellPointAttemptResult(data) {
    var result = data && data.result || {};
    var text = String(result.sellingPoints != null ? result.sellingPoints : '');
    if (!text || !result.analysisProof || !result.expiresAt) throw new Error('服务器恢复的卖点验证信息不完整，不能用于开始生图');
    var legacy = data.legacy === true || result.legacy === true;
    if (!completeSellPointPair(result.sellingPointsBilingual) && !legacy) { var invalid = new Error('恢复记录未包含完整中俄双语卖点，已保留当前内容，请重新提炼。'); invalid.diagnosticId = data.diagnosticId; throw invalid; }
    var expiresAt = Date.parse(String(result.expiresAt));
    if (!Number.isFinite(expiresAt)) throw new Error('服务器恢复的卖点验证有效期无效，不能用于开始生图');
    return { text: text, analysisProof: String(result.analysisProof), expiresAt: expiresAt, sourceHash: '', pair: result.sellingPointsBilingual, reviewData:result, legacy: legacy, diagnosticId: data.diagnosticId };
  }
  function restoreSellPointSummary(result, target, sellArea, guard) {
    if (!guard || !guard() || redrawProofScope() !== sellPointAttemptScope(target)) return false;
    sellArea.value = result.text;
    aiRunState.sellingPoints = result.text;
    aiRunState.sellingPointsBilingual = completeSellPointPair(result.pair) ? {zh: result.pair.zh, ru: result.pair.ru} : null;
    aiRunState.analysisProof = result.analysisProof;
    aiRunState.proofExpiresAt = result.expiresAt;
    aiRunState.proofSourceHash = result.sourceHash || '';
    aiRunState.proofScope = sellPointAttemptScope(target);
    aiRunState.sellingPointsSource = 'ai';
    if (aiRunState.contentReview) aiRunState.contentReview.adopt('sellingPoints', result.reviewData);
    writeSellPointCache();
    syncRedrawStartReady();
    var format = validateSellingPointFormat(result.text);
    aiDialogStatus(format.ok
      ? 'AI 已解析卖点并填入，当前格式正确，共 ' + format.count + ' 条；可以继续手动编辑或开始生图'
      : SELL_POINT_FORMAT_ERROR);
    showSellPointDiagnostic(result.diagnosticId);
    return true;
  }
  function recoverSellPointAttempt(target, sellArea, options) {
    options = options || {};
    stopSellPointAttemptRecovery();
    var token = sellPointAttemptToken;
    var guard = options.guard || function () { return false; };
    var polls = 0, diagnosticId = '';
    function report(state) { if (typeof options.onState === 'function') options.onState(state); }
    function finish(message, state) {
      if (!isCurrentSellPointAttempt(target, token) || !guard()) return;
      sellPointAttemptTimer = null;
      aiDialogStatus(message);
      showSellPointDiagnostic(diagnosticId);
      report(state);
    }
    function schedule() {
      if (!isCurrentSellPointAttempt(target, token) || !guard()) return;
      if (polls >= SELL_POINT_ATTEMPT_MAX_POLLS) { finish('卖点解析仍在处理中，已停止自动查询；结果未确认，禁止自动重试', 'processing'); return; }
      sellPointAttemptTimer = setTimeout(queryAttempt, SELL_POINT_ATTEMPT_POLL_MS);
    }
    function queryAttempt() {
      if (!isCurrentSellPointAttempt(target, token) || !guard()) return;
      polls++;
      rawApi('/api/domain/commands/sku-redraw-selling-points-attempt', sellPointAttemptRequest(target, options.attemptId)).then(function (response) {
        if (!isCurrentSellPointAttempt(target, token) || !guard()) return;
        var data = response.data || {};
        diagnosticId = data.diagnosticId || diagnosticId;
        showSellPointDiagnostic(diagnosticId);
        var state = String(data.state || 'unknown');
        if (response.status < 200 || response.status >= 300) { schedule(); return; }
        if (state === 'succeeded') {
          try {
            if (restoreSellPointSummary(sellPointAttemptResult(data), target, sellArea, guard)) { sellPointAttemptTimer = null; report('succeeded'); }
          } catch (error) { finish(String(error && error.message || '服务器恢复结果无效，不能用于开始生图'), 'recovery_required'); }
          return;
        }
        if (state === 'processing') { aiDialogStatus('卖点解析仍在处理中，正在只读查询服务器状态…'); report('processing'); schedule(); return; }
        if (state === 'none') { finish('未找到可恢复的卖点解析记录，禁止自动重试；请点击“解析卖点”后再试', 'none'); return; }
        if (state === 'failed') { finish('卖点解析失败：' + String(data.message || data.reason || '服务器未返回可用结果') + '；未自动重试', 'failed'); return; }
        if (state === 'recovery_required') { finish('卖点解析结果不确定，禁止自动重试；请等待后手动处理', 'recovery_required'); return; }
        finish('卖点解析结果不确定，禁止自动重试；请等待后手动处理', 'unknown');
      }).catch(function () {
        if (!isCurrentSellPointAttempt(target, token) || !guard()) return;
        schedule();
      });
    }
    aiDialogStatus(options.opening ? '正在读取当前商品已解析的卖点…' : '解析响应未确认，正在只读查询服务器状态，不会重复提交…');
    report('checking');
    queryAttempt();
  }

  var TRANSLATION_DIRECTIONS = [['zh','ru','中文 → 俄文'], ['en','ru','英文 → 俄文']];
  // AI重绘模板：与「AI 配置 → 图片提示词」的6类图片模板一一对应（GET /api/integrations/ai/prompts）
  var IMAGE_TEMPLATE_DEFS = [
    { key: 'image-main', label: '主图', hint: '商品第一张主图：主体突出、背景干净' },
    { key: 'image-scene', label: '场景图', hint: '商品放进使用场景' },
    { key: 'image-selling', label: '卖点图', hint: '突出商品卖点和使用效果的展示图' },
    { key: 'image-accessory', label: '配件赠品图', hint: '配件、赠品的集合展示图' },
    { key: 'image-white-base', label: '白底图', hint: '保留商品主体，替换为纯白背景' },
    { key: 'image-size', label: '尺寸图', hint: '带尺寸标注的说明图' }
  ];
  var TEMPLATE_PLACEHOLDER = '待系统管理员或租户填写。';
  // ── AI 生图 / 图片翻译弹窗：统一外壳，配置 → 批量进度 → 结果预览 → 确认写入 ──
  var AI_DIALOG_ID = 'skuImageAiDialog';
  var AI_BEAN_COST_PER_IMAGE = 10; // 官方通道单价（后端 AI豆开通前仅占位展示）
  // 生图原价、折扣价和实际扣费均由 /api/domain/ai-beans/balance 返回，前端不再写死活动价格。
  var CNY_TO_BEAN_RATE = 100; // 1元=100 AI豆
  var aiRunState = {
    shell: null,
    capability: 'image-redraw',
    direction: '',
    channel: 'official', // official=官方通道（AI豆扣费，默认）；own=自己的密钥（免费）
    busy: false,
    tasks: [],
    single: false, // true=从单张图片卡片菜单进入，只处理这一张、模板单选
    baseIndexes: [], // 本次参与处理的图片下标（模板展开前）
    templateOptions: [], // [{key,label,hint,body,configured}]
    templatesLoading: true,
    templatesError: '',
    selectedTemplates: [], // 选中的模板 functionKey
    templateCounts: {}, // functionKey -> 每张勾选图片出几张候选（1-9）
    beanWallet: null, // {loading,balanceBean,frozenBean,imageCostBean,imagePricing,officialChannelAvailable,error}
    balanceLine: null,
    feeLine: null,
    objCountLine: null, // 批量重绘“本次共选中 X 张图片”行引用
    objStateLine: null, // 批量重绘模板/候选数说明行引用
    startBtn: null, // 底部开始按钮引用
    channelUserTouched: false, // 用户本次是否手动切换过通道（手动选择优先于服务器偏好）
    sellingPoints: '', // 卖点文本框当前内容（提交时以它为准附加到每个模板提示词末尾）
    sellingPointsSource: '',
    imageTextLanguage: 'ru', // 图片实际文案语言：默认俄语；中文仅在用户明确切换时使用
    initialSellingPoints: '',
    analysisProof: '',
    proofExpiresAt: 0,
    proofSourceHash: '',
    proofScope: '',
    redrawSnapshot: null,
    queuedTaskIds: [],
    statusLine: null,
    ownConfigAvailable: false // 当前用户是否有可用的自己密钥图片配置
  };
  var PREVIEW_PER_PAGE = 4;
  var previewPage = 0;
  var selectedPreviewIndexes = new Set([0]);
  var previewMaxSelect = 1;
  var previewCardRefs = {}; // globalIdx -> { setSelected }，仅当前页已渲染卡片
  // ── sku32：模板数量口径（调度规则1/4/6）──
  // 每个模板卡片下方的数量 = 该模板每张勾选图片出几张候选；主图固定1张，其余模板范围1-9。
  function templateCountOf(key) {
    if (key === 'image-main') return 1;
    var n = parseInt(aiRunState.templateCounts[key], 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return n > 9 ? 9 : n;
  }
  // 计价因子 = Σ(各选中模板的数量)；未选中模板的数量不计入；一个都没选时按1口径展示（禁止显示0，沿用sku31）
  function selectedTemplateFactor() {
    var keys = aiRunState.selectedTemplates;
    if (!keys.length) return 1;
    return keys.reduce(function (sum, key) { return sum + templateCountOf(key); }, 0);
  }
  // 数量框改动后的局部同步：任务 / 处理对象说明 / 费用行 / 开始按钮同源刷新，不重建模板卡DOM
  function syncTemplateCountEffects() {
    buildAiTasks();
    refreshAiObjectSummary();
    refreshFeeLine();
    refreshAiStartBtn();
  }
  // 解析输入仅来自当前页面已有事实；全空时不请求、更不编造。
  // 汇总当前商品页已有文本：简介最前，随后标题、类目、品牌、属性、主题标签；取不到的不编造。
  function pageFieldValue(id) {
    var el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  }
  function pageProductFacts() {
    var facts = { description: pageFieldValue('description'), title: pageFieldValue('title'), brand: pageFieldValue('brand'), hashtags: pageFieldValue('hashtags'), category: '', attributes: [] };
    var cat = document.getElementById('category');
    if (cat && cat.selectedIndex >= 0 && cat.options[cat.selectedIndex]) {
      var catText = String(cat.options[cat.selectedIndex].text || '').trim();
      if (catText && !/载入|加载|请选择/.test(catText)) facts.category = catText;
    }
    document.querySelectorAll('[data-attribute-index]').forEach(function (input) {
      var value = String(input.value || '').trim();
      if (!value) return;
      var labelEl = input.closest('label') ? input.closest('label').querySelector('span') : null;
      facts.attributes.push({ name: (labelEl && String(labelEl.textContent || '').trim()) || input.getAttribute('aria-label') || '属性', value: value });
    });
    return facts;
  }
  function snapshotCopy(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value && typeof value === 'object' ? Object.assign({}, value) : value; }
  }
  // 重绘面板只使用打开时已加载的商品和全部 sku-image-links 关联，解析时不重新搜索或猜测商品。
  function freezeRedrawSnapshot() {
    var row = rowAt(openedIndex);
    var shop = $('shop');
    var shopLabel = shop && shop.selectedIndex >= 0 && shop.options[shop.selectedIndex]
      ? String(shop.options[shop.selectedIndex].text || '').trim() : '';
    aiRunState.redrawSnapshot = {
      product: snapshotCopy(currentProductData(row) || {}),
      pageFacts: snapshotCopy(pageProductFacts()),
      contentEvidence: snapshotCopy(sellPointEvidence()),
      target: snapshotCopy(targetOf(row)),
      images: snapshotCopy(linkItems),
      shopLabel: shopLabel
    };
  }
  function clearRedrawSnapshot() { aiRunState.redrawSnapshot = null; }
  function sellPointCacheKey() {
    var target = aiRunState.redrawSnapshot && aiRunState.redrawSnapshot.target;
    var account = window.erpStorage && window.erpStorage.getCurrentUser ? window.erpStorage.getCurrentUser() : '';
    var user = account && typeof account === 'object' ? (account.userId || account.username || '') : account;
    var tenant = window.erpStorage && window.erpStorage.getSelectedTenantId ? window.erpStorage.getSelectedTenantId() : '';
    return target && user && tenant ? 'wyerp.sku-redraw-selling-points:' + [tenant, user, target.clientId, target.productId, target.variantRef, aiRunState.single ? 'single' : 'batch'].map(encodeURIComponent).join(':') : '';
  }
  function showSellPointDiagnostic(id) {
    if (id && aiRunState.statusLine && window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS) window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS.attach(aiRunState.statusLine, id, async function (url) {
      var response = await rawApi(url);
      if (response.status < 200 || response.status >= 300) { var error = new Error('处理记录读取失败，请检查网络后重试。'); error.serverMessage = response.data && response.data.message; throw error; }
      return response.data;
    });
  }
  function createSellPointReview(shell, cached, seed) {
    if (!window.WYERP_PRODUCT_CONTENT_REVIEW) return null;
    var review = window.WYERP_PRODUCT_CONTENT_REVIEW.create({
      context:sellPointCacheKey, clientId:function () { return targetOf(rowAt(openedIndex)).clientId; },
      alive:function () { return aiRunState.shell === shell && shell.dialog.open; },
      pair:function () { return aiRunState.sellingPointsBilingual || {ru:aiRunState.sellingPoints}; },
      facts:function (field, source) {
        var facts = JSON.parse(source && source.facts || '{}'), evidence = sellPointEvidence() || {}, identity = evidence.identityFacts || {};
        ['brand','model','size'].forEach(function (key) { delete facts[key]; if (identity[key]) facts[key] = identity[key]; });
        facts.适配来源 = evidence.compatibilityEvidence || {title:'',attributes:{}};
        delete facts.包装尺寸毫米; delete facts.packageDimensionSources;
        if (evidence.packageDimensionsMm) facts.包装尺寸毫米 = evidence.packageDimensionsMm;
        if (evidence.packageDimensionSources) facts.packageDimensionSources = evidence.packageDimensionSources;
        return JSON.stringify(facts);
      },
      request:async function (url, options) { var response = await rawApi(url, options); if (response.status < 200 || response.status >= 300) { var error = new Error('重新核对失败，请稍后重试。'); error.serverMessage = response.data && response.data.message; throw error; } return response.data; },
      onChange:function () { if (aiRunState.shell === shell && aiRunState.contentReview === review) writeSellPointCache(); }
    });
    if (cached) review.restore(cached.contentRiskChecks, cached.browserContentReview);
    else if (seed && seed.reviewData) review.adopt('sellingPoints', seed.reviewData);
    return review;
  }
  function editedSellPointPair(text) {
    var match = /^中文：\n([\s\S]+)\n\n俄(?:语|文)：\n([\s\S]+)$/.exec(text);
    return match && match[1].trim() && match[2].trim() ? {zh:match[1].trim(),ru:match[2].trim()} : null;
  }
  function sellPointEvidence() { var bridge = window.WYERP_PRODUCT_SELLING_POINTS; return bridge && bridge.getEvidence ? bridge.getEvidence(targetOf(rowAt(openedIndex))) : null; }
  function sellPointSourceIdentity() {
    return JSON.stringify({ evidence: sellPointEvidence(), target: targetOf(rowAt(openedIndex)), indexes: Array.from(selectedPreviewIndexes), sources: aiRunState.baseIndexes.map(function (index) { return aiSourceTarget(linkItems[index], targetOf(rowAt(openedIndex))); }) });
  }
  function sellPointResponseGuard(sellArea) {
    var shell = aiRunState.shell, revision = aiRunState.sellingPointRevision, identity = sellPointSourceIdentity();
    return function () { return sellArea.isConnected && aiRunState.shell === shell && shell && shell.dialog.open && revision === aiRunState.sellingPointRevision && identity === sellPointSourceIdentity(); };
  }
  function readSellPointCache() { try { var key = sellPointCacheKey(), raw = localStorage.getItem(key); if (raw == null && key) raw = localStorage.getItem(key.replace(/:(single|batch)$/, '')); var value = raw && JSON.parse(raw); return value && typeof value.text === 'string' ? value : null; } catch (error) { return null; } }
  function writeSellPointCache() { try { var key = sellPointCacheKey(), text = aiRunState.sellingPoints; if (!key) return; localStorage.setItem(key, JSON.stringify({ text: text, sellingPointsBilingual: aiRunState.sellingPointsBilingual, source: aiRunState.sellingPointsSource, analysisProof: aiRunState.analysisProof, expiresAt: aiRunState.proofExpiresAt, contentRiskChecks:aiRunState.contentReview && aiRunState.contentReview.state(), browserContentReview:aiRunState.contentReview && aiRunState.contentReview.local() })); } catch (error) {} }
  function redrawProductName(snapshot) {
    var product = snapshot && snapshot.product || {};
    var facts = snapshot && snapshot.pageFacts || {};
    return String(product.name || product.title || product.productName || product.product_name || facts.title || '').trim();
  }
  function redrawSnapshotError() {
    var snapshot = aiRunState.redrawSnapshot;
    if (!snapshot) return '当前商品信息加载中，请稍候';
    if (!snapshot.target) return targetError(rowAt(openedIndex));
    if (!redrawProductName(snapshot)) return '当前商品基础信息加载失败：未读取到商品名称';
    if (!snapshot.images || !snapshot.images.length) return '当前商品没有可用于重绘的图片';
    var item = snapshot.images[aiRunState.baseIndexes[0]];
    if (!aiSourceTarget(item, snapshot.target)) return '当前图片来源信息不完整，请重新打开图片编辑';
    return '';
  }
  function readableBusinessValue(value, depth) {
    if (value == null) return '';
    if (typeof value === 'string') return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
    if (depth >= 2) return '';
    if (Array.isArray(value)) return value.map(function (item) { return readableBusinessValue(item, depth + 1); }).filter(Boolean).join('、');
    if (typeof value === 'object') return Object.keys(value).map(function (key) {
      if (/(id|uuid|version|status|created|updated|count|image|url|file|src|preview|audit)/i.test(key)) return '';
      var text = readableBusinessValue(value[key], depth + 1);
      return text ? key + '：' + text : '';
    }).filter(Boolean).join('；');
    return '';
  }
  function richContentText(value) {
    if (value == null) return '';
    if (typeof value === 'string') {
      var raw = value.trim();
      if (!raw) return '';
      try { return richContentText(JSON.parse(raw)); } catch (error) { return raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
    }
    if (Array.isArray(value)) return value.map(richContentText).filter(Boolean).join('\n');
    if (typeof value === 'object') return ['text', 'plainText', 'content', 'insert', 'children', 'blocks', 'ops'].map(function (key) {
      return Object.prototype.hasOwnProperty.call(value, key) ? richContentText(value[key]) : '';
    }).filter(Boolean).join('\n');
    return '';
  }
  function sellPointSourceText(snapshot) {
    var parts = [];
    var product = (snapshot && snapshot.product) || currentProductData(rowAt(openedIndex)) || {};
    var facts = (snapshot && snapshot.pageFacts) || pageProductFacts();
    function add(label, value) {
      var v = readableBusinessValue(value, 0);
      if (v && !parts.some(function (part) { return part === label + '：' + v; })) parts.push(label + '：' + v);
    }
    var target = snapshot && snapshot.target || targetOf(rowAt(openedIndex)) || {};
    // 文本框先显示完整冻结原始资料；点击解析后才由 AI 结果整体替换。
    add('商品名称', redrawProductName(snapshot) || product.name || product.title || facts.title);
    add('SKU/货号', target.variantRef);
    add('店铺', snapshot && snapshot.shopLabel || target.clientId);
    add('描述', richContentText(product.richContent) || product.description || product.descriptionText || product.description_text || product.intro || facts.description);
    add('类目', product.categoryPath || product.category || [product.cat1, product.cat2, product.cat3].filter(Boolean).join(' / ') || facts.category);
    add('品牌', product.brand || facts.brand);
    var seen = {}, evidenceAttributes = snapshot && snapshot.contentEvidence && snapshot.contentEvidence.compatibilityEvidence && snapshot.contentEvidence.compatibilityEvidence.attributes;
    (Array.isArray(product.attributes) ? product.attributes : []).forEach(function (attribute) {
      if (evidenceAttributes) return;
      var classifier = window.WYERP_PRODUCT_ATTRIBUTE_FIELDS, binding = classifier && classifier.classify(attribute || {});
      if (binding && (binding.area === 'dimensions' || binding.area === 'field' && ['length','width','height'].indexOf(binding.key) >= 0)) return;
      var name = String(attribute && (attribute.name || attribute.attributeName || attribute.title) || '属性').trim();
      var value = attribute && (attribute.value || attribute.values && attribute.values.join('、'));
      var dedupe = name + '=' + readableBusinessValue(value, 0);
      if (!value || seen[dedupe]) return;
      seen[dedupe] = true;
      add('属性·' + name, value);
    });
    (evidenceAttributes ? Object.keys(evidenceAttributes).map(function (name) { return {name: name, value: evidenceAttributes[name]}; }) : facts.attributes || []).forEach(function (attribute) {
      var v = readableBusinessValue(attribute && attribute.value, 0);
      if (!v) return;
      var name = String(attribute && attribute.name || '属性').trim();
      var dedupe = name + '=' + v;
      if (seen[dedupe]) return;
      seen[dedupe] = true;
      add('属性·' + name, v);
    });
    add('规格', product.specifications || product.specification || product.specs);
    add('现有卖点', product.sellingPoints || product.selling_points || product.highlights);
    add('主题标签', product.hashtags || product.tags || facts.hashtags);
    add('价格', product.price || product.salePrice || product.sale_price || product.priceRub || product.price_rub);
    return parts.join('\n');
  }
  function aiDialogStatus(text) {
    status(text);
    var box = aiRunState.statusLine;
    if (box && document.body.contains(box)) box.textContent = text;
  }
  function redrawSourceTarget(sourceIndex) {
    var indexes = Number.isInteger(sourceIndex) ? [sourceIndex] : aiRunState.single
      ? aiRunState.baseIndexes.slice()
      : aiRunState.baseIndexes.filter(function (index, at) { return selectedPreviewIndexes.has(at); });
    if (indexes.length !== 1) return { error: '解析卖点时请只选1张图片；批量生图可手工填写卖点后选择多张' };
    var snapshot = aiRunState.redrawSnapshot;
    var item = snapshot && snapshot.images ? snapshot.images[indexes[0]] : linkItems[indexes[0]];
    var target = snapshot && snapshot.target ? snapshot.target : targetOf(rowAt(openedIndex));
    if (!target) return { error: targetError(rowAt(openedIndex)) };
    var sourceTarget = aiSourceTarget(item, target);
    if (!sourceTarget) return { error: '当前图片来源信息不完整，无法用于AI；请重新打开图片编辑' };
    return { item: item, currentItem: linkItems[indexes[0]], target: sourceTarget };
  }
  function redrawProofScope() {
    var source = redrawSourceTarget();
    return source.error ? '' : sellPointAttemptScope(source.target);
  }
  function invalidateRedrawProof() {
    aiRunState.analysisProof = '';
    aiRunState.proofExpiresAt = 0;
    aiRunState.proofSourceHash = '';
    aiRunState.proofScope = '';
  }
  function validRedrawProof() {
    return Boolean(aiRunState.analysisProof) && Date.now() < aiRunState.proofExpiresAt && aiRunState.proofScope === redrawProofScope();
  }
  function sellPointReady() {
    return validateSellingPointFormat(aiRunState.sellingPoints).ok;
  }
  function sellingPointSubmissionSource() {
    return aiRunState.sellingPointsSource === 'ai' && validRedrawProof() ? 'ai' : 'manual';
  }
  function syncRedrawStartReady() {
    var btn = aiRunState.startBtn;
    if (!btn || !document.body.contains(btn) || aiRunState.capability !== 'image-redraw') return;
    btn.disabled = !sellPointReady();
    btn.title = btn.disabled ? SELL_POINT_FORMAT_ERROR : '';
  }
  document.addEventListener('input', function (event) {
    if (aiRunState.analysisProof && event.target && event.target.closest && event.target.closest('#shop, #variantBody [data-field]')) invalidateRedrawProof();
  });
  function renderPreviewGrid(shell) {
    var indexes = aiRunState.baseIndexes;
    if (!indexes || !indexes.length) return;
    var sec = wyEl('section', 'wy-section');
    var titleRow = wyEl('div', 'wy-preview-title-row');
    var title = wyEl('h3', 'wy-section-title');
    title.textContent = '预览图';
    var countWrap = wyEl('div', 'wy-preview-count');
    countWrap.textContent = '选择数量 ';
    var countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = '1';
    countInput.max = String(indexes.length);
    countInput.value = String(previewMaxSelect);
    countInput.addEventListener('change', function () {
      var val = parseInt(countInput.value, 10);
      if (!Number.isFinite(val) || val < 1) val = 1;
      if (val > indexes.length) val = indexes.length;
      countInput.value = String(val);
      previewMaxSelect = val;
      if (selectedPreviewIndexes.size > previewMaxSelect) {
        var arr = [...selectedPreviewIndexes];
        selectedPreviewIndexes = new Set(arr.slice(arr.length - previewMaxSelect));
      }
      renderAiConfigView();
    });
    countWrap.append(countInput);
    titleRow.append(title, countWrap);
    sec.append(titleRow);
    var totalPages = Math.max(1, Math.ceil(indexes.length / PREVIEW_PER_PAGE));
    if (previewPage >= totalPages) previewPage = totalPages - 1;
    if (previewPage < 0) previewPage = 0;
    var start = previewPage * PREVIEW_PER_PAGE;
    var pageIndexes = indexes.slice(start, start + PREVIEW_PER_PAGE);
    var grid = wyEl('div', 'wy-preview-grid');
    previewCardRefs = {};
    pageIndexes.forEach(function (position, i) {
      var globalIdx = start + i;
      var item = linkItems[position];
      var isSelected = selectedPreviewIndexes.has(globalIdx);
      var card = wyEl('div', 'wy-preview-card');
      var thumb = wyEl('div', 'wy-preview-thumb' + (isSelected ? ' selected' : ''));
      if (item) setPreviewBackground(thumb, item);
      var badge = wyEl('span', 'idx');
      badge.textContent = String(globalIdx + 1);
      thumb.append(badge);
      thumb.addEventListener('click', function () {
        if (item) wyLightbox(imageUrlOf(item), '预览图 ' + (globalIdx + 1));
      });
      var setSelected = function (flag) {
        isSelected = flag;
        cb.checked = flag;
        if (flag) thumb.classList.add('selected'); else thumb.classList.remove('selected');
      };
      var cbLabel = wyEl('div', 'wy-preview-check');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isSelected;
      previewCardRefs[globalIdx] = { setSelected: setSelected };
      cb.addEventListener('click', function () {
        // 浏览器在 click 事件派发前已完成原生勾选切换，且 preventDefault 会在处理器结束后
        // 回滚 checked（真实鼠标点击下手动赋值被抵消，2026-09-19 运行时证据）：
        // 因此不拦截默认行为，直接以处理器运行时的 cb.checked 作为目标状态。
        var wantSelect = cb.checked;
        if (wantSelect) {
          selectedPreviewIndexes.add(globalIdx);
          thumb.classList.add('selected');
          var dropped = [];
          while (selectedPreviewIndexes.size > previewMaxSelect) {
            var oldest = selectedPreviewIndexes.values().next().value;
            if (oldest === globalIdx) break;
            selectedPreviewIndexes.delete(oldest);
            var ref = previewCardRefs[oldest];
            if (ref) ref.setSelected(false);
            dropped.push(oldest + 1);
          }
          if (dropped.length) status('已达选择上限，自动取消最早选中的第 ' + dropped.join('、') + ' 张');
        } else {
          if (selectedPreviewIndexes.size <= 1) {
            cb.checked = true;
            status('至少要保留 1 张选中图片');
            return;
          }
          selectedPreviewIndexes.delete(globalIdx);
          thumb.classList.remove('selected');
        }
        syncPreviewSelectionEffects();
      });
      cbLabel.append(cb);
      cbLabel.append(document.createTextNode(' ' + (globalIdx + 1)));
      card.append(thumb, cbLabel);
      grid.append(card);
    });
    sec.append(grid);
    if (totalPages > 1) {
      var pager = wyEl('div', 'wy-preview-pager');
      var prevBtn = document.createElement('button');
      prevBtn.textContent = '上一页';
      prevBtn.disabled = previewPage <= 0;
      prevBtn.addEventListener('click', function () { if (previewPage > 0) { previewPage--; renderAiConfigView(); } });
      var info = wyEl('span', 'page-info');
      info.textContent = (previewPage + 1) + ' / ' + totalPages;
      var nextBtn = document.createElement('button');
      nextBtn.textContent = '下一页';
      nextBtn.disabled = previewPage >= totalPages - 1;
      nextBtn.addEventListener('click', function () { if (previewPage < totalPages - 1) { previewPage++; renderAiConfigView(); } });
      pager.append(prevBtn, info, nextBtn);
      sec.append(pager);
    }
    shell.body.append(sec);
  }
  // ── 预览勾选变化后局部同步：处理对象文案 / 费用行 / 开始按钮，不做全量重建 ──
  function buildRedrawStateText() {
    var tplCountNow = aiRunState.selectedTemplates.length;
    if (aiRunState.templatesLoading) return '正在读取「AI 配置」里的图片模板，请稍候…';
    if (aiRunState.templatesError) return '模板暂时读取失败，重试成功前不能开始生图。';
    if (aiRunState.single) {
      if (!tplCountNow) return '请在下面选择 1 个模板（单张只能单选）。';
      var singleQty = templateCountOf(aiRunState.selectedTemplates[0]);
      return '已选模板：' + templateLabel(aiRunState.selectedTemplates[0]) + ' ×' + singleQty + '，将生成 ' + singleQty + ' 张候选。';
    }
    var candidateCount = selectedPreviewIndexes.size * selectedTemplateFactor();
    return tplCountNow
      ? '已选 ' + tplCountNow + ' 个模板，将生成 ' + candidateCount + ' 张候选，逐张计费。'
      : '请在下面选择一个或多个模板。';
  }
  function refreshAiObjectSummary() {
    if (aiRunState.capability !== 'image-redraw') return;
    if (!aiRunState.single) {
      var countLine = aiRunState.objCountLine;
      if (countLine && document.body.contains(countLine) && countLine.children[1]) {
        countLine.children[1].textContent = String(selectedPreviewIndexes.size);
      }
    }
    var stateLine = aiRunState.objStateLine;
    if (stateLine && document.body.contains(stateLine) && stateLine.children[0]) {
      stateLine.children[0].textContent = buildRedrawStateText() + ' 在点“确认”之前，外面的原图不会有任何改动。';
    }
  }
  function refreshAiStartBtn() {
    var btn = aiRunState.startBtn;
    if (!btn || !document.body.contains(btn)) return;
    if (aiRunState.capability !== 'image-redraw') return;
    btn.textContent = aiRunState.tasks.length ? '开始生图（' + aiRunState.tasks.length + ' 张）' : '开始生图';
  }
  function syncPreviewSelectionEffects() {
    if (aiRunState.cancelSellingPointRequest) aiRunState.cancelSellingPointRequest();
    aiRunState.sellingPointRevision++;
    if (aiRunState.capability === 'image-redraw' && !aiRunState.single) buildAiTasks();
    refreshAiObjectSummary();
    refreshFeeLine();
    refreshAiStartBtn();
    syncRedrawStartReady();
  }
  // ── 费用通道偏好：服务器保存（/api/integrations/ai/ui-preferences），本地 localStorage 即时缓存 ──
  var AI_UI_PREF_CACHE_PREFIX = 'wyerp.ai-ui-pref.v1.';
  function aiUiPrefCacheKey() {
    var who = '';
    try { who = window.erpStorage && window.erpStorage.getCurrentUser ? String(window.erpStorage.getCurrentUser() || '') : ''; } catch (error) { who = ''; }
    return AI_UI_PREF_CACHE_PREFIX + who;
  }
  function readAiUiPrefCache() {
    try {
      var raw = localStorage.getItem(aiUiPrefCacheKey());
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return null;
      return obj;
    } catch (error) { return null; }
  }
  function writeAiUiPrefCache(obj) {
    try { localStorage.setItem(aiUiPrefCacheKey(), JSON.stringify(Object.assign({ ts: Date.now() }, obj))); } catch (error) {}
  }
  async function checkOwnImageConfig() {
    try { await resolveImageConfigId(aiRunState.capability); return true; } catch (error) { return false; }
  }
  function isAiConfigViewActive() {
    var shell = aiRunState.shell;
    return Boolean(shell && shell.el && document.body.contains(shell.el) && !aiRunState.busy && shell.body && shell.body.querySelector('.wy-pickgrid'));
  }
  // 弹窗打开后在后台与服务器核对；用户没手动动过通道时，以服务器值为准并回写本地缓存
  async function loadAiChannelPreference() {
    try {
      var pair = await Promise.all([api('/api/integrations/ai/ui-preferences'), checkOwnImageConfig()]);
      var data = pair[0];
      var ownAvailable = Boolean(pair[1]);
      aiRunState.ownConfigAvailable = ownAvailable;
      var channel = data && (data.billingChannel === 'own' || data.billingChannel === 'official') ? String(data.billingChannel) : 'official';
      writeAiUiPrefCache({ channel: channel, ownAvailable: ownAvailable });
      if (aiRunState.channelUserTouched) return;
      var effective = channel === 'own' && ownAvailable ? 'own' : 'official';
      if (effective !== aiRunState.channel) {
        aiRunState.channel = effective;
        // sku35（任务#38）：后台核对切换通道后，非配置视图（批量重绘弹窗）也必须立即刷新费用行，
        // 否则会残留旧通道文字（显示官方10豆、实际按自己密钥0豆计费），展示与计费口径不一致。
        if (isAiConfigViewActive()) renderAiConfigView();
        else refreshFeeLine();
      }
    } catch (error) {
      // 服务器慢或失败时继续沿用本地缓存/默认，不阻断使用；下次打开继续核对
    }
  }
  async function saveAiChannelPreference(channel) {
    writeAiUiPrefCache({ channel: channel, ownAvailable: aiRunState.ownConfigAvailable });
    try { await api('/api/integrations/ai/ui-preferences', { method: 'PUT', body: JSON.stringify({ billingChannel: channel }) }); }
    catch (error) { /* 本地缓存已记住，下次打开继续沿用并再次尝试同步到服务器 */ }
  }
  function freshBeanWallet() {
    return { loading: true, balanceBean: null, frozenBean: 0, imageCostBean: AI_BEAN_COST_PER_IMAGE, imagePricing: null, officialChannelAvailable: false, error: '' };
  }
  function beanCostYuan(amountBean) {
    var yuan = Math.round(Number(amountBean) * 100 / CNY_TO_BEAN_RATE) / 100;
    return String(yuan);
  }
  async function loadAiBeanBalance() {
    var wallet = freshBeanWallet();
    aiRunState.beanWallet = wallet;
    refreshBeanBalanceLine();
    try {
      var data = await api('/api/domain/ai-beans/balance');
      wallet.loading = false;
      wallet.balanceBean = Number.isFinite(Number(data.balanceBean)) ? Number(data.balanceBean) : null;
      wallet.frozenBean = Number.isFinite(Number(data.frozenBean)) ? Number(data.frozenBean) : 0;
      if (Number(data.imageCostBean) > 0) wallet.imageCostBean = Number(data.imageCostBean);
      if (data.imagePricing && typeof data.imagePricing === 'object') wallet.imagePricing = data.imagePricing;
      wallet.officialChannelAvailable = Boolean(data.officialChannelAvailable);
    } catch (error) {
      wallet.loading = false;
      wallet.error = error && error.message ? error.message : '余额读取失败';
    }
    refreshBeanBalanceLine();
    refreshFeeLine();
  }
  function pricePromoParts(wallet) {
    var pricing = wallet && wallet.imagePricing && typeof wallet.imagePricing === 'object' ? wallet.imagePricing : null;
    var original = pricing && Number(pricing.originalBean) > 0 ? Number(pricing.originalBean) : Number(wallet.imageCostBean);
    var discount = pricing && Number(pricing.discountBean) > 0 ? Number(pricing.discountBean) : 0;
    var effective = Number(wallet.imageCostBean) > 0 ? Number(wallet.imageCostBean) : original;
    if (discount > 0 && discount < original) {
      return [{ text: '原价 ' + original + ' AI豆/张', cls: 'price-original' },
        { text: ' 活动价 ' },
        { text: effective + ' AI豆/张（约 ' + beanCostYuan(effective) + '元/张）', cls: 'price-promo' }];
    }
    return [{ text: effective + ' AI豆/张（约 ' + beanCostYuan(effective) + '元/张）', cls: 'price-promo' }];
  }
  function officialPriceBadge(wallet) {
    var pricing = wallet && wallet.imagePricing && typeof wallet.imagePricing === 'object' ? wallet.imagePricing : null;
    var discounted = pricing && Number(pricing.discountBean) > 0 && Number(pricing.discountBean) < Number(pricing.originalBean);
    return (discounted ? '活动' : '') + wallet.imageCostBean + '豆/张';
  }
  function renderRichParts(line, parts) {
    line.replaceChildren();
    parts.forEach(function (part) {
      var child = document.createElement(part.href ? 'a' : (part.bold ? 'b' : 'span'));
      if (part.cls) child.className = part.cls;
      if (part.href) {
        child.href = part.href;
        if (/^\/pages\//.test(part.href)) child.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); openWorkspacePage(part.href, part.workspaceTitle || part.text || '功能页面'); });
      }
      child.textContent = part.text;
      line.append(child);
    });
  }
  function refreshBeanBalanceLine() {
    var line = aiRunState.balanceLine;
    if (!line || !document.body.contains(line)) return;
    var wallet = aiRunState.beanWallet || freshBeanWallet();
    var parts;
    if (wallet.loading) {
      parts = [{ text: aiRunState.capability === 'image-redraw' ? '我的 AI 豆余额：读取中…' : '我的 AI 豆余额：读取中…（使用自己的密钥免费，不受影响）' }];
    } else if (wallet.error || wallet.balanceBean === null) {
      parts = [{ text: aiRunState.capability === 'image-redraw' ? '我的 AI 豆余额：暂时读不到（官方通道开始前会再次校验余额；1元=100豆）' : '我的 AI 豆余额：暂时读不到（不影响使用自己的密钥免费处理；1元=100豆）' }];
    } else {
      parts = [{ text: '我的 AI 豆余额：' }, { text: wallet.balanceBean + ' AI豆', bold: true }];
      if (wallet.frozenBean > 0) parts.push({ text: '（其中 ' + wallet.frozenBean + ' 豆因处理中任务冻结）' });
      parts.push({ text: wallet.officialChannelAvailable ? '；官方通道已开通，图片处理 ' : '；官方通道暂未开通，图片处理 ' });
      parts = parts.concat(pricePromoParts(wallet));
      parts.push({ text: wallet.officialChannelAvailable ? '，开始处理后自动冻结并在出图成功后扣除' : '，开通后在此自动扣费' });
    }
    if (!wallet.loading && !wallet.error && wallet.balanceBean !== null) parts.push({ text: '查看AI豆管理', href: '/pages/ai-beans.html', workspaceTitle: 'AI豆管理', cls: 'ai-bean-manage-link' });
    renderRichParts(line, parts);
  }
  function refreshFeeLine() {
    var line = aiRunState.feeLine;
    if (!line || !document.body.contains(line)) return;
    var wallet = aiRunState.beanWallet || freshBeanWallet();
    // 每张目标按所选模板及其数量分别入队。
    var imageCount = (aiRunState.capability === 'image-redraw' && !aiRunState.single)
      ? selectedPreviewIndexes.size : aiRunState.baseIndexes.length;
    var tplFactor = aiRunState.capability === 'image-redraw' ? selectedTemplateFactor() : 1;
    var candidateCount = imageCount * tplFactor;
    var parts;
    if (aiRunState.channel === 'official') {
      var needBean = candidateCount * wallet.imageCostBean;
      parts = [{ text: '已选 ' }, { text: String(imageCount), bold: true },
        { text: ' 张图片；当前通道：官方通道，将生成 ' }, { text: String(candidateCount), bold: true },
        { text: ' 张候选，预计费用 ' }, { text: needBean + ' AI豆', bold: true },
        { text: '（约 ' + beanCostYuan(needBean) + ' 元），确认开始时冻结，出图成功后扣除；单价 ' }];
      parts = parts.concat(pricePromoParts(wallet));
    } else {
      parts = [{ text: '已选 ' }, { text: String(imageCount), bold: true },
        { text: ' 张图片；当前通道：自己的密钥，将生成 ' }, { text: String(candidateCount), bold: true },
        { text: ' 张候选，预计费用 ' }, { text: '0 AI豆', bold: true },
        { text: '（AI 普通文字翻译同样免费）' }];
    }
    renderRichParts(line, parts);
  }
  function aiDialogTitle(capability) {
    return capability === 'image-translation' ? '图片翻译'
      : capability === 'image-repair' ? 'AI修复' : 'AI重绘';
  }
  function templateLabel(key) {
    var def = IMAGE_TEMPLATE_DEFS.filter(function (item) { return item.key === key; })[0];
    return def ? def.label : key;
  }
  function buildAiTasks() {
    var capability = aiRunState.capability;
    var baseIndexes = aiRunState.baseIndexes;
    var ordinal = 0;
    var tasks = [];
    function baseTask(item, position, extra) {
      ordinal += 1;
      return Object.assign({
        id: ordinal,
        item: item,
        name: '图片 ' + (aiRunState.single ? 1 : (position + 1)),
        sourceIndex: position,
        status: 'pending',
        chosen: true,
        candidate: null,
        writeMode: 'replace',
        error: '',
        prompt: ''
      }, extra || {});
    }
    if (capability === 'image-redraw' && aiRunState.selectedTemplates.length) {
      // 每张勾选图片按所选模板及其数量分别入队。
      var tpls = aiRunState.templateOptions.filter(function (t) { return aiRunState.selectedTemplates.indexOf(t.key) >= 0; });
      var redrawIndexes = aiRunState.single
        ? baseIndexes
        : baseIndexes.filter(function (position, at) { return selectedPreviewIndexes.has(at); });
      redrawIndexes.forEach(function (position) {
        var item = linkItems[position];
        if (!item) return;
        tpls.forEach(function (tpl, templateAt) {
          var quantity = templateCountOf(tpl.key);
          for (var copyAt = 0; copyAt < quantity; copyAt += 1) {
            tasks.push(baseTask(item, position, {
              name: '图片 ' + (aiRunState.single ? 1 : (position + 1)) + ' · ' + tpl.label + (quantity > 1 ? ' ' + (copyAt + 1) : ''),
              chosen: false,
              templateKey: tpl.key,
              templateQuantity: quantity,
              templateIndex: templateAt + 1
            }));
          }
        });
      });
      // 每张原图默认只勾选首个结果供人工采用；所有模板任务仍分别入队。
      var seenSource = {};
      tasks.forEach(function (task) {
        var sourceKey = String(task.item.id || task.item.url || task.name);
        if (!seenSource[sourceKey]) { seenSource[sourceKey] = true; task.chosen = true; }
      });
    } else if (capability !== 'image-redraw') {
      // 翻译 / 修复：每张图片一条任务
      baseIndexes.forEach(function (position) {
        var item = linkItems[position];
        if (!item) return;
        tasks.push(baseTask(item, position, { prompt: '' }));
      });
    }
    aiRunState.tasks = tasks;
  }
  async function loadAiPromptTemplates() {
    if (aiRunState.capability !== 'image-redraw') { aiRunState.templatesLoading = false; return; }
    try {
      var data = await api('/api/integrations/ai/prompts');
      var officialRows = (data && Array.isArray(data.official)) ? data.official : [];
      var customRows = (data && Array.isArray(data.custom)) ? data.custom : [];
      var effectiveRows = (data && Array.isArray(data.effective)) ? data.effective : [];
      aiRunState.templateOptions = IMAGE_TEMPLATE_DEFS.map(function (def) {
        var eff = effectiveRows.filter(function (row) { return row.functionKey === def.key; })[0];
        var custom = eff && eff.promptId ? customRows.filter(function (row) { return row.id === eff.promptId && row.enabled !== false; })[0] : null;
        var official = officialRows.filter(function (row) { return row.functionKey === def.key; })[0];
        var body = custom ? String(custom.body || '') : (official ? String(official.body || '') : '');
        var configured = eff && typeof eff.configured === 'boolean'
          ? eff.configured
          : custom ? (Boolean(body.trim()) && body.trim() !== TEMPLATE_PLACEHOLDER) : Boolean(official && official.configured === true);
        var masked = Boolean((eff && eff.masked) || (official && official.masked) || (configured && !body.trim()));
        return { key: def.key, label: def.label, hint: def.hint, body: body, configured: configured, masked: masked };
      });
      aiRunState.templatesError = '';
    } catch (error) {
      aiRunState.templatesError = error && error.message ? error.message : '模板读取失败';
    }
    aiRunState.templatesLoading = false;
    if (aiRunState.shell && aiRunState.shell.dialog && document.body.contains(aiRunState.shell.dialog)) {
      // 模板正文异步到达后必须重建任务快照（打开弹窗时 templateOptions 还是空的），否则开始张数/冻结数滞后为0
      buildAiTasks();
      renderAiConfigView();
    }
  }
  function clearFoot(shell) { shell.foot.replaceChildren(); }
  function richDiv(parts, className) {
    var node = wyEl('div', className || '');
    parts.forEach(function (part) {
      var child = document.createElement(part.bold ? 'b' : 'span');
      child.textContent = part.text;
      node.append(child);
    });
    return node;
  }
  function detailLine(text) {
    var line = wyEl('div', 'wy-detailline');
    var ic = wyEl('i', 'ic'); ic.textContent = '…';
    var msg = wyEl('span', 'msg'); msg.textContent = text;
    line.append(ic, msg);
    line.set = function (stateName, icon, message) {
      line.className = 'wy-detailline ' + stateName;
      ic.textContent = icon;
      if (message !== undefined) msg.textContent = message;
    };
    return line;
  }
  function cssUrl(url) {
    return 'url("' + String(url == null ? '' : url).replace(/["\\\r\n]+/g, function (ch) { return encodeURIComponent(ch); }) + '"';
  }
  // ── 模板卡悬停显示生效提示词全文（任务#32）：单个浮层挂在弹窗上，位置用 CSSOM，样式走 .wy-tpl-tip，禁止内联 style ──
  var tplTipNode = null;
  function tplTipHost(shell) {
    var host = shell.dialog;
    if (tplTipNode && tplTipNode.parentNode === host) return tplTipNode;
    tplTipNode = wyEl('div', 'wy-tpl-tip');
    tplTipNode.setAttribute('role', 'tooltip');
    host.append(tplTipNode);
    return tplTipNode;
  }
  function bindTplTip(grid, shell) {
    var tip = tplTipHost(shell);
    var hideTimer = null;
    function contentFor(key) {
      var opt = aiRunState.templateOptions.filter(function (t) { return t.key === key; })[0];
      if (!opt) return null;
      if (!opt.configured) return templateLabel(key) + '：该模板尚未配置生效的提示词，请联系租户管理员配置。';
      if (opt.masked || !String(opt.body || '').trim()) return templateLabel(opt.key) + '：模板已配置并可使用，正文由租户管理员维护，当前账号不可查看。';
      return templateLabel(opt.key) + '（本次打开弹窗读取到的生效提示词）：\n' + opt.body;
    }
    function showTip(anchor) {
      var text = contentFor(anchor.dataset.tplKey);
      if (!text) { hideTip(); return; }
      if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = null; }
      tip.textContent = text;
      tip.classList.add('show');
      // sku34（用户真实Edge验收打回）：全站样式 dialog[open] 带 transform:translate(-50%,-50%)，
      // 弹窗因此成为 fixed 子层的包含块，视口坐标会被二次偏移（浮层跑到弹窗中部、被压成窄条）。
      // 浮层改为 absolute 挂在弹窗上，坐标一律换算成「卡片rect − 弹窗rect」，免疫弹窗transform、
      // 宿主覆盖层和页面缩放；宽度可用空间以弹窗自身为准，最右卡向左展开、不窄于卡片宽度；
      // 垂直优先卡片下方6px，放不下翻上方，两侧都放不下收缩高度保持贴卡（定位走CSSOM，允许）。
      var hr = shell.dialog.getBoundingClientRect();
      var rect = anchor.getBoundingClientRect();
      var margin = 8;
      var gap = 6;
      var cardLeft = rect.left - hr.left;
      var cardTop = rect.top - hr.top;
      var cardBottom = rect.bottom - hr.top;
      var avail = hr.width - margin - cardLeft;
      var width = Math.min(460, Math.max(rect.width, avail), hr.width - margin * 2);
      if (width < 160) width = Math.min(160, hr.width - margin * 2);
      tip.style.width = width + 'px';
      tip.style.maxHeight = '280px';
      var left = cardLeft;
      if (left + width > hr.width - margin) left = hr.width - margin - width;
      if (left < margin) left = margin;
      var h = tip.offsetHeight;
      var spaceBelow = hr.height - margin - (cardBottom + gap);
      var spaceAbove = cardTop - gap - margin;
      if (h <= spaceBelow) {
        tip.style.top = (cardBottom + gap) + 'px';
      } else if (h <= spaceAbove) {
        tip.style.top = (cardTop - gap - h) + 'px';
      } else if (spaceBelow >= spaceAbove) {
        tip.style.maxHeight = Math.max(80, spaceBelow) + 'px';
        tip.style.top = (cardBottom + gap) + 'px';
      } else {
        var ch = Math.max(80, spaceAbove);
        tip.style.maxHeight = ch + 'px';
        tip.style.top = (cardTop - gap - ch) + 'px';
      }
      tip.style.left = left + 'px';
    }
    function hideTip() { tip.classList.remove('show'); }
    function scheduleHide() { if (hideTimer) window.clearTimeout(hideTimer); hideTimer = window.setTimeout(hideTip, 200); }
    grid.addEventListener('mouseover', function (event) {
      var anchor = event.target && event.target.closest ? event.target.closest('[data-tpl-key]') : null;
      if (anchor) showTip(anchor);
    });
    grid.addEventListener('mouseout', function (event) {
      if (event.target && event.target.closest && event.target.closest('[data-tpl-key]')) scheduleHide();
    });
    tip.addEventListener('mouseenter', function () { if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = null; } });
    tip.addEventListener('mouseleave', scheduleHide);
  }
  // ── 视图1：配置（处理对象/翻译方向/提示词/费用通道） ──
  function renderAiConfigView() {
    var shell = aiRunState.shell;
    var capability = aiRunState.capability;
    var isTranslation = capability === 'image-translation';
    var isRepair = capability === 'image-repair';
    shell.body.replaceChildren();
    if (tplTipNode) tplTipNode.classList.remove('show');
    shell.titleEl.textContent = aiDialogTitle(capability);
    aiRunState.objCountLine = null;
    aiRunState.objStateLine = null;
    aiRunState.startBtn = null;
    aiRunState.statusLine = null;

    renderPreviewGrid(shell);

    var objSec = wyEl('section', 'wy-section');
    var objTitle = wyEl('h3', 'wy-section-title'); objTitle.textContent = '处理对象';
    var objSummary = wyEl('div', 'wy-summary');
    if (isTranslation || isRepair) {
      objSummary.append(richDiv(aiRunState.single
        ? [{ text: '单张编辑：本次只处理这 ' }, { text: '1', bold: true }, { text: ' 张图片，不会动外面已勾选的其它图片' }]
        : [{ text: '本次共选中 ' }, { text: String(aiRunState.tasks.length), bold: true }, { text: ' 张图片' }]));
      objSummary.append(richDiv([{ text: isTranslation ? '处理方式：把图片里的文字翻译成目标语言；在点“确认”之前，外面的原图不会有任何改动。'
        : '处理方式：框选出要修补的区域，由 AI 填补，每次处理一张。' }]));
    } else {
      if (aiRunState.single) {
        objSummary.append(richDiv([{ text: '单张编辑：本次只处理这 ' }, { text: '1', bold: true }, { text: ' 张图片，不会动外面已勾选的其它图片' }]));
        aiRunState.objStateLine = richDiv([{ text: buildRedrawStateText() + ' 在点“确认”之前，外面的原图不会有任何改动。' }]);
        objSummary.append(aiRunState.objStateLine);
      } else {
        aiRunState.objCountLine = richDiv([{ text: '批量操作：本次共选中 ' }, { text: String(selectedPreviewIndexes.size), bold: true }, { text: ' 张图片' }]);
        aiRunState.objStateLine = richDiv([{ text: buildRedrawStateText() + ' 在点“确认”之前，外面的原图不会有任何改动。' }]);
        objSummary.append(aiRunState.objCountLine, aiRunState.objStateLine);
      }
    }
    objSec.append(objTitle, objSummary);
    shell.body.append(objSec);

    var errLine = wyEl('p', 'wy-section-sub');
    errLine.style.margin = '0';
    errLine.style.color = '#dc2626';
    errLine.style.minHeight = '18px';

    if (isTranslation) {
      var dirSec = wyEl('section', 'wy-section');
      var dirTitle = wyEl('h3', 'wy-section-title'); dirTitle.textContent = '翻译方向';
      var dirGrid = wyEl('div', 'wy-pickgrid');
      var dirPicks = [];
      TRANSLATION_DIRECTIONS.forEach(function (entry) {
        var value = entry[0] + '->' + entry[1];
        var pick = wyPick(entry[2], value === 'zh->ru' ? '适合中文包装/说明书图片翻译到俄语市场' : '适合英文包装图片翻译到俄语市场');
        pick.select(aiRunState.direction === value);
        pick.onSelect = function () {
          aiRunState.direction = value;
          dirPicks.forEach(function (other) { other.select(other === pick); });
          errLine.textContent = '';
        };
        dirPicks.push(pick);
        dirGrid.append(pick.el);
      });
      dirSec.append(dirTitle, dirGrid);
      shell.body.append(dirSec);
    } else if (isRepair) {
      var repairSec = wyEl('section', 'wy-section');
      var repairTitle = wyEl('h3', 'wy-section-title'); repairTitle.textContent = '框选修复区域';
      var repairHint = wyEl('p', 'wy-section-sub'); repairHint.style.margin = '0';
      repairHint.textContent = 'AI修复要先在图片上框出需要修补的地方（比如多余文字、小瑕疵），每次只处理一张。点下面按钮进入框选。';
      var goRepair = wyBtn('去框选修复区域', 'primary');
      goRepair.addEventListener('click', function () { shell.close(); openSelectionFromHook('repair'); });
      repairSec.append(repairTitle, repairHint, goRepair);
      shell.body.append(repairSec);
    } else {
      // 卖点不会在打开弹窗或开始生图时自动请求；只有用户点击按钮才会调用文字AI。
      var sellSec = wyEl('section', 'wy-section');
      var sellTitle = wyEl('h3', 'wy-section-title'); sellTitle.textContent = '卖点';
      var sellSub = wyEl('p', 'wy-section-sub');
      var redrawLoadError = redrawSnapshotError();
      sellSub.textContent = redrawLoadError
        ? '当前商品原始信息加载失败，解析卖点已禁用：' + redrawLoadError
        : '优先保留当前窗口内容；已有双语卖点仅作文字填充，可再次点击“解析卖点”。';
      var sellBtnRow = wyEl('div', 'wy-sellrow');
      var sellGet = wyBtn('解析卖点', 'ghost');
      sellGet.disabled = Boolean(redrawLoadError);
      var sellLang = wyEl('label', 'wy-selllang');
      var sellLangLabel = wyEl('span', ''); sellLangLabel.textContent = '图片文案';
      var sellLangSelect = document.createElement('select');
      var sellLangRu = document.createElement('option'); sellLangRu.value = 'ru'; sellLangRu.textContent = '俄语（默认）';
      var sellLangZh = document.createElement('option'); sellLangZh.value = 'zh'; sellLangZh.textContent = '中文';
      sellLangSelect.append(sellLangRu, sellLangZh);
      sellLangSelect.value = aiRunState.imageTextLanguage === 'zh' ? 'zh' : 'ru';
      sellLangSelect.setAttribute('aria-label', 'AI图片文案语言');
      sellLangSelect.title = '卖点可以使用中文、俄文或双语。\n这里只决定生成图片时使用哪种语言的文案。';
      sellLangSelect.addEventListener('change', function () {
        aiRunState.imageTextLanguage = sellLangSelect.value === 'zh' ? 'zh' : 'ru';
        aiDialogStatus(aiRunState.imageTextLanguage === 'ru' ? '图片将使用俄文正式版卖点；中文仅供核对' : '图片将使用中文核对版卖点');
      });
      sellLang.append(sellLangLabel, sellLangSelect);
      var sellStatus = wyEl('p', 'wy-section-sub wy-status');
      sellStatus.setAttribute('role', 'status');
      sellStatus.setAttribute('aria-live', 'polite');
      aiRunState.statusLine = sellStatus;
      var sellAiBusy = false;
      aiRunState.cancelSellingPointRequest = function () { stopSellPointAttemptRecovery(); sellAiBusy = false; sellGet.disabled = Boolean(redrawLoadError); sellGet.textContent = '解析卖点'; };
      function updateRecoveredAttemptState(state) {
        sellAiBusy = false;
        if (state === 'none' || state === 'failed' || state === 'unknown' || state === 'recovery_required') { invalidateRedrawProof(); sellGet.disabled = false; sellGet.textContent = '解析卖点'; syncRedrawStartReady(); return; }
        if (state === 'succeeded') { sellGet.disabled = false; sellGet.textContent = '解析卖点'; return; }
        if (state === 'checking' || state === 'processing') { sellGet.disabled = true; sellGet.textContent = '读取已解析卖点…'; return; }
        sellGet.disabled = true;
        sellGet.textContent = '解析卖点';
      }
      sellGet.addEventListener('click', function () {
        if (sellAiBusy) return;
        var snapshotError = redrawSnapshotError();
        if (snapshotError) { aiDialogStatus('当前商品信息尚未加载成功：' + snapshotError); return; }
        stopSellPointAttemptRecovery(); // 新的人工点击会取消旧目标的只读轮询；是否提交由本次点击明确决定。
        invalidateRedrawProof();
        var collected = sellPointSourceText(aiRunState.redrawSnapshot);
        if (!collected) { aiDialogStatus('当前商品没有可读的标题、简介或属性，无法交给 AI 解析；请先补充内容或手动填写卖点'); return; }
        sellAiBusy = true;
        sellGet.disabled = true;
        sellGet.textContent = 'AI 解析卖点中…';
        aiDialogStatus('正在调用 AI 大模型解析当前商品内容并总结提炼卖点…');
        var source = redrawSourceTarget();
        if (source.error) { sellAiBusy = false; sellGet.disabled = false; sellGet.textContent = '解析卖点'; aiDialogStatus(source.error); return; }
        var awaitingRecovery = false, guard = sellPointResponseGuard(sellArea), attemptId = window.crypto.randomUUID();
        aiRunState.sellingPointAttemptId = attemptId;
        requestSellPointSummary(collected, source.target, attemptId, sellPointEvidence()).then(function (result) {
          if (!guard()) return;
          if (result.state === 'processing') { awaitingRecovery = true; recoverSellPointAttempt(source.target, sellArea, { onState: updateRecoveredAttemptState, guard: guard, attemptId: attemptId }); return; }
          restoreSellPointSummary(result, source.target, sellArea, guard);
        }).catch(function (error) {
          if (!guard()) return;
          showSellPointDiagnostic(error && error.diagnosticId);
          if (error && error.sellPointAttemptRecovery) { awaitingRecovery = true; recoverSellPointAttempt(source.target, sellArea, { onState: updateRecoveredAttemptState, guard: guard, attemptId: attemptId }); }
          else { aiDialogStatus('AI 解析卖点失败：' + String((error && error.message) || '未知错误') + '；卖点框保持现有内容，未编造任何文字'); showSellPointDiagnostic(error && error.diagnosticId); }
        }).then(function () {
          if (!awaitingRecovery && aiRunState.sellingPointAttemptId === attemptId && aiRunState.shell && aiRunState.shell.dialog.contains(sellGet)) { sellAiBusy = false; sellGet.disabled = false; sellGet.textContent = '解析卖点'; }
        });
      });
      sellBtnRow.append(sellGet, sellLang);
      var sellField = wyEl('div', 'field wy-sellfield');
      var sellArea = document.createElement('textarea');
      sellArea.className = 'wy-sellarea';
      sellArea.value = aiRunState.sellingPoints || '';
      sellArea.placeholder = '至少填写2条卖点，例如：\n1. 卖点内容\n2. 卖点内容';
      sellArea.setAttribute('aria-label', '当前重绘窗口的卖点');
      var sellFormatHint = wyEl('p', 'wy-section-sub');
      function updateSellPointFormatHint() {
        var checked = validateSellingPointFormat(sellArea.value);
        sellFormatHint.textContent = checked.ok
          ? '卖点格式正确，共 ' + checked.count + ' 条；中文或俄文均可。'
          : '至少填写2条卖点，每条需用 1.、1、或 1) 开头；中文或俄文均可。不会写可以使用“解析卖点”。';
      }
      sellArea.addEventListener('input', function () {
        aiRunState.sellingPointRevision++;
        aiRunState.sellingPointsBilingual = editedSellPointPair(sellArea.value);
        if (aiRunState.contentReview) aiRunState.contentReview.changed('sellingPoints');
        stopSellPointAttemptRecovery();
        sellAiBusy = false; sellGet.disabled = false; sellGet.textContent = '解析卖点';
        aiRunState.sellingPoints = sellArea.value;
        if (sellArea.value && sellArea.value !== aiRunState.initialSellingPoints) {
          aiRunState.sellingPointsSource = 'manual'; invalidateRedrawProof(); writeSellPointCache();
        } else if (!sellArea.value) {
          aiRunState.sellingPointsSource = ''; invalidateRedrawProof(); writeSellPointCache();
        }
        updateSellPointFormatHint();
        aiDialogStatus(validateSellingPointFormat(sellArea.value).ok ? '卖点格式正确，可以继续选择模板并生图' : SELL_POINT_FORMAT_ERROR);
        syncRedrawStartReady();
      });
      updateSellPointFormatHint();
      sellField.append(sellArea, sellFormatHint);
      if (aiRunState.contentReview) { aiRunState.contentReview.attach('sellingPoints', sellField); aiRunState.contentReview.attachChinese('sellingPoints', sellField); aiRunState.contentReview.changed('sellingPoints'); }
      sellSec.append(sellTitle, sellSub, sellBtnRow, sellField, sellStatus);
      shell.body.append(sellSec);
      if (redrawLoadError) aiDialogStatus('当前商品信息加载失败：' + redrawLoadError + '；解析卖点已禁用');
      else {
        var savedSource = redrawSourceTarget();
        if (savedSource.error) { sellGet.disabled = true; aiDialogStatus(savedSource.error); }
        else if (validateSellingPointFormat(sellArea.value).ok) aiDialogStatus('卖点格式正确，可以继续选择模板并生图');
        else aiDialogStatus(SELL_POINT_FORMAT_ERROR);
      }
      var tplSec = wyEl('section', 'wy-section');
      var tplTitle = wyEl('h3', 'wy-section-title'); tplTitle.textContent = '选择模板';
      var tplSub = wyEl('p', 'wy-section-sub');
      tplSub.style.margin = '0 0 10px';
      tplSub.textContent = '模板来自「AI 配置 → 图片提示词」。批量重绘可选择多个模板，每张勾选图片按模板各创建一个任务；鼠标悬停可查看当前生效的提示词全文。';
      if (aiRunState.templatesLoading) {
        var tplLoading = wyEl('p', 'wy-section-sub'); tplLoading.style.margin = '0';
        tplLoading.textContent = '模板读取中…';
        tplSec.append(tplTitle, tplSub, tplLoading);
      } else if (aiRunState.templatesError) {
        var tplErr = wyEl('p', 'wy-section-sub'); tplErr.style.margin = '0 0 10px'; tplErr.style.color = '#dc2626';
        tplErr.textContent = '模板读取失败：' + aiRunState.templatesError;
        var tplRetry = wyBtn('重新读取模板', 'ghost');
        tplRetry.addEventListener('click', function () { aiRunState.templatesLoading = true; renderAiConfigView(); loadAiPromptTemplates(); });
        tplSec.append(tplTitle, tplSub, tplErr, tplRetry);
      } else {
        var tplGrid = wyEl('div', 'wy-pickgrid cols-6');
        aiRunState.templateOptions.forEach(function (opt) {
          var cell = wyEl('div', 'wy-tplcell');
          var pick = wyPick(opt.label, opt.configured ? opt.hint : '这个模板还没填写内容，先到「AI 配置 → 图片提示词」保存',
            opt.configured ? null : { text: '待填写', cls: 'wy-badge-gray' });
          pick.select(aiRunState.selectedTemplates.indexOf(opt.key) >= 0);
          if (!opt.configured) pick.el.classList.add('disabled');
          pick.el.dataset.tplKey = opt.key;
          pick.onSelect = function () {
            if (!opt.configured) { status('“' + opt.label + '”模板还没填写内容，请到「AI 配置 → 图片提示词」先保存模板'); return; }
            if (aiRunState.single) aiRunState.selectedTemplates = [opt.key];
            else if (aiRunState.selectedTemplates.indexOf(opt.key) >= 0) aiRunState.selectedTemplates = aiRunState.selectedTemplates.filter(function (key) { return key !== opt.key; });
            else aiRunState.selectedTemplates.push(opt.key);
            buildAiTasks();
            renderAiConfigView();
          };
          cell.append(pick.el);
          // 每张模板卡下方的候选数量框（主图固定1；其余模板1-9，非数字实时过滤，清空失焦回落1）
          var qtyRow = wyEl('div', 'wy-tplqty');
          var qtyLabel = wyEl('span', '');
          qtyLabel.textContent = '数量';
          var qty = document.createElement('input');
          qty.type = 'text';
          qty.inputMode = 'numeric';
          qty.maxLength = 1;
          qty.value = String(templateCountOf(opt.key));
          qty.setAttribute('aria-label', opt.label + '：每张勾选图片生成的候选数量（1-9）');
          // sku33：右侧自定义步进箭头（按钮+▲▼字符，不用原生number spinner），点击/键盘Up/Down同口径±1，1-9钳制
          // sku35（任务#38）：未选中模板改数量按裁决不计入、不刷新价格，但必须给明确中文提示，消除“改了数字价格不动”的无反馈感
          function notifyCountEffect() {
            if (aiRunState.selectedTemplates.indexOf(opt.key) < 0) status('“' + opt.label + '”模板还没选中，它的数量不计入本次将生成和费用；点该卡片选中后立即按数量计入');
          }
          function applyCount(n) {
            var v = Math.max(1, Math.min(9, n));
            aiRunState.templateCounts[opt.key] = v;
            qty.value = String(v);
            syncTemplateCountEffects();
            notifyCountEffect();
          }
          var steps = wyEl('div', 'wy-tplstep');
          var upBtn = document.createElement('button');
          upBtn.type = 'button'; upBtn.textContent = '\u25B2';
          upBtn.setAttribute('aria-label', opt.label + '数量加1');
          var downBtn = document.createElement('button');
          downBtn.type = 'button'; downBtn.textContent = '\u25BC';
          downBtn.setAttribute('aria-label', opt.label + '数量减1');
          if (capability === 'image-redraw' && opt.key !== 'image-main') {
            qty.addEventListener('input', function () {
              var filtered = qty.value.replace(/[^1-9]/g, '');
              // 输入了数字但不在 1-9（即 '0'）→ 钳制为 1；输入非数字 → 直接过滤掉（清空由 blur 回落 1）
              if (!filtered && /[0-9]/.test(qty.value)) filtered = '1';
              if (filtered !== qty.value) qty.value = filtered;
              if (filtered) {
                aiRunState.templateCounts[opt.key] = parseInt(filtered, 10);
                syncTemplateCountEffects();
                notifyCountEffect();
              }
            });
            qty.addEventListener('blur', function () {
              if (!qty.value) {
                qty.value = '1';
                aiRunState.templateCounts[opt.key] = 1;
                syncTemplateCountEffects();
                notifyCountEffect();
              }
            });
            qty.addEventListener('keydown', function (event) {
              if (event.key === 'ArrowUp') { event.preventDefault(); applyCount(templateCountOf(opt.key) + 1); }
              else if (event.key === 'ArrowDown') { event.preventDefault(); applyCount(templateCountOf(opt.key) - 1); }
            });
            upBtn.addEventListener('click', function () { applyCount(templateCountOf(opt.key) + 1); });
            downBtn.addEventListener('click', function () { applyCount(templateCountOf(opt.key) - 1); });
          } else {
            qty.disabled = true;
            qty.classList.add('fixed');
            upBtn.disabled = true;
            downBtn.disabled = true;
            upBtn.classList.add('fixed');
            downBtn.classList.add('fixed');
          }
          steps.append(upBtn, downBtn);
          qtyRow.append(qtyLabel, qty, steps);
          cell.append(qtyRow);
          tplGrid.append(cell);
        });
        tplSec.append(tplTitle, tplSub, tplGrid);
        bindTplTip(tplGrid, shell);
      }
      shell.body.append(tplSec);
    }

    // 调度裁决（sku31）：AI修复模式也显示费用通道/费用行/余额行，与批量/翻译/单张同规则，费用区块对所有模式渲染
    {
      var feeSec = wyEl('section', 'wy-section');
      var feeTitle = wyEl('h3', 'wy-section-title'); feeTitle.textContent = '费用通道';
      var feeGrid = wyEl('div', 'wy-pickgrid cols-2');
      var ownPick = wyPick('使用我自己的密钥', '使用你在「AI 配置」页保存的密钥调用，平台不扣 AI豆', { text: '免费', cls: 'wy-badge-green' });
      var walletNow = aiRunState.beanWallet || freshBeanWallet();
      var officialPick = wyPick(
        '使用官方通道',
        '不用自己注册和保管密钥',
        walletNow.officialChannelAvailable ? { text: officialPriceBadge(walletNow), cls: 'wy-badge-green' } : { text: '即将开通', cls: 'wy-badge-gray' }
      );
      // 单价说明含原价删除线结构，用节点渲染（禁止内联 style，CSP style-src-attr 拦截）
      renderRichParts(officialPick.el.querySelector('span.d'),
        [{ text: '不用自己注册和保管密钥，图片处理 ' }].concat(pricePromoParts(walletNow)));
      if (!walletNow.officialChannelAvailable) officialPick.el.classList.add('disabled');
      if (capability === 'image-redraw') aiRunState.channel = 'official';
      ownPick.select(aiRunState.channel === 'own');
      officialPick.select(aiRunState.channel === 'official');
      ownPick.onSelect = function () {
        aiRunState.channelUserTouched = true;
        aiRunState.channel = 'own';
        ownPick.select(true); officialPick.select(false);
        refreshFeeLine(); errLine.textContent = '';
        saveAiChannelPreference('own');
      };
      officialPick.onSelect = function () {
        if (!walletNow.officialChannelAvailable) { officialPick.select(false); return; }
        aiRunState.channelUserTouched = true;
        aiRunState.channel = 'official';
        officialPick.select(true); ownPick.select(false);
        refreshFeeLine(); errLine.textContent = '';
        saveAiChannelPreference('official');
      };
      if (capability === 'image-redraw') feeGrid.append(officialPick.el);
      else feeGrid.append(ownPick.el, officialPick.el);
      var feeRemember = wyEl('p', 'wy-section-sub'); feeRemember.style.margin = '6px 0 0';
      feeRemember.textContent = capability === 'image-redraw'
        ? '本次10 AI豆包含提示词整理与图片生成，不另扣文字整理费用；任务已进入后台后，请在任务中心查看状态。'
        : '通道选择会自动保存到你的账号（换设备登录也沿用），下次打开重绘、翻译、修复都继续用这次的选择，不用每次重选；若“自己的密钥”配置被删除或停用，会自动回到官方通道。';
      var feeSummary = wyEl('div', 'wy-summary');
      aiRunState.feeLine = richDiv([]);
      aiRunState.balanceLine = wyEl('span', '');
      var balanceWrap = richDiv([]);
      balanceWrap.append(aiRunState.balanceLine);
      feeSummary.append(aiRunState.feeLine, balanceWrap);
      feeSec.append(feeTitle, feeGrid, feeRemember, feeSummary);
      shell.body.append(feeSec, errLine);
      // refreshFeeLine 有 document.body.contains 保护，必须在节点挂入文档后再填充
      refreshFeeLine();
      refreshBeanBalanceLine();
    }

    clearFoot(shell);
    var cancel = wyBtn('取消', 'ghost');
    cancel.addEventListener('click', function () { shell.close(); });
    shell.foot.append(cancel);
    if (!isRepair) {
      var startLabel = isTranslation
        ? '开始翻译（' + aiRunState.tasks.length + ' 张）'
        : (aiRunState.tasks.length ? '开始生图（' + aiRunState.tasks.length + ' 张）' : '开始生图');
      var start = wyBtn(startLabel, 'primary');
      aiRunState.startBtn = start;
      syncRedrawStartReady();
      start.addEventListener('click', function () {
        if (aiRunState.busy) return;
        if (isTranslation && !aiRunState.direction) { errLine.textContent = '请选择翻译方向后再开始，不会替你预选'; return; }
        if (capability === 'image-redraw') {
          if (!sellPointReady()) { errLine.textContent = SELL_POINT_FORMAT_ERROR; return; }
          if (aiRunState.templatesLoading) { errLine.textContent = '模板还在读取中，请稍等几秒再开始'; return; }
          if (aiRunState.templatesError) { errLine.textContent = '模板读取失败，请点“重新读取模板”成功后再开始'; return; }
          if (!aiRunState.selectedTemplates.length) { errLine.textContent = aiRunState.single ? '请先选择 1 个模板再开始生图' : '请先选择至少 1 个模板再开始生图'; return; }
          var source = sellingPointSubmissionSource() === 'manual' ? redrawSourceTarget(aiRunState.tasks[0] && aiRunState.tasks[0].sourceIndex) : redrawSourceTarget();
          if (source.error) { invalidateRedrawProof(); errLine.textContent = source.error; return; }
          // 主图默认选中，但真实环境可能尚未在「AI 配置」填写正文：占位符/空正文模板被选中时禁止开始，避免按无效模板扣费
          var unconfigured = aiRunState.templateOptions.filter(function (t) { return aiRunState.selectedTemplates.indexOf(t.key) >= 0 && !t.configured; });
          if (unconfigured.length) { errLine.textContent = '“' + unconfigured.map(function (t) { return t.label; }).join('、') + '”模板还没填写内容，请到「AI 配置 → 图片提示词」保存后再开始'; return; }
          buildAiTasks(); // 开始前用当前选中模板的最新正文快照任务
          if (!aiRunState.tasks.length) { errLine.textContent = '没有可处理的图片，请关闭后重新打开'; return; }
        }
        if (aiRunState.channel === 'official') {
          var wallet = aiRunState.beanWallet || freshBeanWallet();
          if (!wallet.officialChannelAvailable) { errLine.textContent = '官方通道即将开通，当前还不能扣费使用；请先选择上面的“使用我自己的密钥”（免费），开通后这里会自动放开'; return; }
          if (wallet.loading) { errLine.textContent = 'AI豆余额还在读取，请稍等几秒再开始（也可以改用自己的密钥免费处理）'; return; }
          if (wallet.balanceBean === null) { errLine.textContent = 'AI豆余额暂时读不到，请改用自己的密钥；官方通道开通后才可扣费使用'; return; }
          var needBean = aiRunState.tasks.length * wallet.imageCostBean;
          if (wallet.balanceBean < needBean) {
            errLine.textContent = 'AI豆余额不足：本次共需 ' + needBean + ' 豆（' + aiRunState.tasks.length + ' 张×' + wallet.imageCostBean + ' 豆），当前余额只有 ' + wallet.balanceBean + ' 豆。请改用“使用我自己的密钥”，或联系管理员充值（1元=100豆）';
            return;
          }
        }
        errLine.textContent = '';
        renderAiProgressView();
        runAiBatch();
      });
      shell.foot.append(start);
    }
  }
  // ── 视图2：批量处理进度 ──
  function renderAiProgressView() {
    var shell = aiRunState.shell;
    shell.body.replaceChildren();
    shell.titleEl.textContent = aiDialogTitle(aiRunState.capability) + '进行中';
    var prog = wyProgress();
    shell.body.append(prog.el);
    var detailSec = wyEl('section', 'wy-section');
    var detailTitle = wyEl('h3', 'wy-section-title'); detailTitle.textContent = '处理明细';
    var detailList = wyEl('div', 'wy-detaillist');
    aiRunState.tasks.forEach(function (task) {
      var line = detailLine(task.name + '：等待中');
      task.detailLine = line;
      detailList.append(line);
    });
    detailSec.append(detailTitle, detailList);
    shell.body.append(detailSec);
    clearFoot(shell);
    var waiting = wyBtn('处理中，请稍候…', 'ghost');
    waiting.disabled = true;
    shell.foot.append(waiting);
    shell.aiProgress = prog;
  }
  // 图片翻译走服务器持久任务；重绘批量由 runAiBatch 一次提交，浏览器绝不轮询供应商。
  async function generateAiCandidate(task, onWait) {
    var source = task.item;
    var target = targetOf(rowAt(openedIndex));
    if (!target) throw new Error('请先选择上架店铺');
    var pair = String(aiRunState.direction || '').split('->');
    var billingChannel = aiRunState.channel === 'official' ? 'official' : 'own';
    var sourceTarget = aiSourceTarget(source, target);
    if (!sourceTarget) throw new Error('当前图片来源信息不完整，请重新打开图片编辑');
    var payload = Object.assign({}, sourceTarget, {
      sourceLanguage: pair[0] || null,
      targetLanguage: pair[1] || null,
      capability: aiRunState.capability,
      billingChannel: billingChannel
    });
    if (billingChannel === 'own') payload.configurationId = await resolveImageConfigId(aiRunState.capability);
    var response = await rawApi('/api/domain/commands/sku-image-ai', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('ai-translation') }, body: JSON.stringify(payload) });
    var outcome = response.data || {};
    if (response.status !== 202 || !outcome.taskId) {
      var processFailure = new Error(outcome.message || '图片翻译任务未能进入任务中心，请稍后重试；若持续失败请提交 BUG 反馈。');
      processFailure.status = response.status;
      throw processFailure;
    }
    return { taskId: String(outcome.taskId), duplicate: Boolean(outcome.duplicate) };
  }
  async function enqueueAiRedrawBatch(tasks) {
    var first = redrawSourceTarget(tasks[0] && tasks[0].sourceIndex);
    if (first.error) throw new Error(first.error);
    var target = first.target;
    var payload = {
      clientId: target.clientId,
      productId: target.productId,
      variantRef: target.variantRef,
      capability: 'image-redraw',
      billingChannel: 'official',
      sellingPointsSource: sellingPointSubmissionSource(),
      sellingPoints: String(aiRunState.sellingPoints).trim(),
      imageTextLanguage: aiRunState.imageTextLanguage === 'zh' ? 'zh' : 'ru',
      items: tasks.map(function (task) {
        var source = redrawSourceTarget(task.sourceIndex);
        if (source.error) throw new Error(source.error);
        if (source.currentItem !== task.item) throw new Error('当前选择的图片已变化，请重新打开面板并解析卖点后再开始生图');
        return Object.assign({}, source.target, { templateKey: task.templateKey || aiRunState.selectedTemplates[0] });
      })
    };
    if (payload.sellingPointsSource !== 'manual') payload.analysisProof = aiRunState.analysisProof;
    var queued = await rawApi('/api/domain/commands/sku-image-ai-batch', {
      method: 'POST', headers: { 'Idempotency-Key': idempotencyKey('ai-redraw-batch') }, body: JSON.stringify(payload)
    });
    var data = queued.data || {}, taskIds = Array.isArray(data.taskIds) ? data.taskIds.map(String) : [];
    if (queued.status !== 202 || data.state !== 'queued' || !data.taskId || taskIds.length !== tasks.length) {
      throw new Error(data.message || '批量AI重绘任务未能进入任务中心，请稍后重试；若持续失败请提交 BUG 反馈。');
    }
    return { taskId: String(data.taskId), taskIds: taskIds };
  }
  async function runAiBatch() {
    var shell = aiRunState.shell;
    var prog = shell.aiProgress;
    var tasks = aiRunState.tasks;
    aiRunState.busy = true;
    var doneCount = 0;
    prog.set(0, tasks.length, '正在进入任务中心…');
    if (aiRunState.capability === 'image-redraw') {
      tasks.forEach(function (task) { task.status = 'running'; task.detailLine.set('run', '…', task.name + '：正在登记批量任务…'); });
      try {
        var batch = await enqueueAiRedrawBatch(tasks);
        aiRunState.queuedBatchTaskId = batch.taskId;
        aiRunState.queuedTaskIds = batch.taskIds;
        tasks.forEach(function (task, index) {
          task.candidate = { taskId: batch.taskIds[index] };
          task.status = 'success';
          task.detailLine.set('ok', '\u2713', task.name + '：已进入批量任务（' + batch.taskIds[index] + '）');
        });
        prog.set(tasks.length, tasks.length, '已进入任务中心');
      } catch (error) {
        var message = error && error.message ? error.message : '未知原因';
        tasks.forEach(function (task) { task.status = 'failed'; task.error = message; task.detailLine.set('fail', '\u00D7', task.name + '：' + message); });
      }
      aiRunState.busy = false;
      if (aiRunState.queuedTaskIds.length) renderQueuedRedrawView();
      else { renderAiConfigView(); aiDialogStatus('没有任务进入任务中心：' + tasks[0].error); }
      return;
    }
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      task.status = 'running';
      task.detailLine.set('run', '…', task.name + '：正在处理…');
      prog.set(doneCount, tasks.length, '正在处理 ' + task.name + '…');
      try {
        var candidate = await generateAiCandidate(task);
        task.candidate = candidate;
        task.status = 'success';
        aiRunState.queuedTaskIds.push(candidate.taskId);
        task.detailLine.set('ok', '\u2713', task.name + '：已进入任务中心（' + candidate.taskId + '）');
      } catch (error) {
        task.status = 'failed';
        task.error = error && error.message ? error.message : '未知原因';
        task.detailLine.set('fail', '\u00D7', task.name + '：' + task.error);
      }
      doneCount += 1;
      prog.set(doneCount, tasks.length, '已完成 ' + doneCount + '/' + tasks.length + ' 张');
    }
    aiRunState.busy = false;
    if (aiRunState.queuedTaskIds.length) renderQueuedRedrawView();
    else { renderAiConfigView(); aiDialogStatus('没有任务进入任务中心：' + tasks.filter(function (task) { return task.status === 'failed'; }).map(function (task) { return task.name + '（' + task.error + '）'; }).join('；')); }
  }

  var redrawTaskWatcher = null;
  function refreshRedrawLinks() {
    if (sourceTab === 'ai') renderSourceList();
    return Promise.resolve();
  }
  function watchQueuedRedrawTasks() {
    var ids = aiRunState.queuedTaskIds.slice();
    if (!ids.length) return;
    function check() {
      api('/api/sync-tasks?limit=100&offset=0&ids=' + encodeURIComponent(ids.join(','))).then(function (data) {
        var byId = {};
        (data.items || []).forEach(function (item) { byId[String(item.id)] = item; });
        var terminal = ids.length > 0;
        var anyFailed = aiRunState.tasks.some(function (task) { return task.status === 'failed'; });
        aiRunState.tasks.forEach(function (task) {
          if (!task.candidate || !task.candidate.taskId) return;
          var item = byId[task.candidate.taskId];
          if (!item) { terminal = false; return; }
          var failed = item.status === 'failed';
          var done = item.status === 'done';
          if (failed) anyFailed = true;
          if (!failed && !done) terminal = false;
          if (task.detailLine) task.detailLine.set(failed ? 'fail' : done ? 'ok' : 'run', failed ? '×' : done ? '\u2713' : '…', task.name + '：' + (failed ? '失败：' + (item.label || item.reason || '任务失败') : done ? '成功：' + (item.label || '已完成，已回填图片列表') : (item.label || item.progressLabel || '后台处理中')));
        });
        if (terminal) {
          if (redrawTaskWatcher) { window.clearInterval(redrawTaskWatcher); redrawTaskWatcher = null; }
          refreshRedrawLinks().then(function () { status(anyFailed ? 'AI图片任务已结束，部分失败原因见任务中心；成功候选可到AI生图记录查看' : 'AI图片任务已完成，候选已进入AI生图记录，请查看后再决定是否采用'); }).catch(function (error) { status('任务已结束，但AI生图记录刷新失败：' + String(error && error.message || '未知原因') + '；可重新打开AI生图记录'); });
        }
      }).catch(function () {});
    }
    check();
    if (redrawTaskWatcher) window.clearInterval(redrawTaskWatcher);
    redrawTaskWatcher = window.setInterval(check, 5000);
  }
  function openWorkspacePage(route, title) {
    var target = String(route || '/index.html');
    if (window.top !== window && new URLSearchParams(location.search).get('workspace') === '1') {
      window.parent.postMessage({ type: 'wyerp-workspace-open', route: target, title: title || '' }, location.origin);
      return;
    }
    location.href = target;
  }
  function renderQueuedRedrawView() {
    var shell = aiRunState.shell;
    shell.body.replaceChildren();
    shell.titleEl.textContent = (aiRunState.capability === 'image-translation' ? '图片翻译' : 'AI重绘') + '已进入任务中心';
    var hint = wyEl('p', 'wy-section-sub');
    hint.textContent = '任务已由服务器持久处理。页面不会拿任务号再次调用生图接口，也不会轮询供应商；完成后请到AI生图记录查看候选图。';
    var sec = wyEl('section', 'wy-section');
    var title = wyEl('h3', 'wy-section-title'); title.textContent = '任务状态';
    var list = wyEl('div', 'wy-detaillist');
    aiRunState.tasks.forEach(function (task) {
      var taskId = task.candidate && task.candidate.taskId;
      var line = detailLine(taskId ? task.name + '：已进入任务中心（' + taskId + '）' : task.name + '：失败：' + String(task.error || '未返回任务编号'));
      line.set(taskId ? 'ok' : 'failed', taskId ? '✓' : '×');
      task.detailLine = line;
      list.append(line);
    });
    sec.append(title, list);
    shell.body.append(hint, sec);
    clearFoot(shell);
    var openTasks = wyBtn('打开任务中心', 'primary');
    openTasks.addEventListener('click', function () { openWorkspacePage('/pages/task-center.html', '任务中心'); });
    var close = wyBtn('关闭', 'ghost'); close.addEventListener('click', function () { shell.close(); });
    shell.foot.append(close, openTasks);
    watchQueuedRedrawTasks();
  }

  // 读取该SKU已产出的 AI 候选（服务端只读接口 GET sku-image-candidates）
  async function fetchCandidates() {
    var target = targetOf(rowAt(openedIndex));
    if (!target) return [];
    var data = await api('/api/domain/commands/sku-image-candidates', { method: 'POST', body: JSON.stringify(target) });
    return (data && Array.isArray(data.items) ? data.items : []).map(function (item) {
      return {
        id: String(item.candidateId), capability: item.capability || 'image-redraw', preview: item.url,
        width: item.width, height: item.height, adopted: Boolean(item.adopted), createdAt: item.createdAt,
        taskId: item.taskId || '', templateKey: item.templateKey || '', sourceLanguage: item.sourceLanguage || '', targetLanguage: item.targetLanguage || '', billingChannel: item.billingChannel || '',
        linkId: item.linkId || '', associationVersion: Number(item.associationVersion) || 0, sourceKind: item.sourceKind || 'linked', sourceRef: item.sourceRef || '', sourceIndex: -1, fromServer: true
      };
    });
  }
  // ── 视图3：结果预览（勾选/放大/每张选择替换或追加） ──
  function chosenSuccessTasks() {
    return aiRunState.tasks.filter(function (task) { return task.status === 'success' && task.chosen; });
  }
  function aiResultCard(task) {
    var card = wyEl('div', 'wy-imgcard');
    var name = wyEl('div', 'wy-imgname'); name.textContent = task.name;
    if (task.status !== 'success') {
      var brokenThumb = wyEl('div', 'wy-imgthumb');
      var err = wyEl('div', 'wy-imgerr'); err.textContent = task.error || '处理失败';
      brokenThumb.append(err);
      card.append(brokenThumb, name);
      return card;
    }
    card.classList.toggle('on', task.chosen);
    var check = wyEl('button', 'wy-imgcheck' + (task.chosen ? '' : ' off'));
    check.type = 'button';
    check.textContent = task.chosen ? '\u2713' : '';
    check.setAttribute('aria-label', (task.chosen ? '取消选择 ' : '选择 ') + task.name);
    check.addEventListener('click', function (event) {
      event.stopPropagation();
      task.chosen = !task.chosen;
      renderAiResultView();
    });
    var thumb = wyEl('div', 'wy-imgthumb zoomable');
    thumb.style.backgroundImage = cssUrl(task.candidate.url);
    var pv = wyEl('span', 'pv'); pv.textContent = '\u25CE 预览';
    thumb.append(pv);
    thumb.addEventListener('click', function () {
      wyLightbox(task.candidate.url, task.name + ' AI 结果');
    });
    var modeRow = wyEl('div', 'wy-modes');
    ['replace', 'append'].forEach(function (mode) {
      var modeBtn = wyEl('button', 'wy-modebtn' + (task.writeMode === mode ? ' on' : ''));
      modeBtn.type = 'button';
      modeBtn.textContent = mode === 'replace' ? '替换原图' : '追加为新图';
      modeBtn.addEventListener('click', function (event) {
        event.stopPropagation();
        task.writeMode = mode;
        renderAiResultView();
      });
      modeRow.append(modeBtn);
    });
    card.append(check, thumb, name, modeRow);
    return card;
  }
  function renderAiResultView() {
    var shell = aiRunState.shell;
    var isTranslation = aiRunState.capability === 'image-translation';
    shell.body.replaceChildren();
    shell.titleEl.textContent = isTranslation ? '翻译结果预览' : 'AI生图结果预览';

    var successTasks = aiRunState.tasks.filter(function (task) { return task.status === 'success'; });
    var failedCount = aiRunState.tasks.length - successTasks.length;
    var chosenCount = chosenSuccessTasks().length;

    var headSec = wyEl('section', 'wy-section');
    var sub = wyEl('p', 'wy-section-sub'); sub.style.margin = '0';
    sub.textContent = '成功 ' + successTasks.length + ' 张' + (failedCount ? '，失败 ' + failedCount + ' 张' : '') + '；勾选要写入的图片，点缩略图可放大查看；确认后才会真正改动图片列表。';
    var checkAll = wyCheckLine('全选成功的图片', successTasks.length > 0 && chosenCount === successTasks.length);
    checkAll.onChange = function (flag) {
      aiRunState.tasks.forEach(function (task) { if (task.status === 'success') task.chosen = flag; });
      renderAiResultView();
    };
    headSec.append(sub, checkAll.el);
    shell.body.append(headSec);

    var gridSec = wyEl('section', 'wy-section');
    var grid = wyEl('div', 'wy-result-grid');
    aiRunState.tasks.forEach(function (task) { grid.append(aiResultCard(task)); });
    gridSec.append(grid);
    shell.body.append(gridSec);

    clearFoot(shell);
    var back = wyBtn('返回重新设置', 'ghost');
    back.addEventListener('click', function () { renderAiConfigView(); });
    var hasAppend = chosenSuccessTasks().some(function (task) { return task.writeMode === 'append'; });
    var confirmWrite = wyBtn((hasAppend ? '确认写入（' : '确认替换（') + chosenCount + ' 张）', 'primary');
    confirmWrite.addEventListener('click', function () {
      if (!chosenSuccessTasks().length) { status('请先勾选至少一张成功的图片'); return; }
      shell.close();
      sourceTab = 'ai';
      document.querySelectorAll('[data-static-tab]').forEach(function (tab) {
        var active = tab.getAttribute('data-static-tab') === 'ai';
        tab.classList.toggle('on', active);
        tab.setAttribute('aria-selected', String(active));
      });
      renderSourceList();
      status('请在AI生图记录中单击候选图加入左侧，再点商品页“保存草稿”或“确定编辑”');
    });
    shell.foot.append(back, confirmWrite);
  }
  // ── 视图4：确认写入（逐张 adopt，带进度与明细） ──
  function renderAiWriteView() {
    var shell = aiRunState.shell;
    shell.body.replaceChildren();
    shell.titleEl.textContent = '正在写入图片';
    var prog = wyProgress();
    shell.body.append(prog.el);
    var detailSec = wyEl('section', 'wy-section');
    var detailTitle = wyEl('h3', 'wy-section-title'); detailTitle.textContent = '写入明细';
    var detailList = wyEl('div', 'wy-detaillist');
    chosenSuccessTasks().forEach(function (task) {
      var line = detailLine(task.name + '：等待写入…');
      task.writeLine = line;
      detailList.append(line);
    });
    detailSec.append(detailTitle, detailList);
    shell.body.append(detailSec);
    clearFoot(shell);
    var waiting = wyBtn('正在写入，请稍候…', 'ghost');
    waiting.disabled = true;
    shell.foot.append(waiting);
    shell.aiWriteProgress = prog;
  }
  async function stageAiTaskLocally(task) {
    var candidate = task && task.candidate || {};
    var sourceUrl = String(candidate.url || candidate.preview || '');
    if (!sourceUrl) throw new Error('AI结果尚未形成可读取候选图，请到“AI生图记录”中采用已完成的候选');
    var response = await window.erpStorage.request(sourceUrl, { method: 'GET' });
    if (!response.ok) throw new Error('AI候选图读取失败，请稍后重试');
    var blob = await response.blob();
    if (!blob || !String(blob.type || '').startsWith('image/')) throw new Error('AI候选图格式不正确');
    var localBlobUrl = URL.createObjectURL(blob);
    if (task.writeMode === 'replace') {
      var position = linkItems.indexOf(task.item);
      if (position < 0) { URL.revokeObjectURL(localBlobUrl); throw new Error('原图已变化，请重新打开AI结果页'); }
      if (task.item.localBlobUrl) { try { URL.revokeObjectURL(task.item.localBlobUrl); } catch (ignored) { void ignored; } }
      linkItems[position] = Object.assign({}, task.item, {
        localBlob: blob,
        localBlobUrl: localBlobUrl,
        localProcessed: true,
        wmReplace: true,
        width: candidate.width || task.item.width,
        height: candidate.height || task.item.height
      });
    } else {
      if (linkItems.length >= 30) { URL.revokeObjectURL(localBlobUrl); throw new Error('这个SKU最多只能放30张图片'); }
      linkItems.push({
        url: localBlobUrl,
        localBlob: blob,
        localBlobUrl: localBlobUrl,
        localProcessed: true,
        width: candidate.width || 0,
        height: candidate.height || 0,
        extension: String(blob.type || '').toLowerCase() === 'image/png' ? '.png' : '.jpg'
      });
    }
  }
  async function runAiWrite() {
    var shell = aiRunState.shell;
    var prog = shell.aiWriteProgress;
    var tasks = chosenSuccessTasks();
    aiRunState.busy = true;
    pushHistory();
    var doneCount = 0;
    prog.set(0, tasks.length, '正在加入本地待保存列表…');
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      task.writeLine.set('run', '…', task.name + '：正在加入本地待保存列表…');
      try {
        await stageAiTaskLocally(task);
        doneCount += 1;
        task.writeLine.set('ok', '\u2713', task.name + '：已加入本地待保存列表');
        prog.set(doneCount, tasks.length, '已加入 ' + doneCount + '/' + tasks.length + ' 张');
      } catch (error) {
        var message = error && error.message ? error.message : '未知原因';
        task.writeLine.set('fail', '\u00D7', task.name + '：' + message);
        aiRunState.busy = false;
        prog.set(doneCount, tasks.length, '本地暂存中断：' + message);
        clearFoot(shell);
        var back = wyBtn('返回结果页', 'ghost');
        back.addEventListener('click', function () { renderAiResultView(); });
        shell.foot.append(back);
        return;
      }
    }
    aiRunState.busy = false;
    render();
    shell.close();
    status('AI结果已加入本地待保存列表，共 ' + tasks.length + ' 张；只有点击商品页“保存草稿”或“确定编辑”才会提交服务器');
  }

  async function adoptCandidate(item, mode) {
    return addCandidateToLeft(item, mode);
  }

  function openAiDialog(presetCapability, scope) {
    var capability = presetCapability || 'image-redraw';
    var single = Boolean(scope && Number.isInteger(scope.singleIndex) && linkItems[scope.singleIndex]);
    var indexes = single ? [scope.singleIndex] : selection().indexes.filter(function (position) { return Boolean(linkItems[position]); });
    if (!indexes.length) { status(single ? '这张图片读不到，暂时不能处理' : '请先勾选要处理的图片'); return; }
    clearRedrawSnapshot();
    aiRunState.capability = capability;
    aiRunState.direction = '';
    // 重绘固定官方通道；其它图片能力才允许恢复用户自己的密钥偏好。
    var cachedChannelPref = readAiUiPrefCache();
    aiRunState.ownConfigAvailable = Boolean(cachedChannelPref && cachedChannelPref.ownAvailable);
    aiRunState.channelUserTouched = false;
    aiRunState.channel = capability === 'image-redraw' ? 'official' : ((cachedChannelPref && cachedChannelPref.channel === 'own' && cachedChannelPref.ownAvailable) ? 'own' : 'official');
    aiRunState.busy = false;
    aiRunState.single = single;
    aiRunState.baseIndexes = indexes;
    if (capability === 'image-redraw') freezeRedrawSnapshot();
    previewPage = 0;
    if (capability === 'image-redraw') {
      selectedPreviewIndexes = new Set([0]);
      previewMaxSelect = 1;
    } else {
      selectedPreviewIndexes = new Set(single ? [0] : indexes.map(function (_, at) { return at; }));
      previewMaxSelect = single ? 1 : 30;
    }
    aiRunState.templateOptions = [];
    aiRunState.templatesLoading = capability === 'image-redraw';
    aiRunState.templatesError = '';
    // sku32规则2：重绘弹窗主图默认选中（数量恒1）；每次打开数量重置为默认
    aiRunState.templateCounts = {};
    var cachedSellingPoints = capability === 'image-redraw' ? readSellPointCache() : null;
    var bridge = window.WYERP_PRODUCT_SELLING_POINTS;
    var pair = capability === 'image-redraw' && bridge && bridge.get ? bridge.get(aiRunState.redrawSnapshot && aiRunState.redrawSnapshot.target) : null;
    var existingR5 = pair && typeof pair.zh === 'string' && pair.zh.trim() && typeof pair.ru === 'string' && pair.ru.trim() ? '中文：\n' + pair.zh.trim() + '\n\n俄文：\n' + pair.ru.trim() : '';
    aiRunState.sellingPoints = cachedSellingPoints ? cachedSellingPoints.text : existingR5;
    aiRunState.sellingPointsBilingual = cachedSellingPoints ? (completeSellPointPair(cachedSellingPoints.sellingPointsBilingual) ? cachedSellingPoints.sellingPointsBilingual : null) : (completeSellPointPair(pair) ? pair : null);
    aiRunState.initialSellingPoints = aiRunState.sellingPoints;
    aiRunState.sellingPointsSource = cachedSellingPoints ? (cachedSellingPoints.source || '') : 'r5';
    aiRunState.sellingPointRevision = 0;
    aiRunState.sellingPointAttemptId = '';
    aiRunState.imageTextLanguage = 'ru';
    invalidateRedrawProof();
    aiRunState.queuedTaskIds = [];
    aiRunState.queuedBatchTaskId = '';
    aiRunState.selectedTemplates = capability === 'image-redraw' ? ['image-main'] : [];
    buildAiTasks();
    aiRunState.beanWallet = freshBeanWallet();
    aiRunState.balanceLine = null;
    aiRunState.feeLine = null;
    aiRunState.shell = wyShell({ id: AI_DIALOG_ID, size: 'lg', title: aiDialogTitle(capability) });
    aiRunState.contentReview = null;
    if (capability === 'image-redraw') aiRunState.contentReview = createSellPointReview(aiRunState.shell, cachedSellingPoints, pair);
    aiRunState.shell.dialog.addEventListener('close', function () { stopSellPointAttemptRecovery(); clearRedrawSnapshot(); });
    renderAiConfigView();
    aiRunState.shell.open();
    // 渲染发生在 open() 之前，此时节点才挂到 DOM，补一次费用/余额行刷新
    refreshFeeLine();
    refreshBeanBalanceLine();
    loadAiBeanBalance(); // 异步拉取，到达后原地更新余额行
    loadAiPromptTemplates(); // 异步拉取 AI 配置里的图片模板，到达后原地重渲染配置页
    if (capability !== 'image-redraw') loadAiChannelPreference(); // 重绘不读取或依赖用户自有配置
  }

  function selectAllBox() { return document.querySelector('#skuImageEditor .sku-check input[type="checkbox"]'); }
  function selectAllLabel() { var box = selectAllBox(); return box ? box.closest('label') : null; }
  function syncSelectAllLabel() {
    var box = selectAllBox(), label = selectAllLabel();
    if (!box || !label) return;
    var boxes = Array.prototype.slice.call(document.querySelectorAll('#skuImageGrid input[type="checkbox"]'));
    var all = boxes.length > 0 && boxes.every(function (item) { return item.checked; });
    box.checked = all;
    Array.prototype.forEach.call(label.childNodes, function (node) {
      if (node.nodeType === 3) node.nodeValue = all ? ' 取消全选' : ' 全选';
    });
  }
  function bindSelectAll() {
    var box = selectAllBox();
    if (!box || box.dataset.enhBound) return;
    box.dataset.enhBound = '1';
    box.addEventListener('click', function (event) { event.stopPropagation(); });
    box.addEventListener('change', function () {
      var boxes = Array.prototype.slice.call(document.querySelectorAll('#skuImageGrid input[type="checkbox"]'));
      boxes.forEach(function (item) { if (item.checked !== box.checked) item.click(); });
      syncSelectAllLabel();
    });
  }
  // ── 桌面端跟随指针的悬停放大镜（.sku-hover-lens 样式已在验收版 CSS 中，这里只补行为，不加界面元素） ──
  // 触屏与窄屏不启用；放大镜元素挂在编辑器对话框内部，保证不被顶层对话框遮挡。
  var LENS_SIZE = 220, LENS_ZOOM = 3;
  function hoverLens() {
    var editor = $('skuImageEditor');
    if (!editor) return null;
    var lens = editor.querySelector(':scope > .sku-hover-lens');
    if (!lens) {
      lens = document.createElement('div');
      lens.className = 'sku-hover-lens';
      lens.hidden = true;
      lens.setAttribute('aria-hidden', 'true');
      editor.append(lens);
    }
    return lens;
  }
  function bindHoverLensDisabled() {
    var grid = $('skuImageGrid');
    if (!grid || grid.dataset.lensBound) return;
    grid.dataset.lensBound = '1';
    function enabled(event) {
      if (event.pointerType === 'touch' || event.pointerType === 'pen') return false;
      return window.innerWidth > 900;
    }
    grid.addEventListener('pointermove', function (event) {
      var lens = hoverLens();
      if (!lens) return;
      var preview = event.target && event.target.closest ? event.target.closest('.sku-image-preview') : null;
      if (!preview || !enabled(event)) { lens.hidden = true; return; }
      var background = getComputedStyle(preview).backgroundImage;
      if (!background || background === 'none') { lens.hidden = true; return; }
      var rect = preview.getBoundingClientRect();
      var ratioX = Math.min(1, Math.max(0, (event.clientX - rect.left) / (rect.width || 1)));
      var ratioY = Math.min(1, Math.max(0, (event.clientY - rect.top) / (rect.height || 1)));
      var bgWidth = rect.width * LENS_ZOOM, bgHeight = rect.height * LENS_ZOOM;
      lens.hidden = false;
      lens.style.backgroundImage = background;
      lens.style.backgroundSize = bgWidth + 'px ' + bgHeight + 'px';
      lens.style.backgroundPosition = (-(ratioX * bgWidth) + LENS_SIZE / 2) + 'px ' + (-(ratioY * bgHeight) + LENS_SIZE / 2) + 'px';
      lens.style.left = (event.clientX - LENS_SIZE / 2) + 'px';
      lens.style.top = (event.clientY - LENS_SIZE / 2) + 'px';
    }, true);
    grid.addEventListener('pointerleave', function () {
      var lens = hoverLens();
      if (lens) lens.hidden = true;
    });
    var dialog = $('skuImageEditor');
    if (dialog) dialog.addEventListener('close', function () { var lens = hoverLens(); if (lens) lens.hidden = true; });
  }

  // ── 新增商品：本地自动暂存（只存这台浏览器的 localStorage，绝不上传服务器） ──
  // 规则：只保存最近 3 天的暂存，超过 3 天自动清理；只在 mode=create 且带 draftId 时工作；
  // 恢复时只填空着的输入框，不覆盖你已经在打的内容；不调用 erpStorage.set / request，不产生任何服务器写入。
  var LOCAL_DRAFT_KEY = 'wyerp_create_draft_local_v1';
  var LOCAL_DRAFT_TTL_MS = 3 * 24 * 60 * 60 * 1000;
  var LOCAL_DRAFT_KEEP = 50;
  var localDraftTimer = null, localDraftLast = '', localDraftWhy = 'init';
  function localDraftId() { return String(params.get('draftId') || ''); }
  function localDraftsRead() {
    try {
      var raw = window.localStorage.getItem(LOCAL_DRAFT_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (error) { return {}; }
  }
  function localDraftsWrite(buckets) {
    try { window.localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(buckets)); return true; } catch (error) { return false; }
  }
  function localDraftPurge(buckets, now, limit) {
    var alive = Object.keys(buckets)
      .map(function (id) { return buckets[id]; })
      .filter(function (entry) {
        var savedAt = Date.parse((entry && entry.savedAt) || '') || 0;
        return savedAt && now - savedAt <= LOCAL_DRAFT_TTL_MS;
      })
      .sort(function (left, right) { return (Date.parse(right.savedAt) || 0) - (Date.parse(left.savedAt) || 0); })
      .slice(0, Number(limit) > 0 ? Number(limit) : LOCAL_DRAFT_KEEP);
    var kept = {};
    alive.forEach(function (entry) { kept[String(entry.draftId)] = entry; });
    return kept;
  }
  function localDraftFields() {
    var out = {};
    Array.prototype.forEach.call(document.querySelectorAll('#variantBody tr'), function (row, rowIndex) {
      Array.prototype.forEach.call(row.querySelectorAll('[data-field]'), function (field) {
        var name = field.getAttribute('data-field');
        if (!name) return;
        var value = field.type === 'checkbox' ? (field.checked ? '1' : '') : String(field.value == null ? '' : field.value);
        if (value) out['v' + rowIndex + '.' + name] = value.slice(0, 4000);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-field]'), function (field) {
      if (field.closest && field.closest('#variantBody')) return;
      var name = field.getAttribute('data-field');
      if (!name) return;
      var value = field.type === 'checkbox' ? (field.checked ? '1' : '') : String(field.value == null ? '' : field.value);
      if (value) out['page.' + name] = value.slice(0, 4000);
    });
    return out;
  }
  function localDraftSnapshot() {
    if (params.get('mode') !== 'create') { localDraftWhy = 'not-create'; return; }
    var id = localDraftId();
    if (!/^draft_[\w-]+$/.test(id)) { localDraftWhy = 'bad-id:' + id; return; }
    var fields = localDraftFields();
    var signature = JSON.stringify(fields);
    if (!Object.keys(fields).length) { localDraftWhy = 'no-fields'; return; }
    if (signature === localDraftLast) { localDraftWhy = 'unchanged'; return; }
    var now = Date.now();
    var buckets = localDraftPurge(localDraftsRead(), now, LOCAL_DRAFT_KEEP - 1);
    buckets[id] = { draftId: id, savedAt: new Date(now).toISOString(), fields: fields };
    localDraftWhy = localDraftsWrite(buckets) ? (localDraftLast = signature, 'written') : 'write-failed';
  }
  function localDraftRestore() {
    if (params.get('mode') !== 'create') return 0;
    var id = localDraftId();
    if (!/^draft_[\w-]+$/.test(id)) return 0;
    var now = Date.now();
    var buckets = localDraftsRead();
    var purged = localDraftPurge(buckets, now);
    if (Object.keys(purged).length !== Object.keys(buckets).length) localDraftsWrite(purged);
    var entry = purged[id];
    if (!entry || !entry.fields) return 0;
    var rows = Array.prototype.slice.call(document.querySelectorAll('#variantBody tr'));
    var filled = 0;
    Object.keys(entry.fields).forEach(function (key) {
      var value = entry.fields[key];
      if (key.indexOf('page.') === 0) {
        var pageField = document.querySelector('[data-field="' + key.slice(5).replace(/["\\]/g, '') + '"]');
        if (pageField && !(pageField.closest && pageField.closest('#variantBody')) && !String(pageField.value || '').trim()) {
          pageField.value = value;
          pageField.dispatchEvent(new Event('input', { bubbles: true }));
          filled += 1;
        }
        return;
      }
      var dot = key.indexOf('.');
      var rowIndex = Number(key.slice(1, dot));
      var name = key.slice(dot + 1);
      var row = rows[rowIndex];
      if (!row) return;
      var field = row.querySelector('[data-field="' + name.replace(/["\\]/g, '') + '"]');
      if (!field || String(field.value || '').trim()) return;
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      filled += 1;
    });
    return filled;
  }
  function startLocalDraft() {
    if (params.get('mode') !== 'create') return;
    if (localDraftTimer) return;
    localDraftRestore();
    localDraftTimer = window.setInterval(localDraftSnapshot, 15000);
    window.addEventListener('pagehide', localDraftSnapshot);
    document.addEventListener('change', localDraftSnapshot, true);
  }

  function installMenus() {
    var editor = $('skuImageEditor');
    if (!editor || editor.dataset.enhMenus) return;
    editor.dataset.enhMenus = '1';
    Object.keys(MENU_SPECS).forEach(function (kind) {
      var menu = document.createElement('div');
      menu.className = 'sku-pop-menu';
      menu.hidden = true;
      menu.dataset.menu = kind;
      MENU_SPECS[kind].forEach(function (item) {
        if (!item[1]) { menu.appendChild(document.createElement('hr')); return; }
        var button = document.createElement('button');
        button.type = 'button';
        var icon = document.createElement('i');
        icon.className = item[2] || '';
        icon.textContent = item[0];
        var label = document.createElement('span');
        label.textContent = item[1];
        button.append(icon, label);
        button.addEventListener('click', function (event) { event.stopPropagation(); closeMenus(); var label = item[1].replace('　›', ''); if (label === '下载' && kind === 'edit') { downloadAt(editAnchorIndex); return; } action(label, kind === 'edit' ? { singleIndex: editAnchorIndex } : null)(); });
        menu.append(button);
      });
      editor.append(menu);
      menus[kind] = menu;
    });
    editor.addEventListener('click', function (event) {
      if (!event.target || typeof event.target.closest !== 'function') return;
      var tool = event.target.closest('[data-static-tool]');
      if (tool) {
        event.stopPropagation();
        var owner = tool.closest('.sku-image-card');
        editAnchorIndex = owner ? Array.prototype.indexOf.call($('skuImageGrid').children, owner) : -1;
        showMenu('edit', tool);
        return;
      }
      var batch = event.target.closest('#skuImageSelectAll');
      if (batch) { event.stopPropagation(); showMenu('batch', batch); return; }
      var source = event.target.closest('.sku-image-source-head>.btn');
      if (source) { event.stopPropagation(); showMenu('source', source); return; }
      if (!event.target.closest('.sku-pop-menu')) closeMenus();
    });
    var hooks = { skuImageUndo: undo, skuImageRedo: redo, skuImageDelete: deleteSelected, skuImageSetCover: setCover, skuImageDownload: downloadSelected, skuImageZoom: function () { zoom(0); }, skuImageRestore: function () { status('恢复原图需服务器处理通道，正在接入'); } };
    Object.keys(hooks).forEach(function (id) { var hook = $(id); if (hook) hook.addEventListener('click', function (event) { event.stopPropagation(); hooks[id](); }); });
    var input = $('skuImageUploadInput'), upload = $('skuImageUploadButton');
    if (upload && input) upload.addEventListener('click', function () { input.click(); });
    if (input) input.addEventListener('change', function () { var files = Array.prototype.slice.call(this.files); this.value = ''; uploadFiles(files); });
    bindProcessHooks();
    bindSourceTabs();
    bindSelectAll();
    var confirm = $('skuImageConfirm');
    if (confirm) confirm.addEventListener('click', function () {
      var changed = hasPendingImageChanges(), applied = applyCurrentImagesToPage();
      var editor = $('skuImageEditor');
      if (editor && editor.open) editor.close();
      status(changed
        ? '已把 ' + applied + ' 张图片更新到当前SKU表格；尚未提交服务器，请点击商品页“保存草稿”或“确定编辑”统一保存'
        : '图片列表没有新的待保存变更');
    });
  }

  async function open(index) {
    var row = rowAt(index);
    if (!row) { status('没找到这个SKU'); return; }
    openedIndex = Number(index);
    linkItems = []; removedIds = []; history.length = 0; future.length = 0;
    savedOrderIds = '';
    pendingCopies = [];
    imageSource = '';
    render();
    var editor = $('skuImageEditor');
    installMenus();
    if (editor && !editor.open) editor.showModal();
    renderSourceList();
    status('正在读取该SKU已转存的图片…');
    var fromServer = false;
    try { fromServer = await loadFromServer(row); } catch (error) { imageSource = '服务端关联读取失败（' + (error && error.message ? error.message : '未知') + '）'; }
    var serverCount = linkItems.length;
    var snapshot = platformSnapshotFor(row);
    if (snapshot.length) {
      linkItems = mergePlatformSnapshot(linkItems, snapshot);
      var pendingCount = linkItems.filter(function (item) { return item.platformSnapshot; }).length;
      imageSource = '已转存 ' + serverCount + ' 张；平台快照 ' + snapshot.length + ' 张' + (pendingCount ? '（其中 ' + pendingCount + ' 张仅查看，未确认不会写入服务器）' : '');
    } else if (!fromServer) {
      fillFromRow(row);
    }
    savedOrderIds = currentImageOrderSignature();
    render();
    status('SKU：' + (fieldValue(row, 'name') || fieldValue(row, 'offerId') || ('第 ' + (Number(index) + 1) + ' 个SKU')) + ' · 共 ' + linkItems.length + ' 张（来源：' + imageSource + '）');
  }

  function bind() {
    document.addEventListener('click', function (event) {
      if (!event.target || typeof event.target.closest !== 'function') return;
      var media = event.target.closest('.variant-media-grid, .variant-col-images');
      if (!media) return;
      var row = media.closest('tr[data-index]');
      if (!row) return;
      event.preventDefault();
      event.stopPropagation();
      open(row.dataset.index);
    }, true);
    Array.prototype.forEach.call(document.querySelectorAll('[data-close-sku-image-editor]'), function (button) {
      button.addEventListener('click', function () {
        var editor = $('skuImageEditor');
        if (editor && editor.open) editor.close();
        status('已关闭SKU图片编辑，未确认的改动不会写回商品');
      });
    });
  }
  // 供本机自检读取（只读接口，不参与业务逻辑）
  window.WYERP_SKU_CREATE_LOCAL_DRAFT = {
    read: localDraftsRead,
    write: localDraftsWrite,
    snapshot: localDraftSnapshot,
    restore: localDraftRestore,
    key: LOCAL_DRAFT_KEY,
    ttl: LOCAL_DRAFT_TTL_MS,
    keep: LOCAL_DRAFT_KEEP,
    diag: function () {
      var probe = (function () {
        try { window.localStorage.setItem('__wyerp_probe', '1'); window.localStorage.removeItem('__wyerp_probe'); return '可用'; } catch (error) { return '不可用: ' + error.message; }
      })();
      return { mode: params.get('mode'), draftId: localDraftId(), started: Boolean(localDraftTimer), fields: localDraftFields(), localStorage: probe, why: localDraftWhy, lastLen: String(localDraftLast).length, 直读: (function () { try { return window.localStorage.getItem(LOCAL_DRAFT_KEY); } catch (error) { return null; } })() };
    }
  };
  // 本地自动暂存与图片编辑器无关：页面加载即启动（只写这台浏览器的 localStorage，绝不上传服务器）
  function boot() { bind(); startLocalDraft(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
