(function () {
  'use strict';
  var PRODUCT_KEY = 'erp_online_products', DRAFT_KEY = 'erp_product_drafts', SHOP_KEY = 'erp_shops_data', COLLECTION_KEY = 'erp_collected_products';
  var SERVER_CREATE_DRAFT_LIMIT = 50;
  var params = new URLSearchParams(location.search), navRef = window.WYERP_NAV_REF, navTarget = navRef ? navRef.fromSearch(location.search) : null;
  if (navTarget && navTarget.kind === 'product-detail') {
    ['productId','sku','shop','clientId'].forEach(function (key) { if (navTarget[key]) params.set(key, String(navTarget[key])); });
  } else if (navRef && (params.get('sku') || params.get('shop') || params.get('clientId'))) {
    var legacyTarget = { kind: 'product-detail', productId: String(params.get('productId') || ''), sku: String(params.get('sku') || ''), shop: String(params.get('shop') || ''), clientId: String(params.get('clientId') || '') };
    var safeExtra = {}; ['mode','load','focus','workspace','skuStatic','case'].forEach(function (key) { if (params.get(key)) safeExtra[key] = params.get(key); });
    var safeRoute = navRef.href(location.pathname, legacyTarget, safeExtra); if (safeRoute) history.replaceState(null, '', safeRoute);
  }
  var relistMode = params.get('mode') === 'relist';
  var createMode = params.get('mode') === 'create' || relistMode;
  if (params.get('skuStatic') === '1') {
    document.body.classList.add('sku-static-preview');
    var staticEditor = document.getElementById('skuImageEditor');
    var staticStatus = document.getElementById('skuImageState');
    var staticDrawer = document.getElementById('skuImageToolDrawer');
    var menuSpecs = {
      edit: [['⛓','多语言翻译','violet'],['⛓','AI重绘','blue'],['✣','美图美化','pink'],['♧','易可图','green'],['✥','AI编辑　›','blue'],['—',''],['▧','设为封面'],['▣','添加水印'],['⊕','添加到其它变体'],['⇩','下载']],
      batch: [['▣','添加水印'],['⛓','象寄批量翻译','violet'],['⛓','批量AI重绘','blue'],['♧','易可图·批量编辑','green'],['✥','批量AI编辑　›'],['⊕','添加到其它变体'],['⤨','图片打乱　›'],['⇩','下载'],['♙','删除']],
      source: [['⇩','下载']]
    };
    function buildStaticMenu(kind) { var menu = document.createElement('div'); menu.className = 'sku-pop-menu'; menu.hidden = true; menu.dataset.menu = kind; menuSpecs[kind].forEach(function (item) { if (!item[1]) { menu.appendChild(document.createElement('hr')); return; } var button = document.createElement('button'); button.type = 'button'; button.innerHTML = '<i class="' + (item[2] || '') + '">' + item[0] + '</i><span>' + item[1] + '</span>'; button.addEventListener('click', function () { setStaticStatus('“' + item[1].replace('　›','') + '”为静态入口，本阶段不会执行功能'); }); menu.appendChild(button); }); staticEditor.appendChild(menu); return menu; }
    var editMenu = buildStaticMenu('edit'), batchMenu = buildStaticMenu('batch'), sourceMenu = buildStaticMenu('source');
    document.querySelectorAll('.sku-image-card').forEach(function (card, index) { if (card.querySelector('.sku-image-card-foot')) return; var foot = document.createElement('div'), checkbox = document.createElement('input'), edit = document.createElement('button'); foot.className = 'sku-image-card-foot'; checkbox.type = 'checkbox'; checkbox.checked = true; checkbox.setAttribute('aria-label', '选择图片' + (index + 1)); edit.type = 'button'; edit.dataset.staticTool = '编辑图片' + (index + 1); edit.setAttribute('aria-expanded', 'false'); edit.textContent = '编辑⌄'; foot.append(checkbox, edit); card.appendChild(foot); });
    var sourceList = document.getElementById('skuImageCollectionList'), sourceSample = sourceList.querySelector('.sku-source-placeholder');
    for (var sourceIndex = 2; sourceIndex <= 8; sourceIndex++) { var sourceCard = sourceSample.cloneNode(true), sourceImage = sourceCard.querySelector('.synthetic-image'), sourceCheck = sourceCard.querySelector('input'), sourceEdit = sourceCard.querySelector('[data-static-tool]'); sourceImage.className = 'synthetic-image synthetic-' + ['b','c','d','e'][(sourceIndex - 1) % 4]; sourceCheck.setAttribute('aria-label', '选择右侧占位图片' + sourceIndex); sourceEdit.dataset.staticTool = '编辑右侧占位图片' + sourceIndex; sourceCard.querySelector('.sku-image-dimension').textContent = sourceIndex === 2 ? '1600×1600' : '1792×2400'; sourceList.insertBefore(sourceCard, document.getElementById('skuImageRetry')); }
    document.querySelectorAll('.sku-card-icons').forEach(function (icons) { icons.textContent = '⌕　🗑'; icons.setAttribute('aria-label', '放大，删除'); });
    var pagination = document.createElement('nav'); pagination.className = 'sku-source-pagination'; pagination.setAttribute('aria-label', '图片分页'); pagination.innerHTML = '<button type="button" disabled>‹</button><button type="button" class="on">1</button><button type="button">2</button><button type="button">3</button><button type="button">4</button><button type="button">›</button>'; sourceList.after(pagination);
    var networkPanel = document.createElement('section'); networkPanel.className = 'sku-network-panel'; networkPanel.hidden = true; networkPanel.innerHTML = '<textarea aria-label="网络图片链接" placeholder="请输入图片链接，每行一个（仅支持 JPG、PNG 格式）：\nhttps://example.com/image1.jpg\nhttps://example.com/image2.png\n\n• 请确保图片链接可以正常访问\n• 建议图片大小不超过 5MB\n• 自动过滤重复和无效链接"></textarea><button class="btn" type="button" disabled>⊕&nbsp; 添加图片</button>'; pagination.after(networkPanel);
    function setStaticStatus(message) { staticStatus.textContent = message; }
    function closeStaticDrawer() { staticDrawer.hidden = true; document.querySelectorAll('.sku-pop-menu').forEach(function (menu) { menu.hidden = true; }); document.querySelectorAll('[data-static-tool]').forEach(function (button) { button.setAttribute('aria-expanded', 'false'); }); }
    function showStaticMenu(menu, button) { closeStaticDrawer(); var editorRect = staticEditor.getBoundingClientRect(), buttonRect = button.getBoundingClientRect(); menu.hidden = false; menu.style.left = Math.min(staticEditor.clientWidth - menu.offsetWidth - 12, Math.max(12, buttonRect.left - editorRect.left)) + 'px'; menu.style.top = Math.min(staticEditor.clientHeight - menu.offsetHeight - 12, buttonRect.bottom - editorRect.top + 4) + 'px'; }
    document.querySelectorAll('[data-close-sku-image-editor]').forEach(function (button) { button.addEventListener('click', function () { setStaticStatus('静态预览不会保存或发布任何数据'); }); });
    document.querySelectorAll('[data-static-tool]').forEach(function (button) { button.addEventListener('click', function (event) { event.stopPropagation(); showStaticMenu(editMenu, button); button.setAttribute('aria-expanded', 'true'); }); });
    document.getElementById('skuImageSelectAll').addEventListener('click', function (event) { event.stopPropagation(); showStaticMenu(batchMenu, this); });
    document.querySelector('.sku-image-source-head>.btn').addEventListener('click', function (event) { event.stopPropagation(); showStaticMenu(sourceMenu, this); });
    document.addEventListener('click', function (event) { if (!event.target.closest('.sku-pop-menu')) closeStaticDrawer(); });
    document.querySelectorAll('[data-static-tab]').forEach(function (button) { button.addEventListener('click', function () { document.querySelectorAll('[data-static-tab]').forEach(function (tab) { var active = tab === button; tab.classList.toggle('on', active); tab.setAttribute('aria-selected', String(active)); }); var network = button.dataset.staticTab === 'web'; sourceList.hidden = network; pagination.hidden = network; networkPanel.hidden = !network; document.querySelector('.sku-source-select').hidden = network; setStaticStatus(network ? '网络图片链接仅作静态录入展示，不会读取或上传' : '已切换图片来源静态展示'); }); });
    document.querySelectorAll('.sku-image-card').forEach(function (card) { card.addEventListener('click', function () { card.classList.toggle('is-selected'); var checkbox = card.querySelector('input'); if (checkbox) checkbox.checked = card.classList.contains('is-selected'); }); });
    document.getElementById('skuImageRetry').addEventListener('click', function () { setStaticStatus('本地静态资源仍不可用，请稍后重试'); });
    document.getElementById('skuImageConfirm').addEventListener('click', function () { setStaticStatus('静态页面未接入保存，未发送任何数据'); });
    document.getElementById('skuImageExpand').addEventListener('click', function () { staticEditor.classList.toggle('is-expanded'); setStaticStatus(staticEditor.classList.contains('is-expanded') ? '已铺满主工作区' : '已恢复安全边距'); });
    staticEditor.showModal();
    return;
  }
  var workspaceEmbedded = window.parent !== window && params.get('workspace') === '1';
  var product = null, shops = [], catalog = [], attributes = [], variants = [];
  var ozonProductLink = window.WYERP_OZON_PRODUCT_LINK;
  var membershipQuotaApi = window.WYERP_MEMBERSHIP_QUOTA;
  if (!ozonProductLink) throw new Error('Ozon商品链接模块加载失败');
  var originalContentSource = null, allowManualOriginalTitle = false, sellingPointsBilingual = null, richContentBilingual = null, richDraftEdited = false, packageDimensionSources = {}, packageDimensionValues = {}, contentReview = null, relistSource = null;
  window.WYERP_PRODUCT_SELLING_POINTS = { get: function (target) {
    var value = sellingPointsBilingual;
    if (!value || !Array.isArray(value.variantRefs) || !target || value.shop !== String(target.clientId) || value.productId !== String(target.productId) || value.variantRefs.indexOf(String(target.variantRef)) < 0) return null;
    var review = contentReview && contentReview.state().fields.sellingPoints, local = contentReview && contentReview.local();
    return { zh: value.zh, ru: value.ru, reviewData: review ? {checks:{sellingPoints:review}, reviewSource:local.sources.sellingPoints} : null };
  }, getEvidence: function (target) {
    if (!target || String(target.clientId) !== val('shop') || String(target.productId) !== (createMode ? createDraftId : pid(product)) || !variants.some(function (variant) { return String(variant.offerId || variant.article || variant.sku || '') === String(target.variantRef); })) return null;
    var identity = {}, model = attributes.find(isModelNameAttribute);
    if (aiBrandValue()) identity.brand = aiBrandValue();
    if (model && String(attributeFields.text(model) || '').trim()) identity.model = String(attributeFields.text(model)).trim();
    return JSON.parse(JSON.stringify({ compatibilityEvidence: aiCompatibilityEvidence(), identityFacts: identity, packageDimensionsMm: {length:val('length'),width:val('width'),height:val('height')}, packageDimensionSources:Object.assign({}, packageDimensionSources) }));
  } };
  var editRevision = '', editKey = '', createKey = '', createState = null, editBusy = false, draftRestored = false;
  var requestedCreateDraftId = /^draft_[\w-]+$/.test(String(params.get('draftId') || '')) ? String(params.get('draftId')) : '';
  var createDraftId = requestedCreateDraftId || 'draft_' + (window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).slice(2));
  var draftFields = ['title','brand','weight','length','width','height','barcode','hashtags','description','richContent','sourceUrl','sourcePrice','sourceNote'];
  var moreAttributesOpen = false, brandHasValue = false, categoryEdited = false, attributeRequest = 0, requestedCategory = '';
  var lockedCategory = null, pendingCreateCategory = null, hashtagsEdited = false, hashtagsControl = null;
  var collectionSourceId = createMode ? String(params.get('collectionId') || '') : '', collectionCategoryWriteKey = '';
  var fullInfoMode = params.get('load') === 'full', fullInfoLoading = false, fullInfoDirty = Object.create(null), variantStructureEdited = false, workspaceDraftSafe = false;
  var detailData = window.WYERP_PRODUCT_DETAIL_DATA, collectionModel = window.WYERP_PRODUCT_COLLECTION, combinationModel = window.WYERP_PRODUCT_COMBINATION, relistModel = window.WYERP_PRODUCT_RELIST, productScope = '';
  if (relistMode && !relistModel) throw new Error('下架重上复制模块加载失败');
  var attributeFields = window.WYERP_PRODUCT_ATTRIBUTE_FIELDS, sharedDirty = Object.create(null), sharedHydrated = Object.create(null);
  var variantAutoWarnings = Object.create(null), variantAutoRecognitionBusy = false;
  var manualVariantAttributeKeys = new Set(), suppressedVariantAttributeKeys = new Set();
  var promotionState = {schemaVersion: 1, attributes: {}}, richContentEditorTarget = null;
  var sourceBundles = [], combinationRelations = [], combinationHistory = [], collectionSourceRecord = null, sourceImagePickerIndex = -1;
  var combinationPickerState = { variantIndex: -1, records: [], selected: new Set(), globalRelations: [], globalAliases: [], query: '' }, expandedCombinationParents = new Set(), expandedCombinationNodes = new Set(), combinationContextLoaded = false, combinationContextPromise = null, combinationReferenceBundleId = '', combinationReferenceMode = 'bundle', combinationReferenceVariantSkuId = '', combinationReferenceVariantRowKey = '', combinationVariantBundleId = '', legacyCombinationPending = false;
  var attributeOptions = window.WYERP_PRODUCT_ATTRIBUTE_OPTIONS, optionControls = [], categoryCache = window.WYERP_PRODUCT_CATEGORY_CACHE;
  var draftCache = window.WYERP_PRODUCT_DRAFT_CACHE;
  var categoryVersion = '', optionCategory = '', shopSelect = null, categorySelect = null, productShops = window.WYERP_PRODUCT_SHOPS;
  var optionMappingTranslator = window.WYERP_PRODUCT_TRANSLATOR && window.WYERP_PRODUCT_TRANSLATOR.create ? window.WYERP_PRODUCT_TRANSLATOR.create() : window.WYERP_PRODUCT_TRANSLATOR;
  var optionLocalizer = window.WYERP_PRODUCT_OPTION_LABELS.createLocalizer({ cache: categoryCache, translator: optionMappingTranslator });
  function markWorkspaceDirty() { workspaceDraftSafe = false; }
  function hasWorkspacePendingChanges() {
    var imagePending = Boolean(window.wyerpSkuImage && typeof window.wyerpSkuImage.hasPending === 'function' && window.wyerpSkuImage.hasPending());
    var formPending = richDraftEdited || Object.keys(fullInfoDirty).length > 0 || Object.keys(sharedDirty).length > 0 || hashtagsEdited || variantStructureEdited;
    return Boolean(editBusy || fullInfoLoading || imagePending || (formPending && !workspaceDraftSafe));
  }
  window.WYERP_WORKSPACE_DIRTY = { hasPending: hasWorkspacePendingChanges };  var fieldTranslator = window.WYERP_PRODUCT_TRANSLATOR && window.WYERP_PRODUCT_TRANSLATOR.create ? window.WYERP_PRODUCT_TRANSLATOR.create() : window.WYERP_PRODUCT_TRANSLATOR; var translationControls = window.WYERP_PRODUCT_TRANSLATION_CONTROLS.create({ translator: fieldTranslator, context: contentContext, pairContext: function () { return optionScope() + ":" + val("shop") + ":" + val("descriptionCategoryId") + ":" + val("typeId"); }, identityFacts: function () {
    var model = attributes.find(isModelNameAttribute), identity = {};
    if (aiBrandValue()) identity.brand = aiBrandValue();
    if (model && String(attributeFields.text(model) || '').trim()) identity.model = String(attributeFields.text(model)).trim();
    return Object.keys(identity).length ? identity : undefined;
  }, compatibilityEvidence: aiCompatibilityEvidence, reviewWarnings: function (field) { return contentReview ? contentReview.chineseMessages(field) : []; }, onReview: function (field, data) { if (contentReview) contentReview.adopt(field, data); }, diagnosticRequest: requestJson });
  function isPackageDimensionAttribute(attribute) {
    var binding = attributeFields.classify(attribute);
    return Boolean(binding && (binding.area === 'dimensions' || binding.area === 'field' && ['length','width','height'].indexOf(binding.key) >= 0));
  }
  function aiSourceAttributes(items) {
    var result = {};
    arr(items).forEach(function (attribute) {
      if (isPackageDimensionAttribute(attribute)) return;
      if (['4180', '4191', '23171', '11254'].indexOf(String(attribute.id || attribute.attribute_id || '')) >= 0) return;
      var name = String(attribute.name || attribute.nameRu || attribute.nameEn || attribute.attribute_name || '').trim();
      var value = String(attributeFields.text(attribute) || '').trim();
      if (name) result[name] = value;
    });
    return result;
  }
  function aiCompatibilityEvidence() {
    collectAttributes();
    var current = aiSourceAttributes(attributes);
    return { title: originalContentSource ? originalContentSource.title : '', attributes: Object.assign({}, originalContentSource && originalContentSource.attributes || {}, current) };
  }
  function contentContext() { return optionScope() + ':' + val('shop') + ':' + val('descriptionCategoryId') + ':' + val('typeId') + ':' + attributeRequest; }
  var optionLoader = attributeOptions.createLoader(function (endpoint, body, context) {
    return requestJson('/api/integrations/ozon/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: context.shop, command: erpStorage.ozonCommandForEndpoint(endpoint).name, body: body }) }).catch(function (error) {
      var message = String(error.message || '');
      if (/unauthorized|401/i.test(message)) throw new Error('登录已失效，请重新登录后读取选项');
      if (/permission|scope|403/i.test(message)) throw new Error('当前账号或店铺无权读取选项');
      if (/credentials|api.?key/i.test(message)) throw new Error('店铺接口凭据不可用，请检查店铺配置');
      if (/429|rate.?limit/i.test(message)) throw new Error('选项请求较多，请稍后点击重试');
      if (/timeout|abort|fetch|network/i.test(message)) throw new Error('读取平台选项超时或网络异常，请重试');
      throw error;
    });
  }, { cache: categoryCache });
  var $ = function (id) { return document.getElementById(id); }, arr = function (v) { return Array.isArray(v) ? v : []; };
  var val = function (id) { return String($(id).value || '').trim(); }, num = function (id) { var n = Number(val(id)); return Number.isFinite(n) ? n : 0; };
  function recentServerDrafts(items) {
    return arr(items).slice().sort(function (left, right) {
      return (Date.parse(right && (right.updatedAt || right.savedAt) || '') || 0) - (Date.parse(left && (left.updatedAt || left.savedAt) || '') || 0);
    }).slice(0, SERVER_CREATE_DRAFT_LIMIT);
  }
  var esc = function (text) { return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  function requestJson(url, options) { return erpStorage.request(url, options).then(function (response) { return response.json().catch(function () { return {}; }).then(function (data) {
    if (!response.ok) {
      var message = data.message || '商品信息读取失败，请稍后重试。';
      if (data.error === 'ozon_request_failed') {
        message = response.status === 429 ? 'Ozon 请求过于频繁，请稍后重试' : response.status === 401 || response.status === 403 ? 'Ozon 拒绝访问，请检查店铺接口凭据与权限' : data.message || '服务器未能完成 Ozon 请求，请重试或检查服务日志';
      }
      var error = new Error(message + '（HTTP ' + response.status + '）'); error.status = response.status; error.code = data.error; error.diagnosticId = data.diagnosticId; error.diagnosticIds = data.diagnosticIds; error.serverMessage = typeof data.message === 'string' ? data.message : ''; throw error;
    }
    return data;
  }); }); }
  var optionMapQueue = [], optionMapTimer = null;
  function showOptionMapDiagnostics(data, context) {
    if (context !== contentContext() || !window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS) return;
    var ids = Array.isArray(data.diagnosticIds) ? data.diagnosticIds : data.diagnosticId ? [data.diagnosticId] : [];
    var container = $('attributeLoadStatus');
    ids.forEach(function (id) {
      if (Array.from(container.querySelectorAll('[data-option-diagnostic-id]')).some(function (row) { return row.dataset.optionDiagnosticId === id; })) return;
      var row = document.createElement('span'); row.dataset.optionDiagnosticId = id;
      container.appendChild(row);
      window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS.attach(row, id, requestJson);
      container.hidden = false;
    });
  }
  function flushOptionMapQueue() {
    var batch = optionMapQueue.splice(0); optionMapTimer = null;
    var active = batch.filter(function (item) { return !item.aborted && item.context === contentContext(); });
    if (!active.length) return;
    var context = contentContext();
    var entries = active.map(function (item) { return { text: item.text, evidenceToken: item.evidenceToken }; });
    requestJson('/api/domain/commands/product-option-auto-map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: entries })
    }).then(function (data) {
      showOptionMapDiagnostics(data, context);
      var translations = data.translations || {}, failures = data.failures || {};
      active.forEach(function (item) {
        if (item.aborted) return;
        var translated = String(translations[item.text] || '');
        if (translated) item.resolve(translated);
        else item.reject(new Error(String(failures[item.text] || '公共属性映射没有返回可用中文译文')));
      });
    }).catch(function (error) {
      showOptionMapDiagnostics(error || {}, context);
      var message = error && typeof error.serverMessage === 'string' && /[\u3400-\u9fff]/.test(error.serverMessage) ? error.serverMessage : '公共属性中文映射读取失败，请检查网络后重试；俄文原值已保留。';
      active.forEach(function (item) { if (!item.aborted) item.reject(new Error(message)); });
    });
  }
  if (optionMappingTranslator && optionMappingTranslator.setRequest) {
    optionMappingTranslator.setRequest(function (payload) {
      if (payload.publicMapping !== true) return Promise.reject(new Error('只有公共字典缺失映射可以自动调用AI'));
      return new Promise(function (resolve, reject) {
        var item = { text: String(payload.text || '').trim(), evidenceToken: payload.evidenceToken, context: contentContext(), resolve: resolve, reject: reject, aborted: false };
        if (payload.signal && payload.signal.aborted) { reject(new Error('公共属性映射请求已取消')); return; }
        if (payload.signal) payload.signal.addEventListener('abort', function () { item.aborted = true; reject(new Error('公共属性映射请求已取消')); }, { once: true });
        optionMapQueue.push(item);
        if (!optionMapTimer) optionMapTimer = setTimeout(flushOptionMapQueue, 20);
      });
    });
  }
  if (fieldTranslator && fieldTranslator.setRequest) {
    fieldTranslator.setRequest(function (payload) {
      return requestJson('/api/domain/commands/product-field-translate', {
        method: 'POST', signal: payload.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: payload.text, source: payload.source, target: payload.target, fieldKey: payload.fieldKey, identityFacts: payload.identityFacts, compatibilityEvidence: payload.compatibilityEvidence })
      }).then(function (data) { if (payload.onDiagnostic) payload.onDiagnostic(data.diagnosticId); if (payload.onReview) payload.onReview(data); return String(data.text || ''); });
    });
  }
  function categoryRequest(kind, url, force) {
    var key = [optionScope(), url, kind === 'definition' ? categoryVersion : ''];
    return (force ? Promise.resolve(null) : categoryCache.get(kind, key)).then(function (cached) {
      if (cached) return cached;
      return requestJson(url).then(function (data) { return categoryCache.put(kind, key, data).then(function () { return data; }); });
    });
  }
  function note(text, bad) { $('saveState').textContent = text; $('saveState').style.color = bad ? 'var(--red)' : ''; }
  function pid(p) { return String(p && (p.id || p.productId || p.sku) || ''); }
  function pshop(p) { return String(p && (p.shop || p.clientId || p.shopId) || ''); }
  function categoryText(item) { return arr(item && item.path).map(function (level) { return level.name; }).filter(Boolean).join(' / '); }
  function categoryKey(item) { return String(item.descriptionCategoryId) + ':' + String(item.typeId); }
  function categoryLabel() { return $('category').selectedOptions[0] && $('category').selectedOptions[0].textContent || ''; }
  function findProduct(items) {
    var id = String(params.get('productId') || ''), sku = String(params.get('sku') || ''), shop = String(params.get('shop') || '');
    var clientId = String(params.get('clientId') || '');
    var matches = arr(items).filter(function (p) { return (id ? pid(p) === id : sku && String(p.sku || '') === sku) && (!shop || pshop(p) === shop) && (!clientId || String(p.clientId || p.shopId || '') === clientId); });
    return matches.length === 1 ? matches[0] : null;
  }
  function fillShops(selected) {
    var resolved = productShops.resolve(shops, selected), select = $('shop');
    select.replaceChildren(new Option('请选择店铺', ''));
    shops.forEach(function (shop) { select.add(new Option(shop.name || shop.shopName || productShops.id(shop), productShops.id(shop))); });
    if (resolved) { select.value = productShops.id(resolved); }
    else {
      // 授权列表匹配不到时（如系统管理员跨租户查看），仍显示商品自带的店铺标识，避免编辑页店铺空白；保存仍由服务端校验店铺范围
      var explicitValue = String(selected && (selected.clientId || selected.externalShopId || selected.shopId) || '');
      var explicitLabel = String(selected && (selected.shop || selected.shopName || explicitValue) || '');
      if (explicitValue) { select.add(new Option(explicitLabel, explicitValue)); select.value = explicitValue; }
    }
    if (shopSelect) shopSelect.refresh();
  }
  function normAttr(item, existing) {
    var id = String(item.id || item.attribute_id || '');
    return Object.assign({}, item, { id: id, name: item.name || item.attribute_name || ('属性 ' + (item.id || '')), value: existing && Object.prototype.hasOwnProperty.call(existing, id) ? existing[id] : attributeFields.text(item), required: Boolean(item.required || item.is_required), group: item.groupName || item.group_name || item.group || '', description: item.description || '', type: item.type || '' });
  }
  function displayAttrName(name) {
    name = String(name || '');
    if (/^型号名称/.test(name)) return '型号名称';
    if (/^JSON\s*富内容/i.test(name)) return '富内容';
    return name;
  }
  function isModelNameAttribute(attribute) { return /^型号名称/.test(String(attribute && attribute.name || '').trim()); }
  function newErpVariantRef() {
    var raw = window.crypto && typeof window.crypto.randomUUID === 'function' ? window.crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    return 'erv_' + String(raw).replace(/[^A-Za-z0-9_-]/g, '');
  }
  function normVariant(item) {
    var images = arr(item.images).map(function (image) { return typeof image === 'string' ? image : image && (image.file_name_url || image.url || image.src) || ''; }).filter(Boolean); if (!images.length && item.image) images = [item.image];
    function amount(primary, fallback) { return primary != null && primary !== '' ? String(primary) : (fallback == null ? '' : String(fallback)); }
    var colorNameAttribute = arr(item.attributes).find(function (a) { return String(a.id || a.attribute_id) === '10097'; });
    var colorName = item.colorName != null ? String(item.colorName) : (colorNameAttribute ? attributeFields.text(colorNameAttribute) : '');
    return { erpVariantRef: String(item.erpVariantRef || item.variantLocalRef || '').trim() || newErpVariantRef(), sourceBundleIds: arr(item.sourceBundleIds).map(String).filter(Boolean), name: item.name || '', title: item.title == null ? '' : String(item.title), weightG: amount(item.weightG), packageLength: amount(item.packageLength), packageWidth: amount(item.packageWidth), packageHeight: amount(item.packageHeight), descriptionCategoryId: item.descriptionCategoryId == null ? '' : String(item.descriptionCategoryId), typeId: item.typeId == null ? '' : String(item.typeId), category: item.category == null ? '' : String(item.category), categoryAttributeKeys: arr(item.categoryAttributeKeys).map(String).filter(Boolean), categoryRequiredKeys: arr(item.categoryRequiredKeys).map(String).filter(Boolean), sourceSpecText: item.sourceSpecText || item.sourceLabel || item.specText || item.name || '', image: item.image || images[0] || '', images: images, videoCover: item.videoCover || '', video: item.video || '', offerId: item.offerId || item.article || '', sku: item.sku || '', purchase: amount(item.purchase, item.purchasePrice), domesticShipping: item.domesticShipping == null ? '' : String(item.domesticShipping), lowest: amount(item.lowest, item.priceLowest, item.minPrice, item.min_price), sale: amount(item.sale, item.priceSell), old: amount(item.old, item.priceOriginal), packQuantity: amount(item.packQuantity), itemLength: amount(item.itemLength), color: item.color || '', colorName: colorName, barcode: item.barcode, description: item.description, hashtags: item.hashtags, richContent: item.richContent, attributes: arr(item.attributes).map(function (a) { return Object.assign({}, a); }), stock: item.stock == null ? '' : item.stock };
  }
  function baseVariant(item) {
    var images = arr(item.images).concat(arr(item.primary_image)); if (!images.length && (item.img || item.image || item.primaryImage)) images = [item.img || item.image || item.primaryImage];
    return normVariant({ erpVariantRef: item.erpVariantRef, sourceBundleIds: item.sourceBundleIds, name: item.variantName || item.name, images: images, image: images[0], videoCover: item.videoCover || item.video_cover, video: item.video || arr(item.videos)[0] || '', article: item.article || item.offer_id, sku: item.sku || item.id, purchasePrice: item.purchasePrice, domesticShipping: item.domesticShipping, priceLowest: item.priceLowest || item.minPrice || item.min_price, priceSell: item.priceSell || item.price, priceOriginal: item.priceOriginal || item.oldPrice, color: item.color, colorName: item.colorName, stock: item.stock });
  }
  function isBrandAttribute(a) { return ['85','31'].indexOf(String(a.id)) >= 0 || /^(品牌(?:名称)?(?:[（(].*[)）])?|服装和鞋类品牌)$/.test(String(a.name || '').replace(/\s+/g, '')); }
  function aiBrandValue() {
    var value = val('brand');
    return /^(?:无品牌|無品牌|нет\s+бренда|без\s+бренда|no\s*brand|unbranded|请选择(?:品牌)?|[-—–])$/i.test(value) ? '' : value;
  }
  function isTypeAttribute(a) { return String(a.id) === '8229'; }
  function isHashtagsAttribute(a) { return String(a.id) === '23171'; }
  function syncBrandAttributes() { attributes.forEach(function (a) { if (isBrandAttribute(a) && !manualVariantAttributeKeys.has(variantAttributeKey(a))) attributeFields.setText(a, val('brand')); }); }
  function syncHashtags() { attributes.forEach(function (a) { if (isHashtagsAttribute(a) && !manualVariantAttributeKeys.has(variantAttributeKey(a))) attributeFields.setText(a, val('hashtags')); }); }
  function hydrateHashtags() {
    var field = attributes.find(isHashtagsAttribute);
    if (field && !hashtagsEdited) $('hashtags').value = String(field.value == null ? '' : field.value);
    $('hashtags').disabled = !field;
    $('hashtagsField').classList.toggle('required', Boolean(field && field.required));
    $('hashtags').setAttribute('aria-required', String(Boolean(field && field.required)));
    syncHashtags();
    if (hashtagsControl) hashtagsControl.refresh();
  }
  function hydrateBrand() {
    var brand = attributes.find(function (a) { return isBrandAttribute(a) && String(a.value || '').trim(); });
    if (!brandHasValue && brand) { $('brand').value = String(brand.value); brandHasValue = true; }
    syncBrandAttributes();
  }
  function sharedBindings() { return attributeFields.bindings(attributes); }
  function activateOptionControls() {
    // Restored drafts normally avoid automatic dictionary reads. Old drafts whose
    // chips contain only an ID/Chinese label must resolve the Russian source value
    // before they can be saved or submitted safely.
    optionControls.forEach(function (control) {
      if (!draftRestored || control && typeof control.needsResolution === 'function' && control.needsResolution()) control.activate();
    });
  }
  function optionScope() { return JSON.stringify([erpStorage.getCurrentUser ? erpStorage.getCurrentUser() : '', erpStorage.getSelectedTenantId ? erpStorage.getSelectedTenantId() : '']); }
  function editBrowserDraftId() {
    if (!product) return '';
    return 'edit:' + String(product.clientId || product.externalShopId || product.shopId || product.shop || '').replace(/[^\w.-]/g, '_') + ':' + pid(product).replace(/[^\w.-]/g, '_');
  }
  function browserDraftPut(id, draft) {
    if (!draftCache || typeof draftCache.put !== 'function') return Promise.resolve(false);
    var localDraft = JSON.parse(JSON.stringify(draft));
    if (contentReview) { localDraft.contentRiskChecks = contentReview.state(); localDraft.browserContentReview = contentReview.local(); }
    localDraft.packageDimensionSources = Object.assign({}, packageDimensionSources);
    if (richContentBilingual) localDraft.richContentBilingual = JSON.parse(JSON.stringify(richContentBilingual));
    if (sellingPointsBilingual) localDraft.sellingPointsBilingual = JSON.parse(JSON.stringify(sellingPointsBilingual));
    if (originalContentSource) localDraft.browserOriginalContentSource = JSON.parse(JSON.stringify(originalContentSource));
    if (translationControls && translationControls.exportState) localDraft.browserTranslations = translationControls.exportState();
    return draftCache.put(optionScope(), id, localDraft);
  }
  function browserDraftGet(id) { return draftCache && typeof draftCache.get === 'function' ? draftCache.get(optionScope(), id) : Promise.resolve(null); }
  function browserDraftList() { return draftCache && typeof draftCache.list === 'function' ? draftCache.list(optionScope()) : Promise.resolve([]); }
  function browserDraftRemove(id) { return draftCache && typeof draftCache.remove === 'function' ? draftCache.remove(optionScope(), id) : Promise.resolve(false); }
  function rememberCreateDraftInUrl() {
    if (!createMode || params.get('draftId') === createDraftId) return;
    params.set('draftId', createDraftId);
    history.replaceState(history.state, '', location.pathname + '?' + params.toString() + location.hash);
    if (workspaceEmbedded) window.parent.postMessage({ type: 'wyerp-workspace-route-replace', route: location.pathname + location.search + location.hash }, location.origin);
  }
  function currentOptionContext() {
    var categoryId = val('descriptionCategoryId'), typeId = val('typeId');
    if (!categoryId || !typeId) return null;
    var scope = optionScope(), version = categoryVersion;
    var sources = shops.map(function (shop) { return String(shop.clientId || shop.externalShopId || '').trim(); }).filter(Boolean);
    return { scope: scope, version: version, shop: sources[0] || '', shops: sources, descriptionCategoryId: categoryId, typeId: typeId, alive: function () { return optionScope() === scope && categoryVersion === version && val('descriptionCategoryId') === categoryId && val('typeId') === typeId; } };
  }
  function refreshOptionControls() {
    translationControls.clear();
    optionControls.forEach(function (control) { control.destroy(); }); optionControls = [];
    var categoryId = val('descriptionCategoryId'), typeId = val('typeId');
    if (!categoryId || !typeId || optionCategory !== categoryId + ':' + typeId) { translationControls.refresh(attributes, sharedBindings()); return; }
    // Public dictionaries are independent of the listing selection; authorization remains on the server.
    var context = currentOptionContext();
    var bindings = sharedBindings(), attached = new Set();
    function attach(input, a, rowIndex) {
      if (!input || attached.has(input) || !attributeOptions.kind(a)) return;
      attached.add(input);
      var variantAttribute = rowIndex == null ? null : arr(variants[rowIndex].attributes).find(function (item) { return detailData.attributeKey(item) === detailData.attributeKey(a); });
      var stored = rowIndex == null ? a : Object.assign({}, a, variantAttribute || {}, { value: input.value, values: variantAttribute && variantAttribute.values || [] });
      optionControls.push(attributeOptions.mount(input, a, { context: context, loader: optionLoader, localizer: optionLocalizer, stored: stored, brand: isBrandAttribute(a), resolved: function () { if (input.dataset.field === 'color') hydrateColorName(input.closest('tr')); }, change: function (selected, text) {
        if (rowIndex == null) attributeOptions.applySelection(a, selected);
        if (rowIndex != null && variants[rowIndex]) {
          var variant = variants[rowIndex], previous = arr(variant.attributes).find(function (item) { return detailData.attributeKey(item) === detailData.attributeKey(a); });
          var value = Object.assign({}, previous || {}, { id: a.id, collection: Boolean(a.collection != null ? a.collection : a.is_collection), maxValueCount: a.maxValueCount != null ? a.maxValueCount : a.max_value_count, complexId: a.complexId || a.attribute_complex_id || '' });
          attributeOptions.applySelection(value, selected);
          variant.attributes = arr(variant.attributes).filter(function (item) { return detailData.attributeKey(item) !== detailData.attributeKey(a); }).concat(value);
          if (input.dataset.field) variant[input.dataset.field] = text;
        }
      } }));
    }
    attributes.forEach(function (a, i) {
      if (!attributeOptions.kind(a) || isTypeAttribute(a) || isHashtagsAttribute(a)) return;
      var binding = bindings[i];
      if (binding && binding.area === 'media') return;
      if (isBrandAttribute(a)) {
        if (manualVariantAttributeKeys.has(variantAttributeKey(a))) $('variantBody').querySelectorAll('[data-variant-attribute-index="' + i + '"]').forEach(function (input) { attach(input, a, Number(input.closest('tr').dataset.index)); });
        else attach($('brand'), a);
        return;
      }
      if (binding && binding.area === 'field' && !manualVariantAttributeKeys.has(variantAttributeKey(a))) { attach($(binding.key), a); return; }
      var variantInputs = $('variantBody').querySelectorAll('[data-variant-attribute-index="' + i + '"]');
      if (variantInputs.length) {
        variantInputs.forEach(function (input) { attach(input, a, Number(input.closest('tr').dataset.index)); });
        return;
      }
      if (binding && binding.area === 'variant' && !suppressedVariantAttributeKeys.has(variantAttributeKey(a))) {
        $('variantBody').querySelectorAll('[data-field="' + binding.key + '"]').forEach(function (input) { attach(input, a, Number(input.closest('tr').dataset.index)); });
        return;
      }
      attach(document.querySelector('[data-attribute-index="' + i + '"]'), a);
    });
    activateOptionControls();
    translationControls.refresh(attributes, bindings);
  }
  function syncSharedAttributes() {
    sharedBindings().forEach(function (binding, i) {
      if (manualVariantAttributeKeys.has(variantAttributeKey(attributes[i])) || binding && binding.key === 'barcode' && manualVariantAttributeKeys.has('field:barcode')) return;
      if (binding && binding.area === 'dimensions' && ['length','width','height'].some(function (key) { return sharedDirty['field:' + key]; })) {
        var formatted = attributeFields.formatDimensions({ length: val('length'), width: val('width'), height: val('height') });
        if (formatted !== null) attributeFields.setText(attributes[i], formatted);
        return;
      }
      if (!binding || !sharedDirty[binding.area + ':' + binding.key]) return;
      if (binding.area === 'field') attributeFields.setText(attributes[i], val(binding.key));
      if (binding.area === 'variant' && variants[0] && !suppressedVariantAttributeKeys.has(variantAttributeKey(attributes[i]))) attributeFields.setText(attributes[i], variants[0][binding.key]);
    });
  }
  function hydrateSharedAttributes() {
    var bindings = sharedBindings();
    bindings.forEach(function (binding, i) {
      if (manualVariantAttributeKeys.has(variantAttributeKey(attributes[i])) || binding && binding.key === 'barcode' && manualVariantAttributeKeys.has('field:barcode')) return;
      if (!binding || sharedDirty[binding.area + ':' + binding.key]) return;
      if (binding.area === 'media') {
        if (variants[0] && (binding.key === 'video' || (binding.key === 'videoCover' && /\.(mp4|mov|m3u8)(?:[?#]|$)/i.test(variants[0].videoCover))) && !attributeFields.text(attributes[i]) && variants[0][binding.key]) {
          attributeFields.setText(attributes[i], variants[0][binding.key]);
        }
        return;
      }
      var value = attributeFields.text(attributes[i]);
      if (binding.area === 'dimensions') {
        var dimensions = attributeFields.parseDimensions(value);
        if (dimensions) ['length','width','height'].forEach(function (key) {
          if (!sharedDirty['field:' + key] && !val(key)) { $(key).value = dimensions[key]; sharedHydrated['field:' + key] = dimensions[key]; }
        });
      }
      if (binding.area === 'field' && !val(binding.key)) { $(binding.key).value = value; sharedHydrated['field:' + binding.key] = value; }
      if (binding.area === 'variant' && !suppressedVariantAttributeKeys.has(variantAttributeKey(attributes[i])) && variants[0] && String(variants[0][binding.key] || '') === '') {
        variants[0][binding.key] = value;
        sharedHydrated['variant:' + binding.key] = value;
        var input = $('variantBody').querySelector('tr:first-child [data-field="' + binding.key + '"]');
        if (input) input.value = value;
      }
    });
    ['title','description','richContent','weight','barcode','length','width','height'].forEach(function (key) {
      var required = ['title','weight','length','width','height'].indexOf(key) >= 0 || bindings.some(function (binding, i) { return binding && binding.area === 'field' && binding.key === key && attributes[i].required; });
      $(key).closest('.field').classList.toggle('required', required);
      $(key).setAttribute('aria-required', String(required));
    });
    variantAttributeColumns().forEach(function (column) {
      $('variantBody').querySelectorAll('[data-variant-attribute-index="' + column.index + '"]').forEach(function (input) { input.setAttribute('aria-required', String(Boolean(column.attribute.required))); });
    });
    $('variantBody').querySelectorAll('tr[data-index]').forEach(function (row) { hydrateColorName(row); });
  }
  function resetHydratedCategoryFields() {
    Object.keys(sharedHydrated).forEach(function (token) {
      if (sharedDirty[token]) return;
      var parts = token.split(':'), key = parts[1];
      if (parts[0] === 'field' && val(key) === sharedHydrated[token]) $(key).value = '';
      if (parts[0] === 'variant' && variants[0] && String(variants[0][key]) === sharedHydrated[token]) {
        variants[0][key] = '';
        var input = $('variantBody').querySelector('tr:first-child [data-field="' + key + '"]');
        if (input) input.value = '';
      }
    });
    sharedHydrated = Object.create(null);
  }
  function mediaAttribute(key) {
    var index = sharedBindings().findIndex(function (binding) { return binding && binding.area === 'media' && binding.key === key; });
    return index < 0 ? null : attributes[index];
  }
  function refreshMediaPreviews() {
    ['video','videoCover'].forEach(function (key) {
      var attribute = mediaAttribute(key), shared = attribute && attributeFields.text(attribute);
      $('variantBody').querySelectorAll('tr[data-index]').forEach(function (row) {
        var input = row.querySelector('[data-field="' + key + '"]'), trigger = input && input.parentElement.querySelector('[data-video-media="' + key + '"]');
        if (!input) return;
        var rowShared = row.dataset.index === '0' ? shared : '';
        var value = rowShared || input.value;
        if (!trigger) return;
        var videoValue = row.dataset.index === '0' && mediaAttribute('video') && attributeFields.text(mediaAttribute('video'))
          ? attributeFields.text(mediaAttribute('video'))
          : row.querySelector('[data-field="video"]').value;
        trigger.outerHTML = videoCell(value, key === 'videoCover', row.dataset.index === '0', videoValue);
      });
    });
    primeVariantVideoPreviews();
  }
  function syncChoiceInputs() {
    optionControls.forEach(function (control) { if (control && typeof control.syncInput === 'function') control.syncInput(); });
    // A rapid category/draft rerender can leave an older control in the lifecycle
    // list. The adjacent visible tags are the final state the user can see, so
    // apply them last and prevent a stale control from clearing the source field.
    document.querySelectorAll('[data-choice-input="true"]').forEach(function (input) {
      var wrapper = input.previousElementSibling;
      if (!wrapper || !wrapper.classList.contains('searchable-select')) return;
      var items = Array.from(wrapper.querySelectorAll('.searchable-select-tag')).map(function (tag) {
        return { id: tag.dataset.choiceId || '', value: tag.dataset.choiceValue || '' };
      });
      input.value = attributeOptions.serialize(items, input.dataset.choiceMultiple === 'true' || items.length > 1);
    });
  }
  function collectAttributes() { syncChoiceInputs(); document.querySelectorAll('[data-attribute-index]:not([data-variant-attribute-index])').forEach(function (input) { if (attributes[Number(input.dataset.attributeIndex)]) attributeFields.setText(attributes[Number(input.dataset.attributeIndex)], input.value); }); syncBrandAttributes(); syncHashtags(); syncSharedAttributes(); }
  function generateMissingModelNames() {
    var generatedCount = 0;
    attributes.forEach(function (attribute, index) {
      if (!isModelNameAttribute(attribute)) return;
      var input = document.querySelector('[data-attribute-index="' + index + '"]');
      if (!input || input.readOnly || input.disabled || String(input.value || '').trim()) return;
      try {
        var generated = window.WYERP_PRODUCT_MODEL_NAME_GENERATOR.generate();
        input.value = generated.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        generatedCount += 1;
      } catch (_) {}
    });
    return generatedCount;
  }
  function generateModelName(index) {
    var attribute = attributes[index], input = document.querySelector('[data-attribute-index="' + index + '"]');
    if (!attribute || !input || !isModelNameAttribute(attribute) || input.readOnly || input.disabled) return;
    try {
      var generated = window.WYERP_PRODUCT_MODEL_NAME_GENERATOR.generate();
      input.value = generated.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      note('已生成型号名称：' + generated.value);
      input.focus();
    } catch (error) { note(error.message || '型号名称生成失败', true); }
  }
  function attributeRows(indexes) {
    var fragment = document.createDocumentFragment();
    indexes.forEach(function (i) {
      var a = attributes[i], row = document.createElement('div'), label = document.createElement('label');
      row.className = 'attribute-item';
      if (a.required) { var mark = document.createElement('b'); mark.className = 'field-required-mark'; mark.textContent = '* '; label.appendChild(mark); }
      var binding = attributeFields.classify(a);
      label.appendChild(document.createTextNode(binding && binding.area === 'media' ? binding.label : displayAttrName(a.name)));
      if (a.group) { var group = document.createElement('small'); group.textContent = a.group; label.appendChild(group); }
      var control = document.createElement('span'), input = document.createElement('input');
      control.className = 'attribute-control' + (isModelNameAttribute(a) ? ' model-name-control' : ''); input.id = 'product-attribute-' + i; label.htmlFor = input.id;
      input.dataset.attributeIndex = String(i); input.value = a.value;
      if (!createMode && String(a.id) === '9024') { input.readOnly = true; input.title = '卖家代码由平台货号确定，不支持通过属性修改'; }
      if (Number(a.complexId || a.complex_id || a.attribute_complex_id)) { input.readOnly = true; input.title = '当前编辑命令暂不支持复合属性修改，原值会保留'; }
      input.setAttribute('aria-required', String(a.required));
      control.appendChild(input);
      if (isModelNameAttribute(a)) {
        var generateButton = document.createElement('button'), generateIcon = document.createElement('span');
        generateButton.className = 'model-name-generate-btn product-field-action'; generateButton.type = 'button'; generateButton.dataset.generateModelName = String(i);
        generateButton.dataset.actionTooltip = '按年月日时分秒加4位随机数生成型号名称'; generateButton.setAttribute('aria-label', '一键生成型号名称');
        generateIcon.textContent = '✦'; generateIcon.setAttribute('aria-hidden', 'true'); generateButton.append(generateIcon);
        if (input.readOnly || input.disabled) { generateButton.disabled = true; generateButton.dataset.actionTooltip = '当前型号名称属性不可编辑'; }
        control.appendChild(generateButton);
      }
      var promotionUnavailable = variantPromotionUnavailableReason(a, binding), addVariantAttribute = document.createElement('button');
      addVariantAttribute.type = 'button'; addVariantAttribute.className = 'attribute-variant-add product-field-action'; addVariantAttribute.dataset.addVariantAttribute = String(i);
      addVariantAttribute.textContent = '+'; addVariantAttribute.setAttribute('aria-label', '将' + displayAttrName(a.name) + '添加到变体属性中');
      if (promotionUnavailable) {
        addVariantAttribute.classList.add('attribute-variant-unavailable'); addVariantAttribute.setAttribute('aria-disabled', 'true');
        addVariantAttribute.dataset.actionTooltip = promotionUnavailable;
        addVariantAttribute.addEventListener('click', function () { note(promotionUnavailable, true); });
      } else {
        addVariantAttribute.dataset.actionTooltip = '添加到变体属性中';
        addVariantAttribute.addEventListener('click', function () { promoteVariantAttribute(i); });
      }
      control.classList.add('attribute-promotable'); control.appendChild(addVariantAttribute);
      row.append(label, control); fragment.appendChild(row);
    });
    return fragment;
  }
  function variantAttributeStored(variant, attribute) {
    var key = detailData.attributeKey(attribute);
    return arr(variant && variant.attributes).find(function (item) { return detailData.attributeKey(item) === key; }) || null;
  }
  function variantAttributeValue(variant, attribute, binding, rowIndex) {
    if (attribute && attribute.promotionField === 'category') return variant && variant.category ? String(variant.category) : categoryLabel();
    if (attribute && attribute.promotionField === 'dimensions') return variant && [variant.packageLength,variant.packageWidth,variant.packageHeight].some(function (value) { return value != null && value !== ''; }) ? [variant.packageLength || '',variant.packageWidth || '',variant.packageHeight || ''].join(' × ') : rowIndex === 0 ? [val('length'),val('width'),val('height')].join(' × ') : '';
    if (binding && variant && variant[binding.key] != null) return String(variant[binding.key]);
    var stored = variantAttributeStored(variant, attribute);
    if (stored) return attributeFields.text(stored);
    return rowIndex === 0 ? attributeFields.text(attribute) : '';
  }
  function variantAttributeVaries(attribute, binding) {
    if (variants.length < 2) return false;
    var values = variants.map(function (variant, index) { return variantAttributeValue(variant, attribute, binding, index).trim(); });
    return new Set(values).size > 1;
  }
  var fixedPromotionDefinitions = {
    '-1': {promotionField:'barcode', name:'条码', inputId:'barcode', binding:{area:'field',key:'barcode'}},
    '-2': {promotionField:'title', name:'标题', inputId:'title', binding:{area:'field',key:'title'}},
    '-3': {promotionField:'weight', name:'包装重量', inputId:'weight', binding:{area:'field',key:'weightG'}},
    '-4': {promotionField:'dimensions', name:'包装尺寸', inputId:'length', binding:{area:'dimensions',key:'dimensions'}},
    '-5': {promotionField:'category', name:'产品类目', inputId:'category', binding:{area:'category',key:'category'}}
  };
  function variantAttributeKey(attribute) { return attribute && attribute.promotionField ? 'field:' + attribute.promotionField : detailData.attributeKey(attribute); }
  function promotionAttribute(index) { return index < 0 ? fixedPromotionDefinitions[String(index)] : attributes[index]; }
  function promotionBinding(attribute, index) { return attribute && attribute.promotionField ? attribute.binding : isHashtagsAttribute(attribute) ? {area:'field',key:'hashtags'} : sharedBindings()[index]; }
  function variantPromotionUnavailableReason(attribute, binding) {
    if (!attribute || attribute.categoryDefined === false) return '当前属性不是有效的平台类目属性，不能作为SKU变体';
    if (attribute.promotionField === 'category') return createMode ? '' : '编辑已有商品不能修改产品类目';
    if (isBrandAttribute(attribute)) return '';
    if (isTypeAttribute(attribute)) return '商品类型由主商品统一维护，不能拆分为SKU变体';
    if (Number(attribute.complexId || attribute.complex_id || attribute.attribute_complex_id)) return '复合属性暂不支持拆分为SKU变体';
    if (!binding || binding.area === 'variant') return '';
    if (attribute.promotionField && ['title','weight','dimensions','barcode','category'].indexOf(attribute.promotionField) >= 0) return '';
    if (binding.area === 'field' && ['description','richContent','barcode','hashtags'].indexOf(binding.key) >= 0) return '';
    if (binding.area === 'media') return '图片和视频属性请使用SKU图片/视频编辑器维护';
    return '该属性当前由主商品统一维护，不能拆分为SKU变体';
  }
  function canPromoteVariantAttribute(attribute, binding) { return !variantPromotionUnavailableReason(attribute, binding); }
  function automaticVariantAttribute(column) {
    var attribute = column.attribute, binding = column.binding;
    if (attribute && attribute.promotionField) return false;
    return Boolean(attribute.aspect) || Boolean(binding && binding.area === 'variant' && attribute.required) || variantAttributeVaries(attribute, binding);
  }
  function promotionColumns() {
    var columns = attributes.map(function (attribute, index) { return {attribute: attribute, index: index, binding: promotionBinding(attribute, index)}; }).filter(function (column) { return !column.binding || column.binding.key !== 'barcode'; });
    [-1,-2,-3,-4,-5].forEach(function (index) { var attribute = promotionAttribute(index); columns.push({attribute:attribute,index:index,binding:promotionBinding(attribute,index)}); });
    return columns;
  }
  function variantAttributeColumns() {
    return promotionColumns().filter(function (column) {
      if (!canPromoteVariantAttribute(column.attribute, column.binding) || isBrandAttribute(column.attribute)) return false;
      var key = variantAttributeKey(column.attribute);
      return !suppressedVariantAttributeKeys.has(key) && (manualVariantAttributeKeys.has(key) || automaticVariantAttribute(column));
    }).map(function (column) { column.manual = manualVariantAttributeKeys.has(variantAttributeKey(column.attribute)); column.removable = column.manual; return column; });
  }
  function normalizeVariantAttributeModes() {
    promotionColumns().forEach(function (column) {
      var key = variantAttributeKey(column.attribute);
      if (!automaticVariantAttribute(column)) return;
      var state = promotionState.attributes && promotionState.attributes[key];
      if (state && state.manual === true) return;
      manualVariantAttributeKeys.delete(key);
      suppressedVariantAttributeKeys.delete(key);
    });
  }
  function promotionSnapshot(attribute, binding, variant) {
    var stored = variant ? variantAttributeStored(variant, attribute) : attribute;
    var snapshot = {attribute: attribute.promotionField ? {} : cloneVariantAttribute(stored || attribute)};
    if (attribute.promotionField === 'category') snapshot.fieldValue = variant ? {descriptionCategoryId:String(variant.descriptionCategoryId || ''),typeId:String(variant.typeId || ''),category:String(variant.category || ''),categoryAttributeKeys:arr(variant.categoryAttributeKeys).slice(),categoryRequiredKeys:arr(variant.categoryRequiredKeys).slice()} : {descriptionCategoryId:val('descriptionCategoryId'),typeId:val('typeId'),category:categoryLabel(),categoryAttributeKeys:attributes.filter(function (item) { return item.categoryDefined !== false && !isTypeAttribute(item); }).map(variantAttributeKey),categoryRequiredKeys:attributes.filter(function (item) { return item.categoryDefined !== false && !isTypeAttribute(item) && item.required; }).map(variantAttributeKey)};
    else if (attribute.promotionField === 'dimensions') snapshot.fieldValue = variant ? {length:String(variant.packageLength || ''),width:String(variant.packageWidth || ''),height:String(variant.packageHeight || '')} : {length:val('length'),width:val('width'),height:val('height')};
    else if (binding) { var inputId = attribute.inputId || binding.key; snapshot.fieldValue = variant ? String(variant[binding.key] == null ? attributeFields.text(stored || attribute) : variant[binding.key]) : binding.area === 'field' ? val(inputId) : attributeFields.text(attribute); }
    return snapshot;
  }
  function applyPromotionSnapshot(variant, attribute, binding, snapshot) {
    if (!attribute.promotionField) variant.attributes = arr(variant.attributes).filter(function (item) { return detailData.attributeKey(item) !== variantAttributeKey(attribute); }).concat(cloneVariantAttribute(snapshot.attribute));
    if (attribute.promotionField === 'category' && snapshot.fieldValue) { variant.descriptionCategoryId = snapshot.fieldValue.descriptionCategoryId; variant.typeId = snapshot.fieldValue.typeId; variant.category = snapshot.fieldValue.category; variant.categoryAttributeKeys = arr(snapshot.fieldValue.categoryAttributeKeys).slice(); variant.categoryRequiredKeys = arr(snapshot.fieldValue.categoryRequiredKeys).slice(); }
    else if (attribute.promotionField === 'dimensions' && snapshot.fieldValue) { variant.packageLength = snapshot.fieldValue.length; variant.packageWidth = snapshot.fieldValue.width; variant.packageHeight = snapshot.fieldValue.height; }
    else if (binding && snapshot.fieldValue != null) variant[binding.key] = snapshot.fieldValue;
  }
  function promoteVariantAttribute(index) {
    collectVariants(); collectAttributes();
    var attribute = promotionAttribute(index), binding = promotionBinding(attribute, index);
    if (!canPromoteVariantAttribute(attribute, binding)) { note('此属性不适合作为SKU变体列', true); return; }
    var key = variantAttributeKey(attribute), cached = promotionState.attributes[key], original = promotionSnapshot(attribute, binding);
    var state = {original: original, variantValues: cached ? cached.variantValues : {}, manual: true};
    variants.forEach(function (variant) { var value = state.variantValues[variant.erpVariantRef] || (variantAttributeStored(variant, attribute) ? promotionSnapshot(attribute, binding, variant) : original); applyPromotionSnapshot(variant, attribute, binding, value); });
    promotionState.attributes[key] = state;
    manualVariantAttributeKeys.add(key); suppressedVariantAttributeKeys.delete(key);
    if (!attribute.promotionField) fullInfoDirty['attribute:' + key] = true;
    if (attribute.promotionField === 'dimensions') ['length','width','height'].forEach(function (field) { fullInfoDirty['field:' + field] = true; });
    else if (binding && binding.area === 'field') fullInfoDirty['field:' + (attribute.inputId || binding.key)] = true;
    variantStructureEdited = true; markWorkspaceDirty(); renderAttributes(); renderVariants(); note('已将“' + displayAttrName(attribute.name) + '”添加到变体表');
  }
  function removeManualVariantAttribute(index) {
    collectVariants(); collectAttributes();
    var attribute = promotionAttribute(index); if (!attribute) return;
    var key = variantAttributeKey(attribute), binding = promotionBinding(attribute, index), state = promotionState.attributes[key] || {original: promotionSnapshot(attribute, binding), variantValues: {}};
    variants.forEach(function (variant) {
      state.variantValues[variant.erpVariantRef] = promotionSnapshot(attribute, binding, variant);
      if (!attribute.promotionField) variant.attributes = arr(variant.attributes).filter(function (item) { return detailData.attributeKey(item) !== key; });
      if (attribute.promotionField === 'category') { delete variant.descriptionCategoryId; delete variant.typeId; delete variant.category; delete variant.categoryAttributeKeys; delete variant.categoryRequiredKeys; }
      else if (attribute.promotionField === 'dimensions') { delete variant.packageLength; delete variant.packageWidth; delete variant.packageHeight; }
      else if (binding) delete variant[binding.key];
    });
    state.manual = false; promotionState.attributes[key] = state;
    if (index >= 0) attributes[index] = cloneVariantAttribute(state.original.attribute);
    if (attribute.promotionField === 'category') { /* 主类目选择在变体期间保持原值，取消后无需重写 */ }
    else if (attribute.promotionField === 'dimensions' && state.original.fieldValue) { $('length').value = state.original.fieldValue.length || ''; $('width').value = state.original.fieldValue.width || ''; $('height').value = state.original.fieldValue.height || ''; }
    else if (binding && binding.area === 'field') { $(attribute.inputId || binding.key).value = state.original.fieldValue || ''; if (binding.key === 'hashtags') hashtagsControl.refresh(); }
    manualVariantAttributeKeys.delete(key); suppressedVariantAttributeKeys.add(key);
    if (!attribute.promotionField) fullInfoDirty['attribute:' + key] = true;
    if (attribute.promotionField === 'dimensions') ['length','width','height'].forEach(function (field) { fullInfoDirty['field:' + field] = true; });
    else if (binding && binding.area === 'field') fullInfoDirty['field:' + (attribute.inputId || binding.key)] = true;
    variantStructureEdited = true; markWorkspaceDirty(); renderAttributes(); renderVariants(); note('已恢复原属性，变体内容已保留');
  }
  function mainInfoVariantReason(field) { return field === 'category' && !createMode ? '编辑已有商品不能修改产品类目' : ''; }
  function renderMainInfoPromotionFields() {
    document.querySelectorAll('#mainInfo [data-main-info-variant-add]').forEach(function (button) { button.remove(); });
    [['category','产品类目',-5],['title','标题',-2],['brand','品牌','brand'],['weight','包装重量',-3],['length','包装尺寸',-4]].forEach(function (entry) {
      var input = $(entry[0]), row = input && input.closest('.field'); if (!row) return;
      var index = entry[2] === 'brand' ? attributes.findIndex(isBrandAttribute) : entry[2];
      var active = index != null && index >= -5 && (entry[2] !== 'brand' || index >= 0) && variantAttributeColumns().some(function (column) { return column.index === index; });
      row.hidden = Boolean(active); if (active) return;
      var reason = mainInfoVariantReason(entry[0]), button = document.createElement('button');
      button.type = 'button'; button.className = 'attribute-variant-add product-field-action main-info-variant-add'; button.dataset.mainInfoVariantAdd = entry[0]; button.textContent = '+';
      button.setAttribute('aria-label', '将' + entry[1] + '添加到变体属性中');
      if (reason || index == null || entry[2] === 'brand' && index < 0) { button.classList.add('attribute-variant-unavailable'); button.dataset.actionTooltip = reason || '当前类目没有可用的品牌属性定义'; button.setAttribute('aria-disabled','true'); button.onclick = function () { note(button.dataset.actionTooltip, true); }; }
      else { button.dataset.actionTooltip = '添加到变体属性中'; button.onclick = function () { promoteVariantAttribute(index); }; }
      var host = row.children[1], line = host && host.classList.contains('main-info-action-line') ? host : null;
      if (!line && host) { line = document.createElement('span'); line.className = 'main-info-action-line'; row.insertBefore(line, host); line.appendChild(host); }
      if (line) { line.classList.toggle('main-info-action-wide', ['category','title'].indexOf(entry[0]) >= 0); line.appendChild(button); } else row.appendChild(button);
    });
  }
  function renderPromotionFields() {
    renderMainInfoPromotionFields();
    ['hashtags','description','richContent','barcode'].forEach(function (field) {
      var input = $(field), row = input && input.closest('.field'); if (!row) return;
      var column = promotionColumns().find(function (item) { return item.binding && item.binding.area === 'field' && item.binding.key === field && canPromoteVariantAttribute(item.attribute, item.binding); });
      var previous = row.querySelector('[data-promote-fixed]'); if (previous) previous.remove();
      row.hidden = Boolean(column && variantAttributeColumns().some(function (item) { return item.index === column.index; }));
      if (!column || input.disabled || input.readOnly) return;
      var button = document.createElement('button'); button.type = 'button'; button.className = 'attribute-variant-add product-field-action'; button.dataset.promoteFixed = field; button.textContent = '+'; button.dataset.actionTooltip = '添加到变体属性中'; button.setAttribute('aria-label', '添加到变体属性中');
      button.onclick = function () { promoteVariantAttribute(column.index); };
      var control = row.querySelector('.promotion-field-control');
      if (!control) { control = document.createElement('span'); control.className = 'promotion-field-control'; var host = input; while (host.parentElement !== row) host = host.parentElement; row.insertBefore(control, host); control.appendChild(host); }
      control.appendChild(button);
    });
  }
  function variantAttributeTemplate(column, variant, rowIndex) {
    var attribute = column.attribute, binding = column.binding, value = variantAttributeValue(variant, attribute, binding, rowIndex);
    var readonly = Number(attribute.complexId || attribute.complex_id || attribute.attribute_complex_id) ? ' readonly title="当前编辑命令暂不支持修改复合属性，原值会保留"' : '';
    var className = 'variant-col-dynamic' + (variantAutoAttributeKind(attribute) === 'color' ? ' variant-col-color' : '');
    if (attribute.promotionField === 'category') {
      var selectedKey = String(variant.descriptionCategoryId || '') + ':' + String(variant.typeId || '');
      var options = catalog.map(function (item) { var key = categoryKey(item); return '<option value="' + esc(key) + '"' + (key === selectedKey ? ' selected' : '') + '>' + esc(categoryText(item)) + '</option>'; }).join('');
      if (selectedKey !== ':' && !catalog.some(function (item) { return categoryKey(item) === selectedKey; })) options = '<option value="' + esc(selectedKey) + '" selected>' + esc(variant.category || selectedKey) + '</option>' + options;
      return '<td class="' + className + '"><select data-variant-category data-variant-attribute-index="' + column.index + '" aria-label="第' + (rowIndex + 1) + '行产品类目">' + options + '</select></td>';
    }
    if (attribute.promotionField === 'dimensions') {
      var base = ' data-variant-attribute-index="' + column.index + '" aria-required="true" inputmode="decimal"';
      var dims = '<div class="variant-package-dimensions"><input' + base + ' data-package-dimension="length" value="' + esc(variant.packageLength || '') + '"><i>×</i><input' + base + ' data-package-dimension="width" value="' + esc(variant.packageWidth || '') + '"><i>×</i><input' + base + ' data-package-dimension="height" value="' + esc(variant.packageHeight || '') + '"></div>';
      return '<td class="' + className + '">' + dims + '</td>';
    }
    var field = binding ? ' data-field="' + esc(binding.key) + '"' : '';
    var attrs = ' data-variant-attribute-index="' + column.index + '" data-attribute-index="' + column.index + '"' + field + ' aria-required="' + String(Boolean(attribute.required || attribute.promotionField)) + '"' + readonly;
    var inputType = attribute.promotionField === 'weight' ? ' type="number" min="0" step="1"' : '';
    var editor = binding && ['hashtags','description','richContent'].indexOf(binding.key) >= 0 ? '<textarea' + attrs + '>' + esc(value) + '</textarea>' : '<input' + inputType + attrs + ' value="' + esc(value) + '">';
    if (binding && binding.key === 'richContent') editor += '<button type="button" class="btn" data-variant-rich-editor>编辑富内容</button>';
    return '<td class="' + className + '">' + editor + '<p class="variant-auto-warning" data-variant-auto-warning="' + rowIndex + ':' + column.index + '" hidden></p></td>';
  }
  function storeVariantAttributeInput(row, input) {
    var rowIndex = Number(row.dataset.index), variant = variants[rowIndex], attributeIndex = Number(input.dataset.variantAttributeIndex), attribute = promotionAttribute(attributeIndex);
    if (!variant || !attribute) return;
    if (attribute.promotionField === 'category') { var parts = String(input.value || '').split(':'); variant.descriptionCategoryId = parts[0] || ''; variant.typeId = parts[1] || ''; var match = catalog.find(function (item) { return categoryKey(item) === input.value; }); variant.category = match ? categoryText(match) : String(input.options[input.selectedIndex] && input.options[input.selectedIndex].textContent || ''); return; }
    if (attribute.promotionField === 'dimensions') { var key = input.dataset.packageDimension; if (key === 'length') variant.packageLength = input.value; if (key === 'width') variant.packageWidth = input.value; if (key === 'height') variant.packageHeight = input.value; return; }
    if (attribute.promotionField) { var binding = promotionBinding(attribute, attributeIndex); variant[binding && binding.key || attribute.promotionField] = input.value; return; }
    var key = detailData.attributeKey(attribute), previous = variantAttributeStored(variant, attribute);
    var stored = Object.assign({}, previous || {values: cloneVariantAttribute(attribute.values || [])}, { id: attribute.id, complexId: attribute.complexId || attribute.complex_id || attribute.attribute_complex_id || '', complex_id: attribute.complexId || attribute.complex_id || attribute.attribute_complex_id || 0, collection: Boolean(attribute.collection != null ? attribute.collection : attribute.is_collection), maxValueCount: attribute.maxValueCount != null ? attribute.maxValueCount : attribute.max_value_count });
    attributeFields.setText(stored, input.value);
    variant.attributes = arr(variant.attributes).filter(function (item) { return detailData.attributeKey(item) !== key; }).concat(stored);
    if (rowIndex === 0 && !manualVariantAttributeKeys.has(variantAttributeKey(attribute))) attributeFields.setText(attribute, input.value);
  }
  function renderAttributes() {
    var bindings = sharedBindings();
    var variantIndexes = new Set(variantAttributeColumns().map(function (column) { return column.index; }));
    var indexes = attributes.map(function (_, i) { return i; }).filter(function (i) { return attributes[i].categoryDefined !== false && !attributes[i].variantCategoryOnly && !variantIndexes.has(i) && (!bindings[i] || bindings[i].area === 'variant' && suppressedVariantAttributeKeys.has(variantAttributeKey(attributes[i]))) && !isBrandAttribute(attributes[i]) && !isTypeAttribute(attributes[i]) && !isHashtagsAttribute(attributes[i]); });
    var required = indexes.filter(function (i) { return attributes[i].required; }), optional = indexes.filter(function (i) { return !attributes[i].required; });
    $('attributeGroups').replaceChildren(attributeRows(required));
    $('attributeGroups').hidden = !required.length;
    $('optionalAttributes').replaceChildren(attributeRows(optional));
    $('attributeMoreActions').hidden = !optional.length;
    if (!optional.length) moreAttributesOpen = false;
    updateMoreAttributes();
    if (window.WYERP_PRODUCT_FIELD_HELP) window.WYERP_PRODUCT_FIELD_HELP.attributes(attributes);
    refreshOptionControls(); renderPromotionFields();
  }
  function updateMoreAttributes() {
    $('optionalAttributes').hidden = !moreAttributesOpen;
    $('loadAttributesBtn').setAttribute('aria-expanded', String(moreAttributesOpen));
    $('loadAttributesBtn').textContent = moreAttributesOpen ? '收起更多属性' : '更多属性';
    activateOptionControls();
  }
  function attributeStatus(text, failed) {
    $('attributeState').textContent = text;
    $('attributeLoadStatus').hidden = !text && !$('attributeLoadStatus').querySelector('[data-option-diagnostic-id]');
    $('retryAttributesBtn').hidden = !failed;
  }
  function collectVariants() {
    syncChoiceInputs();
    document.querySelectorAll('#variantBody tr[data-index]').forEach(function (row) {
      var v = variants[Number(row.dataset.index)]; if (!v) return;
      row.querySelectorAll('[data-field]').forEach(function (input) { v[input.dataset.field] = input.dataset.field === 'domesticShipping' ? input.value.trim() : input.value; });
      row.querySelectorAll('[data-variant-attribute-index]').forEach(function (input) { storeVariantAttributeInput(row, input); });
    });
  }
  function syncColorName(input) {
    var index = Number(input.closest('tr').dataset.index), variant = variants[index];
    var a = attributes.find(function (item) { return String(item.id) === '10097'; });
    if (!variant || !a || attributeOptions.kind(a)) return;
    var previous = arr(variant.attributes).find(function (item) { return String(item.id) === '10097'; });
    var stored = Object.assign({ id: '10097', values: [], collection: Boolean(a.collection), complexId: a.complexId || '' }, previous || {});
    attributeFields.setText(stored, input.value);
    variant.colorName = input.value;
    variant.attributes = arr(variant.attributes).filter(function (item) { return String(item.id) !== '10097'; }).concat(stored);
    if (index === 0 && !manualVariantAttributeKeys.has(variantAttributeKey(a))) attributeFields.setText(a, input.value);
  }
  function linkColorName(input, hydrating) {
    if (!input) return;
    var row = input.closest('tr'), target = row && row.querySelector('[data-field="colorName"]');
    var a = attributes.find(function (item) { return String(item.id) === '10096'; });
    var nameAttribute = attributes.find(function (item) { return String(item.id) === '10097'; });
    if (!target || !a) return;
    if (!nameAttribute) {
      var displayControl = optionControls.find(function (item) { return item.input === input; });
      if (displayControl) target.value = window.WYERP_PRODUCT_COLOR_LABELS.selectionName(displayControl.colorSelection()) || '';
      return;
    }
    if (attributeOptions.kind(nameAttribute)) { if (!hydrating) note('颜色名称使用独立字典，请从对应选项中选择俄文名称', true); return; }
    var control = optionControls.find(function (item) { return item.input === input; });
    if (!control) return;
    var selected = control.colorSelection();
    var name = window.WYERP_PRODUCT_COLOR_LABELS.selectionName(selected);
    if (name === null) {
      if (!hydrating) {
        target.value = ''; target.dispatchEvent(new Event('input', { bubbles: true }));
        note('剩余旧颜色尚未匹配俄文字典 ID，颜色名称已清空；请移除旧颜色后重新选择', true);
      }
      return;
    }
    target.value = name;
    // Use the normal editing path to update row attributes, first-row compatibility and dirty flags.
    if (hydrating) syncColorName(target);
    else target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function hydrateColorName(row) {
    var index = Number(row.dataset.index), name = row.querySelector('[data-field="colorName"]');
    var savedRow = arr(product && product.variants)[index];
    var savedClear = product && product.editorDraftId && savedRow && savedRow.colorName === '' && arr(savedRow.attributes).some(function (a) { return String(a.id || a.attribute_id) === '10097' && !attributeFields.text(a); });
    if (name && !name.value.trim() && !savedClear && !fullInfoDirty['variant:' + index + ':colorName']) linkColorName(row.querySelector('[data-field="color"]'), true);
  }
  function mediaImages(v) {
    var images = arr(v.images).slice(); if (v.image && images.indexOf(v.image) < 0) images.unshift(v.image); return images.filter(Boolean);
  }
  window.erpProductDetailVariantImages = function (index) { var variant = variants[Number(index)]; return variant ? mediaImages(variant).slice() : []; };
  window.erpProductDetailApplyVariantImages = function (index, urls) {
    index = Number(index); var variant = variants[index]; if (!variant) return 0;
    var seen = Object.create(null), list = arr(urls).map(function (url) { return String(url || '').trim(); }).filter(function (url) { if (!url || seen[url]) return false; seen[url] = true; return true; }).slice(0, 30);
    variant.images = list.slice(); variant.image = list[0] || '';
    markWorkspaceDirty();
    // SKU图片编辑只改变当前变体的图片集合。禁止为一张图变化重建整张变体表，
    // 否则SKU/组合/视频/动态属性越多，点击图片编辑“确定”越卡。
    if (!refreshVariantImageCell(index)) renderVariants();
    return list.length;
  };
  function imageCell(v) {
    var images = mediaImages(v), visible = images.slice(0, 3);
    if (!visible.length) return '<div class="variant-media-placeholder" aria-label="暂无图片">▧</div><input type="hidden" data-field="image" value="">';
    return '<div class="variant-media-grid">' + visible.map(function (src) { return '<img src="' + esc(src) + '" alt="" loading="lazy">'; }).join('') + (images.length > 3 ? '<span class="variant-more">+' + (images.length - 3) + '</span>' : '') + '</div><input type="hidden" data-field="image" value="' + esc(v.image || images[0]) + '">';
  }
  function refreshVariantImageCell(index) {
    var variant = variants[Number(index)], body = $('variantBody');
    if (!variant || !body) return false;
    var row = body.querySelector('tr[data-index="' + Number(index) + '"]');
    var cell = row && row.querySelector('.variant-col-images');
    if (!cell) return false;
    cell.innerHTML = imageCell(variant);
    return true;
  }
  function isVideoMediaUrl(value) { value = String(value || ''); return /\.(?:mp4|mov|m3u8)(?:[?#]|$)/i.test(value) || /^\/api\/private-objects\/product-videos\/[0-9a-f-]{36}(?:[?#]|$)/i.test(value); }
  function isPrivateGeneratedVideoUrl(value) { return /^\/api\/private-objects\/product-videos\/[0-9a-f-]{36}(?:[?#]|$)/i.test(String(value || '').trim()); }
  function videoCell(value, cover, firstVariant, videoValue) {
    var mode = cover ? 'videoCover' : 'video', preview = '';
    value = String(value || ''); videoValue = String(videoValue || '');
    if (cover && value && !isVideoMediaUrl(value)) preview = '<span class="variant-video-cover-preview variant-video-cover-bg" data-video-cover-url="' + esc(value) + '" role="img" aria-label="视频封面"></span>';
    else {
      var videoPreview = cover ? (isVideoMediaUrl(value) ? value : videoValue) : value;
      if (videoPreview) preview = '<video class="' + (cover ? 'variant-video-cover-preview' : 'variant-video-preview') + '" src="' + esc(videoPreview) + '" muted playsinline disablepictureinpicture preload="metadata" aria-label="' + (cover ? '视频首帧封面预览' : '视频首帧预览') + '"></video>';
    }
    if (!preview) preview = '<span class="variant-media-placeholder variant-video-empty">' + (cover ? '未获取封面' : '未获取视频') + '</span>';
    var canPlay = /<video\b/.test(preview);
    return '<div class="variant-video-shell" data-video-media="' + mode + '" role="button" tabindex="0" title="' + (cover ? '编辑视频封面' : '编辑视频') + '">' + preview + (canPlay ? '<button class="variant-video-play" type="button" data-video-play aria-label="播放视频" title="播放视频">▶</button>' : '') + '</div>';
  }
  function videoPreviewCandidates(video) {
    var duration = Number(video && video.duration), max = Number.isFinite(duration) && duration > .12 ? duration - .05 : 2;
    var raw = [.2, .5, 1];
    if (Number.isFinite(duration) && duration > 0) raw.push(duration * .08, duration * .15, duration * .25);
    var seen = Object.create(null), result = [];
    raw.forEach(function (value) {
      value = Math.max(.05, Math.min(max, Number(value) || .05));
      var key = value.toFixed(3);
      if (!seen[key]) { seen[key] = true; result.push(value); }
    });
    return result.sort(function (a, b) { return a - b; });
  }
  function videoFrameIsDark(video) {
    try {
      if (!video.videoWidth || !video.videoHeight) return null;
      var canvas = document.createElement('canvas'), width = 24, height = 24;
      canvas.width = width; canvas.height = height;
      var context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(video, 0, 0, width, height);
      var data = context.getImageData(0, 0, width, height).data, total = 0, bright = 0, pixels = 0;
      for (var i = 0; i < data.length; i += 16) {
        var luminance = data[i] * .2126 + data[i + 1] * .7152 + data[i + 2] * .0722;
        total += luminance; pixels += 1; if (luminance > 28) bright += 1;
      }
      return pixels ? total / pixels < 20 && bright / pixels < .08 : null;
    } catch (_) { return null; }
  }
  function seekUsefulVideoPreview(video) {
    if (!video || video.dataset.previewScan === 'done') return;
    if (!video.paused) { video.dataset.previewScan = 'done'; return; }
    video.addEventListener('play', function () { video.dataset.previewScan = 'done'; }, {once: true});
    video.dataset.previewScan = 'running';
    var candidates = videoPreviewCandidates(video), index = 0, fallback = candidates[Math.min(1, candidates.length - 1)] || .5;
    function finish(time) {
      if (video.dataset.previewScan !== 'running' || !video.paused) { video.dataset.previewScan = 'done'; return; }
      try { if (Number.isFinite(time)) video.currentTime = time; } catch (_) {}
      video.dataset.previewScan = 'done';
    }
    function seekNext() {
      if (video.dataset.previewScan !== 'running' || !video.paused) { video.dataset.previewScan = 'done'; return; }
      if (index >= candidates.length) { finish(fallback); return; }
      var target = candidates[index++];
      try {
        if (Math.abs(Number(video.currentTime || 0) - target) < .002) inspect();
        else video.currentTime = target;
      } catch (_) { finish(fallback); }
    }
    function inspect() {
      if (video.dataset.previewScan !== 'running' || !video.paused) { video.dataset.previewScan = 'done'; return; }
      var dark = videoFrameIsDark(video);
      if (dark === true) { seekNext(); return; }
      if (dark === null && Number(video.currentTime || 0) < fallback - .01) { finish(fallback); return; }
      finish(Number(video.currentTime || fallback));
    }
    video.addEventListener('seeked', function onSeeked() {
      if (video.dataset.previewScan !== 'running') { video.removeEventListener('seeked', onSeeked); return; }
      inspect();
    });
    seekNext();
  }
  function primeVariantVideoPreviews() {
    $('variantBody').querySelectorAll('[data-video-cover-url]').forEach(function (cover) { cover.style.backgroundImage = 'url(' + JSON.stringify(String(cover.dataset.videoCoverUrl || '')) + ')'; });
    $('variantBody').querySelectorAll('video.variant-video-preview,video.variant-video-cover-preview').forEach(function (video) {
      function prime() { seekUsefulVideoPreview(video); }
      if (video.readyState >= 1) prime(); else video.addEventListener('loadedmetadata', prime, { once: true });
      video.addEventListener('error', function () {
        var shell = video.closest('.variant-video-shell');
        if (!shell || !document.body.contains(shell)) return;
        var fallback = document.createElement('span');
        fallback.className = 'variant-media-placeholder variant-video-empty';
        fallback.textContent = '视频不可播放';
        video.replaceWith(fallback);
        var play = shell.querySelector('[data-video-play]'); if (play) play.remove();
      }, { once: true });
    });
  }
  function toggleVariantVideoPlayback(button) {
    var shell = button && button.closest('.variant-video-shell'), video = shell && shell.querySelector('video');
    if (!video) return;
    video.muted = true; video.playsInline = true; video.dataset.previewScan = 'done';
    if (video.paused || video.ended) {
      var promise = video.play();
      if (promise && promise.then) promise.then(function () { button.textContent = '❚❚'; button.title = '暂停视频'; button.setAttribute('aria-label', '暂停视频'); }).catch(function () { note('视频播放失败，请检查视频地址或格式后重试。', true); });
    } else {
      video.pause(); button.textContent = '▶'; button.title = '播放视频'; button.setAttribute('aria-label', '播放视频');
    }
    video.addEventListener('ended', function () { button.textContent = '▶'; button.title = '播放视频'; button.setAttribute('aria-label', '播放视频'); }, { once: true });
  }
  var skuVideoEditorState = { index: -1, mode: 'video', objectUrl: '' };
  function clearSkuVideoObjectUrl() {
    if (!skuVideoEditorState.objectUrl) return;
    try { URL.revokeObjectURL(skuVideoEditorState.objectUrl); } catch (_) {}
    skuVideoEditorState.objectUrl = '';
  }
  function renderSkuVideoEditorPreview(url) {
    var host = $('skuVideoEditorPreview'); host.replaceChildren(); host.hidden = true;
    url = String(url || '').trim();
    if (!url) return;
    var node;
    if (skuVideoEditorState.mode === 'video' || isVideoMediaUrl(url) || /^blob:/i.test(url)) {
      node = document.createElement('video'); node.src = url; node.muted = true; node.playsInline = true; node.preload = 'metadata'; node.controls = true;
      node.addEventListener('loadedmetadata', function () { seekUsefulVideoPreview(node); }, { once: true });
      node.addEventListener('error', function () { $('skuVideoEditorNote').textContent = '视频播放失败，请检查视频地址或格式后重试。'; }, {once: true});
    } else {
      node = document.createElement('img'); node.src = url; node.alt = '视频封面预览';
    }
    host.appendChild(node); host.hidden = false;
  }
  function openSkuVideoEditor(index, mode) {
    collectVariants();
    var variant = variants[index]; if (!variant) return;
    clearSkuVideoObjectUrl();
    skuVideoEditorState.index = index; skuVideoEditorState.mode = mode === 'videoCover' ? 'videoCover' : 'video';
    var coverMode = skuVideoEditorState.mode === 'videoCover', value = String(variant[skuVideoEditorState.mode] || '');
    $('skuVideoEditorTitle').textContent = coverMode ? 'SKU视频封面编辑' : 'SKU视频编辑';
    var headNote = document.querySelector('.sku-video-head-note'); if (headNote) headNote.textContent = coverMode ? 'JPG/PNG/WEBP · 支持 MP4/MOV 首帧 · 保存商品后才提交' : '无需先保存 · MP4/MOV · ≤ 20 MB · ≤ 30 秒 · 服装竖版/其它方形';
    $('skuVideoUploadBtn').innerHTML = coverMode ? '↥&nbsp; 上传封面' : '↥&nbsp; 上传视频';
    $('skuVideoUploadInput').accept = coverMode ? 'image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp,video/mp4,video/quicktime,.mp4,.mov' : 'video/mp4,video/quicktime,.mp4,.mov';
    $('skuVideoUrlInput').placeholder = coverMode ? '输入视频封面 URL 地址' : '输入视频 URL 地址';
    $('skuVideoUrlInput').value = value;
    var rulesNode = $('skuVideoEditorRules'); if (rulesNode) rulesNode.textContent = coverMode ? 'JPG / PNG / WEBP · 也支持 MP4 / MOV 首帧 · 已有人工封面不会覆盖' : 'MP4 / MOV · ≤ 20 MB · ≤ 30 秒 · 服装建议竖版，其它类目建议方形';
    $('skuVideoEditorNote').textContent = coverMode && !value && variant.video ? '当前未填写独立封面，列表已使用视频首帧预览。' : '';
    renderSkuVideoEditorPreview(value || (coverMode ? variant.video : ''));
    var dialog = $('skuVideoEditorDialog'); if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function applySkuVideoEditor() {
    var index = skuVideoEditorState.index, mode = skuVideoEditorState.mode, variant = variants[index];
    if (!variant) return;
    var value = $('skuVideoUrlInput').value.trim();
    if (value && !/^(?:https?:)?\/\//i.test(value) && !isPrivateGeneratedVideoUrl(value)) { $('skuVideoEditorNote').textContent = '请填写可访问的网络URL地址，或使用本页生成的视频'; return; }
    variant[mode] = value;
    var otherMode = mode === 'video' ? 'videoCover' : 'video';
    if (value && isVideoMediaUrl(value) && !String(variant[otherMode] || '').trim()) variant[otherMode] = value;
    var row = $('variantBody').querySelector('tr[data-index="' + index + '"]');
    [mode, otherMode].forEach(function (key) {
      if (!row) return;
      var input = row.querySelector('[data-field="' + key + '"]'); if (!input) return;
      input.value = variant[key] || '';
      fullInfoDirty['variant:' + index + ':' + key] = true;
      if (index === 0) {
        sharedDirty['media:' + key] = true;
        var attribute = mediaAttribute(key); if (attribute) { attributeFields.setText(attribute, input.value); fullInfoDirty['attribute:' + detailData.attributeKey(attribute)] = true; }
      }
    });
    markWorkspaceDirty();
    clearSkuVideoObjectUrl();
    $('skuVideoEditorDialog').close();
    renderVariants();
    note((mode === 'videoCover' ? '视频封面' : '视频') + '已更新；保存商品后才会提交平台。');
  }
  function handleSkuVideoUpload(file) {
    clearSkuVideoObjectUrl();
    if (!file) return;
    var coverMode = skuVideoEditorState.mode === 'videoCover';
    if (!coverMode && !/^(video\/mp4|video\/quicktime)$/i.test(file.type || '') && !/\.(mp4|mov)$/i.test(file.name || '')) { $('skuVideoEditorNote').textContent = '视频仅支持 MP4、MOV'; return; }
    if (!coverMode && file.size > 20 * 1024 * 1024) { $('skuVideoEditorNote').textContent = '视频大小不能超过20MB'; return; }
    if (coverMode && !/^image\/(jpeg|png|webp)$/i.test(file.type || '') && !/^(video\/mp4|video\/quicktime)$/i.test(file.type || '')) { $('skuVideoEditorNote').textContent = '封面仅支持 JPG、PNG、WEBP；也可选择 MP4/MOV 查看首帧'; return; }
    skuVideoEditorState.objectUrl = URL.createObjectURL(file);
    renderSkuVideoEditorPreview(skuVideoEditorState.objectUrl);
    if (!coverMode && /^video\//i.test(file.type || '')) {
      var probe = document.createElement('video'); probe.preload = 'metadata'; probe.src = skuVideoEditorState.objectUrl;
      probe.addEventListener('loadedmetadata', function () { $('skuVideoEditorNote').textContent = probe.duration > 30 ? '视频超过30秒，不能使用；请选择更短的视频。' : '本地视频预览已加载；当前项目尚未接入视频文件持久上传，请填写正式视频URL后确认。'; }, { once: true });
    } else $('skuVideoEditorNote').textContent = '本地文件预览已加载；当前项目尚未接入媒体文件持久上传，请填写正式URL后确认。';
  }
  function sizeOfferField(input) {
    input.value = input.value.replace(/[\r\n]/g, '');
    input.title = input.value;
  }
  function generateMissingOfferIds() {
    if (!createMode) return 0;
    collectVariants();
    var missing = variants.map(function (variant, index) { return String(variant && variant.offerId || '').trim() ? -1 : index; }).filter(function (index) { return index >= 0; });
    if (!missing.length) return 0;
    try {
      var generated = window.WYERP_PRODUCT_ARTICLE_GENERATOR.generate(missing.length);
      missing.forEach(function (index, offset) {
        var value = generated.values[offset], row = $('variantBody').querySelector('tr[data-index="' + index + '"]'), input = row && row.querySelector('[data-field="offerId"]');
        variants[index].offerId = value;
        fullInfoDirty['variant:' + index + ':offerId'] = true;
        if (input) { input.value = value; sizeOfferField(input); }
      });
      return missing.length;
    } catch (_) { return 0; }
  }
  function generateOfferIds() {
    if (!createMode) return;
    collectVariants();
    try {
      var generated = window.WYERP_PRODUCT_ARTICLE_GENERATOR.generate(variants.length);
      $('variantBody').querySelectorAll('tr[data-index]').forEach(function (row, index) {
        var value = generated.values[index], input = row.querySelector('[data-field="offerId"]');
        variants[index].offerId = value;
        fullInfoDirty['variant:' + index + ':offerId'] = true;
        input.value = value;
        sizeOfferField(input);
      });
      note('已生成 ' + generated.values.length + ' 个货号；同组随机字母 ' + generated.letters + '，尾号从 0001 递增');
    } catch (error) {
      note(error.message || '随机货号生成失败', true);
    }
  }
  function variantHeadTitle(label, options) {
    options = options || {};
    var attrs = options.field ? ' data-variant-field="' + esc(options.field) + '"' : options.attributeIndex != null ? ' data-variant-attribute-head="' + options.attributeIndex + '"' : '';
    var suffix = [];
    if (options.required) suffix.push('<span class="variant-required-mark" title="必填">*</span>');
    if (options.aspect) suffix.push('<span class="variant-aspect-mark" title="该属性可用于区分多SKU" aria-label="该属性可用于区分多SKU">SKU</span>');
    if (options.removeIndex != null) suffix.push('<button class="variant-column-remove" type="button" data-remove-variant-attribute="' + options.removeIndex + '" title="取消变体属性" aria-label="取消' + esc(label) + '变体属性">×</button>');
    return '<span class="variant-head-title"' + attrs + '><span class="variant-head-center"><span class="variant-head-label">' + esc(label) + '</span><span class="variant-head-suffix">' + suffix.join('') + '</span></span></span>';
  }
  function sameFirstAction(token, disabled) {
    return '<span class="variant-head-actions"><button class="variant-head-action" type="button" data-same-first="' + esc(token) + '"' + (disabled ? ' disabled' : '') + '>同首行</button></span>';
  }
  function cloneVariantAttribute(attribute) { return attribute ? JSON.parse(JSON.stringify(attribute)) : null; }
  function copyFirstVariantColumn(token) {
    if (!variants.length || variants.length < 2) { note('当前只有一个SKU，不需要执行同首行'); return; }
    collectVariants();
    var first = variants[0];
    if (token === 'images') {
      variants.slice(1).forEach(function (variant) { variant.images = arr(first.images).slice(); variant.image = first.image || variant.images[0] || ''; });
    } else if (/^field:/.test(token)) {
      var field = token.slice(6);
      if (field === 'offerId' || field === 'name' || field === 'sku') return;
      variants.slice(1).forEach(function (variant, offset) { variant[field] = first[field]; fullInfoDirty['variant:' + (offset + 1) + ':' + field] = true; });
    } else if (/^attribute:/.test(token)) {
      var attributeIndex = Number(token.slice(10)), attribute = promotionAttribute(attributeIndex), binding = promotionBinding(attribute, attributeIndex);
      if (!attribute) return;
      if (attribute.promotionField === 'dimensions') {
        variants.slice(1).forEach(function (variant, offset) { variant.packageLength = first.packageLength; variant.packageWidth = first.packageWidth; variant.packageHeight = first.packageHeight; fullInfoDirty['variant:' + (offset + 1) + ':dimensions'] = true; });
        variantStructureEdited = true; markWorkspaceDirty(); renderVariants(); note('已将第一行内容同步到后续SKU'); return;
      }
      var source = variantAttributeStored(first, attribute);
      if (!source && variantAttributeValue(first, attribute, binding, 0)) {
        source = { id: attribute.id, complexId: attribute.complexId || attribute.complex_id || attribute.attribute_complex_id || '', complex_id: attribute.complexId || attribute.complex_id || attribute.attribute_complex_id || 0, collection: Boolean(attribute.collection != null ? attribute.collection : attribute.is_collection), maxValueCount: attribute.maxValueCount != null ? attribute.maxValueCount : attribute.max_value_count };
        attributeFields.setText(source, variantAttributeValue(first, attribute, binding, 0));
      }
      variants.slice(1).forEach(function (variant, offset) {
        variant.attributes = arr(variant.attributes).filter(function (item) { return detailData.attributeKey(item) !== detailData.attributeKey(attribute); });
        if (source && !attribute.promotionField) variant.attributes.push(cloneVariantAttribute(source));
        if (binding) variant[binding.key] = first[binding.key] == null ? source ? attributeFields.text(source) : '' : first[binding.key];
        if (!attribute.promotionField) fullInfoDirty['attribute:' + detailData.attributeKey(attribute)] = true;
        if (binding) fullInfoDirty['variant:' + (offset + 1) + ':' + binding.key] = true;
      });
    }
    variantStructureEdited = true; markWorkspaceDirty(); renderVariants(); note('已将第一行内容同步到后续SKU');
  }
  function variantAutoAttributeKind(attribute) {
    var id = String(attribute && (attribute.id || attribute.attribute_id) || ''), label = [attribute && attribute.name, attribute && attribute.nameRu, attribute && attribute.nameEn].filter(Boolean).join(' ');
    if (id === '10096' || /颜色|色彩|цвет/i.test(label)) return 'color';
    if (/尺寸|尺码|大小|规格|长度|宽度|高度|直径|容量|size|размер|длин|ширин|высот|диаметр|об[ъь]?[её]м/i.test(label)) return 'size';
    return '';
  }
  function variantAutoSourceText(variant) { return [variant && variant.name, variant && variant.sourceSpecText].filter(Boolean).join(' · ').trim(); }
  function autoTextCompact(value) { return String(value == null ? '' : value).toLowerCase().replace(/[\s\-_/|,，.。:：;；()（）\[\]{}]+/g, ''); }
  function regexEscape(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function sourceSizeTokens(source) {
    var result = [], seen = Object.create(null), text = String(source || '');
    function add(value) { value = String(value || '').trim(); var key = value.toLowerCase().replace(/\s+/g, ''); if (value && !seen[key]) { seen[key] = true; result.push(value); } }
    var alpha = text.match(/(?:^|[^A-Za-z0-9])(?:XXXS|XXS|XS|S|M|L|XL|XXL|XXXL)(?=$|[^A-Za-z0-9])/ig) || [];
    alpha.forEach(function (value) { add(value.replace(/[^A-Za-z]/g, '')); });
    var units = text.match(/\d+(?:\.\d+)?\s*(?:毫米|厘米|公分|米|码|英寸|寸|mm|cm|inch|in)(?![A-Za-z])/ig) || [];
    units.forEach(add);
    return result;
  }
  function optionMatchesVariantSource(source, item, kind) {
    var candidates = [item && item.labelZh, item && item.label, item && item.value].filter(Boolean), compactSource = autoTextCompact(source);
    if (kind === 'size') {
      var sizeTokens = sourceSizeTokens(source).map(autoTextCompact);
      return candidates.some(function (candidate) {
        var compact = autoTextCompact(candidate);
        if (!compact) return false;
        if (/^[a-z]{1,5}$/i.test(String(candidate).trim())) return new RegExp('(^|[^a-z0-9])' + regexEscape(String(candidate).trim()) + '($|[^a-z0-9])', 'i').test(String(source));
        return sizeTokens.some(function (token) { return token === compact || token.replace(/[^0-9.]/g, '') && token.replace(/[^0-9.]/g, '') === compact.replace(/[^0-9.]/g, ''); });
      });
    }
    return candidates.some(function (candidate) { var compact = autoTextCompact(candidate); return compact.length >= 2 && compactSource.indexOf(compact) >= 0; });
  }
  function sourceHasAutoSignal(source, kind) {
    source = String(source || '');
    if (kind === 'color') return /色|颜色|цвет/i.test(source);
    return sourceSizeTokens(source).length > 0 || /尺寸|尺码|размер|size/i.test(source);
  }
  function setVariantAutoWarning(rowIndex, attributeIndex, message) {
    var key = rowIndex + ':' + attributeIndex;
    if (message) variantAutoWarnings[key] = message; else delete variantAutoWarnings[key];
  }
  function renderVariantAutoWarnings() {
    $('variantBody').querySelectorAll('[data-variant-auto-warning]').forEach(function (node) {
      var text = variantAutoWarnings[node.dataset.variantAutoWarning] || '';
      node.textContent = text; node.hidden = !text;
    });
  }
  function applyAutoVariantSelection(column, rowIndex, item) {
    var attribute = column.attribute, binding = column.binding, variant = variants[rowIndex], previous = variantAttributeStored(variant, attribute);
    if (!variant || !attribute) return;
    var stored = Object.assign({}, previous || {values: cloneVariantAttribute(attribute.values || [])}, { id: attribute.id, collection: Boolean(attribute.collection != null ? attribute.collection : attribute.is_collection), maxValueCount: attribute.maxValueCount != null ? attribute.maxValueCount : attribute.max_value_count, complexId: attribute.complexId || attribute.attribute_complex_id || '', complex_id: attribute.complexId || attribute.complex_id || attribute.attribute_complex_id || 0 });
    attributeOptions.applySelection(stored, [item]);
    variant.attributes = arr(variant.attributes).filter(function (entry) { return detailData.attributeKey(entry) !== detailData.attributeKey(attribute); }).concat(stored);
    if (binding && binding.area === 'variant') variant[binding.key] = attributeFields.text(stored);
    if (rowIndex === 0 && !manualVariantAttributeKeys.has(variantAttributeKey(attribute))) attributeOptions.applySelection(attribute, [item]);
    fullInfoDirty['attribute:' + detailData.attributeKey(attribute)] = true;
    if (binding && binding.area === 'variant') fullInfoDirty['variant:' + rowIndex + ':' + binding.key] = true;
  }
  function applyAutoVariantText(column, rowIndex, value) {
    var attribute = column.attribute, binding = column.binding, variant = variants[rowIndex], previous = variantAttributeStored(variant, attribute);
    if (!variant || !attribute) return;
    var stored = Object.assign({}, previous || {values: cloneVariantAttribute(attribute.values || [])}, { id: attribute.id, complexId: attribute.complexId || attribute.attribute_complex_id || '', complex_id: attribute.complexId || attribute.complex_id || attribute.attribute_complex_id || 0 });
    attributeFields.setText(stored, value);
    variant.attributes = arr(variant.attributes).filter(function (entry) { return detailData.attributeKey(entry) !== detailData.attributeKey(attribute); }).concat(stored);
    if (binding && binding.area === 'variant') variant[binding.key] = value;
    if (rowIndex === 0 && !manualVariantAttributeKeys.has(variantAttributeKey(attribute))) attributeFields.setText(attribute, value);
    fullInfoDirty['attribute:' + detailData.attributeKey(attribute)] = true;
    if (binding && binding.area === 'variant') fullInfoDirty['variant:' + rowIndex + ':' + binding.key] = true;
  }
  function runAutoVariantRecognition() {
    if (variantAutoRecognitionBusy) return Promise.resolve(false);
    var context = currentOptionContext(); if (!context) return Promise.resolve(false);
    collectVariants(); variantAutoRecognitionBusy = true; variantAutoWarnings = Object.create(null);
    var columns = variantAttributeColumns().filter(function (column) { return column.attribute.aspect && variantAutoAttributeKind(column.attribute); });
    if (!columns.length) { variantAutoRecognitionBusy = false; note('当前类目没有可自动识别的颜色/尺寸SKU属性'); return Promise.resolve(false); }
    var button = $('recognizeVariantAttributesBtn'); button.disabled = true; button.setAttribute('aria-busy', 'true');
    var sourceByRef = new Map(variants.map(function (variant) { return [variant.erpVariantRef, variantAutoSourceText(variant)]; }));
    function editable(column, variant, rowIndex) {
      var input = $('variantBody').querySelector('tr[data-index="' + rowIndex + '"] [data-variant-attribute-index="' + column.index + '"]');
      return (!context.alive || context.alive()) && attributes[column.index] === column.attribute && !suppressedVariantAttributeKeys.has(variantAttributeKey(column.attribute)) && sourceByRef.get(variant.erpVariantRef) === variantAutoSourceText(variant) && input && !input.readOnly && !input.disabled;
    }
    var changed = 0, uncertain = 0;
    return Promise.all(columns.map(function (column) {
      var attribute = column.attribute, kind = variantAutoAttributeKind(attribute), dictionaryKind = attributeOptions.kind(attribute);
      if (dictionaryKind) {
        return optionLoader.load(attribute, context, { cursor: 0 }).then(function (page) {
          if (context.alive && !context.alive() || suppressedVariantAttributeKeys.has(variantAttributeKey(attribute))) return;
          collectVariants();
          variants.forEach(function (variant, rowIndex) {
            if (!editable(column, variant, rowIndex)) return;
            var source = variantAutoSourceText(variant), existing = variantAttributeValue(variant, attribute, column.binding, rowIndex).trim();
            if (!source || existing) return;
            var matches = arr(page && page.items).filter(function (item) { return optionMatchesVariantSource(source, item, kind); });
            if (matches.length === 1) { applyAutoVariantSelection(column, rowIndex, matches[0]); changed++; setVariantAutoWarning(rowIndex, column.index, ''); }
            else if (matches.length > 1 || sourceHasAutoSignal(source, kind)) { uncertain++; setVariantAutoWarning(rowIndex, column.index, matches.length > 1 ? '识别到多个可能值，请手动确认' : '已识别到颜色/尺寸线索，但未能唯一匹配，请手动设置'); }
          });
        }).catch(function () {
          variants.forEach(function (variant, rowIndex) { if (!editable(column, variant, rowIndex)) return; var source = variantAutoSourceText(variant); if (sourceHasAutoSignal(source, kind)) { uncertain++; setVariantAutoWarning(rowIndex, column.index, '自动读取官方选项失败，请手动设置'); } });
        });
      }
      if (kind === 'size') variants.forEach(function (variant, rowIndex) {
        if (!editable(column, variant, rowIndex)) return;
        var source = variantAutoSourceText(variant), existing = variantAttributeValue(variant, attribute, column.binding, rowIndex).trim(), tokens = sourceSizeTokens(source);
        if (!source || existing || !tokens.length) return;
        if (tokens.length === 1) { var value = tokens[0]; if (/厘米|cm/i.test(String(attribute.name || ''))) value = value.replace(/\s*(?:厘米|公分|cm)$/i, ''); if (/毫米|mm/i.test(String(attribute.name || ''))) value = value.replace(/\s*(?:毫米|mm)$/i, ''); applyAutoVariantText(column, rowIndex, value); changed++; }
        else { uncertain++; setVariantAutoWarning(rowIndex, column.index, '识别到多个尺寸，请手动确认'); }
      });
      return Promise.resolve();
    })).then(function () {
      if (context.alive && !context.alive()) return false;
      if (changed) { variantStructureEdited = true; markWorkspaceDirty(); renderVariants(); }
      else renderVariantAutoWarnings();
      note(changed ? '已自动匹配 ' + changed + ' 个颜色/尺寸值' + (uncertain ? '；另有 ' + uncertain + ' 项需要手动确认' : '') : uncertain ? '自动识别完成，但有 ' + uncertain + ' 项需要手动确认' : 'SKU名称和货源规格中没有可用的颜色/尺寸信息');
      return changed > 0;
    }).finally(function () { variantAutoRecognitionBusy = false; button.disabled = false; button.removeAttribute('aria-busy'); });
  }
  function bundleIdForCollection(item) { return 'bundle:' + String(item && item.id || ''); }
  function collectionImageCandidates(item) {
    var capture = item && item.capture && typeof item.capture === 'object' ? item.capture : {}, result = [], seen = new Set();
    function add(value) { var url = String(value || '').trim(); if (!/^https:\/\//i.test(url) || seen.has(url)) return; seen.add(url); result.push(url); }
    add(item && item.image); arr(item && item.images).forEach(add);
    arr(capture.skuImages).forEach(function (entry) { add(entry && (entry.url || entry.imageUrl)); });
    arr(capture.variants).forEach(function (entry) { add(entry && (entry.imageUrl || entry.image || entry.thumbnailUrl || entry.url)); });
    if (capture.primarySkuImage) add(capture.primarySkuImage.url || capture.primarySkuImage.imageUrl);
    arr(capture.media).forEach(function (entry) { if (entry && String(entry.kind || '').toLowerCase() === 'image') add(entry.url || entry.src); });
    return result.slice(0, 60);
  }
  function compactCollectionSnapshot(item) {
    var capture = item && item.capture && typeof item.capture === 'object' ? item.capture : {}, reviews = arr(capture.review && capture.review.variants), packageInfo = collectionModel.packageSummary(item || {}), productWeightG = Number(packageInfo && packageInfo.weightG) || 0;
    var productOfferId = String(item && (item.offerId || item.offer_id || item.article || item.itemId || item.productId) || capture.offerId || capture.offer_id || capture.article || capture.itemId || capture.productId || '').trim();
    if (!productOfferId) { var attr = arr(capture.attributes).find(function (entry) { return /^货号$/i.test(String(entry && (entry.name || entry.label) || '').trim()); }); productOfferId = String(attr && (attr.value || attr.text) || '').trim(); }
    return { title: String(item && item.title || ''), source: String(item && item.source || ''), category: String(item && item.category || ''), updatedAt: String(item && item.updatedAt || ''), variants: arr(capture.variants).slice(0, 80).map(function (entry, variantIndex) { var skuId = String(entry && (entry.skuId || entry.sku || entry.sku_id) || '').trim(), label = String(entry && entry.label || ''), review = reviews.find(function (row) { return row && ((skuId && String(row.skuId || '') === skuId) || (label && String(row.label || '') === label)); }) || {}, weightG = Number(review.packagingWeight && review.packagingWeight.grams) || Number(entry && entry.packagingWeight && entry.packagingWeight.grams) || Number(entry && entry.weightG) || productWeightG || 0, dims = review.packagingDimensions || entry && entry.packagingDimensions || {}, lengthMm = Number(dims.lengthMm || dims.length || packageInfo.lengthMm) || 0, widthMm = Number(dims.widthMm || dims.width || packageInfo.widthMm) || 0, heightMm = Number(dims.heightMm || dims.height || packageInfo.heightMm) || 0, offerId = String(entry && (entry.offerId || entry.offer_id || entry.article || entry.itemId || entry.productId) || productOfferId || '').trim(); return { combinationRowKey:'row:' + String(variantIndex + 1), skuId: skuId, offerId: offerId, weightG: weightG || '', lengthMm:lengthMm||'', widthMm:widthMm||'', heightMm:heightMm||'', label: label, imageUrl: String(entry && (entry.imageUrl || entry.image || entry.thumbnailUrl) || '') }; }) };
  }
  function sourceBundleFromCollection(item, existing) {
    var draft = collectionModel.createDraft(item), images = collectionImageCandidates(item), id = bundleIdForCollection(item), now = new Date().toISOString(), previous = existing || bundleById(id), preferredImage = previous && images.indexOf(previous.referenceImage) >= 0 ? previous.referenceImage : images[0] || '';
    var snapshot = compactCollectionSnapshot(item), previousVariants = arr(previous && previous.sourceSnapshot && previous.sourceSnapshot.variants), previousByRowKey = new Map(previousVariants.map(function (entry, index) { return [String(entry && entry.combinationRowKey || 'row:' + String(index + 1)), entry]; })), previousSelectionInitialized = Boolean(previous && previous.sourceSnapshot && previous.sourceSnapshot.variantSelectionInitialized);
    snapshot.referenceImageManual = Boolean(previous && previous.sourceSnapshot && previous.sourceSnapshot.referenceImageManual);
    snapshot.variants = arr(snapshot.variants).map(function (entry, index) { var rowKey = String(entry && entry.combinationRowKey || 'row:' + String(index + 1)), old = previousByRowKey.get(rowKey); if (!old) return entry; return Object.assign({}, entry, { imageUrl: old.imageUrl || entry.imageUrl || '', weightG: entry.weightG || old.weightG || '', lengthMm:entry.lengthMm||old.lengthMm||'', widthMm:entry.widthMm||old.widthMm||'', heightMm:entry.heightMm||old.heightMm||'', combinationQuantity: old.combinationQuantity, combinationPurchaseCost: old.combinationPurchaseCost, combinationDomesticShipping: old.combinationDomesticShipping == null || String(old.combinationDomesticShipping).trim() === '' ? (old.combinationDomesticFreight == null ? old.combinationInternationalShipping : old.combinationDomesticFreight) : old.combinationDomesticShipping, combinationDomesticShippingManual: old.combinationDomesticShippingManual === true || old.combinationDomesticFreight != null || old.combinationInternationalShipping != null }); });
    var validVariantIds = arr(snapshot.variants).map(function (entry) { return String(entry && entry.skuId || ''); }).filter(Boolean), validRowKeys = arr(snapshot.variants).map(function (entry, index) { return String(entry && entry.combinationRowKey || 'row:' + String(index + 1)); }), previousVariantIds = arr(previous && previous.selectedVariantIds).map(String).filter(function (id) { return validVariantIds.indexOf(id) >= 0; }), previousRowKeys = arr(previous && previous.sourceSnapshot && previous.sourceSnapshot.selectedVariantKeys).map(String).filter(function (key) { return validRowKeys.indexOf(key) >= 0; }), selectedVariantIds = previous ? (previousSelectionInitialized || previousVariantIds.length ? previousVariantIds : validVariantIds) : []; snapshot.selectedVariantKeys = previous ? (previousSelectionInitialized ? previousRowKeys : validRowKeys) : []; snapshot.variantSelectionInitialized = true; return normalizeSourceBundle({ id: id, collectionId: String(item.id || ''), title: String(item.title || ''), sourceUrl: String(item.sourceUrl || ''), purchase: draft.srcPrice == null ? '' : String(draft.srcPrice), domesticShipping: draft.domesticShipping == null ? '' : String(draft.domesticShipping), referenceImage: preferredImage, imageCandidates: images, selectedVariantIds: selectedVariantIds, sourceSnapshot: snapshot, createdAt: previous && previous.createdAt || now, updatedAt: String(item.updatedAt || now), lastCombinedAt: previous && previous.lastCombinedAt || now }, sourceBundles.length);
  }
  function bundleById(id) { return sourceBundles.find(function (bundle) { return String(bundle.id) === String(id); }) || null; }
  function collectionRecordForBundle(bundle) { var id = String(bundle && bundle.collectionId || ''); return id ? combinationPickerState.records.find(function (item) { return String(item && item.id || '') === id; }) || null : null; }
  function bundleSourceState(bundle) {
    if (bundle && !bundle.collectionId) return { code: 'unassigned', label: '待分配组合' };
    if (!bundle || !combinationContextLoaded) return { code: 'current', label: '' };
    var record = collectionRecordForBundle(bundle); if (!record) return { code: 'missing', label: '来源记录缺失' };
    var currentUrl = String(record.sourceUrl || '').trim(), savedUrl = String(bundle.sourceUrl || '').trim();
    if (!/^https?:\/\//i.test(currentUrl)) return { code: 'link-risk', label: '货源链接可能失效' };
    var snapshotAt = Date.parse(bundle.sourceSnapshot && bundle.sourceSnapshot.updatedAt || '') || 0, currentAt = Date.parse(record.updatedAt || '') || 0;
    if ((savedUrl && currentUrl !== savedUrl) || (currentAt && (!snapshotAt || currentAt > snapshotAt))) return { code: 'stale', label: '来源数据有更新' };
    return { code: 'current', label: '' };
  }
  function refreshCombinationBundle(bundleId) {
    var at = sourceBundles.findIndex(function (bundle) { return String(bundle.id) === String(bundleId); }); if (at < 0) return;
    var record = collectionRecordForBundle(sourceBundles[at]); if (!record) { note('来源记录缺失，无法刷新组合快照；组合关系已保留，请先恢复对应采集箱记录。', true); return; }
    sourceBundles[at] = sourceBundleFromCollection(record, sourceBundles[at]); markSourceBundlesDirty(); renderSourceBundles(); renderVariants(); note('组合快照已按采集箱最新来源数据刷新。');
  }
  function collectionCombinationSummary(record) {
    var ref = 'collection:' + String(record && record.id || ''), relations = allCombinationRelations(), incoming = relations.filter(function (relation) { return relation.childRef === ref || String(relation.childCollectionId || '') === String(record && record.id || ''); }), outgoing = outgoingCombinationRelations(ref);
    return { active: Boolean(incoming.length || outgoing.length), incoming: incoming.length, outgoing: outgoing.length, nested: outgoing.length > 0 };
  }
  function parentCombinationRef(variant) { return variant && variant.erpVariantRef ? 'variant:' + variant.erpVariantRef : ''; }
  function relationKey(relation) { return String(relation.parentRef || '') + '\u0000' + String(relation.childRef || ''); }
  function mergedCombinationRelations(excludeParentRef) {
    var map = new Map();
    arr(combinationPickerState.globalRelations).concat(arr(combinationRelations)).forEach(function (relation) { if (!relation || relation.parentRef === excludeParentRef) return; map.set(relationKey(relation), relation); });
    return Array.from(map.values());
  }
  function allCombinationRelations() {
    var map = new Map();
    arr(combinationPickerState.globalRelations).concat(arr(combinationRelations)).forEach(function (relation) { if (relation) map.set(relationKey(relation), relation); });
    return Array.from(map.values());
  }
  function combinationBundleForRef(ref) {
    ref = String(ref || ''); if (!ref.startsWith('collection:')) return null;
    var collectionId = ref.slice('collection:'.length), bundle = sourceBundles.find(function (item) { return String(item.collectionId || '') === collectionId; });
    if (bundle) return bundle;
    var record = combinationPickerState.records.find(function (item) { return String(item.id || '') === collectionId; });
    return record ? sourceBundleFromCollection(record) : null;
  }
  function formatCombinationMoney(value) { var n = Number(value); if (!Number.isFinite(n)) return '--'; return n.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'); }
  function combinationSelectedVariantEntries(bundle) {
    var snapshot = arr(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.variants), selectedKeys = new Set(arr(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.selectedVariantKeys).map(String));
    return snapshot.filter(function (entry, index) { return selectedKeys.has(String(entry && entry.combinationRowKey || 'row:' + String(index + 1))); });
  }
  function combinationPrimaryImage(bundle) {
    var manual = Boolean(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.referenceImageManual), reference = String(bundle && bundle.referenceImage || '').trim(), selected = combinationSelectedVariantEntries(bundle), selectedImage = selected.map(function (entry) { return String(entry && entry.imageUrl || '').trim(); }).find(Boolean);
    return (manual && reference ? reference : selectedImage) || reference || String(arr(bundle && bundle.imageCandidates)[0] || '').trim();
  }
  function combinationVariantCostSummary(bundle, fallbackQuantity) {
    if (!bundle) return { hasVariants:false, selectedCount:0, totalQuantity:0, purchase:0, domesticShipping:0, total:0 };
    var snapshot = arr(bundle.sourceSnapshot && bundle.sourceSnapshot.variants), validSnapshot = snapshot.filter(function (entry) { return entry && typeof entry === 'object'; }), selectionInitialized = Boolean(bundle.sourceSnapshot && bundle.sourceSnapshot.variantSelectionInitialized), selectedKeys = new Set(arr(bundle.sourceSnapshot && bundle.sourceSnapshot.selectedVariantKeys).map(String));
    if (!validSnapshot.length || !selectionInitialized) return { hasVariants:false, selectedCount:0, totalQuantity:Math.max(1,Number(fallbackQuantity)||1), purchase:combinationEditablePurchaseCost(bundle), domesticShipping:Number(bundle.domesticShipping)||0, total:combinationEditablePurchaseCost(bundle)+(Number(bundle.domesticShipping)||0) };
    snapshot = validSnapshot;
    var defaultPurchase = Number(bundle.purchase)||0, defaultDomestic = Number(bundle.domesticShipping)||0, purchase = 0, domesticShipping = 0, totalQuantity = 0, selectedCount = 0;
    snapshot.forEach(function (entry, index) { var rowKey = String(entry && entry.combinationRowKey || 'row:' + String(index + 1)); if (!selectedKeys.has(rowKey)) return; selectedCount += 1; var quantity = Math.max(1,Math.min(9999,Math.floor(Number(entry.combinationQuantity)||Number(fallbackQuantity)||1))), purchaseCost = String(entry.combinationPurchaseCost == null ? '' : entry.combinationPurchaseCost).trim() === '' ? defaultPurchase : Math.max(0,Number(entry.combinationPurchaseCost)||0), domesticRaw = String(entry.combinationDomesticShipping == null ? '' : entry.combinationDomesticShipping).trim(), legacyFreight = entry.combinationDomesticFreight == null ? entry.combinationInternationalShipping : entry.combinationDomesticFreight, domestic = domesticRaw !== '' ? Math.max(0,Number(domesticRaw)||0) : (legacyFreight != null && String(legacyFreight).trim() !== '' ? Math.max(0,Number(legacyFreight)||0) : (quantity === 1 ? defaultDomestic : 0)); totalQuantity += quantity; purchase += purchaseCost * quantity; domesticShipping += domestic; });
    return { hasVariants:true, selectedCount:selectedCount, totalQuantity:totalQuantity, purchase:purchase, domesticShipping:domesticShipping, total:purchase+domesticShipping };
  }
  function combinationCostBundleForRef(ref, relations) {
    var bundle = combinationBundleForRef(ref); if (!bundle) return null; var relation = arr(relations).find(function (item) { return item.childRef === ref; }), summary = combinationVariantCostSummary(bundle, relation && relation.quantity);
    return summary.hasVariants ? { purchase:summary.purchase, domesticShipping:summary.domesticShipping, internationalShipping:0 } : bundle;
  }
  function normalizedCombinationCostRelations(relations) {
    return arr(relations).map(function (relation) { var bundle = combinationBundleForRef(relation.childRef), hasVariants = Boolean(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.variantSelectionInitialized && arr(bundle.sourceSnapshot.variants).length); return hasVariants ? Object.assign({}, relation, { quantity:1 }) : relation; });
  }
  function combinationCostForVariant(variant) {
    var relations = variant && arr(variant.sourceBundleIds).length && combinationContextLoaded ? allCombinationRelations() : combinationRelations, costRelations = normalizedCombinationCostRelations(relations);
    if (!variant || !arr(variant.sourceBundleIds).length) return { loading:false, result:combinationModel.calculateCost(parentCombinationRef(variant), costRelations, function (ref) { return combinationCostBundleForRef(ref, relations); }, { purchase:variant && variant.purchase, domesticShipping:variant && variant.domesticShipping }, allCombinationAliases()) };
    if (!combinationContextLoaded) return { loading:true, result:null };
    return { loading:false, result:combinationModel.calculateCost(parentCombinationRef(variant), costRelations, function (ref) { return combinationCostBundleForRef(ref, relations); }, { purchase:variant.purchase, domesticShipping:variant.domesticShipping }, allCombinationAliases()) };
  }
  function ensureCombinationContext() {
    if (combinationContextLoaded) return Promise.resolve(combinationPickerState);
    if (combinationContextPromise) return combinationContextPromise;
    combinationContextPromise = Promise.all([erpStorage.init([COLLECTION_KEY]), requestJson('/api/domain/queries/product-combinations').catch(function () { return { relations: [] }; })]).then(function (values) {
      combinationPickerState.records = collectionModel.normalizeAll(erpStorage.get(COLLECTION_KEY, [])); combinationPickerState.globalRelations = arr(values[1] && values[1].relations); combinationPickerState.globalAliases = combinationModel.normalizeAliases(values[1] && values[1].aliases); combinationContextLoaded = true; resolveLegacyCollectionIdentities(); migrateLegacySourceBundles(); combinationContextPromise = null; return combinationPickerState;
    }).catch(function (error) { combinationContextPromise = null; throw error; });
    return combinationContextPromise;
  }
  function selectedCollectionRelations(variant, selected) {
    var parentRef = parentCombinationRef(variant), result = [], recordsByBundle = new Map(combinationPickerState.records.map(function (record) { return [bundleIdForCollection(record), record]; }));
    if (!parentRef) return result;
    selected.forEach(function (bundleId) {
      var record = recordsByBundle.get(bundleId), bundle = record ? null : bundleById(bundleId), collectionId = record ? String(record.id || '') : String(bundle && bundle.collectionId || '');
      if (!collectionId) return;
      var childRef = 'collection:' + collectionId;
      var existing = arr(combinationRelations).concat(arr(combinationPickerState.globalRelations)).find(function (relation) { return relation.parentRef === parentRef && relation.childRef === childRef; });
      result.push(existing || { id: 'comb_rel_' + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).slice(2)), parentRef: parentRef, childRef: childRef, childCollectionId: collectionId, quantity: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastCombinedAt: new Date().toISOString() });
    });
    return result;
  }
  function currentMainCollectionId() { return String(collectionSourceId || product && product.collectionId || '').trim(); }
  function localCombinationAliases() {
    var collectionId = currentMainCollectionId();
    return collectionId && variants.length === 1 && variants[0] && variants[0].erpVariantRef ? [{ collectionId: collectionId, variantRef: variants[0].erpVariantRef }] : [];
  }
  function allCombinationAliases() {
    var byCollection = new Map();
    combinationModel.normalizeAliases(combinationPickerState.globalAliases).concat(combinationModel.normalizeAliases(localCombinationAliases())).forEach(function (alias) { byCollection.set(alias.collectionId, alias); });
    return Array.from(byCollection.values());
  }
  function collectionCandidateReason(record, variant, selected) {
    var id = String(record && record.id || ''), bundleId = bundleIdForCollection(record), mainId = currentMainCollectionId(), mainUrl = val('sourceUrl'), recordUrl = String(record && record.sourceUrl || '').trim();
    if (id && mainId && id === mainId) return '当前商品的主货源，不能重复作为组合子项';
    if (mainUrl && recordUrl && mainUrl === recordUrl) return '与当前主货源相同，不能重复计入组合成本';
    if (selected.has(bundleId)) return '';
    var parentRef = parentCombinationRef(variant), childRef = 'collection:' + id;
    if (!parentRef || !id) return '缺少稳定关联标识';
    var base = mergedCombinationRelations(parentRef).concat(selectedCollectionRelations(variant, selected));
    var checked = combinationModel.canLink(base, parentRef, childRef, allCombinationAliases());
    if (checked.ok) return '';
    if (checked.code === 'combination_cycle') return '该组合会形成循环关系，无法添加' + (checked.path.length ? '：' + checked.path.join(' → ') : '');
    if (checked.code === 'combination_duplicate') return '该商品已经关联到当前SKU';
    return '当前商品不能作为组合子项';
  }
  function combinationSearchText(record) {
    var capture = record && record.capture && typeof record.capture === 'object' ? record.capture : {};
    return [record && record.title, record && record.sourceUrl].concat(arr(capture.variants).map(function (v) { return v && v.label; })).filter(Boolean).join(' ').toLowerCase();
  }
  function renderCombinationPicker() {
    var state = combinationPickerState, variant = variants[state.variantIndex], keyword = String(state.query || '').trim().toLowerCase();
    if (!variant) { $('combinationPickerList').innerHTML = ''; return; }
    var rows = state.records.filter(function (record) { return !keyword || combinationSearchText(record).indexOf(keyword) >= 0; });
    $('combinationPickerCount').textContent = rows.length + ' 个采集商品';
    $('combinationPickerList').innerHTML = rows.map(function (record) {
      var bundleId = bundleIdForCollection(record), selected = state.selected.has(bundleId), reason = collectionCandidateReason(record, variant, state.selected), disabled = Boolean(reason && !selected), draft = collectionModel.createDraft(record), images = collectionImageCandidates(record), capture = record.capture && typeof record.capture === 'object' ? record.capture : {}, specs = arr(capture.variants).map(function (v) { return String(v && v.label || '').trim(); }).filter(Boolean).slice(0, 3).join(' / '), combinationStatus = collectionCombinationSummary(record), statusText = combinationStatus.active ? '组合中 · 子项 ' + combinationStatus.outgoing + ' · 被 ' + combinationStatus.incoming + ' 个父项引用' + (combinationStatus.nested ? ' · 含下级组合' : '') : '未参与组合';
      return '<label class="combination-picker-item' + (selected ? ' is-selected' : '') + (disabled ? ' is-disabled' : '') + '" data-combination-record="' + esc(record.id) + '" title="' + esc(reason || '') + '"><input type="checkbox" data-combination-check="' + esc(bundleId) + '"' + (selected ? ' checked' : '') + (disabled ? ' disabled' : '') + '><span class="combination-picker-image" data-combination-image="' + esc(images[0] || record.image || '') + '"></span><span class="combination-picker-main"><strong>' + esc(record.title || '未命名采集商品') + '</strong><small>' + esc(specs || record.category || '无规格摘要') + '</small><small class="combination-picker-status">' + esc(statusText) + '</small></span><span>¥' + esc(draft.srcPrice == null || draft.srcPrice === '' ? '--' : draft.srcPrice) + '</span><span>快递 ¥' + esc(draft.domesticShipping == null || draft.domesticShipping === '' ? '--' : draft.domesticShipping) + '</span><span class="combination-picker-source">' + esc(record.sourceUrl || '无货源链接') + '</span></label>';
    }).join('') || '<div class="source-bundle-empty">没有匹配的采集商品</div>';
    $('combinationPickerList').querySelectorAll('[data-combination-image]').forEach(function (node) { var url = String(node.dataset.combinationImage || ''); if (url) node.style.backgroundImage = 'url(' + JSON.stringify(url) + ')'; });
    $('combinationPickerNote').textContent = (legacyCombinationPending ? '存在旧商品级组合货源待分配到具体SKU；请逐个SKU勾选确认。' : '只读取采集箱已有资料；') + '组合子项只保存在网研ERP，不会作为SKU提交到Ozon。';
  }
  function openCombinationPicker(index) {
    collectVariants(); var variant = variants[index]; if (!variant) return;
    combinationPickerState.variantIndex = index; combinationPickerState.query = ''; combinationPickerState.selected = new Set(arr(variant.sourceBundleIds).map(String));
    $('combinationPickerSearch').value = ''; $('combinationPickerNote').textContent = '正在读取采集箱和组合关系…';
    ensureCombinationContext().then(function () { renderCombinationPicker(); $('combinationPickerDialog').showModal(); }).catch(function (error) { note('采集箱读取失败：' + (error.message || '请稍后重试'), true); });
  }
  function appendCombinationHistory(parentRef, relation, action, source) {
    combinationHistory.push({ id: 'comb_evt_' + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).slice(2)), relationId: relation.id, parentRef: parentRef, childRef: relation.childRef, childCollectionId: relation.childCollectionId || '', action: action, occurredAt: new Date().toISOString(), source: source || '商品编辑', operatorUserId: erpStorage && typeof erpStorage.getCurrentUserId === 'function' ? String(erpStorage.getCurrentUserId() || '') : '' });
  }
  function applyCombinationPicker() {
    var state = combinationPickerState, variant = variants[state.variantIndex]; if (!variant) return;
    var parentRef = parentCombinationRef(variant), base = mergedCombinationRelations(parentRef), nextParentRelations = selectedCollectionRelations(variant, state.selected), graph = combinationModel.validateGraph(base.concat(nextParentRelations), allCombinationAliases());
    if (!graph.ok) { $('combinationPickerNote').textContent = graph.code === 'combination_cycle' ? '该组合会形成循环关系，无法添加：' + graph.path.join(' → ') : '组合关系包含重复或无效关联'; return; }
    var oldParentRelations = arr(combinationRelations).filter(function (relation) { return relation.parentRef === parentRef; }), oldMap = new Map(oldParentRelations.map(function (relation) { return [relation.childRef, relation]; })), newMap = new Map(nextParentRelations.map(function (relation) { return [relation.childRef, relation]; }));
    state.records.forEach(function (record) { if (!state.selected.has(bundleIdForCollection(record))) return; var at = sourceBundles.findIndex(function (bundle) { return bundle.id === bundleIdForCollection(record); }), nextBundle = sourceBundleFromCollection(record, at >= 0 ? sourceBundles[at] : null); if (at >= 0) sourceBundles[at] = nextBundle; else sourceBundles.push(nextBundle); });
    oldMap.forEach(function (relation, childRef) { if (!newMap.has(childRef)) appendCombinationHistory(parentRef, relation, 'unlinked'); });
    newMap.forEach(function (relation, childRef) { if (!oldMap.has(childRef)) appendCombinationHistory(parentRef, relation, 'linked'); });
    combinationRelations = arr(combinationRelations).filter(function (relation) { return relation.parentRef !== parentRef; }).concat(nextParentRelations);
    variant.sourceBundleIds = Array.from(state.selected); fullInfoDirty['variant:' + state.variantIndex + ':sourceBundleIds'] = true; fullInfoDirty['field:sourceBundles'] = true; variantStructureEdited = true; markWorkspaceDirty();
    if (variant.sourceBundleIds.length) expandedCombinationParents.add(variant.erpVariantRef); else expandedCombinationParents.delete(variant.erpVariantRef);
    $('combinationPickerDialog').close(); renderVariants(); note('当前SKU已关联 ' + variant.sourceBundleIds.length + ' 个组合子项；组合数据只保存在ERP。');
  }
  function removeCombinationChild(variantIndex, bundleId) {
    var variant = variants[variantIndex]; if (!variant) return; var parentRef = parentCombinationRef(variant), bundle = bundleById(bundleId), childRef = bundle && bundle.collectionId ? 'collection:' + bundle.collectionId : '';
    variant.sourceBundleIds = arr(variant.sourceBundleIds).filter(function (id) { return String(id) !== String(bundleId); });
    if (childRef) { var relation = arr(combinationRelations).find(function (item) { return item.parentRef === parentRef && item.childRef === childRef; }); if (relation) appendCombinationHistory(parentRef, relation, 'unlinked'); combinationRelations = arr(combinationRelations).filter(function (item) { return !(item.parentRef === parentRef && item.childRef === childRef); }); }
    fullInfoDirty['variant:' + variantIndex + ':sourceBundleIds'] = true; variantStructureEdited = true; markWorkspaceDirty(); if (!variant.sourceBundleIds.length) expandedCombinationParents.delete(variant.erpVariantRef); renderVariants(); note('已从当前SKU移除组合子项，采集箱原商品未删除。');
  }
  function cloneVariantCombinationRelations(sourceVariant, targetVariant) {
    var sourceParent = parentCombinationRef(sourceVariant), targetParent = parentCombinationRef(targetVariant); if (!sourceParent || !targetParent || sourceParent === targetParent) return;
    var now = new Date().toISOString(), sourceRelations = arr(combinationRelations).filter(function (relation) { return relation.parentRef === sourceParent; });
    sourceRelations.forEach(function (relation) { var cloned = Object.assign({}, relation, { id: 'comb_rel_' + (window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : Date.now() + '_' + Math.random().toString(36).slice(2)), parentRef: targetParent, createdAt: now, updatedAt: now, lastCombinedAt: now }); combinationRelations.push(cloned); appendCombinationHistory(targetParent, cloned, 'linked'); });
    if (arr(targetVariant.sourceBundleIds).length) expandedCombinationParents.add(targetVariant.erpVariantRef);
  }
  function removeVariantCombinationRelations(variant) {
    if (!variant) return; var parentRef = parentCombinationRef(variant), owned = arr(combinationRelations).filter(function (relation) { return relation.parentRef === parentRef; });
    owned.forEach(function (relation) { appendCombinationHistory(parentRef, relation, 'unlinked'); }); combinationRelations = arr(combinationRelations).filter(function (relation) { return relation.parentRef !== parentRef; }); expandedCombinationParents.delete(variant.erpVariantRef);
  }
  function combinationBundleImages(bundle) {
    var images = arr(bundle && bundle.imageCandidates).concat(arr(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.variants).map(function (entry) { return entry && entry.imageUrl; })).concat(bundle && bundle.referenceImage ? [bundle.referenceImage] : []);
    return images.filter(function (url, at, list) { return (/^https:\/\//i.test(String(url || '')) || /^\/api\/private-objects\/(?:sku-images|combination-references)\/[0-9a-f-]{36}(?:\?|$)/i.test(String(url || ''))) && list.indexOf(url) === at; });
  }
  function showCombinationImagePicker(bundle, activeUrl, title) {
    var images = combinationBundleImages(bundle); $('combinationReferenceTitle').textContent = title; $('combinationReferenceSummary').textContent = '当前共 ' + images.length + ' 张候选图片';
    $('combinationReferenceList').innerHTML = images.length ? images.map(function (url, index) { return '<article class="sku-image-card combination-reference-choice' + (url === activeUrl ? ' is-selected on' : '') + '" data-combination-reference-choice="' + esc(url) + '" tabindex="0"><div class="sku-image-preview"><img src="' + esc(url) + '" alt="候选图片' + (index + 1) + '" loading="lazy"></div><div class="sku-image-card-foot"><input type="radio" name="combinationReferenceImage"' + (url === activeUrl ? ' checked' : '') + ' tabindex="-1"><button type="button">选择</button></div></article>'; }).join('') : '<div class="combination-reference-empty"><strong>暂无候选图片</strong><span>可以点击右上角“上传图片”添加。</span></div>';
    $('combinationReferenceNote').textContent = images.length ? '可从当前子项其它SKU原图中选择，也可以上传新图。' : '暂无现成图片，可以直接上传本地图片。'; $('combinationReferenceDialog').showModal();
  }
  function openCombinationReferencePicker(bundleId) {
    var bundle = bundleById(bundleId); if (!bundle) { note('未找到这个组合子项的参考图资料', true); return; }
    combinationReferenceBundleId = String(bundleId); combinationReferenceMode = 'bundle'; combinationReferenceVariantSkuId = ''; showCombinationImagePicker(bundle, bundle.referenceImage, '选择参考图 · ' + (bundle.title || '组合子项'));
  }
  function openCombinationVariantImagePicker(bundleId, rowKey, rowIndex, skuId) {
    var bundle = bundleById(bundleId), variants = arr(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.variants), index = Number(rowIndex), entry = Number.isInteger(index) && index >= 0 ? variants[index] : variants.find(function (item, at) { return String(item && item.combinationRowKey || 'row:' + String(at + 1)) === String(rowKey || ''); });
    if (!bundle || !entry) { note('未找到这个规格的图片资料', true); return; }
    combinationReferenceBundleId = String(bundleId); combinationReferenceMode = 'variant'; combinationReferenceVariantSkuId = String(skuId || ''); combinationReferenceVariantRowKey = String(entry.combinationRowKey || rowKey || 'row:' + String(index + 1)); showCombinationImagePicker(bundle, String(entry.imageUrl || ''), '选择规格图片 · ' + String(entry.label || skuId || '规格'));
  }
  function updateCombinationVariantImagePreview(bundleId, rowKey, url) {
    var row = $('combinationVariantList') && $('combinationVariantList').querySelector('[data-combination-spec-row="' + CSS.escape(String(rowKey || '')) + '"]'); if (!row) return;
    var button = row.querySelector('[data-combination-variant-image]'); if (!button) return;
    button.innerHTML = url ? '<img src="' + esc(url) + '" alt="" loading="lazy">' : '<i>选图</i>';
  }
  function chooseCombinationReference(url) {
    var bundle = bundleById(combinationReferenceBundleId); if (!bundle || !(/^https:\/\//i.test(String(url || '')) || /^\/api\/private-objects\/(?:sku-images|combination-references)\/[0-9a-f-]{36}(?:\?|$)/i.test(String(url || '')))) return;
    var variantMode = combinationReferenceMode === 'variant', variantSkuId = combinationReferenceVariantSkuId, variantRowKey = combinationReferenceVariantRowKey;
    if (variantMode) { var variants = arr(bundle.sourceSnapshot && bundle.sourceSnapshot.variants), entry = variants.find(function (item, index) { return String(item && item.combinationRowKey || 'row:' + String(index + 1)) === variantRowKey; }); if (entry) entry.imageUrl = String(url); }
    else { bundle.referenceImage = String(url); if (bundle.sourceSnapshot) bundle.sourceSnapshot.referenceImageManual = true; }
    bundle.updatedAt = new Date().toISOString(); markSourceBundlesDirty(); $('combinationReferenceDialog').close(); if (variantMode) updateCombinationVariantImagePreview(combinationReferenceBundleId, variantRowKey, String(url)); combinationReferenceBundleId = ''; combinationReferenceMode = 'bundle'; combinationReferenceVariantSkuId = ''; combinationReferenceVariantRowKey = ''; renderVariants(); note('已更新图片；保存草稿或提交后正式保存');
  }
  async function uploadCombinationReferenceImage(file) {
    var bundle = bundleById(combinationReferenceBundleId); if (!bundle || !file) return;
    if (file.size > 6 * 1024 * 1024) { $('combinationReferenceNote').textContent = '单张图片不得超过 6 MiB。'; return; }
    if (!/\.(jpe?g|png|bmp|gif|webp|avif)$/i.test(String(file.name || ''))) { $('combinationReferenceNote').textContent = '仅支持 JPG、PNG、BMP、GIF、WebP、AVIF 图片。'; return; }
    var bundleId = String(combinationReferenceBundleId || '').trim(), mode = combinationReferenceMode, skuId = combinationReferenceVariantSkuId, rowKey = combinationReferenceVariantRowKey;
    $('combinationReferenceUploadBtn').disabled = true; $('combinationReferenceNote').textContent = '正在上传图片…';
    try {
      var uploadUrl = '/api/domain/commands/combination-reference-image?bundleId=' + encodeURIComponent(bundleId) + '&name=' + encodeURIComponent(String(file.name || 'combination-reference.jpg').slice(0, 120));
      var uploadResponse = await erpStorage.request(uploadUrl, { method:'POST', headers:{'Content-Type':file.type || 'application/octet-stream'}, body:file });
      var uploadData = await uploadResponse.json().catch(function () { return {}; });
      if (!uploadResponse.ok || !uploadData.item || !uploadData.item.url) throw new Error(uploadData.message || '上传失败');
      var url = String(uploadData.item.url); bundle.imageCandidates = arr(bundle.imageCandidates).filter(Boolean); if (bundle.imageCandidates.indexOf(url) < 0) bundle.imageCandidates.unshift(url);
      if (mode === 'variant') { var variants = arr(bundle.sourceSnapshot && bundle.sourceSnapshot.variants), entry = variants.find(function (item, index) { return String(item && item.combinationRowKey || 'row:' + String(index + 1)) === rowKey; }); if (entry) entry.imageUrl = url; updateCombinationVariantImagePreview(bundleId, rowKey, url); } else { bundle.referenceImage = url; if (bundle.sourceSnapshot) bundle.sourceSnapshot.referenceImageManual = true; }
      bundle.updatedAt = new Date().toISOString(); markSourceBundlesDirty(); renderVariants(); if (mode === 'variant') showCombinationImagePicker(bundle, url, '选择规格图片 · ' + String((entry && entry.label) || skuId || '规格')); else openCombinationReferencePicker(bundleId); $('combinationReferenceNote').textContent = '上传完成；保存草稿或提交后正式保存。';
    } catch (error) { $('combinationReferenceNote').textContent = '上传失败：' + String(error && error.message || '未知原因'); }
    finally { $('combinationReferenceUploadBtn').disabled = false; }
  }
  function refreshVariantFloatingScroll() {
    var viewport = document.querySelector('#variants .variant-viewport'), bar = $('variantFloatingScroll'), inner = $('variantFloatingScrollInner'), table = $('variantTable');
    if (!viewport || !bar || !inner || !table) return;
    var rect = viewport.getBoundingClientRect(), overflow = viewport.scrollWidth > viewport.clientWidth + 2, visible = rect.bottom > 36 && rect.top < window.innerHeight - 36;
    inner.style.width = Math.max(viewport.scrollWidth, viewport.clientWidth) + 'px'; bar.hidden = !(overflow && visible);
    if (!bar.hidden) {
      var left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right), visibleTop = Math.max(0, rect.top), visibleBottom = Math.min(window.innerHeight, rect.bottom), width = Math.max(0, right - left), top = visibleBottom - 17;
      if (width < 24 || top < visibleTop) { bar.hidden = true; return; }
      bar.style.left = left + 'px'; bar.style.top = top + 'px'; bar.style.width = width + 'px'; if (Math.abs(bar.scrollLeft - viewport.scrollLeft) > 1) bar.scrollLeft = viewport.scrollLeft;
    }
  }
  function bindVariantFloatingScroll() {
    var viewport = document.querySelector('#variants .variant-viewport'), bar = $('variantFloatingScroll'), table = $('variantTable'); if (!viewport || !bar || !table || bar.dataset.bound === '1') return;
    bar.dataset.bound = '1'; var syncing = false;
    viewport.addEventListener('scroll', function () { if (syncing) return; syncing = true; bar.scrollLeft = viewport.scrollLeft; syncing = false; });
    bar.addEventListener('scroll', function () { if (syncing) return; syncing = true; viewport.scrollLeft = bar.scrollLeft; syncing = false; });
    window.addEventListener('scroll', refreshVariantFloatingScroll, { passive:true }); window.addEventListener('resize', refreshVariantFloatingScroll);
    if (window.ResizeObserver) new ResizeObserver(refreshVariantFloatingScroll).observe(table);
    refreshVariantFloatingScroll();
  }
  function openCombinationVariantPicker(bundleId) {
    var bundle = bundleById(bundleId); if (!bundle) { note('未找到这个组合子项的规格资料', true); return; }
    var snapshot = arr(bundle.sourceSnapshot && bundle.sourceSnapshot.variants), selected = new Set(arr(bundle.sourceSnapshot && bundle.sourceSnapshot.selectedVariantKeys).map(String));
    if (!snapshot.length) { note('这个组合子项没有可选择的规格', true); return; }
    var childRef = bundle.collectionId ? 'collection:' + bundle.collectionId : '', legacyRelation = arr(combinationRelations).find(function (relation) { return relation.childRef === childRef; }), legacyQuantity = Math.max(1, Number(legacyRelation && legacyRelation.quantity) || 1), defaultPurchase = Number(bundle.purchase)||0, defaultDomestic = Number(bundle.domesticShipping)||0;
    combinationVariantBundleId = String(bundleId); $('combinationVariantTitle').textContent = '选择组合子项规格 · ' + (bundle.title || '组合子项');
    $('combinationVariantList').innerHTML = '<table class="combination-variant-table"><thead><tr><th class="combination-variant-col-check">选择</th><th class="combination-variant-col-image">图片</th><th class="combination-variant-col-spec">规格</th><th class="combination-variant-col-weight">重量</th><th class="combination-variant-col-size">尺寸</th><th class="combination-variant-col-qty">数量</th><th class="combination-variant-col-money">采购价</th><th class="combination-variant-col-money">国内运费</th><th class="combination-variant-col-money">小计</th></tr></thead><tbody>' + snapshot.map(function (entry, rowIndex) { var rowKey = String(entry && entry.combinationRowKey || 'row:' + String(rowIndex + 1)), id = String(entry && entry.skuId || ''), weightG = Number(entry && entry.weightG) || 0, lengthMm = Number(entry && entry.lengthMm)||0, widthMm = Number(entry && entry.widthMm)||0, heightMm = Number(entry && entry.heightMm)||0, sizeText = lengthMm && widthMm && heightMm ? formatCombinationMoney(lengthMm) + '×' + formatCombinationMoney(widthMm) + '×' + formatCombinationMoney(heightMm) + ' mm' : '--', label = String(entry && entry.label || id || '未命名规格'), image = String(entry && entry.imageUrl || ''), quantity = Math.max(1,Math.min(9999,Math.floor(Number(entry.combinationQuantity)||legacyQuantity))), purchaseCost = String(entry.combinationPurchaseCost == null ? '' : entry.combinationPurchaseCost).trim() === '' ? defaultPurchase : Math.max(0,Number(entry.combinationPurchaseCost)||0), savedDomestic = String(entry.combinationDomesticShipping == null ? '' : entry.combinationDomesticShipping).trim(), legacyFreight = entry.combinationDomesticFreight == null ? entry.combinationInternationalShipping : entry.combinationDomesticFreight, domesticManual = entry.combinationDomesticShippingManual === true || savedDomestic !== '' || legacyFreight != null, domestic = savedDomestic !== '' ? savedDomestic : (legacyFreight != null && String(legacyFreight).trim() !== '' ? String(legacyFreight) : formatCombinationMoney(defaultDomestic)), domesticAmount = domestic === '' ? 0 : Math.max(0,Number(domestic)||0), subtotal = purchaseCost * quantity + domesticAmount; return '<tr class="combination-variant-row' + (selected.has(rowKey) ? ' on' : '') + '" data-combination-spec-row="' + esc(rowKey) + '" data-combination-row-index="' + rowIndex + '"><td class="combination-variant-check"><input type="checkbox" data-combination-variant-choice="' + esc(rowKey) + '"' + (selected.has(rowKey) ? ' checked' : '') + '></td><td class="combination-variant-option-image"><button type="button" class="combination-variant-image-button" data-combination-variant-image="1" data-combination-bundle-id="' + esc(bundleId) + '" data-combination-row-key="' + esc(rowKey) + '" data-combination-row-index="' + rowIndex + '" data-combination-sku-id="' + esc(id) + '" title="选择或上传规格图片">' + (image ? '<img src="' + esc(image) + '" alt="" loading="lazy">' : '<i>选图</i>') + '</button></td><td class="combination-variant-option-main" title="' + esc(label) + '"><strong>' + esc(label) + '</strong></td><td class="combination-variant-weight">' + (weightG ? esc(formatCombinationMoney(weightG)) + ' g' : '--') + '</td><td class="combination-variant-size" title="' + esc(sizeText) + '">' + esc(sizeText) + '</td><td><input class="combination-variant-edit-input combination-variant-qty-input" type="number" min="1" max="9999" step="1" value="' + esc(quantity) + '" data-combination-spec-field="quantity"></td><td><input class="combination-variant-edit-input" inputmode="decimal" value="' + esc(formatCombinationMoney(purchaseCost)) + '" data-combination-spec-field="purchaseCost"></td><td><input class="combination-variant-edit-input" inputmode="decimal" value="' + esc(domestic) + '" placeholder="0" data-default-domestic="' + esc(formatCombinationMoney(defaultDomestic)) + '" data-domestic-manual="' + (domesticManual ? '1' : '0') + '" data-combination-spec-field="domesticShipping"></td><td class="combination-variant-subtotal" data-combination-spec-subtotal>¥' + esc(formatCombinationMoney(subtotal)) + '</td></tr>'; }).join('') + '</tbody></table>';
    $('combinationVariantNote').textContent = '国内运费默认读取原值，修改数量不会改动运费；用户需要时可自行修改。'; $('combinationVariantDialog').showModal();
  }
  function refreshCombinationVariantRowSubtotal(row) {
    if (!row) return; var quantity = Math.max(1,Math.min(9999,Math.floor(Number(row.querySelector('[data-combination-spec-field="quantity"]') && row.querySelector('[data-combination-spec-field="quantity"]').value)||1))), purchase = Math.max(0,Number(row.querySelector('[data-combination-spec-field="purchaseCost"]') && row.querySelector('[data-combination-spec-field="purchaseCost"]').value)||0), domesticInput = row.querySelector('[data-combination-spec-field="domesticShipping"]'), domestic = domesticInput && String(domesticInput.value || '').trim() !== '' ? Math.max(0,Number(domesticInput.value)||0) : 0, holder = row.querySelector('[data-combination-spec-subtotal]'); if (holder) holder.textContent = '¥' + formatCombinationMoney(purchase * quantity + domestic);
  }
  function applyCombinationVariantPicker() {
    var bundle = bundleById(combinationVariantBundleId); if (!bundle) return;
    var rows = Array.from($('combinationVariantList').querySelectorAll('[data-combination-spec-row]')), selected = [], selectedIds = [];
    for (var i = 0; i < rows.length; i++) { var row = rows[i], box = row.querySelector('[data-combination-variant-choice]'); if (!box || !box.checked) continue; var rowKey = String(box.dataset.combinationVariantChoice || ''), rowIndex = Number(row.dataset.combinationRowIndex), entry = arr(bundle.sourceSnapshot && bundle.sourceSnapshot.variants)[rowIndex], skuId = String(entry && entry.skuId || ''), quantity = Math.floor(Number(row.querySelector('[data-combination-spec-field="quantity"]').value)), purchase = Number(row.querySelector('[data-combination-spec-field="purchaseCost"]').value), domesticInput = row.querySelector('[data-combination-spec-field="domesticShipping"]'), domesticRaw = String(domesticInput.value || '').trim(), domestic = domesticRaw === '' ? NaN : Number(domesticRaw); if (!Number.isFinite(quantity) || quantity < 1 || quantity > 9999 || !Number.isFinite(purchase) || purchase < 0) { $('combinationVariantNote').textContent = '已选规格的数量必须为1-9999，采购价必须为0或正数。'; return; } if (domesticRaw !== '' && (!Number.isFinite(domestic) || domestic < 0)) { $('combinationVariantNote').textContent = '国内运费必须为0或正数。'; domesticInput.focus(); return; } if (entry) { entry.combinationQuantity = quantity; entry.combinationPurchaseCost = String(purchase); entry.combinationDomesticShipping = domesticRaw; entry.combinationDomesticShippingManual = domesticInput.dataset.domesticManual === '1' || quantity > 1; entry.combinationDomesticFreight = ''; entry.combinationInternationalShipping = ''; } selected.push(rowKey); if (skuId) selectedIds.push(skuId); }
    if (!selected.length) { $('combinationVariantNote').textContent = '至少需要选择1个规格。'; return; }
    var missingImageRow = rows.find(function (row) { var box = row.querySelector('[data-combination-variant-choice]'); if (!box || !box.checked) return false; var rowIndex = Number(row.dataset.combinationRowIndex), entry = arr(bundle.sourceSnapshot && bundle.sourceSnapshot.variants)[rowIndex]; return !String(entry && entry.imageUrl || '').trim(); });
    if (missingImageRow) { $('combinationVariantNote').textContent = '每个已选规格都需要1张参考图，请先补齐无图规格。'; var missingButton = missingImageRow.querySelector('[data-combination-variant-image]'); if (missingButton) missingButton.focus(); return; }
    bundle.sourceSnapshot.selectedVariantKeys = selected; bundle.selectedVariantIds = selectedIds; bundle.sourceSnapshot.variantSelectionInitialized = true; bundle.updatedAt = new Date().toISOString(); var childRef = bundle.collectionId ? 'collection:' + bundle.collectionId : ''; arr(combinationRelations).forEach(function (relation) { if (relation.childRef === childRef) { relation.quantity = 1; relation.updatedAt = new Date().toISOString(); } }); fullInfoDirty['field:combinationRelations'] = true; markSourceBundlesDirty(); $('combinationVariantDialog').close(); combinationVariantBundleId = ''; renderVariants(); note('已更新组合子项规格明细，外层成本已同步汇总');
  }
  function outgoingCombinationRelations(ref) { var relations = allCombinationRelations(), direct = relations.filter(function (relation) { return relation.parentRef === ref; }); if (direct.length) return direct; if (String(ref || '').indexOf('collection:') !== 0) return direct; var collectionId = String(ref).slice('collection:'.length), alias = allCombinationAliases().find(function (item) { return item.collectionId === collectionId; }); return alias ? relations.filter(function (relation) { return relation.parentRef === 'variant:' + alias.variantRef; }) : direct; }
  function combinationVariantOptions(bundle, directBundleId) {
    var snapshot = arr(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.variants), selected = new Set(arr(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.selectedVariantKeys).map(String));
    if (!snapshot.length) return '<span class="variant-combination-spec-empty">无规格</span>';
    var labels = snapshot.filter(function (entry, index) { return selected.has(String(entry && entry.combinationRowKey || 'row:' + String(index + 1))); }).map(function (entry) { return String(entry && entry.label || '').trim(); }).filter(Boolean);
    return '<button class="variant-combination-spec-button" type="button"' + (directBundleId ? ' data-combination-variant-open="' + esc(directBundleId) + '"' : ' disabled') + ' title="' + esc(labels.join(' / ')) + '"><strong>已选 ' + selected.size + ' 个规格</strong><small>' + esc(labels.slice(0, 2).join(' / ') + (labels.length > 2 ? '…' : '')) + '</small></button>';
  }
  function combinationSelectedSpecText(bundle) {
    var snapshot = arr(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.variants), selected = new Set(arr(bundle && bundle.sourceSnapshot && bundle.sourceSnapshot.selectedVariantKeys).map(String));
    var labels = snapshot.filter(function (entry, index) { return selected.has(String(entry && entry.combinationRowKey || 'row:' + String(index + 1))); }).map(function (entry) { return String(entry && entry.label || '').trim(); }).filter(Boolean);
    return labels.join(' / ') || '—';
  }
  function combinationRelationForNode(ref, path, variantIndex) {
    var ancestors = Array.from(path || []), parentRef = ancestors.length ? ancestors[ancestors.length - 1] : parentCombinationRef(variants[variantIndex]);
    var local = arr(combinationRelations).find(function (relation) { return relation.parentRef === parentRef && relation.childRef === ref; });
    var relation = local || arr(allCombinationRelations()).find(function (item) { return item.parentRef === parentRef && item.childRef === ref; });
    return { parentRef: parentRef, relation: relation || null, local: local || null };
  }
  function combinationEditablePurchaseCost(bundle) {
    if (!bundle) return 0; var override = String(bundle.purchaseCostOverride == null ? '' : bundle.purchaseCostOverride).trim();
    return override !== '' ? (Number(override) || 0) : (Number(bundle.purchase) || 0) + (Number(bundle.domesticShipping) || 0);
  }
  function combinationReferenceThumbsHtml(bundle, directBundleId) {
    var selected = combinationSelectedVariantEntries(bundle);
    if (!selected.length) return '<span class="variant-combination-reference-empty">未选规格</span>';
    return '<span class="variant-combination-reference-list">' + selected.map(function (entry, index) { var rowKey = String(entry && entry.combinationRowKey || 'row:' + String(index + 1)), image = String(entry && entry.imageUrl || '').trim(), label = String(entry && entry.label || '规格'); return image ? '<button class="variant-combination-thumb-button" type="button"' + (directBundleId ? ' data-combination-row-reference="' + esc(directBundleId) + '" data-combination-row-key="' + esc(rowKey) + '"' : ' disabled') + ' title="' + esc(label) + ' · 更换参考图"><img class="variant-combination-thumb" src="' + esc(image) + '" alt="' + esc(label) + '参考图" loading="lazy"></button>' : '<button class="variant-combination-thumb-button variant-combination-thumb-empty" type="button"' + (directBundleId ? ' data-combination-row-reference="' + esc(directBundleId) + '" data-combination-row-key="' + esc(rowKey) + '"' : ' disabled') + ' title="' + esc(label) + ' · 选择参考图">选图</button>'; }).join('') + '</span>';
  }
  function combinationNodeHtml(ref, bundle, depth, variantIndex, directBundleId, path) {
    depth = Math.max(1, Math.min(10, Number(depth) || 1)); path = path || new Set(); if (path.has(ref)) return '<div class="variant-combination-nested-warning">检测到循环组合，已停止展开</div>';
    var nextPath = new Set(path); nextPath.add(ref); var missing = !bundle, sourceState = bundleSourceState(bundle), outgoing = depth < 10 ? outgoingCombinationRelations(ref) : [], expanded = expandedCombinationNodes.has(ref), controls = '', relationState = combinationRelationForNode(ref, path, variantIndex), relation = relationState.relation, quantity = Math.max(1, Number(relation && relation.quantity) || 1);
    if (directBundleId) controls = (sourceState.code === 'stale' ? '<button class="variant-combination-refresh" type="button" data-combination-refresh="' + esc(directBundleId) + '">刷新快照</button>' : '') + '<button class="btn variant-combination-remove" type="button" data-combination-remove="' + esc(directBundleId) + '" data-combination-parent-index="' + variantIndex + '">删除</button>';
    else controls = '<span class="variant-combination-meta">下级组合</span>';
    var toggle = outgoing.length ? '<button class="variant-combination-nested-toggle" type="button" data-combination-node-toggle="' + esc(ref) + '" aria-expanded="' + String(expanded) + '">' + (expanded ? '收起下级' : '下级 ' + outgoing.length) + '</button>' : '';
    var sourceStateHtml = sourceState.label ? '<small class="variant-combination-source-state is-' + esc(sourceState.code) + '">' + esc(sourceState.label) + '</small>' : '';
    var specControl = combinationVariantOptions(bundle, directBundleId), specText = combinationSelectedSpecText(bundle);
    var thumb = combinationReferenceThumbsHtml(bundle, directBundleId);
    var specSummary = combinationVariantCostSummary(bundle, quantity), purchaseTotal = formatCombinationMoney(specSummary.total);
    var sourceLink = bundle && bundle.sourceUrl ? '<a class="variant-combination-link" href="' + esc(bundle.sourceUrl) + '" target="_blank" rel="noopener">打开货源</a>' : '<span class="variant-combination-meta">无货源链接</span>';
    var quantityControl = '<span title="由已选规格数量汇总">' + esc(specSummary.hasVariants ? specSummary.totalQuantity : quantity) + ' 件</span>';
    var purchaseControl = '<span title="由规格弹窗内采购价×数量汇总">¥' + esc(formatCombinationMoney(specSummary.purchase)) + '</span>';
    var internationalControl = '<span title="由规格弹窗内国内运费汇总">¥' + esc(formatCombinationMoney(specSummary.domesticShipping||0)) + '</span>';
    var row = '<div class="variant-combination-child combination-depth-' + depth + '" data-combination-depth="' + depth + '">' +
      '<span class="variant-combination-title"><strong>' + esc(missing ? '来源记录缺失' : bundle.title || '组合子项') + '</strong><small title="' + esc(specText) + '">' + esc(specText) + '</small><small class="variant-combination-source-inline">' + sourceLink + '</small>' + sourceStateHtml + '</span>' +
      '<span class="variant-combination-reference-cell">' + thumb + '</span>' +
      '<span class="variant-combination-spec-cell">' + specControl + '</span>' +
      '<span class="variant-combination-quantity">' + quantityControl + '</span>' +
      '<span class="variant-combination-purchase">' + purchaseControl + '</span>' +
      '<span class="variant-combination-shipping">' + internationalControl + '</span>' +
      '<span class="variant-combination-total">¥' + esc(purchaseTotal) + '</span>' +
      '<span class="variant-combination-row-actions">' + toggle + controls + '</span></div>';
    if (expanded && outgoing.length) row += outgoing.map(function (relation) { var childBundle = combinationBundleForRef(relation.childRef); return combinationNodeHtml(relation.childRef, childBundle, depth + 1, variantIndex, '', nextPath); }).join('');
    return row;
  }
  function combinationChildRows(variant, index, colspan) {
    if (!variant || !expandedCombinationParents.has(variant.erpVariantRef) || !arr(variant.sourceBundleIds).length) return '';
    var body = arr(variant.sourceBundleIds).map(function (id) { var bundle = bundleById(id), ref = bundle && bundle.collectionId ? 'collection:' + bundle.collectionId : 'bundle:' + id; return combinationNodeHtml(ref, bundle, 1, index, id, new Set()); }).join('');
    return '<tr class="variant-combination-row" data-combination-parent="' + index + '"><td colspan="' + colspan + '">' + body + '</td></tr>';
  }
  function combinationCell(variant, index) {
    var count = arr(variant && variant.sourceBundleIds).length, expanded = variant && expandedCombinationParents.has(variant.erpVariantRef);
    return '<td class="variant-col-combination"><div class="variant-combination-cell"><span class="variant-combination-actions">' + (count ? '<button class="variant-combination-toggle" type="button" data-combination-toggle="' + index + '" aria-expanded="' + String(expanded) + '">组合 ' + count + '</button>' : '') + '<button class="variant-combination-add" type="button" data-combination-open="' + index + '" title="从采集箱添加组合商品" aria-label="从采集箱添加组合商品">+</button></span></div></td>';
  }
  function purchaseTotalCostCell(variant) {
    var cost = combinationCostForVariant(variant);
    if (cost.loading) return '<td class="variant-col-purchase-total"><small class="variant-purchase-total is-loading">成本读取中…</small></td>';
    if (!cost.result || !cost.result.ok) return '<td class="variant-col-purchase-total"><span class="variant-purchase-total">--</span></td>';
    var missing = cost.result.missingRefs.length > 0, title = '自身采购价 ¥' + formatCombinationMoney(cost.result.basePurchase) + '；自身国内快递 ¥' + formatCombinationMoney(cost.result.baseShipping) + '；组合附加采购 ¥' + formatCombinationMoney(cost.result.additionalPurchase) + '；组合附加快递 ¥' + formatCombinationMoney(cost.result.additionalShipping) + (missing ? '；存在下级来源成本未读取完整' : '');
    return '<td class="variant-col-purchase-total"><span class="variant-purchase-total' + (missing ? ' is-warning' : '') + '" title="' + title + '">¥' + formatCombinationMoney(cost.result.total) + (missing ? ' · 待补' : '') + '</span></td>';
  }
  function pricingVariantLabel(variant, index) {
    return String(variant && (variant.offerId || variant.sku || variant.name) || '').trim() || ('SKU ' + (index + 1));
  }
  function pricingPackageValue(variant, key, fieldId) {
    var own = Number(variant && variant[key]);
    if (Number.isFinite(own) && own > 0) return own;
    var shared = Number(val(fieldId));
    return Number.isFinite(shared) && shared > 0 ? shared : '';
  }
  function applyVariantCalculatedPrice(index, result, options) {
    options = options || {};
    var variant = variants[index], row = $('variantBody').querySelector('tr[data-index="' + index + '"]');
    if (!variant || !row || !result || !result.ok) return false;
    var values = { lowest: result.minimumCny, sale: result.saleCny, old: result.oldCny };
    var explanation = window.WYERP_PRODUCT_VARIANT_PRICING.explain(result, window.WYERP_LOGISTICS_QUOTE);
    var applied = true;
    Object.keys(values).forEach(function (key) {
      var input = row.querySelector('[data-field="' + key + '"]');
      if (!input) { applied = false; return; }
      if (options.fillOnlyMissing && String(input.value || variant[key] || '').trim()) return;
      variant[key] = String(values[key]);
      input.value = variant[key];
      input.dataset.autoPricing = '1';
      input.title = explanation;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return applied;
  }
  function calculateAllVariantPrices(options) {
    options = options || {};
    var button = $('calculateVariantPriceBtn');
    if (!button || button.disabled) return Promise.resolve(false);
    collectVariants();
    button.disabled = true;
    note('正在读取定价设置和物流资费…');
    var needCombinationContext = variants.some(function (variant) { return arr(variant && variant.sourceBundleIds).length > 0; });
    var contextPromise = needCombinationContext ? ensureCombinationContext() : Promise.resolve();
    return contextPromise.then(function () {
      return Promise.all([
        requestJson('/api/pricing-settings'),
        requestJson('/api/logistics-configs')
      ]);
    }).then(function (values) {
      var settings = values[0] && values[0].settings || {};
      var logisticsConfig = values[1] || {};
      if (settings.targetMarginPct === null || settings.targetMarginPct === undefined || settings.targetMarginPct === '' || settings.defaultCommissionPct === null || settings.defaultCommissionPct === undefined || settings.defaultCommissionPct === '') {
        note('请先到“设置 → 定价设置”配置目标利润率和默认平台佣金率，再使用一键计算价格。', true);
        return;
      }
      var succeeded = [], skipped = [];
      variants.forEach(function (variant, index) {
        var label = pricingVariantLabel(variant, index);
        var cost = combinationCostForVariant(variant);
        if (cost.loading || !cost.result || !cost.result.ok) {
          skipped.push(label + '：采购总成本尚未读取完整');
          return;
        }
        if (arr(cost.result.missingRefs).length) {
          skipped.push(label + '：组合子项成本未读取完整');
          return;
        }
        var purchaseTotal = Number(cost.result.basePurchase || 0) + Number(cost.result.additionalPurchase || 0);
        if (!(purchaseTotal > 0)) {
          skipped.push(label + '：缺少采购价');
          return;
        }
        var result = window.WYERP_PRODUCT_VARIANT_PRICING.calculate({
          costTotal: cost.result.total,
          weightG: pricingPackageValue(variant, 'weightG', 'weight'),
          lengthMm: pricingPackageValue(variant, 'packageLength', 'length'),
          widthMm: pricingPackageValue(variant, 'packageWidth', 'width'),
          heightMm: pricingPackageValue(variant, 'packageHeight', 'height'),
          logisticsConfig: logisticsConfig,
          settings: settings,
          commissionPct: settings.defaultCommissionPct,
          commissionSource: 'default_setting'
        }, {
          quoteModel: window.WYERP_LOGISTICS_QUOTE,
          calculator: window.WYERP_COMMERCE_CALCULATORS
        });
        if (!result.ok) {
          skipped.push(label + '：' + (result.message || '无法计算价格'));
          return;
        }
        if (options.fillOnlyMissing && [variant.lowest, variant.sale, variant.old].every(function (value) { return String(value == null ? '' : value).trim(); })) { skipped.push(label + '：已有完整价格'); return; }
        if (applyVariantCalculatedPrice(index, result, options)) succeeded.push(label + ' → 最低¥' + result.minimumCny + ' / 销售¥' + result.saleCny + ' / 划线¥' + result.oldCny);
        else skipped.push(label + '：售价输入框未找到');
      });
      if (succeeded.length) markWorkspaceDirty();
      var message = '一键定价完成：成功 ' + succeeded.length + '/' + variants.length + ' 个SKU';
      if (skipped.length) message += '；跳过 ' + skipped.length + ' 个：' + skipped.join('；');
      message += '。价格仅回填当前页面，保存/提交后才会生效。';
      note(message, !succeeded.length && skipped.length > 0);
    }).catch(function (error) {
      note((error && error.message ? error.message : '一键计算价格失败') + '；本次未自动提交商品。', true);
    }).finally(function () {
      button.disabled = false;
    });
  }
  function renderVariantHead(columns) {
    var head = [
      '<th class="variant-col-select"><span class="variant-select"><input id="variantSelectAll" type="checkbox" aria-label="全选变体"><span>⌄</span></span></th>',
      '<th class="variant-col-index">' + variantHeadTitle('序号') + '</th>',
      '<th class="variant-col-name">' + variantHeadTitle('SKU名称', { field: 'name' }) + '</th>',
      '<th class="variant-col-images">' + variantHeadTitle('图片', { required: true }) + sameFirstAction('images') + '</th>',
      '<th class="variant-col-combination">' + variantHeadTitle('组合') + '</th>',
      '<th class="variant-col-video-cover">' + variantHeadTitle('视频封面') + sameFirstAction('field:videoCover') + '</th>',
      '<th class="variant-col-video">' + variantHeadTitle('视频') + sameFirstAction('field:video') + '</th>',
      '<th class="variant-col-offer">' + variantHeadTitle('货号', { field: 'offerId', required: true }) + '<span class="variant-head-actions"><button class="variant-head-action random-offer-btn" id="randomOfferBtn" type="button" hidden title="按 wy-年月日-4位随机字母-0001 生成；多变体共用随机字母并递增尾号">一键生成货号</button></span></th>',
      '<th class="variant-col-purchase">' + variantHeadTitle('采购价', { field: 'purchase' }) + sameFirstAction('field:purchase') + '</th>',
      '<th class="variant-col-shipping">' + variantHeadTitle('国内快递费', { field: 'domesticShipping' }) + sameFirstAction('field:domesticShipping') + '</th>',
      '<th class="variant-col-purchase-total">' + variantHeadTitle('采购总成本') + '</th>',
      '<th class="variant-col-lowest">' + variantHeadTitle('最低价', { field: 'lowest', required: true }) + sameFirstAction('field:lowest') + '</th>',
      '<th class="variant-col-sale">' + variantHeadTitle('销售价', { field: 'sale', required: true }) + sameFirstAction('field:sale') + '</th>',
      '<th class="variant-col-old">' + variantHeadTitle('划线价', { field: 'old', required: true }) + sameFirstAction('field:old') + '</th>'
    ];
    columns.forEach(function (column) {
      var complex = Number(column.attribute.complexId || column.attribute.complex_id || column.attribute.attribute_complex_id), color = variantAutoAttributeKind(column.attribute) === 'color';
      head.push('<th class="variant-col-dynamic' + (color ? ' variant-col-color' : '') + '">' + variantHeadTitle(displayAttrName(column.attribute.name), { attributeIndex: column.index, required: Boolean(column.attribute.required), aspect: Boolean(column.attribute.aspect), removeIndex: column.removable ? column.index : null }) + sameFirstAction('attribute:' + column.index, Boolean(complex)) + '</th>');
    });
    head.push('<th class="variant-col-actions">' + variantHeadTitle('操作') + '</th>');
    $('variantHeadRow').innerHTML = head.join('');
    var randomOfferButton = $('randomOfferBtn'); if (randomOfferButton) { randomOfferButton.hidden = !createMode; randomOfferButton.onclick = generateOfferIds; }
    var width = 2042 + columns.reduce(function (sum, column) { return sum + (variantAutoAttributeKind(column.attribute) === 'color' ? 230 : 150); }, 0);
    $('variantTable').style.width = width + 'px'; $('variantTable').style.minWidth = width + 'px'; $('variantTable').style.maxWidth = width + 'px';
  }
  function renderVariants() {
    var dynamicColumns = variantAttributeColumns();
    dynamicColumns.forEach(function (column) {
      var key = variantAttributeKey(column.attribute);
      if (!promotionState.attributes[key]) promotionState.attributes[key] = {original: promotionSnapshot(column.attribute, column.binding), variantValues: {}};
    });
    var columnCount = 15 + dynamicColumns.length;
    renderVariantHead(dynamicColumns);
    $('variantBody').innerHTML = variants.map(function (v, i) {
      var parent = '<tr data-index="' + i + '"><td class="variant-col-select"><span class="variant-select"><input type="checkbox" aria-label="选择变体 ' + (i + 1) + '"></span></td><td class="variant-col-index"><span class="variant-row-number">' + (i + 1) + '</span></td><td class="variant-col-name"><input class="variant-name-input" data-field="name" value="' + esc(v.name) + '" title="' + esc(v.name) + '"></td><td class="variant-col-images">' + imageCell(v) + '</td>' + combinationCell(v, i) + '<td class="variant-col-video-cover">' + videoCell(v.videoCover, true, i === 0, v.video) + '<input type="hidden" data-field="videoCover" value="' + esc(v.videoCover) + '"></td><td class="variant-col-video">' + videoCell(v.video, false, i === 0, v.video) + '<input type="hidden" data-field="video" value="' + esc(v.video) + '"></td><td class="variant-col-offer"><input class="variant-offer-input" data-field="offerId" spellcheck="false" value="' + esc(v.offerId) + '"><input type="hidden" data-field="sku"></td><td class="variant-col-purchase"><input data-field="purchase" value="' + esc(v.purchase) + '"></td><td class="variant-col-shipping"><input data-field="domesticShipping" inputmode="decimal" value="' + esc(v.domesticShipping) + '"></td>' + purchaseTotalCostCell(v) + '<td class="variant-col-lowest"><input data-field="lowest" value="' + esc(v.lowest) + '"></td><td class="variant-col-sale"><input data-field="sale" value="' + esc(v.sale) + '"></td><td class="variant-col-old"><input data-field="old" value="' + esc(v.old) + '"></td>' + dynamicColumns.map(function (column) { return variantAttributeTemplate(column, v, i); }).join('') + '<td class="variant-col-actions"><span class="variant-actions"><button class="btn" type="button" data-copy="' + i + '">复制</button><button class="btn" type="button" data-delete="' + i + '"' + (variants.length < 2 ? ' disabled' : '') + '>删除</button></span></td></tr>';
      return parent + combinationChildRows(v, i, columnCount);
    }).join('');
    $('variantBody').querySelectorAll('tr[data-index]').forEach(function (row, i) {
      var v = variants[i], offer = row.querySelector('[data-field="offerId"]');
      row.querySelector('[data-field="sku"]').value = v.sku;
      if (!createMode) {
        offer.readOnly = true; offer.title = '现有商品货号仅展示；改货号需单独的平台操作';
        row.querySelector('[data-field="name"]').readOnly = true;
        row.querySelectorAll('[data-copy],[data-delete]').forEach(function (button) { button.disabled = true; button.title = '此页仅编辑当前平台商品，不能复制创建或删除平台商品'; });
      }
    });
    $('variantBody').querySelectorAll('.variant-offer-input').forEach(sizeOfferField);
    var selectAll = $('variantSelectAll');
    if (selectAll) {
      selectAll.checked = false; selectAll.indeterminate = false;
      selectAll.onchange = function () {
        $('variantBody').querySelectorAll('tr[data-index] .variant-col-select input[type="checkbox"]').forEach(function (box) { box.checked = selectAll.checked; });
      };
    }
    $('variantBody').querySelectorAll('tr[data-index] .variant-col-select input[type="checkbox"]').forEach(function (box) {
      box.onchange = function () {
        if (!selectAll) return;
        var boxes = Array.from($('variantBody').querySelectorAll('tr[data-index] .variant-col-select input[type="checkbox"]'));
        var checked = boxes.filter(function (item) { return item.checked; }).length;
        selectAll.checked = Boolean(boxes.length) && checked === boxes.length;
        selectAll.indeterminate = checked > 0 && checked < boxes.length;
      };
    });

    bindVariantFloatingScroll(); refreshVariantFloatingScroll();
    if (window.WYERP_PRODUCT_FIELD_HELP) window.WYERP_PRODUCT_FIELD_HELP.variants();
    hydrateSharedAttributes();
    refreshMediaPreviews();
    if (window.WYERP_PRODUCT_FIELD_HELP) window.WYERP_PRODUCT_FIELD_HELP.attributes(attributes);
    refreshOptionControls(); renderVariantAutoWarnings(); renderPromotionFields();
  }
  function renderCategoryOptions() {
    var selected = val('category'), select = $('category');
    select.replaceChildren();
    function option(value, label) { var node = document.createElement('option'); node.value = value; node.textContent = label; select.appendChild(node); }
    if (!createMode) {
      var locked = lockedCategory || { descriptionId: '', typeId: '', label: '未取得商品原类目' };
      option(locked.descriptionId && locked.typeId ? locked.descriptionId + ':' + locked.typeId : 'existing', locked.label || '商品原类目名称暂不可用');
      select.disabled = true;
      $('categoryHint').textContent = '编辑商品不能修改类目；商品类型随原类目确定。';
      return;
    }
    var matches = catalog;
    option('', matches.length ? '请选择三级类目' : (catalog.length ? '没有匹配的类目' : '暂无可用类目'));
    var current = catalog.find(function (item) { return categoryKey(item) === selected; });
    if (!current && pendingCreateCategory && pendingCreateCategory.descriptionId && pendingCreateCategory.typeId) {
      var pendingKey = pendingCreateCategory.descriptionId + ':' + pendingCreateCategory.typeId;
      option(pendingKey, (pendingCreateCategory.label || '已匹配Ozon三级类目') + (catalog.length ? '（当前匹配）' : '（目录加载中）'));
      if (!selected) selected = pendingKey;
    }
    if (current && matches.indexOf(current) < 0) option(selected, categoryText(current) + '（当前选择）');
    matches.forEach(function (item) { option(categoryKey(item), categoryText(item)); });
    select.value = selected;
    select.disabled = !catalog.length;
    $('categoryHint').textContent = '已同步可用类目 ' + catalog.length + ' 项，可直接输入部分名称筛选；rFBS 可售范围待官方文档确认。';
    if (categorySelect) categorySelect.refresh();
  }
  function selectCategory(descriptionId, typeId, fallback) {
    if (!createMode && lockedCategory) { descriptionId = lockedCategory.descriptionId; typeId = lockedCategory.typeId; fallback = lockedCategory.label; }
    var match = catalog.find(function (item) { return String(item.descriptionCategoryId) === String(descriptionId) && String(item.typeId) === String(typeId); });
    if (!match && fallback) match = catalog.find(function (item) { return categoryText(item) === String(fallback).replace(/\s*>\s*/g, ' / '); });
    if (match) { descriptionId = match.descriptionCategoryId; typeId = match.typeId; pendingCreateCategory = null; }
    else if (createMode && descriptionId && typeId) pendingCreateCategory = { descriptionId: String(descriptionId), typeId: String(typeId), label: fallback || '' };
    if (!createMode) lockedCategory = { descriptionId: descriptionId || '', typeId: typeId || '', label: match ? categoryText(match) : (fallback || '') };
    $('descriptionCategoryId').value = descriptionId || ''; $('typeId').value = typeId || '';
    renderCategoryOptions();
    if (createMode) $('category').value = match ? categoryKey(match) : (descriptionId && typeId ? String(descriptionId) + ':' + String(typeId) : '');
    if (categorySelect) categorySelect.refresh();
    refreshOptionControls();
    return match;
  }
  function collectionCategoryRecord(category, method) {
    if (!category) return null;
    var descriptionCategoryId = String(category.descriptionCategoryId || ''), typeId = String(category.typeId || '');
    if (!/^\d+$/.test(descriptionCategoryId) || !/^\d+$/.test(typeId)) return null;
    var path = arr(category.path).map(function (level) { return String(level && typeof level === 'object' ? (level.name || level.title || level.label || '') : level || ''); }).filter(Boolean);
    return {
      status: 'matched', method: method || 'manual_editor', confidence: 1, requiresManual: false, warning: '', alternatives: [], reasons: [method === 'manual_editor' ? '用户在商品编辑页手动选择' : '商品编辑页自动匹配'],
      category: { key: descriptionCategoryId + ':' + typeId, descriptionCategoryId: descriptionCategoryId, typeId: typeId, path: path, pathText: categoryText(category) || path.join(' > ') }
    };
  }
  function persistCollectionCategory(match) {
    if (!createMode || !collectionSourceId || !collectionModel || !match || match.status !== 'matched') return Promise.resolve(false);
    var category = match.category && typeof match.category === 'object' ? match.category : {};
    var descriptionCategoryId = String(category.descriptionCategoryId || ''), typeId = String(category.typeId || '');
    if (!/^\d+$/.test(descriptionCategoryId) || !/^\d+$/.test(typeId)) return Promise.resolve(false);
    var method = String(match.method || 'matched'), writeKey = collectionSourceId + ':' + descriptionCategoryId + ':' + typeId + ':' + method;
    if (collectionCategoryWriteKey === writeKey) return Promise.resolve(true);
    var found = false, rows = collectionModel.normalizeAll(erpStorage.get(COLLECTION_KEY, []));
    var next = rows.map(function (item) {
      if (item.id !== collectionSourceId) return item;
      found = true;
      return Object.assign(collectionModel.applyOzonMatch(item, match), { updatedAt: new Date().toISOString() });
    });
    if (!found) return Promise.resolve(false);
    collectionCategoryWriteKey = writeKey;
    return erpStorage.set(COLLECTION_KEY, next).then(function () { return true; }).catch(function (error) { collectionCategoryWriteKey = ''; throw error; });
  }
  function autoMatchCollectionCategory(collected) {
    if (!createMode || !collected || !collectionSourceId || !collectionModel) return Promise.resolve(false);
    var existing = collectionModel.ozonCategory(collected);
    if (existing && existing.status === 'matched' && /^\d+$/.test(String(existing.descriptionCategoryId || '')) && /^\d+$/.test(String(existing.typeId || ''))) return Promise.resolve(false);
    note('采集箱暂无已确认的Ozon类目，正在自动匹配…');
    return requestJson('/api/product-category-mappings/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [collectionModel.categoryMatchInput(collected)] }) }).then(function (data) {
      var entry = arr(data.results).find(function (item) { return String(item && item.id || '') === String(collected.id || ''); });
      var match = entry && entry.match, category = match && match.category || {};
      if (!match || match.status !== 'matched' || !/^\d+$/.test(String(category.descriptionCategoryId || '')) || !/^\d+$/.test(String(category.typeId || ''))) {
        selectCategory('', '', '');
        note('未能可靠匹配Ozon类目，当前保持为空；可以手动选择类目。');
        return false;
      }
      selectCategory(category.descriptionCategoryId, category.typeId, category.pathText || arr(category.path).join(' / '));
      return persistCollectionCategory(match).then(function () {
        note('已自动匹配Ozon类目并回写采集箱。');
        loadCurrentCategoryAttributes();
        return true;
      });
    }).catch(function (error) {
      selectCategory('', '', '');
      note('自动匹配Ozon类目失败，当前保持为空；可手动选择。' + (error && error.message ? ' ' + error.message : ''), true);
      return false;
    });
  }
  function categoryChanged() {
    if (!createMode) { selectCategory(); return; }
    categoryEdited = true;
    var match = catalog.find(function (item) { return categoryKey(item) === val('category'); });
    if (!match) { attributeRequest++; requestedCategory = ''; $('descriptionCategoryId').value = ''; $('typeId').value = ''; refreshOptionControls(); $('categoryHint').textContent = '请选择列表中的三级类目'; attributeStatus('请先选择有效的三级类目。', false); return; }
    selectCategory(match.descriptionCategoryId, match.typeId, categoryText(match)); loadCurrentCategoryAttributes();
    var manualMatch = collectionCategoryRecord(match, 'manual_editor');
    if (manualMatch) persistCollectionCategory(manualMatch).then(function (saved) { if (saved) note('已选择Ozon类目并回写采集箱。'); }).catch(function (error) { note('类目已选择，但回写采集箱失败：' + (error.message || '保存失败'), true); });
  }
  function loadCatalog(force) {
    $('retryCategoryBtn').hidden = true;
    return categoryRequest('catalog', '/api/category-attributes/catalog', force).then(function (data) {
      categoryVersion = data.libraryUpdatedAt || categoryVersion;
      var seen = new Set();
      catalog = arr(data.items).filter(function (item) { var key = categoryKey(item); if (item.disabled || !/^\d+:\d+$/.test(key) || !categoryText(item) || seen.has(key)) return false; seen.add(key); return true; });
      if (!createMode && product) selectCategory(); else renderCategoryOptions();
    }).catch(function () {
      $('retryCategoryBtn').hidden = false;
      $('categoryHint').textContent = '类目目录加载失败，已有商品类目和填写内容保持不变。';
    });
  }
  function loadVariantCategoryDefinition(rowIndex, selectedKey, select) {
    var variant = variants[rowIndex], oldKey = String(variant && variant.descriptionCategoryId || '') + ':' + String(variant && variant.typeId || '');
    var match = catalog.find(function (item) { return categoryKey(item) === selectedKey; });
    if (!variant || !match || selectedKey === oldKey) return Promise.resolve(true);
    $('saveBtn').disabled = true; $('saveDraftBtn').disabled = true; if (select) select.disabled = true;
    return categoryRequest('definition', '/api/category-attributes/category?descriptionCategoryId=' + encodeURIComponent(match.descriptionCategoryId) + '&typeId=' + encodeURIComponent(match.typeId), false).then(function (data) {
      if (!data.item) throw new Error('所选类目没有可用的属性定义');
      var defs = arr(data.item.requiredAttributes).map(function (a) { return normAttr(Object.assign({}, a, {required:true,is_required:true,categoryDefined:true})); }).concat(arr(data.item.optionalAttributes).map(function (a) { return normAttr(Object.assign({}, a, {required:false,is_required:false,categoryDefined:true})); }));
      var available = new Set(attributes.map(variantAttributeKey)), required = defs.filter(function (a) { return a.required && !isTypeAttribute(a); });
      var missing = required.filter(function (a) { return !available.has(variantAttributeKey(a)); });
      if (missing.length) throw new Error('所选类目新增了当前变体表无法填写的必填属性：' + missing.slice(0,3).map(function (a) { return displayAttrName(a.name); }).join('、'));
      var allowed = new Set(defs.filter(function (a) { return !isTypeAttribute(a); }).map(variantAttributeKey));
      variant.descriptionCategoryId = String(match.descriptionCategoryId); variant.typeId = String(match.typeId); variant.category = categoryText(match);
      variant.categoryAttributeKeys = Array.from(allowed); variant.categoryRequiredKeys = required.map(variantAttributeKey);
      variant.attributes = arr(variant.attributes).filter(function (a) { return allowed.has(variantAttributeKey(a)); });
      fullInfoDirty['variant:' + rowIndex + ':category'] = true; variantStructureEdited = true; markWorkspaceDirty(); renderVariants(); note('第' + (rowIndex + 1) + '行已切换产品类目并核对必填属性'); return true;
    }).catch(function (error) {
      if (select) select.value = oldKey; note('SKU类目未切换：' + (error.message || '类目属性读取失败'), true); return false;
    }).finally(function () { if (select && select.isConnected) select.disabled = false; $('saveBtn').disabled = false; $('saveDraftBtn').disabled = false; });
  }
  function loadLibraryAttributes(descriptionId, typeId, existing, force) {
    if (!descriptionId || !typeId) return Promise.reject(new Error('没有匹配到三级类目编号'));
    var key = String(descriptionId) + ':' + String(typeId), requestId = ++attributeRequest;
    $('attributeLoadStatus').querySelectorAll('[data-option-diagnostic-id]').forEach(function (row) { row.remove(); });
    if (requestedCategory && key !== requestedCategory) { resetHydratedCategoryFields(); variants.forEach(function (variant) { variant.attributes = []; }); attributes = []; moreAttributesOpen = false; hydrateHashtags(); hydrateSharedAttributes(); renderAttributes(); }
    requestedCategory = key;
    attributeStatus('正在载入类目属性，已有内容可继续填写…', false);
    return categoryRequest('definition', '/api/category-attributes/category?descriptionCategoryId=' + encodeURIComponent(descriptionId) + '&typeId=' + encodeURIComponent(typeId), force).then(function (data) {
      if (requestId !== attributeRequest || key !== val('descriptionCategoryId') + ':' + val('typeId')) return;
      if (!data.item) throw new Error('当前类目还没有可用的属性定义');
      categoryVersion = data.libraryUpdatedAt || categoryVersion; optionCategory = key;
      collectVariants(); collectAttributes();
      var oldDefinitions = Object.create(null); attributes.forEach(function (a) { oldDefinitions[detailData.attributeKey(a)] = a; });
      function definition(a, required) {
        var old = oldDefinitions[detailData.attributeKey(a)];
        var merged = Object.assign({}, old, a, { required: required, is_required: required, categoryDefined: true });
        if (old) { merged.value = old.value; if (old.values) merged.values = old.values; }
        else if (existing && Object.prototype.hasOwnProperty.call(existing, String(a.id))) merged.value = existing[String(a.id)];
        return normAttr(merged);
      }
      attributes = arr(data.item.requiredAttributes).map(function (a) { return definition(a, true); }).concat(arr(data.item.optionalAttributes).map(function (a) { return definition(a, false); }));
      var defined = new Set(attributes.map(detailData.attributeKey));
      Object.keys(oldDefinitions).forEach(function (key) { if (!defined.has(key)) attributes.push(Object.assign({}, oldDefinitions[key], { categoryDefined: false })); });
      hydrateBrand(); hydrateHashtags(); renderAttributes(); renderVariants(); attributeStatus('', false);
      return true;
    }).catch(function (error) {
      if (requestId !== attributeRequest) return;
      optionCategory = key; refreshOptionControls();
      attributeStatus('类目属性加载失败，已保留现有填写内容：' + (error.message || '读取失败'), true);
      return false;
    });
  }
  function loadCurrentCategoryAttributes(force) {
    var id = val('descriptionCategoryId'), type = val('typeId');
    if (!id || !type) { attributeStatus('选择三级类目后自动显示需要填写的属性。', false); return; }
    if (force || requestedCategory !== id + ':' + type) return loadLibraryAttributes(id, type, {}, force);
  }
  function normalizeSourceBundle(value, index) { return combinationModel.normalizeBundle(value, index); }
  function syncSourceLegacyFields() { return { srcUrl: val('sourceUrl'), srcPrice: val('sourcePrice') }; }
  function findCollectionSourceRecord(bundle) {
    if (!collectionModel) return null;
    var url = String(bundle && bundle.url || '').trim();
    var records = collectionModel.normalizeAll(erpStorage.get(COLLECTION_KEY, []));
    return records.find(function (item) { return url && String(item.sourceUrl || '').trim() === url; }) || (collectionSourceRecord && (!url || String(collectionSourceRecord.sourceUrl || '').trim() === url) ? collectionSourceRecord : null);
  }
  function showSourceImagePicker(index) {
    var bundle = sourceBundles[index]; if (!bundle) return;
    function finish() { collectionSourceRecord = findCollectionSourceRecord(bundle) || collectionSourceRecord; sourceImagePickerIndex = sourceImagePickerIndex === index ? -1 : index; renderSourceBundles(); if (sourceImagePickerIndex === index && !sourceImageCandidates(bundle).length) note('暂无可用货源图片；只会使用采集箱/浏览器已缓存的货源图片，不会自动抓取网页', true); }
    var cached = findCollectionSourceRecord(bundle);
    if (cached) { collectionSourceRecord = cached; finish(); return; }
    erpStorage.init([COLLECTION_KEY]).then(finish).catch(function () { sourceImagePickerIndex = index; renderSourceBundles(); note('暂无可用货源图片；采集箱缓存读取失败', true); });
  }
  function sourceImageCandidates(bundle) {
    var item = collectionSourceRecord, result = [], seen = new Set();
    if (!item) return result;
    var sourceUrl = String(item.sourceUrl || '').trim(), bundleUrl = String(bundle && bundle.url || '').trim();
    if (sourceUrl && bundleUrl && sourceUrl !== bundleUrl) return result;
    function add(value) { var url = String(value || '').trim(); if (!url || seen.has(url) || !/^https:\/\//i.test(url)) return; seen.add(url); result.push(url); }
    var capture = item.capture && typeof item.capture === 'object' ? item.capture : {};
    add(item.image); arr(item.images).forEach(add);
    arr(capture.skuImages).forEach(function (entry) { add(entry && (entry.url || entry.imageUrl)); });
    arr(capture.variants).forEach(function (entry) { add(entry && (entry.imageUrl || entry.image || entry.thumbnailUrl || entry.url)); });
    if (capture.primarySkuImage) add(capture.primarySkuImage.url || capture.primarySkuImage.imageUrl);
    arr(capture.media).forEach(function (entry) { if (entry && String(entry.kind || '').toLowerCase() === 'image') add(entry.url || entry.src); });
    return result.slice(0, 60);
  }
  function renderSourceBundles() {
    var host = $('sourceBundleList');
    if (!sourceBundles.length) { host.innerHTML = '<div class="source-bundle-empty">暂无组合货源，点击右侧“+”添加</div>'; syncSourceLegacyFields(); return; }
    host.innerHTML = sourceBundles.map(function (bundle, index) {
      var candidates = sourceImagePickerIndex === index ? sourceImageCandidates(bundle) : [], sourceState = bundleSourceState(bundle);
      var preview = bundle.referenceImage ? '<span class="source-reference-image" data-source-reference-image="' + esc(bundle.referenceImage) + '" role="img" aria-label="货源参考图"></span>' : '<span class="source-reference-empty">暂无参考图</span>';
      var picker = sourceImagePickerIndex === index ? '<div class="source-image-picker">' + (candidates.length ? candidates.map(function (url) { return '<button type="button" class="source-image-choice' + (url === bundle.referenceImage ? ' on' : '') + '" data-source-image-choice="' + esc(url) + '" title="选为参考图"><span data-source-candidate-image="' + esc(url) + '"></span></button>'; }).join('') : '<p>暂无可用货源图片</p>') + '</div>' : '';
      var state = sourceState.label ? '<span class="source-bundle-state is-' + esc(sourceState.code) + '">' + esc(sourceState.label) + '</span>' + (sourceState.code === 'stale' ? '<button type="button" class="source-bundle-refresh" data-combination-refresh="' + esc(bundle.id) + '">刷新组合快照</button>' : '') : '';
      return '<article class="source-bundle-card" data-source-bundle-index="' + index + '"><div class="source-bundle-head"><strong>组合货源 ' + (index + 1) + '</strong><span class="source-bundle-state-actions">' + state + '</span><button type="button" class="round-field-action source-bundle-remove" data-source-remove title="取消这个货源" aria-label="取消组合货源' + (index + 1) + '">×</button></div><label class="source-bundle-url"><span>货源链接</span><span class="source-bundle-url-control"><input data-source-bundle-field="url" value="' + esc(bundle.url) + '" placeholder="输入货源链接"><button type="button" data-source-open title="打开货源链接">↗</button><button type="button" data-source-images>获取图片</button></span></label><div class="source-bundle-cost-row"><label><span>采购价</span><input data-source-bundle-field="purchase" inputmode="decimal" value="' + esc(bundle.purchase) + '" placeholder="采购价"></label><label><span>国内快递费</span><input data-source-bundle-field="domesticShipping" inputmode="decimal" value="' + esc(bundle.domesticShipping) + '" placeholder="国内快递费"></label></div><div class="source-reference-row"><span class="source-reference-title">参考图</span>' + preview + '<button type="button" class="source-reference-pick" data-source-images>选择参考图</button></div>' + picker + '</article>';
    }).join('');
    host.querySelectorAll('[data-source-reference-image]').forEach(function (node) { node.style.backgroundImage = 'url(' + JSON.stringify(node.dataset.sourceReferenceImage || '') + ')'; });
    host.querySelectorAll('[data-source-candidate-image]').forEach(function (node) { node.style.backgroundImage = 'url(' + JSON.stringify(node.dataset.sourceCandidateImage || '') + ')'; });
    syncSourceLegacyFields();
  }
  function restoreSourceBundles(item) {
    sourceBundles = combinationModel.normalizeBundles(item && item.sourceBundles);
    sourceBundles.forEach(function (bundle) {
      var snapshot = bundle && bundle.sourceSnapshot, variants = arr(snapshot && snapshot.variants);
      if (!snapshot || !variants.length) return;
      variants.forEach(function (entry, index) { if (entry && !entry.combinationRowKey) entry.combinationRowKey = 'row:' + String(index + 1); });
      var validKeys = variants.map(function (entry, index) { return String(entry && entry.combinationRowKey || 'row:' + String(index + 1)); });
      if (Array.isArray(snapshot.selectedVariantKeys)) {
        snapshot.selectedVariantKeys = snapshot.selectedVariantKeys.map(String).filter(function (key) { return validKeys.indexOf(key) >= 0; });
        snapshot.variantSelectionInitialized = true;
        return;
      }
      if (snapshot.variantSelectionInitialized === true) {
        snapshot.selectedVariantKeys = [];
        return;
      }
      var legacyIds = Array.from(new Set(arr(bundle.selectedVariantIds).map(String).filter(Boolean)));
      if (legacyIds.length) {
        var keysBySku = new Map();
        variants.forEach(function (entry, index) { var skuId = String(entry && entry.skuId || '').trim(); if (!skuId) return; if (!keysBySku.has(skuId)) keysBySku.set(skuId, []); keysBySku.get(skuId).push(validKeys[index]); });
        var canMapLegacySelection = legacyIds.every(function (skuId) { return keysBySku.has(skuId) && keysBySku.get(skuId).length === 1; });
        if (canMapLegacySelection) {
          snapshot.selectedVariantKeys = legacyIds.map(function (skuId) { return keysBySku.get(skuId)[0]; });
          snapshot.variantSelectionInitialized = true;
          return;
        }
      } else {
        var stableSkuIds = variants.map(function (entry) { return String(entry && entry.skuId || '').trim(); });
        var hasStableLegacyIdentity = stableSkuIds.length === variants.length && stableSkuIds.every(Boolean) && new Set(stableSkuIds).size === stableSkuIds.length;
        if (hasStableLegacyIdentity) {
          snapshot.selectedVariantKeys = validKeys.slice();
          snapshot.variantSelectionInitialized = true;
          return;
        }
      }
      delete snapshot.selectedVariantKeys;
      snapshot.variantSelectionInitialized = false;
    });
    combinationRelations = combinationModel.normalizeRelations(item && item.combinationRelations);
    combinationHistory = combinationModel.normalizeHistory(item && item.combinationHistory);
    var graph = combinationModel.validateGraph(combinationRelations);
    if (!graph.ok) { combinationRelations = []; note('检测到旧组合关系存在循环，已暂时停止加载组合关系，请人工核对：' + graph.path.join(' → '), true); }
    renderSourceBundles();
  }
  function resolveLegacyCollectionIdentities() {
    if (!combinationContextLoaded) return;
    var records = combinationPickerState.records, remap = new Map(), changed = false;
    sourceBundles = sourceBundles.map(function (bundle) {
      if (!bundle || bundle.collectionId) return bundle;
      var url = String(bundle.sourceUrl || bundle.url || '').trim(), matches = url ? records.filter(function (record) { return String(record && record.sourceUrl || '').trim() === url; }) : [];
      if (matches.length !== 1) return bundle;
      var record = matches[0], nextId = bundleIdForCollection(record), next = sourceBundleFromCollection(record, bundle); remap.set(String(bundle.id), nextId); next.id = nextId; changed = true; return next;
    });
    if (remap.size) {
      variants.forEach(function (variant) { variant.sourceBundleIds = arr(variant.sourceBundleIds).map(function (id) { return remap.get(String(id)) || id; }); });
      fullInfoDirty['field:sourceBundles'] = true; markWorkspaceDirty();
    }
    if (!createMode && !collectionSourceId && !(product && product.collectionId) && variants.length === 1) {
      var mainUrl = val('sourceUrl'), sourceMatches = mainUrl ? records.filter(function (record) { return String(record && record.sourceUrl || '').trim() === mainUrl; }) : [], onlineRows = arr(erpStorage.get(PRODUCT_KEY, [])), sameSourceRows = mainUrl ? onlineRows.filter(function (row) { return String(row && (row.srcUrl || row.sourceUrl || row.supplierUrl) || '').trim() === mainUrl; }) : [];
      if (sourceMatches.length === 1 && sameSourceRows.length === 1) { collectionSourceId = String(sourceMatches[0].id || ''); fullInfoDirty['field:collectionId'] = true; markWorkspaceDirty(); changed = true; note('检测到旧商品唯一主货源采集记录，已恢复组合身份；保存商品后正式生效。'); }
    }
    if (changed) renderSourceBundles();
  }
  function migrateLegacySourceBundles() {
    legacyCombinationPending = false;
    var eligible = sourceBundles.filter(function (bundle) { return bundle && bundle.collectionId; }), unresolved = sourceBundles.filter(function (bundle) { return bundle && !bundle.collectionId; }), hasAssigned = combinationRelations.length || variants.some(function (variant) { return arr(variant.sourceBundleIds).length; });
    if (hasAssigned) { legacyCombinationPending = unresolved.length > 0; return; }
    if (!eligible.length) { if (sourceBundles.length) { legacyCombinationPending = true; note('检测到旧组合货源无法唯一匹配采集箱记录，已标记“待分配组合”；请从SKU组合列“+”重新选择对应采集商品。', true); } return; }
    if (variants.length !== 1) { legacyCombinationPending = true; note('检测到旧商品级组合货源；当前有多个SKU，无法自动判断归属，已标记“待分配组合”，请分别点击SKU组合列“+”指定父SKU。', true); return; }
    var variant = variants[0], parentRef = parentCombinationRef(variant), now = new Date().toISOString();
    variant.sourceBundleIds = eligible.map(function (bundle) { return bundle.id; });
    combinationRelations = eligible.map(function (bundle, index) { var relation = { id: 'comb_rel_legacy_' + index + '_' + Date.now().toString(36), parentRef: parentRef, childRef: 'collection:' + bundle.collectionId, childCollectionId: bundle.collectionId, quantity: 1, createdAt: now, updatedAt: now, lastCombinedAt: now }; appendCombinationHistory(parentRef, relation, 'linked', '旧数据迁移'); return relation; });
    legacyCombinationPending = unresolved.length > 0; fullInfoDirty['variant:0:sourceBundleIds'] = true; fullInfoDirty['field:sourceBundles'] = true; variantStructureEdited = true; markWorkspaceDirty(); expandedCombinationParents.add(variant.erpVariantRef); note(unresolved.length ? '旧组合货源中可唯一识别的部分已迁移到唯一SKU；仍有 ' + unresolved.length + ' 条标记“待分配组合”。' : '检测到旧商品级组合货源，已自动迁移到唯一SKU；保存商品后正式生效。', unresolved.length > 0);
  }
  function markSourceBundlesDirty() { fullInfoDirty['field:sourceBundles'] = true; markWorkspaceDirty(); syncSourceLegacyFields(); }
  function refreshDailySkuMembershipQuota() {
    var host = $('dailySkuDetailQuota');
    if (!host) return Promise.resolve(null);
    if (!createMode) { host.hidden = true; return Promise.resolve(null); }
    host.hidden = false;
    if (!membershipQuotaApi || typeof membershipQuotaApi.load !== 'function') { host.textContent = '今日上架 SKU 额度读取失败'; return Promise.resolve(null); }
    return membershipQuotaApi.load().then(function (payload) {
      var daily = payload && payload.quotas && payload.quotas.dailySku;
      if (!daily) throw new Error('今日上架 SKU 额度缺失');
      var day = payload && payload.quotas && payload.quotas.businessDate;
      membershipQuotaApi.renderFromPayload(host, payload, 'dailySku', { compact: true, label: '今日上架 SKU 会员额度', note: day ? '北京时间 ' + day : '按北京时间自然日统计' });
      return payload;
    }).catch(function () {
      host.className = 'membership-quota-inline membership-quota-card membership-quota-compact is-over-limit';
      host.textContent = '今日上架 SKU 额度读取失败';
      return null;
    });
  }
  function ozonFrontIdentity(item) {
    item = item || {};
    if (!createMode || relistMode) return item;
    var officialUrl = ozonProductLink.officialUrlOf(item);
    return {
      ozonSku: item.ozonSku || item.ozon_sku || '',
      ozonUrl: officialUrl || item.ozonUrl || item.ozon_url || ''
    };
  }
  function syncOzonFrontLink(item) {
    var link = $('ozonProductFrontLink'); if (!link) return;
    var target = ozonProductLink.href(ozonFrontIdentity(item));
    link.hidden = !target;
    if (!target) { link.removeAttribute('href'); link.removeAttribute('aria-label'); return; }
    link.href = target;
    link.title = '在Ozon前台打开当前商品';
    link.setAttribute('aria-label', '在Ozon前台打开当前商品');
  }

  function fill(item) {
    syncOzonFrontLink(item);
    packageDimensionSources = Object.assign({}, item.packageDimensionSources || {});
    packageDimensionValues = {length: String(item.length || item.dimensions && item.dimensions.length || ""), width: String(item.width || item.dimensions && item.dimensions.width || ""), height: String(item.height || item.dimensions && item.dimensions.height || "")};
    if (createMode && (item.descriptionCategoryId || item.description_category_id) && (item.typeId || item.type_id)) {
      pendingCreateCategory = {
        descriptionId: String(item.descriptionCategoryId || item.description_category_id),
        typeId: String(item.typeId || item.type_id),
        label: item.categoryPath || [item.cat1, item.cat2, item.cat3].filter(Boolean).join(' / ')
      };
    }
    lockedCategory = { descriptionId: item.descriptionCategoryId || item.description_category_id || '', typeId: item.typeId || item.type_id || '', label: item.categoryPath || item.category || [item.cat1, item.cat2, item.cat3].filter(Boolean).join(' / ') };
    fillShops({ clientId: item.clientId, externalShopId: item.externalShopId, shopId: item.shopId, shop: item.shop }); $('title').value = item.name || item.title || ''; $('brand').value = item.brand || '无品牌'; brandHasValue = Boolean(String(item.brand || '').trim());
    $('autoColorSample').checked = Boolean(item.autoColorSample);
    var weight = item.weightG || item.weightValue || item.weight || ''; if (/kg$/i.test(String(weight))) weight = Number.parseFloat(weight) * 1000; else weight = Number.parseFloat(weight) || ''; $('weight').value = weight;
    $('length').value = item.length != null ? item.length : (item.depth || item.lengthMm || item.dimensions && item.dimensions.length || ''); $('width').value = item.width != null ? item.width : (item.widthMm || item.dimensions && item.dimensions.width || ''); $('height').value = item.height != null ? item.height : (item.heightMm || item.dimensions && item.dimensions.height || '');
    $('barcode').value = item.barcode || '';
    $('sourceUrl').value = item.srcUrl || ''; $('sourcePrice').value = item.srcPrice == null ? '' : String(item.srcPrice); $('sourceNote').value = item.srcNote || ''; $('description').value = item.description || ''; $('richContent').value = item.richContent || '';
    promotionState = cloneVariantAttribute(item.promotionState) || {schemaVersion: 1, attributes: {}};
    if (Array.isArray(item.manualVariantAttributes)) manualVariantAttributeKeys = new Set(item.manualVariantAttributes.map(String));
    if (Array.isArray(item.suppressedVariantAttributes)) suppressedVariantAttributeKeys = new Set(item.suppressedVariantAttributes.map(String));
    restoreSourceBundles(item);
    attributes = arr(item.editorAttributes || item.attributes).map(function (a) { return normAttr(a); }); hydrateBrand(); hydrateHashtags(); variants = arr(item.variants).length && typeof item.variants[0] === 'object' ? item.variants.map(normVariant) : [baseVariant(item)]; if (variants[0] && arr(item.variants)[0] && item.variants[0].domesticShipping == null) variants[0].domesticShipping = item.domesticShipping == null ? '' : String(item.domesticShipping); normalizeVariantAttributeModes(); migrateLegacySourceBundles();
    renderAttributes(); renderVariants();
    if (variants.some(function (variant) { return arr(variant.sourceBundleIds).length; }) || sourceBundles.length) ensureCombinationContext().then(function () { renderSourceBundles(); renderVariants(); }).catch(function () { note('组合关系读取失败，当前组合成本暂未完整计算', true); });
    selectCategory(item.descriptionCategoryId || item.description_category_id, item.typeId || item.type_id, item.categoryPath || item.category || [item.cat1, item.cat2, item.cat3].filter(Boolean).join(' / '));
  }
  function activeShop() { return productShops.resolve(shops, val('shop')); }
  function ozonForShop(shop, endpoint, body) { var command = erpStorage.ozonCommandForEndpoint(endpoint); var headers = { 'Content-Type': 'application/json' }; if (command.writes) headers['Idempotency-Key'] = erpStorage.createIdempotencyKey(); return requestJson('/api/integrations/ozon/commands', { method: 'POST', headers: headers, body: JSON.stringify({ clientId: shop.clientId, command: command.name, body: body || {} }) }); }
  function applyProductDetails(info, detail) {
    collectVariants(); collectAttributes();
    var currentVariants = variants.map(function (v) { return Object.assign({}, v); });
    var currentAttributes = attributes.slice(), complete = Boolean(info && detail);
    var next = complete ? detailData.refresh(product, info, detail) : detailData.project(product, info, detail);
    next.sourceBundles = combinationModel.normalizeBundles(sourceBundles); next.combinationRelations = combinationModel.normalizeRelations(combinationRelations); next.combinationHistory = combinationModel.normalizeHistory(combinationHistory);
    next.editorAttributes = detailData.mergeAttributes(complete ? currentAttributes.map(function (a) { return Object.assign({}, a, { value: '', values: [] }); }) : currentAttributes, next.editorAttributes);
    next.editorAttributes = detailData.mergeAttributes(next.editorAttributes, currentAttributes.filter(function (a) { return fullInfoDirty['attribute:' + detailData.attributeKey(a)]; }));
    var fields = { title: 'name', brand: 'brand', weight: 'weightG', length: 'length', width: 'width', height: 'height', barcode: 'barcode', sourceUrl: 'srcUrl', sourcePrice: 'srcPrice', sourceNote: 'srcNote', description: 'description', richContent: 'richContent' };
    var editedValues = Object.create(null);
    Object.keys(fields).forEach(function (id) { if (fullInfoDirty['field:' + id]) next[fields[id]] = editedValues[id] = $(id).value; });
    var chosenShop = val('shop'), hashtags = $('hashtags').value, autoColor = $('autoColorSample').checked;
    if (variantStructureEdited) next.variants = currentVariants;
    else next.variants.forEach(function (v, index) {
      var old = currentVariants.find(function (item) { var left = String(item.offerId || item.article || item.sku || ''); var right = String(v.offerId || v.article || v.sku || ''); return left && right && left === right; }) || currentVariants[index];
      if (old) { v.erpVariantRef = old.erpVariantRef || newErpVariantRef(); v.sourceBundleIds = arr(old.sourceBundleIds).slice(); Object.keys(old).forEach(function (key) { if (fullInfoDirty['variant:' + index + ':' + key]) v[key] = old[key]; }); }
    });
    // Dispose controls before replacing rows; do not collect old DOM into the new variants.
    optionControls.forEach(function (control) { control.destroy(); }); optionControls = [];
    $('variantBody').replaceChildren();
    fill(next);
    Object.keys(editedValues).forEach(function (id) { $(id).value = editedValues[id]; });
    syncBrandAttributes(); syncSharedAttributes();
    if (fullInfoDirty['field:shop']) { $('shop').value = chosenShop; shopSelect.refresh(); }
    if (hashtagsEdited) { $('hashtags').value = hashtags; syncHashtags(); hashtagsControl.refresh(); }
    if (fullInfoDirty['field:autoColorSample']) $('autoColorSample').checked = autoColor;
    refreshOptionControls();
  }
  function loadProductMatch() {
    if (!product || fullInfoLoading) return Promise.resolve();
    if (productScope !== optionScope()) { note('账号或租户已切换，请重新打开商品', true); $('saveBtn').disabled = true; return Promise.resolve(); }
    fullInfoLoading = true; $('saveBtn').disabled = true; $('loadProductInfoBtn').disabled = true;
    note('已有ERP商品数据已填充，正在从Ozon读取基础商品信息、价格、条码、图片/视频、包装重量尺寸和商品属性…');
    var scope = optionScope(), failures = [], shop = resolveTargetShop();
    var id = Number(pid(product)), controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); }, 20000);
    function read(endpoint, body) {
      return requestJson('/api/integrations/ozon/commands', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: shop.clientId || shop.externalShopId, command: erpStorage.ozonCommandForEndpoint(endpoint).name, body: body }) }).then(function (data) {
        var item = detailData.match(data, pid(product));
        if (!item) throw new Error('接口未返回所选商品');
        return item;
      });
    }
    return Promise.resolve().then(function () {
      if (!shop || !(shop.clientId || shop.externalShopId)) throw new Error('无法确认该商品所属的已授权店铺，请核对店铺配置');
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('该商品缺少有效的平台商品编号');
      return Promise.allSettled([
        read('/v3/product/info/list', { product_id: [String(id)] }),
        read('/v4/product/info/attributes', { filter: { product_id: [String(id)], visibility: 'ALL' }, limit: 100 }),
        read('/v5/product/info/prices', { filter: { product_id: [String(id)], visibility: 'ALL' }, limit: 100 })
      ]);
    }).then(function (results) {
      if (scope !== optionScope()) throw new Error('账号或租户已切换，请重新打开商品');
      var labels = ['基础信息', '属性详情', '价格信息'];
      results.forEach(function (result, i) { if (result.status === 'rejected') failures.push(labels[i] + '：' + (result.reason.message || '读取失败')); });
      var info = results[0].status === 'fulfilled' ? results[0].value : null;
      var detail = results[1].status === 'fulfilled' ? results[1].value : null;
      var priceRow = results[2].status === 'fulfilled' ? results[2].value : null;
      var livePrice = priceRow && priceRow.price || {};
      if (priceRow) info = Object.assign({}, info || {}, {
        min_price: livePrice.min_price || priceRow.min_price || '',
        price: livePrice.price || priceRow.priceSell || info && info.price || '',
        old_price: livePrice.old_price || priceRow.priceOriginal || info && info.old_price || ''
      });
      if (info || detail) applyProductDetails(info, detail);
      return loadCatalog().then(function () {
        var categoryId = val('descriptionCategoryId'), typeId = val('typeId');
        if (!categoryId || !typeId) { failures.push('商品缺少类目或类型编号'); return; }
        return loadLibraryAttributes(categoryId, typeId, {}).then(function (ok) { if (!ok) failures.push('类目属性定义未完整加载'); });
      });
    }).then(function () {
      note(failures.length ? '部分信息未加载，已保留现有内容；可重试。' + failures.join('；') : '商品信息已加载并填入对应控件；未提供的字段保留空值，人工成本与编辑内容已保留', failures.length > 0);
      return { ok: failures.length === 0, failures: failures.slice() };
    }).catch(function (error) {
      var message = error && error.message || '读取失败'; note('商品详情加载失败，已保留现有内容：' + message, true);
      return { ok: false, failures: [message] };
    }).finally(function () {
      clearTimeout(timeout); fullInfoLoading = false; $('saveBtn').disabled = scope !== optionScope(); $('loadProductInfoBtn').disabled = false;
    });
  }
  function prepareRelistDraft() {
    if (!relistMode || !product) return false;
    collectVariants(); collectAttributes();
    var prepared = relistModel.prepare({
      attributes: attributes,
      variants: variants,
      sourceBundles: sourceBundles,
      combinationRelations: combinationRelations,
      combinationHistory: combinationHistory
    }, { source: product });
    if (!prepared.relistSource) {
      note('原下架商品缺少可验证的店铺或平台商品编号，不能执行下架重上', true);
      $('saveBtn').disabled = true; $('saveDraftBtn').disabled = true;
      return false;
    }
    relistSource = prepared.relistSource;
    collectionSourceId = String(product.collectionId || '');
    attributes = prepared.attributes.map(function (attribute) { return normAttr(attribute); });
    variants = prepared.variants.map(normVariant);
    sourceBundles = combinationModel.normalizeBundles(prepared.sourceBundles);
    combinationRelations = combinationModel.normalizeRelations(prepared.combinationRelations);
    combinationHistory = [];
    createState = null; createKey = '';
    syncOzonFrontLink({});
    renderAttributes(); hydrateBrand(); hydrateHashtags(); renderVariants(); renderSourceBundles();
    note('已完整复制原下架商品资料；原 Ozon SKU 和旧货号未复用，已按现有规则生成 ' + prepared.generated.values.length + ' 个新货号。确认后将按新增商品流程重新上架。');
    return true;
  }

  function submissionVariants() {
    if (!suppressedVariantAttributeKeys.has('field:barcode') || manualVariantAttributeKeys.has('field:barcode')) return variants;
    return variants.map(function (variant) { return Object.assign({}, variant, {barcode: val('barcode')}); });
  }
  function activePromotionField(field) {
    var column = variantAttributeColumns().find(function (item) { return item.binding && item.binding.area === 'field' && item.binding.key === field; });
    return column && variants[0] ? variantAttributeValue(variants[0], column.attribute, column.binding, 0) : val(field);
  }
  function payload() {
    collectVariants(); collectAttributes(); syncSourceLegacyFields();
    var selected = createMode ? catalog.find(function (item) { return categoryKey(item) === val('category'); }) : null;
    return { draftId: createMode ? createDraftId : product && product.editorDraftId || createDraftId, mode: createMode ? 'create' : 'edit', collectionId: createMode ? (relistMode ? currentMainCollectionId() : String(params.get('collectionId') || '').slice(0, 200)) : currentMainCollectionId(), productId: createMode ? '' : product ? pid(product) : '', relistSource: relistMode ? relistSource : undefined, shop: val('shop'), category: createMode ? categoryText(selected) : lockedCategory && lockedCategory.label || '', descriptionCategoryId: createMode ? selected && selected.descriptionCategoryId || '' : lockedCategory && lockedCategory.descriptionId || '', typeId: createMode ? selected && selected.typeId || '' : lockedCategory && lockedCategory.typeId || '', title: val('title'), brand: val('brand'), barcode: activePromotionField('barcode'), weightG: num('weight'), dimensions: { length: num('length'), width: num('width'), height: num('height') }, packageDimensionSources: Object.assign({}, packageDimensionSources), contentRiskChecks: contentReview ? contentReview.state() : undefined, attributes: attributes.filter(function (a) { return !createMode || !isTypeAttribute(a); }).map(function (a) { if (!manualVariantAttributeKeys.has(variantAttributeKey(a)) && !(attributeFields.classify(a) && attributeFields.classify(a).key === 'barcode' && manualVariantAttributeKeys.has('field:barcode'))) return a; var definition = cloneVariantAttribute(a); definition.value = ''; definition.values = []; return definition; }), variants: submissionVariants(), promotionState: cloneVariantAttribute(promotionState), manualVariantAttributes: Array.from(manualVariantAttributeKeys), suppressedVariantAttributes: Array.from(suppressedVariantAttributeKeys), sourceBundles: combinationModel.normalizeBundles(sourceBundles), combinationRelations: combinationModel.normalizeRelations(combinationRelations), combinationHistory: combinationModel.normalizeHistory(combinationHistory), autoColorSample: $('autoColorSample').checked, srcUrl: val('sourceUrl'), srcPrice: val('sourcePrice'), domesticShipping: variants[0] ? variants[0].domesticShipping : '', srcNote: val('sourceNote'), description: activePromotionField('description'), richContent: activePromotionField('richContent'), updatedAt: new Date().toISOString() };
  }

  function createDraftTime(item) { return Date.parse(item && (item.updatedAt || item.savedAt) || '') || 0; }
  function staleBrowserOnlyDraft(record, serverDraft) {
    if (!record || !record.draft || serverDraft) return false;
    var saved = createDraftTime(record.draft);
    return Boolean(saved && Date.now() - saved >= 72 * 60 * 60 * 1000);
  }
  function legacyDraftMatchesCollection(draft, collected) {
    if (!draft || !collected) return false;
    var draftUrl = String(draft.srcUrl || '').trim(), collectedUrl = String(collected.sourceUrl || '').trim();
    if (draftUrl && collectedUrl) return draftUrl === collectedUrl;
    var draftImage = draft.variants && draft.variants[0] && String(draft.variants[0].image || '').trim();
    var collectedImage = String(collected.image || '').trim();
    return Boolean(draftImage && collectedImage && draftImage === collectedImage && String(draft.title || '').trim() === String(collected.title || '').trim());
  }
  function draftMatchesEntry(draft, collectionId, collected) {
    if (!draft || draft.mode !== 'create' || !/^draft_[\w-]+$/.test(String(draft.draftId || ''))) return false;
    if (!collectionId) return true;
    if (String(draft.collectionId || '') === collectionId) return true;
    return !draft.collectionId && legacyDraftMatchesCollection(draft, collected);
  }
  function captureDraft() {
    var fields = {};
    draftFields.forEach(function (id) { fields[id] = $(id).value; });
    collectVariants(); collectAttributes();
    document.querySelectorAll('#variantBody tr[data-index]').forEach(function (row) {
      row.querySelectorAll('[data-field]').forEach(function (input) { variants[Number(row.dataset.index)][input.dataset.field] = input.value; });
    });
    return JSON.parse(JSON.stringify({ version: 1, fields: fields, packageDimensionSources: Object.assign({}, packageDimensionSources), contentRiskChecks: contentReview ? contentReview.state() : undefined, attributes: attributes, variants: variants, dirtyFields: fullInfoDirty, sharedDirty: sharedDirty, hashtagsEdited: hashtagsEdited, variantStructureEdited: variantStructureEdited, moreAttributesOpen: moreAttributesOpen, promotionState: cloneVariantAttribute(promotionState), manualVariantAttributes: Array.from(manualVariantAttributeKeys), suppressedVariantAttributes: Array.from(suppressedVariantAttributeKeys), sourceBundles: combinationModel.normalizeBundles(sourceBundles), combinationRelations: combinationModel.normalizeRelations(combinationRelations), combinationHistory: combinationModel.normalizeHistory(combinationHistory), autoColorSample: $('autoColorSample').checked, categoryVersion: categoryVersion }));
  }
  function restoreDraft(draft) {
    draftRestored = true;
    packageDimensionSources = Object.assign({}, draft.packageDimensionSources || packageDimensionSources);
    packageDimensionValues = {length: String(draft.fields.length || ""), width: String(draft.fields.width || ""), height: String(draft.fields.height || "")};
    sellingPointsBilingual = draft.sellingPointsBilingual || sellingPointsBilingual;
      richContentBilingual = draft.richContentBilingual || richContentBilingual;
    workspaceDraftSafe = true;
    fullInfoDirty = Object.assign(Object.create(null), draft.dirtyFields);
    sharedDirty = Object.assign(Object.create(null), draft.sharedDirty);
    hashtagsEdited = Boolean(draft.hashtagsEdited); variantStructureEdited = Boolean(draft.variantStructureEdited);
    moreAttributesOpen = Boolean(draft.moreAttributesOpen); categoryVersion = draft.categoryVersion || '';
    promotionState = cloneVariantAttribute(draft.promotionState) || {schemaVersion: 1, attributes: {}};
    manualVariantAttributeKeys = new Set(arr(draft.manualVariantAttributes).map(String)); suppressedVariantAttributeKeys = new Set(arr(draft.suppressedVariantAttributes).map(String));
    sourceBundles = combinationModel.normalizeBundles(draft.sourceBundles); combinationRelations = combinationModel.normalizeRelations(draft.combinationRelations); combinationHistory = combinationModel.normalizeHistory(draft.combinationHistory); sourceImagePickerIndex = -1;
    optionControls.forEach(function (control) { control.destroy(); }); optionControls = [];
    attributes = JSON.parse(JSON.stringify(draft.attributes)); variants = JSON.parse(JSON.stringify(draft.variants)).map(normVariant); normalizeVariantAttributeModes();
    draftFields.forEach(function (id) { $(id).value = draft.fields[id]; });
    brandHasValue = true; $('autoColorSample').checked = Boolean(draft.autoColorSample);
    renderSourceBundles();
    optionCategory = val('descriptionCategoryId') + ':' + val('typeId');
    renderAttributes(); renderVariants();
    // Rendering normally hydrates absent platform fields. A draft's raw blanks and zeroes take precedence.
    draftFields.forEach(function (id) { $(id).value = draft.fields[id]; });
    document.querySelectorAll('#variantBody tr[data-index]').forEach(function (row) {
      row.querySelectorAll('[data-field]').forEach(function (input) { var value = draft.variants[Number(row.dataset.index)][input.dataset.field]; input.value = value == null ? '' : String(value); });
    });
    hashtagsControl.refresh(); refreshOptionControls(); updateMoreAttributes();
    if (translationControls && translationControls.restoreState) translationControls.restoreState(draft.browserTranslations);
    note('已恢复服务器草稿（' + new Date(draft.savedAt).toLocaleString() + '）；尚未提交 Ozon，确定编辑后才加入任务中心');
  }
  function clearValidationMarks() {
    $('productForm').querySelectorAll('[aria-invalid="true"]').forEach(function (node) { node.removeAttribute('aria-invalid'); });
    $('productForm').querySelectorAll('.validation-error').forEach(function (node) { node.classList.remove('validation-error'); });
  }
  function showValidationError(error) {
    clearValidationMarks(); note(error.message, true);
    var target = error.target || '', input = null, row = null;
    if (target.indexOf('variant:') === 0) {
      var parts = target.split(':'); row = $('variantBody').querySelector('tr[data-index="' + parts[1] + '"]');
      input = row && row.querySelector('[data-field="' + parts[2] + '"]');
      if (row) row.classList.add('validation-error');
    } else if (target.indexOf('attribute:') === 0) input = document.querySelector('[data-attribute-index="' + target.split(':')[1] + '"]');
    else input = $(target);
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      var focusTarget = input.type === 'hidden' ? row : input;
      if (focusTarget) { focusTarget.scrollIntoView({ block: 'center', behavior: 'smooth' }); if (typeof focusTarget.focus === 'function') focusTarget.focus(); }
    } else if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  function validate(d) {
    var error = window.WYERP_PRODUCT_CREATE_VALIDATOR.validate(d, { attributes: attributes, bindings: sharedBindings() });
    if (error) return error;
    var richColumn = variantAttributeColumns().find(function (column) { return column.binding && column.binding.key === 'richContent'; });
    if (richColumn) {
      for (var richIndex = 0; richIndex < d.variants.length; richIndex++) {
        var richValue = variantAttributeValue(d.variants[richIndex], richColumn.attribute, richColumn.binding, richIndex);
        if (richValue) { try { JSON.parse(richValue); } catch (_) { return {message: '第 ' + (richIndex + 1) + ' 行富内容格式不正确，请通过富内容编辑器调整', target: 'variant:' + richIndex + ':richContent'}; } }
      }
    }
    var invalidShipping = d.variants.findIndex(function (variant) { var value = String(variant.domesticShipping == null ? '' : variant.domesticShipping).trim(); return value !== '' && (!/^(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(value) || !Number.isFinite(Number(value))); });
    if (invalidShipping >= 0) return { message: '第 ' + (invalidShipping + 1) + ' 行国内快递费请填写 0 或正数金额，最多两位小数，也可留空', target: 'variant:' + invalidShipping + ':domesticShipping' };
    return null; }
  // 解析商品所属店铺：优先从授权店铺列表唯一匹配；匹配不到时回退使用商品自身店铺标识。
  // 回退不是放行——服务端 /product-edit 仍会对店铺范围做权限校验（普通用户越权返回 403，系统管理员不受店铺限制）。
  function resolveTargetShop() {
    var shop = productShops.resolve(shops, { clientId: product.clientId, externalShopId: product.externalShopId, shopId: product.shopId, shop: product.shop });
    if (shop && (shop.clientId || shop.externalShopId)) return shop;
    var explicit = String(product.clientId || product.externalShopId || product.shopId || '');
    if (explicit) return { clientId: explicit, externalShopId: '', shopId: '', name: product.shop || '', shopName: product.shop || '' };
    return null;
  }
  function editTarget() {
    var shop = resolveTargetShop();
    if (!shop || !(shop.clientId || shop.externalShopId)) throw new Error('无法确认商品所属店铺（授权列表无匹配且商品缺少店铺标识），请核对店铺配置');
    return { clientId: String(shop.clientId || shop.externalShopId), productId: pid(product) };
  }
  function acceptEdit(result) { product = result.item; editRevision = result.revision; return result; }
  function editRequest(action, body) {
    return requestJson('/api/domain/commands/product-edit', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': editKey || erpStorage.createIdempotencyKey() }, body: JSON.stringify(Object.assign({ action: action, target: editTarget(), revision: editRevision }, body || {})) }).then(acceptEdit);
  }
  function createRequest(draft) {
    return requestJson('/api/domain/commands/product-create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': createKey }, body: JSON.stringify({ action: 'enqueue', clientId: draft.shop, draftId: draft.draftId }) });
  }
  function platformChanges(d) {
    var firstVariant = d.variants[0] || {}, patch = {}, dimensionsPromoted = manualVariantAttributeKeys.has('field:dimensions');
    var fields = { title: ['name', manualVariantAttributeKeys.has('field:title') ? firstVariant.title : d.title], barcode: ['barcode', d.barcode], weight: ['weight', manualVariantAttributeKeys.has('field:weight') ? firstVariant.weightG : d.weightG], length: ['depth', dimensionsPromoted ? firstVariant.packageLength : d.dimensions.length], width: ['width', dimensionsPromoted ? firstVariant.packageWidth : d.dimensions.width], height: ['height', dimensionsPromoted ? firstVariant.packageHeight : d.dimensions.height] };
    Object.keys(fields).forEach(function (key) { if (fullInfoDirty['field:' + key]) patch[fields[key][0]] = fields[key][1]; });
    ['lowest', 'sale', 'old'].forEach(function (key) { if (fullInfoDirty['variant:0:' + key]) patch[key === 'lowest' ? 'min_price' : key === 'sale' ? 'price' : 'old_price'] = d.variants[0][key]; });
    var bindings = sharedBindings();
    var changed = attributes.filter(function (a, i) {
      var binding = bindings[i];
      if (binding && binding.key === 'barcode') return false;
      return fullInfoDirty['attribute:' + detailData.attributeKey(a)] || isBrandAttribute(a) && fullInfoDirty['field:brand'] || isHashtagsAttribute(a) && hashtagsEdited || binding && (sharedDirty[binding.area + ':' + binding.key] || binding.area === 'dimensions' && ['length','width','height'].some(function (key) { return fullInfoDirty['field:' + key]; }));
    });
    changed = changed.map(function (a) {
      var result = manualVariantAttributeKeys.has(variantAttributeKey(a)) ? variantAttributeStored(firstVariant, a) || Object.assign({}, a, {value:'',values:[]}) : cloneVariantAttribute(a);
      var binding = attributeFields.classify(a);
      if (binding && binding.area === 'field' && binding.key === 'title' && manualVariantAttributeKeys.has('field:title')) attributeFields.setText(result, firstVariant.title || '');
      if (binding && binding.area === 'field' && binding.key === 'weight' && manualVariantAttributeKeys.has('field:weight')) attributeFields.setText(result, firstVariant.weightG || '');
      if (binding && binding.area === 'field' && binding.key === 'length' && dimensionsPromoted) attributeFields.setText(result, firstVariant.packageLength || '');
      if (binding && binding.area === 'field' && binding.key === 'width' && dimensionsPromoted) attributeFields.setText(result, firstVariant.packageWidth || '');
      if (binding && binding.area === 'field' && binding.key === 'height' && dimensionsPromoted) attributeFields.setText(result, firstVariant.packageHeight || '');
      if (binding && binding.area === 'dimensions' && dimensionsPromoted) { var formatted = attributeFields.formatDimensions({length:firstVariant.packageLength,width:firstVariant.packageWidth,height:firstVariant.packageHeight}); if (formatted != null) attributeFields.setText(result, formatted); }
      return result;
    });
    if (manualVariantAttributeKeys.has('field:barcode') && (fullInfoDirty['field:barcode'] || fullInfoDirty['variant:0:barcode'])) patch.barcode = d.variants[0].barcode || '';
    var generatedPrivateMedia = changed.find(function (a) { var binding = attributeFields.classify(a); return binding && binding.area === 'media' && isPrivateGeneratedVideoUrl(attributeFields.text(a)); });
    if (generatedPrivateMedia) throw new Error('本地生成视频已安全保存到ERP，可先“保存草稿”；Ozon视频上传适配尚未完成真实验收，当前丏会把ERP私有地址提交平台。');
    if (changed.length) patch.attributes = changed.map(function (a) { return { id: a.id, complex_id: a.complexId || a.complex_id || a.attribute_complex_id || 0, values: arr(a.values).map(function (v) { return { value: v.value, dictionary_value_id: v.dictionary_value_id || 0 }; }) }; });
    // Do not silently drop edits when a category definition failed to load.
    [['brand','85'],['hashtags','23171'],['description','4191'],['richContent','11254']].forEach(function (entry) {
      if ((fullInfoDirty['field:' + entry[0]] || entry[0] === 'hashtags' && hashtagsEdited) && !changed.some(function (a) { return String(a.id) === entry[1] || entry[0] === 'brand' && isBrandAttribute(a); })) throw new Error('对应平台属性尚未加载，请先重试加载属性；可先保存草稿');
    });
    return patch;
  }
  function showEditStatus(prefix) {
    var state = product.ozonEdit;
    if (!state) { note(prefix || '成本和货源已保存到 ERP 数据库，未调用 Ozon'); return; }
    var pending = ['queued','preparing','submitting','pending','unknown'].indexOf(state.phase) >= 0;
    $('saveBtn').textContent = pending ? state.queueId ? '返回列表（任务处理中）' : '查询 Ozon 结果' : '确定编辑';
    note((prefix ? prefix + '；' : '') + (state.phase === 'confirmed' ? state.message : state.phase === 'failed' ? 'Ozon 更新失败：' + state.message : state.phase === 'pending' ? 'Ozon 正在处理，尚未确认更新成功' : state.message || 'Ozon 提交尚未确认，请勿重复提交'), ['failed','unknown','partial'].indexOf(state.phase) >= 0);
  }
  function closeEditor(queueTaskId) {
    if (workspaceEmbedded) window.parent.postMessage({ type: 'wyerp-workspace-product-close', queueTaskId: queueTaskId || '' }, location.origin);
    else location.href = '/pages/goods-online.html';
  }
  async function saveExisting(draftOnly, imageCommit) {
    if (editBusy || fullInfoLoading || !editRevision) return;
    if (productScope !== optionScope()) { note('账号或租户已切换，请重新打开商品', true); return; }
    var confirmedPayload = null;
    if (!draftOnly) { confirmedPayload = payload(); var validationError = validate(confirmedPayload); if (validationError) { showValidationError(validationError); return; } }
    editBusy = true; $('productForm').inert = true; $('saveBtn').disabled = true; $('saveDraftBtn').disabled = true;
    var saved = false;
    try {
      var state = product.ozonEdit;
      if (!draftOnly && state && ['queued','preparing','submitting','pending','unknown'].indexOf(state.phase) >= 0) {
        if (state.queueId) { closeEditor(state.queueId); return; }
        // Legacy edits without a queue receipt remain queryable; never resubmit.
        await editRequest('status'); showEditStatus('本次仅查询，不重复提交'); return;
      }
      if (draftOnly) {
        var editorDraft = captureDraft(), editorCacheId = editBrowserDraftId();
        var draftPayload = { draft: editorDraft };
        if (imageCommit && imageCommit.changed && imageCommit.variantRef) draftPayload.imageVariantRef = imageCommit.variantRef;
        var draftResults = await Promise.allSettled([editRequest('draft', draftPayload), browserDraftPut(editorCacheId, editorDraft)]);
        var serverDraftSaved = draftResults[0].status === 'fulfilled';
        var browserDraftSaved = draftResults[1].status === 'fulfilled' && draftResults[1].value === true;
        if (!serverDraftSaved) {
          var serverReason = draftResults[0].reason && draftResults[0].reason.message || '服务器保存失败';
          throw new Error((browserDraftSaved ? '浏览器草稿已保存，但' : '浏览器和服务器草稿均未保存；') + serverReason);
        }
        saved = true;
        note(browserDraftSaved ? '整页草稿已同时保存到浏览器和服务器，未调用 Ozon、未加入任务队列' : '服务器草稿已保存，但浏览器副本保存失败，请检查浏览器存储权限', !browserDraftSaved);
        workspaceDraftSafe = true;
        return;
      }
      var d = confirmedPayload;
      var local = { purchasePrice: d.variants[0] && d.variants[0].purchase, domesticShipping: d.domesticShipping, srcPrice: d.srcPrice, srcUrl: d.srcUrl, srcNote: d.srcNote, collectionId: d.collectionId || '', erpVariantRef: d.variants[0] && d.variants[0].erpVariantRef, sourceBundleIds: d.variants[0] && d.variants[0].sourceBundleIds || [], sourceBundles: d.sourceBundles, combinationRelations: d.combinationRelations, combinationHistory: d.combinationHistory, manualVariantAttributes: d.manualVariantAttributes, suppressedVariantAttributes: d.suppressedVariantAttributes };
      var patch = platformChanges(d);
      if (d.variants.length !== 1) throw new Error('当前仅支持编辑一个平台商品；不能将多行变体当作同一商品提交');
      if (d.richContent && fullInfoDirty['field:richContent']) { try { JSON.parse(d.richContent); } catch (_) { throw new Error('富内容格式不正确，尚未加入队列'); } }
      if (!editKey) editKey = erpStorage.createIdempotencyKey();
      note('正在保存并加入任务中心…');
      var enqueuePayload = { changes: patch, costs: local };
      if (imageCommit && imageCommit.changed && imageCommit.variantRef) enqueuePayload.imageVariantRef = imageCommit.variantRef;
      var result = await editRequest('enqueue', enqueuePayload);
      if (!result.queueTaskId) throw new Error('服务器未确认任务入队，请保留页面重试');
      saved = true;
      fullInfoDirty = Object.create(null); sharedDirty = Object.create(null); hashtagsEdited = false; editKey = '';
      browserDraftRemove(editBrowserDraftId()).then(function (removed) { if (!removed) console.warn('[product-draft] 已入队，但浏览器草稿副本未能清除'); });
      erpStorage.notifyServerChange(PRODUCT_KEY);
      closeEditor(result.queueTaskId);
    } catch (error) { note('保存或入队未完成，已保留当前内容：' + error.message, true); }
    finally { if (saved) erpStorage.notifyServerChange(PRODUCT_KEY); editBusy = false; $('productForm').inert = false; $('saveBtn').disabled = false; $('saveDraftBtn').disabled = false; }
  }

  function collectionPackageFacts(draft) {
    if (!draft || !draft.collectionId) return null;
    var dimensions = draft.dimensions && typeof draft.dimensions === 'object' ? draft.dimensions : {};
    return {
      collectionId: String(draft.collectionId || ''), sourceUrl: String(draft.srcUrl || ''),
      product: { weightG: draft.weightG, lengthMm: dimensions.length, widthMm: dimensions.width, heightMm: dimensions.height },
      variants: arr(draft.variants).map(function (variant) { return { sourceVariantId: String(variant && variant.sku || ''), sourceSpecText: String(variant && variant.sourceSpecText || ''), weightG: variant && variant.weightG, packageLength: variant && variant.packageLength, packageWidth: variant && variant.packageWidth, packageHeight: variant && variant.packageHeight }; })
    };
  }
  function backwriteCollectionPackageFacts(draft) {
    var facts = collectionPackageFacts(draft); if (!facts) return Promise.resolve(null);
    return requestJson('/api/domain/commands/collection-source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'package-facts', payload: facts }) }).then(function (result) { erpStorage.notifyServerChange(COLLECTION_KEY); return result; });
  }
  async function saveCreateDraft(requireComplete) {
    if (editBusy || fullInfoLoading) return;
    if (productScope !== optionScope()) { note('账号或租户已切换，请重新打开商品', true); $('saveBtn').disabled = true; return; }
    if (requireComplete && createState && ['queued','preparing','submitting','pending','unknown'].indexOf(createState.phase) >= 0) {
      if (createState.queueId) closeEditor(createState.queueId);
      else note('该新增任务正在处理中，请在任务中心查看，不能重复提交', true);
      return;
    }
    if (requireComplete && createState && createState.phase === 'confirmed') { note('该草稿已经新增成功，不能重复提交；请新建草稿', true); return; }
    var d = payload(), error = requireComplete ? validate(d) : null;
    if (error) { showValidationError(error); return; }
    clearValidationMarks(); editBusy = true; $('saveBtn').disabled = true; $('saveDraftBtn').disabled = true;
    note(requireComplete ? '正在保存草稿并加入新增任务队列…' : '正在保存草稿…');
    var serverSave = Promise.resolve(erpStorage.get(DRAFT_KEY, [])).then(function (drafts) {
      drafts = arr(drafts); var i = drafts.findIndex(function (item) { return item.draftId === d.draftId; });
      if (i >= 0) drafts[i] = d; else drafts.unshift(d);
      return erpStorage.set(DRAFT_KEY, recentServerDrafts(drafts));
    });
    try {
      var results = await Promise.allSettled([serverSave, browserDraftPut(d.draftId, d)]);
      var serverSaved = results[0].status === 'fulfilled';
      var browserSaved = results[1].status === 'fulfilled' && results[1].value === true;
      if (serverSaved || browserSaved) { rememberCreateDraftInUrl(); workspaceDraftSafe = true; }
      var collectionBackwrite = null;
      if (serverSaved && d.collectionId) {
        try { collectionBackwrite = await backwriteCollectionPackageFacts(d); }
        catch (backwriteError) {
          if (requireComplete) throw new Error('重量和尺寸尚未回写采集箱：' + backwriteError.message);
          note('草稿已保存，但重量和尺寸回写采集箱失败：' + backwriteError.message, true);
        }
      }
      if (!requireComplete) {
        if (serverSaved && browserSaved && (!d.collectionId || collectionBackwrite)) note(d.collectionId ? '草稿已保存，重量和尺寸已同步回采集箱' : '草稿已同时保存到浏览器和服务器；再次保存会更新同一草稿');
        else if (serverSaved && !d.collectionId) note('服务器草稿已保存，但浏览器副本保存失败，请检查浏览器存储权限', true);
        else if (serverSaved && d.collectionId && collectionBackwrite) note('服务器草稿和采集箱重量尺寸已保存，但浏览器副本保存失败，请检查浏览器存储权限', true);
        else if (browserSaved) note('浏览器草稿已保存，但服务器保存失败：' + (results[0].reason && results[0].reason.message || '请检查服务连接后重试'), true);
        else note('浏览器和服务器草稿均未保存：' + (results[0].reason && results[0].reason.message || '请检查浏览器存储权限和服务连接'), true);
        return;
      }
      if (!serverSaved) throw new Error('服务器尚未保存完整草稿，未加入新增任务：' + (results[0].reason && results[0].reason.message || '请检查服务连接后重试'));
      if (!createKey) createKey = erpStorage.createIdempotencyKey();
      var accepted = await createRequest(d);
      if (!accepted.queueTaskId) throw new Error('服务器未确认新增任务入队，请保留页面重试');
      createState = accepted.item && accepted.item.ozonCreate || null;
      createKey = '';
      if (!browserSaved) console.warn('[product-create] 已入队，但浏览器草稿副本未能保存');
      erpStorage.notifyServerChange(DRAFT_KEY);
      closeEditor(accepted.queueTaskId);
    } catch (saveError) {
      note('新增商品尚未入队，当前内容已保留：' + saveError.message, true);
    } finally { editBusy = false; $('saveBtn').disabled = false; $('saveDraftBtn').disabled = false; }
  }
  function aiProductFacts() {
    var draft = payload(), attributeFacts = {}, variantFacts = [];
    var sourceAttributes = arr(attributes).length ? arr(attributes) : arr(draft.attributes);
    sourceAttributes.forEach(function (attribute) {
      if (isBrandAttribute(attribute) || isPackageDimensionAttribute(attribute)) return;
      var text = attributeFields.text(attribute);
      if (!String(text || '').trim()) return;
      var label = String(attribute.name || attribute.nameRu || attribute.nameEn || ('属性' + attribute.id)).trim();
      attributeFacts[label] = String(text).trim();
    });
    arr(draft.variants).forEach(function (variant, index) {
      var row = {
        序号: index + 1, SKU名称: String(variant.name || '').trim(),
        采购价: String(variant.purchase || '').trim(), 国内快递费: String(variant.domesticShipping || '').trim(),
        最低价: String(variant.lowest || '').trim(), 销售价: String(variant.sale || '').trim(), 划线价: String(variant.old || '').trim(),
        每包数量: String(variant.packQuantity || '').trim(), 长度厘米: String(variant.itemLength || '').trim(),
        商品颜色: String(variant.color || '').trim(), 颜色名称: String(variant.colorName || '').trim()
      };
      Object.keys(row).forEach(function (key) { if (row[key] === '') delete row[key]; });
      variantFacts.push(row);
    });
    var titleAttribute = sourceAttributes.find(function (attribute) { return String(attribute && (attribute.id || attribute.attribute_id) || '') === '4180'; });
    var hashtagAttribute = sourceAttributes.find(function (attribute) { return String(attribute && (attribute.id || attribute.attribute_id) || '') === '23171'; });
    var descriptionAttribute = sourceAttributes.find(function (attribute) { return String(attribute && (attribute.id || attribute.attribute_id) || '') === '4191'; });
    var typeAttribute = sourceAttributes.find(isTypeAttribute);
    var brandAttribute = sourceAttributes.find(isBrandAttribute);
    var modelNameAttribute = sourceAttributes.find(isModelNameAttribute);
    function attributeText(attribute) { return attribute ? String(attributeFields.text(attribute) || '').trim() : ''; }
    function titleHint(attribute, fallbackLabel) {
      if (!attribute) return null;
      var value = isBrandAttribute(attribute) ? aiBrandValue() : attributeText(attribute);
      var description = String(attribute.description || attribute.descriptionRu || attribute.help || '').trim();
      if (!value && !description) return null;
      return { 字段: String(attribute.name || attribute.nameRu || fallbackLabel || '').trim(), 值: value, 说明: description };
    }
    var titleHints = [
      titleHint(titleAttribute, '商品标题'),
      titleHint(typeAttribute, '商品类型'),
      titleHint(brandAttribute, '品牌'),
      titleHint(modelNameAttribute, '型号名称')
    ].filter(Boolean);
    var facts = {
      产品类目: draft.category || categoryLabel(), 当前标题: draft.title,
      商品类型: attributeText(typeAttribute), 品牌: aiBrandValue(),
      适配来源: aiCompatibilityEvidence(),
      型号名称: attributeText(modelNameAttribute), 当前类目标题相关说明: titleHints,
      包装重量克: draft.weightG || '', 包装尺寸毫米: {length:val('length'),width:val('width'),height:val('height')}, packageDimensionSources: Object.assign({}, packageDimensionSources),
      当前主题标签: val('hashtags'), 当前类目主题标签说明: String(hashtagAttribute && hashtagAttribute.description || '').trim(), 当前简介: draft.description,
      当前类目简介说明: String(descriptionAttribute && (descriptionAttribute.description || descriptionAttribute.descriptionRu || descriptionAttribute.help) || '').trim(),
      类目属性: attributeFacts, 变体: variantFacts,
      货源价格: draft.srcPrice, 货源备注: draft.srcNote
    };
    return JSON.stringify(facts);
  }
  function aiFieldUserEdited(id) { return id === 'hashtags' ? hashtagsEdited || Boolean(fullInfoDirty['field:hashtags']) : Boolean(fullInfoDirty['field:' + id]); }
  function applyAiBilingualField(id, pair) {
    var input = $(id);
    if (aiFieldUserEdited(id)) return false;
    if (!input || !pair || typeof pair.ru !== 'string' || !pair.ru.trim() || typeof pair.zh !== 'string' || !pair.zh.trim()) return false;
    input.value = pair.ru.trim();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (translationControls && translationControls.rememberBilingual) translationControls.rememberBilingual(input, { ru: pair.ru.trim(), zh: pair.zh.trim() });
    return true;
  }
  var richContentEditorState = null;
  function richContentDefaultImages() {
    collectVariants();
    var first = variants[0] || {}, images = [];
    arr(first.images).forEach(function (image) {
      var url = typeof image === 'string' ? image : image && (image.file_name_url || image.url || image.src) || '';
      url = String(url || '').trim();
      if (url && images.indexOf(url) < 0) images.push(url);
    });
    return images.slice(2, 6);
  }
  function richContentBlankBlock(url) {
    return { src: url || '', srcMobile: url || '', imgLink: '', alt: '', position: 'width_full', positionMobile: 'width_full', dimensions: {} };
  }
  function applyRichContentAutoLayout(state) {
    if (!state) return 0;
    var active = [];
    state.blocks.forEach(function (block, index) {
      if (block.src || block.srcMobile) active.push(index);
      block.position = 'width_full'; block.positionMobile = 'width_full';
    });
    if (active.length === 2) {
      active.forEach(function (index) { state.blocks[index].position = state.blocks[index].positionMobile = 'width_half'; });
    } else if (active.length === 3) {
      state.blocks[active[0]].position = state.blocks[active[0]].positionMobile = 'width_full';
      active.slice(1).forEach(function (index) { state.blocks[index].position = state.blocks[index].positionMobile = 'width_half'; });
    } else if (active.length >= 4) {
      state.blocks[active[0]].position = state.blocks[active[0]].positionMobile = 'width_full';
      active.slice(1, 4).forEach(function (index) { state.blocks[index].position = state.blocks[index].positionMobile = 'width_one_third'; });
    }
    return active.length;
  }
  function richContentBlankState(useProductImages) {
    var defaults = useProductImages ? richContentDefaultImages() : [], blocks = [];
    for (var i = 0; i < 4; i += 1) blocks.push(richContentBlankBlock(defaults[i] || ''));
    var state = {
      device: 'pc', selected: 0, type: 'billboard', blocks: blocks,
      title: { content: '', size: 'size4', align: 'center', color: 'color1' },
      text: { content: '', size: 'size2', align: 'center', color: 'color1' },
      baseDocument: null, contentIndex: -1, sourceInvalid: false
    };
    if (useProductImages) applyRichContentAutoLayout(state);
    return state;
  }
  function richContentCopyDocument(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }
  function richContentTextContent(section) {
    return String(section && section.items && section.items[0] && section.items[0].content || '');
  }
  function richContentAllowed(value, allowed, fallback) { return allowed.indexOf(String(value || '')) >= 0 ? String(value) : fallback; }
  function readRichContentEditorValue(raw) {
    raw = String(raw || '').trim();
    if (!raw) return { document: null, state: null, invalid: false };
    try {
      var documentValue = JSON.parse(raw);
      if (!documentValue || !Array.isArray(documentValue.content)) return { document: documentValue, state: null, invalid: false };
      var index = documentValue.content.findIndex(function (item) { return item && item.widgetName === 'raShowcase' && Array.isArray(item.blocks); });
      if (index < 0) return { document: documentValue, state: null, invalid: false };
      var showcase = documentValue.content[index], state = richContentBlankState(false);
      state.type = richContentAllowed(showcase.type, ['billboard','roll','tileL','tileXL'], 'billboard');
      arr(showcase.blocks).slice(0, 4).forEach(function (source, blockIndex) {
        var img = source && source.img || {}, dimensions = {};
        ['width','height','widthMobile','heightMobile'].forEach(function (key) { if (img[key] != null) dimensions[key] = img[key]; });
        state.blocks[blockIndex] = {
          src: String(img.src || ''), srcMobile: String(img.srcMobile || ''),
          imgLink: String(source && source.imgLink || ''), alt: String(img.alt || ''),
          position: richContentAllowed(img.position, ['fill','to_the_edge','width_full','width_half','width_one_fourth','width_one_third'], 'width_full'),
          positionMobile: richContentAllowed(img.positionMobile, ['fill','to_the_edge','width_full','width_half','width_one_fourth','width_one_third'], 'width_full'),
          dimensions: dimensions
        };
        if (!state.title.content && source && source.title) {
          state.title = {
            content: richContentTextContent(source.title),
            size: richContentAllowed(source.title.size, ['size1','size2','size3','size4','size5','size6','size7'], 'size4'),
            align: richContentAllowed(source.title.align, ['left','center','right'], 'center'),
            color: richContentAllowed(source.title.color, ['color1','color2','color3','color4'], 'color1')
          };
        }
        if (!state.text.content && source && source.text) {
          state.text = {
            content: richContentTextContent(source.text),
            size: richContentAllowed(source.text.size, ['size1','size2','size3','size4','size5','size6','size7'], 'size2'),
            align: richContentAllowed(source.text.align, ['left','center','right'], 'center'),
            color: richContentAllowed(source.text.color, ['color1','color2','color3','color4'], 'color1')
          };
        }
      });
      state.baseDocument = richContentCopyDocument(documentValue); state.contentIndex = index;
      return { document: documentValue, state: state, invalid: false };
    } catch (_) { return { document: null, state: null, invalid: true }; }
  }
  function richContentPositionWidth(position) {
    if (position === 'width_half') return '50%';
    if (position === 'width_one_third') return '33.3333%';
    if (position === 'width_one_fourth') return '25%';
    return '100%';
  }
  function richContentPreviewSize(size) {
    return ({size1:'12px',size2:'14px',size3:'16px',size4:'18px',size5:'20px',size6:'24px',size7:'28px'})[size] || '16px';
  }
  function richContentPreviewColor(color) {
    return ({color1:'#001a34',color2:'#3d5265',color3:'#8b9bab',color4:'#ffffff'})[color] || '#001a34';
  }
  function normalizeRichContentSharedMedia(state) {
    if (!state) return state;
    state.blocks.forEach(function (block) {
      var url = String(block.src || block.srcMobile || ''), position = String(block.position || block.positionMobile || 'width_full');
      block.src = url; block.srcMobile = url; block.position = position; block.positionMobile = position;
    });
    return state;
  }
  function richContentSelectedBlock() { return richContentEditorState && richContentEditorState.blocks[richContentEditorState.selected]; }
  function syncRichContentEditorFields() {
    if (!richContentEditorState) return;
    var state = richContentEditorState, block = richContentSelectedBlock(), mobile = state.device === 'mobile';
    document.querySelectorAll('[data-rich-device]').forEach(function (button) {
      var active = button.dataset.richDevice === state.device;
      button.classList.toggle('on', active); button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('richContentPreviewLabel').textContent = mobile ? '移动端预览' : '电脑端预览';
    $('richContentImageUrlLabel').textContent = '图片地址';
    $('richContentImagePositionLabel').textContent = '图片宽度';
    $('richContentSelectedImageNo').textContent = String(state.selected + 1);
    $('richContentEditorImageUrl').value = block.src || block.srcMobile || '';
    $('richContentEditorImageLink').value = block.imgLink;
    $('richContentEditorImageAlt').value = block.alt;
    $('richContentEditorImagePosition').value = block.position || block.positionMobile || 'width_full';
    $('richContentEditorType').value = state.type;
    $('richContentEditorTextTitle').value = state.title.content;
    $('richContentEditorTitleSize').value = state.title.size;
    $('richContentEditorTitleColor').value = state.title.color;
    $('richContentEditorTitleAlign').value = state.title.align;
    $('richContentEditorTextDescription').value = state.text.content;
    $('richContentEditorTextSize').value = state.text.size;
    $('richContentEditorTextColor').value = state.text.color;
    $('richContentEditorTextAlign').value = state.text.align;
    $('richContentMoveUpBtn').disabled = state.selected <= 0;
    $('richContentMoveDownBtn').disabled = state.selected >= state.blocks.length - 1;
  }
  function renderRichContentEditorPreview() {
    if (!richContentEditorState) return;
    var state = richContentEditorState, mobile = state.device === 'mobile';
    $('richContentEditorPreviewStage').classList.toggle('is-mobile', mobile);
    var title = $('richContentPreviewTitle'), text = $('richContentPreviewText');
    title.textContent = state.title.content; title.style.fontSize = richContentPreviewSize(state.title.size); title.style.color = richContentPreviewColor(state.title.color); title.style.textAlign = state.title.align;
    text.textContent = state.text.content; text.style.fontSize = richContentPreviewSize(state.text.size); text.style.color = richContentPreviewColor(state.text.color); text.style.textAlign = state.text.align;
    var mainHost = $('richContentPreviewMainImage'), secondaryHost = $('richContentPreviewSecondaryImages');
    mainHost.replaceChildren(); secondaryHost.replaceChildren();
    state.blocks.forEach(function (block, index) {
      var card = document.createElement('button'), url = block.src || block.srcMobile || '', position = block.position || block.positionMobile || 'width_full';
      card.type = 'button'; card.className = 'rich-content-preview-card' + (index === state.selected ? ' is-selected' : ''); card.style.width = richContentPositionWidth(position);
      card.setAttribute('aria-label', '编辑富内容图片' + (index + 1));
      var number = document.createElement('b'); number.textContent = String(index + 1); card.appendChild(number);
      if (url) {
        var image = document.createElement('img'); image.src = url; image.alt = block.alt || ('富内容图片' + (index + 1));
        image.addEventListener('error', function () { image.replaceWith(Object.assign(document.createElement('span'), { className: 'empty', textContent: '图片暂时无法预览' })); });
        card.appendChild(image);
      } else {
        var empty = document.createElement('span'); empty.className = 'empty'; empty.textContent = '暂无图片'; card.appendChild(empty);
      }
      card.addEventListener('click', function () { state.selected = index; syncRichContentEditorFields(); renderRichContentEditorPreview(); });
      (index === 0 ? mainHost : secondaryHost).appendChild(card);
    });
  }
  function renderRichContentEditor() { syncRichContentEditorFields(); renderRichContentEditorPreview(); }
  function syncGeneratedRichContentIntoEditor() {
    if (!richContentEditorState) return;
    var changed = false;
    var generatedTitle = String(richContentBilingual && richContentBilingual.richTitle && richContentBilingual.richTitle.ru || '').trim();
    var generatedDescription = String(richContentBilingual && richContentBilingual.richDescription && richContentBilingual.richDescription.ru || '').trim();
    if (!richContentEditorState.title.content && generatedTitle) { richContentEditorState.title.content = generatedTitle; changed = true; }
    if (!richContentEditorState.text.content && generatedDescription) { richContentEditorState.text.content = generatedDescription; changed = true; }
    if (changed) renderRichContentEditor();
  }
  function richContentEditorShowcase(state) {
    var chosen = state.blocks.filter(function (block) { return block.src || block.srcMobile || block.imgLink || block.alt; });
    if (!chosen.length) chosen = [state.blocks[0]];
    var blocks = chosen.map(function (block, index) {
      var img = { src: block.src, srcMobile: block.srcMobile, alt: block.alt, position: block.position, positionMobile: block.positionMobile };
      Object.keys(block.dimensions || {}).forEach(function (key) { img[key] = block.dimensions[key]; });
      var output = { imgLink: block.imgLink, img: img };
      if (index === 0 && state.title.content) output.title = { items: [{type:'text',content:state.title.content}], size: state.title.size, align: state.title.align, color: state.title.color };
      if (index === 0 && state.text.content) output.text = { size: state.text.size, align: state.text.align, color: state.text.color, items: [{type:'text',content:state.text.content}] };
      return output;
    });
    return { widgetName: 'raShowcase', type: state.type, blocks: blocks };
  }
  function richContentDraftPayload(state) {
    var documentValue = state.baseDocument && Array.isArray(state.baseDocument.content) ? richContentCopyDocument(state.baseDocument) : {content:[],version:0.3};
    if (!Array.isArray(documentValue.content)) documentValue.content = [];
    var showcase = richContentEditorShowcase(state);
    if (state.contentIndex >= 0 && state.contentIndex < documentValue.content.length) documentValue.content[state.contentIndex] = showcase;
    else documentValue.content.push(showcase);
    if (documentValue.version == null) documentValue.version = 0.3;
    return documentValue;
  }
  function openRichContentEditor(target) {
    richContentEditorTarget = target && target.tagName === 'TEXTAREA' ? target : $('richContent');
    var dialog = $('richContentEditorDialog'), parsed = readRichContentEditorValue(richContentEditorTarget.value), state = parsed.state || richContentBlankState(true);
    if (!parsed.state) { state.baseDocument = parsed.document && Array.isArray(parsed.document.content) ? richContentCopyDocument(parsed.document) : null; state.contentIndex = -1; state.sourceInvalid = parsed.invalid; }
    normalizeRichContentSharedMedia(state);
    if (!state.title.content) state.title.content = String(richContentBilingual && richContentBilingual.richTitle && richContentBilingual.richTitle.ru || '').trim();
    if (!state.text.content) state.text.content = String(richContentBilingual && richContentBilingual.richDescription && richContentBilingual.richDescription.ru || '').trim();
    richContentEditorState = state;
    var status = $('richContentEditorNote'); status.className = 'rich-content-editor-note';
    if (parsed.state) status.textContent = '已读取当前富内容，可编辑4张图片、两种设备预览和文字样式；只有点击“应用到富内容”才更新原字段。';
    else if (parsed.invalid) { status.textContent = '当前富内容格式无法解析，打开编辑器不会修改原内容；点击“应用到富内容”后才会用当前编辑结果替换。'; status.classList.add('is-warn'); }
    else if (parsed.document) status.textContent = '当前富内容中没有可编辑的图文展示模块；其它模块会保留，点击“应用到富内容”后新增本组图文内容。';
    else status.textContent = '已默认带入第3-6张商品图和现有俄文图文文案；所有内容都可以继续调整。';
    renderRichContentEditor();
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function applyRichContentEditor() {
    if (!richContentEditorState) return;
    normalizeRichContentSharedMedia(richContentEditorState);
    var target = richContentEditorTarget || $('richContent'), documentValue = richContentDraftPayload(richContentEditorState), warnings = [];
    var activeBlocks = richContentEditorState.blocks.filter(function (block) { return block.src || block.srcMobile || block.imgLink || block.alt; });
    if (!activeBlocks.length) warnings.push('4张图片都为空');
    activeBlocks.forEach(function (block, index) {
      if (!block.src) warnings.push('图片' + (index + 1) + '为空');
      else if (!/^https:\/\//i.test(block.src)) warnings.push('图片' + (index + 1) + '不是安全网络地址');
    });
    if (!richContentEditorState.title.content) warnings.push('图文标题为空');
    if (!richContentEditorState.text.content) warnings.push('图文描述为空');
    target.value = JSON.stringify(documentValue);
    target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
    $('richContentEditorDialog').close(); target.focus();
    note('富内容已应用到当前字段' + (warnings.length ? '；' + warnings.join('、') + '，请人工核对后保存。' : '；请核对后保存。'), warnings.length > 0);
  }
  function updateRichContentSelectedImage(field, value) {
    var block = richContentSelectedBlock(); if (!block) return;
    if (field === 'url') { block.src = value; block.srcMobile = value; }
    else if (field === 'position') { block.position = value; block.positionMobile = value; }
    else block[field] = value;
    renderRichContentEditorPreview();
  }
  function useDefaultRichContentImages() {
    if (!richContentEditorState) return;
    var images = richContentDefaultImages();
    for (var i = 0; i < 4; i += 1) {
      richContentEditorState.blocks[i].src = images[i] || '';
      richContentEditorState.blocks[i].srcMobile = images[i] || '';
    }
    autoLayoutRichContentImages(richContentEditorState, false);
    renderRichContentEditor();
  }
  function autoLayoutRichContentImages(state, shouldRender) {
    state = state || richContentEditorState;
    if (!state) return;
    var activeCount = applyRichContentAutoLayout(state);
    if (shouldRender !== false) {
      if (!activeCount) $('richContentEditorNote').textContent = '当前没有图片可自动排版。';
      renderRichContentEditor();
    }
  }
  function moveRichContentImage(offset) {
    if (!richContentEditorState) return;
    var from = richContentEditorState.selected, to = from + offset;
    if (to < 0 || to >= richContentEditorState.blocks.length) return;
    var current = richContentEditorState.blocks[from]; richContentEditorState.blocks[from] = richContentEditorState.blocks[to]; richContentEditorState.blocks[to] = current; richContentEditorState.selected = to;
    renderRichContentEditor();
  }
  function currentReviewFacts(field, source) {
    var facts = JSON.parse(aiProductFacts()), original = {};
    try { original = JSON.parse(source && source.facts || '{}'); } catch (error) {}
    facts.当前标题 = originalContentSource && originalContentSource.title || original.当前标题 || '';
    facts.当前简介 = original.当前简介 || ''; facts.当前主题标签 = original.当前主题标签 || '';
    facts.当前类目标题相关说明 = original.当前类目标题相关说明 || [];
    attributes.forEach(function (attribute) { if (['4180','4191','23171','11254'].indexOf(String(attribute.id || attribute.attribute_id)) >= 0) delete facts.类目属性[String(attribute.name || attribute.nameRu || attribute.nameEn || ('属性' + attribute.id)).trim()]; });
    return JSON.stringify(facts);
  }
  contentReview = window.WYERP_PRODUCT_CONTENT_REVIEW.create({request:requestJson, onChange:markWorkspaceDirty, clientId:function () { return val('shop'); }, context:function () { return optionScope() + ':' + val('shop') + ':' + val('descriptionCategoryId') + ':' + val('typeId'); }, facts:currentReviewFacts, pair:function (field) {
    if (field === 'title' || field === 'summary') return translationControls.currentPair(field === 'title' ? 'title' : 'description') || {ru:val(field === 'title' ? 'title' : 'description')};
    if (field === 'sellingPoints') return sellingPointsBilingual ? {zh:sellingPointsBilingual.zh,ru:sellingPointsBilingual.ru} : null;
    return richContentBilingual && richContentBilingual[field] || null;
  }});
  contentReview.attach('title', $('title').closest('.field')); contentReview.attach('summary', $('description').closest('.field'));
  $('productForm').addEventListener('input', function () { if (contentReview) contentReview.changed(); });
  $('productForm').addEventListener('change', function () { if (contentReview) contentReview.changed(); });
  function restoreContentReviews(draft, browserDraft) { var local = browserDraft || draft || {}; if (contentReview) contentReview.restore(draft && draft.contentRiskChecks || local.contentRiskChecks, local.browserContentReview); }
  function generateAiText() {
    var button = $('aiTextBtn');
    if (!button || button.disabled) return;
    var capturedOriginal = false;
    if (!originalContentSource && allowManualOriginalTitle) { originalContentSource = { title: val('title'), attributes: aiSourceAttributes(attributes) }; capturedOriginal = true; }
    var facts = aiProductFacts();
    if (!facts || facts === '{}') { note('请先完善商品资料后再生成文案', true); return; }
    if (facts.length > 8000) { note('商品资料超过8000字符，无法完整提交，请精简后重新生成；当前内容已保留。', true); return; }
    var oldText = button.textContent;
    var context = contentContext(), shop = val('shop'), latestDiagnosticId = '', sellingSnapshot = JSON.stringify(sellingPointsBilingual), richSnapshot = JSON.stringify(richContentBilingual);
    button.disabled = true; button.textContent = 'AI 正在整理双语文案…';
    note('正在汇总当前页面商品信息，并按系统管理员AI规则生成中俄双语…');
    return Promise.resolve(capturedOriginal ? browserDraftPut(createDraftId, payload()) : null).then(function () { return requestJson('/api/domain/commands/product-content-candidates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ facts: facts, items: ['title', 'tags', 'summary', 'sellingPoints', 'richTitle', 'richDescription'], bilingual: true })
    }); }).then(function (result) {
      latestDiagnosticId = result.diagnosticId;
      if (contentContext() !== context || val('shop') !== shop || aiProductFacts() !== facts || JSON.stringify(sellingPointsBilingual) !== sellingSnapshot || JSON.stringify(richContentBilingual) !== richSnapshot) { note('商品字段或类目已变化，已保留当前内容，请重新生成。', true); if (window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS) window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS.attach($('saveState'), latestDiagnosticId, requestJson); return; }
      var pairs = result.translations || {}, applied = 0, reviewedFields = [], preservedAiFields = ['title','hashtags','description'].filter(aiFieldUserEdited), sellingPreserved = Boolean(sellingPointsBilingual && (sellingPointsBilingual.zh || sellingPointsBilingual.ru));
      if (applyAiBilingualField('title', pairs.title)) { applied += 1; reviewedFields.push('title'); }
      if (applyAiBilingualField('hashtags', pairs.tags)) { hashtagsEdited = true; syncHashtags(); hashtagsControl.refresh(); applied += 1; }
      if (applyAiBilingualField('description', pairs.summary)) { applied += 1; reviewedFields.push('summary'); }
      if ((!sellingPointsBilingual || (!sellingPointsBilingual.zh && !sellingPointsBilingual.ru)) && pairs.sellingPoints && typeof pairs.sellingPoints.zh === 'string' && pairs.sellingPoints.zh.trim() && typeof pairs.sellingPoints.ru === 'string' && pairs.sellingPoints.ru.trim()) {
        sellingPointsBilingual = { zh: pairs.sellingPoints.zh.trim(), ru: pairs.sellingPoints.ru.trim(), shop: shop, productId: createMode ? createDraftId : pid(product), variantRefs: variants.map(function (variant) { return String(variant.offerId || variant.article || variant.sku || ''); }).filter(Boolean) };
        applied += 1; reviewedFields.push('sellingPoints');
      }
      var richPreserved = false;
      ['richTitle','richDescription'].forEach(function (key) {
        var pair = pairs[key], previous = richContentBilingual && richContentBilingual[key];
        if (previous && (previous.zh || previous.ru)) { richPreserved = true; return; }
        if (pair && typeof pair.zh === 'string' && pair.zh.trim() && typeof pair.ru === 'string' && pair.ru.trim()) { richContentBilingual = richContentBilingual || {}; richContentBilingual[key] = {zh: pair.zh.trim(), ru: pair.ru.trim()}; richDraftEdited = true; applied++; reviewedFields.push(key); }
      });
      syncGeneratedRichContentIntoEditor();
      reviewedFields.forEach(function (field) { if (contentReview) contentReview.adopt(field, result); });
      var failures = result.failures && Object.keys(result.failures) || [];
      failures.forEach(function (field) { if (contentReview) contentReview.failure(field, result.failures[field].message); });
      var failureMessages = failures.map(function (key) { return result.failures[key].message; }).filter(Boolean);
      [['title','标题'],['tags','主题标签'],['summary','简介'],['sellingPoints','卖点'],['richTitle','图文标题'],['richDescription','图文描述']].forEach(function (entry) {
        var pair = pairs[entry[0]];
        if ((!pair || typeof pair.zh !== 'string' || !pair.zh.trim() || typeof pair.ru !== 'string' || !pair.ru.trim()) && failures.indexOf(entry[0]) < 0) failureMessages.push(entry[1] + '未返回完整中俄双语，已保留原内容。');
      });
      var failureText = failureMessages.join('；');
      if (!applied && (preservedAiFields.length || sellingPreserved || richPreserved)) { note('已有人工填写内容已保留，没有覆盖' + (failureText ? '；' + failureText : '')); return; }
      if (!applied) throw new Error(failureText || 'AI没有返回可回写的双语内容');
      markWorkspaceDirty();
      note('AI双语文案已生成：俄语已填入正式字段，中文保存在对应“翻译”按钮中；双语卖点供重绘窗口选用' + (richPreserved ? '；已有图文草稿已保留' : '') + (failureText ? '；' + failureText : ''), Boolean(failureText));
      if (window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS) window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS.attach($('saveState'), result.diagnosticId, requestJson);
    }).catch(function (error) {
      note('AI双语文案生成失败：' + (error.message || '请检查AI配置后重试'), true);
      if (window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS) window.WYERP_PRODUCT_CONTENT_DIAGNOSTICS.attach($('saveState'), error.diagnosticId || latestDiagnosticId, requestJson);
    }).finally(function () { button.disabled = false; button.textContent = oldText; });
  }
  var oneClickAutofillBusy = false;
  function runOneClickAutofill() {
    if (oneClickAutofillBusy) return;
    oneClickAutofillBusy = true;
    var localFilled = generateMissingModelNames() + generateMissingOfferIds();
    Promise.resolve(runAutoVariantRecognition()).catch(function () { return false; }).then(function () {
      return calculateAllVariantPrices({ fillOnlyMissing: true }).catch(function () { return false; });
    }).then(function () {
      return Promise.resolve(generateAiText());
    }).finally(function () {
      oneClickAutofillBusy = false;
      if (localFilled) markWorkspaceDirty();
    });
  }
  function showCreateStatus(prefix) {
    if (!createState) { if (prefix) note(prefix); return; }
    var pending = ['queued','preparing','submitting','pending','unknown'].indexOf(createState.phase) >= 0;
    $('saveBtn').textContent = pending ? '返回列表（新增处理中）' : createState.phase === 'confirmed' ? '该草稿已新增' : '重新提交新增商品';
    var message = createState.phase === 'confirmed' ? createState.message : createState.phase === 'failed' ? 'Ozon 新增失败：' + createState.message : createState.message || '新增任务尚未确认，请勿重复提交';
    note((prefix ? prefix + '；' : '') + message, ['failed','unknown'].indexOf(createState.phase) >= 0);
  }
  // 商品保存前先提交图片编辑器的本地变更（删除/排序/封面/处理结果），失败则中止商品保存，避免商品与图片不一致
  function commitSkuImages(requireComplete) {
    if (editBusy || fullInfoLoading || productScope !== optionScope()) return Promise.resolve(null);
    if (requireComplete) {
      var validationError = validate(payload());
      if (validationError) { showValidationError(validationError); return Promise.resolve(null); }
    }
    var reason = requireComplete ? 'confirm' : 'draft';
    return (window.wyerpSkuImage && window.wyerpSkuImage.flush ? window.wyerpSkuImage.flush(reason) : Promise.resolve({ ok: true, changed: false })).then(function (result) {
      if (result && result.ok === false) { note('图片变更未提交，商品未保存：' + (result.message || '未知原因'), true); return null; }
      return result || { ok: true, changed: false };
    });
  }
  function save() {
    if (createMode || !product) { saveCreateDraft(true); return; }
    commitSkuImages(true).then(function (imageCommit) {
      if (!imageCommit) return;
      saveExisting(false, imageCommit);
    });
  }
  function bindRichContentEditorControls() {
    $('buildRichContentBtn').onclick = openRichContentEditor;
    $('richContentEditorClose').onclick = function () { $('richContentEditorDialog').close(); };
    $('richContentEditorCancel').onclick = function () { $('richContentEditorDialog').close(); };
    $('richContentEditorApply').onclick = applyRichContentEditor;
    document.querySelectorAll('[data-rich-device]').forEach(function (button) {
      button.onclick = function () {
        if (!richContentEditorState) return;
        richContentEditorState.device = button.dataset.richDevice === 'mobile' ? 'mobile' : 'pc';
        renderRichContentEditor();
      };
    });
    $('richContentUseProductImages').onclick = useDefaultRichContentImages;
    $('richContentAutoLayout').onclick = function () { autoLayoutRichContentImages(); };
    $('richContentMoveUpBtn').onclick = function () { moveRichContentImage(-1); };
    $('richContentMoveDownBtn').onclick = function () { moveRichContentImage(1); };
    $('richContentClearImageBtn').onclick = function () {
      var block = richContentSelectedBlock(); if (!block) return;
      block.src = ''; block.srcMobile = '';
      renderRichContentEditor();
    };
    $('richContentEditorImageUrl').addEventListener('input', function () { updateRichContentSelectedImage('url', this.value); });
    $('richContentEditorImageLink').addEventListener('input', function () { updateRichContentSelectedImage('imgLink', this.value); });
    $('richContentEditorImageAlt').addEventListener('input', function () { updateRichContentSelectedImage('alt', this.value); });
    $('richContentEditorImagePosition').addEventListener('change', function () { updateRichContentSelectedImage('position', this.value); });
    $('richContentEditorType').addEventListener('change', function () { if (!richContentEditorState) return; richContentEditorState.type = this.value; renderRichContentEditorPreview(); });
    $('richContentEditorTextTitle').addEventListener('input', function () { if (!richContentEditorState) return; richContentEditorState.title.content = this.value; renderRichContentEditorPreview(); });
    $('richContentEditorTitleSize').addEventListener('change', function () { if (!richContentEditorState) return; richContentEditorState.title.size = this.value; renderRichContentEditorPreview(); });
    $('richContentEditorTitleColor').addEventListener('change', function () { if (!richContentEditorState) return; richContentEditorState.title.color = this.value; renderRichContentEditorPreview(); });
    $('richContentEditorTitleAlign').addEventListener('change', function () { if (!richContentEditorState) return; richContentEditorState.title.align = this.value; renderRichContentEditorPreview(); });
    $('richContentEditorTextDescription').addEventListener('input', function () { if (!richContentEditorState) return; richContentEditorState.text.content = this.value; renderRichContentEditorPreview(); });
    $('richContentEditorTextSize').addEventListener('change', function () { if (!richContentEditorState) return; richContentEditorState.text.size = this.value; renderRichContentEditorPreview(); });
    $('richContentEditorTextColor').addEventListener('change', function () { if (!richContentEditorState) return; richContentEditorState.text.color = this.value; renderRichContentEditorPreview(); });
    $('richContentEditorTextAlign').addEventListener('change', function () { if (!richContentEditorState) return; richContentEditorState.text.align = this.value; renderRichContentEditorPreview(); });
  }
  function bind() {
    hashtagsControl = window.WYERP_PRODUCT_HASHTAGS.mount($('hashtags'));
    $('loadProductInfoBtn').onclick = loadProductMatch;
    $('variantBody').addEventListener('error', function (event) { if (event.target.tagName === 'IMG') { event.target.hidden = true; event.target.alt = '图片暂不可用'; } }, true);
    $('category').oninput = categoryChanged; $('category').onchange = categoryChanged;
    shopSelect = window.WYERP_SEARCHABLE_SELECT.mountSelect($('shop'), '上架店铺');
    categorySelect = window.WYERP_SEARCHABLE_SELECT.mountSelect($('category'), '产品类目');
    $('retryCategoryBtn').onclick = function () { loadCatalog(true).then(function () { loadCurrentCategoryAttributes(true); }); };
    $('loadAttributesBtn').onclick = function () { moreAttributesOpen = !moreAttributesOpen; updateMoreAttributes(); };
    $('retryAttributesBtn').onclick = function () { loadCurrentCategoryAttributes(true); };
    $('combinationPickerClose').onclick = function () { $('combinationPickerDialog').close(); };
    $('combinationPickerCancel').onclick = function () { $('combinationPickerDialog').close(); };
    $('combinationReferenceClose').onclick = function () { combinationReferenceBundleId = ''; combinationReferenceMode = 'bundle'; combinationReferenceVariantSkuId = ''; combinationReferenceVariantRowKey = ''; $('combinationReferenceDialog').close(); };
    $('combinationReferenceCancel').onclick = function () { combinationReferenceBundleId = ''; combinationReferenceMode = 'bundle'; combinationReferenceVariantSkuId = ''; combinationReferenceVariantRowKey = ''; $('combinationReferenceDialog').close(); };
    $('combinationReferenceUploadBtn').onclick = function () { $('combinationReferenceUploadInput').click(); };
    $('combinationReferenceUploadInput').addEventListener('change', function () { var file = this.files && this.files[0]; this.value = ''; if (file) uploadCombinationReferenceImage(file); });
    $('combinationReferenceList').addEventListener('click', function (event) { var choice = event.target.closest('[data-combination-reference-choice]'); if (choice) chooseCombinationReference(choice.dataset.combinationReferenceChoice); });
    $('combinationReferenceList').addEventListener('keydown', function (event) { if (event.key !== 'Enter' && event.key !== ' ') return; var choice = event.target.closest('[data-combination-reference-choice]'); if (choice) { event.preventDefault(); chooseCombinationReference(choice.dataset.combinationReferenceChoice); } });
    $('combinationVariantClose').onclick = function () { combinationVariantBundleId = ''; $('combinationVariantDialog').close(); };
    $('combinationVariantCancel').onclick = function () { combinationVariantBundleId = ''; $('combinationVariantDialog').close(); };
    $('combinationVariantConfirm').onclick = applyCombinationVariantPicker;
    $('combinationVariantList').addEventListener('change', function (event) { var box = event.target.closest('[data-combination-variant-choice]'); if (box) box.closest('.combination-variant-row').classList.toggle('on', box.checked); });
    $('combinationVariantList').addEventListener('input', function (event) { var field = event.target.closest('[data-combination-spec-field]'); if (!field) return; var row = field.closest('[data-combination-spec-row]'); if (field.dataset.combinationSpecField === 'domesticShipping') field.dataset.domesticManual = '1'; refreshCombinationVariantRowSubtotal(row); });
    $('combinationVariantList').addEventListener('click', function (event) { var imageButton = event.target.closest('[data-combination-variant-image]'); if (imageButton) { event.preventDefault(); openCombinationVariantImagePicker(imageButton.dataset.combinationBundleId, imageButton.dataset.combinationRowKey, imageButton.dataset.combinationRowIndex, imageButton.dataset.combinationSkuId); } });
    $('combinationPickerConfirm').onclick = applyCombinationPicker;
    $('combinationPickerSearch').addEventListener('input', function () { combinationPickerState.query = this.value; renderCombinationPicker(); });
    $('combinationPickerList').addEventListener('change', function (event) {
      var box = event.target.closest('[data-combination-check]'); if (!box || box.disabled) return;
      var id = String(box.dataset.combinationCheck || ''); if (!id) return;
      if (box.checked) combinationPickerState.selected.add(id); else combinationPickerState.selected.delete(id);
      renderCombinationPicker();
    });
    $('variantBody').addEventListener('click', function (event) {
      var open = event.target.closest('[data-combination-open]');
      if (open) { event.preventDefault(); openCombinationPicker(Number(open.dataset.combinationOpen)); return; }
      var toggle = event.target.closest('[data-combination-toggle]');
      if (toggle) { event.preventDefault(); var index = Number(toggle.dataset.combinationToggle), variant = variants[index]; if (!variant) return; if (expandedCombinationParents.has(variant.erpVariantRef)) expandedCombinationParents.delete(variant.erpVariantRef); else expandedCombinationParents.add(variant.erpVariantRef); renderVariants(); return; }
      var remove = event.target.closest('[data-combination-remove]');
      if (remove) { event.preventDefault(); removeCombinationChild(Number(remove.dataset.combinationParentIndex), remove.dataset.combinationRemove); }
      var specOpen = event.target.closest('[data-combination-variant-open]'); if (specOpen) { event.preventDefault(); openCombinationVariantPicker(specOpen.dataset.combinationVariantOpen); return; }
      var reference = event.target.closest('[data-combination-reference]'); if (reference) { event.preventDefault(); openCombinationReferencePicker(reference.dataset.combinationReference); return; }
      var rowReference = event.target.closest('[data-combination-row-reference]'); if (rowReference) { event.preventDefault(); openCombinationVariantImagePicker(rowReference.dataset.combinationRowReference, rowReference.dataset.combinationRowKey, -1, ''); return; }
      var refreshBundle = event.target.closest('[data-combination-refresh]'); if (refreshBundle) { event.preventDefault(); refreshCombinationBundle(refreshBundle.dataset.combinationRefresh); return; }
      var nested = event.target.closest('[data-combination-node-toggle]'); if (nested) { event.preventDefault(); var ref = String(nested.dataset.combinationNodeToggle || ''); if (expandedCombinationNodes.has(ref)) expandedCombinationNodes.delete(ref); else expandedCombinationNodes.add(ref); renderVariants(); }
    });
    $('mainSourceOpenBtn').onclick = function () { var url = val('sourceUrl'); if (!/^https:\/\//i.test(url)) { note('请先填写可访问的HTTPS主货源链接', true); return; } window.open(url, '_blank', 'noopener'); };
    $('addSourceBundleBtn').onclick = function () { sourceBundles.push(normalizeSourceBundle({}, sourceBundles.length)); sourceImagePickerIndex = -1; markSourceBundlesDirty(); renderSourceBundles(); };
    $('sourceBundleList').addEventListener('input', function (event) { var card = event.target.closest('[data-source-bundle-index]'), field = event.target.dataset.sourceBundleField; if (!card || !field) return; var index = Number(card.dataset.sourceBundleIndex); if (!sourceBundles[index]) return; sourceBundles[index][field] = event.target.value; markSourceBundlesDirty(); });
    $('sourceBundleList').addEventListener('click', function (event) {
      var card = event.target.closest('[data-source-bundle-index]'); if (!card) return; var index = Number(card.dataset.sourceBundleIndex), bundle = sourceBundles[index]; if (!bundle) return;
      if (event.target.closest('[data-source-remove]')) { sourceBundles.splice(index, 1); sourceImagePickerIndex = -1; markSourceBundlesDirty(); renderSourceBundles(); return; }
      if (event.target.closest('[data-source-open]')) { var url = String(bundle.url || '').trim(); if (!/^https:\/\//i.test(url)) { note('请先填写可访问的 HTTPS 货源链接', true); return; } window.open(url, '_blank', 'noopener'); return; }
      if (event.target.closest('[data-source-images]')) { showSourceImagePicker(index); return; }
      var refreshBundle = event.target.closest('[data-combination-refresh]'); if (refreshBundle) { refreshCombinationBundle(refreshBundle.dataset.combinationRefresh); return; }
      var choice = event.target.closest('[data-source-image-choice]'); if (choice) { bundle.referenceImage = choice.dataset.sourceImageChoice || ''; sourceImagePickerIndex = -1; markSourceBundlesDirty(); renderSourceBundles(); note('已选择货源参考图'); }
    });
    $('variantHeadRow').addEventListener('click', function (event) { var remove = event.target.closest('[data-remove-variant-attribute]'); if (remove) { event.preventDefault(); removeManualVariantAttribute(Number(remove.dataset.removeVariantAttribute)); return; } var button = event.target.closest('[data-same-first]'); if (button && !button.disabled) { event.preventDefault(); copyFirstVariantColumn(button.dataset.sameFirst); } });
    $('recognizeVariantAttributesBtn').addEventListener('click', function () { runAutoVariantRecognition(); });
    $('calculateVariantPriceBtn').addEventListener('click', calculateAllVariantPrices);
    $('skuVideoUploadBtn').onclick = function () { $('skuVideoUploadInput').click(); };
    $('skuVideoUploadInput').addEventListener('change', function () { handleSkuVideoUpload(this.files && this.files[0]); this.value = ''; });
    $('skuVideoUrlInput').addEventListener('input', function () {
      var value = this.value.trim(), variant = variants[skuVideoEditorState.index];
      $('skuVideoEditorNote').textContent = '';
      renderSkuVideoEditorPreview(value || (skuVideoEditorState.mode === 'videoCover' && variant ? variant.video : ''));
    });
    $('skuVideoClearBtn').onclick = function () {
      $('skuVideoUrlInput').value = '';
      var variant = variants[skuVideoEditorState.index];
      renderSkuVideoEditorPreview(skuVideoEditorState.mode === 'videoCover' && variant ? variant.video : '');
      $('skuVideoEditorNote').textContent = skuVideoEditorState.mode === 'videoCover' && variant && variant.video ? '独立封面已清空，确认后列表将继续使用视频首帧预览。' : '当前地址已清空，点击确认后生效。';
    };
    $('skuVideoEditorClose').onclick = function () { clearSkuVideoObjectUrl(); $('skuVideoEditorDialog').close(); };
    $('skuVideoCancelBtn').onclick = function () { clearSkuVideoObjectUrl(); $('skuVideoEditorDialog').close(); };
    $('skuVideoConfirmBtn').onclick = applySkuVideoEditor;
    $('skuVideoEditorDialog').addEventListener('close', clearSkuVideoObjectUrl);
    renderSourceBundles();
    $('productForm').addEventListener('click', function (event) { var button = event.target.closest('[data-generate-model-name]'); if (button) generateModelName(Number(button.dataset.generateModelName)); });
    $('brand').addEventListener('input', function () { brandHasValue = true; syncBrandAttributes(); });
    $('hashtags').addEventListener('input', function () { hashtagsEdited = true; syncHashtags(); });
    $('variantBody').addEventListener('input', function (event) {
      if (event.target.matches('.variant-offer-input')) sizeOfferField(event.target);
      if (event.target.dataset.field === 'purchase' || event.target.dataset.field === 'domesticShipping') {
        var row = event.target.closest('tr[data-index]'), index = row ? Number(row.dataset.index) : -1, variant = variants[index];
        if (row && variant) {
          variant.purchase = row.querySelector('[data-field="purchase"]').value;
          variant.domesticShipping = row.querySelector('[data-field="domesticShipping"]').value;
          var oldCell = row.querySelector('.variant-col-purchase-total');
          if (oldCell) { var holder = document.createElement('tbody'); holder.innerHTML = '<tr>' + purchaseTotalCostCell(variant) + '</tr>'; oldCell.replaceWith(holder.firstElementChild.firstElementChild); }
        }
      }
    });
    $('productForm').addEventListener('input', function (event) {
      markWorkspaceDirty();
      var input = event.target;
      if (input.dataset.variantAttributeIndex != null && input.closest('tr')) {
        var promotedIndex = Number(input.dataset.variantAttributeIndex), promotedAttribute = promotionAttribute(promotedIndex);
        setVariantAutoWarning(Number(input.closest('tr').dataset.index), promotedIndex, ''); renderVariantAutoWarnings();
        if (promotedAttribute && promotedAttribute.promotionField === 'title') fullInfoDirty['field:title'] = true;
        if (promotedAttribute && promotedAttribute.promotionField === 'weight') fullInfoDirty['field:weight'] = true;
        if (promotedAttribute && promotedAttribute.promotionField === 'dimensions') ['length','width','height'].forEach(function (field) { fullInfoDirty['field:' + field] = true; });
      }
      if (input.dataset.field === 'color') linkColorName(input);
      if (input.dataset.field === 'colorName') syncColorName(input);
      if (['length','width','height'].indexOf(input.id) >= 0) { var currentDimension = input.value.trim(); if (!currentDimension) delete packageDimensionSources[input.id]; else if (Number(currentDimension) !== Number(packageDimensionValues[input.id])) packageDimensionSources[input.id] = 'manual'; packageDimensionValues[input.id] = currentDimension; }
      if (input.id) fullInfoDirty['field:' + input.id] = true;
      if (input.dataset.field && input.closest('tr')) fullInfoDirty['variant:' + input.closest('tr').dataset.index + ':' + input.dataset.field] = true;
      var attribute = attributes[Number(input.dataset.attributeIndex)];
      if (input.hasAttribute('data-attribute-index') && attribute) fullInfoDirty['attribute:' + detailData.attributeKey(attribute)] = true;
      if (['title','description','richContent','weight','barcode','length','width','height'].indexOf(input.id) >= 0) sharedDirty['field:' + input.id] = true;
      if (['color','colorName','packQuantity','itemLength'].indexOf(input.dataset.field) >= 0 && input.closest('tr').dataset.index === '0') sharedDirty['variant:' + input.dataset.field] = true;
    });
    $('productForm').addEventListener('change', function (event) {
      markWorkspaceDirty(); if (event.target.id) fullInfoDirty['field:' + event.target.id] = true;
      var categorySelectInput = event.target.closest && event.target.closest('[data-variant-category]');
      if (categorySelectInput) { var row = categorySelectInput.closest('tr[data-index]'); if (row) loadVariantCategoryDefinition(Number(row.dataset.index), categorySelectInput.value, categorySelectInput); }
    });
    $('variantBody').addEventListener('click', function (event) {
      var richButton = event.target.closest('[data-variant-rich-editor]'); if (richButton) { openRichContentEditor(richButton.parentElement.querySelector('textarea')); return; }
      var playButton = event.target.closest('[data-video-play]');
      if (playButton) { event.preventDefault(); event.stopPropagation(); toggleVariantVideoPlayback(playButton); return; }
      var videoTrigger = event.target.closest('[data-video-media]');
      if (videoTrigger) {
        var videoRow = videoTrigger.closest('tr'); if (videoRow) openSkuVideoEditor(Number(videoRow.dataset.index), videoTrigger.dataset.videoMedia);
        return;
      }
      if (event.target.closest('[data-copy],[data-delete]')) { variantStructureEdited = true; markWorkspaceDirty(); }
    });
    $('variantBody').addEventListener('keydown', function (event) {
      var trigger = event.target.closest('[data-video-media]');
      if (!trigger || event.target.closest('[data-video-play]') || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      var row = trigger.closest('tr'); if (row) openSkuVideoEditor(Number(row.dataset.index), trigger.dataset.videoMedia);
    });
    var addVariantButton = $('addVariantBtn');
    if (addVariantButton) {
      addVariantButton.hidden = !createMode;
      addVariantButton.onclick = function () {
        if (!createMode) return;
        collectVariants();
        if (variants.length >= 100) { note('单个商品最多支持100个变体', true); return; }
        variantStructureEdited = true; markWorkspaceDirty();
        variants.push(normVariant({})); renderVariants();
        var added = $('variantBody').querySelector('tr[data-index="' + (variants.length - 1) + '"] [data-field="name"]');
        if (added) added.focus();
      };
    }
    var deleteSelectedVariantsButton = $('deleteSelectedVariantsBtn');
    if (deleteSelectedVariantsButton) {
      deleteSelectedVariantsButton.hidden = !createMode;
      deleteSelectedVariantsButton.onclick = function () {
        if (!createMode) return;
        var selected = Array.from($('variantBody').querySelectorAll('tr[data-index] .variant-col-select input[type="checkbox"]'))
          .filter(function (box) { return box.checked; })
          .map(function (box) { return Number(box.closest('tr[data-index]').dataset.index); })
          .filter(Number.isInteger);
        if (!selected.length) { note('请先勾选需要删除的变体', true); return; }
        collectVariants();
        if (selected.length >= variants.length) { note('至少需要保留1个变体，请取消勾选一个变体后再删除', true); return; }
        variantStructureEdited = true; markWorkspaceDirty();
        selected.sort(function (a, b) { return b - a; }).forEach(function (index) {
          var removedVariant = variants[index];
          removeVariantCombinationRelations(removedVariant);
          variants.splice(index, 1);
        });
        renderVariants();
        note('已批量删除 ' + selected.length + ' 个变体；保存草稿或提交后才会正式保存');
      };
    }
    $('variantBody').onclick = function (e) {
      var media = e.target.closest('.variant-media-grid'), copy = e.target.closest('[data-copy]'), del = e.target.closest('[data-delete]');
      if (e.target.closest('[data-video-media]')) return;
      if (media) { var previewUrl = new URL(location.href); previewUrl.searchParams.set('skuStatic', '1'); location.href = previewUrl.toString(); return; }
      if (!copy && !del) return;
      collectVariants();
      if (copy) {
        var original = variants[Number(copy.dataset.copy)], copied = Object.assign({}, original, { erpVariantRef: newErpVariantRef(), sourceBundleIds: arr(original.sourceBundleIds).slice(), images: arr(original.images).slice(), attributes: arr(original.attributes).map(function (a) { return Object.assign({}, a); }) });
        cloneVariantCombinationRelations(original, copied);
        variants.splice(Number(copy.dataset.copy) + 1, 0, copied);
      }
      var deletedOne = false;
      if (del && variants.length > 1) {
        var removedVariant = variants[Number(del.dataset.delete)];
        removeVariantCombinationRelations(removedVariant);
        variants.splice(Number(del.dataset.delete), 1);
        deletedOne = true;
      }
      renderVariants();
      if (deletedOne) note('已删除1个变体；保存草稿或提交后才会正式保存');
    };
    $('saveDraftBtn').onclick = function () {
      if (createMode) { saveCreateDraft(false); return; }
      commitSkuImages(false).then(function (imageCommit) { if (!imageCommit) return; saveExisting(true, imageCommit); });
    };
    $('productForm').addEventListener('input', function (event) { if (event.target.getAttribute('aria-invalid') === 'true' || event.target.closest('.validation-error')) clearValidationMarks(); });
    $('productForm').addEventListener('change', function (event) { if (event.target.getAttribute('aria-invalid') === 'true' || event.target.closest('.validation-error')) clearValidationMarks(); });
    $('saveBtn').onclick = save; $('cancelBtn').onclick = function () {
      closeEditor();
    }; $('aiTextBtn').onclick = runOneClickAutofill; bindRichContentEditorControls();
    document.querySelectorAll('.editor-nav a').forEach(function (link) { link.onclick = function () { document.querySelectorAll('.editor-nav a').forEach(function (a) { a.classList.toggle('on', a === link); }); }; });
  }
  bind(); $('saveBtn').textContent = relistMode ? '确认下架重上' : createMode ? '保存新增商品' : '确定编辑';
  if (workspaceEmbedded) window.parent.postMessage({ type: 'wyerp-workspace-ready', route: location.pathname + location.search + location.hash, title: relistMode ? '下架重上' : createMode ? '新增商品' : fullInfoMode ? '全部信息' : '商品编辑' }, location.origin);
  var initKeys = [SHOP_KEY, PRODUCT_KEY, DRAFT_KEY];
  if (createMode && params.get('collectionId')) initKeys.push(COLLECTION_KEY);
  erpStorage.init(initKeys).then(function () { refreshDailySkuMembershipQuota(); shops = productShops.list(erpStorage.get(SHOP_KEY, [])); product = createMode && !relistMode ? null : findProduct(erpStorage.get(PRODUCT_KEY, []));
    productScope = optionScope();
    if (product) { var target = editTarget(); return requestJson('/api/domain/commands/product-edit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'read', target: target }) }).then(acceptEdit); }
  }).then(function () {
    $('saveDraftBtn').hidden = !createMode && !product;
    $('shop').disabled = !createMode || relistMode; shopSelect.refresh();
    if (relistMode) {
      $('saveDraftBtn').hidden = true;
      $('loadProductInfoBtn').hidden = true;
      if (!product) { note('没有找到要重新上架的原商品，请返回下架重上页面重新进入', true); $('saveBtn').disabled = true; $('saveDraftBtn').disabled = true; return; }
      collectionSourceId = String(product.collectionId || '');
      originalContentSource = { title: String(product.name || product.title || ''), attributes: aiSourceAttributes(product.editorAttributes || product.attributes) };
      fill(product);
      note('正在从 Ozon 完整读取原下架商品信息，读取完成后才生成新的重上草稿…');
      return loadProductMatch().then(function (result) {
        if (!result || !result.ok) {
          note('原商品信息未完整读取，不能按“复制全部信息”执行下架重上；请稍后重新进入。' + (result && result.failures && result.failures.length ? ' ' + result.failures.join('；') : ''), true);
          $('saveBtn').disabled = true; $('saveDraftBtn').disabled = true; return;
        }
        prepareRelistDraft();
      });
    }
    if (createMode) {
      var collectionId = String(params.get('collectionId') || '');
      var collected = collectionId && collectionModel ? collectionModel.normalizeAll(erpStorage.get(COLLECTION_KEY, [])).find(function (item) { return item.id === collectionId; }) : null;
      collectionSourceRecord = collected || null;
      if (collected) originalContentSource = { title: String(collected.title || ''), attributes: aiSourceAttributes(collected.capture && collected.capture.attributes) };
      var serverDrafts = arr(erpStorage.get(DRAFT_KEY, []));
      var serverCreateDraft = requestedCreateDraftId
        ? serverDrafts.find(function (item) { return item && item.mode === 'create' && item.draftId === requestedCreateDraftId; })
        : serverDrafts.filter(function (item) { return draftMatchesEntry(item, collectionId, collected); }).sort(function (a, b) { return createDraftTime(b) - createDraftTime(a); })[0];
      $('loadProductInfoBtn').hidden = true;
      return (requestedCreateDraftId ? browserDraftGet(requestedCreateDraftId) : browserDraftList().then(function (records) {
        return arr(records).filter(function (record) { return draftMatchesEntry(record && record.draft, collectionId, collected); })[0] || null;
      })).then(function (browserRecord) {
        if (staleBrowserOnlyDraft(browserRecord, serverCreateDraft)) {
          var staleId = String(browserRecord && (browserRecord.draftId || browserRecord.draft && browserRecord.draft.draftId) || '');
          if (staleId) browserDraftRemove(staleId);
          browserRecord = null;
        }
        if (browserRecord && browserRecord.draft) { sellingPointsBilingual = browserRecord.draft.sellingPointsBilingual || null; richContentBilingual = browserRecord.draft.richContentBilingual || null; }
        if (!originalContentSource && browserRecord && browserRecord.draft && browserRecord.draft.browserOriginalContentSource) originalContentSource = browserRecord.draft.browserOriginalContentSource;
        var restored = serverCreateDraft || browserRecord && browserRecord.draft, source = serverCreateDraft ? '服务器' : '浏览器';
        if (browserRecord && browserRecord.draft && (!serverCreateDraft || browserRecord.savedAt > createDraftTime(serverCreateDraft))) {
          restored = browserRecord.draft; source = '浏览器';
        }
        if (!requestedCreateDraftId && restored) {
          requestedCreateDraftId = String(restored.draftId || browserRecord && browserRecord.draftId || '');
          createDraftId = requestedCreateDraftId || createDraftId;
          rememberCreateDraftInUrl();
        }
        if (restored) {
          fill(restored); draftRestored = true; workspaceDraftSafe = true; createState = restored.ozonCreate || null;
          if (translationControls && translationControls.restoreState) translationControls.restoreState(browserRecord && browserRecord.draft && browserRecord.draft.browserTranslations || restored.browserTranslations);
          sellingPointsBilingual = restored.sellingPointsBilingual || sellingPointsBilingual;
          richContentBilingual = restored.richContentBilingual || richContentBilingual; restoreContentReviews(restored, browserRecord && browserRecord.draft);
          showCreateStatus('已从' + source + '恢复新增商品草稿');
        } else if (collected) {
          var collectionDraft = collectionModel.createDraft(collected); fill(collectionDraft);
          if (params.get('shop')) fillShops(params.get('shop'));
          note(collectionDraft.descriptionCategoryId && collectionDraft.typeId ? '已从采集箱预填商品资料和匹配的Ozon三级类目；请选择上架店铺后继续完善' : '已从采集箱预填商品资料；正在尝试自动匹配Ozon三级类目');
        } else {
          allowManualOriginalTitle = !requestedCreateDraftId && !collectionId;
          fillShops(params.get('shop') || ''); $('brand').value = '无品牌'; variants = [normVariant({})]; renderVariants(); renderAttributes();
          note(requestedCreateDraftId ? '没有找到该草稿的浏览器或服务器副本，已打开空白新增商品页面' : collectionId ? '未找到对应采集商品，已打开空白新增商品页面' : '新增模式：请选择三级类目', Boolean(requestedCreateDraftId || collectionId));
        }
        if (collected && (!val('descriptionCategoryId') || !val('typeId'))) autoMatchCollectionCategory(collected);
        if (params.get('focus') === 'source') $('sourceUrl').focus();
        setTimeout(function () { loadCatalog().then(function () { if (!categoryEdited) loadCurrentCategoryAttributes(); }); }, 0);
      });
    }
    else if (product) { originalContentSource = { title: String(product.name || product.title || ''), attributes: aiSourceAttributes(product.editorAttributes || product.attributes) }; fill(product); showEditStatus('已从 ERP 数据库加载；成本与平台资料分别保存'); }
    else { fillShops(params.get('shop') || ''); variants = [normVariant({})]; renderVariants(); renderAttributes(); note('没有找到对应商品，请返回在线商品重新进入', true); $('saveBtn').disabled = true; }
    if (params.get('focus') === 'source') $('sourceUrl').focus();
    $('loadProductInfoBtn').hidden = !product || !fullInfoMode;
    if (product) return browserDraftGet(editBrowserDraftId()).then(function (browserRecord) {
      if (browserRecord && browserRecord.draft) { sellingPointsBilingual = browserRecord.draft.sellingPointsBilingual || null; richContentBilingual = browserRecord.draft.richContentBilingual || null; }
      if (browserRecord && browserRecord.draft && browserRecord.draft.browserOriginalContentSource) originalContentSource = browserRecord.draft.browserOriginalContentSource;
      var serverDraft = product.editorDraft || null, restored = serverDraft, source = serverDraft ? '服务器' : '';
      if (browserRecord && browserRecord.draft && (!serverDraft || browserRecord.savedAt > (Date.parse(serverDraft.savedAt || '') || 0))) {
        restored = browserRecord.draft; source = '浏览器';
      }
      if (restored) {
        restoreDraft(restored);
        if (browserRecord && browserRecord.draft && browserRecord.draft.browserTranslations && translationControls && translationControls.restoreState) translationControls.restoreState(browserRecord.draft.browserTranslations);
        restoreContentReviews(restored, browserRecord && browserRecord.draft);
        note('已从' + source + '恢复整页草稿；再次保存会同步浏览器和服务器');
        return;
      }
      if (fullInfoMode) return loadProductMatch();
      setTimeout(function () { loadCatalog().then(function () { if (!categoryEdited) loadCurrentCategoryAttributes(); }); }, 0);
    });
    setTimeout(function () { loadCatalog().then(function () { if (!categoryEdited) loadCurrentCategoryAttributes(); }); }, 0);
  }).catch(function (e) { $('saveBtn').disabled = true; $('saveDraftBtn').disabled = true; note('页面载入失败：' + (e.message || '未知错误'), true); });
})();
