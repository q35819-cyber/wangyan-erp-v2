(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WyCapture = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = '0.1.55';
  const MEDIA_HOSTS = ['alicdn.com', 'alicdn1688.com', '1688img.com', 'cloud.video.taobao.com', 'ozone.ru', 'ozonusercontent.com'];
  const cleanText = (value, limit = 4000) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
  function sourceUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      let match;
      if (['detail.1688.com', 'm.1688.com'].includes(url.hostname) && (match = url.pathname.match(/^\/offer\/(\d+)\.html\/?$/))) {
        return { platform: '1688', productId: match[1], url: 'https://detail.1688.com/offer/' + match[1] + '.html' };
      }
      if (/^(www\.)?ozon\.(ru|by|kz)$/.test(url.hostname) && (match = url.pathname.match(/^\/product\/(?:[^/]*-)?(\d+)\/?$/))) {
        return { platform: 'ozon', productId: match[1], url: url.origin + url.pathname.replace(/\/?$/, '/') };
      }
    } catch (_) { /* Invalid input is not a source URL. */ }
    return null;
  }
  function mediaUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.href.length > 3000) return null;
      if (!MEDIA_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host))) return null;
      // Do not export signed URLs or silently strip signatures into broken links.
      const allowed = new Set(['width', 'height', 'w', 'h', 'quality', 'q', 'format', 'x-oss-process', 'imwidth']);
      for (const key of url.searchParams.keys()) if (!allowed.has(key.toLowerCase())) return null;
      url.hash = '';
      return url.href;
    } catch (_) { return null; }
  }
  function currencyOf(raw, fallback = null) {
    const text = String(raw);
    if (/BYN|бел\.?\s*руб/i.test(text)) return 'BYN';
    if (/KZT|₸|тенге/i.test(text)) return 'KZT';
    if (/RUB|₽|руб/i.test(text)) return 'RUB';
    if (/CNY|RMB|￥|元/.test(text)) return 'CNY';
    // ¥ alone can also mean JPY. Use a verified page context when available.
    if (/¥/.test(text)) return fallback === 'CNY' ? 'CNY' : null;
    return fallback;
  }
  function decimal(value, currency = null) {
    let text = cleanText(value, 120);
    if (/\s/.test(text) && !/^\d{1,3}( \d{3})+(?:[,.]\d{1,4})?$/.test(text)) return null;
    text = text.replace(/[\s\u00a0\u202f]/g, '');
    if (!/^\d[\d.,]*$/.test(text)) return null;
    if (text.includes(',') && text.includes('.')) {
      if (/^\d{1,3}(,\d{3})+\.\d{1,4}$/.test(text)) text = text.replace(/,/g, '');
      else if (/^\d{1,3}(\.\d{3})+,\d{1,4}$/.test(text) && currency !== 'CNY') text = text.replace(/\./g, '').replace(',', '.');
      else return null;
    } else if (text.includes(',')) {
      if (/^\d{1,3}(,\d{3})+$/.test(text) && currency === 'CNY') text = text.replace(/,/g, '');
      else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.');
      else return null;
    }
    if (!/^\d{1,15}(\.\d{1,4})?$/.test(text)) return null;
    return text.replace(/^0+(?=\d)/, '');
  }
  function price(raw, fallback = null, kind = 'display', evidence = 'dom') {
    raw = cleanText(raw, 500);
    if (!raw) return null;
    const currency = currencyOf(raw, fallback);
    const tokens = raw.match(/\d(?:[\d.,\u00a0\u202f ]*\d)?/g) || [];
    const values = tokens.map(token => decimal(token, currency));
    const simple = values.length === 1 && values[0] !== null && !/[-−]\s*\d/.test(raw);
    const range = values.length === 2 && values.every(value => value !== null) && /[-~～–—至]/.test(raw);
    return { kind, currency, amount: simple ? values[0] : null, min: range ? values[0] : null, max: range ? values[1] : null, raw, evidence };
  }
  function csvCell(value) {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function weight(raw, defaultUnit = null) {
    raw = cleanText(raw, 300);
    if (/^\d+(?:[.,]\d{1,4})?$/.test(raw) && /^(?:g|kg)$/i.test(String(defaultUnit || ''))) raw += ' ' + defaultUnit;
    const matches = [...raw.matchAll(/(\d+(?:[.,]\d{1,4})?)\s*(kg|g|千克|公斤|克)\b/gi)];
    // Chinese unit boundaries do not use \b reliably.
    const chinese = [...raw.matchAll(/(\d+(?:[.,]\d{1,4})?)\s*(千克|公斤|克)/g)];
    const match = matches.length === 1 ? matches[0] : !matches.length && chinese.length === 1 ? chinese[0] : null;
    if (!match || /[-−]\s*\d/.test(raw)) return { rawText: raw, grams: null };
    const value = decimal(match[1]);
    if (value === null) return { rawText: raw, grams: null };
    const kg = /^(kg|千克|公斤)$/i.test(match[2]);
    const parts = value.split('.');
    const grams = kg ? (parts[0] + (parts[1] || '').padEnd(3, '0').slice(0, 3)).replace(/^0+(?=\d)/, '') + ((parts[1] || '').length > 3 ? '.' + parts[1].slice(3) : '') : value;
    return { rawText: raw, grams, unit: 'g' };
  }
  function dimensions(raw, defaultUnit = null) {
    raw = cleanText(raw, 300);
    if (/^\d+(?:\.\d{1,4})?\s*[x×*]\s*\d+(?:\.\d{1,4})?\s*[x×*]\s*\d+(?:\.\d{1,4})?$/.test(raw) && /^(?:mm|cm)$/i.test(String(defaultUnit || ''))) raw += ' ' + defaultUnit;
    const match = raw.match(/^(\d+(?:\.\d{1,4})?)\s*[x×*]\s*(\d+(?:\.\d{1,4})?)\s*[x×*]\s*(\d+(?:\.\d{1,4})?)\s*(mm|cm|毫米|厘米)$/i);
    const result = { rawText: raw, lengthMm: null, widthMm: null, heightMm: null };
    if (!match) return result;
    const centimetres = /^(cm|厘米)$/i.test(match[4]);
    const values = match.slice(1, 4).map(value => {
      if (!centimetres) return decimal(value);
      const [whole, fraction = ''] = value.split('.');
      return (whole + (fraction[0] || '0')).replace(/^0+(?=\d)/, '') + (fraction.length > 1 ? '.' + fraction.slice(1) : '');
    });
    if (values.some(value => /^0+(?:\.0+)?$/.test(value))) return result;
    return { rawText: raw, lengthMm: values[0], widthMm: values[1], heightMm: values[2], unit: 'mm' };
  }
  function productDescription(record) {
    const title = cleanText(record?.title, 1000).replace(/[。；;]+$/, '');
    if (!title) return '';
    const attributes = Array.isArray(record?.attributes) ? record.attributes : [];
    const packagingRows = Array.isArray(record?.packagingRows) ? record.packagingRows : [];
    const attribute = names => {
      const wanted = names.map(name => String(name).toLowerCase());
      const item = attributes.find(entry => wanted.includes(cleanText(entry?.name, 100).toLowerCase()));
      return cleanText(item?.value, 1000);
    };
    const facts = [];
    const brand = attribute(['品牌']);
    const material = attribute(['主体材质', '材质', '主要材质']);
    const colours = attribute(['颜色', '款式', '规格']);
    if (brand) facts.push('品牌为' + brand);
    if (material) facts.push('主体材质为' + material);
    const dimensionLabels = [...new Set(packagingRows.map(row => row?.packagingDimensions).filter(item => item && item.lengthMm && item.widthMm && item.heightMm).map(item => {
      const cm = value => {
        const number = Number(value) / 10;
        return Number.isFinite(number) ? String(Number(number.toFixed(4))) : '';
      };
      return [cm(item.lengthMm), cm(item.widthMm), cm(item.heightMm)].join('×') + '厘米';
    }).filter(Boolean))];
    if (dimensionLabels.length === 1) facts.push('包装尺寸为' + dimensionLabels[0]);
    else if (dimensionLabels.length > 1) facts.push('不同款式包装尺寸为' + dimensionLabels.join('、'));
    const weights = [...new Set(packagingRows.map(row => Number(row?.packagingWeight?.grams)).filter(value => Number.isFinite(value) && value > 0))].sort((a, b) => a - b);
    if (weights.length === 1) facts.push('包装重量为' + weights[0] + '克');
    else if (weights.length > 1) facts.push('不同款式包装重量为' + weights[0] + '至' + weights.at(-1) + '克');
    if (colours) facts.push('可选款式为' + colours);
    const paragraphs = [title + '。'];
    if (facts.length) paragraphs.push(facts.join('，') + '。');
    if (/扩香器|扩香木|香薰/i.test(title)) {
      paragraphs.push('适合放置在室内、车内或桌面，作为木质摆件和精油扩香载体使用。');
      paragraphs.push('使用时将少量精油滴在扩香木表面，待木材吸收后自然散香；香味变淡后可按需少量补滴。不同木材的纹理和颜色可能存在自然差异，是否包含精油以所选款式和页面说明为准。');
    } else if (/沥水|水槽置物|碗碟.*置物|置物架/i.test(title)) {
      paragraphs.push('适合在厨房水槽或台面放置碗碟及日常用品，帮助沥水和整理。使用前确认尺寸与安装位置，放稳后再摆放物品，并按需清洁晾干。');
    } else if (/立牌|桌面摆件/i.test(title)) {
      paragraphs.push('适合放置在桌面、书架或展示区域作为装饰摆件。使用时按商品结构完成组装并放置在平稳表面，避免弯折、挤压和高温环境。');
    } else if (/积木|轨道车|拼装玩具/i.test(title)) {
      paragraphs.push('适合按照商品结构进行拼装和轨道搭建。使用前核对配件与适用年龄，按说明完成组装；含小零件时应避免低龄儿童误吞。');
    } else if (/刷|清洁|洗浴/i.test(title)) {
      paragraphs.push('用于标题所示的日常清洁场景。使用前先湿润接触面并少量测试，使用后冲洗干净并放在通风处晾干。');
    } else {
      paragraphs.push('适用于标题所描述的日常场景。使用前请核对所选款式、尺寸、材质和包装信息，并按照商品页面说明操作。');
    }
    return cleanText(paragraphs.join('\n'), 6000);
  }
  function csv(records) {
    const rows = [['平台', '商品ID', '标题', '来源链接', '价格原文', '币种', '主图数', '详情图数', '视频数', '可见规格数', '运费原文', '人工运费', '运费币种', '收货城市', '购买数量', '采集时间', '注意事项']];
    for (const record of records) rows.push([
      record.source.platform, record.source.productId, record.title, record.source.url,
      record.prices.map(item => item.raw).join(' | '), [...new Set(record.prices.map(item => item.currency).filter(Boolean))].join(' / '),
      record.media.filter(item => item.kind === 'image' && item.role === 'main').length,
      record.media.filter(item => item.kind === 'image' && item.role === 'detail').length,
      record.media.filter(item => item.kind === 'video').length, record.variants.length,
      record.shipping.rawText, record.review?.shippingAmount, record.review?.shippingCurrency, record.review?.destinationCity,
      record.review?.quantity, record.source.capturedAt, record.warnings.join(' | ')
    ]);
    return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  }
  function variantKey(variant, record) {
    if (variant.skuId) return 'sku:' + variant.skuId;
    if (variant.url) return 'url:' + variant.url;
    if (record.variants.filter(item => item.label === variant.label).length === 1) return 'label:' + variant.label;
    return 'unresolved:' + record.source.capturedAt + ':' + variant.id;
  }
  function variantsCsv(records) {
    const rows = [['平台','商品ID','SKU ID','规格名','价格原文','币种','库存原文','起批量','混批条件','源页运费原文','源页单件运费','单件核价状态','源页重量g','源页长mm','源页宽mm','源页高mm','人工单件运费','人工运费币种','人工重量g','人工长mm','人工宽mm','人工高mm','核价数量','来源URL']];
    for (const record of records) for (const variant of record.variants) {
      const review = record.review?.variants?.find(item => item.variantKey === variantKey(variant, record));
      rows.push([record.source.platform,record.source.productId,variant.skuId,variant.label,variant.price?.raw,variant.price?.currency,variant.stockText,record.purchaseConditions?.minimumQuantity,record.purchaseConditions?.mixedBatchText,variant.unitShipping?.rawText,variant.unitShipping?.amount,variant.unitShipping?.status,variant.packagingWeight?.grams,variant.packagingDimensions?.lengthMm,variant.packagingDimensions?.widthMm,variant.packagingDimensions?.heightMm,review?.unitShipping?.amount,review?.unitShipping?.currency,review?.packagingWeight?.grams,review?.packagingDimensions?.lengthMm,review?.packagingDimensions?.widthMm,review?.packagingDimensions?.heightMm,1,record.source.url]);
    }
    return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  }
  function mediaFilename(item, record, index) {
    const pathname = new URL(item.url).pathname;
    const ext = pathname.match(/\.(jpe?g|png|webp|avif|gif|mp4|webm|mov)$/i)?.[1]?.toLowerCase();
    return 'wyerp-capture/' + record.source.platform + '-' + record.source.productId + '/' + item.role + '-' + String(index + 1).padStart(3, '0') + '.' + (ext || (item.kind === 'video' ? 'mp4' : 'jpg'));
  }
  return { VERSION, MEDIA_HOSTS, cleanText, sourceUrl, mediaUrl, currencyOf, decimal, price, weight, dimensions, productDescription, csv, variantsCsv, variantKey, csvCell, mediaFilename };
});
