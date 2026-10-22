/* 网研ERP — 采集箱数据模型（浏览器 / Node 共用） */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_PRODUCT_COLLECTION = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function text(value) { return value == null ? '' : String(value).trim(); }
  function sourceImageUrl(value) {
    var raw = text(value);
    if (!raw) return '';
    try {
      var parsed = new URL(raw);
      if (/(?:^|\.)alicdn(?:1688)?\.com$/i.test(parsed.hostname) || /(?:^|\.)1688img\.com$/i.test(parsed.hostname)) parsed.pathname = parsed.pathname.replace(/\.jpg_(?:sum|b)\.jpg$/i, '.jpg');
      return parsed.href;
    } catch (error) { return raw; }
  }
  function number(value) {
    if (value === '' || value == null) return null;
    var parsed = Number(String(value).replace(/[,，￥¥₽\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  function array(value) { return Array.isArray(value) ? value : (value && Array.isArray(value.items) ? value.items : []); }
  function positive(value) { var parsed = number(value); return parsed != null && parsed > 0 ? parsed : null; }
  function nonNegative(value) { var parsed = number(value); return parsed != null && parsed >= 0 ? parsed : null; }
  function standardSource(product) { return product && product.standardSource && typeof product.standardSource === 'object' ? product.standardSource : null; }
  function standardPlatform(product) { var source = standardSource(product); return text(source && source.identity && source.identity.sourcePlatform || product && product.source).toLowerCase(); }
  function capturedFallbackImage(item) {
    var capture = item && item.capture && typeof item.capture === 'object' ? item.capture : {};
    var standard = standardSource(item), candidates = [];
    array(capture.skuImages).forEach(function (entry) { candidates.push(entry && (entry.url || entry.imageUrl)); });
    array(capture.variants).forEach(function (entry) { candidates.push(entry && (entry.imageUrl || entry.image || entry.thumbnailUrl)); });
    candidates.push(capture.primarySkuImage && (capture.primarySkuImage.url || capture.primarySkuImage.imageUrl));
    array(standard && standard.variants).forEach(function (entry) { candidates.push(entry && entry.imageUrl); });
    candidates.push(item && (item.image || item.imageUrl));
    array(capture.media).forEach(function (entry) { if (entry && text(entry.kind).toLowerCase() === 'image' && ['main','detail'].indexOf(text(entry.role).toLowerCase()) >= 0) candidates.push(entry.url || entry.src); });
    array(standard && standard.media).forEach(function (entry) { if (entry && text(entry.kind).toLowerCase() === 'image' && ['main','detail','variant'].indexOf(text(entry.role).toLowerCase()) >= 0) candidates.push(entry.url); });
    for (var i = 0; i < candidates.length; i += 1) { var url = sourceImageUrl(candidates[i]); if (url) return url; }
    return '';
  }
  function variantKey(variant, capture) {
    if (variant && (variant.skuId || variant.sourceVariantId)) return 'sku:' + (variant.skuId || variant.sourceVariantId);
    if (variant && variant.url) return 'url:' + variant.url;
    if (variant && variant.label && array(capture && capture.variants).filter(function (item) { return item && item.label === variant.label; }).length === 1) return 'label:' + variant.label;
    return '';
  }
  function packageProfile(item) {
    var capture = item && item.capture && typeof item.capture === 'object' ? item.capture : {};
    var sources = array(capture.packagingRows).concat(array(capture.variants)), reviews = array(capture.review && capture.review.variants), candidates = [];
    sources.forEach(function (source) {
      source = source || {};
      var key = variantKey(source, capture);
      var review = reviews.find(function (entry) { return entry && (key && entry.variantKey === key || source.label && entry.label === source.label); }) || {};
      var reviewedWeight = positive(review.packagingWeight && review.packagingWeight.grams);
      var sourceWeight = positive(source.packagingWeight && source.packagingWeight.grams);
      var reviewedDimensions = review.packagingDimensions || {}, sourceDimensions = source.packagingDimensions || {};
      candidates.push({
        source: source, review: review,
        weightG: reviewedWeight || sourceWeight,
        length: positive(reviewedDimensions.lengthMm) || positive(sourceDimensions.lengthMm),
        width: positive(reviewedDimensions.widthMm) || positive(sourceDimensions.widthMm),
        height: positive(reviewedDimensions.heightMm) || positive(sourceDimensions.heightMm)
      });
    });
    reviews.forEach(function (review) {
      if (!review || candidates.some(function (candidate) { return candidate.review === review; })) return;
      var dimensions = review.packagingDimensions || {};
      candidates.push({ source: {}, review: review, weightG: positive(review.packagingWeight && review.packagingWeight.grams), length: positive(dimensions.lengthMm), width: positive(dimensions.widthMm), height: positive(dimensions.heightMm) });
    });
    return candidates.find(function (candidate) { return candidate.weightG && candidate.length && candidate.width && candidate.height; }) || candidates.find(function (candidate) { return candidate.weightG || candidate.length || candidate.width || candidate.height; }) || { source: {}, review: {}, weightG: null, length: null, width: null, height: null };
  }
  function shippingAmount(item, profile) {
    var capture = item && item.capture && typeof item.capture === 'object' ? item.capture : {};
    var values = [item.domesticShipping, profile.review && profile.review.unitShipping && profile.review.unitShipping.amount, capture.review && capture.review.shippingAmount, profile.source && profile.source.unitShipping && profile.source.unitShipping.amount, item.shippingAmount, capture.shipping && capture.shipping.amount];
    for (var i = 0; i < values.length; i += 1) { var parsed = nonNegative(values[i]); if (parsed != null) return parsed; }
    return null;
  }
  function capturedDescription(item) {
    var capture = item && item.capture && typeof item.capture === 'object' ? item.capture : {};
    var standard = standardSource(item), basic = standard && standard.basic || {};
    return text(item.description) || text(capture.descriptionText) || text(capture.structuredDescriptionText) || text(basic.description);
  }
  function categoryName(product) {
    var capture = product && product.capture && typeof product.capture === 'object' ? product.capture : {};
    var standard = standardSource(product), standardCategory = standard && standard.basic && standard.basic.sourceCategory || {};
    var match = capture.categoryMatch && typeof capture.categoryMatch === 'object' ? capture.categoryMatch : {};
    var matchedPath = match.category && Array.isArray(match.category.path) ? match.category.path : null;
    if (matchedPath && matchedPath.length) {
      var matchedName = matchedPath.map(function (item) { return text(item); }).filter(Boolean).join(' / ');
      return matchedName + (match.status === 'needs_review' ? '（候选）' : '');
    }
    var direct = text(product && product.categoryName);
    if (direct) return direct + (product && product.categoryMatchStatus === 'needs_review' && !/候选/.test(direct) ? '（候选）' : '');
    var path = product && product.categoryPath != null ? product.categoryPath : capture.categoryPath != null ? capture.categoryPath : array(standardCategory.path).length ? standardCategory.path : product && product.category;
    if (Array.isArray(path)) return path.map(function (item) { return text(item && typeof item === 'object' ? item.name || item.title || item.label : item); }).filter(Boolean).join(' / ');
    return text(path && typeof path === 'object' ? path.name || path.title || path.label : path) || text(standardCategory.raw);
  }
  function ozonCategory(product) {
    var match = product && product.ozonCategoryMatch && typeof product.ozonCategoryMatch === 'object' ? product.ozonCategoryMatch : {};
    var category = match.category && typeof match.category === 'object' ? match.category : {};
    var directDescriptionId = text(product && (product.ozonDescriptionCategoryId || product.descriptionCategoryId));
    var directTypeId = text(product && (product.ozonTypeId || product.typeId));
    var descriptionCategoryId = text(category.descriptionCategoryId) || directDescriptionId;
    var typeId = text(category.typeId) || directTypeId;
    var path = array(category.path).map(text).filter(Boolean);
    var confirmedLegacy = /^\d+$/.test(descriptionCategoryId) && /^\d+$/.test(typeId) && !text(match.status);
    return {
      key: text(category.key) || (descriptionCategoryId && typeId ? descriptionCategoryId + ':' + typeId : ''), descriptionCategoryId: descriptionCategoryId, typeId: typeId,
      path: path, pathText: text(category.pathText) || text(product && product.ozonCategoryName) || path.join(' > '),
      status: text(match.status) || (confirmedLegacy ? 'matched' : ''), method: text(match.method) || (confirmedLegacy ? 'legacy_saved' : ''), confidence: number(match.confidence),
      requiresManual: Boolean(match.requiresManual), warning: text(match.warning), alternatives: array(match.alternatives), reasons: array(match.reasons).map(text).filter(Boolean)
    };
  }
  function categoryMatchInput(product) {
    var item = normalize(product), capture = item.capture && typeof item.capture === 'object' ? item.capture : {};
    var standard = standardSource(item), standardBasic = standard && standard.basic || {};
    var sourceMatch = capture.categoryMatch && typeof capture.categoryMatch === 'object' ? capture.categoryMatch : {};
    var sourceCategory = sourceMatch.category && typeof sourceMatch.category === 'object' && (sourceMatch.category.id || array(sourceMatch.category.path).length) ? sourceMatch.category : standardBasic.sourceCategory && typeof standardBasic.sourceCategory === 'object' ? standardBasic.sourceCategory : {};
    var noisyAttribute = /^(?:货号|品牌|颜色|产地|价格段|箱装数量|装箱数|是否进口|是否跨境出口专供货源|主要下游平台|主要销售地区|加印LOGO|版权|是否IP授权|是否专利货源|专利|包装明细(?:\s*\/.*)?)/i;
    var negativeValue = /^(?:否|无|不是|不支持|none|no|false|0)$/i;
    var attributeRows = (array(capture.attributes).length ? array(capture.attributes) : array(standard && standard.attributes)).slice(0, 60).map(function (attribute) {
      if (!attribute || typeof attribute !== 'object') return { name: '', value: text(attribute) };
      return { name: text(attribute.name || attribute.label), value: text(attribute.value || attribute.text) };
    }).filter(function (row) { return (row.name || row.value) && !noisyAttribute.test(row.name) && !negativeValue.test(row.value); });
    var attributeNames = attributeRows.map(function (row) { return row.name; }).filter(Boolean).join(' ').slice(0, 600);
    var attributeKeywords = attributeRows.map(function (row) { return [row.name, row.value].filter(Boolean).join(' '); }).filter(Boolean).join(' ').slice(0, 1200);
    var descriptionKeywords = capturedDescription(item).slice(0, 600);
    return {
      id: item.id, title: item.title, sourcePlatform: standardPlatform(item) || text(capture.source && capture.source.platform || capture.platform || 'unknown').toLowerCase(),
      sourceCategoryId: text(sourceCategory.id || item.categoryId),
      sourceCategoryPath: array(sourceCategory.path && sourceCategory.path.length ? sourceCategory.path : item.categoryPath).map(function (value) { return text(value && typeof value === 'object' ? value.name || value.title || value.label : value); }).filter(Boolean),
      attributeNames: attributeNames,
      attributeKeywords: attributeKeywords,
      descriptionKeywords: descriptionKeywords,
      keywords: attributeKeywords || descriptionKeywords
    };
  }
  function applyOzonMatch(product, match) {
    var category = match && match.category && typeof match.category === 'object' ? match.category : {};
    return normalize(Object.assign({}, product, {
      ozonCategoryMatch: match || null,
      ozonCategoryName: text(category.pathText) || array(category.path).map(text).filter(Boolean).join(' > '),
      ozonDescriptionCategoryId: text(category.descriptionCategoryId),
      ozonTypeId: text(category.typeId)
    }));
  }
  function packageSummary(product, profile) {
    product = product || {}; profile = profile || packageProfile(product);
    var dimensions = product.dimensions || {}, verified = product.verifiedPackage && product.verifiedPackage.product && typeof product.verifiedPackage.product === 'object' ? product.verifiedPackage.product : {};
    return {
      weightG: positive(verified.weightG) || positive(product.weightG) || profile.weightG || null,
      lengthMm: positive(verified.lengthMm) || positive(product.length) || positive(dimensions.length) || profile.length || null,
      widthMm: positive(verified.widthMm) || positive(product.width) || positive(dimensions.width) || profile.width || null,
      heightMm: positive(verified.heightMm) || positive(product.height) || positive(dimensions.height) || profile.height || null
    };
  }
  function applyPackageMeasurements(product, values) {
    var next = Object.assign({}, product || {}), input = values || {}, pack = packageSummary(product);
    next.packageDimensionSources = Object.assign({}, product && product.packageDimensionSources || {});
    ['weightG', 'length', 'width', 'height'].forEach(function (field) {
      if (input[field] == null || String(input[field]).trim() === '') return;
      var value = positive(input[field]); if (value != null) { next[field] = value; if (['length','width','height'].indexOf(field) >= 0 && value !== pack[field + 'Mm']) next.packageDimensionSources[field] = 'manual'; }
    });
    return next;
  }
  function supplementDefaultDimensions(product, defaultMm) {
    var pack = packageSummary(product), size = positive(defaultMm) || 100;
    if (!(pack.weightG > 0 && pack.weightG < 500)) return product;
    var next = Object.assign({}, product || {}), changed = false;
    next.packageDimensionSources = Object.assign({}, product && product.packageDimensionSources || {});
    [['length', 'lengthMm'], ['width', 'widthMm'], ['height', 'heightMm']].forEach(function (fields) {
      if (pack[fields[1]] != null) return;
      next[fields[0]] = size; next.packageDimensionSources[fields[0]] = 'fallback'; changed = true;
    });
    return changed ? next : product;
  }
  function displayIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    var masked = text(value.masked), raw = text(value.raw), kind = text(value.kind);
    return masked ? { kind: kind || 'unknown', raw: raw, masked: masked } : null;
  }
  function normalize(product) {
    product = product || {};
    var standard = standardSource(product), identity = standard && standard.identity || {}, basic = standard && standard.basic || {}, pricing = standard && standard.pricing || {}, logistics = standard && standard.logistics || {}, pack = standard && standard.package || {};
    var media = standard && array(standard.media), main = media && (media.find(function (item) { return item && item.kind === 'image' && item.role === 'main'; }) || media.find(function (item) { return item && item.kind === 'image'; }));
    var platform = text(identity.sourcePlatform || product.source), sourceLabel = platform === '1688' ? '1688' : platform === 'ozon' ? 'Ozon' : platform;
    return Object.assign({}, product, {
      packageDimensionSources: Object.assign({}, product.packageDimensionSources || {}),
      id: text(identity.recordId || product.id), title: text(basic.title || product.title || product.name), image: text(main && main.url || product.image || product.imageUrl), sourceUrl: text(identity.sourceUrl || product.sourceUrl || product.url),
      price: number(pricing.purchasePrice != null ? pricing.purchasePrice : product.price), skuCount: number(product.skuCount), source: sourceLabel, note: text(product.note), category: categoryName(product),
      shippingText: text(logistics.rawText || product.shippingText), shippingAmount: number(logistics.domesticAmount != null ? logistics.domesticAmount : product.shippingAmount), shippingQuantity: number(logistics.quantity != null ? logistics.quantity : product.shippingQuantity), minimumQuantity: number(pricing.minimumQuantity != null ? pricing.minimumQuantity : product.minimumQuantity), minimumUnit: text(pricing.minimumUnit || logistics.unit || product.minimumUnit),
      weightG: positive(product.weightG) || positive(pack.weightG), length: positive(product.length) || positive(pack.lengthMm), width: positive(product.width) || positive(pack.widthMm), height: positive(product.height) || positive(pack.heightMm),
      status: text(product.status) || '未上架', createdAt: text(product.createdAt), updatedAt: text(product.updatedAt),
      collectedBy: text(product.collectedBy), collectedByUserId: text(product.collectedByUserId), collectedByIdentity: displayIdentity(product.collectedByIdentity), collectedAt: text(product.collectedAt),
      ozonCategoryName: ozonCategory(product).pathText
    });
  }
  function normalizeAll(value) { return array(value).map(normalize).filter(function (item) { return item.id || item.title; }); }
  function filter(value, criteria) {
    criteria = criteria || {};
    var keyword = text(criteria.keyword).toLowerCase(), source = text(criteria.source), status = text(criteria.status);
    return normalizeAll(value).filter(function (item) {
      if (keyword && (item.title + ' ' + item.note).toLowerCase().indexOf(keyword) < 0) return false;
      if (source && item.source !== source) return false;
      return !status || item.status === status;
    });
  }
  function upsert(value, product) {
    var list = normalizeAll(value), incoming = product || {}, next = normalize(incoming), found = false;
    list = list.map(function (item) { if (next.id && item.id === next.id) { found = true; return normalize(Object.assign({}, item, incoming)); } return item; });
    if (!found) list.unshift(next);
    return list;
  }
  function capturedDraftVariants(item, domesticShipping) {
    var capture = item && item.capture && typeof item.capture === 'object' ? item.capture : {};
    var standard = standardSource(item), standardVariants = array(standard && standard.variants);
    var capturedVariants = array(capture.variants).filter(function (variant) { return variant && text(variant.label || variant.skuId || variant.sourceVariantId); });
    var capturedSkuImages = array(capture.skuImages).filter(function (variant) { return variant && text(variant.label || variant.url); });
    var sources = capturedVariants.length >= capturedSkuImages.length ? capturedVariants : capturedSkuImages;
    if (!sources.length) sources = standardVariants;
    var capturedVideo = array(capture.media).filter(function (media) { return media && text(media.kind).toLowerCase() === 'video' && text(media.role).toLowerCase() === 'main'; }).map(function (media) { return text(media.url || media.src); }).filter(Boolean)[0]
      || array(standard && standard.media).filter(function (media) { return media && text(media.kind).toLowerCase() === 'video' && (!text(media.role) || text(media.role).toLowerCase() === 'main'); }).map(function (media) { return text(media.url); }).filter(Boolean)[0]
      || text(capture.video || capture.videoUrl || item.video || item.videoUrl);
    if (!sources.length) return [];
    var fallbackImage = capturedFallbackImage(item);
    function imageFor(source) {
      var direct = sourceImageUrl(source && (source.imageUrl || source.url || source.image || source.thumbnailUrl));
      if (direct) return direct;
      var label = text(source && source.label);
      var matched = capturedSkuImages.find(function (entry) { return label && text(entry && entry.label) === label; });
      return sourceImageUrl(matched && (matched.url || matched.imageUrl)) || fallbackImage;
    }
    function priceFor(source) {
      var price = source && source.price;
      var values = [price && typeof price === 'object' ? price.amount : price, price && typeof price === 'object' ? price.min : null, source && source.purchasePrice, item.price];
      for (var i = 0; i < values.length; i += 1) { var parsed = number(values[i]); if (parsed != null) return parsed; }
      return '';
    }
    var reviews = array(capture.review && capture.review.variants);
    var verifiedPackage = item && item.verifiedPackage && typeof item.verifiedPackage === 'object' ? item.verifiedPackage : {}, verifiedVariants = array(verifiedPackage.variants), verifiedModes = verifiedPackage.modes && typeof verifiedPackage.modes === 'object' ? verifiedPackage.modes : {};
    function matchingVerifiedVariant(source) {
      var skuId = text(source && (source.skuId || source.sourceVariantId)), label = text(source && source.label);
      if (skuId) { var exact = verifiedVariants.find(function (entry) { return text(entry && entry.sourceVariantId) === skuId; }); if (exact) return exact; }
      var byLabel = label ? verifiedVariants.filter(function (entry) { return text(entry && entry.label) === label; }) : [];
      return byLabel.length === 1 ? byLabel[0] : {};
    }
    function matchingStandardVariant(source) {
      var skuId = text(source && (source.skuId || source.sourceVariantId));
      if (skuId) {
        var exact = standardVariants.find(function (entry) { return text(entry && entry.sourceVariantId) === skuId; });
        if (exact) return exact;
      }
      var label = text(source && source.label);
      var byLabel = label ? standardVariants.filter(function (entry) { return text(entry && entry.label) === label; }) : [];
      return byLabel.length === 1 ? byLabel[0] : {};
    }
    function packageFor(source, review) {
      var standardVariant = matchingStandardVariant(source), verifiedVariant = matchingVerifiedVariant(source), sourcePackage = source && source.package || {}, standardPackage = standardVariant && standardVariant.package || {};
      var reviewDimensions = review && review.packagingDimensions || {}, sourceDimensions = source && source.packagingDimensions || {};
      return {
        weightG: (verifiedModes.weight ? positive(verifiedVariant.weightG) : null) || positive(review && review.packagingWeight && review.packagingWeight.grams) || positive(sourcePackage.weightG) || positive(source && source.packagingWeight && source.packagingWeight.grams) || positive(standardPackage.weightG),
        packageLength: (verifiedModes.dimensions ? positive(verifiedVariant.lengthMm) : null) || positive(reviewDimensions.lengthMm) || positive(sourcePackage.lengthMm) || positive(sourceDimensions.lengthMm) || positive(standardPackage.lengthMm),
        packageWidth: (verifiedModes.dimensions ? positive(verifiedVariant.widthMm) : null) || positive(reviewDimensions.widthMm) || positive(sourcePackage.widthMm) || positive(sourceDimensions.widthMm) || positive(standardPackage.widthMm),
        packageHeight: (verifiedModes.dimensions ? positive(verifiedVariant.heightMm) : null) || positive(reviewDimensions.heightMm) || positive(sourcePackage.heightMm) || positive(sourceDimensions.heightMm) || positive(standardPackage.heightMm)
      };
    }
    return sources.map(function (source, index) {
      var image = imageFor(source), label = text(source && source.label), skuId = text(source && (source.skuId || source.sourceVariantId));
      var review = reviews.find(function (entry) { return entry && ((skuId && text(entry.skuId) === skuId) || (label && text(entry.label) === label)); }) || {};
      var reviewedShipping = nonNegative(review.unitShipping && review.unitShipping.amount);
      var sourceShipping = nonNegative(source && source.unitShipping && source.unitShipping.amount);
      if (sourceShipping == null) sourceShipping = nonNegative(source && source.logistics && source.logistics.domesticAmount);
      var shipping = reviewedShipping != null ? reviewedShipping : sourceShipping != null ? sourceShipping : domesticShipping;
      var packageValues = packageFor(source, review);
      return {
        name: label || ('规格 ' + (index + 1)),
        sourceSpecText: label,
        image: image,
        images: image ? [image] : [],
        video: capturedVideo,
        sku: skuId,
        purchase: priceFor(source),
        domesticShipping: shipping == null ? '' : shipping,
        weightG: packageValues.weightG || '',
        packageLength: packageValues.packageLength || '',
        packageWidth: packageValues.packageWidth || '',
        packageHeight: packageValues.packageHeight || ''
      };
    });
  }
  function createDraft(product) {
  function variantPackageModes(variants) {
    function varies(field) {
      var known = variants.map(function (variant) { return positive(variant && variant[field]); }).filter(function (value) { return value != null; });
      return known.length >= 2 && new Set(known.map(String)).size > 1;
    }
    return {
      weight: varies('weightG'),
      dimensions: varies('packageLength') || varies('packageWidth') || varies('packageHeight')
    };
  }
  function applyVariantPackageMode(variants, modes) {
    return variants.map(function (variant) {
      var next = Object.assign({}, variant);
      if (!modes.weight) delete next.weightG;
      if (!modes.dimensions) { delete next.packageLength; delete next.packageWidth; delete next.packageHeight; }
      return next;
    });
  }
    var item = normalize(product), mainImage = sourceImageUrl(item.image) || capturedFallbackImage(item), image = mainImage ? [mainImage] : [], notes = [item.note], profile = packageProfile(item);
    var domesticShipping = shippingAmount(item, profile), packaging = packageSummary(item, profile);
    var categoryMatch = item.capture && item.capture.categoryMatch && typeof item.capture.categoryMatch === 'object' ? item.capture.categoryMatch : {};
    var standard = standardSource(item), standardCategory = standard && standard.basic && standard.basic.sourceCategory || {};
    var sourceCategory = categoryMatch.category && typeof categoryMatch.category === 'object' && (categoryMatch.category.id || array(categoryMatch.category.path).length) ? categoryMatch.category : standardCategory;
    var resolvedCategory = ozonCategory(item), targetCategory = resolvedCategory.status === 'matched' ? resolvedCategory : {};
    if (item.shippingText) notes.push('最低起批运费：' + item.shippingText);
    var categorySource = item.source || standardPlatform(item) || text(item.capture && item.capture.source && item.capture.source.platform) || text(item.capture && item.capture.platform) || '1688';
    if (sourceCategory.path && sourceCategory.path.length) notes.push(categorySource + '货源类目' + (categoryMatch.status === 'needs_review' ? '候选（待核对）' : '') + '：' + sourceCategory.path.join(' / '));
    var capturedVariants = capturedDraftVariants(item, domesticShipping), packageModes = variantPackageModes(capturedVariants), variantRows = applyVariantPackageMode(capturedVariants, packageModes);
    var manualVariantAttributes = [];
    if (packageModes.weight) manualVariantAttributes.push('field:weight');
    if (packageModes.dimensions) manualVariantAttributes.push('field:dimensions');
    return {
      collectionId: item.id, title: item.title, name: item.title,
      image: mainImage, img: mainImage, images: image,
      srcUrl: item.sourceUrl, srcPrice: item.price,
      srcNote: notes.filter(Boolean).join('\n'), purchasePrice: item.price,
      packageDimensionSources: Object.assign({}, item.packageDimensionSources || {}),
      manualVariantAttributes: manualVariantAttributes,
      weightG: packaging.weightG || '',
      length: packaging.lengthMm || '',
      width: packaging.widthMm || '',
      height: packaging.heightMm || '',
      description: capturedDescription(item), domesticShipping: domesticShipping == null ? '' : domesticShipping,
      sourceCategoryId: text(sourceCategory.id), sourceCategoryPath: array(sourceCategory.path).map(text).filter(Boolean),
      sourceCategoryMatch: { status: text(categoryMatch.status), method: text(categoryMatch.method), confidence: number(categoryMatch.confidence), requiresReview: Boolean(categoryMatch.requiresReview) },
      category: targetCategory.key, categoryPath: targetCategory.pathText,
      descriptionCategoryId: targetCategory.descriptionCategoryId, typeId: targetCategory.typeId,
      ozonCategoryMatch: item.ozonCategoryMatch || null,
      variants: variantRows.length ? variantRows : [{ name: item.title, image: mainImage, images: image.slice(), video: array(item.capture && item.capture.media).filter(function (media) { return media && text(media.kind).toLowerCase() === 'video' && text(media.role).toLowerCase() === 'main'; }).map(function (media) { return text(media.url || media.src); }).filter(Boolean)[0] || array(standard && standard.media).filter(function (media) { return media && text(media.kind).toLowerCase() === 'video' && (!text(media.role) || text(media.role).toLowerCase() === 'main'); }).map(function (media) { return text(media.url); }).filter(Boolean)[0] || text(item.capture && (item.capture.video || item.capture.videoUrl) || item.video || item.videoUrl), purchase: item.price, domesticShipping: domesticShipping == null ? '' : domesticShipping }]
    };
  }
  function remove(value, ids) {
    var map = Object.create(null); (ids || []).forEach(function (id) { map[text(id)] = true; });
    return normalizeAll(value).filter(function (item) { return !map[item.id]; });
  }
  return { applyOzonMatch: applyOzonMatch, applyPackageMeasurements: applyPackageMeasurements, array: array, categoryMatchInput: categoryMatchInput, createDraft: createDraft, filter: filter, normalize: normalize, normalizeAll: normalizeAll, ozonCategory: ozonCategory, packageSummary: packageSummary, remove: remove, supplementDefaultDimensions: supplementDefaultDimensions, upsert: upsert };
});
