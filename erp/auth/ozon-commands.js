'use strict';

const COMMANDS = Object.freeze({
  'shops.getProductLimit': { endpoint: '/v4/product/info/limit', permissions: ['shops.write'] },
  'shops.getRoles': { endpoint: '/v1/roles', permissions: ['shops.write'] },
  'shops.listWarehouses': { endpoint: '/v2/warehouse/list', permissions: ['shops.write'] },
  'shops.listDeliveryMethods': { endpoint: '/v2/delivery-method/list', permissions: ['products.read', 'shops.read', 'shops.write'] },
  'catalog.getTree': { endpoint: '/v1/description-category/tree', permissions: ['products.read', 'products.write'] },
  'catalog.getAttributes': { endpoint: '/v1/description-category/attribute', permissions: ['products.read', 'products.write'] },
  'catalog.getAttributeValues': { endpoint: '/v1/description-category/attribute/values', permissions: ['products.read', 'products.write'] },
  'catalog.searchAttributeValues': { endpoint: '/v1/description-category/attribute/values/search', permissions: ['products.read', 'products.write'] },
  'products.list': { endpoint: '/v3/product/list', permissions: ['products.write'] },
  'products.getInfo': { endpoint: '/v3/product/info/list', permissions: ['products.read', 'products.write', 'orders.write'] },
  'products.getAttributes': { endpoint: '/v4/product/info/attributes', permissions: ['products.read', 'products.write'] },
  'products.getPrices': { endpoint: '/v5/product/info/prices', permissions: ['products.read', 'products.write'] },
  'analytics.getData': { endpoint: '/v1/analytics/data', permissions: ['products.read'] },
  'analytics.getTurnoverStocks': { endpoint: '/v1/analytics/turnover/stocks', permissions: ['products.read'] },
  'products.updatePrices': { endpoint: '/v1/product/import/prices', permissions: ['products.write'], writes: true },
  'products.updateStocks': { endpoint: '/v2/products/stocks', permissions: ['products.write'], writes: true },
  'products.archive': { endpoint: '/v1/product/archive', permissions: ['products.write'], writes: true },
  'products.unarchive': { endpoint: '/v1/product/unarchive', permissions: ['products.write'], writes: true },
  'products.getDescription': { endpoint: '/v1/product/info/description', permissions: ['products.read', 'products.write'] },
  'orders.listFbs': { endpoint: '/v3/posting/fbs/list', permissions: ['orders.write'] },
  'orders.getFbs': { endpoint: '/v3/posting/fbs/get', permissions: ['orders.write'] },
  'orders.listReturns': { endpoint: '/v1/returns/list', permissions: ['orders.write'] },
  'orders.listRfbsReturns': { endpoint: '/v2/returns/rfbs/list', permissions: ['orders.write'] },
  'orders.getRfbsReturn': { endpoint: '/v2/returns/rfbs/get', permissions: ['orders.write'] },
  'finance.listAccrualTypes': { endpoint: '/v1/finance/accrual/types', permissions: ['orders.write'] },
  'finance.listAccrualPostings': { endpoint: '/v1/finance/accrual/postings', permissions: ['orders.write'] }
});

function getOzonCommand(name) {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name) ? COMMANDS[name] : null;
}

module.exports = { COMMANDS, getOzonCommand };
