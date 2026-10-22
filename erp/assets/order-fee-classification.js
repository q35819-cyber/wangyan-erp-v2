/* 网研ERP — Ozon订单费用统一分类：兼容数字type_id、Seller字符串类型和旧数据错误kind */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ORDER_FEE_CLASSIFICATION = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CATEGORY_LABELS = {
    comm: '销售佣金',
    acq: '收单业务费',
    intl: '国际物流费',
    logistics: 'Ozon物流费',
    last: '尾程配送费',
    return: '退货/拒收费用',
    advertising: '广告推广费',
    other: '其它费用'
  };

  var ID_CATEGORY = Object.create(null);
  function assign(ids, category) { ids.forEach(function (id) { ID_CATEGORY[String(id)] = category; }); }

  assign([69], 'comm');
  assign([1, 63, 66], 'acq');
  assign([67, 99, 100, 122], 'intl');
  assign([32, 64, 73, 114, 120, 121], 'logistics');
  assign([28, 29, 30, 44, 98, 110, 111, 112], 'last');
  assign([2, 6, 9, 40, 45, 53, 59, 60, 65, 71, 78, 113, 115], 'return');
  assign([3, 4, 5, 19, 23, 31, 33, 36, 41, 49, 54, 55, 61, 70, 74, 75, 87, 95, 96, 116], 'advertising');

  var AD_LABELS = {
    3: '品牌推广', 4: '品牌推广服务', 5: '品牌专柜', 19: '站外推广',
    23: '站内广告', 31: '线索营销', 33: '营销服务', 36: '预售引流',
    41: '按点击付费', 49: 'Premium推广', 54: '商品推广', 55: '推送活动',
    61: '评价置顶', 70: '评价获取', 74: '星星商品', 75: '模板推广',
    87: '社交媒体广告', 95: '评论管理订阅', 96: '加速评论收集', 116: '首评收集'
  };
  var AD_CHARGE_LABELS = { CPC: '按点击付费', CPO: '按订单付款', CPM: '按千次展示', OTHER: '其它推广费用' };
  var OTHER_LABELS = {
    93: '错误指数超标罚款',
    123: '物流平台连接服务费'
  };

  function text(value) { return String(value == null ? '' : value).trim(); }
  function feeType(item) { return text(item && (item.type != null ? item.type : item.accrual_type)).toLowerCase(); }
  function searchable(item) {
    return [feeType(item), item && item.rawType, item && item.name, item && item.rawName, item && item.desc, item && item.description]
      .map(text).join(' ');
  }
  function classify(item) {
    var type = feeType(item);
    if (Object.prototype.hasOwnProperty.call(ID_CATEGORY, type)) return ID_CATEGORY[type];
    var haystack = searchable(item);
    if (/sale.?commission|sales_fee|fee_refund|вознаграждение за продажу|комиссия за продажу/i.test(haystack)) return 'comm';
    if (/acquir|эквайр|rfbsglobalagentfee|agency_fee_ozon|агентское вознаграждение ozon/i.test(haystack)) return 'acq';
    if (/international|международн|rfbsglobaldelivery|internationaldelivery|international_logistic|международная логистика|организац[^]*международн.*перевоз/i.test(haystack)) return 'intl';
    if (/last.?mile|последн[^]*мил|deliverytohandover|courierclientreinvoice|pickup.*courier.*deliver|доставка до места выдачи|выдача товара|доставка курьером/i.test(haystack)) return 'last';
    if (/backward|reverse.?logistic|returnflow|clientreturn|partialreturn|returnacceptance|preparingtoreturn|sellerreturns|easyreturn|обратн[^]*логист|возврат|отмен[^]*невостреб|невыкуп/i.test(haystack)) return 'return';
    if (/brand.?promotion|brandcommission|brandshelf|externalpromotion|internetsiteadvertising|leadgeneration|marketing|ordersbooking|payperclick|premiumcashbackpromotion|promotion|pushcampaign|reviewspin|salereview|starsmembership|star_products|stencil|socialmediaadvertising|customerreviews|acceleratedreviewcollection|firstcustomerreview|продвиж|реклам|трафарет|закреплен[^]*отзыв|сбор первых отзывов|приобретение отзывов/i.test(haystack)) return 'advertising';
    if (/\blogistics?\b|rfbsdomesticdelivery|shipment|b2clogistics|доставка партнером ozon|\bлогистика\b|магистраль/i.test(haystack)) return 'logistics';
    return 'other';
  }

  function costAmount(item) {
    if (!item) return 0;
    var signed = Number(item.signedAmount);
    if (Number.isFinite(signed) && signed !== 0) return -signed;
    var amount = Number(item.amount);
    if (!Number.isFinite(amount) || amount === 0) return 0;
    var direction = text(item.direction).toLowerCase();
    if (direction === 'credit' || direction === 'refund' || direction === 'income') return -Math.abs(amount);
    if (direction === 'charge' || direction === 'debit' || direction === 'expense') return Math.abs(amount);
    return Math.abs(amount);
  }
  function round(value) { return Math.round((Number(value) || 0) * 100) / 100; }
  function displayLabel(item, category) {
    var type = feeType(item);
    if (category === 'advertising' && Object.prototype.hasOwnProperty.call(AD_LABELS, type)) return AD_LABELS[type];
    if (category === 'other' && Object.prototype.hasOwnProperty.call(OTHER_LABELS, type)) return OTHER_LABELS[type];
    if (category === 'other') {
      var raw = text(item && (item.rawName || item.desc || item.description || item.name || item.rawType));
      return raw ? '未映射平台费：' + raw : '未映射平台费';
    }
    return text(item && (item.label || item.nameZh || item.rawName || item.desc || item.description || item.name)) || CATEGORY_LABELS[category] || '其它费用';
  }
  function advertisingChargeModel(item) {
    var explicit = text(item && (item.chargeModel || item.charge_model || item.paymentMethod || item.payment_method)).toUpperCase();
    if (explicit === 'CPC' || explicit === 'CPO' || explicit === 'CPM') return explicit;
    var type = feeType(item), haystack = searchable(item);
    if (type === '41' || /pay.?per.?click|cost.?per.?click|оплата за клик|за клик|\bcpc\b/i.test(haystack)) return 'CPC';
    // Ozon Finance type 54（Promotion / Продвижение товара）是按订单付费推广结算。
    if (type === '54' || /pay.?per.?order|cost.?per.?order|operationpromotionwithcostperorder|оплата за заказ|за заказ|search[_ -]?promo|\bcpo\b/i.test(haystack)) return 'CPO';
    if (/cost.?per.?mille|за 1000 показ|за тысячу показ|\bcpm\b/i.test(haystack)) return 'CPM';
    return 'OTHER';
  }
  function isOrderAttributableAdvertising(item) {
    var model = advertisingChargeModel(item);
    return model !== 'CPC' && model !== 'CPM';
  }

  function summarize(items) {
    var result = {
      comm: 0, acq: 0, intl: 0, logistics: 0, last: 0, return: 0, advertising: 0, other: 0,
      totalCostRub: 0, advertisingOrderCostRub: 0, advertisingUnallocatedRub: 0,
      advertisingBreakdown: [], advertisingChargeBreakdown: [], normalizedItems: []
    };
    var breakdown = new Map(), chargeBreakdown = new Map();
    (Array.isArray(items) ? items : []).forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      var category = classify(raw);
      var cost = costAmount(raw);
      // 把最新分类写回 kind，避免历史缓存残留 kind=other 时被其它消费者错类。
      var item = Object.assign({}, raw, { kind: category, normalizedKind: category, normalizedCostRub: round(cost) });
      result[category] += cost;
      result.totalCostRub += cost;
      result.normalizedItems.push(item);
      if (category === 'advertising') {
        var label = displayLabel(raw, category);
        var chargeModel = advertisingChargeModel(raw);
        var chargeLabel = AD_CHARGE_LABELS[chargeModel] || AD_CHARGE_LABELS.OTHER;
        var orderAttributable = isOrderAttributableAdvertising(raw);
        var key = chargeModel + '|' + feeType(raw) + '|' + label;
        var entry = breakdown.get(key);
        if (!entry) {
          entry = { type: feeType(raw), label: label, chargeModel: chargeModel, chargeLabel: chargeLabel, orderAttributable: orderAttributable, amountRub: 0, count: 0 };
          breakdown.set(key, entry);
        }
        entry.amountRub += cost;
        entry.count += 1;
        var charge = chargeBreakdown.get(chargeModel);
        if (!charge) { charge = { chargeModel: chargeModel, label: chargeLabel, amountRub: 0, count: 0, orderAttributable: orderAttributable }; chargeBreakdown.set(chargeModel, charge); }
        charge.amountRub += cost; charge.count += 1;
        if (orderAttributable) result.advertisingOrderCostRub += cost;
        else result.advertisingUnallocatedRub += cost;
      }
    });
    ['comm','acq','intl','logistics','last','return','advertising','other','totalCostRub','advertisingOrderCostRub','advertisingUnallocatedRub'].forEach(function (key) { result[key] = round(result[key]); });
    result.advertisingBreakdown = Array.from(breakdown.values()).map(function (entry) {
      entry.amountRub = round(entry.amountRub); return entry;
    }).sort(function (left, right) { return Math.abs(right.amountRub) - Math.abs(left.amountRub); });
    result.advertisingChargeBreakdown = Array.from(chargeBreakdown.values()).map(function (entry) {
      entry.amountRub = round(entry.amountRub); return entry;
    }).sort(function (left, right) { return Math.abs(right.amountRub) - Math.abs(left.amountRub); });
    return result;
  }

  function hasFeeItems(finance) { return Boolean(finance && Array.isArray(finance.feeItems)); }

  return {
    CATEGORY_LABELS: CATEGORY_LABELS,
    AD_LABELS: AD_LABELS,
    AD_CHARGE_LABELS: AD_CHARGE_LABELS,
    OTHER_LABELS: OTHER_LABELS,
    classify: classify,
    feeType: feeType,
    costAmount: costAmount,
    displayLabel: displayLabel,
    advertisingChargeModel: advertisingChargeModel,
    isOrderAttributableAdvertising: isOrderAttributableAdvertising,
    summarize: summarize,
    hasFeeItems: hasFeeItems
  };
});
