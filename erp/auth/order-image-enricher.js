'use strict';

const { withRetry } = require('./category-attribute-sync');

function imageFromProduct(product) {
  const primary = product && product.primary_image;
  const images = product && product.images;
  return String((Array.isArray(primary) ? primary[0] : primary) || (Array.isArray(images) ? images[0] : images) || product && product.image || '');
}

function imageCacheFromOrders(orders) {
  const cache = {};
  for (const order of Array.isArray(orders) ? orders : []) {
    for (const item of Array.isArray(order && order.items) ? order.items : []) {
      const sku = String(item && item.sku || '').trim();
      if (sku && item.img && !cache[sku]) cache[sku] = String(item.img);
    }
  }
  return cache;
}

function createOrderImageEnricher(options = {}) {
  const request = options.request;
  if (typeof request !== 'function') throw Object.assign(new Error('订单图片补算器未正确初始化，请联系系统管理员检查服务端配置。'), { code: 'order_image_enricher_invalid' });
  const cache = { ...imageCacheFromOrders(options.existing), ...(options.cache && typeof options.cache === 'object' ? options.cache : {}) };
  const onWarning = typeof options.onWarning === 'function' ? options.onWarning : async () => {};
  async function call(body) { return withRetry(request, '/v3/product/info/list', body, { attempts: 3 }); }
  return async function enrich(rows) {
    if (!Array.isArray(rows)) throw Object.assign(new Error('订单图片补算的数据格式不正确，请重新同步订单后再试。'), { code: 'order_image_batch_invalid' });
    const targets = new Map();
    for (const row of rows) {
      for (const item of Array.isArray(row && row.items) ? row.items : []) {
        const sku = String(item && item.sku || '').trim();
        if (!sku || item.img) continue;
        if (cache[sku]) { item.img = cache[sku]; continue; }
        if (!/^\d+$/.test(sku)) continue;
        if (!targets.has(sku)) targets.set(sku, []);
        targets.get(sku).push(item);
      }
    }
    const skus = [...targets.keys()];
    let updated = 0, failedBatches = 0;
    for (let offset = 0; offset < skus.length; offset += 100) {
      const batch = skus.slice(offset, offset + 100);
      try {
        const data = await call({ sku: batch.map(Number), limit: 100, offset: 0 });
        for (const product of Array.isArray(data && data.items) ? data.items : []) {
          const sku = String(product && product.sku || '');
          const image = imageFromProduct(product);
          if (!sku || !image || !targets.has(sku)) continue;
          cache[sku] = image;
          for (const item of targets.get(sku)) if (!item.img) { item.img = image; updated += 1; }
        }
      } catch (error) {
        failedBatches += 1;
        await onWarning({ code: 'order_image_batch_failed', skuCount: batch.length, message: String(error && error.message || 'unknown').slice(0, 300) });
      }
    }
    return { rows, result: { updated, failedBatches, requestedSkus: skus.length }, cache: { ...cache } };
  };
}

module.exports = { imageFromProduct, imageCacheFromOrders, createOrderImageEnricher };
