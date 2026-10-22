'use strict';

const SCHEMA_VERSION = 1;

function text(value) { return String(value == null ? '' : value).trim(); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }

function categoryKey(descriptionCategoryId, typeId) {
  return `${text(descriptionCategoryId)}:${text(typeId)}`;
}

function flattenThirdLevelCategories(tree) {
  const rows = [];
  const seen = new Set();
  for (const level1 of Array.isArray(tree) ? tree : []) {
    for (const level2 of Array.isArray(level1 && level1.children) ? level1.children : []) {
      for (const level3 of Array.isArray(level2 && level2.children) ? level2.children : []) {
        const descriptionCategoryId = text(level3.description_category_id || level2.description_category_id || level1.description_category_id);
        const typeId = text(level3.type_id);
        if (!/^\d+$/.test(descriptionCategoryId) || !/^\d+$/.test(typeId)) continue;
        const key = categoryKey(descriptionCategoryId, typeId);
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          key,
          descriptionCategoryId,
          typeId,
          disabled: Boolean(level1.disabled || level2.disabled || level3.disabled),
          path: [
            { id: text(level1.description_category_id), name: text(level1.category_name), level: 1 },
            { id: text(level2.description_category_id), name: text(level2.category_name), level: 2 },
            { id: typeId, name: text(level3.type_name || level3.category_name), level: 3 }
          ]
        });
      }
    }
  }
  return rows;
}

function normalizeAttribute(attribute) {
  return {
    id: text(attribute && attribute.id),
    name: text(attribute && attribute.name),
    description: text(attribute && attribute.description),
    type: text(attribute && attribute.type),
    groupId: text(attribute && attribute.group_id),
    groupName: text(attribute && attribute.group_name),
    dictionaryId: text(attribute && attribute.dictionary_id),
    required: Boolean(attribute && attribute.is_required),
    collection: Boolean(attribute && attribute.is_collection),
    aspect: Boolean(attribute && attribute.is_aspect),
    categoryDependent: Boolean(attribute && attribute.category_dependent),
    complexId: text(attribute && attribute.attribute_complex_id),
    complexCollection: Boolean(attribute && attribute.complex_is_collection),
    maxValueCount: number(attribute && attribute.max_value_count),
    dictionaryValuesCached: false
  };
}

function splitAttributes(attributes) {
  const normalized = (Array.isArray(attributes) ? attributes : []).map(normalizeAttribute).filter(item => /^\d+$/.test(item.id));
  normalized.sort((left, right) => (left.groupName || '').localeCompare(right.groupName || '', 'zh-CN') || left.name.localeCompare(right.name, 'zh-CN') || Number(left.id) - Number(right.id));
  return {
    required: normalized.filter(item => item.required),
    optional: normalized.filter(item => !item.required)
  };
}

function chineseFailureReason(error) {
  const raw = text(error && (error.publicMessage || error.message || error.error) || error);
  const lower = raw.toLowerCase();
  if (!raw) return '平台没有返回失败原因';
  if (/429|too many|rate.?limit|resource_exhausted/.test(lower)) return 'OZON 接口请求过于频繁，已达到平台限流';
  if (/401|unauthorized|api.?key|invalid.*credential/.test(lower)) return '店铺接口密钥无效或已经失效';
  if (/403|forbidden|permission/.test(lower)) return '当前店铺没有读取该类目属性的权限';
  if (/404|not found/.test(lower)) return 'OZON 没有找到该三级类目或商品类型';
  if (/timeout|timed out|abort|etimedout/.test(lower)) return '请求 OZON 类目属性超时';
  if (/network|fetch|socket|econn|dns/.test(lower)) return '服务器连接 OZON 失败';
  if (/category.*(?:invalid|legacy)|description_category/.test(lower)) return '三级类目已经失效、迁移或类目编号不正确';
  if (/type.*(?:invalid|not.*belong)|description_type/.test(lower)) return '商品类型与描述类目不匹配';
  if (/invalid.*response|parse|unexpected token/.test(lower)) return 'OZON 返回的类目属性数据格式异常';
  if (/[\u3400-\u9fff]/.test(raw)) return raw.slice(0, 300);
  return `OZON 返回错误，暂未识别具体原因（${raw.slice(0, 180)}）`;
}

