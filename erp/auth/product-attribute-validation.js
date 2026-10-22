'use strict';
function invalid(message) { return Object.assign(new Error(message), { publicCode: 'product_attribute_validation_failed', status: 409 }); }
function present(attribute) { return attribute && Array.isArray(attribute.values) && attribute.values.some(value => Number(value.dictionary_value_id) > 0 || String(value.value || '').trim()); }
function validateItem(item, definitions, index) {
  const label = '第' + (index + 1) + '个商品：';
  const simple = Array.isArray(item.attributes) ? item.attributes : [];
  const groups = Array.isArray(item.complex_attributes) ? item.complex_attributes : [];
  const lookup = new Map(definitions.map(row => [String(row.id), row]));
  const contexts = [{ complex: 0, attributes: simple }];
  for (const group of groups) {
    if (!group || !Array.isArray(group.attributes) || !group.attributes.length) throw invalid(label + '复合属性结构不完整，未提交商品。');
    const complexIds = new Set(group.attributes.map(row => Number(lookup.get(String(row.id))?.attribute_complex_id || 0)));
    if (complexIds.size !== 1 || complexIds.has(0)) throw invalid(label + '复合属性层级与平台规则不匹配，未提交商品。');
    contexts.push({ complex: [...complexIds][0], attributes: group.attributes });
  }
  for (const context of contexts) {
    const seen = new Set();
    for (const attribute of context.attributes) {
      const definition = lookup.get(String(attribute.id));
      if (!definition || Number(definition.attribute_complex_id || 0) !== context.complex || seen.has(String(attribute.id))) throw invalid(label + '属性编号重复或不属于当前平台层级，未提交商品。');
      seen.add(String(attribute.id));
      if (!Array.isArray(attribute.values)) throw invalid(label + '属性值格式不正确，未提交商品。');
      const name = String(definition.name || definition.id).slice(0, 100);
      if (!definition.is_collection && attribute.values.length > 1) throw invalid(label + '属性【' + name + '】仅允许一个值，未提交商品。');
      if (Number(definition.max_value_count) > 0 && attribute.values.length > Number(definition.max_value_count)) throw invalid(label + '属性【' + name + '】最多' + definition.max_value_count + '个值，未提交商品。');
      if (Number(definition.dictionary_id) > 0 && attribute.values.some(value => !Number.isSafeInteger(Number(value.dictionary_value_id)) || Number(value.dictionary_value_id) <= 0)) throw invalid(label + '属性【' + name + '】必须选择平台字典选项，未提交商品。');
    }
    for (const definition of definitions) if (definition.is_required && Number(definition.attribute_complex_id || 0) === context.complex && !present(context.attributes.find(row => String(row.id) === String(definition.id)))) throw invalid(label + '属性【' + String(definition.name || definition.id).slice(0, 100) + '】为必填，未提交商品。');
  }
  for (const definition of definitions) {
    const complex = Number(definition.attribute_complex_id || 0);
    if (!complex) continue;
    const count = contexts.filter(row => row.complex === complex).length;
    if (definition.is_required && !count) throw invalid(label + '缺少平台要求的复合属性，未提交商品。');
    if (!definition.complex_is_collection && count > 1) throw invalid(label + '该复合属性仅允许一组，未提交商品。');
  }
}
async function validateImportAttributes(body, { call }) {
  const definitions = new Map(), dictionaries = new Map();
  let totalPages = 0;
  async function checkDictionary(item, attribute) {
    const request = { description_category_id: item.description_category_id, type_id: item.type_id, attribute_id: attribute.id, language: 'RU' };
    const key = request.description_category_id + ':' + request.type_id + ':' + request.attribute_id;
    if (!dictionaries.has(key)) dictionaries.set(key, { values: new Map(), cursor: 0, pages: 0, ended: false });
    const dictionary = dictionaries.get(key);
    const needed = [...new Set(attribute.values.map(value => Number(value.dictionary_value_id)))];
    for (const id of needed) if (!dictionary.values.has(id) && typeof call.findVerifiedOption === 'function') {
      const raw = call.findVerifiedOption(request, id);
      if (typeof raw === 'string') dictionary.values.set(id, raw);
    }
    while (needed.some(id => !dictionary.values.has(id)) && !dictionary.ended) {
      if (dictionary.pages >= 10 || totalPages >= 50) throw invalid('属性字典核验未完成，未提交商品；请重新读取相关选项后重试。');
      let response;
      try { response = await call('/v1/description-category/attribute/values', { ...request, limit: 1000, last_value_id: dictionary.cursor }); }
      catch (_) { throw invalid('无法读取平台属性字典，未提交商品，请稍后重试。'); }
      dictionary.pages++; totalPages++;
      if (!Array.isArray(response?.result) || typeof response.has_next !== 'boolean' || response.result.some(row => !row || !Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0 || typeof row.value !== 'string')) throw invalid('平台属性字典格式不完整，未提交商品，请重新读取后再试。');
      const cursor = response.result.length ? Number(response.result[response.result.length - 1].id) : dictionary.cursor;
      if (response.result.length && (cursor <= dictionary.cursor || response.result.some(row => Number(row.id) <= dictionary.cursor)) || response.has_next && !response.result.length) throw invalid('属性字典核验未完成，未提交商品；请重新读取相关选项后重试。');
      for (const row of response.result) dictionary.values.set(Number(row.id), row.value);
      dictionary.cursor = cursor; dictionary.ended = !response.has_next;
    }
    for (const value of attribute.values) {
      const raw = dictionary.values.get(Number(value.dictionary_value_id));
      if (raw === undefined) throw invalid('属性选项编号不属于当前平台字典，未提交商品，请重新选择。');
      if (String(value.value || '') && String(value.value) !== raw) throw invalid('属性选项编号与平台原文不一致，未提交商品。');
    }
  }
  for (const [index, item] of body.items.entries()) {
    const key = item.description_category_id + ':' + item.type_id;
    if (!definitions.has(key)) {
      let response;
      try { response = await call('/v1/description-category/attribute', { description_category_id: item.description_category_id, type_id: item.type_id, language: 'RU' }); }
      catch (_) { throw invalid('无法读取当前类目属性规则，未提交商品，请稍后重试。'); }
      if (!Array.isArray(response?.result) || !response.result.length || response.result.some(row => !row || !Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0 || typeof row.is_required !== 'boolean' || typeof row.is_collection !== 'boolean')) throw invalid('平台类目属性规则不完整，未提交商品，请重新读取后再试。');
      definitions.set(key, response.result);
    }
    validateItem(item, definitions.get(key), index);
    const lookup = new Map(definitions.get(key).map(row => [String(row.id), row]));
    const attributes = (item.attributes || []).concat((item.complex_attributes || []).flatMap(group => group.attributes));
    for (const attribute of attributes) if (Number(lookup.get(String(attribute.id)).dictionary_id) > 0) await checkDictionary(item, attribute);
  }
}
module.exports = { validateItem, validateImportAttributes };
