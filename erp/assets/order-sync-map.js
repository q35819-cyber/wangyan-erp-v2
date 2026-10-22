(function (root, factory) {
  'use strict';
  var mappings = typeof module === 'object' && module.exports ? require('./order-mappings') : root.WYERP_ORDER_MAPPINGS;
  var feeClassifier = typeof module === 'object' && module.exports ? require('./order-fee-classification') : root.WYERP_ORDER_FEE_CLASSIFICATION;
  var api = factory(mappings, feeClassifier);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_ORDER_SYNC_MAP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (orderMappings, feeClassifier) {
  'use strict';

  var STATUS_MAP = {
    waiting_for_deliver: ['等待备货', '已创建'], awaiting_registration: ['等待登记', '已登记'], waiting_for_ship: ['等待发运', '已登记'],
    awaiting_passing: ['等待交接', '已创建'], awaiting_deliver: ['等待发货', '已创建'], awaiting_packaging: ['等待打包', '已创建'],
    delivering: ['运输中', '正在发往城市途中'], delivered: ['已签收', '已完成'], cancelled: ['已取消', '已取消'],
    not_accepted: ['未接受', '已取消'], cancelled_by_seller: ['已取消', '卖家取消'], cancelled_by_client: ['已取消', '买家取消'],
    cancelled_by_ozon: ['已取消', 'Ozon取消'], cancelled_from_split_pending: ['已取消', '已取消'], cancelled_from_split_created: ['已取消', '已取消'],
    driver_pickup: ['司机自提', '已发货'], last_mile: ['派送中', '已发货'], arbitration: ['有争议的', '争议中'], client_arbitration: ['有争议的', '争议中']
  };

  function pad(value) { return String(value).padStart(2, '0'); }
  function nowString(now) { var d = now || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function formatApiTime(value) { var d = new Date(value); return value && !isNaN(d.getTime()) ? nowString(d) : ''; }
  function rub(value) { if (value == null || value === '' || value === '--') return '--'; var n = Number(value); if (isNaN(n)) return String(value) + ' RUB'; var s = (Math.round(n * 100) / 100).toFixed(2); return (s.slice(-3) === '.00' ? s.slice(0, -3) : s) + ' RUB'; }
  function prep(status) { return ['等待备货', '等待发运', '等待装运', '等待打包', '等待发货'].indexOf(status) >= 0; }
  function findItem(items, product) { return (items || []).find(function (item) { return product.offer_id && item.offerId === product.offer_id || product.sku != null && String(item.sku) === String(product.sku); }) || null; }
  function call(options, name, fallback) { return options && typeof options[name] === 'function' ? options[name] : fallback; }

  function applyPosting(order, posting, feeMap, options) {
    order = order || {};
    posting = posting || {};
    var now = call(options, 'now', function () { return new Date(); })();
    var nowText = call(options, 'nowString', nowString)(now);
    var isCancel = /^(cancelled|not_accepted)/.test(String(posting.status || ''));
    var status = STATUS_MAP[posting.status] || (isCancel ? ['已取消', '已取消'] : [String(posting.status || order.status || '--'), order.sub || '']);
    if (posting.status === 'delivering' && posting.substatus === 'posting_in_pickup_point') status = ['到取货点', '在取货点'];
    order.status = status[0]; order.sub = status[1];
    var deliverySchema = String(posting.delivery_schema || order.deliverySchema || '').toUpperCase();
    if (posting.delivery_schema) order.deliverySchema = deliverySchema;
    var base = posting.in_process_at || posting.shipment_date || posting.created_at;
    if (base && prep(order.status)) { var timestamp = new Date(base).getTime(); if (!isNaN(timestamp)) order.days = Math.max(0, Math.floor((now.getTime() - timestamp) / 86400000)); }
    if (prep(order.status) && posting.shipment_date) order.deadline = posting.shipment_date;
    var formatted = call(options, 'formatApiTime', formatApiTime)(posting.in_process_at);
    if (formatted) order.orderTime = formatted;
    order.updateTime = nowText;

    if (isCancel) {
      var cancellation = posting.cancellation || {};
      var reason = orderMappings && orderMappings.extractCancellationReason ? orderMappings.extractCancellationReason(posting) : (cancellation.cancel_reason || '');
      var cancellationType = String(cancellation.cancellation_type || '').toLowerCase();
      var initiator = String(cancellation.cancellation_initiator || '');
      var who = '系统取消';
      if (/покупател|клиент|client/i.test(cancellationType) || /покупател|клиент/i.test(initiator)) who = '买家取消';
      else if (/продавец|seller/i.test(cancellationType) || /продавец/i.test(initiator)) who = '卖家取消';
      else if (/ozon/i.test(cancellationType)) who = 'Ozon取消';
      var translateReason = call(options, 'cancelZh', orderMappings && orderMappings.cancelReasonZh ? orderMappings.cancelReasonZh : function () { return ''; });
      order.cancel = { who: who, why: reason, whyZh: translateReason(reason), shipped: !!cancellation.cancelled_after_ship, refused: /отказал|refus/i.test(reason + ' ' + cancellationType), ctype: cancellationType };
    } else order.cancel = null;
    if (posting.tracking_number) order.track = posting.tracking_number;
    else if (posting.status === 'waiting_for_ship') order.track = '';

    if (Array.isArray(posting.products) && posting.products.length) {
      order.items = posting.products.map(function (product) {
        var previous = findItem(order.items, product) || {};
        var productCurrency = String(product.price_currency_code || product.currency_code || previous.priceCurrency || '').trim().toUpperCase();
        return { name: product.name || '--', price: product.price != null ? Number(product.price) : null, qty: product.quantity != null ? product.quantity : 1,
          priceCurrency: productCurrency, priceSource: deliverySchema === 'WHD' && productCurrency === 'CNY' ? 'seller_fbo_posting_list_products_price' : (previous.priceSource || ''),
          offerId: product.offer_id || '', sku: product.sku != null ? String(product.sku) : '', img: previous.img || '', spec: previous.spec || '', specRu: previous.specRu || '',
          src: previous.src || '', srcPrice: previous.srcPrice != null ? previous.srcPrice : '--', srcRemark: previous.srcRemark != null ? previous.srcRemark : '--',
          purchaseNo: previous.purchaseNo || '', purchasePrice: previous.purchasePrice != null ? previous.purchasePrice : '--', purchaseExpress: previous.purchaseExpress || '',
          purchaseChannel: previous.purchaseChannel || '', domesticShipping: previous.domesticShipping != null ? previous.domesticShipping : '--', returnFee: previous.returnFee || '',
          remark: previous.remark || '', stockIn: previous.stockIn || null };
      });
    }

    var financial = posting.financial_data || {};
    var whdListTotal = 0, whdListEvidence = deliverySchema === 'WHD' && Array.isArray(posting.products) && posting.products.length > 0;
    (posting.products || []).forEach(function (product) {
      var price = Number(product && product.price), quantity = Number(product && product.quantity || 1);
      var priceCurrency = String(product && (product.price_currency_code || product.currency_code) || '').trim().toUpperCase();
      if (!Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity <= 0 || priceCurrency !== 'CNY') whdListEvidence = false;
      else whdListTotal += price * quantity;
    });
    var whdFinancialTotal = 0, whdFinancialEvidence = deliverySchema === 'WHD' && Array.isArray(financial.products) && financial.products.length > 0;
    (financial.products || []).forEach(function (product) {
      var price = Number(product && product.price), quantity = Number(product && product.quantity || 1);
      var priceCurrency = String(product && (product.price_currency_code || product.currency_code) || '').trim().toUpperCase();
      if (!Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity <= 0 || (priceCurrency && priceCurrency !== 'CNY')) whdFinancialEvidence = false;
      else whdFinancialTotal += price * quantity;
    });
    var totalCny = 0, totalRub = 0, totalCommission = 0, cnyComplete = Array.isArray(financial.products) && financial.products.length > 0;
    var totalPayoutRub = 0, payoutSeen = false, customerPriceRub = 0, customerPriceRubSeen = false, customerPriceCny = 0, customerPriceCnySeen = false, grossFromPayoutSeen = false;
    var customerPriceActions = [];
    (financial.products || []).forEach(function (product) {
      var price = Number(product.price), quantity = product.quantity || 1, customer = Number(product.customer_price != null ? product.customer_price : price || 0);
      if (product.price == null || product.price === '' || !Number.isFinite(price) || String(product.currency || product.price_currency || 'CNY').toUpperCase() !== 'CNY') cnyComplete = false;
      var commission = Math.abs(Number(product.commission_amount || 0)), payout = Number(product.payout || 0);
      if (Number.isFinite(price)) totalCny += price * quantity;
      const payoutRaw = product.payout, fromPayout = payoutRaw != null && payoutRaw !== '' && Number.isFinite(Number(payoutRaw));
      if (fromPayout) { totalPayoutRub += payout; payoutSeen = true; grossFromPayoutSeen = true; }
      else if (commission > 0) grossFromPayoutSeen = true;
      const explicitCustomer = product.customer_price != null ? Number(product.customer_price) : product.customerPrice != null ? Number(product.customerPrice) : null;
      const customerCurrency = String(product.customer_currency_code || product.customerCurrency || '').trim().toUpperCase();
      if (Number.isFinite(explicitCustomer) && explicitCustomer >= 0 && customerCurrency === 'RUB') { customerPriceRub += explicitCustomer * quantity; customerPriceRubSeen = true; }
      if (Number.isFinite(explicitCustomer) && explicitCustomer >= 0 && customerCurrency === 'CNY') { customerPriceCny += explicitCustomer * quantity; customerPriceCnySeen = true; }
      if (Array.isArray(product.actions)) product.actions.forEach(function (action) { var text = String(action || '').trim(); if (text && customerPriceActions.indexOf(text) < 0) customerPriceActions.push(text); });
      totalRub += payout > 0 || commission > 0 ? payout + commission : customer * quantity; totalCommission += commission;
    });
    if (totalRub > 0 && cnyComplete && totalCny > 0) order.rate = totalRub / totalCny;
    var previousFinance = order.finance || {};
    var verifiedWhdCny = whdListEvidence && whdFinancialEvidence && Math.abs(whdListTotal - whdFinancialTotal) <= 0.000001;
    var cnyTotalValue = verifiedWhdCny ? Math.round(whdListTotal * 100) / 100 : cnyComplete ? totalCny : null;
    var cnyTotalSource = verifiedWhdCny ? 'seller_fbo_posting_list_products_price' : previousFinance.cnyTotalSource;
    var cnyTotalVerificationSource = verifiedWhdCny ? 'seller_posting_financial_data_total_price' : previousFinance.cnyTotalVerificationSource;
    if (!verifiedWhdCny && deliverySchema === 'WHD' && previousFinance.cnyTotal != null
      && previousFinance.cnyTotalSource === 'seller_fbo_posting_list_products_price'
      && previousFinance.cnyTotalVerificationSource === 'seller_posting_financial_data_total_price') cnyTotalValue = previousFinance.cnyTotal;
    var delivered = posting.status === 'delivered';
    var finalized = delivered || /^(cancelled|not_accepted)/.test(String(posting.status || ''));
    var estimatedCommission = !delivered && totalCommission > 0 ? Math.round(totalCommission * 100) / 100 : previousFinance.ozonFeeEstimateRub;
    var fee = feeMap && feeMap[posting.posting_number];
    var commissionRub = null, lastMileRub = null, internationalRub = null, logisticsRub = null, advertisingRub = null, otherRub = null, returnHandlingRub = null, lastOfficial = false;
    if (finalized) {
      if (fee == null || !feeMap) {
        commissionRub = previousFinance.ozonFeeRub != null ? previousFinance.ozonFeeRub : null;
        lastMileRub = previousFinance.lastMileRub != null ? previousFinance.lastMileRub : null;
        lastOfficial = previousFinance.lastMileRub != null;
        internationalRub = previousFinance.intlLogisticsRub != null ? previousFinance.intlLogisticsRub : null;
        logisticsRub = previousFinance.logisticsFeeRub != null ? previousFinance.logisticsFeeRub : null;
        advertisingRub = previousFinance.advertisingFeeRub != null ? previousFinance.advertisingFeeRub : null;
        otherRub = previousFinance.otherFeeRub != null ? previousFinance.otherFeeRub : null;
        returnHandlingRub = previousFinance.returnHandlingFeeRub != null ? previousFinance.returnHandlingFeeRub : null;
      } else if (fee) {
        var containsOfficialCategories = Array.isArray(fee.items) && fee.items.some(function (item) { return item && item.kind !== 'acq'; });
        var normalizedFee = feeClassifier && feeClassifier.summarize && Array.isArray(fee.items) && fee.items.length
          ? (containsOfficialCategories ? feeClassifier.summarize(fee.items) : Object.assign({}, feeClassifier.summarize(fee.items), fee)) : fee;
        commissionRub = Number(normalizedFee.comm) || 0; lastMileRub = Number(normalizedFee.last) || 0; lastOfficial = true;
        internationalRub = Number(normalizedFee.intl) || 0; logisticsRub = Number(normalizedFee.logistics) || 0;
        advertisingRub = Number(normalizedFee.advertising) || 0; otherRub = Number(normalizedFee.other) || 0;
        returnHandlingRub = Number(normalizedFee.return) || 0;
      }
      var signed = fee && fee.signDate ? String(fee.signDate) : posting.analytics_data && posting.analytics_data.delivery_date_end ? String(posting.analytics_data.delivery_date_end).slice(0, 10) : '';
      if (signed) order.deliveredDate = signed.slice(0, 10);
    }
    var resale = previousFinance.resaleIncomeRub != null;
    var purchaseCost = call(options, 'calculatePurchaseCost', function () { return null; })(order.items, order.combine, order.posting);
    var bonusMap = options && options.realizationBonus || {};
    var bonusCny = delivered && bonusMap[posting.posting_number] ? Number(bonusMap[posting.posting_number]) : (previousFinance.bonusCny || null);
    var actualAcquiring = fee && fee.acq != null ? fee.acq : null;
    var estimatedAcquiring = Math.round((Math.min(totalRub, 1500) * 0.014 + Math.max(totalRub - 1500, 0) * 0.019) * 100) / 100;
    var acquiringRub = actualAcquiring != null ? actualAcquiring : totalRub > 0 ? estimatedAcquiring : null;
    order.finance = { orderAmount: rub(resale ? 0 : totalRub), cnyTotal: cnyTotalValue, cnyTotalSource: cnyTotalSource, cnyTotalVerificationSource: cnyTotalVerificationSource, orderAmountRub: resale ? 0 : totalRub,
      sellerGrossRub: resale ? 0 : totalRub, sellerGrossRubSource: grossFromPayoutSeen ? 'seller_financial_payout_plus_commission' : 'seller_financial_customer_price',
      sellerPayoutRub: payoutSeen ? Math.round(totalPayoutRub * 100) / 100 : null, sellerPayoutRubSource: payoutSeen ? 'seller_financial_product_payout' : null,
      postingPayoutRub: payoutSeen ? Math.round(totalPayoutRub * 100) / 100 : null, postingPayoutRubSource: payoutSeen ? 'seller_financial_product_payout' : null,
      customerPriceRub: customerPriceRubSeen ? Math.round(customerPriceRub * 100) / 100 : null, customerPriceRubSource: customerPriceRubSeen ? 'seller_financial_customer_price_rub_verified' : null,
      customerPriceCny: customerPriceCnySeen ? Math.round(customerPriceCny * 100) / 100 : previousFinance.customerPriceCny, customerPriceCnySource: customerPriceCnySeen ? 'seller_financial_customer_price_cny_verified' : previousFinance.customerPriceCnySource,
      customerPriceActions: customerPriceActions.length ? customerPriceActions : previousFinance.customerPriceActions || [],
      ozonSupportRub: null, ozonSupportRubSource: null,
      purchaseCost: purchaseCost || previousFinance.purchaseCost || '--', returnFeeRub: previousFinance.returnFeeRub, resaleIncomeRub: previousFinance.resaleIncomeRub,
      resaleFeeRub: previousFinance.resaleFeeRub, retResalePosting: previousFinance.retResalePosting, ozonFeeRub: commissionRub,
      ozonFee: commissionRub == null ? null : rub(commissionRub), ozonFeeEstimateRub: delivered ? null : estimatedCommission,
      acquiringRub: acquiringRub, acquiring: acquiringRub == null ? null : rub(acquiringRub), acquiringComplete: finalized && fee ? true : previousFinance.acquiringComplete,
      intlLogisticsRub: internationalRub, intlLogistics: internationalRub == null ? null : rub(internationalRub),
      logisticsFeeRub: logisticsRub, logisticsFee: logisticsRub == null ? null : rub(logisticsRub),
      advertisingFeeRub: advertisingRub, advertisingFee: advertisingRub == null ? null : rub(advertisingRub),
      lastMileRub: lastOfficial ? lastMileRub : null, lastMile: lastOfficial && lastMileRub != null ? rub(lastMileRub) : null,
      otherFeeRub: otherRub, otherFee: otherRub == null ? null : rub(otherRub),
      returnHandlingFeeRub: returnHandlingRub, returnHandlingFee: returnHandlingRub == null ? null : rub(returnHandlingRub),
      acquiringRub: acquiringRub, acquiringSource: actualAcquiring != null ? fee.acqSource || 'ozon_v1_finance_accrual_postings' : '分层公式预估', acquiringEstimated: actualAcquiring == null, acquiringComplete: actualAcquiring != null,
      accrualsComplete: Boolean(fee), actualFeeStatus: { acquiring: actualAcquiring != null ? 'actual' : 'estimated' },
      bonusCny: bonusCny,
      feeItems: fee && fee.items ? fee.items : previousFinance.feeItems || [], profit: previousFinance.profit || '--' };

    var delivery = posting.delivery_method || {}, analytics = posting.analytics_data || {};
    order.warehouse = { name: delivery.warehouse || analytics.warehouse_name || order.warehouse && order.warehouse.name || '--', method: delivery.name || order.warehouse && order.warehouse.method || '--', desc: delivery.delivery_warehouse || delivery.tpl_provider || order.warehouse && order.warehouse.desc || '--' };
    var customerData = posting.customer || {}, addressData = customerData.address || {}, addressee = posting.addressee || {};
    var buyerName = customerData.name || [customerData.customer_first_name, customerData.customer_last_name].filter(Boolean).join(' ') || addressee.name || '';
    var id = customerData.customer_id != null ? String(customerData.customer_id) : '';
    var address = addressData.address_tail ? [addressData.city || analytics.city, addressData.address_tail].filter(Boolean).join(' · ') : addressData.city ? [addressData.city, addressData.country].filter(Boolean).join(' · ') : [analytics.region, analytics.city].filter(Boolean).join(' · ');
    if (buyerName || id) order.buyer = { name: buyerName, id: id, nameZh: call(options, 'nameZh', function () { return ''; })(buyerName), address: address, addressZh: call(options, 'addressZh', function () { return ''; })(address), phone: addressee.phone || customerData.phone || '' };
    else if (!options || options.preserveMissingBuyer !== true) order.buyer = null;
    return order;
  }

  function upsert(list, posting, shop, feeMap, options) {
    var number = String(posting && posting.posting_number || '');
    var order = (list || []).find(function (item) { return String(item.posting) === number; });
    var isNew = !order;
    if (!order) {
      order = { posting: number, clientId: shop && shop.clientId || '', shop: shop && shop.name || '', status: '--', sub: '', days: 0, deadline: '', items: [], finance: null, buyer: null, warehouse: null, track: '--', rate: 0, cancel: null, orderTime: '', updateTime: '' };
      list.push(order);
    }
    if (shop && shop.clientId != null) order.clientId = shop.clientId;
    if (shop && shop.name) order.shop = shop.name;
    applyPosting(order, posting, feeMap, options);
    return { order: order, isNew: isNew, exists: !isNew };
  }

  return { STATUS_MAP: STATUS_MAP, applyPosting: applyPosting, upsert: upsert, rub: rub, formatApiTime: formatApiTime };
});