function normalizeLibrary(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  return {
    schemaVersion: SCHEMA_VERSION,
    status: ['running', 'done', 'partial', 'failed'].includes(source.status) ? source.status : 'failed',
    source: text(source.source || 'OZON Seller API'),
    sourceLanguage: text(source.sourceLanguage || 'ZH_HANS'),
    startedAt: source.startedAt || null,
    updatedAt: source.updatedAt || null,
    completedAt: source.completedAt || null,
    totalCategories: Math.max(0, number(source.totalCategories)),
    processedCategories: Math.max(0, number(source.processedCategories)),
    categories: source.categories && typeof source.categories === 'object' && !Array.isArray(source.categories) ? source.categories : {},
    failures: Array.isArray(source.failures) ? source.failures : []
  };
}

function summarizeLibrary(payload) {
  const library = normalizeLibrary(payload);
  const categories = Object.values(library.categories);
  const requiredAttributes = categories.reduce((total, item) => total + (Array.isArray(item.required) ? item.required.length : 0), 0);
  const optionalAttributes = categories.reduce((total, item) => total + (Array.isArray(item.optional) ? item.optional.length : 0), 0);
  return {
    status: library.status,
    totalCategories: library.totalCategories,
    processedCategories: library.processedCategories,
    successfulCategories: categories.length,
    failedCategories: library.failures.length,
    requiredAttributes,
    optionalAttributes,
    totalAttributes: requiredAttributes + optionalAttributes,
    startedAt: library.startedAt,
    updatedAt: library.updatedAt,
    completedAt: library.completedAt
  };
}

function treeNameIndexes(tree) {
  const level1 = new Map();
  const level2 = new Map();
  const level3 = new Map();
  for (const first of Array.isArray(tree) ? tree : []) {
    const firstId = text(first && first.description_category_id);
    if (firstId) level1.set(firstId, text(first.category_name));
    for (const second of Array.isArray(first && first.children) ? first.children : []) {
      const secondId = text(second && second.description_category_id);
      if (secondId) level2.set(`${firstId}:${secondId}`, text(second.category_name));
      for (const third of Array.isArray(second && second.children) ? second.children : []) {
        const typeId = text(third && third.type_id);
        if (typeId) level3.set(categoryKey(secondId, typeId), text(third.type_name || third.category_name));
      }
    }
  }
  return { level1, level2, level3 };
}

function mapLocalizedCategoryTrees(chineseTree, russianTree) {
  const russian = treeNameIndexes(russianTree);
  const mapped = (Array.isArray(chineseTree) ? chineseTree : []).map(first => {
    const firstId = text(first.description_category_id);
    const children = (first.children || []).map(second => {
      const secondId = text(second.description_category_id);
      const grandchildren = (second.children || []).map(third => {
        const typeId = text(third.type_id);
        return {
          id: typeId,
          descriptionCategoryId: text(third.description_category_id || secondId),
          ru: russian.level3.get(categoryKey(secondId, typeId)) || '',
          name: text(third.type_name || third.category_name),
          disabled: Boolean(first.disabled || second.disabled || third.disabled)
        };
      });
      return {
        id: secondId,
        ru: russian.level2.get(`${firstId}:${secondId}`) || '',
        name: text(second.category_name),
        n: grandchildren.length,
        children: grandchildren
      };
    });
    return {
      id: firstId,
      ru: russian.level1.get(firstId) || '',
      name: text(first.category_name),
      n: children.length,
      children
    };
  });
  return {
    updated: new Date().toISOString(), source: 'OZON /v1/description-category/tree (ZH_HANS + DEFAULT)',
    counts: { l1: mapped.length, l2: mapped.reduce((a, item) => a + item.children.length, 0), l3: mapped.reduce((a, item) => a + item.children.reduce((b, child) => b + child.children.length, 0), 0) },
    tree: mapped
  };
}

function mapCategoryTree(tree, translate) {
  if (typeof translate !== 'function') return mapLocalizedCategoryTrees(tree, []);
  const translatedTree = JSON.parse(JSON.stringify(Array.isArray(tree) ? tree : []));
  for (const first of translatedTree) {
    first.category_name = translate(first.category_name);
    for (const second of first.children || []) {
      second.category_name = translate(second.category_name);
      for (const third of second.children || []) third.type_name = translate(third.type_name || third.category_name);
    }
  }
  return mapLocalizedCategoryTrees(translatedTree, tree);
}

module.exports = {
  SCHEMA_VERSION,
  categoryKey,
  flattenThirdLevelCategories,
  normalizeAttribute,
  splitAttributes,
  chineseFailureReason,
  normalizeLibrary,
  summarizeLibrary,
  mapCategoryTree,
  mapLocalizedCategoryTrees
};
