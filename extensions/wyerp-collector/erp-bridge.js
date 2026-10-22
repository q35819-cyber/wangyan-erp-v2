(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.WyErpCollectorBridge = api;
    api.install(root, root.chrome);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ALLOWED_ORIGINS = new Set(['http://127.0.0.1:8765', 'http://localhost:8765']);
  const KEY = 'erp_collected_products';
  function text(value, maximum) { return String(value == null ? '' : value).trim().slice(0, maximum || 1000); }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function decimal(value) {
    const raw = String(value == null ? '' : value).trim();
    return /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(raw) ? raw : null;
  }
  function number(value) { const parsed = decimal(value); return parsed === null ? null : Number(parsed); }
  function positive(value) { const parsed = Number(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
  function dimensionFactor(unit) { return /^(?:cm|厘米)$/i.test(String(unit || '')) ? 10 : /^(?:mm|毫米)$/i.test(String(unit || '')) ? 1 : null; }
  function packageMeasurements(record) {
    const sources = [...(Array.isArray(record?.packagingRows) ? record.packagingRows : []), ...(Array.isArray(record?.variants) ? record.variants : [])];
    const candidates = sources.map(item => {
      const dimensions = item?.packagingDimensions || {};
      return {
        weightG: positive(item?.packagingWeight?.grams),
        length: positive(dimensions.lengthMm),
        width: positive(dimensions.widthMm),
        height: positive(dimensions.heightMm)
      };
    });
    return candidates.find(item => item.weightG && item.length && item.width && item.height)
      || candidates.find(item => item.weightG || item.length || item.width || item.height)
      || { weightG: null, length: null, width: null, height: null };
  }
  function attributeMeasurements(record) {
    const attributes = Array.isArray(record?.attributes) ? record.attributes : [];
    const result = { weightG: null, length: null, width: null, height: null };
    const platform = String(record?.source?.platform || '');
    for (const item of attributes) {
      const name = text(item?.name, 160);
      const value = text(item?.value, 500).replace(/[（）()]/g, ' ');
      if (!name || !value) continue;
      if (!result.weightG && /(?:^|包装|包裹)(?:重量|毛重|净重|克重)$|^(?:重量|毛重|净重|克重)$/i.test(name)) {
        const match = value.match(/(\d+(?:\.\d+)?)\s*(kg|g|千克|公斤|克)\b/i) || value.match(/(\d+(?:\.\d+)?)\s*(千克|公斤|克)/i);
        if (match) {
          const amount = Number(match[1]);
          if (Number.isFinite(amount) && amount > 0) result.weightG = /^(?:kg|千克|公斤)$/i.test(match[2]) ? amount * 1000 : amount;
        }
      }
      if (!(result.length && result.width && result.height) && /(?:尺寸|长宽高|包装规格|包装大小)/i.test(name)) {
        const match = value.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)?/i);
        if (match) {
          const unit = match[4] || ((name + ' ' + value).match(/(?:^|[^a-z])(mm|cm)(?:[^a-z]|$)|毫米|厘米/i)?.[1]) || (platform === '1688' ? 'cm' : '');
          const factor = dimensionFactor(unit);
          if (factor) {
            result.length = positive(Number(match[1]) * factor);
            result.width = positive(Number(match[2]) * factor);
            result.height = positive(Number(match[3]) * factor);
          }
        }
      }
    }
    const scalar = [
      ['length', /^(?:包装|包裹)?(?:长|长度)$/i],
      ['width', /^(?:包装|包裹)?(?:宽|宽度)$/i],
      ['height', /^(?:包装|包裹)?(?:高|高度)$/i]
    ];
    for (const [field, pattern] of scalar) {
      if (result[field]) continue;
      const item = attributes.find(attribute => pattern.test(text(attribute?.name, 160)));
      if (!item) continue;
      const raw = text(item.value, 200).replace(/[（）()]/g, ' ');
      const match = raw.match(/(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)?/i);
      if (!match) continue;
      const factor = dimensionFactor(match[2] || (platform === '1688' ? 'cm' : ''));
      if (factor) result[field] = positive(Number(match[1]) * factor);
    }
    return result;
  }
  function sourceMeasurements(record) {
    const packaged = packageMeasurements(record), attributed = attributeMeasurements(record);
    return {
      weightG: packaged.weightG || attributed.weightG || null,
      length: packaged.length || attributed.length || null,
      width: packaged.width || attributed.width || null,
      height: packaged.height || attributed.height || null
    };
  }
  function tenantId(value) { const raw = String(value == null ? '' : value).trim(); return /^[1-9]\d{0,19}$/.test(raw) ? raw : ''; }
  function dataUrl(origin, selectedTenantId) {
    const selected = tenantId(selectedTenantId);
    return origin + '/api/data/' + KEY + (selected ? '?tenantId=' + encodeURIComponent(selected) : '');
  }
  function collectionCommandUrl(origin, selectedTenantId) {
    const selected = tenantId(selectedTenantId);
    return origin + '/api/domain/commands/collection-source' + (selected ? '?tenantId=' + encodeURIComponent(selected) : '');
  }
  function categoryUrl(origin, selectedTenantId) {
    const selected = tenantId(selectedTenantId);
    return origin + '/api/source-categories/match' + (selected ? '?tenantId=' + encodeURIComponent(selected) : '');
  }
  function ozonCommandUrl(origin, selectedTenantId) {
    const selected = tenantId(selectedTenantId);
    return origin + '/api/integrations/ozon/commands' + (selected ? '?tenantId=' + encodeURIComponent(selected) : '');
  }
  function seerfarProductUrl(origin, selectedTenantId) {
    const selected = tenantId(selectedTenantId);
    return origin + '/api/integrations/seerfar/ozon/product' + (selected ? '?tenantId=' + encodeURIComponent(selected) : '');
  }
  function codedError(message, code) { const error = new Error(message); error.code = code; return error; }
  function refreshCollectionView(scope) {
    const origin = String(scope?.location?.origin || '');
    if (!ALLOWED_ORIGINS.has(origin)) return 0;
    const isCollection = value => {
      try { const url = new URL(String(value || ''), origin); return url.origin === origin && url.pathname === '/pages/goods.html'; }
      catch (_) { return false; }
    };
    if (isCollection(scope.location?.href)) {
      try { scope.location.reload(); return 1; } catch (_) { return 0; }
    }
    let refreshed = 0;
    for (const frame of Array.from(scope.document?.querySelectorAll?.('iframe[src]') || [])) {
      if (!isCollection(frame.src || frame.getAttribute?.('src'))) continue;
      try { frame.contentWindow.location.reload(); refreshed += 1; } catch (_) { /* unavailable frame */ }
    }
    return refreshed;
  }
  function localTime(date) {
    const pad = value => String(value).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }
  function preferredPrice(record) {
    const variants = Array.isArray(record?.variants) ? record.variants : [];
    const prices = Array.isArray(record?.prices) ? record.prices : [];
    const candidates = [];
    if (record?.source?.platform === '1688') prices.filter(item => decimal(item?.min) !== null).forEach(item => candidates.push(item));
    if (record?.source?.platform === '1688') prices.filter(item => item?.kind === 'minimum_order_unit' || item?.kind === 'minimum_order_quantity').forEach(item => candidates.push(item));
    if (record?.source?.platform === '1688') variants.forEach(item => candidates.push(item?.price));
    const preferredKinds = record?.source?.platform === 'ozon'
      ? ['structured_offer', 'display', 'sku'] : ['sku', 'display', 'tier'];
    preferredKinds.forEach(kind => prices.filter(item => item?.kind === kind).forEach(item => candidates.push(item)));
    prices.filter(item => !/original|bank|card/i.test(String(item?.kind || ''))).forEach(item => candidates.push(item));
    for (const candidate of candidates) {
      const value = decimal(candidate?.amount) || decimal(candidate?.min);
      if (value !== null) return Number(value);
    }
    return null;
  }
  function mainImage(record) {
    const media = Array.isArray(record?.media) ? record.media : [];
    const variants = Array.isArray(record?.variants) ? record.variants : [];
    if (record?.source?.platform === '1688') {
      return text(record?.primarySkuImage?.url || variants.find(item => item?.imageUrl)?.imageUrl || media.find(item => item?.kind === 'image' && item?.role === 'variant')?.url || media.find(item => item?.kind === 'image' && item?.role === 'main')?.url || media.find(item => item?.kind === 'image')?.url, 2000);
    }
    return text(media.find(item => item?.kind === 'image' && item?.role === 'main')?.url || media.find(item => item?.kind === 'image')?.url || variants.find(item => item?.imageUrl)?.imageUrl, 2000);
  }
  function capturedSkuCount(record) {
    const packagingRows = Array.isArray(record?.packagingRows) ? record.packagingRows : [];
    const packagingLabels = [...new Set(packagingRows.map(item => text(item?.label, 500)).filter(Boolean))];
    if (packagingLabels.length) return packagingLabels.length;
    return Array.isArray(record?.variants) ? record.variants.length : null;
  }
  function shippingSummary(record) {
    const shipping = record?.shipping || {};
    const minimum = Number(record?.purchaseConditions?.minimumQuantity);
    const minimumUnit = /^(?:个|件|套|包|盒|枚|条|组|份|支|台|只|对|张)$/.test(String(record?.purchaseConditions?.minimumUnit || '')) ? String(record.purchaseConditions.minimumUnit) : '件';
    const quantity = Number.isInteger(Number(shipping.quantity)) && Number(shipping.quantity) > 0
      ? Number(shipping.quantity) : Number.isInteger(minimum) && minimum > 0 ? minimum : 1;
    const amount = number(shipping.amount);
    let raw = text(shipping.rawText, 500);
    if (!raw && amount !== null) raw = '¥' + amount;
    if (!raw && record?.source?.platform === '1688' && Number.isInteger(minimum) && minimum > 0) raw = '运费未知（按' + minimum + minimumUnit + '起批）';
    if (raw && record?.source?.platform === '1688' && !new RegExp('按\\s*' + quantity + '\\s*' + minimumUnit).test(raw)) raw += '（按' + quantity + minimumUnit + '起批）';
    return { text: raw, amount, quantity, unit: minimumUnit, starting: Boolean(shipping.isStartingPrice || /起/.test(shipping.rawText || '')) };
  }
  function toCollectionRecord(record, previous, now) {
    const sourcePlatform = text(record?.source?.platform, 64).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!record || record.schemaVersion !== 1 || !sourcePlatform || !text(record?.source?.productId, 120)) throw new Error('采集数据格式无效。');
    const platform = sourcePlatform;
    const productId = text(record.source.productId, 120);
    const old = previous && typeof previous === 'object' ? previous : {};
    const shipping = shippingSummary(record);
    const minimum = Number(record?.purchaseConditions?.minimumQuantity);
    const categoryMatch = record?.categoryMatch && typeof record.categoryMatch === 'object' ? record.categoryMatch : null;
    const category = categoryMatch?.category && typeof categoryMatch.category === 'object' ? categoryMatch.category : null;
    const measurements = sourceMeasurements(record);
    const categoryPath = Array.isArray(category?.path) ? category.path.map(item => text(item, 120)).filter(Boolean).slice(0, 8)
      : Array.isArray(record?.categoryPath) ? record.categoryPath.map(item => text(item, 120)).filter(Boolean).slice(0, 8) : [];
    return {
      ...old,
      id: 'collector:' + platform + ':' + productId,
      title: text(record.title, 500) || '未命名商品',
      image: mainImage(record),
      sourceUrl: text(record?.source?.url, 2000),
      price: preferredPrice(record),
      skuCount: capturedSkuCount(record),
      source: platform === '1688' ? '1688' : platform === 'ozon' ? 'Ozon' : platform,
      note: text(old.note, 300),
      status: text(old.status, 40) || '未上架',
      minimumQuantity: Number.isInteger(minimum) && minimum > 0 ? minimum : null,
      minimumUnit: shipping.unit,
      shippingText: shipping.text,
      shippingAmount: shipping.amount,
      shippingQuantity: shipping.quantity,
      shippingIsStartingPrice: shipping.starting,
      weightG: positive(old.weightG) || measurements.weightG || null,
      length: positive(old.length) || measurements.length || null,
      width: positive(old.width) || measurements.width || null,
      height: positive(old.height) || measurements.height || null,
      categoryName: categoryPath.join(' / '),
      categoryId: text(category?.id, 40),
      categoryPath,
      categoryMatchStatus: text(categoryMatch?.status, 40),
      categoryMatchConfidence: number(categoryMatch?.confidence),
      categoryMatchMethod: text(categoryMatch?.method, 80),
      captureSchemaVersion: record.schemaVersion,
      captureAdapterVersion: text(record.adapterVersion, 40),
      capture: clone(record),
      createdAt: text(old.createdAt, 40) || now,
      updatedAt: now
    };
  }
  async function responseJson(response) { try { return await response.json(); } catch (_) { return {}; } }
  async function timedFetch(options, url, init, timeoutMs, stage) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try { return await options.fetch(url, { ...(init || {}), ...(controller ? { signal: controller.signal } : {}) }); }
    catch (error) {
      if (error?.name === 'AbortError') throw codedError(stage + '在' + Math.round(timeoutMs / 1000) + '秒内未返回。', stage + '_timeout');
      throw codedError(stage + '请求失败。', stage + '_network_failed');
    } finally { if (timer) clearTimeout(timer); }
  }
  async function authorizeOzon(options, candidate) {
    if (!ALLOWED_ORIGINS.has(String(options?.origin || '')) || typeof options?.fetch !== 'function') throw codedError('只能通过本机网研ERP读取Ozon官方数据。', 'erp_origin_invalid');
    const authResponse = await timedFetch(options, options.origin + '/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } }, 5000, '网研ERP登录检查');
    if (authResponse.status === 401) throw codedError('请先登录网研ERP，再读取Ozon官方店铺数据。', 'erp_login_required');
    if (!authResponse.ok) throw codedError('无法确认网研ERP登录状态。', 'erp_auth_failed');
    const account = await responseJson(authResponse); const csrfToken = text(account.csrfToken, 500);
    if (!csrfToken) throw codedError('网研ERP没有返回读取凭据，请重新登录。', 'erp_csrf_missing');
    const shopsUrl = dataUrl(options.origin, options.selectedTenantId).replace('/' + KEY, '/erp_shops_data');
    const shopsResponse = await timedFetch(options, shopsUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } }, 5000, '网研ERP店铺检查');
    const shops = shopsResponse.ok ? await responseJson(shopsResponse) : [];
    const shop = Array.isArray(shops) ? shops.find(item => String(item?.clientId || item?.externalShopId || '') === candidate) : null;
    if (!shop || !shop.credentialsConfigured) throw codedError('绑定的Ozon店铺未在当前ERP租户配置官方API凭据。', 'ozon_shop_credentials_required');
    return { csrfToken, shop };
  }
  async function authorizeErpRead(options) {
    if (!ALLOWED_ORIGINS.has(String(options?.origin || '')) || typeof options?.fetch !== 'function') throw codedError('只能通过本机网研ERP读取Seerfar数据。', 'erp_origin_invalid');
    const response = await timedFetch(options, options.origin + '/api/auth/me', { credentials: 'include', headers: { Accept: 'application/json' } }, 5000, '网研ERP登录检查');
    if (response.status === 401) throw codedError('请先登录ERP', 'erp_login_required');
    if (!response.ok) throw codedError('无法确认网研ERP登录状态。', 'erp_auth_failed');
    const account = await responseJson(response);
    const csrfToken = text(account.csrfToken, 500);
    if (!csrfToken) throw codedError('网研ERP没有返回读取凭据，请重新登录。', 'erp_csrf_missing');
    return csrfToken;
  }
  async function listConfiguredOzonShops(options) {
    if (!ALLOWED_ORIGINS.has(String(options?.origin || '')) || typeof options?.fetch !== 'function') throw codedError('只能通过本机网研ERP读取店铺列表。', 'erp_origin_invalid');
    const authResponse = await timedFetch(options, options.origin + '/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } }, 5000, '网研ERP登录检查');
    if (authResponse.status === 401) throw codedError('请先打开并登录网研ERP，再选择店铺。', 'erp_login_required');
    if (!authResponse.ok) throw codedError('无法确认网研ERP登录状态。', 'erp_auth_failed');
    const shopsUrl = dataUrl(options.origin, options.selectedTenantId).replace('/' + KEY, '/erp_shops_data');
    const shopsResponse = await timedFetch(options, shopsUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } }, 5000, '网研ERP店铺列表');
    if (!shopsResponse.ok) throw codedError('网研ERP店铺列表读取失败。', 'erp_shop_list_failed');
    const payload = await responseJson(shopsResponse);
    return (Array.isArray(payload) ? payload : []).map(item => {
      const clientId = text(item?.clientId || item?.externalShopId, 20);
      const name = text(item?.name || item?.shopName || item?.storeName || item?.label, 120);
      return { clientId, name: name || ('Ozon店铺 ' + clientId.slice(-4)), credentialsConfigured: item?.credentialsConfigured === true };
    }).filter(item => /^[1-9]\d{2,19}$/.test(item.clientId) && item.credentialsConfigured).slice(0, 100);
  }
  function categoryRequest(record) {
    const evidence = record?.categoryEvidence && typeof record.categoryEvidence === 'object' ? record.categoryEvidence : {};
    const ids = (Array.isArray(evidence.pageCategoryIds) ? evidence.pageCategoryIds : []).map(item => text(item && typeof item === 'object' ? item.id : item, 40)).filter(item => /^\d{1,20}$/.test(item)).slice(0, 20);
    const path = (Array.isArray(evidence.pagePath) && evidence.pagePath.length ? evidence.pagePath : record?.categoryPath || []).map(item => text(item && typeof item === 'object' ? item.name || item.title || item.label : item, 120)).filter(Boolean).slice(0, 8);
    const signals = (Array.isArray(evidence.signals) ? evidence.signals : []).slice(0, 20).map(item => ({ kind: text(item?.kind, 40), value: text(item?.value, 120), evidence: text(item?.evidence, 120) })).filter(item => item.kind && item.value);
    const attributes = (Array.isArray(record?.attributes) ? record.attributes : []).slice(0, 100).map(item => ({ name: text(item?.name, 120), value: text(item?.value, 500) })).filter(item => item.name && item.value);
    return { platform: '1688', title: text(record?.title, 600), pagePath: path, categoryIds: ids, signals, attributes };
  }
  async function enrichCategory(record, options) {
    const next = clone(record);
    if (next?.source?.platform !== '1688') return next;
    const unavailable = reason => {
      next.categoryMatch = { status: 'unavailable', method: 'server_catalog_unavailable', confidence: 0, category: null, alternatives: [], requiresReview: true, error: text(reason, 120) };
      next.warnings = Array.isArray(next.warnings) ? next.warnings.slice() : [];
      next.warnings.push('1688类目目录暂不可用，商品已保存但类目待核对');
      return next;
    };
    let response;
    try {
      response = await timedFetch(options, categoryUrl(options.origin, options.selectedTenantId), {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken },
        body: JSON.stringify(categoryRequest(next))
      }, 5000, '网研ERP类目匹配');
    } catch (_) { return unavailable('category_match_request_failed'); }
    const payload = await responseJson(response);
    if (response.status === 401) throw codedError('网研ERP登录已失效，请重新登录。', 'erp_login_required');
    if (response.ok && ['matched', 'needs_review', 'unmatched'].includes(payload?.status)) {
      next.categoryMatch = payload;
      if (Array.isArray(payload?.category?.path) && payload.category.path.length) next.categoryPath = payload.category.path.map(item => text(item, 120)).filter(Boolean).slice(0, 8);
      if (payload.status === 'needs_review') {
        next.warnings = Array.isArray(next.warnings) ? next.warnings.slice() : [];
        next.warnings.push('1688类目仅按标题、属性或店铺主营生成候选，发布前必须人工核对');
      }
      return next;
    }
    return unavailable(payload?.error || ('HTTP ' + response.status));
  }
  const OZON_ANALYTICS_METRICS = [
    'revenue', 'ordered_units', 'hits_view_search', 'hits_view_pdp', 'hits_view',
    'hits_tocart_search', 'hits_tocart_pdp', 'hits_tocart', 'session_view_search', 'session_view_pdp',
    'conv_tocart_search', 'conv_tocart_pdp', 'returns', 'cancellations'
  ];
  const OZON_BASIC_ANALYTICS_METRICS = ['ordered_units', 'revenue'];
  function isoDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error('invalid_date');
    return date.toISOString().slice(0, 10);
  }
  function thirtyDayRange(value) {
    const end = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(end.getTime())) throw new Error('invalid_date');
    const start = new Date(end.getTime()); start.setUTCDate(start.getUTCDate() - 29);
    return { dateFrom: isoDate(start), dateTo: isoDate(end) };
  }
  async function ozonCommand(options, clientId, command, body) {
    let response; const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
    try {
      response = await options.fetch(ozonCommandUrl(options.origin, options.selectedTenantId), {
        method: 'POST', credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken },
        body: JSON.stringify({ clientId, command, body }), ...(controller ? { signal: controller.signal } : {})
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw codedError('Ozon官方接口12秒内未返回。', 'ozon_timeout');
      throw codedError('Ozon官方接口网络请求失败。', 'ozon_network_failed');
    } finally { if (timer) clearTimeout(timer); }
    const payload = await responseJson(response);
    if (!response.ok) {
      const error = codedError(text(payload?.error || payload?.message || ('HTTP ' + response.status), 120), 'ozon_' + command.replace(/[^a-z0-9]+/gi, '_').toLowerCase());
      error.status = response.status; throw error;
    }
    return payload;
  }
  function present(value) { return value !== null && value !== undefined && !(typeof value === 'string' && !value.trim()); }
  function numberValue(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : null; }
  function objectValue(value, keys) {
    if (!value || typeof value !== 'object') return null;
    for (const key of keys) if (present(value[key])) return value[key];
    return null;
  }
  function metric(key, label, raw, unit, capturedAt, period) {
    if (!present(raw)) return null;
    return { key, label, raw, unit: unit || '', source: 'seerfar_ozon_market', trust: 'licensed_market_data', capturedAt, period };
  }
  function categoryText(value) {
    if (typeof value === 'string') return value.trim();
    if (Array.isArray(value)) return value.map(categoryText).filter(Boolean).join(' / ');
    return text(objectValue(value, ['cnTitlePath', 'titlePath', 'enTitlePath', 'name', 'title', 'categoryName', 'pathName']) || objectValue(value?.category, ['cnTitle', 'title', 'enTitle']), 300);
  }
  function dimensionText(value) {
    if (typeof value === 'string') return value.trim();
    if (!value || typeof value !== 'object') return '';
    const length = objectValue(value, ['length', 'lengthMm', 'lengthCm']);
    const width = objectValue(value, ['width', 'widthMm', 'widthCm']);
    const height = objectValue(value, ['height', 'heightMm', 'heightCm']);
    return [length, width, height].every(present) ? [length, width, height].join(' x ') : '';
  }
  function trendMetrics(data) {
    const rows = (Array.isArray(data?.salesTrendVOList) ? data.salesTrendVOList : []).map(item => ({
      date: text(present(item?.date) ? item.date : item?.day, 20),
      sales: numberValue(present(item?.sales) ? item.sales : present(item?.saleCount) ? item.saleCount : item?.orders),
      revenue: numberValue(present(item?.revenue) ? item.revenue : item?.salesAmount)
    })).filter(item => item.date).sort((a, b) => a.date.localeCompare(b.date));
    const current = rows.slice(-30); const previous = rows.slice(-60, -30);
    const sum = (items, key) => items.reduce((total, item) => total + (item[key] == null ? 0 : item[key]), 0);
    const currentSales = current.some(item => item.sales != null) ? sum(current, 'sales') : numberValue(data?.totalSales);
    const currentRevenue = current.some(item => item.revenue != null) ? sum(current, 'revenue') : numberValue(data?.totalRevenue);
    const previousRevenue = previous.length >= 20 && previous.some(item => item.revenue != null) ? sum(previous, 'revenue') : null;
    const turnover = previousRevenue > 0 && currentRevenue != null ? Math.round(((currentRevenue - previousRevenue) / previousRevenue) * 10000) / 100 : null;
    return { currentSales, currentRevenue, turnover };
  }
  function listedAt(product, now) {
    const raw = text(product?.upTime || product?.listedAt || product?.createTime, 40);
    const source = product?.upTime || product?.listedAt || product?.createTime;
    const parsed = typeof source === 'number' ? new Date(source).getTime() : Date.parse(raw);
    const days = Number.isFinite(parsed) ? Math.max(0, Math.floor((now.getTime() - parsed) / 86400000)) : numberValue(product?.upDays);
    if (!raw && days == null) return null;
    const dateText = Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : raw.slice(0, 10);
    return dateText + (days == null ? '' : '(' + days + '天)');
  }
  function sellerTypeText(value) {
    const normalized = text(value, 40).trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === '0') return '本土卖家';
    if (normalized === '1') return '跨境卖家';
    if (/本土|本地|local/.test(normalized)) return '本土卖家';
    if (/跨境|cross.?border/.test(normalized)) return '跨境卖家';
    return null;
  }
  function applySeerfar(record, payload, now) {
    const next = clone(record); const data = payload?.data || {}; const product = data.product || {};
    const capturedAt = text(payload?.fetchedAt, 40) || now.toISOString();
    const period = { label: '最近30天', start: text(data.startDate, 20), end: text(data.endDate, 20) };
    const trend = trendMetrics(data);
    const commissions = Array.isArray(product.commissions) && product.commissions.length
      ? product.commissions
      : objectValue(product.categoryInfo, ['rfbsCommission', 'rfbsRate', 'commissions']);
    const commissionText = Array.isArray(commissions) ? commissions.map(item => present(item?.rate) ? item.rate : item).filter(present).join(' / ') : commissions;
    const commissionTitle = Array.isArray(commissions) ? commissions.map(item => item?.title).filter(present).join('；') : '';
    const commissionMetric = metric('commission', '类目佣金', commissionText, '', capturedAt, period);
    if (commissionMetric && commissionTitle) commissionMetric.title = commissionTitle;
    const variantCount = Array.isArray(product.variants) ? product.variants.length : numberValue(product.variants);
    const volumeValue = ['string', 'number', 'boolean'].includes(typeof product.volume) ? product.volume : null;
    const metrics = [
      metric('productTitle', '商品名称', product.title, '', capturedAt, period),
      metric('category', '类目', categoryText(product.categoryInfo), '', capturedAt, period),
      commissionMetric,
      metric('brand', '品牌', product.brandName || objectValue(product.brand, ['name', 'title']) || product.brand || '无品牌', '', capturedAt, period),
      metric('sellerType', '卖家类型', sellerTypeText(product.sellerType), '', capturedAt, period),
      metric('reviewCount', '评论数', product.reviewCount ?? product.reviews, '条', capturedAt, period),
      metric('reviewRating', '商品评分', product.reviewRating, '', capturedAt, period),
      metric('questionCount', '问题数', product.questionsAndAnswers, '条', capturedAt, period),
      metric('dailySales', '日销量', data.dailySales, '件', capturedAt, period),
      metric('monthlyUnits', '月销量', trend.currentSales, '件', capturedAt, period),
      metric('monthlyRevenue', '月销售额', trend.currentRevenue, '₽', capturedAt, period),
      metric('stock', '库存', data.stock, '件', capturedAt, period),
      metric('marketPrice', '商品价格', product.price == null || product.price === ''
        ? product.price
        : typeof product.price === 'string' && /(?:₽|RUB)/i.test(product.price)
          ? product.price
          : String(product.price) + ' ₽', '', capturedAt, period),
      metric('grossMargin', '毛利率', product.grossMargin, '%', capturedAt, period),
      metric('turnover', '月周转动态', trend.turnover, '%', capturedAt, period),
      metric('advertising', '广告费占比', product.drr, '%', capturedAt, period),
      metric('promotionDays', '参与促销天数', product.promotionDays ?? product.promoDays ?? data.promotionDays, '天', capturedAt, period),
      metric('promotionDiscount', '参与促销的折扣', product.discount, '%', capturedAt, period),
      metric('promotionConversion', '促销活动的转化率', product.promoRevenueShare, '%', capturedAt, period),
      metric('paidPromotionDays', '付费推广天数', product.paidPromotionDays ?? product.paidDays ?? data.paidPromotionDays, '天', capturedAt, period),
      metric('cardViews', '商品卡浏览量', product.sessionCount, '', capturedAt, period),
      metric('cardCartRate', '商品卡加购率', product.convToCartPdp, '%', capturedAt, period),
      metric('searchViews', '搜索目录浏览量', product.sessionCountSearch, '', capturedAt, period),
      metric('searchCartRate', '搜索目录加购率', product.convToCartSearch, '%', capturedAt, period),
      metric('impressionConversion', '展示转化率', product.convViewToOrder, '%', capturedAt, period),
      metric('productClickRate', '商品点击率', product.productClickRate ?? product.clickRate ?? data.productClickRate, '%', capturedAt, period),
      metric('orderConversionRate', '下单转化率', product.orderConversionRate, '%', capturedAt, period),
      metric('fulfillment', '发货模式', Array.isArray(product.fulfillment) ? product.fulfillment.join(',') : product.fulfillment, '', capturedAt, period),
      metric('returnRate', '退货取消率', product.returnCancellationRate, '%', capturedAt, period),
      metric('dimensions', '长 宽 高', dimensionText(product.dimension), 'mm', capturedAt, period),
      metric('weight', '重量', product.weight, 'g', capturedAt, period),
      metric('listedAt', '上架时间', listedAt(product, now), '', capturedAt, period),
      metric('upDays', '上架天数', product.upDays, '天', capturedAt, period),
      metric('upMonths', '上架月数', product.upMonths, '个月', capturedAt, period),
      metric('variantCount', '变体数量', variantCount, '个', capturedAt, period),
      metric('volume', '体积', volumeValue, '', capturedAt, period)
    ].filter(Boolean);
    const mergedMetrics = new Map((Array.isArray(next.analytics?.metrics) ? next.analytics.metrics : []).map(item => [item?.key, item]).filter(item => item[0]));
    metrics.forEach(item => mergedMetrics.set(item.key, item));
    const seerfarSource = { id: 'seerfar_ozon_market', endpoint: '/api/integrations/seerfar/ozon/product', trust: 'licensed_market_data', capturedAt };
    const mergedSources = new Map((Array.isArray(next.analytics?.sources) ? next.analytics.sources : []).map(item => [item?.id, item]).filter(item => item[0]));
    mergedSources.set(seerfarSource.id, seerfarSource);
    const mergedWarnings = [
      ...(Array.isArray(next.analytics?.warnings) ? next.analytics.warnings : []),
      ...(Array.isArray(payload?.warnings) ? payload.warnings : [])
    ].map(item => text(item, 180)).filter(Boolean);
    next.analytics = {
      status: mergedMetrics.size >= 10 ? 'available' : 'partial',
      metrics: Array.from(mergedMetrics.values()),
      sources: Array.from(mergedSources.values()),
      warnings: Array.from(new Set(mergedWarnings)),
      cache: clone(payload?.cache)
    };
    return next;
  }
  async function enrichOzon(record, options) {
    const next = clone(record);
    if (next?.source?.platform !== 'ozon') return next;
    const csrfToken = await authorizeErpRead(options);
    const response = await timedFetch(options, seerfarProductUrl(options.origin, options.selectedTenantId), {
      method: 'POST', credentials: 'include',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ sku: String(next.source.productId), dateRange: 'past_60_days', forceRefresh: options.forceRefresh === true })
    }, 25000, 'Seerfar商品数据');
    const payload = await responseJson(response);
    if (!response.ok) throw codedError(text(payload?.message || 'Seerfar数据读取失败。', 180), text(payload?.error || 'seerfar_request_failed', 80));
    return applySeerfar(next, payload, options.now ? options.now() : new Date());
  }

  function analyticsRange(input, nowValue) {
    const dateFrom = text(input?.dateFrom, 10); const dateTo = text(input?.dateTo, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) throw codedError('统计日期格式无效。', 'analytics_range_invalid');
    const start = Date.parse(dateFrom + 'T00:00:00Z'); const end = Date.parse(dateTo + 'T00:00:00Z');
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const map = Object.fromEntries(parts.map(item => [item.type, item.value]));
    const today = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day));
    const days = Math.floor((end - start) / 86400000) + 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || days < 1 || days > 90 || end > today) throw codedError('免费基础分析仅允许读取截至今天的1至90天。', 'analytics_range_invalid');
    return { dateFrom, dateTo, days };
  }

  function metricText(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(Math.round(value * 10000) / 10000);
    const raw = String(value == null ? '' : value).trim();
    return /^-?\d+(?:\.\d+)?$/.test(raw) ? raw : '0';
  }

  function storeAnalyticsResult(payload, context) {
    const result = payload?.result && typeof payload.result === 'object' ? payload.result : {};
    const rows = (Array.isArray(result.data) ? result.data : []).slice(0, 1000).map(item => {
      const dimension = Array.isArray(item?.dimensions) ? item.dimensions[0] : null;
      const values = Array.isArray(item?.metrics) ? item.metrics : [];
      return {
        sku: text(dimension?.id || dimension?.value || dimension?.key, 80),
        name: text(dimension?.name || dimension?.title, 300),
        orderedUnits: metricText(values[0]),
        revenue: metricText(values[1])
      };
    }).filter(item => item.sku || item.name);
    rows.sort((a, b) => Number(b.orderedUnits) - Number(a.orderedUnits) || Number(b.revenue) - Number(a.revenue));
    const totals = Array.isArray(result.totals) ? result.totals : [];
    return {
      schemaVersion: 1,
      kind: 'ozon_basic_analytics',
      storeId: context.storeId,
      range: { dateFrom: context.range.dateFrom, dateTo: context.range.dateTo, days: context.range.days },
      metrics: OZON_BASIC_ANALYTICS_METRICS.slice(),
      totals: { orderedUnits: metricText(totals[0]), revenue: metricText(totals[1]) },
      rows,
      limited: rows.length >= 1000,
      source: { id: 'ozon_official_seller_api', endpoint: '/v1/analytics/data', trust: 'official_authorized_store' },
      capturedAt: context.capturedAt,
      diagnostics: [{ command: 'analytics.getData', status: 'ok', elapsedMs: context.elapsedMs }],
      warnings: ['只读取普通卖家可用的ordered_units和revenue；Premium专属指标未请求。']
    };
  }

  async function readStoreAnalytics(query, options) {
    const candidate = text(query?.storeId, 120);
    if (!/^[1-9]\d{2,19}$/.test(candidate)) throw codedError('尚未绑定有效的Ozon卖家店铺。', 'ozon_store_unbound');
    const now = options.now ? options.now() : new Date(); const range = analyticsRange(query, now);
    const { csrfToken } = await authorizeOzon(options, candidate);
    const commandOptions = { ...options, csrfToken }; const started = Date.now();
    try {
      const payload = await ozonCommand(commandOptions, candidate, 'analytics.getData', {
        date_from: range.dateFrom, date_to: range.dateTo, dimension: ['sku'], metrics: OZON_BASIC_ANALYTICS_METRICS,
        filters: [], sort: [{ key: 'ordered_units', order: 'DESC' }], limit: 1000, offset: 0
      });
      return storeAnalyticsResult(payload, { storeId: candidate, range, capturedAt: now.toISOString(), elapsedMs: Date.now() - started });
    } catch (error) {
      error.diagnostic = { command: 'analytics.getData', status: 'error', elapsedMs: Date.now() - started, code: text(error?.code || 'request_failed', 100), httpStatus: Number(error?.status) || null };
      throw error;
    }
  }
  async function save(record, environment) {
    const origin = String(environment?.origin || '');
    const fetcher = environment?.fetch;
    if (!ALLOWED_ORIGINS.has(origin) || typeof fetcher !== 'function') throw new Error('只能写入本机网研ERP采集箱。');
    const selectedTenantId = tenantId(environment?.selectedTenantId);
    const authResponse = await timedFetch(environment, origin + '/api/auth/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } }, 5000, '网研ERP登录检查');
    if (authResponse.status === 401) throw codedError('请先登录网研ERP，再重新采集。', 'erp_login_required');
    if (!authResponse.ok) throw codedError('无法确认网研ERP登录状态。', 'erp_auth_failed');
    const account = await responseJson(authResponse);
    const csrfToken = text(account.csrfToken, 500);
    if (!csrfToken) throw new Error('网研ERP没有返回保存凭据，请重新登录。');
    record = await enrichCategory(record, { origin, selectedTenantId, csrfToken, fetch: fetcher });
    const written = await timedFetch(environment, collectionCommandUrl(origin, selectedTenantId), {
      method: 'POST', credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ action: 'upsert', payload: record })
    }, 8000, '网研ERP采集箱保存');
    if (written.status === 401) throw codedError('网研ERP登录已失效，请重新登录。', 'erp_login_required');
    if (written.status === 403) throw new Error('采集箱保存被拒绝，请检查账号权限。');
    if (!written.ok) { const failure = await responseJson(written); throw new Error(text(failure.message || failure.error || ('采集箱保存失败：HTTP ' + written.status), 240)); }
    const saved = await responseJson(written);
    if (typeof environment?.notifyChange === 'function') environment.notifyChange({ key: KEY, tenantId: selectedTenantId });
    const item = saved && saved.item || {};
    return { ok: true, id: saved.id || item.id, title: item.title || record.title, created: Boolean(saved.created), version: Number(saved.version), tenantId: selectedTenantId, categoryStatus: item.categoryMatchStatus, categoryName: item.categoryName };
  }
  function install(scope, extension) {
    if (!scope || !extension?.runtime?.onMessage) return;
    const previous = scope.__WYERP_COLLECTOR_ERP_BRIDGE_LISTENER__;
    if (typeof previous === 'function') try { extension.runtime.onMessage.removeListener?.(previous); } catch (_) { /* prior extension context already invalid */ }
    const listener = (message, sender, sendResponse) => {
      if (!['save-capture-to-erp', 'enrich-ozon-record-from-erp'].includes(message?.type) || sender?.id !== extension.runtime.id) return false;
      let selectedTenantId = '';
      try { selectedTenantId = tenantId(scope.sessionStorage?.getItem('erp_system_tenant_id')); } catch (_) { /* unavailable storage */ }
      const notifyChange = detail => {
        if (typeof scope.BroadcastChannel !== 'function') return;
        let channel;
        try {
          channel = new scope.BroadcastChannel('wyerp-storage-updates');
          channel.postMessage({ source: 'wyerp-collector-bridge-' + Date.now(), key: detail.key, tenant: detail.tenantId });
        } finally { try { channel?.close(); } catch (_) { /* already closed */ } }
      };
      const action = message.type === 'enrich-ozon-record-from-erp'
        ? enrichOzon(message.record, { origin: scope.location.origin, fetch: scope.fetch.bind(scope), selectedTenantId, analytics: scope.WyAnalytics, now: () => new Date() }).then(record => ({ ok: true, record }))
        : save(message.record, { origin: scope.location.origin, fetch: scope.fetch.bind(scope), selectedTenantId, notifyChange });
      action
        .then(result => {
          sendResponse(result);
          if (result?.ok && typeof scope.setTimeout === 'function') scope.setTimeout(() => refreshCollectionView(scope), 100);
        })
        .catch(error => sendResponse({ ok: false, code: text(error?.code, 80), message: text(error?.message || '采集箱保存失败。', 200) }));
      return true;
    };
    scope.__WYERP_COLLECTOR_ERP_BRIDGE_LISTENER__ = listener;
    extension.runtime.onMessage.addListener(listener);
  }
  return { ALLOWED_ORIGINS, OZON_ANALYTICS_METRICS, OZON_BASIC_ANALYTICS_METRICS, preferredPrice, capturedSkuCount, shippingSummary, toCollectionRecord, dataUrl, collectionCommandUrl, categoryUrl, ozonCommandUrl, seerfarProductUrl, categoryRequest, enrichCategory, thirtyDayRange, ozonCommand, applySeerfar, enrichOzon, listConfiguredOzonShops, analyticsRange, storeAnalyticsResult, readStoreAnalytics, refreshCollectionView, save, install };
});
