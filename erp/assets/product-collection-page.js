/* 网研ERP — 采集箱页面与Ozon类目匹配 */
(function () {
  'use strict';
  var KEY = 'erp_collected_products', DRAFT_KEY = 'erp_product_drafts';
  var model = window.WYERP_PRODUCT_COLLECTION;
  var sourceLink = window.WYERP_PRODUCT_SOURCE_LINK;
  var inputRules = window.WYERP_INPUT_RULES;
  var quotaApi = window.WYERP_MEMBERSHIP_QUOTA, collectionQuota = null, quotaReady = false;
  if (!sourceLink) throw new Error('货源商品链接模块加载失败');
  if (!quotaApi) throw new Error('会员采集箱额度模块加载失败');
  inputRules.bind(document);
  var products = [], drafts = [], catalog = [], catalogPromise = null, manualProductId = '', packageProductId = '', combinationHistoryProductId = '', matching = false, supplementing = false, activeQuickFilter = 'all', combinationGraph = { relations: [], aliases: [], history: [] };
  var body = document.getElementById('collectBody'), editor = document.getElementById('editor'), categoryEditor = document.getElementById('categoryEditor'), packageEditor = document.getElementById('packageEditor'), combinationHistoryDialog = document.getElementById('combinationHistoryDialog');
  var matchButton = document.getElementById('matchCategoryBtn'), matchButtonLabel = document.getElementById('matchCategoryBtnLabel'), supplementButton = document.getElementById('supplementDimensionBtn'), supplementButtonLabel = document.getElementById('supplementDimensionBtnLabel'), matchStatus = document.getElementById('categoryMatchStatus');

  function now() { var d = new Date(), p = function (n) { return n < 10 ? '0' + n : n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function id() { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'p-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
  function el(tag, className, value) { var node = document.createElement(tag); if (className) node.className = className; if (value != null) node.textContent = String(value); return node; }
  function save() { return erpStorage.set(KEY, products); }
  function trustedMessage(value, fallback) {
    var message = typeof value === 'string' ? value.trim() : '';
    var checked = message.replace(/Ozon/g, '');
    return message.length <= 200 && /[\u3400-\u9fff]/.test(checked) && !/[A-Za-z_\\/\r\n]|\b[45]\d{2}\b/.test(checked)
      ? message : fallback;
  }
  function requestJson(url, options, fallback) {
    return erpStorage.request(url, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) { var error = new Error(trustedMessage(data.message, fallback)); error.status = response.status; error.code = data.error; throw error; }
        return data;
      });
    }, function () { throw new Error(fallback); });
  }
  function collectionQuotaFull() {
    return quotaReady && collectionQuota && !collectionQuota.unlimited && collectionQuota.limit !== null && products.length >= Number(collectionQuota.limit || 0);
  }
  function renderCollectionQuota() {
    var host = document.getElementById('collectionBoxMembershipQuota'), createButton = document.getElementById('createBtn');
    if (!host || !createButton) return;
    if (!quotaReady || !collectionQuota) {
      host.className = 'membership-quota-card membership-quota-compact is-over-limit';
      host.textContent = '会员采集箱额度读取失败，暂不可新增采集商品；已有数据仍可查看和清理。';
      createButton.disabled = true;
      createButton.title = '会员采集箱额度读取失败，请刷新后重试';
      return;
    }
    collectionQuota.usage = products.length;
    quotaApi.render(host, collectionQuota, { compact: true, label: collectionQuota.localOnly ? '采集箱商品' : '采集箱会员额度', note: '按商品条目计数，不按SKU数量计数' });
    var full = collectionQuotaFull();
    createButton.disabled = full;
    createButton.title = full ? '采集箱会员额度已用完，请先清理不再需要的商品或升级会员' : '手动创建采集商品';
  }
  function applyCollectionQuota(payload) {
    var quota = payload && payload.quotas && payload.quotas.collectionBox;
    collectionQuota = quota ? Object.assign({}, quota) : null;
    quotaReady = Boolean(collectionQuota);
    renderCollectionQuota();
    return payload;
  }
  function refreshCollectionQuota() {
    return quotaApi.load().then(applyCollectionQuota).catch(function () {
      quotaReady = false; collectionQuota = null; renderCollectionQuota(); return null;
    });
  }
  function setMatchStatus(kind, message) {
    matchStatus.className = 'category-match-status' + (kind ? ' is-' + kind : '');
    matchStatus.textContent = message || '';
    matchStatus.hidden = !message;
  }
  function shippingParts(value) {
    var valueText = String(value || '').trim(), match = valueText.match(/^(.*?)[（(]([^）)]*)[）)]\s*$/);
    return { main: match ? match[1].trim() : (valueText || '--'), detail: match ? '（' + match[2].trim() + '）' : '' };
  }
  function packageParts(product) {
    var pack = model.packageSummary(product), dimensions = [pack.lengthMm, pack.widthMm, pack.heightMm], hasDimension = dimensions.some(function (value) { return value != null; });
    return { size: hasDimension ? dimensions.map(function (value) { return value == null ? '--' : value; }).join(' × ') + ' mm' : '--', weight: pack.weightG == null ? '--' : pack.weightG + ' g' };
  }
  function packageVariantTooltip(product) {
    var draft = model.createDraft(product), modes = new Set(model.array(draft.manualVariantAttributes));
    var showWeight = modes.has('field:weight'), showDimensions = modes.has('field:dimensions');
    if (!showWeight && !showDimensions) return '';
    var lines = ['多规格包装数据：'];
    model.array(draft.variants).forEach(function (variant, index) {
      var label = String(variant && (variant.name || variant.sourceSpecText || variant.sku) || ('规格 ' + (index + 1))).trim(), parts = [];
      if (showWeight) parts.push('重量 ' + (variant.weightG == null || variant.weightG === '' ? '未知' : variant.weightG + ' g'));
      if (showDimensions) parts.push('尺寸 ' + [variant.packageLength, variant.packageWidth, variant.packageHeight].map(function (value) { return value == null || value === '' ? '--' : value; }).join(' × ') + ' mm');
      lines.push(label + '：' + parts.join('；'));
    });
    return lines.join('\n');
  }
  function selectedIds() { return Array.from(document.querySelectorAll('.row-check:checked')).map(function (node) { return node.value; }); }
  function filters() { return { keyword: document.getElementById('keyword').value, source: document.getElementById('sourceFilter').value, status: document.getElementById('statusFilter').value }; }
  function draftTime(draft) { return Date.parse(draft && (draft.updatedAt || draft.savedAt) || '') || 0; }
  function collectionDraft(product) {
    var collectionId = String(product && product.id || ''), userId = erpStorage && typeof erpStorage.getCurrentUserId === 'function' ? String(erpStorage.getCurrentUserId() || '') : '';
    return drafts.filter(function (draft) {
      if (!draft || draft.mode !== 'create' || String(draft.collectionId || '') !== collectionId) return false;
      return !userId || !draft.ownerUserId || String(draft.ownerUserId) === userId;
    }).sort(function (a, b) { return draftTime(b) - draftTime(a); })[0] || null;
  }
  function remainingDraftTime(ms) {
    if (!(ms > 0)) return '等待自动清理';
    var hours = Math.max(1, Math.ceil(ms / 3600000)), days = Math.floor(hours / 24), rest = hours % 24;
    if (days && rest) return '剩余 ' + days + '天' + rest + '小时';
    if (days) return '剩余 ' + days + '天';
    return '剩余 ' + hours + '小时';
  }
  function draftMeta(draft) {
    if (!draft) return { text: '', title: '' };
    var updatedRaw = draft.updatedAt || draft.savedAt || '', updated = dateTimeParts(updatedRaw), updatedText = [updated.date, updated.time].filter(Boolean).join(' ');
    var retention = draft.draftRetention && typeof draft.draftRetention === 'object' ? draft.draftRetention : {};
    var protectedText = retention.reason === 'active_task' ? '任务处理中，不自动清理'
      : retention.protected ? '组合保护，不自动清理'
      : '';
    var expiresAt = Date.parse(retention.expiresAt || '');
    if (!Number.isFinite(expiresAt)) {
      var base = draftTime(draft);
      if (base) expiresAt = base + 72 * 60 * 60 * 1000;
    }
    var retentionText = protectedText || (Number.isFinite(expiresAt) ? remainingDraftTime(expiresAt - Date.now()) : '72小时自动清理');
    return {
      text: retentionText,
      title: ['草稿更新：' + (updatedText || '--'), retentionText].join('\n')
    };
  }
  function collectionOutgoingRelations(id, ref, relations) {
    var direct = relations.filter(function (relation) { return relation && relation.parentRef === ref; }); if (direct.length) return direct;
    var alias = (Array.isArray(combinationGraph.aliases) ? combinationGraph.aliases : []).find(function (item) { return item && String(item.collectionId || '') === id; });
    return alias ? relations.filter(function (relation) { return relation && relation.parentRef === 'variant:' + String(alias.variantRef || ''); }) : [];
  }
  function collectionCombinationStats(product) {
    var id = String(product && product.id || ''), ref = 'collection:' + id, relations = Array.isArray(combinationGraph.relations) ? combinationGraph.relations : [], history = Array.isArray(combinationGraph.history) ? combinationGraph.history : [];
    var incoming = relations.filter(function (relation) { return relation && (relation.childRef === ref || String(relation.childCollectionId || '') === id); });
    var outgoing = collectionOutgoingRelations(id, ref, relations);
    var events = history.filter(function (event) { return event && (event.parentRef === ref || event.childRef === ref || String(event.childCollectionId || '') === id); }).slice().sort(function (a, b) { return (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0); });
    var latestParentEvent = events.find(function (event) { return event.action === 'linked' && (event.childRef === ref || String(event.childCollectionId || '') === id); });
    return { protected: Boolean(incoming.length || outgoing.length), parentRefCount: incoming.length, childCount: outgoing.length, combinationEventCount: events.length, lastCombinedAt: events[0] && events[0].occurredAt || '', recentParentRef: latestParentEvent && latestParentEvent.parentRef || incoming[0] && incoming[0].parentRef || '', multiLevel: outgoing.length > 0, history: events };
  }
  function loadCombinationGraph() {
    return requestJson('/api/domain/queries/product-combinations').then(function (data) { combinationGraph = { relations: Array.isArray(data.relations) ? data.relations : [], aliases: Array.isArray(data.aliases) ? data.aliases : [], history: Array.isArray(data.history) ? data.history : [] }; return combinationGraph; }).catch(function () { combinationGraph = { relations: [], aliases: [], history: [] }; return combinationGraph; });
  }
  function blockedRemovalIds(ids) { return ids.filter(function (id) { var product = products.find(function (item) { return String(item.id) === String(id); }); return product && collectionCombinationStats(product).protected; }); }
  function removalBlockedMessage(count) { return count === 1 ? '该采集商品正在参与商品组合，请先解除全部组合关系后再删除。' : '选中的商品中有 ' + count + ' 个正在参与商品组合，请先解除组合关系后再删除。'; }
  function categoryMatchText(product) {
    var detail = model.ozonCategory(product), methodLabel = detail.method === 'manual_feedback' ? '人工确认' : detail.method === 'manual_exact' || detail.method === 'manual_similar' ? '训练样本' : detail.method === 'catalog_weighted' ? '综合匹配' : detail.status === 'matched' ? '自动匹配' : detail.status ? '需要人工处理' : '';
    var percent = detail.confidence == null ? '' : String(Math.round(detail.confidence * 100));
    return [detail.pathText, detail.method, methodLabel, percent, percent ? percent + '%' : '', percent ? '百分之' + percent : ''].filter(Boolean).join(' ').toLowerCase();
  }
  function matchesCategoryFilter(product) {
    var query = String(document.getElementById('categoryMatchFilter').value || '').trim().toLowerCase().replace(/％/g, '%');
    if (!query) return true;
    var haystack = categoryMatchText(product);
    return query.split(/\s+/).filter(Boolean).every(function (term) { return haystack.indexOf(term) >= 0; });
  }
  function hasPackageDimensionsAndWeight(product) {
    var pack = model.packageSummary(product);
    return [pack.lengthMm, pack.widthMm, pack.heightMm, pack.weightG].every(function (value) { return value != null && Number(value) > 0; });
  }
  function hasFreeShipping(product) {
    if (/包邮|free\s*shipping/i.test(String(product.shippingText || ''))) return true;
    return product.shippingAmount !== '' && product.shippingAmount != null && Number(product.shippingAmount) === 0;
  }
  function isOnePieceMinimum(product) {
    var quantity = product.minimumQuantity == null || product.minimumQuantity === '' ? null : Number(product.minimumQuantity), unit = String(product.minimumUnit || '').trim();
    if (quantity != null) return quantity === 1;
    if (unit) return false;
    return /(?:按\s*)?1\s*(?:件|套|盒|枚|条|组|份|支|台|只|对|张|个)\s*起批/.test(String(product.shippingText || ''));
  }
  function matchesQuickFilter(product, key) {
    if (key === 'unlisted') return product.status === '未上架';
    if (key === 'category_failed') return Boolean(product.ozonCategoryMatch) && model.ozonCategory(product).status !== 'matched';
    if (key === 'free_shipping') return hasFreeShipping(product);
    if (key === 'one_piece') return isOnePieceMinimum(product);
    if (key === 'with_package') return hasPackageDimensionsAndWeight(product);
    if (key === 'without_package') return !hasPackageDimensionsAndWeight(product);
    if (key === 'listed') return product.status === '已上架';
    if (key === 'combination') return collectionCombinationStats(product).protected;
    if (key === 'drafts') return Boolean(collectionDraft(product));
    return true;
  }
  function renderQuickFilters(rows) {
    document.querySelectorAll('#collectionQuickFilters [data-quick-filter]').forEach(function (button) {
      var key = button.dataset.quickFilter, count = key === 'all' ? rows.length : rows.filter(function (product) { return matchesQuickFilter(product, key); }).length;
      var badge = button.querySelector('strong'); if (badge) badge.textContent = String(count);
      var active = key === activeQuickFilter; button.classList.toggle('on', active); button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }
  function renderSources() {
    var select = document.getElementById('sourceFilter'), current = select.value;
    var sources = products.map(function (product) { return product.source; }).filter(Boolean).filter(function (value, index, all) { return all.indexOf(value) === index; });
    select.replaceChildren();
    var all = document.createElement('option'); all.value = ''; all.textContent = '全部平台'; select.appendChild(all);
    sources.forEach(function (value) { var option = document.createElement('option'); option.value = value; option.textContent = value; select.appendChild(option); });
    if (sources.indexOf(current) >= 0) select.value = current;
  }
  function textCell(row, value, className, title) {
    var cell = el('td', className || '', null), span = el('span', 'cell-ellipsis', value == null || value === '' ? '--' : value);
    span.title = title == null ? span.textContent : String(title); cell.appendChild(span); row.appendChild(cell); return cell;
  }
  function dateTimeParts(value) {
    var raw = String(value || '').trim();
    if (!raw) return { date: '--', time: '' };
    var simple = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
    if (simple) return { date: simple[1], time: simple[2] + ':' + (simple[3] || '00') };
    var date = new Date(raw);
    if (!Number.isFinite(date.getTime())) return { date: raw, time: '' };
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return { date: date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()), time: pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds()) };
  }
  function dateTimeCell(row, value) {
    var parts = dateTimeParts(value), cell = el('td', 'date-time-cell');
    cell.appendChild(el('span', 'date-line', parts.date));
    if (parts.time) cell.appendChild(el('span', 'time-line', parts.time));
    row.appendChild(cell); return cell;
  }
  function sourceTitleNode(product, label, className) {
    var platform = String(product && (product.source || product.sourcePlatform) || '').trim();
    var href = sourceLink.safePlatformSupplierUrl(product && (product.sourceUrl || product.url) || '', platform);
    var node = el(href ? 'a' : 'span', className || 'cell-ellipsis', label);
    node.title = href && platform ? label + '\n原平台：' + platform : label;
    if (href) {
      node.href = href; node.target = '_blank'; node.rel = 'noopener';
      node.classList.add('source-product-link');
      node.setAttribute('aria-label', '在' + (platform || '原平台') + '打开原商品：' + label);
    }
    return node;
  }
  function titleCell(row, product, label) {
    var cell = el('td', 'title-cell', null), node = sourceTitleNode(product, label, 'cell-ellipsis');
    cell.appendChild(node); row.appendChild(cell); return cell;
  }
  function actionButton(label, className, title) {
    var button = el('button', 'btn ' + className, label); button.type = 'button'; button.title = title || label; return button;
  }
  function renderOzonCategory(cell, product) {
    var detail = model.ozonCategory(product), failed = product.ozonCategoryMatch && detail.status !== 'matched';
    cell.className = 'category-cell ozon-category-cell' + (failed ? ' is-failed' : detail.status === 'matched' ? ' is-matched' : '');
    var label = detail.pathText || (failed ? '匹配失败，需要手动更改' : '--');
    var reasonText = model.array(detail.reasons).join('；');
    var path = el('span', 'cell-ellipsis ozon-category-label', label); path.title = [detail.pathText || detail.warning || label, reasonText ? '匹配依据：' + reasonText : ''].filter(Boolean).join('\n'); cell.appendChild(path);
    if (detail.status) {
      var confidence = detail.confidence == null ? '' : ' · ' + Math.round(detail.confidence * 100) + '%';
      cell.appendChild(el('span', 'ozon-category-meta', detail.method === 'manual_feedback' ? '人工确认' : detail.method === 'manual_exact' || detail.method === 'manual_similar' ? '训练样本' + confidence : detail.method === 'catalog_weighted' ? '综合匹配' + confidence : detail.status === 'matched' ? '自动匹配' + confidence : '需要人工处理'));
    }
    var button = actionButton(detail.status === 'matched' ? '更改' : '手动选择', 'category-manual-btn', (detail.status === 'matched' ? '人工更改 ' : '手动选择 ') + (product.title || '商品') + ' 的Ozon类目');
    button.dataset.manualCategory = product.id; cell.appendChild(button);
  }
  function combinationEventRoute(event) {
    var parent = String(event && event.parentRef || '').replace(/^variant:/, 'SKU ').replace(/^collection:/, '采集箱 ');
    var child = String(event && (event.childRef || event.childCollectionId) || '').replace(/^variant:/, 'SKU ').replace(/^collection:/, '采集箱 ');
    return [parent, child].filter(Boolean).join(' → ');
  }
  function openCombinationHistory(productId) {
    combinationHistoryProductId = String(productId || '');
    var product = products.find(function (item) { return String(item.id) === combinationHistoryProductId; }); if (!product) return;
    var stats = collectionCombinationStats(product), summary = document.getElementById('combinationHistorySummary'), list = document.getElementById('combinationHistoryList');
    var historyTitle = document.getElementById('combinationHistoryTitle'), historyLabel = product.title || '未命名商品'; historyTitle.textContent = '组合记录 · ' + historyLabel; historyTitle.title = historyLabel;
    summary.innerHTML = '<div class="combination-history-stat"><strong>' + stats.childCount + '</strong><span>当前子项</span></div><div class="combination-history-stat"><strong>' + stats.parentRefCount + '</strong><span>父项引用</span></div><div class="combination-history-stat"><strong>' + stats.combinationEventCount + '</strong><span>累计操作</span></div><div class="combination-history-stat"><strong>' + (stats.lastCombinedAt ? dateTimeParts(stats.lastCombinedAt).date : '--') + '</strong><span>最近组合日期</span></div><div class="combination-history-stat"><strong>' + (stats.recentParentRef ? combinationEventRoute({ parentRef: stats.recentParentRef }).replace(/ → $/, '') : '--') + '</strong><span>最近关联父项</span></div><div class="combination-history-stat"><strong>' + (stats.multiLevel ? '是' : '否') + '</strong><span>多级组合</span></div>';
    list.replaceChildren();
    if (!stats.history.length) list.appendChild(el('div', 'empty', '暂无组合历史'));
    else stats.history.forEach(function (event) {
      var item = el('div', 'combination-history-item'), parts = dateTimeParts(event.occurredAt), time = el('time', '', [parts.date, parts.time].filter(Boolean).join(' ')), action = el('span', 'combination-history-action' + (event.action === 'unlinked' ? ' is-unlinked' : ''), event.action === 'unlinked' ? '解除' : '组合'), route = el('span', 'combination-history-route', combinationEventRoute(event) || '--');
      item.append(time, action, route); list.appendChild(item);
    });
    combinationHistoryDialog.showModal();
  }
  function render() {
    var baseRows = model.filter(products, filters()).filter(matchesCategoryFilter);
    renderCollectionQuota();
    renderQuickFilters(baseRows);
    var rows = baseRows.filter(function (product) { return matchesQuickFilter(product, activeQuickFilter); });
    if (activeQuickFilter === 'combination') rows.sort(function (a, b) { return (Date.parse(collectionCombinationStats(b).lastCombinedAt) || 0) - (Date.parse(collectionCombinationStats(a).lastCombinedAt) || 0); });
    if (activeQuickFilter === 'drafts') rows.sort(function (a, b) { return draftTime(collectionDraft(b)) - draftTime(collectionDraft(a)); });
    document.getElementById('selectAll').checked = false;
    matchButton.disabled = matching || supplementing || !products.length;
    supplementButton.disabled = supplementing || matching || !products.length;
    body.replaceChildren();
    if (!rows.length) {
      var emptyRow = document.createElement('tr'), emptyCell = document.createElement('td'); emptyCell.colSpan = 15;
      var empty = el('div', 'empty', '采集箱暂无符合条件的商品'); empty.appendChild(document.createElement('br')); empty.appendChild(document.createTextNode('可点击「手动创建商品」录入，或使用浏览器插件直接采集。'));
      emptyCell.appendChild(empty); emptyRow.appendChild(emptyCell); body.appendChild(emptyRow); return;
    }
    rows.forEach(function (product) {
      var row = document.createElement('tr'), label = product.title || '未命名商品';
      var checkCell = document.createElement('td'), check = document.createElement('input'); check.className = 'row-check'; check.type = 'checkbox'; check.value = product.id; check.setAttribute('aria-label', '选择 ' + label); checkCell.appendChild(check); row.appendChild(checkCell);
      var imageCell = document.createElement('td');
      if (product.image) { var image = document.createElement('img'); image.className = 'collect-image'; image.src = product.image; image.alt = ''; image.loading = 'lazy'; imageCell.appendChild(image); }
      else imageCell.appendChild(el('div', 'collect-image'));
      row.appendChild(imageCell);
      titleCell(row, product, label);
      textCell(row, product.category || '--', 'category-cell source-category-cell', product.category || '--');
      var ozonCell = document.createElement('td'); renderOzonCategory(ozonCell, product); row.appendChild(ozonCell);
      textCell(row, product.price == null ? '--' : '¥ ' + product.price);
      var shipping = shippingParts(product.shippingText), shippingCell = el('td', 'shipping-cell'); shippingCell.appendChild(el('span', 'shipping-main', shipping.main)); shippingCell.appendChild(el('span', 'shipping-detail', shipping.detail)); row.appendChild(shippingCell);
      textCell(row, product.skuCount == null ? '--' : product.skuCount); textCell(row, product.source || '--');
      var pack = packageParts(product), packageCell = el('td', 'package-cell'), packageTooltip = packageVariantTooltip(product);
      if (packageTooltip) { packageCell.title = packageTooltip; packageCell.setAttribute('aria-label', '重量和尺寸；悬停可查看多规格差异'); }
      var weightRow = el('div', 'package-weight-row'), weight = el('span', 'package-weight', '重量：' + pack.weight), packageButton = actionButton('修改', 'package-edit-btn', '仅修改 ' + label + ' 的重量和尺寸');
      packageButton.dataset.packageEdit = product.id; packageButton.setAttribute('aria-label', packageButton.title); weightRow.appendChild(weight); weightRow.appendChild(packageButton); packageCell.appendChild(weightRow); packageCell.appendChild(el('span', 'package-size', '尺寸：' + pack.size)); row.appendChild(packageCell);
      var collectorIdentity = product.collectedByIdentity || {}, collectorText = collectorIdentity.masked || '历史未记录';
      textCell(row, collectorText, 'collector-cell', collectorIdentity.raw || collectorText);
      textCell(row, product.status); dateTimeCell(row, product.createdAt); dateTimeCell(row, product.updatedAt);
      var actionCell = document.createElement('td'), actions = el('div', 'collect-actions'), draft = collectionDraft(product); actionCell.className = 'collect-action-cell';
      var create = el('a', 'btn collect-action-btn collect-create-btn create-product-btn' + (draft ? ' has-draft' : ''), draft ? '继续编辑' : '新增商品'); var createUrl = '/pages/product-detail.html?mode=create&collectionId=' + encodeURIComponent(String(product.id)); if (draft && draft.draftId) createUrl += '&draftId=' + encodeURIComponent(String(draft.draftId)); var selectedTenant = erpStorage && typeof erpStorage.getSelectedTenantId === 'function' ? String(erpStorage.getSelectedTenantId() || '') : ''; if (selectedTenant) createUrl += '&tenantId=' + encodeURIComponent(selectedTenant); create.href = createUrl; create.title = draft ? '继续编辑 ' + label + ' 的当前账号草稿' : '用 ' + label + ' 新增在线商品'; create.setAttribute('aria-label', create.title); actions.appendChild(create);
      var draftMetaNode = null; if (draft) { var meta = draftMeta(draft); draftMetaNode = el('span', 'collect-draft-meta', meta.text); draftMetaNode.title = meta.title; }
      var combination = collectionCombinationStats(product);
      if (combination.protected) { var badge = el('button', 'collect-combination-badge', '组合 ' + (combination.combinationEventCount || combination.childCount + combination.parentRefCount)); badge.type = 'button'; badge.dataset.combinationHistory = product.id; badge.title = '子项 ' + combination.childCount + '｜被 ' + combination.parentRefCount + ' 个父项引用｜累计组合操作 ' + combination.combinationEventCount + (combination.lastCombinedAt ? '\n最近组合：' + combination.lastCombinedAt : '') + (combination.recentParentRef ? '\n最近关联父项：' + combination.recentParentRef : '') + '\n多级组合：' + (combination.multiLevel ? '是' : '否') + '\n点击查看按时间倒序排列的组合记录'; actions.appendChild(badge); }
      var remove = actionButton('删除', 'collect-action-btn collect-remove-btn remove-btn', combination.protected ? '该商品正在参与组合，需先解除全部组合关系' : '删除 ' + label); remove.dataset.id = product.id; remove.disabled = combination.protected; actions.appendChild(remove); actionCell.appendChild(actions); if (draftMetaNode) actionCell.appendChild(draftMetaNode); row.appendChild(actionCell);
      body.appendChild(row);
    });
  }
  function openEditor() {
    if (!quotaReady) { alert('会员采集箱额度读取失败，暂不能新增商品，请刷新后重试。'); return; }
    if (collectionQuotaFull()) { alert('采集箱会员额度已用完，请先清理不再需要的商品，或升级会员方案后再新增。'); return; }
    document.getElementById('dialogTitle').textContent = '手动创建商品';
    document.getElementById('editTitle').value = ''; document.getElementById('editPrice').value = ''; document.getElementById('editSkuCount').value = ''; document.getElementById('editSource').value = '手动创建';
    document.getElementById('editStatus').value = '未上架'; document.getElementById('editImage').value = ''; document.getElementById('editSourceUrl').value = ''; document.getElementById('editNote').value = '';
    editor.showModal(); document.getElementById('editTitle').focus();
  }
  function openPackageEditor(productId) {
    packageProductId = String(productId || '');
    var product = products.find(function (item) { return item.id === packageProductId; }); if (!product) return;
    var pack = model.packageSummary(product), fields = { packageWeight: pack.weightG, packageLength: pack.lengthMm, packageWidth: pack.widthMm, packageHeight: pack.heightMm };
    var packageTitle = document.getElementById('packageProductTitle'), packageLabel = product.title || '未命名商品'; packageTitle.replaceChildren(sourceTitleNode(product, packageLabel, 'product-title-ellipsis')); packageTitle.title = packageLabel;
    Object.keys(fields).forEach(function (field) { document.getElementById(field).value = fields[field] == null ? '' : String(fields[field]); });
    var hint = document.getElementById('packageEditHint'); hint.className = 'package-edit-hint'; hint.textContent = '单位固定为克和毫米，填写值必须大于0。';
    packageEditor.showModal(); document.getElementById('packageWeight').focus();
  }
  function catalogPath(item) { return model.array(item && item.path).map(function (level) { return String(level && level.name || level || '').trim(); }).filter(Boolean).join(' > '); }
  function catalogKey(item) { return String(item && item.descriptionCategoryId || '') + ':' + String(item && item.typeId || ''); }
  function loadCatalog() {
    if (catalog.length) return Promise.resolve(catalog);
    if (catalogPromise) return catalogPromise;
    catalogPromise = requestJson('/api/category-attributes/catalog', undefined, '平台类目目录加载失败，请稍后重试。').then(function (data) {
      var seen = Object.create(null);
      catalog = model.array(data.items).filter(function (item) { var key = catalogKey(item), label = catalogPath(item); if (item.disabled || !/^\d+:\d+$/.test(key) || !label || seen[key]) return false; seen[key] = true; return true; });
      return catalog;
    }).finally(function () { catalogPromise = null; });
    return catalogPromise;
  }
  function suggestedKeys(product) {
    var detail = model.ozonCategory(product), keys = [];
    if (detail.key) keys.push(detail.key);
    model.array(detail.alternatives).forEach(function (candidate) { var key = String(candidate.key || (candidate.descriptionCategoryId || '') + ':' + (candidate.typeId || '')); if (/^\d+:\d+$/.test(key) && keys.indexOf(key) < 0) keys.push(key); });
    return keys;
  }
  function renderCategoryOptions(query) {
    var product = products.find(function (item) { return item.id === manualProductId; }), select = document.getElementById('ozonCategorySelect');
    var normalized = String(query || '').trim().toLowerCase(), suggestions = suggestedKeys(product || {}), rows = [];
    suggestions.forEach(function (key) { var item = catalog.find(function (entry) { return catalogKey(entry) === key; }); if (item && rows.indexOf(item) < 0) rows.push(item); });
    if (normalized) catalog.forEach(function (item) { var label = catalogPath(item).toLowerCase(); if (label.indexOf(normalized) >= 0 && rows.indexOf(item) < 0 && rows.length < 120) rows.push(item); });
    else if (!rows.length) rows = catalog.slice(0, 80);
    select.replaceChildren();
    rows.forEach(function (item) { var option = document.createElement('option'); option.value = catalogKey(item); option.textContent = catalogPath(item); select.appendChild(option); });
    var current = product && model.ozonCategory(product).key;
    if (current && rows.some(function (item) { return catalogKey(item) === current; })) select.value = current;
    else if (select.options.length) select.selectedIndex = 0;
    document.getElementById('categorySearchCount').textContent = rows.length ? '显示 ' + rows.length + ' 个类目；输入中文路径可继续筛选' : '没有匹配结果，请更换关键词';
  }
  function openCategoryEditor(productId) {
    manualProductId = String(productId || '');
    var product = products.find(function (item) { return item.id === manualProductId; }); if (!product) return;
    var categoryTitle = document.getElementById('categoryProductTitle'), categoryLabel = product.title || '未命名商品'; categoryTitle.replaceChildren(sourceTitleNode(product, categoryLabel, 'product-title-ellipsis')); categoryTitle.title = categoryLabel;
    document.getElementById('categorySourcePath').textContent = product.category || '--';
    document.getElementById('categorySearch').value = '';
    document.getElementById('categoryFeedbackHint').textContent = '保存后会记录为当前租户的人工训练样本；以后同类商品优先复用。';
    categoryEditor.showModal();
    loadCatalog().then(function () { renderCategoryOptions(''); document.getElementById('categorySearch').focus(); }).catch(function (error) { document.getElementById('categoryFeedbackHint').textContent = 'Ozon类目目录加载失败：' + error.message; });
  }
  function matchAllCategories() {
    if (matching || supplementing || !products.length) return;
    matching = true; matchButton.disabled = true; matchButtonLabel.textContent = '正在匹配…'; setMatchStatus('loading', '正在综合参考标题、货源类目和商品属性，匹配采集箱全部 ' + products.length + ' 个商品…');
    var inputs = products.map(model.categoryMatchInput), batches = [];
    for (var offset = 0; offset < inputs.length; offset += 300) batches.push(inputs.slice(offset, offset + 300));
    var aggregate = { results: [], summary: { total: 0, matched: 0, needsManual: 0 } };
    var requests = batches.reduce(function (promise, items, index) {
      return promise.then(function () {
        setMatchStatus('loading', '正在匹配第 ' + (index + 1) + '/' + batches.length + ' 批，共 ' + inputs.length + ' 个商品…');
        return requestJson('/api/product-category-mappings/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items }) }, '类目匹配失败，原有商品数据未改变，请稍后重试。').then(function (data) {
          aggregate.results = aggregate.results.concat(model.array(data.results));
          aggregate.summary.total += Number(data.summary && data.summary.total || 0);
          aggregate.summary.matched += Number(data.summary && data.summary.matched || 0);
          aggregate.summary.needsManual += Number(data.summary && data.summary.needsManual || 0);
        });
      });
    }, Promise.resolve());
    requests.then(function () {
      var data = aggregate;
      var byId = Object.create(null); model.array(data.results).forEach(function (entry) { byId[String(entry.id)] = entry.match; });
      products = products.map(function (product) { return byId[product.id] ? Object.assign(model.applyOzonMatch(product, byId[product.id]), { updatedAt: now() }) : product; });
      return save().then(function () {
        render();
        var summary = data.summary || {}, message = '匹配完成：成功 ' + Number(summary.matched || 0) + ' 个，需手动更改 ' + Number(summary.needsManual || 0) + ' 个。';
        setMatchStatus(Number(summary.needsManual || 0) ? 'warning' : 'success', message + (summary.needsManual ? '失败项已标红，请点击“手动选择”。' : ''));
      });
    }).catch(function (error) {
      setMatchStatus('error', '类目匹配或保存失败，已有数据保留，可重试：' + error.message);
    }).finally(function () { matching = false; matchButtonLabel.textContent = '匹配全部类目'; render(); });
  }
  function supplementDimensions() {
    if (supplementing || matching || !products.length) return;
    var original = products, changed = 0, skippedLimit = 0, skippedUnknown = 0, alreadyComplete = 0, time = now();
    products = products.map(function (product) {
      var pack = model.packageSummary(product), weight = Number(pack.weightG);
      if (!(weight > 0)) { skippedUnknown += 1; return product; }
      if (weight >= 500) { skippedLimit += 1; return product; }
      if ([pack.lengthMm, pack.widthMm, pack.heightMm].every(function (value) { return value != null && Number(value) > 0; })) { alreadyComplete += 1; return product; }
      var next = model.supplementDefaultDimensions(product, 100);
      if (next === product) return product;
      changed += 1; return Object.assign(next, { updatedAt: time });
    });
    if (!changed) {
      products = original;
      setMatchStatus('warning', '没有可补充的商品：500g及以上跳过 ' + skippedLimit + ' 个，重量未知跳过 ' + skippedUnknown + ' 个，已有完整尺寸 ' + alreadyComplete + ' 个。');
      return;
    }
    supplementing = true; supplementButton.disabled = true; matchButton.disabled = true; supplementButtonLabel.textContent = '正在补充…';
    setMatchStatus('loading', '正在为 ' + changed + ' 个重量低于500g的商品补充缺失尺寸为100 × 100 × 100 mm…');
    save().then(function () {
      render();
      setMatchStatus('success', '尺寸补充完成：已处理 ' + changed + ' 个；500g及以上跳过 ' + skippedLimit + ' 个，重量未知跳过 ' + skippedUnknown + ' 个，已有完整尺寸 ' + alreadyComplete + ' 个。');
    }).catch(function (error) {
      products = original; render(); setMatchStatus('error', '尺寸补充保存失败，原数据已恢复，可重试：' + error.message);
    }).finally(function () { supplementing = false; supplementButtonLabel.textContent = '补充尺寸'; render(); });
  }

  document.getElementById('createBtn').addEventListener('click', openEditor);
  supplementButton.addEventListener('click', supplementDimensions);
  document.getElementById('categoryMatchFilter').addEventListener('input', render);
  document.getElementById('collectionQuickFilters').addEventListener('click', function (event) {
    var button = event.target.closest('[data-quick-filter]'); if (!button) return;
    activeQuickFilter = button.dataset.quickFilter || 'all'; render();
  });
  document.getElementById('closeBtn').addEventListener('click', function () { editor.close(); }); document.getElementById('cancelBtn').addEventListener('click', function () { editor.close(); });
  document.getElementById('packageCloseBtn').addEventListener('click', function () { packageEditor.close(); }); document.getElementById('packageCancelBtn').addEventListener('click', function () { packageEditor.close(); });
  document.getElementById('combinationHistoryClose').addEventListener('click', function () { combinationHistoryDialog.close(); }); document.getElementById('combinationHistoryDone').addEventListener('click', function () { combinationHistoryDialog.close(); });
  document.getElementById('searchBtn').addEventListener('click', render); document.getElementById('keyword').addEventListener('keydown', function (event) { if (event.key === 'Enter') render(); });
  document.getElementById('selectAll').addEventListener('change', function () { var checked = this.checked; document.querySelectorAll('.row-check').forEach(function (node) { node.checked = checked; }); });
  body.addEventListener('click', function (event) {
    var history = event.target.closest('[data-combination-history]'); if (history) { openCombinationHistory(history.dataset.combinationHistory); return; }
    var packageEdit = event.target.closest('[data-package-edit]'); if (packageEdit) { openPackageEditor(packageEdit.dataset.packageEdit); return; }
    var manual = event.target.closest('[data-manual-category]'); if (manual) { openCategoryEditor(manual.dataset.manualCategory); return; }
    var remove = event.target.closest('.remove-btn'); if (remove) { var blocked = blockedRemovalIds([remove.dataset.id]); if (blocked.length) { alert(removalBlockedMessage(blocked.length)); return; } if (confirm('确定删除这个采集商品？')) { products = model.remove(products, [remove.dataset.id]); save().then(function () { renderSources(); render(); }).catch(function (error) { alert(error.message); }); } }
  });
  document.addEventListener('error', function (event) { if (event.target && event.target.classList && event.target.classList.contains('collect-image')) event.target.hidden = true; }, true);
  document.getElementById('deleteBtn').addEventListener('click', function () { var ids = selectedIds(); if (!ids.length) { alert('请先选择商品'); return; } var blocked = blockedRemovalIds(ids); if (blocked.length) { alert(removalBlockedMessage(blocked.length)); return; } if (confirm('确定删除选中的 ' + ids.length + ' 个商品？')) { var original = products; products = model.remove(products, ids); save().then(function () { renderSources(); render(); }).catch(function (error) { products = original; render(); alert(error.message); }); } });
  document.getElementById('clearBtn').addEventListener('click', function () { if (!products.length) return; var blocked = blockedRemovalIds(products.map(function (item) { return item.id; })); if (blocked.length) { alert('采集箱中有 ' + blocked.length + ' 个商品正在参与商品组合，无法清空；请先解除全部组合关系。'); return; } if (confirm('确定清空采集箱？此操作不可撤销。')) { var original = products; products = []; save().then(function () { renderSources(); render(); }).catch(function (error) { products = original; render(); alert(error.message); }); } });
  document.getElementById('editorForm').addEventListener('submit', function (event) {
    event.preventDefault();
    if (!quotaReady) { alert('会员采集箱额度读取失败，暂不能新增商品，请刷新后重试。'); return; }
    if (collectionQuotaFull()) { alert('采集箱会员额度已用完，请先清理不再需要的商品，或升级会员方案后再新增。'); return; }
    var time = now(), collectorIdentity = erpStorage && typeof erpStorage.getCurrentIdentity === 'function' ? erpStorage.getCurrentIdentity() : { kind: 'unknown', raw: '', masked: '当前账号' }, collectorUserId = erpStorage && typeof erpStorage.getCurrentUserId === 'function' ? String(erpStorage.getCurrentUserId() || '') : '', original = products;
    products = model.upsert(products, { id: id(), title: document.getElementById('editTitle').value, image: document.getElementById('editImage').value, sourceUrl: document.getElementById('editSourceUrl').value, price: inputRules.decimal(document.getElementById('editPrice').value), skuCount: inputRules.integer(document.getElementById('editSkuCount').value), source: document.getElementById('editSource').value, note: document.getElementById('editNote').value, status: document.getElementById('editStatus').value, collectedBy: '', collectedByUserId: collectorUserId, collectedByIdentity: collectorIdentity, collectedAt: time, createdAt: time, updatedAt: time });
    save().then(function () { editor.close(); renderSources(); render(); }).catch(function (error) { products = original; renderSources(); render(); alert(error.message || '采集商品保存失败，请重试。'); });
  });
  document.getElementById('packageForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var hint = document.getElementById('packageEditHint'), button = document.getElementById('packageSaveBtn');
    var values = { weightG: document.getElementById('packageWeight').value.trim(), length: document.getElementById('packageLength').value.trim(), width: document.getElementById('packageWidth').value.trim(), height: document.getElementById('packageHeight').value.trim() };
    var invalid = Object.keys(values).some(function (field) { return values[field] !== '' && !(Number(values[field]) > 0); });
    if (invalid) { hint.className = 'package-edit-hint is-error'; hint.textContent = '重量和长、宽、高只能填写大于0的数字；空白项保持原值。'; return; }
    var original = products, found = false;
    products = products.map(function (item) { if (item.id !== packageProductId) return item; found = true; return model.applyPackageMeasurements(item, values); });
    if (!found) { products = original; hint.className = 'package-edit-hint is-error'; hint.textContent = '商品不存在或已被移除，请关闭后刷新采集箱。'; return; }
    button.disabled = true; button.textContent = '正在保存…';
    save().then(function () { packageEditor.close(); render(); }).catch(function (error) {
      products = original; hint.className = 'package-edit-hint is-error'; hint.textContent = '重量和尺寸保存失败，原数据已保留，可重试：' + error.message;
    }).finally(function () { button.disabled = false; button.textContent = '保存重量和尺寸'; });
  });
  matchButton.addEventListener('click', matchAllCategories);
  document.getElementById('categorySearch').addEventListener('input', function () { renderCategoryOptions(this.value); });
  document.getElementById('categoryCloseBtn').addEventListener('click', function () { categoryEditor.close(); });
  document.getElementById('categoryCancelBtn').addEventListener('click', function () { categoryEditor.close(); });
  document.getElementById('categoryForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var product = products.find(function (item) { return item.id === manualProductId; }), selected = document.getElementById('ozonCategorySelect').value, parts = selected.split(':'), button = document.getElementById('categorySaveBtn');
    if (!product || !/^\d+:\d+$/.test(selected)) { document.getElementById('categoryFeedbackHint').textContent = '请先选择一个有效的Ozon三级类目。'; return; }
    button.disabled = true; button.textContent = '正在保存…';
    requestJson('/api/product-category-mappings/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item: model.categoryMatchInput(product), target: { descriptionCategoryId: parts[0], typeId: parts[1] } }) }, '类目匹配保存失败，当前选择已保留，请重试。').then(function (data) {
      products = products.map(function (item) { return item.id === manualProductId ? Object.assign(model.applyOzonMatch(item, data.match), { updatedAt: now() }) : item; });
      return save().then(function () {
        categoryEditor.close(); render();
        setMatchStatus('success', '人工类目已保存，并记录为训练样本。以后同类商品会优先自动匹配。');
      });
    }).catch(function (error) { document.getElementById('categoryFeedbackHint').textContent = '保存失败，当前选择已保留，可重试：' + error.message; }).finally(function () { button.disabled = false; button.textContent = '保存并学习'; });
  });
  document.addEventListener('erp-storage-audit-updated', function (event) { if (!event.detail || !event.detail.external || [KEY, DRAFT_KEY].indexOf(event.detail.key) < 0) return; if (event.detail.key === KEY) products = model.normalizeAll(erpStorage.get(KEY)); else drafts = model.array(erpStorage.get(DRAFT_KEY)); Promise.all(event.detail.key === KEY ? [loadCombinationGraph(), refreshCollectionQuota()] : []).then(function () { renderSources(); render(); }); });
  erpStorage.init([KEY, DRAFT_KEY]).then(function () { products = model.normalizeAll(erpStorage.get(KEY)); drafts = model.array(erpStorage.get(DRAFT_KEY)); return Promise.all([loadCombinationGraph(), refreshCollectionQuota()]); }).then(function () { renderSources(); render(); });
})();
