(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ONLINE_STATUS = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var ERROR_TEXT = {
    video_cover_link_invalid: '视频封面链接无效，请重新生成视频封面，并确认视频符合 OZON 要求',
    description_decline: '商品描述审核未通过：描述可能存在无意义内容、语法问题或外语占比过高',
    attribute_is_required: '缺少类目必填属性，请补充商品属性后重新提交',
    attribute_value_invalid: '商品属性值不符合类目要求，请按可选值重新填写',
    barcode_invalid: '商品条码格式无效，请检查条码后重新提交',
    category_not_found: '商品类目无效或已调整，请重新选择正确类目',
    description_invalid: '商品描述不符合平台要求，请检查内容和格式',
    image_invalid: '商品图片不符合平台要求，请检查尺寸、格式和清晰度',
    price_invalid: '商品价格无效，请检查销售价和划线价',
    price_too_low: '商品价格低于平台允许范围，请调整销售价',
    price_too_high: '商品价格高于平台允许范围，请调整销售价',
    weight_invalid: '商品重量无效，请填写正确的重量和单位',
    dimensions_invalid: '商品长、宽、高数据无效，请填写正确尺寸',
    name_invalid: '商品名称不符合平台要求，请修改名称后重新提交'
  };

  var STATUS_TEXT = {
    price_sent: '价格已提交，平台正在处理商品销售状态',
    moderate: '商品正在等待平台审核', moderated: '商品已通过平台审核',
    validation_state_pending: '商品正在等待资料校验',
    variant_wait: '商品资料尚未完整，需要继续修改',
    ready_to_supply: '商品资料已准备完成，等待补充库存',
    declined: '商品审核未通过，需要修改后重新提交',
    failed: '商品处理失败，需要根据错误提示修改',
    archived: '商品已经归档，不再参与销售'
  };

  var DEFAULT_INFO = {
    active: { reason: '商品正在 OZON 平台正常销售', action: '无需处理，保持价格和库存信息及时同步。' },
    ready: { reason: '商品当前没有可售库存，暂时无法产生订单', action: '选择正确仓库并补充库存，等待平台更新销售状态。' },
    error: { reason: '商品更新或平台审核失败', action: '根据错误说明修改商品资料，然后重新提交平台审核。' },
    pending: { reason: '商品存在警告或资料尚未处理完成', action: '检查商品属性、图片、描述、价格和库存后重新提交。' },
    offline: { reason: '商品已从销售中移除', action: '检查下架原因；如需继续销售，请修正商品信息后重新上架。' },
    archived: { reason: '商品已手动归档', action: '如需继续使用该商品，请在已归档列表点击“恢复”；恢复后还需补充库存才能重新销售。' }
  };
  var SELLER_PORTAL = 'https://seller.ozonru.cn/';
  var SELLER_PORTAL_BACKUP = 'https://seller.ozon.ru/';

  function text(value) { return String(value == null ? '' : value).trim(); }

  function hasChinese(value) { return /[\u3400-\u9fff]/.test(text(value)); }

  function isChineseReadable(value) {
    value = text(value);
    if (!hasChinese(value) || /[А-Яа-яЁё]/.test(value)) return false;
    var words = value.match(/[A-Za-z]{3,}/g) || [];
    return words.filter(function (word) { return !/^(ozon|sku|fbo|fbs|fbp|rfbs)$/i.test(word); }).length < 2;
  }

  function codeInfo(code) {
    code = text(code).toLowerCase();
    if (ERROR_TEXT[code]) return { text: ERROR_TEXT[code], mapped: true };
    if (/video|cover/.test(code)) return { text: '商品视频或封面不符合平台要求，请重新上传符合要求的素材', mapped: true };
    if (/image|photo|picture/.test(code)) return { text: '商品图片不符合平台要求，请检查图片格式、尺寸和内容', mapped: true };
    if (/description|content/.test(code)) return { text: '商品描述不符合平台要求，请检查文字内容和格式', mapped: true };
    if (/attribute|characteristic/.test(code)) return { text: '商品类目属性缺失或填写错误，请检查必填属性', mapped: true };
    if (/category|type/.test(code)) return { text: '商品类目信息无效，请重新选择正确类目', mapped: true };
    if (/barcode|sku|offer/.test(code)) return { text: '商品编码信息无效，请检查条码、货号或 SKU', mapped: true };
    if (/price|currency/.test(code)) return { text: '商品价格信息异常，请检查币种、销售价和划线价', mapped: true };
    if (/stock|warehouse/.test(code)) return { text: '商品库存或仓库信息异常，请检查仓库和可售库存', mapped: true };
    if (/weight|dimension|width|height|depth|size/.test(code)) return { text: '商品重量或尺寸信息异常，请检查重量、长、宽和高', mapped: true };
    if (/name|title/.test(code)) return { text: '商品名称不符合平台要求，请修改名称后重新提交', mapped: true };
    return { text: '系统暂未收录此错误代码，请先到 OZON 卖家后台查看商品审核详情，也可以提交 BUG 反馈，请系统管理员补充适配', mapped: false };
  }

  function codeText(code) { return codeInfo(code).text; }

  function errorReason(error) {
    var code = text(error && error.code);
    var known = codeText(code);
    if (ERROR_TEXT[code.toLowerCase()]) return known + (code ? '（错误代码：' + code + '）' : '');
    var texts = error && error.texts || {};
    var detail = text(texts.short_description || texts.description || texts.message);
    var prefix = /warning/i.test(text(error && error.level)) ? '平台警告' : '平台错误';
    var translated = isChineseReadable(detail) ? detail : known;
    return prefix + '：' + translated + (code ? '（错误代码：' + code + '）' : '');
  }

  function stockState(product) {
    var stocks = product && product.stocks || {};
    var rows = Array.isArray(stocks.stocks) ? stocks.stocks : [];
    var total = rows.reduce(function (sum, row) { return sum + Number(row && row.present || 0); }, 0);
    return {
      known: typeof stocks.has_stock === 'boolean' || rows.length > 0,
      hasStock: stocks.has_stock === true || total > 0,
      total: total
    };
  }

  function derive(product) {
    product = product || {};
    var statuses = product.statuses || {};
    var status = text(statuses.status).toLowerCase();
    var statusName = text(statuses.status_name);
    var statusDescription = text(statuses.status_description);
    var tooltip = text(statuses.status_tooltip);
    var failed = text(statuses.status_failed).toLowerCase();
    var visibility = text(product.visibility).toLowerCase();
    var errors = Array.isArray(product.errors) ? product.errors : [];
    var blocking = errors.filter(function (error) {
      return /error_level_error/i.test(text(error && error.level)) || /declined|failed|rejected/i.test(text(error && error.state));
    });
    var warnings = errors.filter(function (error) { return blocking.indexOf(error) < 0; });
    var stock = stockState(product);
    var combined = [status, statusName, statusDescription, tooltip, visibility].join(' ').toLowerCase();

    if (product.is_archived || product.archived || /archiv|архив|归档/.test(combined)) {
      return result('archived', [], status);
    }
    if (/не продается|убран из продажи|not selling|removed from sale|banned|disabled|下架|禁售/.test(combined)) {
      var offlineReasons = errors.map(errorReason);
      [statusDescription, tooltip].forEach(function (value) {
        if (!isChineseReadable(value)) return;
        if (/^(?:商品)?(?:已)?下架$|^(?:已)?禁售$/.test(value.replace(/[，。；;！!\s]/g, ''))) return;
        var reason = '平台说明：' + value;
        if (offlineReasons.indexOf(reason) < 0) offlineReasons.push(reason);
      });
      return result('offline', offlineReasons, status, errors);
    }
    if (blocking.length || /declined|failed|rejected/.test(failed + ' ' + status)) {
      var blockingReasons = blocking.map(errorReason);
      if (!blockingReasons.length && isChineseReadable(tooltip)) blockingReasons.push('平台说明：' + tooltip);
      return result('error', blockingReasons, status, errors);
    }
    if (warnings.length) {
      return result('pending', warnings.map(errorReason), status, warnings);
    }
    if (stock.known && !stock.hasStock) {
      return result('ready', [], status);
    }
    if (/продается|selling|active|moderated|price_sent/.test(combined)) {
      return result('active', [], status);
    }
    return result('pending', [], status);
  }

  function result(key, reasons, platformStatus, errors) {
    var labels = { active: '销售中', ready: '准备出售', error: '错误', pending: '待修改', offline: '已下架', archived: '已归档' };
    var defaults = DEFAULT_INFO[key] || DEFAULT_INFO.pending;
    var statusText = (key === 'pending' || key === 'error') ? (STATUS_TEXT[text(platformStatus).toLowerCase()] || '') : '';
    var cleanReasons = (Array.isArray(reasons) ? reasons : []).filter(Boolean);
    var codes = (Array.isArray(errors) ? errors : []).map(function (error) { return text(error && error.code); }).filter(Boolean);
    var sellerHelp = codes.some(function (code) { return !codeInfo(code).mapped; }) || (key === 'error' && !cleanReasons.length && !statusText);
    var action = sellerHelp ? '请先打开 OZON 卖家后台，在“商品”中找到对应商品并查看审核要求。也可以提交 BUG 反馈，附上错误代码和后台截图；系统管理员适配后，此处将正常显示对应的中文说明。' : defaults.action;
    return { label: labels[key] || labels.pending, key: key, reason: cleanReasons.join('；') || statusText || defaults.reason,
      action: action, codes: codes, sellerHelp: sellerHelp, sellerPortal: sellerHelp ? SELLER_PORTAL : '', sellerPortalBackup: sellerHelp ? SELLER_PORTAL_BACKUP : '' };
  }

  function display(product) {
    product = product || {};
    var key = text(product.key || product.statusKey).toLowerCase();
    if (!DEFAULT_INFO[key]) {
      var label = text(product.label || product.status);
      key = ({ '销售中': 'active', '准备出售': 'ready', '错误': 'error', '待修改': 'pending', '已下架': 'offline', '已归档': 'archived' })[label] || 'pending';
    }
    var codes = Array.isArray(product.codes) ? product.codes.filter(Boolean).map(text) : [];
    var reason = text(product.reason || product.statusReason);
    var safeReason = isChineseReadable(reason) ? reason : '';
    if (codes.length && (key === 'error' || key === 'pending')) safeReason = codes.map(function (code) {
      return codeText(code) + '（错误代码：' + code + '）';
    }).join('；');
    var info = result(key, safeReason ? [safeReason] : [], '', codes.map(function (code) { return { code: code }; }));
    return info;
  }

  function shouldInclude(product) {
    product = product || {};
    return !(product.is_archived === true && product.is_autoarchived === true);
  }

  return { derive: derive, display: display, errorReason: errorReason, codeText: codeText, stockState: stockState, shouldInclude: shouldInclude, sellerPortal: SELLER_PORTAL, sellerPortalBackup: SELLER_PORTAL_BACKUP };
});
