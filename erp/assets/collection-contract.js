(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_COLLECTION_CONTRACT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SCHEMA_VERSION = 1;
  var SNAPSHOT_MAX_BYTES = 512 * 1024;
  var SENSITIVE_KEY = /(?:cookie|token|authorization|password|passwd|secret|session|credential|apikey)/i;
  function sensitiveKey(value) { return SENSITIVE_KEY.test(String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase()); }

  function text(value, maximum) {
    return String(value == null ? '' : value).trim().slice(0, maximum || 2000);
  }
  function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
  function numeric(value) {
    if (value === '' || value == null) return null;
    var parsed = Number(String(value).replace(/[,，￥¥₽\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  function positive(value) { var n = numeric(value); return n != null && n > 0 ? n : null; }
  function nonNegative(value) { var n = numeric(value); return n != null && n >= 0 ? n : null; }
  function array(value) { return Array.isArray(value) ? value : []; }
  function platform(value) {
    var result = text(value, 64).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!result) throw problem('collection_source_platform_required', '采集来源平台不能为空。');
    return result;
  }
  function sourceItemId(value) {
    var result = text(value, 160);
    if (!result) throw problem('collection_source_item_required', '采集来源商品编号不能为空。');
    return result;
  }
  function problem(code, message, status) {
    var error = new Error(message);
    error.publicCode = code;
    error.status = status || 400;
    return error;
  }
  function identityKey(sourcePlatform, itemId) {
    return 'collector:' + platform(sourcePlatform) + ':' + sourceItemId(itemId);
  }
  function safeUrl(value) {
    var raw = text(value, 4000);
    if (!raw) return '';
    try {
      var parsed = new URL(raw);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return '';
      parsed.hash = '';
      return parsed.toString();
    } catch (_) { return ''; }
  }
  function stripSensitive(value, depth) {
    depth = Number(depth) || 0;
    if (depth > 12) return null;
    if (Array.isArray(value)) return value.slice(0, 2000).map(function (item) { return stripSensitive(item, depth + 1); });
    if (!value || typeof value !== 'object') return value;
    var output = {};
    Object.keys(value).slice(0, 2000).forEach(function (key) {
      if (sensitiveKey(key)) return;
      var child = value[key];
      if (typeof child === 'string' && /html/i.test(key) && child.length > 20000) child = child.slice(0, 20000);
      output[key] = stripSensitive(child, depth + 1);
    });
    return output;
  }
  function snapshot(value) {
    var cleaned = stripSensitive(clone(value), 0);
    var encoded = JSON.stringify(cleaned == null ? {} : cleaned);
    if (BufferLikeLength(encoded) > SNAPSHOT_MAX_BYTES) {
      throw problem('collection_snapshot_too_large', '采集来源快照过大，请减少无关页面内容后重试。', 413);
    }
    return cleaned == null ? {} : cleaned;
  }
  function BufferLikeLength(value) {
    if (typeof Buffer !== 'undefined' && Buffer.byteLength) return Buffer.byteLength(value, 'utf8');
    try { return new TextEncoder().encode(value).length; } catch (_) { return unescape(encodeURIComponent(value)).length; }
  }
  function evidence(value, options) {
    options = options || {};
    return {
      value: value == null ? null : clone(value),
      unit: text(options.unit, 32),
      sourcePlatform: text(options.sourcePlatform, 64),
      sourceType: text(options.sourceType || 'page', 40),
      capturedAt: text(options.capturedAt, 64),
      confidence: text(options.confidence || 'exact', 40),
      sourcePath: text(options.sourcePath, 240)
    };
  }
  function dimensionFactor(unit) { return /^(?:cm|厘米)$/i.test(text(unit, 20)) ? 10 : /^(?:mm|毫米)$/i.test(text(unit, 20)) ? 1 : null; }
  function attributeMeasurements(record) {
    var attributes = array(record && record.attributes), result = { weightG: null, lengthMm: null, widthMm: null, heightMm: null };
    var sourcePlatform = text(record && record.source && record.source.platform, 64).toLowerCase();
    attributes.forEach(function (item) {
      var name = text(item && item.name, 160), value = text(item && item.value, 500).replace(/[（）()]/g, ' ');
      if (!name || !value) return;
      if (!result.weightG && /(?:^|包装|包裹)(?:重量|毛重|净重|克重)$|^(?:重量|毛重|净重|克重)$/i.test(name)) {
        var weight = value.match(/(\d+(?:\.\d+)?)\s*(kg|g|千克|公斤|克)\b/i) || value.match(/(\d+(?:\.\d+)?)\s*(千克|公斤|克)/i);
        if (weight) { var amount = Number(weight[1]); if (amount > 0) result.weightG = /^(?:kg|千克|公斤)$/i.test(weight[2]) ? amount * 1000 : amount; }
      }
      if (!(result.lengthMm && result.widthMm && result.heightMm) && /(?:尺寸|长宽高|包装规格|包装大小)/i.test(name)) {
        var dimensions = value.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)?/i);
        if (dimensions) {
          var factor = dimensionFactor(dimensions[4] || (sourcePlatform === '1688' ? 'cm' : ''));
          if (factor) { result.lengthMm = positive(Number(dimensions[1]) * factor); result.widthMm = positive(Number(dimensions[2]) * factor); result.heightMm = positive(Number(dimensions[3]) * factor); }
        }
      }
    });
    [['lengthMm', /^(?:包装|包裹)?(?:长|长度)$/i], ['widthMm', /^(?:包装|包裹)?(?:宽|宽度)$/i], ['heightMm', /^(?:包装|包裹)?(?:高|高度)$/i]].forEach(function (definition) {
      if (result[definition[0]]) return;
      var item = attributes.find(function (attribute) { return definition[1].test(text(attribute && attribute.name, 160)); });
      if (!item) return;
      var match = text(item.value, 200).replace(/[（）()]/g, ' ').match(/(\d+(?:\.\d+)?)\s*(mm|cm|毫米|厘米)?/i);
      if (!match) return;
      var factor = dimensionFactor(match[2] || (sourcePlatform === '1688' ? 'cm' : ''));
      if (factor) result[definition[0]] = positive(Number(match[1]) * factor);
    });
    return result;
  }
  function packageMeasurements(record) {
    var rows = array(record && record.packagingRows).concat(array(record && record.variants));
    var candidates = rows.map(function (item) {
      item = item || {}; var dimensions = item.packagingDimensions || {};
      return { weightG: positive(item.packagingWeight && item.packagingWeight.grams), lengthMm: positive(dimensions.lengthMm), widthMm: positive(dimensions.widthMm), heightMm: positive(dimensions.heightMm) };
    });
    var packaged = candidates.find(function (item) { return item.weightG && item.lengthMm && item.widthMm && item.heightMm; }) || candidates.find(function (item) { return item.weightG || item.lengthMm || item.widthMm || item.heightMm; }) || {};
    var attributed = attributeMeasurements(record);
    return {
      weightG: packaged.weightG || attributed.weightG || null,
      lengthMm: packaged.lengthMm || attributed.lengthMm || null,
      widthMm: packaged.widthMm || attributed.widthMm || null,
      heightMm: packaged.heightMm || attributed.heightMm || null
    };
  }
  function preferredPrice(record) {
    var variants = array(record && record.variants), prices = array(record && record.prices), candidates = [];
    var sourcePlatform = text(record && record.source && record.source.platform, 64).toLowerCase();
    if (sourcePlatform === '1688') prices.filter(function (item) { return numeric(item && item.min) !== null; }).forEach(function (item) { candidates.push(item); });
    if (sourcePlatform === '1688') prices.filter(function (item) { return item && (item.kind === 'minimum_order_unit' || item.kind === 'minimum_order_quantity'); }).forEach(function (item) { candidates.push(item); });
    if (sourcePlatform === '1688') variants.forEach(function (item) { candidates.push(item && item.price); });
    var kinds = sourcePlatform === 'ozon' ? ['structured_offer', 'display', 'sku'] : ['sku', 'display', 'tier'];
    kinds.forEach(function (kind) { prices.filter(function (item) { return item && item.kind === kind; }).forEach(function (item) { candidates.push(item); }); });
    prices.filter(function (item) { return item && !/original|bank|card/i.test(String(item.kind || '')); }).forEach(function (item) { candidates.push(item); });
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i] || {};
      var amount = numeric(candidate.amount);
      if (amount == null) amount = numeric(candidate.min);
      if (amount != null) return amount;
    }
    return null;
  }
  function mainImage(record) {
    var media = array(record && record.media), variants = array(record && record.variants);
    var sourcePlatform = text(record && record.source && record.source.platform, 64).toLowerCase();
    var candidate;
    if (sourcePlatform === '1688') {
      candidate = record && record.primarySkuImage && record.primarySkuImage.url
        || (variants.find(function (item) { return item && item.imageUrl; }) || {}).imageUrl
        || (media.find(function (item) { return item && item.kind === 'image' && item.role === 'variant'; }) || {}).url
        || (media.find(function (item) { return item && item.kind === 'image' && item.role === 'main'; }) || {}).url;
    }
    candidate = candidate
      || (media.find(function (item) { return item && item.kind === 'image' && item.role === 'main'; }) || {}).url
      || (media.find(function (item) { return item && item.kind === 'image'; }) || {}).url
      || (variants.find(function (item) { return item && item.imageUrl; }) || {}).imageUrl;
    return safeUrl(candidate);
  }
  function sourceCategory(record) {
    var rawPath = array(record && record.categoryPath);
    return {
      id: text(record && record.sourceCategoryId, 120),
      path: rawPath.map(function (item) { return text(item && typeof item === 'object' ? item.name || item.title || item.label : item, 160); }).filter(Boolean).slice(0, 12),
      raw: text(record && record.category, 500)
    };
  }
  function shipping(record) {
    var item = record && record.shipping || {};
    var conditions = record && record.purchaseConditions || {};
    var sourcePlatform = text(record && record.source && record.source.platform, 64).toLowerCase();
    var min = Number(conditions.minimumQuantity);
    var minimum = Number.isInteger(min) && min > 0 ? min : null;
    var quantity = Number(item.quantity);
    quantity = Number.isInteger(quantity) && quantity > 0 ? quantity : minimum || 1;
    var unit = text(conditions.minimumUnit, 24) || '件';
    var amount = nonNegative(item.amount), rawText = text(item.rawText, 1000);
    if (!rawText && amount != null) rawText = '¥' + amount;
    if (!rawText && sourcePlatform === '1688' && minimum) rawText = '运费未知（按' + minimum + unit + '起批）';
    if (rawText && sourcePlatform === '1688' && !new RegExp('按\\s*' + quantity + '\\s*' + unit).test(rawText)) rawText += '（按' + quantity + unit + '起批）';
    return {
      domesticAmount: amount,
      rawText: rawText,
      quantity: quantity,
      unit: unit,
      isStartingPrice: Boolean(item.isStartingPrice || /起/.test(text(item.rawText, 1000)))
    };
  }
  function normalizeVariant(item, index) {
    item = item || {};
    var price = item.price && typeof item.price === 'object' ? (numeric(item.price.amount) != null ? numeric(item.price.amount) : numeric(item.price.min)) : numeric(item.price);
    var packageValue = item.package && typeof item.package === 'object' ? item.package : {};
    var packageDimensions = item.packagingDimensions && typeof item.packagingDimensions === 'object' ? item.packagingDimensions : {};
    var logisticsValue = item.logistics && typeof item.logistics === 'object' ? item.logistics : {};
    var unitShipping = item.unitShipping && typeof item.unitShipping === 'object' ? item.unitShipping : {};
    var domesticAmount = nonNegative(logisticsValue.domesticAmount);
    if (domesticAmount == null) domesticAmount = nonNegative(logisticsValue.amount);
    if (domesticAmount == null) domesticAmount = nonNegative(unitShipping.amount);
    var quantity = Number(logisticsValue.quantity);
    quantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    return {
      sourceVariantId: text(item.sourceVariantId || item.skuId || item.variantId || item.id, 160),
      label: text(item.label || item.name || item.specText, 500),
      price: price,
      stock: nonNegative(item.stock != null ? item.stock : item.quantityAvailable),
      imageUrl: safeUrl(item.imageUrl || item.image || item.thumbnailUrl || item.url),
      attributes: array(item.attributes).slice(0, 100).map(function (entry) {
        return { name: text(entry && (entry.name || entry.label), 160), value: text(entry && (entry.value || entry.text), 1000) };
      }).filter(function (entry) { return entry.name || entry.value; }),
      package: {
        weightG: positive(packageValue.weightG) || positive(item.packagingWeight && item.packagingWeight.grams),
        lengthMm: positive(packageValue.lengthMm) || positive(packageDimensions.lengthMm),
        widthMm: positive(packageValue.widthMm) || positive(packageDimensions.widthMm),
        heightMm: positive(packageValue.heightMm) || positive(packageDimensions.heightMm)
      },
      logistics: {
        domesticAmount: domesticAmount,
        rawText: text(logisticsValue.rawText || unitShipping.rawText, 1000),
        quantity: quantity,
        unit: text(logisticsValue.unit || unitShipping.unit, 24),
        isStartingPrice: Boolean(logisticsValue.isStartingPrice || unitShipping.isStartingPrice)
      },
      sourceIndex: index
    };
  }
  function normalizeMedia(item) {
    item = item || {};
    var url = safeUrl(item.url || item.src);
    if (!url) return null;
    return { kind: text(item.kind || 'image', 40).toLowerCase(), role: text(item.role || '', 40).toLowerCase(), url: url };
  }
  function normalizeAttribute(item) {
    if (!item || typeof item !== 'object') return { name: '', value: text(item, 1000) };
    return { name: text(item.name || item.label, 160), value: text(item.value || item.text, 1000) };
  }
  function normalizeCapture(record, options) {
    options = options || {};
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw problem('collection_payload_invalid', '采集数据格式无效。');
    if (record.kind === 'source_product' && Number(record.schemaVersion) === SCHEMA_VERSION && record.identity) return normalizeStandard(record);
    var source = record.source || {};
    var sourcePlatform = platform(source.platform);
    var itemId = sourceItemId(source.productId || source.itemId);
    var capturedAt = text(record.capturedAt || source.capturedAt || options.capturedAt || new Date().toISOString(), 64);
    var sourceType = text(options.sourceType || record.sourceType || source.mode || 'page', 40);
    var sourceTrust = text(source.trust, 40).toLowerCase();
    var confidence = text(options.confidence || (sourceTrust === 'unverified' ? 'unknown' : /^(?:official|verified|trusted|official_api|official_authorized_store)$/.test(sourceTrust) ? 'exact' : 'exact'), 40);
    var pack = packageMeasurements(record), ship = shipping(record), category = sourceCategory(record);
    var minimum = Number(record && record.purchaseConditions && record.purchaseConditions.minimumQuantity);
    minimum = Number.isInteger(minimum) && minimum > 0 ? minimum : null;
    var result = {
      schemaVersion: SCHEMA_VERSION,
      kind: 'source_product',
      identity: {
        recordId: identityKey(sourcePlatform, itemId),
        sourcePlatform: sourcePlatform,
        sourceItemId: itemId,
        sourceUrl: safeUrl(source.url || record.url),
        sourceStoreId: text(source.storeId || source.supplierId || record.storeId || record.supplierId, 160)
      },
      basic: {
        title: text(record.title || record.name, 500),
        description: text(record.descriptionText || record.structuredDescriptionText || record.description, 20000),
        brand: text(record.brand, 160),
        article: text(record.article || record.productCode, 160),
        sourceCategory: category
      },
      pricing: {
        currency: text(record.currency || (sourcePlatform === '1688' ? 'CNY' : ''), 16).toUpperCase(),
        purchasePrice: preferredPrice(record),
        minimumQuantity: minimum,
        minimumUnit: ship.unit,
        ranges: array(record.prices).slice(0, 200).map(function (item) { return stripSensitive(item || {}, 0); })
      },
      logistics: ship,
      package: pack,
      variants: array(record.variants).slice(0, 1000).map(normalizeVariant),
      media: array(record.media).slice(0, 1000).map(normalizeMedia).filter(Boolean),
      attributes: array(record.attributes).slice(0, 1000).map(normalizeAttribute).filter(function (item) { return item.name || item.value; }),
      provenance: {
        capturedAt: capturedAt,
        sourceType: sourceType,
        confidence: confidence,
        fields: {
          title: evidence(text(record.title || record.name, 500), { sourcePlatform: sourcePlatform, sourceType: sourceType, capturedAt: capturedAt, confidence: confidence, sourcePath: 'title' }),
          purchasePrice: evidence(preferredPrice(record), { unit: text(record.currency || (sourcePlatform === '1688' ? 'CNY' : ''), 16).toUpperCase(), sourcePlatform: sourcePlatform, sourceType: sourceType, capturedAt: capturedAt, confidence: confidence, sourcePath: 'prices' }),
          package: evidence(pack, { unit: 'g/mm', sourcePlatform: sourcePlatform, sourceType: sourceType, capturedAt: capturedAt, confidence: pack.weightG || pack.lengthMm ? confidence : 'unknown', sourcePath: 'packagingRows/attributes' })
        }
      },
      sourceSnapshot: snapshot(record)
    };
    return result;
  }
  function normalizeStandard(input) {
    input = input || {};
    var identity = input.identity && typeof input.identity === 'object' ? input.identity : {};
    var sourcePlatform = platform(identity.sourcePlatform);
    var itemId = sourceItemId(identity.sourceItemId);
    var basic = input.basic && typeof input.basic === 'object' ? input.basic : {};
    var category = basic.sourceCategory && typeof basic.sourceCategory === 'object' ? basic.sourceCategory : {};
    var pricing = input.pricing && typeof input.pricing === 'object' ? input.pricing : {};
    var logistics = input.logistics && typeof input.logistics === 'object' ? input.logistics : {};
    var pack = input.package && typeof input.package === 'object' ? input.package : {};
    var provenance = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
    var minimum = Number(pricing.minimumQuantity);
    minimum = Number.isInteger(minimum) && minimum > 0 ? minimum : null;
    var quantity = Number(logistics.quantity);
    quantity = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: 'source_product',
      identity: {
        recordId: identityKey(sourcePlatform, itemId),
        sourcePlatform: sourcePlatform,
        sourceItemId: itemId,
        sourceUrl: safeUrl(identity.sourceUrl),
        sourceStoreId: text(identity.sourceStoreId, 160)
      },
      basic: {
        title: text(basic.title, 500),
        description: text(basic.description, 20000),
        brand: text(basic.brand, 160),
        article: text(basic.article, 160),
        sourceCategory: {
          id: text(category.id, 120),
          path: array(category.path).slice(0, 12).map(function (item) { return text(item && typeof item === 'object' ? item.name || item.title || item.label : item, 160); }).filter(Boolean),
          raw: text(category.raw, 500)
        }
      },
      pricing: {
        currency: text(pricing.currency, 16).toUpperCase(),
        purchasePrice: numeric(pricing.purchasePrice),
        minimumQuantity: minimum,
        minimumUnit: text(pricing.minimumUnit, 24),
        ranges: snapshot(array(pricing.ranges).slice(0, 200))
      },
      logistics: {
        domesticAmount: nonNegative(logistics.domesticAmount),
        rawText: text(logistics.rawText, 1000),
        quantity: quantity,
        unit: text(logistics.unit, 24),
        isStartingPrice: Boolean(logistics.isStartingPrice)
      },
      package: {
        weightG: positive(pack.weightG),
        lengthMm: positive(pack.lengthMm),
        widthMm: positive(pack.widthMm),
        heightMm: positive(pack.heightMm)
      },
      variants: array(input.variants).slice(0, 1000).map(normalizeVariant),
      media: array(input.media).slice(0, 1000).map(normalizeMedia).filter(Boolean),
      attributes: array(input.attributes).slice(0, 1000).map(normalizeAttribute).filter(function (item) { return item.name || item.value; }),
      provenance: {
        capturedAt: text(provenance.capturedAt || new Date().toISOString(), 64),
        sourceType: text(provenance.sourceType || 'import', 40),
        confidence: text(provenance.confidence || 'exact', 40),
        fields: snapshot(provenance.fields || {})
      },
      sourceSnapshot: snapshot(input.sourceSnapshot || {})
    };
  }
  function compatibilityCapture(source) {
    var raw = source && source.sourceSnapshot && typeof source.sourceSnapshot === 'object' ? clone(source.sourceSnapshot) : {};
    raw.schemaVersion = Number(raw.schemaVersion) || 1;
    raw.source = Object.assign({}, raw.source || {}, {
      platform: source.identity.sourcePlatform,
      productId: source.identity.sourceItemId,
      url: source.identity.sourceUrl
    });
    if (!raw.title) raw.title = source.basic.title;
    if (!raw.descriptionText && source.basic.description) raw.descriptionText = source.basic.description;
    if (!Array.isArray(raw.variants) || !raw.variants.length) raw.variants = source.variants.map(function (variant) {
      var pack = variant.package || {}, logistics = variant.logistics || {};
      return {
        skuId: variant.sourceVariantId,
        sourceVariantId: variant.sourceVariantId,
        label: variant.label,
        price: { amount: variant.price },
        stock: variant.stock,
        imageUrl: variant.imageUrl,
        attributes: clone(variant.attributes),
        packagingWeight: pack.weightG != null ? { grams: pack.weightG } : null,
        packagingDimensions: { lengthMm: pack.lengthMm, widthMm: pack.widthMm, heightMm: pack.heightMm },
        unitShipping: logistics.domesticAmount != null ? { amount: logistics.domesticAmount, rawText: logistics.rawText, unit: logistics.unit, isStartingPrice: logistics.isStartingPrice } : null
      };
    });
    if (!Array.isArray(raw.media) || !raw.media.length) raw.media = clone(source.media);
    if (!Array.isArray(raw.attributes) || !raw.attributes.length) raw.attributes = clone(source.attributes);
    return raw;
  }
  function toCompatibilityRecord(sourceInput, previous, now) {
    var source = normalizeCapture(sourceInput);
    var old = previous && typeof previous === 'object' ? previous : {};
    var raw = compatibilityCapture(source);
    var categoryMatch = raw.categoryMatch && typeof raw.categoryMatch === 'object' ? raw.categoryMatch : {};
    var category = categoryMatch.category && typeof categoryMatch.category === 'object' ? categoryMatch.category : {};
    var sourcePath = source.basic && source.basic.sourceCategory && array(source.basic.sourceCategory.path);
    var categoryPath = array(category.path).length ? array(category.path).map(function (item) { return text(item, 160); }).filter(Boolean) : sourcePath;
    var image = mainImage(raw) || (source.media.find(function (item) { return item.kind === 'image' && item.role === 'main'; }) || source.media.find(function (item) { return item.kind === 'image'; }) || {}).url
      || (source.variants.find(function (item) { return item.imageUrl; }) || {}).imageUrl || '';
    var ship = source.logistics || {}, pack = source.package || {};
    var sourceLabel = source.identity.sourcePlatform === '1688' ? '1688' : source.identity.sourcePlatform === 'ozon' ? 'Ozon' : source.identity.sourcePlatform;
    return Object.assign({}, old, {
      id: source.identity.recordId,
      title: source.basic.title || '未命名商品',
      image: image,
      sourceUrl: source.identity.sourceUrl,
      price: numeric(source.pricing.purchasePrice),
      skuCount: source.variants.length || (raw.packagingRows && Array.isArray(raw.packagingRows) ? new Set(raw.packagingRows.map(function (item) { return text(item && item.label, 500); }).filter(Boolean)).size || null : null),
      source: sourceLabel,
      note: text(old.note, 300),
      status: text(old.status, 40) || '未上架',
      minimumQuantity: Number.isInteger(Number(source.pricing.minimumQuantity)) && Number(source.pricing.minimumQuantity) > 0 ? Number(source.pricing.minimumQuantity) : null,
      minimumUnit: text(source.pricing.minimumUnit || ship.unit, 24),
      shippingText: text(ship.rawText, 1000) || (numeric(ship.domesticAmount) != null ? '¥' + numeric(ship.domesticAmount) : ''),
      shippingAmount: nonNegative(ship.domesticAmount),
      shippingQuantity: Number(ship.quantity) > 0 ? Number(ship.quantity) : 1,
      shippingIsStartingPrice: Boolean(ship.isStartingPrice),
      weightG: positive(old.weightG) || positive(pack.weightG),
      length: positive(old.length) || positive(pack.lengthMm),
      width: positive(old.width) || positive(pack.widthMm),
      height: positive(old.height) || positive(pack.heightMm),
      categoryName: categoryPath.join(' / '),
      categoryId: text(category.id || source.basic.sourceCategory && source.basic.sourceCategory.id, 120),
      categoryPath: categoryPath,
      categoryMatchStatus: text(categoryMatch.status, 40),
      categoryMatchConfidence: numeric(categoryMatch.confidence),
      categoryMatchMethod: text(categoryMatch.method, 80),
      captureSchemaVersion: raw.schemaVersion || 1,
      captureAdapterVersion: text(raw.adapterVersion, 40),
      capture: raw,
      standardSource: source,
      createdAt: text(old.createdAt, 64) || text(now, 64) || new Date().toISOString(),
      updatedAt: text(now, 64) || new Date().toISOString()
    });
  }
  function semanticFingerprint(sourceInput) {
    var source = normalizeCapture(sourceInput);
    var stable = { identity: source.identity, basic: source.basic, pricing: source.pricing, logistics: source.logistics, package: source.package, variants: source.variants, media: source.media, attributes: source.attributes };
    var json = JSON.stringify(stable);
    if (typeof require === 'function') {
      try { return require('crypto').createHash('sha256').update(json).digest('hex'); } catch (_) {}
    }
    var hash = 2166136261;
    for (var i = 0; i < json.length; i += 1) { hash ^= json.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return ('00000000' + (hash >>> 0).toString(16)).slice(-8);
  }
  function fromStoredRecord(record) {
    record = record || {};
    if (record.standardSource && typeof record.standardSource === 'object') {
      try { return normalizeCapture(record.standardSource); } catch (_) {}
    }
    if (record.capture && typeof record.capture === 'object') {
      try { return normalizeCapture(record.capture); } catch (_) {}
    }
    var id = text(record.id, 320), match = id.match(/^collector:([^:]+):(.+)$/);
    if (!match) return null;
    return normalizeStandard({
      schemaVersion: 1, kind: 'source_product',
      identity: { sourcePlatform: match[1], sourceItemId: match[2], sourceUrl: record.sourceUrl || '' },
      basic: { title: record.title || record.name || '', description: record.description || '', sourceCategory: { id: record.categoryId || '', path: array(record.categoryPath), raw: record.categoryName || '' } },
      pricing: { currency: '', purchasePrice: record.price, minimumQuantity: record.minimumQuantity, minimumUnit: record.minimumUnit, ranges: [] },
      logistics: { domesticAmount: record.shippingAmount, rawText: record.shippingText, quantity: record.shippingQuantity || 1, unit: record.minimumUnit || '', isStartingPrice: Boolean(record.shippingIsStartingPrice) },
      package: { weightG: record.weightG, lengthMm: record.length, widthMm: record.width, heightMm: record.height },
      variants: [], media: record.image ? [{ kind: 'image', role: 'main', url: record.image }] : [], attributes: [],
      provenance: { capturedAt: record.collectedAt || record.updatedAt || '', sourceType: 'legacy', confidence: 'unknown', fields: {} },
      sourceSnapshot: {}
    });
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION, SNAPSHOT_MAX_BYTES: SNAPSHOT_MAX_BYTES,
    problem: problem, identityKey: identityKey, evidence: evidence, normalizeCapture: normalizeCapture,
    normalizeStandard: normalizeStandard, toCompatibilityRecord: toCompatibilityRecord, fromStoredRecord: fromStoredRecord,
    semanticFingerprint: semanticFingerprint, stripSensitive: stripSensitive, snapshot: snapshot
  };
});
