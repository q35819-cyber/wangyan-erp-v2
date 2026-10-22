/* 在线商品显示与仓库方案规则（浏览器 / Node 共用） */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WYERP_ONLINE_FORMAT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function numeric(value) {
    if (value == null || value === '') return null;
    var cleaned = String(value).replace(/[,，\s]/g, '').replace(/[￥¥₽$€]/g, '');
    var number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
  }

  function amount(value) {
    var number = numeric(value);
    return number == null ? '' : number.toFixed(2);
  }

  function money(value, defaultCurrency) {
    if (value == null || value === '') return '--';
    var text = String(value).trim();
    var currency = (text.match(/^[￥¥₽$€]/) || [defaultCurrency || '￥'])[0];
    var formatted = amount(text);
    return formatted ? currency + formatted : text;
  }

  function percentage(value) {
    var number = numeric(value);
    if (number == null || number < 0 || number > 100) return '';
    return number.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  }

  function pad(value) { return String(value).padStart(2, '0'); }
  function dateTime(value) {
    if (value == null || value === '') return '--';
    var text = String(value).trim();
    var local = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
    if (local) return local[1] + '年' + local[2] + '月' + local[3] + '日 ' + local[4] + ':' + local[5] + ':' + local[6];
    var parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return text;
    return parsed.getFullYear() + '年' + pad(parsed.getMonth() + 1) + '月' + pad(parsed.getDate()) + '日 ' +
      pad(parsed.getHours()) + ':' + pad(parsed.getMinutes()) + ':' + pad(parsed.getSeconds());
  }

  function weight(value, unit) {
    var number = numeric(value);
    if (number == null || number < 0) return '';
    var normalizedUnit = String(unit || 'g').trim().toLowerCase();
    var kilograms = normalizedUnit === 'kg' || normalizedUnit === 'kilogram' || normalizedUnit === 'kilograms'
      ? number
      : (normalizedUnit === 'mg' ? number / 1000000 : number / 1000);
    var rounded = Math.round(kilograms * 1000) / 1000;
    return String(rounded).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') + 'kg';
  }

  function roundedMeasurement(value) {
    return String(Math.round(value * 1000) / 1000).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
  }

  function measurementValue(value, unit, type) {
    var number = numeric(value);
    var normalizedUnit = String(unit || '').trim().toLowerCase();
    if (number == null && typeof value === 'string') {
      var match = value.trim().match(/^([+-]?\d+(?:\.\d+)?)\s*([a-z]+)$/i);
      if (match) {
        number = Number(match[1]);
        normalizedUnit = normalizedUnit || match[2].toLowerCase();
      }
    }
    if (number == null || number <= 0) return null;
    if (type === 'weight') {
      if (normalizedUnit === 'kg' || normalizedUnit === 'kilogram' || normalizedUnit === 'kilograms') return number * 1000;
      if (normalizedUnit === 'lb' || normalizedUnit === 'lbs' || normalizedUnit === 'pound' || normalizedUnit === 'pounds') return number * 453.59237;
      if (normalizedUnit === 'mg') return number / 1000;
      return number;
    }
    if (normalizedUnit === 'cm' || normalizedUnit === 'centimeter' || normalizedUnit === 'centimeters') return number * 10;
    if (normalizedUnit === 'm' || normalizedUnit === 'meter' || normalizedUnit === 'meters') return number * 1000;
    if (normalizedUnit === 'in' || normalizedUnit === 'inch' || normalizedUnit === 'inches') return number * 25.4;
    return number;
  }

  function packageMetrics(product) {
    product = product || {};
    var weightValue = product.weightValue;
    var weightUnit = product.weightUnit;
    if ((weightValue == null || weightValue === '') && product.weight) {
      weightValue = product.weight;
      weightUnit = weightUnit || '';
    }
    var weightG = measurementValue(weightValue, weightUnit, 'weight');
    var dimensionUnit = product.dimensionUnit || '';
    var dimensions = [
      measurementValue(product.depth != null ? product.depth : product.length, dimensionUnit, 'dimension'),
      measurementValue(product.width, dimensionUnit, 'dimension'),
      measurementValue(product.height, dimensionUnit, 'dimension')
    ];
    return { weightG: weightG, lengthMm: dimensions[0], widthMm: dimensions[1], heightMm: dimensions[2] };
  }

  function packageSummary(product) {
    var metrics = packageMetrics(product);
    var dimensions = [metrics.lengthMm, metrics.widthMm, metrics.heightMm];
    var hasDimension = dimensions.some(function (value) { return value != null; });
    return {
      weight: metrics.weightG == null ? '--' : roundedMeasurement(metrics.weightG) + ' g',
      size: hasDimension ? dimensions.map(function (value) { return value == null ? '--' : roundedMeasurement(value); }).join(' × ') + ' mm' : '--'
    };
  }

  function normalizeSchema(value) {
    var text = String(value == null ? '' : value).replace(/\s+/g, '').toLowerCase();
    if (!text) return '';
    if (/real.?fbs|rfbs/.test(text)) return 'rFBS';
    if (/fbo/.test(text)) return 'FBO';
    if (/fbs/.test(text)) return 'FBS';
    return '';
  }

  function schemaPriority(schema) {
    return schema === 'rFBS' ? 0 : schema === 'FBS' ? 1 : schema === 'FBO' ? 2 : 9;
  }

  function stockSchema(item) {
    return normalizeSchema(item && (item.source || item.type || item.shipment_type || item.sale_schema || item.warehouse_name || item.warehouse));
  }

  function available(item) {
    var present = numeric(item && item.present);
    return present != null && present > 0;
  }

  function deliveryMetric(item) {
    item = item || {};
    var fields = [item.delivery_days, item.min_delivery_days, item.delivery_time, item.delivery_hours];
    for (var i = 0; i < fields.length; i += 1) {
      var match = String(fields[i] == null ? '' : fields[i]).match(/\d+(?:\.\d+)?/);
      if (match) return Number(match[0]);
    }
    return null;
  }

  function fulfillment(product, options) {
    product = product || {};
    options = options || {};
    var preferred = normalizeSchema(options.preferredSchema);
    var stocks = product.stocks && Array.isArray(product.stocks.stocks) ? product.stocks.stocks : [];
    var candidates = stocks.map(function (item, index) {
      return { item: item || {}, schema: stockSchema(item), index: index, delivery: deliveryMetric(item) };
    }).filter(function (entry) { return entry.schema; });
    var preferredCandidates = preferred ? candidates.filter(function (entry) { return entry.schema === preferred; }) : [];
    if (preferredCandidates.length) candidates = preferredCandidates;
    var inStock = candidates.filter(function (entry) { return available(entry.item); });
    var ranked = (inStock.length ? inStock : candidates).sort(function (left, right) {
      if (left.delivery != null || right.delivery != null) {
        if (left.delivery == null) return 1;
        if (right.delivery == null) return -1;
        if (left.delivery !== right.delivery) return left.delivery - right.delivery;
      }
      return schemaPriority(left.schema) - schemaPriority(right.schema) || left.index - right.index;
    });
    var fallback = normalizeSchema(product.fulfillmentSchema || product.rfbs);
    var schema = preferred || (ranked.length ? ranked[0].schema : fallback);
    var warehouses = ranked.filter(function (entry) { return entry.schema === schema; }).map(function (entry) {
      return String(entry.item.warehouse_name || entry.item.warehouse || entry.item.name || '').trim();
    }).filter(Boolean).filter(function (name, index, values) { return values.indexOf(name) === index; });
    if (!warehouses.length && Array.isArray(options.warehouseNames)) warehouses = options.warehouseNames.filter(Boolean);
    var commissions = Array.isArray(product.commissions) ? product.commissions : [];
    var commission = commissions.find(function (item) { return normalizeSchema(item && item.sale_schema) === schema; }) || commissions[0] || {};
    return { schema: schema, warehouses: warehouses, commission: commission };
  }

  function commissionPercent(product, schema) {
    var normalizedSchema = normalizeSchema(schema);
    if (!normalizedSchema) return '';
    var commissions = product && Array.isArray(product.commissions) ? product.commissions : [];
    var commission = commissions.find(function (item) {
      return normalizeSchema(item && item.sale_schema) === normalizedSchema;
    });
    return commission ? percentage(commission.percent) : '';
  }

  function warehouseMode(warehouses, fallback) {
    var bad = ['archived', 'frozen', 'deleted', 'paused', 'inactive', 'disabled'];
    var usable = (Array.isArray(warehouses) ? warehouses : []).filter(function (warehouse) {
      if (!warehouse || warehouse.pause_at) return false;
      return bad.indexOf(String(warehouse.status || 'active').toLowerCase()) < 0;
    });
    var rfbs = usable.filter(function (warehouse) { return warehouse.is_rfbs === true; });
    var selected = rfbs.length ? rfbs : usable;
    var options = selected.map(function (warehouse) {
      return {
        id: String(warehouse.warehouse_id != null ? warehouse.warehouse_id : (warehouse.id != null ? warehouse.id : '')),
        name: String(warehouse.name || warehouse.warehouse_name || '').trim(),
        isRfbs: warehouse.is_rfbs === true,
        status: String(warehouse.status || 'active')
      };
    }).filter(function (warehouse) { return warehouse.id || warehouse.name; });
    return {
      schema: rfbs.length ? 'rFBS' : (usable.length ? 'FBS' : normalizeSchema(fallback)),
      names: options.map(function (warehouse) { return warehouse.name; }).filter(Boolean),
      options: options
    };
  }

  function categoryPath(product, translator) {
    product = product || {};
    translator = typeof translator === 'function' ? translator : function (value) { return value; };
    var values = [product.cat1, product.cat2, product.cat3].map(function (value) {
      return String(translator(value) || '').trim();
    }).filter(function (value) { return /[\u3400-\u9fff]/.test(value); });
    values = values.filter(function (value, index) { return values.indexOf(value) === index; });
    return values.join(' > ') || '未提供中文类目';
  }

  return {
    amount: amount,
    money: money,
    percentage: percentage,
    dateTime: dateTime,
    weight: weight,
    packageMetrics: packageMetrics,
    packageSummary: packageSummary,
    normalizeSchema: normalizeSchema,
    fulfillment: fulfillment,
    commissionPercent: commissionPercent,
    warehouseMode: warehouseMode,
    categoryPath: categoryPath
  };
});
