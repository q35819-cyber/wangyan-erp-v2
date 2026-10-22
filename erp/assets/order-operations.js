(function (root, factory) {
  'use strict';
  var rules = typeof module === 'object' && module.exports ? require('./input-rules') : root.WYERP_INPUT_RULES;
  var api = factory(rules);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_ORDER_OPS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inputRules) {
  'use strict';

  function cleanText(value) {
    var text = String(value == null ? '' : value).trim();
    return text === '--' ? '' : text;
  }

  function numberOrNull(value) {
    if (value == null || value === '' || value === '--') return null;
    var parsed = Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  function quantity(value, fallback) {
    var parsed = numberOrNull(value);
    return parsed != null && parsed > 0 ? parsed : fallback;
  }

  var MANUAL_ITEM_FIELDS = [
    'spec', 'specRu', 'src', 'srcPrice', 'srcRemark', 'purchasePrice',
    'purchaseChannel', 'domesticShipping', 'purchaseExpress', 'purchaseNo',
    'returnFee', 'remark', 'stockIn'
  ];

  function copyValue(value) {
    if (value == null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function sanitizeDecimalInput(value) {
    return inputRules.decimal(value);
  }

  function sanitizeIntegerInput(value) {
    return inputRules.integer(value);
  }

  function sanitizeOrderIdentifier(value) {
    return inputRules.orderIdentifier(value);
  }

  function matchingManualItem(sourceItems, target, targetIndex, used) {
    var targetOffer = cleanText(target && target.offerId);
    var targetSku = cleanText(target && target.sku);
    var best = -1;
    for (var i = 0; i < sourceItems.length; i += 1) {
      if (used[i]) continue;
      var source = sourceItems[i] || {};
      var sourceOffer = cleanText(source.offerId);
      var sourceSku = cleanText(source.sku);
      if (targetOffer && sourceOffer === targetOffer && (!targetSku || sourceSku === targetSku)) return i;
      if (best < 0 && targetOffer && sourceOffer === targetOffer) best = i;
      if (best < 0 && targetSku && sourceSku === targetSku) best = i;
    }
    if (best >= 0) return best;
    return sourceItems[targetIndex] && !used[targetIndex] ? targetIndex : -1;
  }

  // OZON 同步会重建商品对象。每批保存前把同步开始时的人工字段重新覆盖回去，
  // 避免 SKU/offerId 变化、同 SKU 多行或异步分批写入时丢失货源、采购、合包和入仓信息。
  function preserveManualOrderData(targetList, sourceList) {
    var sourceByPosting = {};
    (sourceList || []).forEach(function (order) {
      var posting = cleanText(order && order.posting);
      if (posting) sourceByPosting[posting] = order;
    });
    var restored = 0;
    (targetList || []).forEach(function (targetOrder) {
      var sourceOrder = sourceByPosting[cleanText(targetOrder && targetOrder.posting)];
      if (!sourceOrder || !targetOrder) return;
      if (Object.prototype.hasOwnProperty.call(sourceOrder, 'combine')) targetOrder.combine = copyValue(sourceOrder.combine);
      if (sourceOrder.finance && Object.prototype.hasOwnProperty.call(sourceOrder.finance, 'purchaseCost')) {
        if (!targetOrder.finance) targetOrder.finance = {};
        targetOrder.finance.purchaseCost = copyValue(sourceOrder.finance.purchaseCost);
      }
      var sourceItems = Array.isArray(sourceOrder.items) ? sourceOrder.items : [];
      var used = {};
      (targetOrder.items || []).forEach(function (targetItem, targetIndex) {
        var sourceIndex = matchingManualItem(sourceItems, targetItem, targetIndex, used);
        if (sourceIndex < 0) return;
        used[sourceIndex] = true;
        var sourceItem = sourceItems[sourceIndex] || {};
        MANUAL_ITEM_FIELDS.forEach(function (field) {
          if (Object.prototype.hasOwnProperty.call(sourceItem, field)) targetItem[field] = copyValue(sourceItem[field]);
        });
        restored += 1;
      });
    });
    return restored;
  }

  function hasMeaningfulManualValue(value) {
    if (value == null) return false;
    if (typeof value === 'string') return cleanText(value) !== '';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }

  // Compatibility bridge for records created by the old page-only backup.
  // The current ledger uses the normal order shape so all sync writers can use
  // one matching implementation, while older top-level purchaseCost remains readable.
  function normalizeManualOrderSnapshot(sourceList) {
    return (Array.isArray(sourceList) ? sourceList : []).map(function (order) {
      if (!order || typeof order !== 'object') return order;
      var next = copyValue(order);
      if (Object.prototype.hasOwnProperty.call(next, 'purchaseCost')) {
        next.finance = next.finance && typeof next.finance === 'object' ? next.finance : {};
        if (!Object.prototype.hasOwnProperty.call(next.finance, 'purchaseCost')) {
          next.finance.purchaseCost = copyValue(next.purchaseCost);
        }
        delete next.purchaseCost;
      }
      return next;
    });
  }

  function createManualOrderSnapshot(sourceList) {
    return (Array.isArray(sourceList) ? sourceList : []).map(function (order) {
      var snapshot = {
        posting: cleanText(order && (order.posting || order.posting_number)),
        items: []
      };
      if (order && Object.prototype.hasOwnProperty.call(order, 'combine')) snapshot.combine = copyValue(order.combine);
      if (order && order.finance && Object.prototype.hasOwnProperty.call(order.finance, 'purchaseCost')) {
        snapshot.finance = { purchaseCost: copyValue(order.finance.purchaseCost) };
      }
      (Array.isArray(order && order.items) ? order.items : []).forEach(function (item, index) {
        var saved = {
          idx: index,
          offerId: cleanText(item && item.offerId),
          sku: cleanText(item && item.sku)
        };
        MANUAL_ITEM_FIELDS.forEach(function (field) {
          if (item && Object.prototype.hasOwnProperty.call(item, field)) saved[field] = copyValue(item[field]);
        });
        snapshot.items.push(saved);
      });
      return snapshot;
    }).filter(function (order) { return order.posting; });
  }

  // Current rows are a compatibility source for deployments that predate the
  // durable ledger. Only meaningful values may override the ledger: an automatic
  // sync often materializes blank placeholders and those must never erase history.
  function preserveMeaningfulManualOrderData(targetList, sourceList) {
    var filtered = normalizeManualOrderSnapshot(sourceList).map(function (order) {
      if (!order || typeof order !== 'object') return order;
      var next = { posting: order.posting, items: [] };
      if (hasMeaningfulManualValue(order.combine)) next.combine = copyValue(order.combine);
      if (order.finance && hasMeaningfulManualValue(order.finance.purchaseCost)) {
        next.finance = { purchaseCost: copyValue(order.finance.purchaseCost) };
      }
      (Array.isArray(order.items) ? order.items : []).forEach(function (item) {
        var saved = { offerId: item && item.offerId, sku: item && item.sku };
        MANUAL_ITEM_FIELDS.forEach(function (field) {
          if (item && hasMeaningfulManualValue(item[field])) saved[field] = copyValue(item[field]);
        });
        next.items.push(saved);
      });
      return next;
    });
    return preserveManualOrderData(targetList, filtered);
  }

  var WHD_SETTLEMENT_FIELDS = [
    'orderAmountRub', 'sellerGrossRub', 'orderAmount', 'orderAmountRubSource', 'sellerGrossRubSource',
    'customerPriceRub', 'customerPriceRubSource', 'customerPriceCny', 'customerPriceCnySource',
    'sellerPayoutRub', 'sellerPayoutRubSource', 'postingPayoutRub', 'postingPayoutRubSource', 'ozonProfitRub',
    'ozonNetIncomeRub', 'ozonNetIncomeRubSource', 'ozonNetIncomeAccrualDate', 'ozonNetIncomeAccrualCount', 'ozonNetIncomeUpdatedAt',
    'ozonFeeRub', 'ozonFee', 'ozonFeeEstimateRub',
    'intlLogisticsRub', 'intlLogistics', 'logisticsFeeRub', 'logisticsFee',
    'advertisingFeeRub', 'advertisingFee', 'lastMileRub', 'lastMile',
    'returnHandlingFeeRub', 'returnHandlingFee', 'acquiringRub', 'acquiring',
    'acquiringSource', 'acquiringComplete', 'otherFeeRub', 'otherFee',
    'feeItems', 'accrualsComplete', 'actualFeeStatus', 'settlementSource', 'settlementVersion'
  ];
  var WHD_RETURN_FIELDS = [
    'returnFeeRub', 'returnFeeMerged', 'returnFeeSource', 'returnFeePending',
    'resaleIncomeRub', 'resaleFeeRub', 'retResalePosting', 'originPosting',
    'originFeeTotalRub', 'originIntlLogisticsRub', 'secondIntlLogisticsRub', 'firstIntlLogisticsRub'
  ];

  function isWhdOrder(order) {
    return String(order && (order.deliverySchema || order.delivery_schema) || '').trim().toUpperCase() === 'WHD';
  }

  function hasAuthoritativeWhdCny(order) {
    var finance = order && order.finance && typeof order.finance === 'object' ? order.finance : {};
    return isWhdOrder(order)
      && finance.cnyTotal != null && finance.cnyTotal !== ''
      && cleanText(finance.cnyTotalSource) === 'seller_fbo_posting_list_products_price'
      && cleanText(finance.cnyTotalVerificationSource) === 'seller_posting_financial_data_total_price';
  }

  function hasAuthoritativeWhdSettlement(order) {
    var finance = order && order.finance && typeof order.finance === 'object' ? order.finance : {};
    return isWhdOrder(order)
      && Number(finance.settlementVersion || 0) >= 6
      && cleanText(finance.settlementSource) === 'ozon_accruals_details'
      && finance.accrualsComplete === true
      && Array.isArray(finance.feeItems);
  }

  function hasAuthoritativeWhdReturn(order) {
    var finance = order && order.finance && typeof order.finance === 'object' ? order.finance : {};
    return isWhdOrder(order)
      && !!cleanText(order && order.retFrom)
      && finance.returnFeeMerged === true
      && cleanText(finance.returnFeeSource) === 'ozon_accruals_details_origin_merged_by_category';
  }

  function copyPresentFields(target, source, fields) {
    fields.forEach(function (field) {
      if (!source || !Object.prototype.hasOwnProperty.call(source, field)) return;
      target[field] = copyValue(source[field]);
    });
  }

  function authoritativeWhdItem(sourceItems, targetItem) {
    var offer = cleanText(targetItem && targetItem.offerId);
    var sku = cleanText(targetItem && targetItem.sku);
    if (!offer && !sku) return null;
    var candidates = (Array.isArray(sourceItems) ? sourceItems : []).filter(function (item) {
      if (!item || cleanText(item.priceCurrency).toUpperCase() !== 'CNY'
        || cleanText(item.priceSource) !== 'seller_fbo_posting_list_products_price') return false;
      if (offer && cleanText(item.offerId) !== offer) return false;
      if (sku && cleanText(item.sku) !== sku) return false;
      return true;
    });
    if (candidates.length === 1) return candidates[0];
    if (offer && sku) return null;
    return null;
  }

  // A complete Seller v6 WHD snapshot is authoritative and may intentionally clear
  // stale return facts. Only preserve current server enrichment when the incoming
  // snapshot is demonstrably older/incomplete, preventing browser/client snapshots
  // from erasing verified CNY, settlement and resale-origin evidence.
  function preserveAuthoritativeWhdData(targetList, sourceList) {
    var sourceByPosting = {};
    (Array.isArray(sourceList) ? sourceList : []).forEach(function (order) {
      var posting = cleanText(order && (order.posting || order.posting_number));
      if (posting) sourceByPosting[posting] = order;
    });
    var preserved = 0;
    (Array.isArray(targetList) ? targetList : []).forEach(function (targetOrder) {
      var posting = cleanText(targetOrder && (targetOrder.posting || targetOrder.posting_number));
      var current = sourceByPosting[posting];
      if (!targetOrder || !current || !isWhdOrder(current)) return;
      var currentCny = hasAuthoritativeWhdCny(current);
      var currentSettlement = hasAuthoritativeWhdSettlement(current);
      var incomingCny = hasAuthoritativeWhdCny(targetOrder);
      var incomingSettlement = hasAuthoritativeWhdSettlement(targetOrder);
      if (!currentCny && !currentSettlement && !hasAuthoritativeWhdReturn(current)) return;
      if ((currentCny && !incomingCny) || (currentSettlement && !incomingSettlement)) targetOrder.deliverySchema = 'WHD';
      targetOrder.finance = targetOrder.finance && typeof targetOrder.finance === 'object' ? targetOrder.finance : {};
      var currentFinance = current.finance && typeof current.finance === 'object' ? current.finance : {};
      if (currentCny && !incomingCny) {
        copyPresentFields(targetOrder.finance, currentFinance, ['cnyTotal', 'cnyTotalSource', 'cnyTotalVerificationSource']);
        (Array.isArray(targetOrder.items) ? targetOrder.items : []).forEach(function (targetItem) {
          var sourceItem = authoritativeWhdItem(current.items, targetItem);
          if (!sourceItem) return;
          copyPresentFields(targetItem, sourceItem, ['price', 'priceCurrency', 'priceSource']);
        });
        preserved += 1;
      }
      if (currentSettlement && !incomingSettlement) {
        copyPresentFields(targetOrder.finance, currentFinance, WHD_SETTLEMENT_FIELDS);
        if (Object.prototype.hasOwnProperty.call(current, 'deliveredDate')) targetOrder.deliveredDate = copyValue(current.deliveredDate);
        preserved += 1;
      }
      if (hasAuthoritativeWhdReturn(current) && !(incomingCny && incomingSettlement)) {
        targetOrder.retFrom = copyValue(current.retFrom);
        copyPresentFields(targetOrder.finance, currentFinance, WHD_RETURN_FIELDS);
        preserved += 1;
      }
    });
    return preserved;
  }

  function shipGroupKey(product) {
    if (!product) return null;
    var sku = cleanText(product.sku);
    var purchaseNo = cleanText(product.purchaseNo);
    var express = cleanText(product.purchaseExpress);
    if (!sku || !purchaseNo || !express) return null;
    return sku + '\u0001' + purchaseNo + '\u0001' + express;
  }

  function orderSortKey(order) {
    return cleanText(order && order.orderTime) + '\u0001' + cleanText(order && order.posting);
  }

  function isCancelledStatus(status) {
    var text = cleanText(status);
    return text.indexOf('取消') >= 0 || text.indexOf('未接受') >= 0;
  }

  function groupBg(key) {
    var hash = 0;
    for (var i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return 'hsl(' + (hash % 360) + ', ' + (45 + ((hash >>> 4) % 16)) + '%, ' + (93 + ((hash >>> 8) % 4)) + '%)';
  }

  function buildShipGroups(list) {
    var candidates = {};
    (list || []).forEach(function (order) {
      var posting = cleanText(order && order.posting);
      (order && order.items || []).forEach(function (product, itemIndex) {
        var key = shipGroupKey(product);
        if (!key || !posting) return;
        if (!candidates[key]) candidates[key] = [];
        candidates[key].push({
          posting: posting,
          itemIndex: itemIndex,
          orderTime: cleanText(order.orderTime),
          sortKey: orderSortKey(order),
          hasShipping: numberOrNull(product.domesticShipping) > 0
        });
      });
    });
    var result = {};
    Object.keys(candidates).forEach(function (key) {
      var members = candidates[key];
      var postings = {};
      members.forEach(function (member) { postings[member.posting] = true; });
      if (Object.keys(postings).length < 2) return;
      members.sort(function (left, right) {
        return left.sortKey.localeCompare(right.sortKey) || left.itemIndex - right.itemIndex;
      });
      var holder = members.find(function (member) { return member.hasShipping; }) || members[0];
      result[key] = {
        time: members[0].orderTime,
        bg: groupBg(key),
        holderPosting: holder.posting,
        holderItem: holder.itemIndex,
        postings: Object.keys(postings)
      };
    });
    return result;
  }

  function isInventoryConsumer(order) {
    if (!order || isCancelledStatus(order.status) || cleanText(order.retFrom)) return false;
    return !(order.finance && order.finance.resaleIncomeRub != null);
  }

  function applyStock(list) {
    var pools = {};
    (list || []).forEach(function (order) {
      (order && order.items || []).forEach(function (product, itemIndex) {
        if (!product) return;
        delete product._stk;
        delete product._stkLeft;
        if (!product.stockIn || !cleanText(product.sku)) return;
        var stockQty = quantity(product.stockIn.qty, 0);
        if (!(stockQty > 0) || cleanText(product.stockIn.purchaseExpress)) return;
        var sku = cleanText(product.sku);
        if (!pools[sku]) pools[sku] = [];
        pools[sku].push({
          srcPosting: cleanText(order.posting),
          srcItem: itemIndex,
          sourceTime: cleanText(order.orderTime),
          sourceSortKey: orderSortKey(order),
          qty: stockQty,
          price: numberOrNull(product.stockIn.purchasePrice),
          left: stockQty,
          used: []
        });
      });
    });
    Object.keys(pools).forEach(function (sku) {
      pools[sku].sort(function (left, right) {
        return left.sourceSortKey.localeCompare(right.sourceSortKey) || left.srcItem - right.srcItem;
      });
    });

    var orders = (list || []).filter(isInventoryConsumer).slice().sort(function (left, right) {
      return orderSortKey(left).localeCompare(orderSortKey(right));
    });
    orders.forEach(function (order) {
      var consumerTime = cleanText(order.orderTime);
      var consumerSortKey = orderSortKey(order);
      (order.items || []).forEach(function (product, itemIndex) {
        var sku = cleanText(product && product.sku);
        var slots = pools[sku];
        if (!product || !sku || !slots) return;
        if (product.stockIn && quantity(product.stockIn.qty, 0) > 0) return;
        var need = quantity(product.qty, 1);
        var allocations = [];
        for (var index = 0; index < slots.length && need > 0; index += 1) {
          var slot = slots[index];
          if (slot.left <= 0 || slot.srcPosting === cleanText(order.posting)) continue;
          // 缺少下单时间时无法证明库存早于订单，宁可不自动扣减，避免错配。
          if (!slot.sourceTime || !consumerTime) continue;
          if (slot.sourceSortKey >= consumerSortKey) continue;
          var take = Math.min(need, slot.left);
          slot.left -= take;
          slot.used.push({ posting: order.posting, item: itemIndex, qty: take, time: cleanText(order.orderTime) });
          allocations.push({ qty: take, price: slot.price, srcPosting: slot.srcPosting, srcItem: slot.srcItem });
          need -= take;
        }
        if (allocations.length) {
          product._stk = {
            qty: allocations.reduce(function (sum, allocation) { return sum + allocation.qty; }, 0),
            allocations: allocations
          };
        }
      });
    });

    (list || []).forEach(function (order) {
      (order && order.items || []).forEach(function (product, itemIndex) {
        if (!product || !product.stockIn) return;
        var slots = pools[cleanText(product.sku)] || [];
        var slot = slots.find(function (candidate) {
          return candidate.srcPosting === cleanText(order.posting) && candidate.srcItem === itemIndex;
        });
        if (slot) product._stkLeft = { qty: slot.qty, left: slot.left, used: slot.used.slice() };
      });
    });
    return pools;
  }

  function localInventoryRows(list) {
    applyStock(list);
    var rows = [];
    (list || []).forEach(function (order) {
      (order && order.items || []).forEach(function (product, itemIndex) {
        var stockIn = product && product.stockIn;
        var inboundQty = quantity(stockIn && stockIn.qty, 0);
        if (!product || !(inboundQty > 0)) return;
        var automatic = !cleanText(stockIn.purchaseExpress);
        var balance = product._stkLeft;
        rows.push({
          product: product,
          sourcePosting: cleanText(order.posting),
          sourceItem: itemIndex,
          inboundAt: cleanText(stockIn.inboundAt),
          inboundQty: inboundQty,
          left: automatic && balance ? balance.left : inboundQty,
          purchasePrice: numberOrNull(stockIn.purchasePrice),
          domesticShipping: numberOrNull(stockIn.domesticShipping),
          automatic: automatic,
          outbounds: automatic && balance ? balance.used.slice() : []
        });
      });
    });
    return rows.sort(function (left, right) {
      return right.inboundAt.localeCompare(left.inboundAt) || right.sourcePosting.localeCompare(left.sourcePosting) || left.sourceItem - right.sourceItem;
    });
  }

  function localInventoryProducts(list) {
    var groups = {};
    localInventoryRows(list).forEach(function (row) {
      var product = row.product || {};
      var key = cleanText(product.sku) || cleanText(product.offerId) || (row.sourcePosting + ':' + row.sourceItem);
      if (!groups[key]) {
        groups[key] = {
          key: key,
          product: product,
          left: 0,
          inboundQty: 0,
          lastInboundAt: row.inboundAt,
          purchasePrice: row.purchasePrice,
          domesticShipping: row.domesticShipping,
          hasManual: false,
          inbounds: [],
          outbounds: []
        };
      }
      var group = groups[key];
      group.left += Number(row.left) || 0;
      group.inboundQty += Number(row.inboundQty) || 0;
      group.hasManual = group.hasManual || !row.automatic;
      group.inbounds.push({
        time: row.inboundAt,
        qty: row.inboundQty,
        purchasePrice: row.purchasePrice,
        domesticShipping: row.domesticShipping,
        posting: row.sourcePosting,
        item: row.sourceItem,
        automatic: row.automatic
      });
      (row.outbounds || []).forEach(function (record) {
        var match = group.outbounds.find(function (existing) {
          return cleanText(existing.time) === cleanText(record.time) && cleanText(existing.posting) === cleanText(record.posting);
        });
        if (match) match.qty += Number(record.qty) || 0;
        else group.outbounds.push({ time: cleanText(record.time), posting: cleanText(record.posting), qty: Number(record.qty) || 0 });
      });
    });
    return Object.keys(groups).map(function (key) {
      var group = groups[key];
      group.inbounds.sort(function (left, right) { return right.time.localeCompare(left.time); });
      group.outbounds.sort(function (left, right) { return right.time.localeCompare(left.time); });
      return group;
    }).sort(function (left, right) {
      return right.lastInboundAt.localeCompare(left.lastInboundAt) || left.key.localeCompare(right.key);
    });
  }

  function allocationCost(product, covered) {
    var fallbackPrice = numberOrNull(product && product.purchasePrice);
    var remaining = covered;
    var cost = 0;
    var allocations = product && product._stk && Array.isArray(product._stk.allocations) ? product._stk.allocations : [];
    allocations.forEach(function (allocation) {
      if (remaining <= 0) return;
      var used = Math.min(remaining, quantity(allocation.qty, 0));
      var price = numberOrNull(allocation.price);
      if (price == null) price = fallbackPrice;
      if (price != null) cost += price * used;
      remaining -= used;
    });
    if (remaining > 0 && fallbackPrice != null) cost += fallbackPrice * remaining;
    return cost;
  }

  function combineCostNum(combine) {
    var total = 0;
    (combine || []).forEach(function (row) {
      if (!row) return;
      var price = numberOrNull(row.purchasePrice);
      var shipping = numberOrNull(row.domesticShipping);
      total += (price == null ? 0 : price) + (shipping == null ? 0 : shipping);
    });
    return Math.round(total * 100) / 100;
  }

  function savedPurchaseCostNumber(value) {
    if (value == null || value === '' || value === '--') return null;
    var text = String(value).replace(/[¥￥]/g, '').replace(/,/g, '').trim();
    var parsed = Number(text);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  // 同订单总数量为1时，订单商品行就是最可靠的采购成本快照。
  // 多件订单的国内快递费可能是整单/分摊口径，不在这里推断；组合订单也继续走组合专用规则。
  function singleQuantityPurchaseCost(order) {
    if (!order || typeof order !== 'object' || (Array.isArray(order.combine) && order.combine.length)) return null;
    var items = (Array.isArray(order.items) ? order.items : []).filter(Boolean);
    if (items.length !== 1) return null;
    var qty = Number(items[0].qty);
    if (!Number.isSafeInteger(qty) || qty !== 1) return null;
    var price = numberOrNull(items[0].purchasePrice);
    if (price == null || price <= 0) return null;
    var shippingRaw = items[0].domesticShipping;
    var shipping = shippingRaw == null || shippingRaw === '' || shippingRaw === '--' ? 0 : numberOrNull(shippingRaw);
    if (shipping == null) return null;
    return Math.round((price + shipping) * 100) / 100;
  }

  function ensureSingleQuantityPurchaseCost(order) {
    if (!order || typeof order !== 'object') return false;
    order.finance = order.finance && typeof order.finance === 'object' ? order.finance : {};
    if (savedPurchaseCostNumber(order.finance.purchaseCost) != null) return false;
    var calculated = singleQuantityPurchaseCost(order);
    if (calculated == null) return false;
    order.finance.purchaseCost = calculated;
    return true;
  }

  function purchaseCostNum(items, options) {
    options = options || {};
    var groups = options.groups || {};
    var posting = cleanText(options.posting);
    var chargedShippingGroups = {};
    var total = 0;
    (items || []).forEach(function (product, itemIndex) {
      if (!product) return;
      var itemQty = quantity(product.qty, 1);
      var covered = product._stk ? Math.min(quantity(product._stk.qty, 0), itemQty) : 0;
      var ownPrice = numberOrNull(product.purchasePrice);
      if (covered > 0) total += allocationCost(product, covered);
      var rest = itemQty - covered;
      if (rest > 0 && ownPrice != null) total += ownPrice * rest;

      var shipping = numberOrNull(product.domesticShipping);
      if (shipping == null || shipping <= 0 || rest <= 0) return;
      var key = shipGroupKey(product);
      var group = key && groups[key];
      if (group && (group.holderPosting !== posting || group.holderItem !== itemIndex)) return;
      if (key && chargedShippingGroups[key]) return;
      if (key) chargedShippingGroups[key] = true;
      total += shipping;
    });
    total += combineCostNum(options.combine);
    return Math.round(total * 100) / 100;
  }

  return {
    shipGroupKey: shipGroupKey,
    buildShipGroups: buildShipGroups,
    combineCostNum: combineCostNum,
    applyStock: applyStock,
    localInventoryRows: localInventoryRows,
    localInventoryProducts: localInventoryProducts,
    purchaseCostNum: purchaseCostNum,
    singleQuantityPurchaseCost: singleQuantityPurchaseCost,
    ensureSingleQuantityPurchaseCost: ensureSingleQuantityPurchaseCost,
    preserveManualOrderData: preserveManualOrderData,
    preserveMeaningfulManualOrderData: preserveMeaningfulManualOrderData,
    preserveAuthoritativeWhdData: preserveAuthoritativeWhdData,
    normalizeManualOrderSnapshot: normalizeManualOrderSnapshot,
    createManualOrderSnapshot: createManualOrderSnapshot,
    hasMeaningfulManualValue: hasMeaningfulManualValue,
    sanitizeDecimalInput: sanitizeDecimalInput,
    sanitizeIntegerInput: sanitizeIntegerInput,
    sanitizeOrderIdentifier: sanitizeOrderIdentifier,
    isCancelledStatus: isCancelledStatus,
    isInventoryConsumer: isInventoryConsumer
  };
});
