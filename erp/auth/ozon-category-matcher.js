'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const MAX_EXAMPLES = 5000;
const MAX_HISTORY = 10000;
const STOP_WORDS = [
  '跨境', '热销', '新款', '爆款', '厂家', '直销', '批发', '专供', '货源', '同款', '网红',
  '创意', '高颜值', '礼物', '送朋友', '家用', '通用', '多功能', '免安装', '一件代发'
];
const SEMANTIC_GROUPS = [
  ['香薰', '扩香', '香氛', '芳香', '精油'],
  ['汽车', '车载', '车用'],
  ['摆件', '装饰', '工艺品', '饰品'],
  ['收纳', '置物', '整理'],
  ['儿童', '宝宝', '婴儿', '幼儿'],
  ['玩具', '积木', '拼装'],
  ['厨房', '厨具', '烹饪'],
  ['浴室', '卫浴', '淋浴'],
  ['宠物', '猫', '狗'],
  ['服装', '衣服', '上衣', '裤子'],
  ['鞋', '靴', '凉鞋', '拖鞋'],
  ['木质', '木制', '原木', '胡桃木'],
  ['磨豆机', '咖啡研磨机', '研磨机', '磨粉机'],
  ['手办', '角色手办', '人偶', '公仔', '雕像', '摆件', '模型'],
  ['烧烤炉', '烤炉', '烧烤架', '烤肉炉'],
  ['扩香器', '扩香木', '香薰器', '香薰扩香器'],
  ['鞋套', '鞋罩', '防水鞋套'],
  ['头灯', '头戴灯', '夹帽灯', '露营灯', '营地灯', '手电筒'],
  ['斜挎包', '手机包', '肩包', '手提包', '包包'],
  ['粘毛器', '粘毛刷', '去毛刷', '除毛刷', '衣物刷'],
  ['泡茶壶', '茶壶', '提梁壶'],
  ['户外', '露营', '野营', '野餐'],
  ['游戏', '电子游戏', '电影', '角色', '动漫', '二次元']
];
const GENERIC_SOURCE_CATEGORY_WORDS = new Set(['其他', '其它', '其他类', '其它类', '通用', '综合', '默认', '未分类']);
const ATTRIBUTE_NAME_NOISE = /^(?:品牌|颜色|货号|产地|型号|商品名称|合并至一张卡片|搜索关键词|#主题标签|臭氧。视频：标题|臭氧。视频：链接)$/i;
const MATERIAL_LIKE_TERMS = ['咖啡豆', '黏土', '粘土', '木炭', '陶瓷', 'pvc', 'pp', '橡胶', '塑料', '涤纶', '聚酯纤维', '金属', '木材'];
const PRODUCT_FORM_GROUPS = SEMANTIC_GROUPS.slice(12, 21);
const ACCESSORY_MARKERS = ['配件', '替换', '纸芯', '滤芯', '耗材', '补充装', '替换装'];
const NORMALIZED_SEMANTIC_GROUPS = SEMANTIC_GROUPS.map(group => group.map(term => normalizeText(term)));
const CANDIDATE_LIMIT = 96;
const INDEX_MAX_POSTING_2 = 420;
const INDEX_MAX_POSTING_3 = 260;
const compiledCatalogCache = new WeakMap();

function text(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function normalizeText(value) {
  let result = text(value, 2000).normalize('NFKC').toLowerCase();
  for (const word of STOP_WORDS) result = result.split(word).join('');
  return result.replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizedPath(value) {
  return (Array.isArray(value) ? value : []).map(item => text(item && typeof item === 'object' ? item.name || item.title || item.label : item, 120)).filter(Boolean).slice(0, 6);
}

function sourceSignature(item) {
  const platform = normalizeText(item && item.sourcePlatform) || 'unknown';
  const id = text(item && item.sourceCategoryId, 80);
  if (id) return `${platform}|id:${id}`;
  const path = normalizedPath(item && item.sourceCategoryPath).map(normalizeText).filter(Boolean);
  return path.length ? `${platform}|path:${path.join('/')}` : `${platform}|source:unknown`;
}

function titleFingerprint(item) {
  return crypto.createHash('sha256').update(`${sourceSignature(item)}|${normalizeText(item && item.title)}`).digest('hex').slice(0, 32);
}

function grams(value, size = 2) {
  const input = normalizeText(value);
  const result = new Set();
  if (!input) return result;
  if (input.length <= size) { result.add(input); return result; }
  for (let index = 0; index <= input.length - size; index += 1) result.add(input.slice(index, index + size));
  return result;
}

function dice(left, right) {
  const a = grams(left), b = grams(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common += 1;
  return (2 * common) / (a.size + b.size);
}

function coverage(query, candidate) {
  const source = grams(query), target = grams(candidate);
  if (!source.size || !target.size) return 0;
  let common = 0;
  for (const item of target) if (source.has(item)) common += 1;
  return common / target.size;
}

function normalizedGrams(value, size = 2) {
  const input = String(value || '');
  const result = new Set();
  if (!input) return result;
  if (input.length <= size) { result.add(input); return result; }
  for (let index = 0; index <= input.length - size; index += 1) result.add(input.slice(index, index + size));
  return result;
}

function intersectionSize(left, right) {
  if (!left || !right || !left.size || !right.size) return 0;
  const small = left.size <= right.size ? left : right, large = small === left ? right : left;
  let common = 0;
  for (const value of small) if (large.has(value)) common += 1;
  return common;
}

function coverageSets(source, target) {
  if (!source || !target || !source.size || !target.size) return 0;
  return intersectionSize(source, target) / target.size;
}

function diceSets(left, right) {
  if (!left || !right || !left.size || !right.size) return 0;
  return (2 * intersectionSize(left, right)) / (left.size + right.size);
}

function overlapSets(left, right) {
  if (!left || !right || !left.size || !right.size) return 0;
  return intersectionSize(left, right) / Math.min(left.size, right.size);
}

function orderedCoverage(query, target) {
  const source = String(query || ''), expected = String(target || '');
  if (!source || !expected) return 0;
  let cursor = 0;
  for (let index = 0; index < source.length && cursor < expected.length; index += 1) if (source[index] === expected[cursor]) cursor += 1;
  return cursor / expected.length;
}

function limitedValues(set, limit) {
  const values = [];
  if (!set || !set.size) return values;
  for (const value of set) { values.push(value); if (values.length >= limit) break; }
  return values;
}

function categoryKey(value) {
  if (typeof value === 'string' && /^\d+:\d+$/.test(value)) return value;
  const descriptionCategoryId = text(value && value.descriptionCategoryId, 40);
  const typeId = text(value && value.typeId, 40);
  return /^\d+$/.test(descriptionCategoryId) && /^\d+$/.test(typeId) ? `${descriptionCategoryId}:${typeId}` : '';
}

function categoryPayload(category) {
  if (!category) return null;
  const path = normalizedPath(category.path);
  return {
    key: category.key,
    descriptionCategoryId: category.descriptionCategoryId,
    typeId: category.typeId,
    path,
    pathText: text(category.pathText || path.join(' > '), 500)
  };
}

function normalizeCatalogItem(fallbackKey, value) {
  const key = categoryKey(value) || (/^\d+:\d+$/.test(fallbackKey) ? fallbackKey : '');
  const path = normalizedPath(value && value.path);
  if (!key || !path.length || value && value.disabled) return null;
  const [descriptionCategoryId, typeId] = key.split(':');
  const attributeRows = (Array.isArray(value && value.required) ? value.required : []).concat(Array.isArray(value && value.optional) ? value.optional : []);
  const attributeNames = [...new Set(attributeRows
    .filter(attribute => attribute && (attribute.required || attribute.categoryDependent))
    .map(attribute => text(attribute.name, 120))
    .filter(name => name && !ATTRIBUTE_NAME_NOISE.test(name)))]
    .slice(0, 48);
  return { key, descriptionCategoryId, typeId, path, pathText: text(value.pathText || path.join(' > '), 500), attributeNames };
}

function normalizeCatalog(library) {
  const source = library && library.categories && typeof library.categories === 'object' ? library.categories : {};
  return Object.entries(source).map(([key, value]) => normalizeCatalogItem(key, value)).filter(Boolean);
}

function addToIndex(index, gramSet, categoryIndex) {
  for (const gram of gramSet) {
    let list = index.get(gram);
    if (!list) { list = []; index.set(gram, list); }
    list.push(categoryIndex);
  }
}

function compileCategoryFeatures(category) {
    const leaf = normalizeText(category.path[category.path.length - 1] || '');
    const path = normalizeText(category.path.join(' '));
    const attributes = normalizeText(category.attributeNames.join(' '));
    const semanticGroups = new Set();
    NORMALIZED_SEMANTIC_GROUPS.forEach((group, groupIndex) => { if (group.some(term => path.includes(term))) semanticGroups.add(groupIndex); });
    return Object.assign(category, {
      _leaf: leaf,
      _path: path,
      _attributes: attributes,
      _leaf2: normalizedGrams(leaf, 2),
      _path2: normalizedGrams(path, 2),
      _attribute2: normalizedGrams(attributes, 2),
      _semanticGroups: semanticGroups
    });
}

function buildCompiledCatalog(library, catalog, index2, index3, semanticIndex) {
  const value = { catalog, catalogByKey: new Map(catalog.map(category => [category.key, category])), index2, index3, semanticIndex, updatedAt: text(library && library.updatedAt, 80) || null };
  if (library && typeof library === 'object') compiledCatalogCache.set(library, value);
  return value;
}

function compileCatalog(library) {
  if (library && typeof library === 'object' && compiledCatalogCache.has(library)) return compiledCatalogCache.get(library);
  const catalog = normalizeCatalog(library).map(compileCategoryFeatures);
  const index2 = new Map(), index3 = new Map(), semanticIndex = new Map();
  catalog.forEach((category, categoryIndex) => {
    addToIndex(index2, normalizedGrams(category._path, 2), categoryIndex);
    addToIndex(index3, normalizedGrams(category._path, 3), categoryIndex);
    for (const groupIndex of category._semanticGroups) {
      let list = semanticIndex.get(groupIndex);
      if (!list) { list = []; semanticIndex.set(groupIndex, list); }
      list.push(categoryIndex);
    }
  });
  return buildCompiledCatalog(library, catalog, index2, index3, semanticIndex);
}

async function compileCatalogAsync(library, options = {}) {
  if (library && typeof library === 'object' && compiledCatalogCache.has(library)) return compiledCatalogCache.get(library);
  const source = library && library.categories && typeof library.categories === 'object' ? library.categories : {};
  const sliceMs = Math.max(1, Math.min(25, Number(options.sliceMs) || 8));
  const catalog = [], index2 = new Map(), index3 = new Map(), semanticIndex = new Map();
  let visited = 0, lastYield = Date.now();
  for (const [key, value] of Object.entries(source)) {
    const category = normalizeCatalogItem(key, value);
    if (category) {
      compileCategoryFeatures(category);
      const categoryIndex = catalog.length;
      catalog.push(category);
      addToIndex(index2, normalizedGrams(category._path, 2), categoryIndex);
      addToIndex(index3, normalizedGrams(category._path, 3), categoryIndex);
      for (const groupIndex of category._semanticGroups) {
        let list = semanticIndex.get(groupIndex);
        if (!list) { list = []; semanticIndex.set(groupIndex, list); }
        list.push(categoryIndex);
      }
    }
    visited += 1;
    if (visited % 32 === 0 || Date.now() - lastYield >= sliceMs) {
      await new Promise(resolve => setImmediate(resolve));
      lastYield = Date.now();
    }
  }
  return buildCompiledCatalog(library, catalog, index2, index3, semanticIndex);
}

function normalizeFeedback(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const examples = (Array.isArray(source.examples) ? source.examples : []).map(example => {
    const targetKey = categoryKey(example && example.target);
    const fingerprint = text(example && example.fingerprint, 64);
    if (!fingerprint || !targetKey) return null;
    return {
      id: text(example.id, 80), fingerprint,
      sourceSignature: text(example.sourceSignature, 500),
      sourceCategoryId: text(example.sourceCategoryId, 80),
      sourceCategoryPath: normalizedPath(example.sourceCategoryPath),
      title: text(example.title, 300), normalizedTitle: normalizeText(example.normalizedTitle || example.title),
      keywords: text(example.keywords, 800), target: Object.assign({}, example.target, { key: targetKey }),
      createdAt: example.createdAt || null, updatedAt: example.updatedAt || null,
      correctionCount: Math.max(1, Number(example.correctionCount) || 1)
    };
  }).filter(Boolean).slice(-MAX_EXAMPLES);
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: source.updatedAt || null,
    examples,
    history: (Array.isArray(source.history) ? source.history : []).slice(-MAX_HISTORY)
  };
}

function featureText(item) {
  return [text(item && item.title, 300), normalizedPath(item && item.sourceCategoryPath).join(' '), text(item && item.keywords, 800)].filter(Boolean).join(' ');
}

function result(status, method, confidence, category, alternatives, reasons, warning) {
  return {
    status,
    method,
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
    category: categoryPayload(category),
    alternatives: (alternatives || []).map(item => Object.assign(categoryPayload(item.category || item), item.score == null ? {} : { score: item.score })).filter(Boolean).slice(0, 5),
    reasons: (reasons || []).map(item => text(item, 180)).filter(Boolean).slice(0, 6),
    requiresManual: status !== 'matched',
    warning: text(warning, 300)
  };
}

function matchFromTraining(item, feedback, catalogByKey) {
  const normalized = feedback && Array.isArray(feedback.examples) && Array.isArray(feedback.history) ? feedback : normalizeFeedback(feedback);
  const fingerprint = titleFingerprint(item);
  const exact = normalized.examples.find(example => example.fingerprint === fingerprint && catalogByKey.has(categoryKey(example.target)));
  if (exact) {
    return result('matched', 'manual_exact', 1, catalogByKey.get(categoryKey(exact.target)), [], ['命中本租户此前人工确认的同商品类目']);
  }

  const signature = sourceSignature(item), title = normalizeText(item && item.title);
  const candidates = normalized.examples.map(example => {
    const target = catalogByKey.get(categoryKey(example.target));
    if (!target || !title || !example.normalizedTitle) return null;
    const sameSource = !signature.endsWith('|source:unknown') && example.sourceSignature === signature;
    const similarity = dice(title, example.normalizedTitle);
    const score = similarity + (sameSource ? 0.12 : 0);
    return { example, target, sameSource, similarity, score };
  }).filter(Boolean).filter(entry => entry.similarity >= 0.58).sort((a, b) => b.score - a.score);
  if (!candidates.length) return null;

  const top = candidates[0], runner = candidates.find(entry => entry.target.key !== top.target.key);
  const margin = top.score - (runner ? runner.score : 0);
  if ((top.sameSource && top.similarity >= 0.72 || top.similarity >= 0.86) && (!runner || margin >= 0.08)) {
    return result('matched', 'manual_similar', Math.min(0.98, 0.72 + top.similarity * 0.25), top.target, [], ['命中本租户同类商品的人工确认样本', `标题相似度 ${Math.round(top.similarity * 100)}%`]);
  }
  return null;
}

function fieldScore(normalizedValue, valueGrams, category) {
  if (!normalizedValue || !valueGrams.size) return 0;
  const leafCoverage = coverageSets(valueGrams, category._leaf2);
  const leafDice = diceSets(valueGrams, category._leaf2);
  const pathCoverage = coverageSets(valueGrams, category._path2);
  const ordered = orderedCoverage(normalizedValue, category._leaf);
  const directLeaf = category._leaf.length >= 2 && normalizedValue.includes(category._leaf);
  const specificity = ordered >= 0.82 ? Math.min(20, Math.max(0, category._leaf.length - 2) * 4) : 0;
  return Math.min(100, Math.max(leafCoverage * 66 + leafDice * 24, pathCoverage * 58, ordered * 72) + specificity + (directLeaf ? 8 : 0));
}

function prepareItemSignals(item) {
  const title = normalizeText(item && item.title), sourcePath = normalizedPath(item && item.sourceCategoryPath);
  const sourceRaw = sourcePath[sourcePath.length - 1] || '';
  const source = GENERIC_SOURCE_CATEGORY_WORDS.has(sourceRaw) ? '' : normalizeText(sourcePath.join(' '));
  const attributes = normalizeText(item && (item.attributeKeywords || item.keywords));
  const attributeNames = normalizeText(item && item.attributeNames);
  const description = attributes ? '' : normalizeText(item && item.descriptionKeywords);
  const semanticSignal = normalizeText([item && item.title, item && item.attributeKeywords, sourcePath.join(' ')].filter(Boolean).join(' '));
  return {
    title, sourcePath, sourceRaw, source, attributes, attributeNames, description, semanticSignal,
    titleGrams: normalizedGrams(title, 2), sourceGrams: normalizedGrams(source, 2), attributeGrams: normalizedGrams(attributes, 2),
    attributeNameGrams: normalizedGrams(attributeNames, 2), descriptionGrams: normalizedGrams(description, 2),
    semanticGroups: new Set(NORMALIZED_SEMANTIC_GROUPS.map((group, groupIndex) => group.some(term => semanticSignal.includes(term)) ? groupIndex : -1).filter(index => index >= 0)),
    productGroupIndexes: new Set(NORMALIZED_SEMANTIC_GROUPS.slice(12, 21).map((group, offset) => group.some(term => title.includes(term)) ? offset + 12 : -1).filter(index => index >= 0))
  };
}

function categoryCandidateIndexes(signals, compiled) {
  const title = signals.title, source = signals.source, sourceLeafRaw = signals.sourceRaw;
  const sourceLeaf = GENERIC_SOURCE_CATEGORY_WORDS.has(sourceLeafRaw) ? '' : normalizeText(sourceLeafRaw);
  const attributes = signals.attributes;
  const votes = new Map();
  function vote(index, gramsSet, weight, maxPosting, gramLimit) {
    for (const gram of limitedValues(gramsSet, gramLimit)) {
      const rows = index.get(gram);
      if (!rows || rows.length > maxPosting) continue;
      for (const categoryIndex of rows) votes.set(categoryIndex, (votes.get(categoryIndex) || 0) + weight);
    }
  }
  vote(compiled.index3, normalizedGrams(title, 3), 7, INDEX_MAX_POSTING_3, 90);
  vote(compiled.index2, normalizedGrams(title, 2), 4, INDEX_MAX_POSTING_2, 100);
  vote(compiled.index3, normalizedGrams(sourceLeaf || source, 3), 5, INDEX_MAX_POSTING_3, 50);
  vote(compiled.index2, normalizedGrams(sourceLeaf || source, 2), 3, INDEX_MAX_POSTING_2, 60);
  vote(compiled.index3, normalizedGrams(attributes, 3), 2, INDEX_MAX_POSTING_3, 120);
  vote(compiled.index2, normalizedGrams(attributes, 2), 1, INDEX_MAX_POSTING_2, 140);
  for (const groupIndex of signals.productGroupIndexes) {
    const semanticCandidates = compiled.semanticIndex.get(groupIndex) || [];
    for (const categoryIndex of semanticCandidates) votes.set(categoryIndex, (votes.get(categoryIndex) || 0) + 100);
  }
  if (votes.size < 24) {
    const signal = title + sourceLeaf + attributes;
    compiled.catalog.forEach((category, index) => {
      if (category._leaf.length >= 2 && signal.includes(category._leaf)) votes.set(index, (votes.get(index) || 0) + 20);
    });
  }
  return [...votes.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATE_LIMIT).map(entry => entry[0]);
}

function semanticBonus(signals, category) {
  if (!signals.semanticGroups.size || !category._semanticGroups.size) return 0;
  let common = 0;
  for (const groupIndex of signals.semanticGroups) if (category._semanticGroups.has(groupIndex)) common += 1;
  return Math.min(22, common * 11);
}

function productFormPenalty(signals, category) {
  if (!signals.productGroupIndexes.size) return 0;
  for (const groupIndex of signals.productGroupIndexes) if (category._semanticGroups.has(groupIndex)) return 0;
  return 22;
}

function materialPenalty(signals, category) {
  const leaf = category._leaf;
  if (!MATERIAL_LIKE_TERMS.some(term => leaf === normalizeText(term))) return 0;
  return signals.productGroupIndexes.size ? 24 : 0;
}

function accessoryPenalty(signals, category) {
  const title = signals.title, leaf = category._leaf;
  let penalty = 0;
  if (ACCESSORY_MARKERS.some(marker => leaf.includes(normalizeText(marker))) && !ACCESSORY_MARKERS.some(marker => title.includes(normalizeText(marker)))) penalty += 18;
  if (/机$/.test(leaf) && !/机/.test(title)) penalty += 18;
  return penalty;
}

function weightedCategoryScore(signals, category) {
  const titleScore = fieldScore(signals.title, signals.titleGrams, category);
  const sourceScore = fieldScore(signals.source, signals.sourceGrams, category);
  const attributePathScore = fieldScore(signals.attributes, signals.attributeGrams, category);
  const attributeSchemaScore = overlapSets(signals.attributeNameGrams, category._attribute2) * 100;
  const attributeScore = signals.attributes ? Math.min(100, attributePathScore * 0.68 + attributeSchemaScore * 0.32) : 0;
  const descriptionScore = fieldScore(signals.description, signals.descriptionGrams, category);
  const parts = [
    { score: titleScore, weight: 0.62, present: Boolean(signals.title) },
    { score: sourceScore, weight: 0.20, present: sourceScore >= 15 },
    { score: attributeScore, weight: 0.18, present: attributeScore >= 15 },
    { score: descriptionScore, weight: 0.08, present: !signals.attributes && descriptionScore >= 15 }
  ];
  const totalWeight = parts.reduce((sum, part) => sum + (part.present ? part.weight : 0), 0) || 1;
  let score = parts.reduce((sum, part) => sum + (part.present ? part.score * part.weight : 0), 0) / totalWeight;
  const semantic = semanticBonus(signals, category), material = materialPenalty(signals, category), formPenalty = productFormPenalty(signals, category), accessory = accessoryPenalty(signals, category);
  score = Math.max(0, Math.min(100, score + semantic - material - formPenalty - accessory));
  const reasons = [];
  if (titleScore >= 25) reasons.push(`标题匹配 ${Math.round(titleScore)}%`);
  if (sourceScore >= 25) reasons.push(`来源类目匹配 ${Math.round(sourceScore)}%`);
  if (attributeScore >= 20) reasons.push(`商品属性匹配 ${Math.round(attributeScore)}%`);
  if (semantic > 0) reasons.push('商品类型语义与Ozon类目一致');
  if (formPenalty > 0) reasons.push('候选类目与标题中的商品形态不一致，已降低权重');
  if (accessory > 0) reasons.push('候选更像配件或设备，标题未提供对应依据');
  if (material > 0) reasons.push('仅命中材质或原料词，已降低该候选权重');
  if (descriptionScore >= 30) reasons.push(`商品描述匹配 ${Math.round(descriptionScore)}%`);
  return { score, titleScore, sourceScore, attributeScore, descriptionScore, semantic, materialPenalty: material, formPenalty, accessoryPenalty: accessory, reasons };
}

function matchFromCatalog(item, compiled) {
  const signals = prepareItemSignals(item);
  if (!signals.title && !signals.sourcePath.length) return result('needs_manual', 'insufficient_source', 0, null, [], [], '商品缺少可用于匹配的标题和来源类目，请手动选择Ozon类目');
  const candidateIndexes = categoryCandidateIndexes(signals, compiled);
  if (!candidateIndexes.length) return result('needs_manual', 'catalog_no_candidate', 0, null, [], [], '没有找到可用的Ozon类目候选，请手动选择');
  const ranked = candidateIndexes.map(index => {
    const category = compiled.catalog[index];
    return Object.assign({ category }, weightedCategoryScore(signals, category));
  }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score || a.category.pathText.localeCompare(b.category.pathText, 'zh-CN'));
  if (!ranked.length) return result('needs_manual', 'catalog_no_candidate', 0, null, [], [], '没有找到可用的Ozon类目候选，请手动选择');
  const top = ranked[0], second = ranked[1], margin = top.score - (second ? second.score : 0);
  const hasPrimaryEvidence = top.titleScore >= 52 || top.titleScore >= 42 && (top.sourceScore >= 58 || top.attributeScore >= 48) || top.semantic >= 11 && top.titleScore >= 32;
  const canAutoMatch = hasPrimaryEvidence && top.score >= 58 && (top.score >= 74 || margin >= 7);
  const confidence = canAutoMatch ? Math.min(0.97, 0.56 + top.score / 250 + Math.min(0.06, margin / 180)) : Math.min(0.82, 0.34 + top.score / 180);
  return result(
    canAutoMatch ? 'matched' : 'needs_manual',
    canAutoMatch ? 'catalog_weighted' : 'catalog_candidates_weighted',
    confidence,
    canAutoMatch ? top.category : null,
    ranked.slice(canAutoMatch ? 1 : 0, canAutoMatch ? 6 : 5).map(entry => ({ category: entry.category, score: Math.round(entry.score * 100) / 100 })),
    top.reasons,
    canAutoMatch ? '' : '标题、来源类目和商品属性综合置信度不足，请手动选择Ozon类目'
  );
}

function matchOneCompiled(item, compiled, feedback) {
  const normalizedFeedback = normalizeFeedback(feedback);
  if (!compiled || !Array.isArray(compiled.catalog) || !compiled.catalog.length) throw Object.assign(new Error('Ozon 类目目录尚未导入，请先在类目管理页完成一次目录同步。'), { publicCode: 'ozon_category_catalog_empty' });
  return matchFromTraining(item || {}, normalizedFeedback, compiled.catalogByKey) || matchFromCatalog(item || {}, compiled);
}

function matchOne(item, library, feedback) {
  return matchOneCompiled(item, compileCatalog(library), feedback);
}

function matchBatchCompiled(items, compiled, feedback) {
  const normalizedFeedback = normalizeFeedback(feedback);
  if (!compiled || !Array.isArray(compiled.catalog) || !compiled.catalog.length) throw Object.assign(new Error('Ozon 类目目录尚未导入，请先在类目管理页完成一次目录同步。'), { publicCode: 'ozon_category_catalog_empty' });
  const results = (Array.isArray(items) ? items : []).map(item => {
    const match = matchFromTraining(item || {}, normalizedFeedback, compiled.catalogByKey) || matchFromCatalog(item || {}, compiled);
    return { id: text(item && item.id, 160), match };
  });
  const matched = results.filter(item => item.match.status === 'matched').length;
  return { results, summary: { total: results.length, matched, needsManual: results.length - matched } };
}

function matchBatch(items, library, feedback) {
  return matchBatchCompiled(items, compileCatalog(library), feedback);
}

function recordFeedbackCompiled(feedback, item, selectedTarget, compiled, options = {}) {
  if (!compiled || !compiled.catalogByKey || !compiled.catalogByKey.size) throw Object.assign(new Error('Ozon 类目目录尚未导入，请先在类目管理页完成一次目录同步。'), { publicCode: 'ozon_category_catalog_empty' });
  const selectedKey = categoryKey(selectedTarget), target = compiled.catalogByKey.get(selectedKey);
  if (!target) throw Object.assign(new Error('请选择有效的目标类目后再提交映射。'), { publicCode: 'ozon_category_target_invalid' });
  const title = text(item && item.title, 300);
  if (!title) throw Object.assign(new Error('请填写中文类目名称后再提交映射。'), { publicCode: 'category_mapping_title_required' });
  const document = normalizeFeedback(feedback), now = options.now || new Date().toISOString();
  const fingerprint = titleFingerprint(item), index = document.examples.findIndex(example => example.fingerprint === fingerprint);
  const previous = index >= 0 ? document.examples[index] : null;
  const example = {
    id: previous && previous.id || `cm-${fingerprint.slice(0, 24)}`,
    fingerprint,
    sourceSignature: sourceSignature(item),
    sourcePlatform: text(item && item.sourcePlatform, 40),
    sourceCategoryId: text(item && item.sourceCategoryId, 80),
    sourceCategoryPath: normalizedPath(item && item.sourceCategoryPath),
    title,
    normalizedTitle: normalizeText(title),
    keywords: text(item && item.keywords, 800),
    target: categoryPayload(target),
    createdAt: previous && previous.createdAt || now,
    updatedAt: now,
    correctionCount: (previous && previous.correctionCount || 0) + 1
  };
  if (index >= 0) document.examples[index] = example; else document.examples.push(example);
  document.examples = document.examples.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-MAX_EXAMPLES);
  const historyId = text(options.historyId, 100) || crypto.randomUUID();
  document.history.push({
    id: historyId,
    exampleId: example.id,
    productFingerprint: fingerprint,
    previousTargetKey: previous ? categoryKey(previous.target) : '',
    targetKey: target.key,
    changedAt: now
  });
  document.history = document.history.slice(-MAX_HISTORY);
  document.updatedAt = now;
  return {
    document,
    example,
    changed: !previous || categoryKey(previous.target) !== target.key,
    match: result('matched', 'manual_feedback', 1, target, [], ['当前类目由用户人工确认，已保存为本租户训练样本'])
  };
}

function recordFeedback(feedback, item, selectedTarget, library, options = {}) {
  return recordFeedbackCompiled(feedback, item, selectedTarget, compileCatalog(library), options);
}

module.exports = {
  SCHEMA_VERSION,
  categoryKey,
  dice,
  matchBatch,
  matchBatchCompiled,
  matchOne,
  matchOneCompiled,
  normalizeCatalog,
  normalizeFeedback,
  normalizeText,
  compileCatalog,
  compileCatalogAsync,
  recordFeedback,
  recordFeedbackCompiled,
  sourceSignature,
  titleFingerprint
};
