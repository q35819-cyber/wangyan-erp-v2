/* Ozon在线商品同步字段映射（浏览器 / Node 共用）。 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(
    require('./online-product-status'), require('./online-product-format'), require('./product-detail-data'),
    require('./online-products-manual'), require('./product-source-link')
  );
  else root.WYERP_ONLINE_SYNC_MAP = factory(root.WYERP_ONLINE_STATUS, root.WYERP_ONLINE_FORMAT, root.WYERP_PRODUCT_DETAIL_DATA, root.WYERP_ONLINE_MANUAL, root.WYERP_PRODUCT_SOURCE_LINK);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (statusModel, format, detailData, manualModel, sourceLink) {
  'use strict';
  function prices(product) {
    var value = product && product._ozonPrice || {};
    return {
      sell: value.retail_price || product.price || '', original: value.old_price || product.old_price || '',
      lowest: value.min_price || product.min_ozon_price || product.min_price || '',
      promo: value.marketing_price || value.marketing_seller_price || product.marketing_price || product.marketing_seller_price || product.premium_price || '',
      currency: value.currency_code || product.priceCurrency || ''
    };
  }
  function convert(shop, product, old, options) {
    options = options || {};
    var stocks = product.stocks && product.stocks.stocks || [];
    var targetId = String(old && old.stockWarehouseId || shop.defaultWarehouseId || '');
    var targetName = String(old && old.stockWarehouseName || shop.defaultWarehouseName || '');
    var matched = stocks.find(function (item) {
      var id = String(item.warehouse_id != null ? item.warehouse_id : item.id != null ? item.id : '');
      var name = String(item.warehouse_name || item.warehouse || item.name || '');
      return (targetId && id === targetId) || (targetName && name === targetName);
    });
    var stock = matched ? Number(matched.present || 0) : stocks.reduce(function (sum, item) { return sum + Number(item.present || 0); }, 0);
    if (!targetId && !targetName && Array.isArray(shop.warehouseOptions) && shop.warehouseOptions[0]) {
      targetId = String(shop.warehouseOptions[0].id || ''); targetName = String(shop.warehouseOptions[0].name || '');
    }
    var fulfillment = format.fulfillment(product, { preferredSchema: shop.fulfillmentSchema || 'rFBS', warehouseNames: shop.fulfillmentWarehouseNames || [] });
    var configuredScheme = format.normalizeSchema(options.logisticsScheme || 'rFBS');
    var configuredCommission = (Array.isArray(product.commissions) ? product.commissions : []).find(function (item) { return format.normalizeSchema(item && item.sale_schema) === configuredScheme; });
    var commissionRates = (Array.isArray(product.commissions) ? product.commissions : []).reduce(function (result, item) {
      var schema = format.normalizeSchema(item && item.sale_schema), percent = format.percentage(item && item.percent);
      if (schema && percent !== '') result[schema] = percent;
      return result;
    }, {});
    var price = prices(product), status = statusModel.derive(product), category = options.category || {};
    var c2 = category[String(product.description_category_id)] || {}, c3 = category[String(product.type_id)] || {};
    var result = Object.assign({}, old || {}, {
      id: product.id, clientId: String(shop.clientId || shop.externalShopId || ''), name: product.name || '', article: product.offer_id || '', sku: String(product.sku || product.id || ''), shop: shop.name,
      descriptionCategoryId: product.description_category_id || old && old.descriptionCategoryId || '', typeId: product.type_id || old && old.typeId || '',
      cat1: c2.cat1 || '', cat2: c2.cat2 || '', cat3: c3.cat3 || '', status: status.label, statusReason: status.reason,
      ozonStatusCode: product.statuses && product.statuses.status || '', ozonErrorCodes: (Array.isArray(product.errors) ? product.errors : []).map(function (error) { return error && error.code; }).filter(Boolean),
      priceSell: price.sell, priceOriginal: price.original, priceLowest: price.lowest, pricePromo: price.promo, priceCurrency: price.currency,
      stock: stock, stockWarehouseId: targetId, stockWarehouseName: targetName,
      weight: product._ozonAttributes && format.weight(product._ozonAttributes.weight, product._ozonAttributes.weight_unit) || old && old.weight || '',
      weightValue: product._ozonAttributes && product._ozonAttributes.weight != null ? product._ozonAttributes.weight : old && old.weightValue,
      weightUnit: product._ozonAttributes && product._ozonAttributes.weight_unit || old && old.weightUnit || '',
      volumeWeight: product.volume_weight == null ? old && old.volumeWeight : product.volume_weight,
      height: product._ozonAttributes && product._ozonAttributes.height != null ? product._ozonAttributes.height : old && old.height,
      depth: product._ozonAttributes && product._ozonAttributes.depth != null ? product._ozonAttributes.depth : old && old.depth,
      width: product._ozonAttributes && product._ozonAttributes.width != null ? product._ozonAttributes.width : old && old.width,
      dimensionUnit: product._ozonAttributes && product._ozonAttributes.dimension_unit || old && old.dimensionUnit || '',
      barcode: product._ozonAttributes && product._ozonAttributes.barcode || old && old.barcode || '',
      commission: configuredCommission ? format.amount(configuredCommission.value) : '', commissionPercent: format.commissionPercent(product, configuredScheme),
      commissionRates: commissionRates, commissionSchema: configuredCommission ? configuredScheme : '', commissionAmountSchema: configuredCommission ? configuredScheme : '',
      acquiring: product.price ? format.amount(Number(product.price) * 0.01) : '', rfbs: fulfillment.schema || '', fulfillmentSchema: fulfillment.schema || '', warehouseNames: fulfillment.warehouses,
      img: product.primary_image && product.primary_image[0] || product.images && product.images[0] || '',
      mergedCount: product.model_info && product.model_info.count || 0, archived: !!product.is_archived, visibility: product.visibility || '',
      createdAt: product.created_at || '', updatedAt: product.updated_at || ''
    });
    if (product._ozonAttributes) result = detailData.refresh(result, Object.assign({}, product, { price: price.sell, old_price: price.original }), product._ozonAttributes);
    result = manualModel.apply(result, options.manualEntries);
    sourceLink.applyOrdersToProducts([result], options.orders);
    return result;
  }
  return { convert: convert, prices: prices };
});
