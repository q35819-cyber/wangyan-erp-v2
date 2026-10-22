'use strict';

const aggregate = require('./online-product-cost-aggregate');
const combinationStore = require('./product-combination-store');
const sourceLink = require('../assets/product-source-link');

function amount(value) {
  if (value == null || value === '') return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function ownCost(source, fallback) {
  const item = source || {};
  const parent = fallback || {};
  const purchase = amount(item.purchase ?? item.purchasePrice ?? item.srcPrice ?? parent.purchase ?? parent.purchasePrice ?? parent.srcPrice);
  const domesticShipping = amount(item.domesticShipping ?? item.domesticShippingAmount ?? parent.domesticShipping ?? parent.domesticShippingAmount);
  return { purchase, domesticShipping: domesticShipping == null ? 0 : domesticShipping };
}

function productShopId(product) {
  return aggregate.orderShopId(product);
}

function collectionCostResolver(rows) {
  const byId = new Map((rows || []).map(row => [String(row && row.id || ''), row]));
  return function resolve(ref) {
    const text = String(ref || '');
    if (!text.startsWith('collection:')) return null;
    const row = byId.get(text.slice('collection:'.length));
    if (!row) return null;
    return ownCost({
      purchase: row.purchase,
      purchasePrice: row.purchasePrice,
      srcPrice: row.srcPrice ?? row.price,
      domesticShipping: row.domesticShipping
    });
  };
}

function purchaseResolver(graphPayload, collections) {
  const resolveBreakdown = purchaseBreakdownResolver(graphPayload, collections);
  return function resolve(candidate) {
    const result = resolveBreakdown(candidate);
    return result && result.purchaseTotalCostCny != null ? result.purchaseTotalCostCny : null;
  };
}

function purchaseBreakdownResolver(graphPayload, collections) {
  const resolveCollection = collectionCostResolver(collections);
  return function resolve(candidate) {
    const source = candidate.variant || candidate.product;
    const base = ownCost(source, candidate.product);
    const variantRef = String(source && source.erpVariantRef || candidate.product && candidate.product.erpVariantRef || '').trim();
    const missingComponents = [];
    if (base.purchase == null) missingComponents.push('purchase');
    if (!variantRef) {
      return {
        purchaseCny: base.purchase,
        domesticShippingCny: base.domesticShipping,
        purchaseTotalCostCny: missingComponents.length ? null : Number(base.purchase) + Number(base.domesticShipping),
        missingComponents
      };
    }
    if (missingComponents.length) {
      return {
        purchaseCny: base.purchase,
        domesticShippingCny: base.domesticShipping,
        purchaseTotalCostCny: null,
        missingComponents
      };
    }
    const calculated = combinationStore.calculatePurchaseTotalCost(
      graphPayload,
      'variant:' + variantRef.replace(/^variant:/, ''),
      function resolveCompleteCollection(ref) {
        const cost = resolveCollection(ref);
        return cost && cost.purchase != null ? cost : null;
      },
      base
    );
    if (!calculated || !calculated.ok || (calculated.missingRefs && calculated.missingRefs.length)) {
      return {
        purchaseCny: base.purchase,
        domesticShippingCny: base.domesticShipping,
        purchaseTotalCostCny: null,
        missingComponents: ['combination_cost']
      };
    }
    return {
      purchaseCny: calculated.totalPurchase != null ? Number(calculated.totalPurchase) : null,
      domesticShippingCny: calculated.totalDomesticShipping != null ? Number(calculated.totalDomesticShipping) : null,
      purchaseTotalCostCny: calculated.purchaseTotalCost != null ? Number(calculated.purchaseTotalCost) : null,
      missingComponents: []
    };
  };
}

async function query(input) {
  const options = input || {};
  const store = options.store;
  const account = options.account;
  if (!store || !account) throw new Error('缺少在线商品成本查询上下文');
  const [productsDoc, ordersDoc, collectionsDoc, rateDoc, graph, allowed, shops] = await Promise.all([
    store.getDocument(account, 'erp_online_products'),
    store.getDocument(account, 'erp_orders_data'),
    store.getDocument(account, 'erp_collected_products'),
    store.getDocument(account, 'erp_rate'),
    combinationStore.read(store, account),
    store.listAllowedShops(account),
    store.listShops(account)
  ]);
  const shopIdByName = new Map((shops || []).filter(Boolean).map(shop => [String(shop.name || '').trim(), String(shop.externalShopId || '')]));
  function normalizeShop(row) {
    const direct = productShopId(row);
    if (direct) return row;
    const mapped = shopIdByName.get(String(row && row.shop || '').trim());
    return mapped ? { ...row, clientId: mapped } : row;
  }
  const allowedShopIds = allowed === null ? null : allowed.map(shop => String(shop.externalShopId || ''));
  const allowedSet = allowedShopIds === null ? null : new Set(allowedShopIds);
  const products = (Array.isArray(productsDoc && productsDoc.payload) ? productsDoc.payload : []).map(product => normalizeShop({ ...product })).filter(product => {
    return allowedSet === null || allowedSet.has(productShopId(product));
  });
  const orders = (Array.isArray(ordersDoc && ordersDoc.payload) ? ordersDoc.payload : []).map(normalizeShop);
  const visibleOrders = allowedSet === null ? orders : orders.filter(order => allowedSet.has(productShopId(order)));
  sourceLink.repairProductSources(products, visibleOrders);
  const rate = Number(rateDoc && rateDoc.payload);
  if (!Number.isFinite(rate) || rate <= 0) {
    const error = new Error('当前人民币兑卢布汇率不可用，请先刷新官方汇率后重试。');
    error.publicCode = 'online_product_cost_rate_unavailable';
    error.status = 409;
    throw error;
  }
  const resolvePurchaseBreakdown = purchaseBreakdownResolver(
    graph && graph.payload,
    Array.isArray(collectionsDoc && collectionsDoc.payload) ? collectionsDoc.payload : []
  );
  return aggregate.aggregate({
    products,
    orders,
    purchaseTotalCostResolver: purchaseResolver(graph && graph.payload, Array.isArray(collectionsDoc && collectionsDoc.payload) ? collectionsDoc.payload : []),
    purchaseCostBreakdownResolver: resolvePurchaseBreakdown,
    cnyPerRub: rate,
    allowedShopIds,
    window: options.window,
    now: options.now
  });
}

module.exports = { query, ownCost, purchaseResolver, purchaseBreakdownResolver, collectionCostResolver };
