(function (root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./shared') : root.WyCapture, typeof module === 'object' && module.exports ? require('./analytics') : root.WyAnalytics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WyCollector = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, A) {
  'use strict';
  function extract(doc, pageUrl, now = new Date().toISOString()) {
    const source = C.sourceUrl(pageUrl);
    if (!source) throw new Error('仅支持1688详情页和Ozon商城商品页，不支持列表或卖家后台。');
    const ali = source.platform === '1688';
    let fallback = ali ? 'CNY' : null;
    let aliVisibleText = '';
    const all = (selector, parent = doc) => {
      const nodes = parent.querySelectorAll(selector);
      const values = [];
      for (let index = 0, count = Math.min(nodes.length, 1000); index < count; index += 1) values.push(nodes[index]);
      return values;
    };
    const txt = (node, limit = 4000) => C.cleanText(node?.textContent, limit);
    const descriptiveText = (parent, limit = 20000) => {
      if (!parent || !doc.createTreeWalker) return '';
      const walker = doc.createTreeWalker(parent, doc.defaultView?.NodeFilter?.SHOW_TEXT || 4);
      const parts = [];
      for (let node = walker.nextNode(), seen = 0; node && seen < 30000; node = walker.nextNode(), seen += 1) {
        const element = node.parentElement;
        if (element?.closest?.('script,style,noscript,template,[hidden],[aria-hidden="true"]')) continue;
        const value = C.cleanText(node.nodeValue, 2000);
        if (value) parts.push(value);
        if (parts.join(' ').length >= limit) break;
      }
      return C.cleanText(parts.join(' '), limit);
    };
    const first = (selectors, parent = doc) => {
      for (const selector of selectors) { const value = txt(parent.querySelector(selector)); if (value) return value; }
      return '';
    };
    function tableGrid(table) {
      const grid = [];
      const rows = Array.from(table.rows || []).slice(0, 1000);
      rows.forEach((row, r) => {
        if (!grid[r]) grid[r] = [];
        let column = 0;
        for (const cell of Array.from(row.cells).slice(0, 50)) {
          while (grid[r][column] && column < 50) column++;
          const down = Math.min(cell.rowSpan || 1, 1000 - r); const across = Math.min(cell.colSpan || 1, 50 - column);
          for (let y = 0; y < down; y++) { if (!grid[r + y]) grid[r + y] = []; for (let x = 0; x < across; x++) grid[r + y][column + x] = cell; }
          column += across;
        }
      });
      return grid;
    }
    const warnings = [];
    const result = {
      schemaVersion: 1, adapterVersion: C.VERSION,
      source: { ...source, capturedAt: now, mode: 'rendered_dom', trust: 'unverified' },
      title: '', descriptionText: '', sourceDescriptionText: '', structuredDescriptionText: '', descriptionGeneration: null,
      categoryPath: [], categoryEvidence: { pagePath: [], pageCategoryIds: [], signals: [] }, categoryMatch: null,
      supplier: { name: '' }, minimumOrderText: '', inventoryText: '',
      purchaseConditions: { minimumQuantity: null, minimumUnit: null, mixedBatchText: '', unitQuoteStatus: 'unknown' },
      media: [], prices: [], variants: [], variationOptions: [], skuImages: [], primarySkuImage: null, attributes: [], measurements: [], packagingRows: [],
      marketOffers: { sellers: [], sellerNames: [], offerCount: null, lowPrice: null, highPrice: null, currency: null, evidence: [] },
      shipping: { status: 'unknown', amount: null, currency: fallback, rawText: '', quantity: 1, isStartingPrice: false, calculationBasis: 'minimum_order_quantity', contextVerified: false },
      warnings, completeness: { variants: 'observed_only', details: 'loaded_only' }
    };
    const mediaSeen = new Map();
    const selectedQuantities = [];
    let rejectedMedia = 0;
    function addMedia(raw, kind, role, evidence) {
      if (!raw || result.media.length >= 250) return;
      const url = C.mediaUrl(raw, pageUrl);
      if (!url) { rejectedMedia++; return; }
      if (!ali && kind === 'image' && /\/video-[^/]+\/.*\/cover\//.test(url)) role = 'video_cover';
      // Retain roles when a SKU reuses a main image.
      // Select only URLs actually present in DOM; never invent CDN originals.
      const identity = source.platform === 'ozon' ? url.replace(/\/(?:wc|ww)\d+\//, '/') : url;
      const resolution = source.platform === 'ozon' ? Number(url.match(/\/(?:wc|ww)(\d+)\//)?.[1] || 100000) : 0;
      const key = kind + ':' + role + ':' + identity;
      if (mediaSeen.has(key)) {
        const previous = mediaSeen.get(key);
        if (resolution > previous.resolution) { previous.item.url = url; previous.item.evidence = evidence; previous.resolution = resolution; }
        return;
      }
      const item = { id: 'media-' + (result.media.length + 1), kind, role, url, evidence };
      mediaSeen.set(key, { item, resolution });
      result.media.push(item);
    }
    function aliOriginalImageUrl(value) {
      const url = C.mediaUrl(value || '', pageUrl);
      if (!url) return '';
      try {
        const parsed = new URL(url);
        if (!/(?:^|\.)alicdn(?:1688)?\.com$/i.test(parsed.hostname) && !/(?:^|\.)1688img\.com$/i.test(parsed.hostname)) return url;
        parsed.pathname = parsed.pathname.replace(/\.jpg_(?:sum|b)\.jpg$/i, '.jpg');
        return parsed.href;
      } catch (_) { return url; }
    }
    function aliImageUrl(node) {
      if (!node) return '';
      const candidates = ['data-original', 'data-src', 'data-lazy-src', 'data-lazyload-src', 'data-lazy'].map(name => node.getAttribute?.(name));
      const srcsets = [node, ...Array.from(node.querySelectorAll?.('source[srcset], img[srcset]') || [])]
        .flatMap(item => (item.getAttribute?.('srcset') || '').split(',').map(part => part.trim().split(/\s+/)[0])).filter(Boolean).reverse();
      candidates.push(...srcsets, node.getAttribute?.('src'));
      const child = node.matches?.('img,source') ? null : node.querySelector?.('img,source');
      if (child) candidates.push(...['data-original', 'data-src', 'data-lazy-src', 'data-lazyload-src', 'data-lazy', 'src'].map(name => child.getAttribute?.(name)));
      const styled = node.matches?.('img,source') ? node.parentElement : node;
      const background = styled && (doc.defaultView?.getComputedStyle?.(styled).backgroundImage || styled.getAttribute?.('style'));
      candidates.push(background?.match(/url\(["']?([^"')]+)["']?\)/)?.[1]);
      return candidates.map(aliOriginalImageUrl).find(Boolean) || '';
    }
    function aliImageIdentity(value) {
      try { return new URL(value).pathname.replace(/_(?:sum\.jpg|\.(?:webp|avif))$/i, ''); } catch (_) { return ''; }
    }
    function imageNodes(selector, role, parent = doc) {
      const urls = [];
      for (const node of all(selector, parent)) {
        if (!ali) {
          const candidates = ['data-original', 'data-src', 'data-lazy-src', 'src'].map(name => node.getAttribute(name));
          candidates.push(...(node.getAttribute('srcset') || '').split(',').map(part => part.trim().split(/\s+/)[0]));
          for (const value of new Set(candidates.filter(Boolean))) {
            const url = C.mediaUrl(value, pageUrl); if (url) urls.push(url);
            addMedia(value, 'image', role, selector);
          }
          continue;
        }
        const url = aliImageUrl(node);
        if (url) urls.push(url);
        addMedia(url, 'image', role, selector);
      }
      return [...new Set(urls)];
    }
    function addPrice(raw, kind, evidence) {
      const value = C.price(raw, fallback, kind, evidence);
      if (value && !result.prices.some(item => item.kind === value.kind && item.raw === value.raw)) result.prices.push(value);
    }
    function addAttribute(name, value, evidence) {
      name = C.cleanText(name, 200).replace(/[：:]$/, ''); value = C.cleanText(value, 3000);
      if (!name || !value || result.attributes.length >= 300 || result.attributes.some(item => item.name === name && item.value === value)) return;
      result.attributes.push({ name, value, evidence });
    }
    function addCategoryPath(value, evidence) {
      const values = (Array.isArray(value) ? value : [value]).flatMap(item => typeof item === 'string' ? item.split(/\s*(?:>|＞|›|»)\s*/) : [item])
        .map(item => C.cleanText(item && typeof item === 'object' ? item.name || item.title || item.label : item, 120))
        .filter(item => item && !/^(?:首页|1688首页|商品详情|全部商品)$/.test(item)).slice(0, 8);
      if (!values.length) return;
      if (values.length > result.categoryEvidence.pagePath.length) result.categoryEvidence.pagePath = values;
      if (!result.categoryEvidence.signals.some(item => item.kind === 'page_path' && item.value === values.join(' / '))) {
        result.categoryEvidence.signals.push({ kind: 'page_path', value: values.join(' / '), evidence });
      }
    }
    function categoryIdFromUrl(raw) {
      try {
        const parsed = new URL(raw, pageUrl);
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== 'https:' || !(host === '1688.com' || host.endsWith('.1688.com') || host === 'alibaba.com' || host.endsWith('.alibaba.com'))) return '';
        for (const name of ['categoryId', 'category_id', 'catId', 'cat_id', 'cid']) {
          const value = parsed.searchParams.get(name);
          if (/^\d{1,20}$/.test(value || '')) return value;
        }
        return parsed.pathname.match(/\/(?:category|cat)[_/-](\d{1,20})(?:\/|\.|$)/i)?.[1] || '';
      } catch (_) { return ''; }
    }
    function addCategoryId(value, evidence) {
      value = String(value || '').trim();
      if (!/^\d{1,20}$/.test(value) || result.categoryEvidence.pageCategoryIds.some(item => item.id === value)) return;
      result.categoryEvidence.pageCategoryIds.push({ id: value, evidence });
    }
    function visibleSellerCategory() {
      const rootNode = doc.body || doc.documentElement;
      if (!ali || !rootNode || !doc.createTreeWalker) return '';
      const walker = doc.createTreeWalker(rootNode, doc.defaultView?.NodeFilter?.SHOW_TEXT || 4);
      for (let node = walker.nextNode(), seen = 0; node && seen < 30000; node = walker.nextNode(), seen += 1) {
        const raw = String(node.nodeValue || '');
        if (!raw || raw.length > 60 || node.parentElement?.closest?.('script,style,noscript,template,[hidden],[aria-hidden="true"]')) continue;
        const match = C.cleanText(raw, 60).match(/^(?:主营|主营类目)[：:]\s*([\u4e00-\u9fffA-Za-z0-9/、&· -]{1,30})$/);
        if (match) return C.cleanText(match[1], 30);
      }
      return '';
    }
    function visibleMinimumOrder() {
      const rootNode = doc.body || doc.documentElement;
      if (!rootNode || !doc.createTreeWalker) return null;
      const walker = doc.createTreeWalker(rootNode, doc.defaultView?.NodeFilter?.SHOW_TEXT || 4);
      for (let node = walker.nextNode(), seen = 0; node && seen < 25000; node = walker.nextNode(), seen += 1) {
        const raw = String(node.nodeValue || '');
        if (!raw || raw.length > 40) continue;
        const match = C.cleanText(raw, 40).match(/^([1-9]\d{0,5})\s*(个|件|套|包|盒|枚|条|组|份|支|台|只|对|张)\s*起批$/);
        const parent = node.parentElement;
        if (!match || !parent || parent.closest('script,style,noscript,template,[hidden],[aria-hidden="true"]')) continue;
        const style = doc.defaultView?.getComputedStyle?.(parent);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
        return match;
      }
      return null;
    }
    function visibleQuantityQuote(minimumMatch) {
      const rootNode = doc.body || doc.documentElement;
      if (!minimumMatch || !rootNode || !doc.createTreeWalker) return null;
      const wantedQuantity = Number(minimumMatch[1]);
      const walker = doc.createTreeWalker(rootNode, doc.defaultView?.NodeFilter?.SHOW_TEXT || 4);
      for (let node = walker.nextNode(), seen = 0; node && seen < 100000; node = walker.nextNode(), seen += 1) {
        const label = C.cleanText(node.nodeValue, 60);
        const labelMatch = label.match(/^([1-9]\d{0,5})\s*(个|件|套|包|盒|枚|条|组|份|支|台|只|对|张)\s*(?:价格|价)$/);
        if (!labelMatch || Number(labelMatch[1]) !== wantedQuantity) continue;
        const parent = node.parentElement;
        if (!parent || parent.closest('script,style,noscript,template,[hidden],[aria-hidden="true"]')) continue;
        const style = doc.defaultView?.getComputedStyle?.(parent);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
        let container = parent;
        for (let depth = 0; container && depth < 6; depth += 1, container = container.parentElement) {
          const original = String(container.textContent || '');
          if (original.length > 1200) break;
          const context = descriptiveText(container, 1200);
          const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const amount = context.match(new RegExp(escapedLabel + '\\s*[¥￥]?\\s*(\\d[\\d,]*(?:\\.\\d{1,4})?)'))?.[1];
          if (amount) return { amount, quantity: wantedQuantity, unit: labelMatch[2], label };
        }
      }
      return null;
    }
    function shippingQuote(value) {
      const normalized = C.cleanText(value, 1500);
      if (!normalized) return '';
      const fee = normalized.match(/(?:运费|快递费)\s*[¥￥]?\s*\d+(?:\.\d{1,4})?\s*(?:元)?\s*(?:起)?/);
      if (fee) return fee[0];
      return /^(?:(?:运费|快递费)\s*)?包邮$/.test(normalized) ? normalized : '';
    }
    // Only JSON-LD Product facts are used. No app state, cookies, localStorage or arbitrary script execution.
    const products = [];
    function visit(value, depth = 0) {
      if (depth > 8 || products.length > 100 || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.slice(0, 100).forEach(item => visit(item, depth + 1)); return; }
      const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
      if (types.includes('Product')) products.push(value);
      for (const key of ['@graph', 'mainEntity']) if (value[key]) visit(value[key], depth + 1);
    }
    for (const script of all('script[type="application/ld+json"]')) {
      if (script.textContent.length > 1000000) { warnings.push('跳过超过1MB的结构化数据'); continue; }
      try { visit(JSON.parse(script.textContent)); } catch (_) { warnings.push('页面结构化数据格式错误，已改用DOM'); }
    }
    const matchProduct = value => {
      const parsed = C.sourceUrl(value.url || value['@id'] || (!Array.isArray(value.offers) && value.offers?.url));
      return parsed && parsed.productId === source.productId && parsed.platform === source.platform;
    };
    const product = products.find(matchProduct) || (products.length === 1 && !products[0].url && !products[0]['@id'] ? products[0] : null);
    if (product) {
      result.title = C.cleanText(product.name, 1000);
      if (typeof product.description === 'string') { result.structuredDescriptionText = C.cleanText(product.description, 20000); result.descriptionText = result.structuredDescriptionText; }
      for (const item of [].concat(product.image || [])) addMedia(typeof item === 'string' ? item : item.url || item.contentUrl, 'image', 'main', 'jsonld.image');
      for (const item of [].concat(product.video || [])) addMedia(typeof item === 'string' ? item : item.contentUrl, 'video', 'main', 'jsonld.video');
      for (const offer of [].concat(product.offers || []).slice(0, 100)) {
        if (!offer || typeof offer !== 'object') continue;
        const currency = ['CNY', 'RUB', 'BYN', 'KZT'].includes(offer.priceCurrency) ? offer.priceCurrency : fallback;
        if (!ali && currency === 'CNY') fallback = 'CNY';
        const raw = offer.price !== undefined ? String(offer.price) : offer.lowPrice !== undefined && offer.highPrice !== undefined ? offer.lowPrice + '–' + offer.highPrice : '';
        const value = C.price(raw, currency, offer.lowPrice !== undefined ? 'range' : 'structured_offer', 'jsonld.offers');
        if (value) result.prices.push(value);
        if (offer.availability) result.inventoryText = C.cleanText(offer.availability, 300);
        if (!ali) {
          if (Number.isInteger(Number(offer.offerCount)) && Number(offer.offerCount) > 0) result.marketOffers.offerCount = Number(offer.offerCount);
          if (offer.lowPrice !== undefined && /^\d+(?:\.\d{1,4})?$/.test(String(offer.lowPrice))) result.marketOffers.lowPrice = String(offer.lowPrice);
          if (offer.highPrice !== undefined && /^\d+(?:\.\d{1,4})?$/.test(String(offer.highPrice))) result.marketOffers.highPrice = String(offer.highPrice);
          if (currency) result.marketOffers.currency = currency;
          const seller = C.cleanText(typeof offer.seller === 'string' ? offer.seller : offer.seller?.name, 100);
          if (seller && !result.marketOffers.sellerNames.includes(seller)) result.marketOffers.sellerNames.push(seller);
          if (result.marketOffers.offerCount || result.marketOffers.lowPrice || result.marketOffers.highPrice || seller) result.marketOffers.evidence.push('jsonld.offers');
        }
      }
      for (const item of [].concat(product.additionalProperty || [])) if (item) addAttribute(item.name, item.value, 'jsonld.additionalProperty');
      if (product.brand) addAttribute('品牌', typeof product.brand === 'string' ? product.brand : product.brand.name, 'jsonld.brand');
      if (typeof product.category === 'string' || Array.isArray(product.category)) addCategoryPath(product.category, 'jsonld.category');
      else if (product.category && typeof product.category === 'object') {
        addCategoryPath(product.category.name, 'jsonld.category.name');
        addCategoryId(product.category.categoryId || product.category.identifier, 'jsonld.category.id');
        addCategoryId(categoryIdFromUrl(product.category.url || product.category['@id']), 'jsonld.category.url');
      }
    }
    const title = first(ali ? ['.title-text', '.title-content h1', '.title-content', 'h1'] : ['[data-widget="webProductHeading"] h1', 'h1']);
    if (title) result.title = title;
    if (!result.title) result.title = C.cleanText(doc.querySelector('meta[property="og:title"]')?.content, 1000);
    if (!result.title) throw new Error('未读取到商品标题；请先登录、完成验证或等待商品页加载后重试。');
    addMedia(doc.querySelector('meta[property="og:image"]')?.content, 'image', 'main', 'og:image');
    const galleryImages = imageNodes(ali ? '.gallery-img img, .main-image img, .detail-gallery-img img, .thumb-img img, .thumbnail img, [data-gallery] img, .od-gallery-list img.preview-img, .od-picture-gallery-list img.preview-img, .gallery-magnifier-preview img, .detail-gallery img, .preview-list img, .fd-clr img, .od-pc-offer-tab img, .offer-detail-tab img, .main-pic img, .pic-view img, .preview-wrap img, .detail-pic img, .product-image img, .offer-image img' : '[data-widget="webGallery"] img, [data-widget="webGalleryMobile"] img', 'main');
    const detailSelectors = ali ? ['#detailContentContainer', '.html-description', '#desc-lazyload-container'] : ['[data-widget="webDescription"]', '[data-widget="webRichContent"]', '[data-widget="webDescriptionText"]'];
    const descriptions = [];
    const detailRoots = container => {
      const roots = [container], seen = new Set([container]);
      for (let index = 0; index < roots.length && roots.length < 200; index += 1) {
        const current = roots[index];
        if (current?.shadowRoot && !seen.has(current.shadowRoot)) { seen.add(current.shadowRoot); roots.push(current.shadowRoot); }
        for (const node of all('*', current)) if (node.shadowRoot && !seen.has(node.shadowRoot)) { seen.add(node.shadowRoot); roots.push(node.shadowRoot); }
      }
      return roots;
    };
    for (const selector of detailSelectors) for (const container of all(selector)) {
      for (const parent of detailRoots(container)) {
        imageNodes('img', 'detail', parent);
        const detailText = descriptiveText(parent, 20000); if (detailText) descriptions.push(detailText);
        for (const node of all('video[src], video source[src]', parent)) addMedia(node.getAttribute('src'), 'video', 'detail', selector);
      }
    }
    if (descriptions.length) {
      result.sourceDescriptionText = C.cleanText([...new Set(descriptions)].join('\n'), 20000);
      result.descriptionText = result.sourceDescriptionText;
    }
    for (const node of all(ali ? '.gallery video[src], .gallery source[src], .video-player video[src], .video-player source[src], video[src], video source[src]' : '[data-widget="webGallery"] video[src], [data-widget="webGallery"] video source[src]')) addMedia(node.getAttribute('src'), 'video', 'main', 'video/source');
    const priceSelector = ali ? '.price-component .price-text, .price-component .price, .price-text, .price-range, .price-item .price, [data-price]' : '[data-widget="webPrice"] [data-price], [data-widget="webPrice"] [data-price-type], [data-widget="webPrice"] span';
    for (const node of all(priceSelector)) {
      const raw = txt(node, 500);
      const moneyPattern = /₽|руб|RUB|BYN|KZT|₸|тенге|CNY|[¥￥]/i;
      if (!/\d/.test(raw) || (!ali && !moneyPattern.test(raw))) continue;
      if (!ali && all('span', node).some(child => /\d/.test(txt(child)) && moneyPattern.test(txt(child)))) continue;
      let context = txt(node.parentElement, 500);
      if (!ali && node.parentElement?.parentElement && txt(node.parentElement.parentElement).length < 180) context = txt(node.parentElement.parentElement);
      const type = node.getAttribute('data-price-type');
      const struck = !!node.closest('del,s') || (doc.defaultView && doc.defaultView.getComputedStyle(node).textDecorationLine.includes('line-through'));
      const kind = type || (struck ? 'original' : /с другими банками/i.test(context) ? 'display' : /(?:с картой|ozon карт|Ozon卡)/i.test(context) ? 'card' : /с банками/i.test(context) ? 'bank' : 'display');
      addPrice(raw, C.cleanText(kind, 50), priceSelector);
    }
    if (ali) {
      // Both bounds must carry a currency symbol. Without that guard, text such as
      // "￥12.50 2–9件" can join the unit price and the tier quantity into a false range.
      const rangePattern = /(?:[¥￥]\s*\d[\d,]*(?:\.\d{1,4})?\s*[~～–—至]\s*[¥￥]\s*\d[\d,]*(?:\.\d{1,4})?|\d[\d,]*\.\d{1,4}\s*[~～]\s*\d[\d,]*\.\d{1,4})/;
      let visibleRange = null;
      // Keep this scan bounded and avoid every generic div: reading textContent from
      // thousands of large ancestor nodes can stall a real 1688 product page.
      const rangeNodes = all('.price-component, .price-info, .price-section, [class*="price"], span');
      for (const node of rangeNodes) {
        if (node.childElementCount > 20) continue;
        const raw = txt(node, 300); const match = raw.match(rangePattern);
        if (!match || visibleRange && visibleRange.contextLength <= raw.length) continue;
        visibleRange = { raw: match[0], contextLength: raw.length };
      }
      if (!visibleRange && doc.createTreeWalker) {
        // The current 1688 trade panel can appear late in DOM order and split
        // "5.98 ~ 10.92" across sibling spans. Locate the rare separator text
        // first, then inspect only its small ancestors instead of scanning every div.
        const walker = doc.createTreeWalker(doc.body || doc.documentElement, doc.defaultView?.NodeFilter?.SHOW_TEXT || 4);
        for (let node = walker.nextNode(), seen = 0; node && seen < 100000 && !visibleRange; node = walker.nextNode(), seen += 1) {
          if (!/[~～]/.test(String(node.nodeValue || ''))) continue;
          let container = node.parentElement;
          for (let depth = 0; container && depth < 5; depth += 1, container = container.parentElement) {
            const original = String(container.textContent || '');
            if (original.length > 800) break;
            const raw = descriptiveText(container, 800); const match = raw.match(rangePattern);
            if (match) { visibleRange = { raw: match[0], contextLength: raw.length }; break; }
          }
        }
      }
      const tradeTexts = [];
      for (const anchor of all('.expand-view-item, .sku-item-wrapper, .sku-item, [data-sku-id]')) {
        let container = anchor;
        for (let depth = 0; container?.parentElement && depth < 10; depth += 1) {
          container = container.parentElement;
          const original = String(container.textContent || '');
          if (original.length > 20000) break;
          const raw = descriptiveText(container, 20000);
          if (raw) tradeTexts.push(raw);
          const match = raw.match(rangePattern);
          if (match && (!visibleRange || raw.length < visibleRange.contextLength)) visibleRange = { raw: match[0], contextLength: raw.length };
        }
        if (visibleRange) break;
      }
      // Some 1688 layouts split the range into sibling nodes or put more than
      // 1000 spans before it. A single bounded visible-text pass preserves the
      // exact displayed range without joining hidden script/style contents.
      aliVisibleText = C.cleanText(descriptiveText(doc.body || doc.documentElement, 300000) + ' ' + tradeTexts.join(' '), 350000);
      if (!visibleRange) {
        const match = aliVisibleText.match(rangePattern);
        if (match) visibleRange = { raw: match[0], contextLength: match[0].length };
      }
      if (visibleRange) addPrice(visibleRange.raw, 'range', 'dom.visible-price-range');
    }
    if (ali) {
      const skuImageContainers = all('.sku-filter-button, .prop-item-inner-wrapper, .selector-prop-item');
      for (const option of skuImageContainers.slice(0, 500)) {
        const label = first(['.label-name', '.sku-item-name', '.prop-name', '.name'], option) || txt(option, 300);
        const thumbnailUrl = aliImageUrl(option);
        const identity = aliImageIdentity(thumbnailUrl);
        const galleryMatch = identity && galleryImages.find(url => aliImageIdentity(url) === identity);
        const url = galleryMatch || thumbnailUrl;
        if (!label || !url || result.skuImages.some(item => item.label === label && item.url === url)) continue;
        const active = option.matches('.active,.selected,[aria-selected="true"],[aria-checked="true"]') || Boolean(option.querySelector('.active,.selected,[aria-selected="true"],[aria-checked="true"]'));
        const item = { label, url, thumbnailUrl, active, evidence: galleryMatch ? 'dom.sku-option-image+dom.gallery-image-match' : 'dom.sku-option-image' };
        result.skuImages.push(item);
        addMedia(url, 'image', 'variant', item.evidence);
      }
      const preferredSkuImage = result.skuImages.find(item => item.active) || result.skuImages[0];
      if (preferredSkuImage) result.primarySkuImage = { ...preferredSkuImage };
      else if (galleryImages[0]) result.primarySkuImage = { label: '', url: galleryImages[0], active: true, evidence: 'dom.gallery-active-sku-fallback' };
      for (const row of all('.price-item, .price-range-item')) {
        const rawPrice = first(['.price', '.price-text'], row);
        const quantity = first(['.amount', '.quantity', '.range', '.begin-amount'], row);
        if (rawPrice && quantity) { const value = C.price(rawPrice, 'CNY', 'tier', 'dom.price-item'); value.quantityText = quantity; result.prices.push(value); }
      }
      for (const row of all('.offer-attr-item, .attr-item, .product-attr-item')) addAttribute(first(['.offer-attr-item-name', '.attr-name', '.attr-key', '.name'], row), first(['.offer-attr-item-value', '.attr-value', '.value'], row), 'dom.attributes');
      for (const row of all('.attr-table tr, .product-params tr, #productAttributes tr')) {
        const cells = all('th,td', row);
        for (let i = 0; i + 1 < cells.length; i += 2) addAttribute(txt(cells[i]), txt(cells[i + 1]), 'dom.attribute-table');
      }
      for (const label of all('#productAttributes .ant-descriptions-item-label')) addAttribute(txt(label), txt(label.nextElementSibling), 'dom.ant-descriptions');
      for (const row of all('#productAttributes .ant-descriptions-row')) {
        const labels = all('.ant-descriptions-item-label span', row); const values = all('.ant-descriptions-item-content .field-value', row);
        for (let index = 0; index < Math.min(labels.length, values.length); index++) addAttribute(txt(labels[index]), txt(values[index]), 'dom.ant-descriptions.row');
      }
      const rowSelectors = ['.sku-item-wrapper', '.expand-view-item', '.sku-list-item', '.single-sku-list-wrap', '.next-table-body table tr'];
      const rows = rowSelectors.map(selector => ({ selector, nodes: all(selector) })).find(group => group.nodes.length);
      if (rows) for (const row of rows.nodes.slice(0, 500)) {
        const label = first(['.sku-item-name', '.sku-item-name-text', '.item-label', '.sku-name', '.single-sku-title span:nth-child(2)', 'span.normal-text'], row);
        if (!label) continue;
        let rawPrice = first(['.discountPrice-price', '.sku-item-price', '.item-price', '.price', '.single-price-warp .price-title'], row);
        if (!rawPrice) {
          const combined = first(['.item-price-stock'], row);
          rawPrice = combined.match(/[¥￥]\s*\d[\d,]*(?:\.\d{1,4})?/)?.[0] || combined.match(/^\s*\d[\d,]*(?:\.\d{1,4})?\s*(?:元)?(?=\s*库存)/)?.[0] || '';
        }
        const img = row.querySelector('img, picture source');
        let imageUrl = aliImageUrl(img);
        if (!imageUrl) {
          const backgroundNode = row.querySelector('.sku-item-image, .single-sku-img-pop, .od-gyp-pc-sku-selection-sku');
          const background = backgroundNode && (doc.defaultView?.getComputedStyle(backgroundNode).backgroundImage || backgroundNode.getAttribute('style'));
          imageUrl = aliOriginalImageUrl(background?.match(/url\(["']?([^"')]+)["']?\)/)?.[1] || '');
        }
        const variant = { id: 'row-' + (result.variants.length + 1), skuId: C.cleanText(row.getAttribute('data-sku-id'), 120) || null, label, price: C.price(rawPrice, 'CNY', 'sku', rows.selector), imageUrl, stockText: first(['.stock', '.sku-stock', '.item-stock'], row), evidence: rows.selector };
        if (!variant.stockText) variant.stockText = txt(row, 2000).match(/(?:库存|剩余)\s*\d[\d,.]*\s*(?:万|千|[kK])?\+?\s*(?:个|件|套|包)?/)?.[0] || '';
        const shippingText = first(['.sku-shipping-fee', '.freight-price', '.shipping-fee'], row);
        variant.unitShipping = { quantity: null, amount: null, currency: 'CNY', rawText: shippingText, isStartingPrice: /起/.test(shippingText), calculationBasis: 'minimum_order_quantity', status: 'unverified' };
        const weightText = first(['.sku-weight', '.package-weight', '.packing-weight'], row);
        variant.packagingWeight = { ...C.weight(weightText), evidence: weightText ? rows.selector : null };
        const dimensionText = first(['.sku-package-dimensions', '.package-dimensions', '.packing-dimensions'], row);
        variant.packagingDimensions = { ...C.dimensions(dimensionText), evidence: dimensionText ? rows.selector : null };
        const quantityInput = row.querySelector('input[type="number"], input[role="spinbutton"], .next-number-picker-input, .ant-input-number-input');
        const quantity = quantityInput ? String(quantityInput.value || quantityInput.getAttribute('aria-valuenow') || '') : '';
        if (/^\d+$/.test(quantity) && Number(quantity) > 0) selectedQuantities.push({ variant, quantity: Number(quantity) });
        result.variants.push(variant); addMedia(imageUrl, 'image', 'variant', rows.selector);
      }
      for (const group of all('.sku-prop, .sku-props-item, .sku-props-list, .sku-filter')) {
        const name = first(['.prop-title', '.sku-prop-title', '.sku-props-name', '.sku-filter-title'], group) || '未标注规格维度';
        const values = all('.prop-item-inner-wrapper, .selector-prop-item, .sku-filter-button', group).map(node => txt(node, 300)).filter(Boolean);
        if (values.length) result.variationOptions.push({ name, values: [...new Set(values)], evidence: 'dom.options' });
      }
      result.supplier.name = first(['.company-name', '.company-title', '.shop-name']);
      result.minimumOrderText = first(['.min-order', '.min-order-quantity', '.amount-unit']);
      const conditionTexts = all('.price-component, .price-info, .price-section, .trade-info, .order-info, .min-order, .min-order-quantity, .mix-batch, .price-tags, [class*="price-component"], [class*="order-limit"]').map(node => txt(node, 2000));
      const conditions = conditionTexts.join(' ');
      const minimumMatch = visibleMinimumOrder();
      if (minimumMatch) { result.purchaseConditions.minimumQuantity = Number(minimumMatch[1]); result.purchaseConditions.minimumUnit = minimumMatch[2]; result.minimumOrderText = minimumMatch[0]; result.purchaseConditions.unitQuoteStatus = 'minimum_order_quote'; }
      const quantityQuote = visibleQuantityQuote(minimumMatch);
      if (quantityQuote) {
        const quoteKind = quantityQuote.unit === minimumMatch[2] ? 'minimum_order_unit' : 'minimum_order_quantity';
        addPrice('¥' + quantityQuote.amount, quoteKind, 'dom.minimum-order-quantity-price');
      } else if (minimumMatch && aliVisibleText) {
        const quotedQuantity = minimumMatch[1]; const quotedUnit = minimumMatch[2];
        const unitQuote = aliVisibleText.match(new RegExp(quotedQuantity + '\\s*' + quotedUnit + '\\s*(?:价格|价)\\s*[¥￥]?\\s*(\\d[\\d,]*(?:\\.\\d{1,4})?)'));
        if (unitQuote) addPrice('¥' + unitQuote[1], 'minimum_order_unit', 'dom.minimum-order-unit-price');
      }
      result.purchaseConditions.mixedBatchText = conditions.match(/\d+\s*(?:件|个|盒|套|包|元)\s*混批/)?.[0] || '';
      result.shipping.rawText = shippingQuote(first(['.logistics-price', '.freight-price', '.shipping-fee', '.delivery-price']));
      if (!result.shipping.rawText) {
        const shippingCandidates = all('[class*="logistics"], [class*="freight"], [class*="delivery"], .cart-content').map(node => txt(node, 1500));
        result.shipping.rawText = shippingCandidates.map(shippingQuote).find(Boolean) || '';
      }
      if (!result.shipping.rawText) {
        // 1688 now renders the label, amount and "起" in separate nodes without a
        // stable logistics class. Inspect only direct, short text so embedded JSON
        // and the full descendant text of a large product DOM are never normalized.
        const labels = [];
        const candidates = doc.querySelectorAll('span, label, strong, em, p, div');
        for (let index = 0; index < candidates.length && index < 12000 && labels.length < 4; index += 1) {
          const label = candidates[index];
          let directText = '';
          for (const child of label.childNodes) if (child.nodeType === 3 && child.nodeValue && child.nodeValue.length <= 20) directText += child.nodeValue;
          if (!/^(?:运费|快递费)$/.test(C.cleanText(directText, 20))) continue;
          if (label && !/退货包运费|运费险|包退运费|售后/.test(txt(label.closest?.('a,button'), 100))) labels.push(label);
        }
        for (const label of labels) {
          let container = label;
          for (let depth = 0; depth < 4 && container?.parentElement; depth += 1) {
            container = container.parentElement;
            const original = String(container.textContent || '');
            if (original.length > 800) break;
            const fee = txt(container, 400).match(/(?:运费|快递费)\s*[¥￥]?\s*\d+(?:\.\d{1,4})?\s*(?:元)?\s*(?:起)?/);
            if (fee) { result.shipping.rawText = fee[0]; break; }
          }
          if (result.shipping.rawText) break;
        }
      }
    } else {
      const deliveryHeading = all('h2, h3').find(node => /^Доставка и возврат$/i.test(txt(node)));
      const delivery = deliveryHeading?.parentElement;
      const deliveryNotes = [];
      if (delivery && delivery.textContent.length < 6000) {
        const stock = all('span, div', delivery).map(node => txt(node, 150)).find(text => /^В наличии\s*[—-]\s*осталось\s*\d[\d\s]*\s*(?:штук|штуки|штука|шт\.?)[!\.]?$/i.test(text));
        if (stock) result.inventoryText = stock;
        // Only named delivery methods and fee labels; never copy address controls.
        for (const row of Array.from(delivery.children)) {
          const method = all('span', row).map(node => txt(node, 100)).find(text => /^(?:Курьерской службой партнёра|Пункты выдачи Ozon)$/i.test(text));
          if (!method) continue;
          const fee = all('[title], span, div', row).map(node => C.cleanText(node.getAttribute('title') || node.textContent, 100)).find(text => /^(?:\+?\s*\d[\d\s.,]*\s*[¥₽]|Входит в заказ|Бесплатно)$/i.test(text));
          if (fee) deliveryNotes.push(method + ': ' + fee);
        }
      }
      // The current Ozon product is one observed SKU. This does not imply single-SKU completeness.
      result.variants.push({ id: source.productId, skuId: source.productId, label: result.title, url: source.url, price: result.prices.find(item => item.kind === 'structured_offer') || null, imageUrl: result.media.find(item => item.role === 'main' && item.kind === 'image')?.url || null, stockText: result.inventoryText, evidence: 'current_product' });
      for (const row of all('[data-widget="webCharacteristics"] dl, [data-widget="webShortCharacteristics"] dl')) addAttribute(txt(row.querySelector('dt')), all('dd', row).map(node => txt(node)).join(' / '), 'dom.characteristics');
      for (const row of all('[data-widget="webCharacteristics"] tr')) { const cells = all('th,td', row); if (cells.length >= 2) addAttribute(txt(cells[0]), txt(cells[1]), 'dom.characteristics.table'); }
      for (const link of all('[data-widget="webAspects"] a[href], [data-widget="webProductVariants"] a[href]')) {
        const linked = C.sourceUrl(new URL(link.getAttribute('href'), pageUrl).href);
        if (!linked || linked.platform !== 'ozon' || result.variants.some(item => item.url === linked.url)) continue;
        const img = link.querySelector('img'); const imageUrl = C.mediaUrl(img?.getAttribute('data-src') || img?.getAttribute('src') || '', pageUrl);
        result.variants.push({ id: linked.productId, label: txt(link, 300) || C.cleanText(img?.alt, 300) || linked.productId, url: linked.url, price: null, imageUrl, stockText: '', evidence: 'dom.aspects' });
        addMedia(imageUrl, 'image', 'variant', 'dom.aspects');
      }
      result.supplier.name = first(['[data-widget="webCurrentSeller"]', '[data-widget="webSeller"]']);
      result.shipping.rawText = first(['[data-widget="webDelivery"] [data-delivery-price]', '[data-widget="webDelivery"] .delivery-price']);
      if (!result.shipping.rawText) result.shipping.rawText = [...new Set(deliveryNotes)].join('; ');
    }
    const breadcrumbNodes = all(ali
      ? '.breadcrumb a, .breadcrumbs a, .od-breadcrumb a, [class*="breadcrumb"] a, [data-role*="breadcrumb"] a, [aria-label*="面包屑"] a'
      : '[data-widget="breadCrumbs"] a, [data-widget="webBreadCrumbs"] a');
    const breadcrumbPath = breadcrumbNodes.map(node => txt(node, 200)).filter(Boolean).slice(0, 20);
    addCategoryPath(breadcrumbPath, 'dom.breadcrumb');
    if (ali) for (const node of breadcrumbNodes) addCategoryId(categoryIdFromUrl(node.getAttribute?.('href')), 'dom.breadcrumb.href');
    const sellerCategory = visibleSellerCategory();
    if (sellerCategory) result.categoryEvidence.signals.push({ kind: 'seller_category', value: sellerCategory, evidence: 'dom.visible-direct-text' });
    result.categoryPath = result.categoryEvidence.pagePath.slice();
    result.measurements = result.attributes.filter(item => /重量|净重|毛重|尺寸|长|宽|高|вес|габарит|размер|длина|ширина|высота/i.test(item.name)).map(item => ({ ...item, normalized: null }));
    // Packaging table rows are facts in their own right. Exact SKU matches enrich a
    // visible variant; unmatched rows remain separately available without row-order guessing.
    // User-confirmed 1688 rule: unitless packaging dimensions are cm and unitless
    // packaging weights are g.
    if (ali) for (const table of all('table')) {
      const rows = tableGrid(table); if (rows.length < 2) continue;
      const headers = rows[0].map(node => txt(node));
      const specIndex = headers.findIndex(value => /^(?:规格|颜色|款式|SKU|SKU名称|规格名称)$/i.test(value));
      const weightIndex = headers.findIndex(value => /包装重量|包裹重量|毛重|重量/.test(value));
      const dimensionIndex = headers.findIndex(value => /^(?:(?:包装|包裹|规格)?尺寸|长宽高)(?:\s*[（(].*[）)])?$/i.test(value));
      const lengthIndex = headers.findIndex(value => /^(?:包装)?长(?:度)?(?:\s*[（(].*[）)])?$/i.test(value));
      const widthIndex = headers.findIndex(value => /^(?:包装)?宽(?:度)?(?:\s*[（(].*[）)])?$/i.test(value));
      const heightIndex = headers.findIndex(value => /^(?:包装)?高(?:度)?(?:\s*[（(].*[）)])?$/i.test(value));
      if (specIndex < 0 || (weightIndex < 0 && dimensionIndex < 0 && lengthIndex < 0)) continue;
      for (const row of rows.slice(1)) {
        const cells = row; const label = txt(cells[specIndex]);
        if (!label) continue;
        const weightHeading = weightIndex >= 0 ? headers[weightIndex] : '';
        const rawWeight = weightIndex >= 0 ? txt(cells[weightIndex]) : '';
        const weightUnit = /\bkg\b|千克|公斤/i.test(weightHeading) ? 'kg' : 'g';
        const parsedWeight = C.weight(rawWeight, weightUnit);
        let rawDimensions = '';
        let parsedDimensions = C.dimensions('');
        let dimensionUnit = 'cm';
        let dimensionDefaultApplied = false;
        if (dimensionIndex >= 0) {
          const dimensionHeading = headers[dimensionIndex] || '';
          rawDimensions = txt(cells[dimensionIndex]);
          dimensionUnit = /\bmm\b|毫米/i.test(dimensionHeading) ? 'mm' : 'cm';
          dimensionDefaultApplied = !/\b(?:mm|cm)\b|毫米|厘米/i.test(dimensionHeading) && !/\b(?:mm|cm)\b|毫米|厘米/i.test(rawDimensions);
          parsedDimensions = C.dimensions(rawDimensions, dimensionUnit);
        } else if ([lengthIndex, widthIndex, heightIndex].every(index => index >= 0)) {
          const indexes = [lengthIndex, widthIndex, heightIndex];
          const explicitUnits = indexes.map(index => /\bmm\b|毫米/i.test(headers[index]) ? 'mm' : /\bcm\b|厘米/i.test(headers[index]) ? 'cm' : null);
          const presentUnits = explicitUnits.filter(Boolean);
          if (!presentUnits.length || presentUnits.every(unit => unit === presentUnits[0])) {
            dimensionUnit = presentUnits[0] || 'cm';
            dimensionDefaultApplied = !presentUnits.length;
            rawDimensions = indexes.map(index => txt(cells[index])).join('×');
            parsedDimensions = C.dimensions(rawDimensions, dimensionUnit);
          }
        }
        const normalizedDimensionText = parsedDimensions.lengthMm && parsedDimensions.widthMm && parsedDimensions.heightMm
          ? [parsedDimensions.lengthMm, parsedDimensions.widthMm, parsedDimensions.heightMm].map(value => String(Number(value) / 10)).join('×') + '厘米'
          : rawDimensions;
        const normalizedWeightText = parsedWeight.grams !== null ? parsedWeight.grams + '克' : rawWeight;
        const combined = [normalizedDimensionText, normalizedWeightText].filter(Boolean).join('；');
        if (combined) addAttribute('包装明细 / ' + label, combined, 'dom.packaging-table');
        const matching = result.variants.filter(variant => variant.skuId === label || variant.label === label);
        const weight = { ...parsedWeight, sourceRawText: rawWeight, defaultUnitApplied: Boolean(rawWeight && !/\b(?:kg|g)\b|千克|公斤|克/i.test(rawWeight) && !/\b(?:kg|g)\b|千克|公斤|克/i.test(weightHeading)), evidence: 'dom.packaging-table' };
        const dimensions = { ...parsedDimensions, sourceRawText: rawDimensions, defaultUnitApplied: dimensionDefaultApplied, evidence: 'dom.packaging-table' };
        if (matching.length === 1 && rawWeight) matching[0].packagingWeight = { ...weight, evidence: 'dom.packaging-table.exact-sku' };
        if (matching.length === 1 && rawDimensions) matching[0].packagingDimensions = { ...dimensions, evidence: 'dom.packaging-table.exact-sku' };
        const packagingRow = {
          id: 'packaging-row-' + (result.packagingRows.length + 1), label,
          rawDimensions, rawWeight,
          packagingDimensions: dimensions, packagingWeight: weight,
          imageUrl: result.skuImages.find(item => item.label === label)?.url || null,
          evidence: 'dom.packaging-table'
        };
        const key = [label, rawDimensions, rawWeight].join('\u0000');
        if (!result.packagingRows.some(item => [item.label, item.rawDimensions, item.rawWeight].join('\u0000') === key)) {
          result.packagingRows.push(packagingRow);
          result.measurements.push({ name: '包装明细 / ' + label, value: combined, evidence: 'dom.packaging-table', normalized: { packagingDimensions: dimensions, packagingWeight: weight } });
        }
      }
    }
    if (ali) {
      for (const variant of result.variants) {
        if (variant.price && !result.prices.some(item => item.kind === variant.price.kind && item.raw === variant.price.raw)) result.prices.push({ ...variant.price });
      }
      const generatedDescription = C.productDescription(result);
      if (generatedDescription) {
        result.descriptionText = generatedDescription;
        result.descriptionGeneration = {
          method: 'title_attributes_packaging_rules',
          evidence: ['title', 'attributes', 'packagingRows'],
          generatedAt: now
        };
      }
    }
    const minimumQuantity = ali && Number.isInteger(result.purchaseConditions.minimumQuantity) && result.purchaseConditions.minimumQuantity > 0 ? result.purchaseConditions.minimumQuantity : 1;
    for (const variant of result.variants) {
      const stockMatch = variant.stockText.match(/^(?:库存|剩余|可售库存)\s*((?:\d+|\d{1,3}(?:,\d{3})+))\s*(个|件|套|包)?$/) || variant.stockText.match(/^В наличии\s*[—-]\s*осталось\s*(\d[\d\s]*)\s*(штук|штуки|штука|шт\.?)[!\.]?$/i);
      variant.stock = { quantity: stockMatch ? stockMatch[1].replace(/[,\s]/g, '') : null, unit: stockMatch?.[2] || null, rawText: variant.stockText, trust: 'page_reference_unverified' };
      if (!variant.unitShipping) variant.unitShipping = { quantity: minimumQuantity, amount: null, currency: fallback, rawText: '', isStartingPrice: false, calculationBasis: ali ? 'minimum_order_quantity' : 'displayed_delivery_option', status: 'unknown' };
      else variant.unitShipping.quantity = minimumQuantity;
      if (ali && variant.unitShipping.rawText) {
        const rowFee = variant.unitShipping.rawText.match(/(?:运费|快递费)?\s*[¥￥]?\s*(\d+(?:\.\d{1,4})?)\s*元?\s*(起)?/);
        if (rowFee) {
          variant.unitShipping.amount = rowFee[1]; variant.unitShipping.isStartingPrice = Boolean(rowFee[2]);
          variant.unitShipping.status = rowFee[2] ? 'displayed_sku_minimum_starting' : 'displayed_sku_minimum';
        } else if (/包邮/.test(variant.unitShipping.rawText)) {
          variant.unitShipping.amount = '0'; variant.unitShipping.isStartingPrice = false; variant.unitShipping.status = 'displayed_sku_free_shipping';
        }
      }
      if (!variant.packagingWeight) variant.packagingWeight = { rawText: '', grams: null, evidence: null };
      if (!variant.packagingDimensions) variant.packagingDimensions = { rawText: '', lengthMm: null, widthMm: null, heightMm: null, evidence: null };
    }
    if (result.shipping.rawText) {
      result.shipping.quantity = minimumQuantity;
      result.shipping.isStartingPrice = /起/.test(result.shipping.rawText);
      result.shipping.currency = C.currencyOf(result.shipping.rawText, fallback);
      const displayedFee = ali && result.shipping.rawText.match(/(?:运费|快递费)?\s*[¥￥]?\s*(\d+(?:\.\d{1,4})?)\s*元?\s*(起)?/);
      if (displayedFee) {
        result.shipping.amount = displayedFee[1]; result.shipping.isStartingPrice = Boolean(displayedFee[2]);
        result.shipping.status = displayedFee[2] ? 'displayed_minimum_order_starting' : 'displayed_minimum_order';
      } else if (ali && /包邮/.test(result.shipping.rawText)) {
        result.shipping.amount = '0'; result.shipping.isStartingPrice = false; result.shipping.status = 'displayed_minimum_order_free_shipping';
      } else result.shipping.status = 'displayed_unverified';
    }
    if (ali && selectedQuantities.length === 1 && selectedQuantities[0].quantity === minimumQuantity && result.shipping.amount !== null) {
      selectedQuantities[0].variant.unitShipping = { quantity: minimumQuantity, amount: result.shipping.amount, currency: 'CNY', rawText: result.shipping.rawText, isStartingPrice: result.shipping.isStartingPrice, calculationBasis: 'minimum_order_quantity', status: result.shipping.isStartingPrice ? 'displayed_for_selected_sku_minimum_starting' : 'displayed_for_selected_sku_minimum', destination: 'current_page_destination', capturedAt: now };
    }
    if (!result.media.some(item => item.kind === 'image' && item.role === 'main')) warnings.push('未读取到主图；请等待图片加载后重试');
    if (!result.prices.length && !result.variants.some(item => item.price?.amount || item.price?.min)) warnings.push('未读取到价格；可能需要登录或选择规格');
    if (result.prices.some(item => !item.currency || (!item.amount && !item.min))) warnings.push('部分价格只能保留原文，币种或金额待核实');
    if (!result.attributes.length) warnings.push('未读取到属性；请展开商品参数后重新采集');
    if (!result.media.some(item => item.kind === 'video')) warnings.push('未读取到可直接下载的视频；不代表商品没有视频');
    if (result.media.some(item => item.role === 'video_cover') && !result.media.some(item => item.kind === 'video')) warnings.push('页面存在视频封面，但没有可用视频地址；请手动播放后重试，仍为blob时本版不下载');
    if (!ali && result.media.some(item => /\/(?:wc|ww)(?:[1-9]\d?|100)\//.test(item.url))) warnings.push('部分素材只读取到缩略图；请在商品页查看大图后重新采集，本版不拼造原图地址');
    if (rejectedMedia) warnings.push('已跳过' + rejectedMedia + '个非白名单、签名或临时素材地址');
    warnings.push('规格仅记录当前DOM中的行/关联链接；未遍历全部组合，未沿用页面价补齐SKU价格');
    warnings.push('详情仅含已加载内容；可先展开参数、详情并滚动页面，再重新采集');
    warnings.push('1688运费按最低起批数量记录：1件起批按1件、2件起批按2件；“运费起”保留为最低展示价，不均摊成单件，也不复制成全部SKU的确定运费');
    if (result.packagingRows.length && result.variants.some(item => item.packagingWeight.grams === null)) warnings.push('包装表重量和尺寸已按表格行保存；未能按名称精确对应当前规格行时不按行序分配');
    else if (result.variants.some(item => item.packagingWeight.grams === null)) warnings.push('部分SKU包装重量未知；包装表未能精确对应规格时不按行序分配');
    if (result.purchaseConditions.minimumQuantity > 1) warnings.push('页面起批量大于1；运费数量使用最低起批数，不把整单运费除以数量');
    if (result.media.length >= 250) warnings.push('素材达到250条上限，已停止追加');
    if (!ali) result.analytics = A.extract(doc, source, now, result);
    result.completeness.missing = ['title', 'prices', 'attributes'].filter(key => !result[key]?.length);
    if (JSON.stringify(result).length > 1500000) throw new Error('商品数据超过1.5MB安全上限，请减少已展开内容后重试。');
    return result;
  }
  return { extract };
});
