(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WYERP_PRODUCT_CREATE_VALIDATOR = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function text(value) { return String(value == null ? '' : value).trim(); }
  function result(message, target) { return { message: message, target: target || '' }; }
  function money(value) {
    var source = text(value), match = source.match(/^(?:0|[1-9]\d*)(?:\.(\d{1,2}))?$/);
    if (!match) return null;
    var parts = source.split('.');
    return BigInt(parts[0]) * 100n + BigInt((parts[1] || '').padEnd(2, '0'));
  }
  function attributeText(attribute) {
    if (attribute && attribute.value != null) return text(attribute.value);
    return (attribute && Array.isArray(attribute.values) ? attribute.values : []).map(function (item) {
      return text(item && (item.value != null ? item.value : item.dictionary_value_id));
    }).filter(Boolean).join('; ');
  }
  function attributeName(attribute) { return text(attribute && (attribute.name || attribute.attribute_name)) || ('属性 ' + text(attribute && (attribute.id || attribute.attribute_id))); }
  function isBrand(attribute) { return ['85', '31'].indexOf(text(attribute && (attribute.id || attribute.attribute_id))) >= 0; }
  function isType(attribute) { return text(attribute && (attribute.id || attribute.attribute_id)) === '8229'; }
  function isHashtags(attribute) { return text(attribute && (attribute.id || attribute.attribute_id)) === '23171'; }
  function images(variant) {
    var values = Array.isArray(variant && variant.images) ? variant.images : [];
    if (variant && variant.image) values = [variant.image].concat(values);
    return values.some(function (value) { return Boolean(text(value)); });
  }
  function boundValue(draft, binding) {
    if (!binding) return '';
    if (binding.area === 'field') {
      if (binding.key === 'weight') return draft.weightG;
      if (['length', 'width', 'height'].indexOf(binding.key) >= 0) return draft.dimensions && draft.dimensions[binding.key];
      return draft[binding.key];
    }
    if (binding.area === 'dimensions') return draft.dimensions && draft.dimensions.length > 0 && draft.dimensions.width > 0 && draft.dimensions.height > 0 ? 'complete' : '';
    return '';
  }
  function validate(draft, settings) {
    draft = draft || {}; settings = settings || {};
    var variants = Array.isArray(draft.variants) ? draft.variants : [];
    var attributes = settings.attributes || draft.attributes || [], bindings = settings.bindings || [], manual = new Set(draft.manualVariantAttributes || []), categoryPromoted = manual.has('field:category');
    function keyOf(attribute) { return text(attribute && (attribute.id || attribute.attribute_id)) + ':' + Number(attribute && (attribute.complexId || attribute.complex_id || attribute.attribute_complex_id) || 0); }
    var attributeByKey = new Map(attributes.map(function (attribute) { return [keyOf(attribute), attribute]; }));
    var brandAttribute = attributes.find(isBrand), brandKey = brandAttribute ? keyOf(brandAttribute) : '';
    function requiredValue(variant, attribute, binding, attributeKey) {
      var stored = (variant.attributes || []).find(function (item) { return keyOf(item) === attributeKey; });
      if (attributeText(stored)) return attributeText(stored);
      if (manual.has(attributeKey)) return '';
      if (isBrand(attribute)) return text(draft.brand);
      if (isHashtags(attribute)) return attributeText(attribute);
      if (binding && (binding.area === 'variant' || binding.area === 'media')) return text(variant[binding.key]);
      if (binding && binding.area === 'field') {
        if (binding.key === 'title') return manual.has('field:title') ? text(variant.title) : text(draft.title);
        if (binding.key === 'weight') return manual.has('field:weight') ? text(variant.weightG) : text(draft.weightG);
        if (binding.key === 'length') return manual.has('field:dimensions') ? text(variant.packageLength) : text(draft.dimensions && draft.dimensions.length);
        if (binding.key === 'width') return manual.has('field:dimensions') ? text(variant.packageWidth) : text(draft.dimensions && draft.dimensions.width);
        if (binding.key === 'height') return manual.has('field:dimensions') ? text(variant.packageHeight) : text(draft.dimensions && draft.dimensions.height);
        return text(draft[binding.key]);
      }
      if (binding && binding.area === 'dimensions') return manual.has('field:dimensions') ? (Number(variant.packageLength)>0&&Number(variant.packageWidth)>0&&Number(variant.packageHeight)>0?'complete':'') : boundValue(draft,binding);
      return attributeText(attribute);
    }
    if (!text(draft.shop)) return result('请选择上架店铺', 'shop');
    if (!categoryPromoted && (!text(draft.descriptionCategoryId) || !text(draft.typeId))) return result('请从列表选择一个有效的三级类目', 'category');
    if (!manual.has('field:title') && !text(draft.title)) return result('必填项“标题”不能为空', 'title');
    if (!(brandKey && manual.has(brandKey)) && !text(draft.brand)) return result('必填项“品牌”不能为空；无品牌商品请选择“无品牌”', 'brand');
    if (!manual.has('field:weight') && !(Number(draft.weightG) > 0)) return result('必填项“包装重量”必须填写大于 0 的数字', 'weight');
    if (!manual.has('field:dimensions') && !(draft.dimensions && Number(draft.dimensions.length) > 0)) return result('必填项“包装长度”必须填写大于 0 的数字', 'length');
    if (!manual.has('field:dimensions') && !(draft.dimensions && Number(draft.dimensions.width) > 0)) return result('必填项“包装宽度”必须填写大于 0 的数字', 'width');
    if (!manual.has('field:dimensions') && !(draft.dimensions && Number(draft.dimensions.height) > 0)) return result('必填项“包装高度”必须填写大于 0 的数字', 'height');
    if (!variants.length) return result('至少需要一个商品变体', 'variants');
    var offerIds = new Set();
    for (var index = 0; index < variants.length; index += 1) {
      var variant = variants[index], row = index + 1;
      if (categoryPromoted) {
        if (!text(variant.descriptionCategoryId) || !text(variant.typeId)) return result('第 ' + row + ' 行必须选择有效的产品类目', 'variant:' + index + ':category');
        if (!Array.isArray(variant.categoryAttributeKeys) || !variant.categoryAttributeKeys.length) return result('第 ' + row + ' 行类目属性定义尚未加载完成', 'variant:' + index + ':category');
        var rowBindings = bindings;
        for (var requiredIndex = 0; requiredIndex < (variant.categoryRequiredKeys || []).length; requiredIndex += 1) {
          var requiredKey = text(variant.categoryRequiredKeys[requiredIndex]), requiredAttribute = attributeByKey.get(requiredKey);
          if (!requiredAttribute) return result('第 ' + row + ' 行类目必填属性定义不完整，请重新选择类目', 'variant:' + index + ':category');
          var definitionIndex = attributes.indexOf(requiredAttribute), requiredBinding = rowBindings[definitionIndex];
          if (!requiredValue(variant, requiredAttribute, requiredBinding, requiredKey)) return result('第 ' + row + ' 行必填项“' + attributeName(requiredAttribute) + '”不能为空', 'variant:' + index + ':category');
        }
      }
      if (manual.has('field:title') && !text(variant.title)) return result('第 ' + row + ' 行必填项“标题”不能为空', 'variant:' + index + ':title');
      if (manual.has('field:weight') && !(Number(variant.weightG) > 0)) return result('第 ' + row + ' 行必填项“包装重量”必须填写大于0的整数克数', 'variant:' + index + ':weightG');
      if (manual.has('field:dimensions') && !(Number(variant.packageLength) > 0 && Number(variant.packageWidth) > 0 && Number(variant.packageHeight) > 0)) return result('第 ' + row + ' 行包装尺寸长宽高都必须填写大于0的毫米数值', 'variant:' + index + ':dimensions');
      if (!images(variant)) return result('第 ' + row + ' 行必填项“图片”不能为空', 'variant:' + index + ':image');
      if (!text(variant.offerId)) return result('第 ' + row + ' 行必填项“货号”不能为空', 'variant:' + index + ':offerId');
      var offerId = text(variant.offerId); if (offerIds.has(offerId)) return result('第 ' + row + ' 行货号“' + offerId + '”与前面SKU重复，请为每个SKU使用唯一货号', 'variant:' + index + ':offerId'); offerIds.add(offerId);
      var lowest = money(variant.lowest);
      if (lowest == null || lowest <= 0n) return result('第 ' + row + ' 行“最低价”必须填写大于 0 的金额，最多两位小数', 'variant:' + index + ':lowest');
      var sale = money(variant.sale);
      if (sale == null || sale <= 0n) return result('第 ' + row + ' 行“销售价”必须填写大于 0 的金额，最多两位小数', 'variant:' + index + ':sale');
      var old = money(variant.old);
      if (old == null || old <= 0n) return result('第 ' + row + ' 行“划线价”必须填写大于 0 的金额，最多两位小数', 'variant:' + index + ':old');
      if (lowest >= sale) return result('第 ' + row + ' 行“最低价”必须低于销售价', 'variant:' + index + ':lowest');
      if (lowest * 2n < sale) return result('第 ' + row + ' 行“最低价”不能低于销售价的 50%', 'variant:' + index + ':lowest');
      if (old <= sale) return result('第 ' + row + ' 行“划线价”必须高于销售价', 'variant:' + index + ':old');
    }
    for (var attributeIndex = 0; attributeIndex < attributes.length; attributeIndex += 1) {
      var attribute = attributes[attributeIndex];
      if (!attribute || !Boolean(attribute.required || attribute.is_required) || categoryPromoted) continue;
      // Ozon attribute 8229 is represented by the selected category's typeId and has no visible input.
      if (isType(attribute)) continue;
      var name = attributeName(attribute), binding = bindings[attributeIndex];
      var attributeKey = text(attribute.id || attribute.attribute_id) + ':' + Number(attribute.complexId || attribute.complex_id || attribute.attribute_complex_id || 0);
      if ((draft.manualVariantAttributes || []).indexOf(attributeKey) >= 0) {
        for (var promotedIndex = 0; promotedIndex < variants.length; promotedIndex += 1) {
          var stored = (variants[promotedIndex].attributes || []).find(function (item) { return text(item.id || item.attribute_id) + ':' + Number(item.complexId || item.complex_id || item.attribute_complex_id || 0) === attributeKey; });
          if (!attributeText(stored)) return result('第 ' + (promotedIndex + 1) + ' 行必填项“' + name + '”不能为空', 'attribute:' + attributeIndex);
        }
        continue;
      }
      if ((draft.suppressedVariantAttributes || []).indexOf(attributeKey) >= 0) {
        if (!attributeText(attribute)) return result('必填项“' + name + '”不能为空', 'attribute:' + attributeIndex);
        continue;
      }
      if (isBrand(attribute)) {
        if (!text(draft.brand)) return result('必填项“' + name + '”不能为空', 'brand');
        continue;
      }
      if (isHashtags(attribute)) {
        if (!attributeText(attribute)) return result('必填项“' + name + '”不能为空', 'hashtags');
        continue;
      }
      if (binding && (binding.area === 'variant' || binding.area === 'media')) {
        for (var variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
          if (!text(variants[variantIndex][binding.key])) return result('第 ' + (variantIndex + 1) + ' 行必填项“' + name + '”不能为空', 'variant:' + variantIndex + ':' + binding.key);
        }
        continue;
      }
      if (binding) {
        if (!text(boundValue(draft, binding))) return result('必填项“' + name + '”不能为空', binding.area === 'field' ? binding.key : 'length');
        continue;
      }
      if (!attributeText(attribute)) return result('必填项“' + name + '”不能为空', 'attribute:' + attributeIndex);
    }
    return null;
  }

  return { validate: validate, money: money, attributeText: attributeText };
});
