(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WYERP_ORDER_MAPPINGS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 订单取消、拒收原因统一维护在这里。键保留 Ozon 返回的俄文原文。
  // AUTO-MAPPING-START: 服务端更新器只允许原子更新这个对象。
  var CANCEL_REASON_ZH = {
    'Товар закончился на складе': '仓库商品已售罄',
    'Товар или заводская упаковка повреждены': '商品或原厂包装已损坏',
    'Товар или заводскую упаковку повредили': '商品或原厂包装已损坏',
    'Отправление не прошло таможенное оформление': '包裹未通过海关清关',
    'Покупатель отказался при вручении: товар не подошел': '买家拒收：商品不合适',
    'Не удалось доставить заказ': '订单配送失败',
    'Покупатель отменил заказ: нашел дешевле': '买家取消：找到更便宜的商品',
    'Проверка товара на соответствие описанию в карточке': '检查商品是否与商品卡片描述相符',
    'Покупатель отменил заказ': '买家取消订单',
    'Вы отменили заказ': '卖家取消订单',
    'Покупатель отменил заказ: не устроил срок доставки': '买家取消：配送时间不合适',
    'Товар не подошёл': '商品不合适',
    'Товар не подошел': '商品不合适',
    'Покупатель не забрал заказ': '买家未取件',
    'Привезли не тот товар': '收到的商品不符',
    'Покупатель отказался при вручении: недоволен качеством товара': '买家拒收：对商品质量不满意',
    'Покупатель не предоставил персональные данные': '买家未提供个人信息'
  };

  // 订单费用名称统一维护在本文件。数字键兼容旧费用类型目录，字符串键对应 Seller 结算明细 accrual_type。
  // 未命中映射时必须优先返回接口保存的俄文原名，不能用笼统名称覆盖或丢弃，后续由 AI 只补本文件。
  var ACCRUAL_FEE_ZH = {
    1: '收单业务', 2: '逆向物流', 3: '品牌推广', 4: '品牌推广服务', 5: '品牌专柜', 6: '取消/拒收处理', 7: '公益捐赠', 8: '索赔佣金', 9: '退货处理', 10: '赔偿',
    11: '对账修正', 12: '跨境中转', 13: '取货点快递安排', 14: '卖家失误处理', 15: '销毁处理',
    16: 'Drop-off处理', 17: 'Drop-off代理处理', 18: '提前回款', 19: '站外推广', 20: '灵活结算',
    21: '订单打包', 22: '分期付款', 23: '站内广告', 24: '卡片克隆', 25: '商品赔偿',
    26: '哈萨克斯坦分期', 27: '正品标识', 28: '尾程配送', 29: '尾程配送(取货点)', 30: '取货点自提',
    31: '线索营销', 32: '物流', 33: '营销服务', 34: '强制标签', 35: '商品审核',
    36: '预售引流', 37: 'Ozon数据服务', 38: '包装材料', 39: '包装服务', 40: '部分拒收处理',
    41: '按点击付费', 42: 'Pick-up处理', 43: '取货点快递安排', 44: '快递配送(取货点)', 45: '退货拒收处理',
    46: '仓储上架', 47: '评价积分', 48: '卖家积分', 49: 'Premium推广', 50: '卖家推送积分',
    51: 'Premium Pro订阅', 52: 'Premium订阅', 53: '退货准备', 54: '商品推广', 55: '推送活动',
    56: '量子处理物流', 57: '结算修正', 58: '仓库调拨', 59: '退货物流', 60: '退货长期仓储',
    61: '评价置顶', 62: '买家运费转付', 63: '聚合商代理费', 64: 'Ozon配送', 65: '轻松退货',
    66: '收单业务费', 67: '国际物流配送', 68: '平台对接服务费', 69: '销售佣金', 70: '评价获取',
    71: '卖家退货取件', 72: '合同对账', 73: '干线运输', 74: '星星商品', 75: '模板', 76: '库存保险', 77: '入仓处理', 78: '短期退货存放', 79: '临时仓配', 80: '视频封面',
    81: '销售目标奖励', 82: 'OVX处理', 83: '保证金', 84: '额外打包', 85: '封箱',
    86: '独联体取货点打包', 87: '社交媒体广告', 88: '自提', 89: '违规内容罚款', 90: '违禁品罚款',
    91: '侵权罚款', 92: '买家投诉罚款', 93: '错误率罚款', 94: '延迟发货罚款', 95: '评论管理订阅',
    96: '加速评论收集', 97: '包裹处理', 98: 'Ozon配送至取货点', 99: '国际物流差额', 100: '国际运输服务',
    101: '大件处理', 102: '临时存放', 103: '销毁', 104: '保险赔偿', 105: '投保',
    106: 'B2C Drop-off', 107: 'B2C Drop-off代理', 108: '包装材料', 109: '包裹打包', 110: '尾程配送(伙伴)',
    111: 'Ozon配送至取货点', 112: '取货点自提(伙伴)', 113: '退货拒收处理', 114: '物流', 115: '逆向物流',
    116: '首评收集', 117: '类目限额提升', 118: '品牌认证', 119: '买家聊天积分', 122: 'realFBS全球中介服务费', 123: 'realFBS全球平台接入服务费',
    99901: '新处理测试费', 99902: '附加配送佣金', 99903: '礼品盒包装费',
    acquiring: '收单业务费',
    acquiring_fee: '收单业务费',
    agency_fee_ozon: '收单业务费',
    courier_client_reinvoice: '买家快递配送费转付',
    custom_type_999: '专项服务费',
    custom_type_test_1789682529328: '专项服务费',
    custom_type_test_1789682587491: '专项服务费',
    custom_type_test_1789682962684: '专项服务费',
    custom_type_test_1789683516333: '专项服务费',
    custom_type_test_1789684322393: '专项服务费',
    custom_type_test_1789684438288: '专项服务费',
    custom_type_test_1789684689045: '专项服务费',
    custom_type_test_1789684784901: '专项服务费',
    custom_type_test_1789684902426: '专项服务费',
    custom_type_test_1789685080366: '专项服务费',
    custom_type_test_1789688619264: '专项服务费',
    custom_type_test_1789754684824: '专项服务费',
    custom_type_test_1789755081552: '专项服务费',
    custom_type_test_1790983667874: '专项服务费',
    custom_type_test_1791328062981: '专项服务费',
    fee_refund: '销售佣金返还/冲正',
    first_customer_review: '首次评价收集服务费',
    international_delivery_services: '国际物流服务费',
    logistics: 'Ozon物流配送费',
    reverse_logistics: '逆向物流费',
    sales_fee: 'Ozon销售佣金',
    star_products: '星级商品服务费',
    unknown_fee: '未知费用',
    'дополнительная комиссия за доставку': '配送附加佣金',
    'дополнительная услуга доставки': '附加配送服务',
    'новый тестовый сбор за обработку': '新处理测试费',
    'плата за доставку курьером': '快递员配送费',
    'сбор за упаковку подарочной коробки': '礼品盒包装费',
    'тестовый сбор за обработку': '测试处理费'
  };
  // AUTO-MAPPING-END

  // 订单金额明细中的价格活动统一维护在这里。原始 actions 继续保存在订单数据中，页面只使用中文映射。
  var PRICE_ACTION_ZH = {
    'Системная виртуальная скидка селлера Россия (CNY)': '系统虚拟卖家折扣（俄罗斯，CNY）',
    'Округление': '金额取整',
    'Скидка (за счет Озон) - DD GLOBAL SKU CNY сет 1': 'Ozon承担折扣 - DD GLOBAL SKU CNY 第1组',
    'Скидка (за счет Озон) - OA GLOBAL SKU CNY  сет 2': 'Ozon承担折扣 - OA GLOBAL SKU CNY 第2组',
    'Льготный период по кредитной карте Озон Банка': 'Ozon银行信用卡免息期',
    'Эластичный бустинг. Без ограничения срока действия': '弹性加速（无期限限制）',
    'Максимальный бустинг: усиление': '最大加速：增强',
    '[Оплата Баллами] Стандартные условия (до 90%)': '[积分支付] 标准条件（最高90%）',
    'Скидка (за счет Озон) - DD GLOBAL SKU CNY сет 1 (CIS)': 'Ozon承担折扣 - DD GLOBAL SKU CNY 第1组（CIS）',
    'Округление для Казахстана': '哈萨克斯坦金额取整',
    'Акция Звезд до 1рубля (ПЛ Звезды от Озон Банка)': '星星活动低至1卢布（Ozon银行星星计划）'
  };

  var PARTIAL_REASONS = [
    [/товар закончился|закончился на складе/i, '仓库商品已售罄'],
    [/таможен/i, '包裹未通过海关清关'],
    [/покупатель отказался[^]*товар не подошел/i, '买家拒收：商品不合适'],
    [/покупатель отказался/i, '买家拒收'],
    [/отказ[^]*при вручении/i, '买家收货时拒收'],
    [/не предоставил персональные данные/i, '买家未提供个人信息'],
    [/не удалось доставить/i, '订单配送失败'],
    [/наш[её]л дешевле/i, '买家取消：找到更便宜的商品'],
    [/не устроил срок доставки/i, '买家取消：配送时间不合适'],
    [/соответствие описанию/i, '检查商品是否与商品卡片描述相符'],
    [/покупатель отменил/i, '买家取消订单'],
    [/вы отменили/i, '卖家取消订单']
  ];

  // AUTO-MAPPING-START: 服务端更新器只允许原子更新这个对象。
      var RETURN_STATUS_ZH = {
    '销毁中': '正在由Ozon进行销毁', '已到退货仓库': '在仓库', '已销毁': '已销毁', '已由Ozon销毁': '已销毁', '在仓库': '在仓库', '在仓库中': '在仓库',
    '正在由Ozon进行销毁': '正在由Ozon进行销毁', '正在运往仓库': '运往Ozon仓库', ArrivedAtReturnPlace: '在仓库', ArrivedAtWarehouse: '在仓库',
    MoneyReturned: '退款已返还', MovingToOzon: '运往Ozon仓库', MovingToSeller: '退回卖家途中', MovingToWarehouse: '运往仓库中',
    ReceivedBySeller: '卖家已收到退货', ReturnedToOzon: '在仓库', ReturningToSellerByCourier: '退回卖家途中', Utilized: '已销毁',
    UtilizedByOzon: '已销毁', Utilizing: '正在由Ozon进行销毁', UtilizingByOzon: '正在由Ozon进行销毁'
  };
  // AUTO-MAPPING-END

  function text(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (typeof value === 'object') {
      return text(value.name || value.title || value.reason || value.message || value.description || value.value);
    }
    return '';
  }

  function hasCyrillic(value) {
    return /[А-Яа-яЁё]/.test(text(value));
  }

  function normalizedLookup(value) {
    return text(value).replace(/\s+/g, ' ').toLowerCase();
  }

  function extractCancellationReason(posting) {
    posting = posting || {};
    var cancellation = posting.cancellation || {};
    var candidates = [
      cancellation.cancel_reason,
      cancellation.cancellation_reason,
      cancellation.rejection_reason,
      cancellation.refusal_reason,
      cancellation.return_reason,
      cancellation.reason,
      posting.cancel_reason,
      posting.cancellation_reason,
      posting.rejection_reason,
      posting.refusal_reason,
      posting.return_reason
    ];
    for (var i = 0; i < candidates.length; i += 1) {
      var result = text(candidates[i]);
      if (result) return result;
    }
    return '';
  }

  function cancelReasonZh(reason) {
    var source = text(reason);
    if (!source) return '';
    if (CANCEL_REASON_ZH[source]) return CANCEL_REASON_ZH[source];
    for (var i = 0; i < PARTIAL_REASONS.length; i += 1) {
      if (PARTIAL_REASONS[i][0].test(source)) return PARTIAL_REASONS[i][1];
    }
    return '取消/拒收原因待补充映射';
  }

  function hasCancellationReason(reason) {
    var source = text(reason);
    if (!source) return true;
    if (CANCEL_REASON_ZH[source]) return true;
    for (var i = 0; i < PARTIAL_REASONS.length; i += 1) {
      if (PARTIAL_REASONS[i][0].test(source)) return true;
    }
    return false;
  }

  function returnStatusZh(status) {
    return RETURN_STATUS_ZH[text(status)] || '';
  }

  function accrualFeeNameZh(item) {
    item = item || {};
    var type = text(item.type || item.accrual_type || item.rawType || item.type_id);
    var normalized = type.toLowerCase();
    if (type && Object.prototype.hasOwnProperty.call(ACCRUAL_FEE_ZH, type)) return ACCRUAL_FEE_ZH[type];
    if (normalized && Object.prototype.hasOwnProperty.call(ACCRUAL_FEE_ZH, normalized)) return ACCRUAL_FEE_ZH[normalized];
    var suppliedName = text(item.name || item.rawName || item.desc || item.description || item.title);
    if (suppliedName) {
      if (Object.prototype.hasOwnProperty.call(ACCRUAL_FEE_ZH, suppliedName)) return ACCRUAL_FEE_ZH[suppliedName];
      if (Object.prototype.hasOwnProperty.call(ACCRUAL_FEE_ZH, suppliedName.toLowerCase())) return ACCRUAL_FEE_ZH[suppliedName.toLowerCase()];
    }
    if (suppliedName) return suppliedName;
    if (type) return type;
    return '接口未返回费用名称';
  }

  function accrualFeeDisplayNameZh(item) {
    var mapped = accrualFeeNameZh(item);
    return hasCyrillic(mapped) ? '费用名称待补充映射' : mapped;
  }

  function priceActionZh(value) {
    var source = text(value);
    if (!source) return '';
    if (Object.prototype.hasOwnProperty.call(PRICE_ACTION_ZH, source)) return PRICE_ACTION_ZH[source];
    var normalized = normalizedLookup(source);
    var keys = Object.keys(PRICE_ACTION_ZH);
    for (var i = 0; i < keys.length; i += 1) {
      if (normalizedLookup(keys[i]) === normalized) return PRICE_ACTION_ZH[keys[i]];
    }
    return hasCyrillic(source) ? '价格活动待补充映射' : source;
  }

  return {
    CANCEL_REASON_ZH: CANCEL_REASON_ZH,
    extractCancellationReason: extractCancellationReason,
    cancelReasonZh: cancelReasonZh,
    hasCancellationReason: hasCancellationReason,
    RETURN_STATUS_ZH: RETURN_STATUS_ZH,
    returnStatusZh: returnStatusZh,
    ACCRUAL_FEE_ZH: ACCRUAL_FEE_ZH,
    accrualFeeNameZh: accrualFeeNameZh,
    accrualFeeDisplayNameZh: accrualFeeDisplayNameZh,
    PRICE_ACTION_ZH: PRICE_ACTION_ZH,
    priceActionZh: priceActionZh
  };
});
