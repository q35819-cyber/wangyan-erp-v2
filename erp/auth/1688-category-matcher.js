'use strict';

const fs = require('fs');

function clean(value, maximum = 500) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function key(value) {
  return clean(value, 500).toLocaleLowerCase('zh-CN').replace(/[\s>＞›»／/、,，。:：;；()（）[\]【】_\-]+/g, '');
}

function positiveEvidence(value) {
  return clean(value, 8000).replace(/(?:不含|不带|不配|不包含|不包括|不送|没有)\s*[\u4e00-\u9fffA-Za-z0-9]{1,12}/g, ' ');
}

function safeId(value) {
  const result = clean(value, 40);
  return /^\d{1,20}$/.test(result) ? result : '';
}

function pathNames(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s*(?:>|＞|›|»)\s*/) : [];
  return list.map(item => clean(item && typeof item === 'object' ? item.name || item.title || item.label : item, 120)).filter(Boolean).slice(0, 8);
}

function boundedAttributes(value) {
  return (Array.isArray(value) ? value : []).slice(0, 100).map(item => ({
    name: clean(item && item.name, 120), value: clean(item && item.value, 500)
  })).filter(item => item.name && item.value);
}

function boundedSignals(value) {
  return (Array.isArray(value) ? value : []).slice(0, 20).map(item => ({
    kind: clean(item && item.kind, 40), value: clean(item && item.value, 120), evidence: clean(item && item.evidence, 120)
  })).filter(item => item.kind && item.value);
}

function catalogInfo(metadata) {
  metadata = metadata && typeof metadata === 'object' ? metadata : {};
  return {
    classification: clean(metadata.classification, 160) || '第三方快照，非1688官方实时数据',
    snapshotCommit: clean(metadata.commit, 80) || null,
    snapshotDate: clean(metadata.commitDate, 80) || null,
    license: clean(metadata.license, 240) || '未确认',
    current: false,
    authoritative: false
  };
}

function createCatalogIndex(input) {
  if (!input || typeof input !== 'object' || !input.root || typeof input.root !== 'object') throw Object.assign(new Error('1688类目目录格式不正确，请联系系统管理员核对目录文件。'), { code: 'source_category_catalog_invalid' });
  const nodes = [];
  const byId = new Map();
  const byPath = new Map();
  const byName = new Map();
  function visit(raw, parents, depth) {
    if (!raw || typeof raw !== 'object' || depth > 8) return;
    const id = safeId(raw.categoryId);
    const name = clean(raw.chineseName, 120);
    const path = name ? parents.concat(name) : parents.slice();
    if (id && id !== '0' && name) {
      const node = {
        id, name, path,
        level: Number.isInteger(Number(raw.level)) ? Number(raw.level) : path.length,
        leaf: Boolean(raw.isLeaf),
        complete: raw.snapshotChildrenComplete !== false
      };
      nodes.push(node);
      byId.set(id, node);
      const pathKey = path.map(key).join('>');
      if (pathKey) byPath.set(pathKey, node);
      const nameKey = key(name);
      if (!byName.has(nameKey)) byName.set(nameKey, []);
      byName.get(nameKey).push(node);
    }
    for (const child of Array.isArray(raw.children) ? raw.children.slice(0, 20000) : []) visit(child, path, depth + 1);
  }
  visit(input.root, [], 0);
  if (!nodes.length) throw Object.assign(new Error('1688类目目录暂无可匹配内容，请联系系统管理员更新目录。'), { code: 'source_category_catalog_empty' });
  return { nodes, byId, byPath, byName, metadata: catalogInfo(input.metadata) };
}

function resultNode(node, score, reasons) {
  return {
    id: node.id,
    name: node.name,
    path: node.path.slice(),
    pathText: node.path.join(' / '),
    level: node.level,
    leaf: node.leaf,
    branchComplete: node.complete,
    score: Math.round(score * 100) / 100,
    reasons: reasons.slice(0, 8)
  };
}

function exactResult(index, node, method, confidence, reasons) {
  return {
    status: 'matched', method, confidence,
    category: resultNode(node, 100, reasons), alternatives: [], catalog: index.metadata,
    requiresReview: !node.complete
  };
}

