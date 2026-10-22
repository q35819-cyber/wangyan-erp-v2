(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./shared') : root.WyCapture, typeof module === 'object' && module.exports ? require('./analytics') : root.WyAnalytics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WyOzonPublic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, A) {
  'use strict';
  const OZON_HOSTS = new Set(['www.ozon.ru', 'ozon.ru', 'www.ozon.by', 'ozon.by', 'www.ozon.kz', 'ozon.kz']);
  const MAX_RESPONSE = 8 * 1024 * 1024;
  const text = (value, maximum = 2000) => C.cleanText(value, maximum);

  function state(payload, prefix) {
    const states = payload && typeof payload.widgetStates === 'object' ? payload.widgetStates : {};
    const key = Object.keys(states).find(item => item.startsWith(prefix));
    if (!key) return null;
    const value = states[key];
    if (typeof value !== 'string') return value && typeof value === 'object' ? value : null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : null; }
    catch (_) { return null; }
  }

  function numeric(raw) {
    const value = text(raw, 100).replace(/[\u00a0\u2009\s]/g, '').replace(',', '.').replace(/[^\d.]/g, '');
    if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? String(Math.round(number * 10000) / 10000) : null;
  }

  function currency(raw) {
    raw = String(raw || '');
    if (raw.includes('₽') || /\bRUB\b/i.test(raw)) return 'RUB';
    if (raw.includes('₸') || /\bKZT\b/i.test(raw)) return 'KZT';
    if (raw.includes('BYN') || raw.includes('Br')) return 'BYN';
    if (raw.includes('¥') || /\bCNY\b/i.test(raw)) return 'CNY';
    return null;
  }

  function seoProduct(payload) {
    const scripts = Array.isArray(payload?.seo?.script) ? payload.seo.script : [];
    for (const script of scripts) {
      if (String(script?.type || '').toLowerCase() !== 'application/ld+json' || typeof script.innerHTML !== 'string') continue;
      try {
        const value = JSON.parse(script.innerHTML);
        const candidates = Array.isArray(value) ? value : value?.['@graph'] || [value];
        const product = candidates.find(item => String(item?.['@type'] || '').toLowerCase() === 'product');
        if (product) return product;
      } catch (_) { /* malformed page metadata */ }
    }
    return null;
  }

  function jsonLdBrand(value) {
    if (typeof value === 'string') return text(value, 200);
    if (!value || typeof value !== 'object') return '';
    return text(value.name || value.title || value.brand, 200);
  }

  function richText(value) {
    const parts = [];
    const seen = new Set();
    const walk = (item, depth) => {
      if (depth > 12 || parts.join(' ').length > 30000 || item == null) return;
      if (typeof item === 'string') {
        const cleaned = text(item.replace(/<[^>]{1,300}>/g, ' '), 3000);
        if (cleaned && !seen.has(cleaned) && !/^(?:https?:\/\/|#[0-9a-f]{3,8}$)/i.test(cleaned)) { seen.add(cleaned); parts.push(cleaned); }
        return;
      }
      if (Array.isArray(item)) { for (const child of item.slice(0, 500)) walk(child, depth + 1); return; }
      if (typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item).slice(0, 500)) {
        if (/^(?:text|content|title|description|caption)$/i.test(key)) walk(child, depth + 1);
        else if (child && typeof child === 'object') walk(child, depth + 1);
      }
    };
    walk(value, 0);
    return text(parts.join('。'), 30000);
  }

  function addMedia(record, raw, kind, role, evidence) {
    if (!raw || record.media.length >= 250) return;
    const url = C.mediaUrl(typeof raw === 'string' ? raw : raw.src || raw.url || raw.link, record.source.url);
    if (!url) return;
    const identity = kind + ':' + url.replace(/\/(?:wc|ww)\d+\//, '/');
    if (record.media.some(item => item.kind + ':' + item.url.replace(/\/(?:wc|ww)\d+\//, '/') === identity)) return;
    record.media.push({ id: 'media-' + (record.media.length + 1), kind, role, url, evidence });
  }

  function addAttribute(record, name, value, evidence) {
    name = text(name, 200).replace(/[：:]$/, ''); value = text(value, 3000);
    if (!name || !value || record.attributes.length >= 300 || record.attributes.some(item => item.name === name && item.value === value)) return;
    record.attributes.push({ name, value, evidence });
  }

  function publicAttributes(record, payload) {
    const prefixes = ['webCharacteristics-', 'webShortCharacteristics-', 'webCharacteristicsTab-'];
    const visited = new Set();
    const pair = item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      const name = item.title || item.name || item.label;
      const raw = item.value ?? item.text ?? item.description;
      const value = Array.isArray(raw) ? raw.map(child => typeof child === 'object' ? child.value || child.text || child.name : child).filter(Boolean).join(', ') : raw;
      if (typeof name === 'string' && (typeof value === 'string' || typeof value === 'number')) addAttribute(record, name, value, 'ozon.public.widget.characteristics');
    };
    const walk = (item, depth) => {
      if (!item || depth > 9 || visited.size > 5000 || typeof item !== 'object') return;
      if (visited.has(item)) return; visited.add(item);
      if (Array.isArray(item)) { for (const child of item.slice(0, 500)) walk(child, depth + 1); return; }
      pair(item);
      for (const child of Object.values(item).slice(0, 300)) if (child && typeof child === 'object') walk(child, depth + 1);
    };
    for (const prefix of prefixes) walk(state(payload, prefix), 0);
  }

  async function fetchJson(fetcher, url) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
    try {
      const response = await fetcher(url, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' }, ...(controller ? { signal: controller.signal } : {}) });
      if (!response?.ok) throw new Error('HTTP ' + (response?.status || 0));
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE) throw new Error('response_too_large');
      const payload = JSON.parse(raw);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_response');
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('timeout');
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }

  function endpoint(origin, innerPath) {
    const page = new URL(origin);
    if (page.protocol !== 'https:' || !OZON_HOSTS.has(page.hostname) || page.port) throw new Error('unsupported_origin');
    const url = new URL('/api/entrypoint-api.bx/page/json/v2', page.origin);
    url.searchParams.set('url', innerPath);
    return url.href;
  }

  function mergeProduct(record, payload) {
    const heading = state(payload, 'webProductHeading-');
    const price = state(payload, 'webPrice-');
    const gallery = state(payload, 'webGallery-');
    const aspects = state(payload, 'webAspects-');
    const jsonld = seoProduct(payload);
    const title = text(heading?.title || jsonld?.name, 1000);
    if (title) record.title = title;
    const description = text(jsonld?.description, 30000);
    if (description) { record.sourceDescriptionText = description; if (!record.descriptionText) record.descriptionText = description; }
    if (jsonld?.category && !record.categoryPath.length) record.categoryPath = String(jsonld.category).split(/\s*(?:>|＞|›|»)\s*/).map(item => text(item, 120)).filter(Boolean).slice(0, 8);
    const rawPrice = price?.cardPrice || price?.price;
    const parsedPrice = C.price(rawPrice, currency(rawPrice), 'ozon_public_widget', 'ozon.public.widget.price');
    if (parsedPrice && !record.prices.some(item => item.kind === parsedPrice.kind && item.raw === parsedPrice.raw)) record.prices.unshift(parsedPrice);
    for (const image of Array.isArray(gallery?.images) ? gallery.images : []) addMedia(record, image, 'image', 'main', 'ozon.public.widget.gallery');
    for (const video of Array.isArray(gallery?.videos) ? gallery.videos : []) addMedia(record, video, 'video', 'gallery', 'ozon.public.widget.gallery');
    const cover = C.mediaUrl(gallery?.coverImage, record.source.url);
    if (cover) record.primarySkuImage = { label: record.title, url: cover, active: true, evidence: 'ozon.public.widget.gallery.cover' };
    const variants = Array.isArray(aspects?.aspects) ? aspects.aspects.flatMap(item => Array.isArray(item?.variants) ? item.variants : []) : [];
    for (const item of variants.slice(0, 500)) {
      const sku = text(item?.sku, 40); const data = item?.data || {};
      if (!/^\d+$/.test(sku) || record.variants.some(existing => String(existing.skuId || existing.id) === sku)) continue;
      const imageUrl = C.mediaUrl(data.coverImage || data.picture, record.source.url);
      record.variants.push({ id: sku, skuId: sku, label: text(data.title, 500) || sku, url: new URL('/product/' + sku + '/', record.source.url).href, price: C.price(data.cardPrice || data.price, currency(data.cardPrice || data.price), 'variant', 'ozon.public.widget.aspects'), imageUrl: imageUrl || null, stockText: '', evidence: 'ozon.public.widget.aspects' });
      addMedia(record, imageUrl, 'image', 'variant', 'ozon.public.widget.aspects');
    }
    publicAttributes(record, payload);
    const hasBrand = record.attributes.some(item => /^(?:品牌|brand|\u0431\u0440\u0435\u043d\u0434)$/i.test(text(item?.name, 100)));
    if (!hasBrand) {
      const formalBrand = jsonLdBrand(jsonld?.brand);
      if (formalBrand) addAttribute(record, '\u54c1\u724c', formalBrand, 'ozon.public.seo.brand');
    }
  }

  function mergeModalVariants(record, payload) {
    const modal = state(payload, 'webAspectsModal-');
    const variants = Array.isArray(modal?.aspects) ? modal.aspects.flatMap(item => Array.isArray(item?.variants) ? item.variants : []) : [];
    for (const item of variants.slice(0, 500)) {
      const sku = text(item?.sku, 40); const data = item?.data || {};
      if (!/^\d+$/.test(sku) || record.variants.some(existing => String(existing.skuId || existing.id) === sku)) continue;
      const imageUrl = C.mediaUrl(data.coverImage || data.picture, record.source.url);
      record.variants.push({ id: sku, skuId: sku, label: text(data.title, 500) || sku, url: new URL('/product/' + sku + '/', record.source.url).href, price: C.price(data.cardPrice || data.price, currency(data.cardPrice || data.price), 'variant', 'ozon.public.modal.aspects'), imageUrl: imageUrl || null, stockText: '', evidence: 'ozon.public.modal.aspects' });
      addMedia(record, imageUrl, 'image', 'variant', 'ozon.public.modal.aspects');
    }
  }

  function mergeOffers(record, payload) {
    const list = state(payload, 'webSellerList-');
    const sellers = Array.isArray(list?.sellers) ? list.sellers.slice(0, 2000) : [];
    const prices = [];
    record.marketOffers.sellers = Array.isArray(record.marketOffers.sellers) ? record.marketOffers.sellers : [];
    const sameOriginUrl = raw => {
      try {
        const value = new URL(String(raw || ''), record.source.url);
        return value.protocol === 'https:' && value.origin === new URL(record.source.url).origin ? value.href : '';
      } catch (_) { return ''; }
    };
    for (const seller of sellers) {
      const name = text(seller?.name || seller?.seller?.name, 100);
      if (name && !record.marketOffers.sellerNames.includes(name)) record.marketOffers.sellerNames.push(name);
      const raw = seller?.price?.cardPrice?.price || seller?.price?.price || seller?.price;
      const value = numeric(raw); if (value !== null) prices.push(Number(value));
      if (!record.marketOffers.currency) record.marketOffers.currency = currency(raw);
      const sellerId = text(seller?.id || seller?.seller?.id, 40);
      const sellerSku = text(seller?.sku, 40);
      const sellerUrl = sameOriginUrl(seller?.link || (sellerId ? '/seller/' + sellerId + '/' : ''));
      const productUrl = sameOriginUrl(seller?.productLink || (sellerSku ? '/product/' + sellerSku + '/' : ''));
      const logoImageUrl = C.mediaUrl(seller?.logoImageUrl || seller?.seller?.logoImageUrl, record.source.url) || '';
      const rawReviewsCount = Number(seller?.rating?.reviewsCount ?? seller?.seller?.rating?.reviewsCount);
      const reviewsCount = Number.isFinite(rawReviewsCount) ? Math.max(0, Math.trunc(rawReviewsCount)) : null;
      const key = sellerId + ':' + sellerSku;
      if ((name || sellerSku || sellerId) && !record.marketOffers.sellers.some(item => item.key === key)) {
        record.marketOffers.sellers.push({ key, sellerId, sellerSku, name, price: text(raw, 80), sellerUrl, productUrl, logoImageUrl, reviewsCount });
      }
    }
    if (sellers.length) record.marketOffers.offerCount = sellers.length;
    if (prices.length) { record.marketOffers.lowPrice = String(Math.min(...prices)); record.marketOffers.highPrice = String(Math.max(...prices)); }
    if (sellers.length || prices.length) record.marketOffers.evidence.push('ozon.public.modal.other_offers');
  }

  async function enrichOffers(input, options) {
    const record = JSON.parse(JSON.stringify(input));
    if (record?.source?.platform !== 'ozon' || typeof options?.fetch !== 'function') return record;
    const sourceOrigin = new URL(record.source.url).origin;
    const origin = options?.origin || sourceOrigin;
    const sku = String(record.source.productId || '');
    if (origin !== sourceOrigin || !/^\d{3,20}$/.test(sku)) return record;
    record.marketOffers = {
      sellerNames: [], sellers: [], evidence: [],
      ...(record.marketOffers || {})
    };
    const payload = await fetchJson(options.fetch, endpoint(origin, '/modal/otherOffersFromSellers?product_id=' + sku));
    mergeOffers(record, payload);
    const capturedAt = record.source.capturedAt || new Date().toISOString();
    if (A?.publicPage) record.analytics = A.merge(A.publicPage(record, record.source, capturedAt), record.analytics);
    return record;
  }

  async function enrich(input, options) {
    const record = JSON.parse(JSON.stringify(input));
    if (record?.source?.platform !== 'ozon') return record;
    const fetcher = options?.fetch;
    if (typeof fetcher !== 'function') return record;
    const sourceOrigin = new URL(record.source.url).origin;
    const origin = options?.origin || sourceOrigin;
    if (origin !== sourceOrigin) return record;
    const sku = String(record.source.productId || '');
    if (!/^\d{3,20}$/.test(sku)) return record;
    const sourceUrl = new URL(record.source.url);
    const sourcePath = sourceUrl.pathname.includes('/product/') && sourceUrl.pathname.includes(sku)
      ? sourceUrl.pathname + sourceUrl.search
      : '/product/' + sku + '/';
    const descriptionUrl = new URL(sourcePath, sourceUrl.origin);
    descriptionUrl.searchParams.set('layout_container', 'pdpPage2column');
    descriptionUrl.searchParams.set('layout_page_index', '2');
    const requests = [
      ['product', sourcePath],
      ['description', descriptionUrl.pathname + descriptionUrl.search],
      ['variants', '/modal/aspectsNew?product_id=' + sku],
      ['offers', '/modal/otherOffersFromSellers?product_id=' + sku]
    ];
    const fetchWithin = (item, milliseconds = 4000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(item[0] + ' timeout')), milliseconds);
      fetchJson(fetcher, endpoint(origin, item[1])).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    const settled = await Promise.allSettled(requests.map(item => fetchWithin(item)));
    const failures = [];
    settled.forEach((item, index) => {
      const key = requests[index][0];
      if (item.status === 'rejected') { failures.push(key + ':' + text(item.reason?.message || 'failed', 80)); return; }
      if (key === 'product') mergeProduct(record, item.value);
      else if (key === 'description') {
        const description = state(item.value, 'webDescription-');
        const value = richText(description?.richAnnotationJson);
        if (value) { record.structuredDescriptionText = value; if (!record.sourceDescriptionText) record.sourceDescriptionText = value; if (!record.descriptionText) record.descriptionText = value; }
      } else if (key === 'variants') mergeModalVariants(record, item.value);
      else if (key === 'offers') mergeOffers(record, item.value);
    });
    record.completeness = { ...(record.completeness || {}), ozonPublicApi: failures.length ? 'partial' : 'complete' };
    record.source.mode = record.source.mode === 'rendered_dom' ? 'rendered_dom+ozon_public_json' : text(record.source.mode, 80);
    record.warnings = Array.isArray(record.warnings) ? record.warnings : [];
    if (failures.length) record.warnings.push('Ozon公开商品JSON部分读取失败：' + failures.join('；'));
    if (A?.publicPage) record.analytics = A.merge(A.publicPage(record, record.source, record.source.capturedAt), record.analytics);
    return record;
  }

  return { OZON_HOSTS, state, numeric, currency, seoProduct, richText, endpoint, mergeProduct, mergeModalVariants, mergeOffers, enrichOffers, enrich };
});