function candidateScore(node, context) {
  const reasons = [];
  let score = 0;
  const nodeKey = key(node.name);
  const titleKey = key(positiveEvidence(context.title));
  const attributeKey = key(positiveEvidence(context.attributes.map(item => item.name + item.value).join(' ')));
  const sellerValues = context.signals.filter(item => item.kind === 'seller_category').map(item => key(item.value)).filter(Boolean);
  const pathKeys = node.path.map(key);
  const combined = titleKey + attributeKey;
  if (nodeKey.length >= 2 && combined.includes(nodeKey)) { score += 95; reasons.push('标题或属性包含末级类目名称'); }
  for (const seller of sellerValues) {
    const position = pathKeys.findIndex(value => value === seller);
    if (position >= 0) { score += position === pathKeys.length - 1 ? 95 : 62; reasons.push('店铺主营与类目路径一致'); break; }
  }
  const semantic = [
    { input: /木质|木制|胡桃木|实木/, output: /木质|木制|木器/ , points: 32, reason: '材质词与木制类目一致' },
    { input: /工艺品|摆件|装饰品/, output: /工艺品|摆件|装饰品/, points: 20, reason: '用途词与工艺摆件类目一致' },
    { input: /扩香|香薰|香氛/, output: /香薰|香氛|芳香/, points: 30, reason: '扩香用途与香薰类目一致' },
    { input: /车载|汽车|车内/, output: /汽车|车用|车内/, points: 18, reason: '车载用途与汽车类目一致' },
    { input: /玩具|积木|拼装/, output: /玩具|积木|拼装/, points: 28, reason: '商品用途与玩具类目一致' },
    { input: /厨房|厨用/, output: /厨房|厨具|厨用/, points: 25, reason: '使用场景与厨房类目一致' },
    { input: /沥水|置物架|收纳/, output: /沥水|置物|收纳/, points: 28, reason: '功能词与收纳置物类目一致' }
  ];
  const searchablePath = node.path.join('');
  const positiveContext = positiveEvidence(context.title + ' ' + context.attributeText);
  for (const rule of semantic) if (rule.input.test(positiveContext) && rule.output.test(searchablePath)) {
    score += rule.points; reasons.push(rule.reason);
  }
  if (node.leaf) score += 2;
  if (!node.complete) score -= 8;
  return { score, reasons };
}

function matchCategory(index, input) {
  if (!index || !index.byId || !index.nodes) throw Object.assign(new Error('1688类目目录格式不正确，请联系系统管理员核对目录文件。'), { code: 'source_category_catalog_invalid' });
  input = input && typeof input === 'object' ? input : {};
  if (clean(input.platform, 20) !== '1688') throw Object.assign(new Error('只有1688货源支持自动匹配类目，请更换货源链接。'), { code: 'source_category_platform_invalid' });
  const ids = (Array.isArray(input.categoryIds) ? input.categoryIds : []).map(safeId).filter(Boolean).slice(0, 20);
  const identified = ids.map((id, position) => ({ node: index.byId.get(id), position })).filter(item => item.node)
    .sort((left, right) => right.node.level - left.node.level || right.position - left.position)[0];
  if (identified) return exactResult(index, identified.node, 'page_category_id', 1, ['商品页链接提供了目录中的类目ID']);
  const pagePath = pathNames(input.pagePath);
  if (pagePath.length) {
    const exact = index.byPath.get(pagePath.map(key).join('>'));
    if (exact) return exactResult(index, exact, 'page_breadcrumb_path', 0.99, ['商品页面包屑与目录完整路径一致']);
    const terminal = index.byName.get(key(pagePath.at(-1))) || [];
    if (terminal.length === 1) return exactResult(index, terminal[0], 'page_breadcrumb_terminal', 0.93, ['商品页面包屑末级名称在目录中唯一']);
  }
  const context = {
    title: clean(input.title, 600),
    attributes: boundedAttributes(input.attributes),
    signals: boundedSignals(input.signals)
  };
  context.attributeText = context.attributes.map(item => item.name + ' ' + item.value).join(' ');
  const ranked = index.nodes.filter(node => node.leaf).map(node => {
    const scored = candidateScore(node, context);
    return { node, score: scored.score, reasons: scored.reasons };
  }).filter(item => item.score > 20).sort((left, right) => right.score - left.score || right.node.level - left.node.level || left.node.id.localeCompare(right.node.id, 'zh-CN', { numeric: true })).slice(0, 5);
  if (!ranked.length) return {
    status: 'unmatched', method: 'insufficient_page_evidence', confidence: 0,
    category: null, alternatives: [], catalog: index.metadata, requiresReview: true
  };
  const best = ranked[0];
  const runnerUp = ranked[1];
  const margin = Math.max(0, best.score - (runnerUp ? runnerUp.score : 0));
  const confidence = Math.min(0.89, Math.max(0.45, 0.45 + best.score / 360 + margin / 500));
  return {
    status: 'needs_review', method: 'title_attribute_seller_candidate',
    confidence: Math.round(confidence * 100) / 100,
    category: resultNode(best.node, best.score, best.reasons),
    alternatives: ranked.slice(1).map(item => resultNode(item.node, item.score, item.reasons)),
    catalog: index.metadata, requiresReview: true
  };
}

function createFileMatcher(file) {
  let cached = null;
  let cachedMtime = -1;
  return function match(input) {
    let stat;
    try { stat = fs.statSync(file); }
    catch (error) { throw Object.assign(new Error('1688类目目录暂不可用，请稍后重试；持续失败请联系系统管理员。'), { code: 'source_category_catalog_unavailable', cause: error }); }
    if (!cached || cachedMtime !== stat.mtimeMs) {
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
      catch (error) { throw Object.assign(new Error('1688类目目录格式不正确，请联系系统管理员核对目录文件。'), { code: 'source_category_catalog_invalid', cause: error }); }
      cached = createCatalogIndex(parsed);
      cachedMtime = stat.mtimeMs;
    }
    return matchCategory(cached, input);
  };
}

module.exports = { clean, key, positiveEvidence, pathNames, createCatalogIndex, matchCategory, createFileMatcher };
