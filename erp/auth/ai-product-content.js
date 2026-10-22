'use strict';

const { declaredMaxChars, validatePolicy } = require('./ai-product-rules');

// 商品优化第一阶段的六项中文候选，固定顺序与页面卡片一致。
const ITEMS = Object.freeze({
  title: { label: '商品标题', capability: 'title-optimization', maxChars: 200 },
  tags: { label: '标签', capability: 'title-optimization', maxChars: 30 * 30 + 29 },
  summary: { label: '商品简介', capability: 'description-optimization', maxChars: 2000 },
  sellingPoints: { label: '卖点提炼', capability: 'selling-point-generation', maxChars: 1000 },
  richTitle: { label: '图文标题', capability: 'title-optimization', maxChars: 200 },
  richDescription: { label: '图文描述', capability: 'description-optimization', maxChars: 2000 }
});
const ITEM_KEYS = Object.freeze(Object.keys(ITEMS));
const MATERIAL_FIELDS = ['title', 'summary', 'attribute', 'sellingPoints', 'richTitle', 'richDescription'];
const FACTS_MAX_CHARS = 8000;
const REVIEW_FIELDS = ['title', 'summary', 'sellingPoints', 'richTitle', 'richDescription'];
const VALIDATOR_VERSION = 'content-risk-v1';
const RUSSIAN_OUTPUT_PROTOCOL = '正式俄语内容中，仅本次管理员材料许可表且已核对原始证据的完整材料英文词组可以原样保留；未获得该例外的非身份材质或技术缩写使用含义一致的俄语通行表达。不得把材料缩写当作品牌、型号或尺码身份例外。明确品牌、型号、尺码及已核验证据中的适配身份仍保持真实标识，数字和单位含义不得改变。尺寸乘法分隔使用乘号×而不是拉丁字母x，例如14.5x14.5写成14.5×14.5，两个数值均保持不变。不确定俄语对应时不得猜测；明显整字段语言错误会被拒绝，局部不确定术语保留并提示人工核对，不在输出后静默替换。';

function fail(code, message, status = 400) { return Object.assign(new Error(message), { publicCode: code, status }); }

// 尺寸仅核对可识别的数值+长度单位/多轴表达；不把重量数字当尺寸证明。
const DIMENSION_EXPRESSION = /(?<![a-zа-яё\d._/\-])(\d+(?:[.,]\d+)?(?:\s*[×xх*]\s*\d+(?:[.,]\d+)?){0,2})\s*(毫米|厘米|mm|cm|мм|см|米|m|м)(?![a-zа-яё])/giu;
const PACKAGE_DIMENSION_KEY = /^(?:9454|9455|9456|4082|包装尺寸毫米|packageDimensionSources)$|(?:包装|упаков|package|packing).*(?:尺寸|长|宽|高|深|size|dimension|length|width|height|depth|размер|длин|шир|высот|глуб)/iu;
function dimensionTokens(text, facts) {
  let body = String(text);
  // 仅遮蔽已明确声明且同时含字母和数字的完整身份词；裸M尺码不能抹掉真实12 m。
  if (typeof facts === 'string') {
    for (const word of identityValues(facts, true)) if (/^[a-z\d._/-]+$/i.test(word) && /[a-z]/i.test(word) && /\d/.test(word)) body = body.replace(new RegExp(identityPattern(word), 'giu'), ' '.repeat(word.length));
    // 有空格/纯数字型号只在紧接明确尺码的组合处消歧；大小写精确，M不能吃掉单位m。
    for (const model of identityValues(facts, false, 'model')) for (const size of identityValues(facts, false, 'size')) {
      if (!/\d/.test(model) || !model.trim() || !/^[A-Z]+(?:[\d-][A-Z\d]*)*$/.test(size)) continue;
      const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pair = new RegExp('(?<![a-zA-Zа-яА-ЯёЁ\\d._/-])' + escape(model.trim()) + '\\s*' + escape(size) + '(?![a-zA-Zа-яА-ЯёЁ\\d._/-])', 'gu');
      body = body.replace(pair, match => ' '.repeat(match.length));
    }
  }
  return Array.from(body.matchAll(new RegExp(DIMENSION_EXPRESSION.source, 'giu')), match => match[1].replace(/\s/g, '').replace(/[xх*]/gi, '×').replace(/,/g, '.') + ({ 毫米: 'mm', мм: 'mm', 厘米: 'cm', см: 'cm', 米: 'm', м: 'm' }[match[2].toLowerCase()] || match[2].toLowerCase()));
}
function cleanDimensionSource(value) {
  if (Array.isArray(value)) return value.filter(row => !row || typeof row !== 'object' || (!['9454', '9455', '9456', '4082'].includes(String(row.id || row.attribute_id || '')) && row.source !== 'fallback' && row.dimensionSource !== 'fallback' && !PACKAGE_DIMENSION_KEY.test(String(row.name || row.label || '')))).map(cleanDimensionSource);
  if (!value || typeof value !== 'object') return value;
  if (value.dimensionSource === 'fallback' || value.source === 'fallback') return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PACKAGE_DIMENSION_KEY.test(key)).map(([key, item]) => [key, cleanDimensionSource(item)]));
}
function dimensionSourceTexts(facts) {
  let data; try { data = JSON.parse(facts); } catch (_) { return []; }
  data = cleanDimensionSource(data);
  const source = data['适配来源'] || {};
  const texts = [typeof source.title === 'string' ? source.title : ''];
  const visit = (value, label = '') => {
    if (typeof value === 'string' || typeof value === 'number') { if (/尺寸|长度|宽度|高度|厚度|直径|深度|размер|длин|ширин|высот|толщин|диаметр|глубин|dimension|length|width|height|thickness|diameter|depth/iu.test(label)) texts.push(label + ' ' + String(value)); }
    else if (value && typeof value === 'object') {
      const fieldLabel = String(value.name || value.label || value.attribute_name || '');
      for (const [key, item] of Object.entries(value)) if (!['name', 'label', 'attribute_name'].includes(key)) visit(item, label + ' ' + fieldLabel + ' ' + key);
    }
  };
  visit(source.attributes); visit(data['类目属性']);
  return texts;
}
function dimensionEvidence(facts) { return dimensionSourceTexts(facts).flatMap(dimensionTokens); }
function dimensionError(text, facts) {
  const sources = dimensionSourceTexts(facts), allowed = sources.flatMap(dimensionTokens), tokens = dimensionTokens(text, facts);
  if (tokens.some(token => !allowed.includes(token))) return '内容含缺少真实商品尺寸来源的尺寸，包装、兜底或来源不明尺寸不能用于商品文案，请省略后重新生成。';
  const qualifiers = [/展开|展開|unfolded|разложенн/iu, /折叠|折疊|(?<![a-z])folded|(?<![а-яё])сложенн/iu];
  for (const token of tokens) for (const qualifier of qualifiers) {
    if (sources.some(source => dimensionTokens(source).includes(token) && qualifier.test(source)) && !qualifier.test(text)) return '商品尺寸丢失了原始展开或折叠状态限定，已拒绝采用，请保留原始状态后重新生成。';
  }
  return '';
}

function request(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid_ai_content_request', '商品优化请求格式不正确');
  let facts = String(input.facts == null ? '' : input.facts).trim();
  const rawFacts = facts;
  if (!facts) throw fail('invalid_ai_content_facts', '请先填写商品原始事实');
  if (facts.length > FACTS_MAX_CHARS) throw fail('invalid_ai_content_facts', `商品原始事实不能超过 ${FACTS_MAX_CHARS} 字`);
  let structuredFacts;
  try { structuredFacts = JSON.parse(facts); } catch (_) { structuredFacts = null; }
  if (structuredFacts && typeof structuredFacts === 'object') { compatibilitySource(structuredFacts['适配来源']); facts = JSON.stringify(cleanDimensionSource(structuredFacts)); }
  let items = input.items;
  if (items === undefined || items === null || items === '') items = ITEM_KEYS;
  if (!Array.isArray(items) || !items.length) throw fail('invalid_ai_content_items', '请至少选择一项候选内容');
  const keys = [];
  for (const item of items) {
    const key = String(item);
    if (!ITEMS[key]) throw fail('invalid_ai_content_items', '包含未知的候选内容项');
    if (!keys.includes(key)) keys.push(key);
  }
  return { facts, rawFacts, keys, bilingual: input.bilingual === true };
}

// 数字与单位必须在原始事实中出现，防止模型编造规格；这与旧的商品翻译口径一致。
function numbers(value) {
  // 行首编号（“1.”“2)”等）是版式而不是商品事实，不参与数字比对。
  const body = String(value).split(/\r?\n/).map(line => line.replace(/^\s*[-*·]?\s*\d{1,3}\s*[.、．)）]\s+/, '')).join('\n');
  const found = body.match(/\d+(?:[.,]\d+)?/g) || [];
  return found.map(item => item.replace(/[.,]$/, '')).sort();
}
// 单位同义归一后再比对：500毫升 与 500ml 属同一事实，不算编造；多字单位优先匹配，避免 m 抢在 ml 前面截断。
const UNIT_SYNONYMS = Object.freeze({
  '毫米': 'mm', '厘米': 'cm', '毫升': 'ml', '千克': 'kg', '公斤': 'kg', '升': 'l', '克': 'g', '米': 'm',
  '瓦': 'w', '安': 'a', '片': '件', '只': '件', '个': '件', '条': '件', '双': '件', '支': '件', '包': '件', '箱': '件', '盒': '件',
  'mah': 'mah', '℃': 'c', '°': 'c', 'руб': 'rub'
});
const UNIT_ALTERNATIVES = ['毫米','厘米','毫升','千克','公斤','mah','mm','cm','ml','kg','%','℃','°','寸','升','克','米','瓦','安','件','片','只','个','条','双','支','包','箱','盒','元','руб','l','g','m','v'].join('|');
function unitTokens(value) {
  const pattern = new RegExp('(\\d+(?:[.,]\\d+)?)\\s*(' + UNIT_ALTERNATIVES + ')', 'gi');
  const found = [];
  let match;
  while ((match = pattern.exec(String(value)))) {
    const unit = match[2].toLowerCase();
    found.push(match[1].replace(/[.,]$/, '') + (UNIT_SYNONYMS[unit] || unit));
  }
  return found.sort();
}

// 参考稿版式：每节以 **标题** 行开始，正文可包在 ``` 代码块里或直接紧跟其后。
const SECTION_ALIASES = Object.freeze({
  title: ['商品标题', '标题'],
  tags: ['标签', '中文对照', '话题标签'],
  summary: ['商品简介', '简介', '描述'],
  sellingPoints: ['卖点提炼', '卖点'],
  richTitle: ['图文标题'],
  richDescription: ['图文描述', '图文内容']
});
function headingToKey(line) {
  const text = String(line || '').replace(/[*＃#\s]/g, '').replace(/^[一二三四五六七八九十\d]+[、.．]/, '');
  for (const [key, names] of Object.entries(SECTION_ALIASES)) {
    if (names.some(name => text === name.replace(/[*＃#\s]/g, ''))) return key;
  }
  return null;
}
function parseSections(text, keys) {
  const raw = String(text || '');
  const value = {};
  const lines = raw.split(/\r?\n/);
  let current = null;
  let inFence = false;
  const buffer = [];
  const flush = () => {
    // 空行是小节排版；标签正文行的空格和制表符必须留给格式校验，不能清洗。
    while (buffer[0] === '') buffer.shift();
    while (buffer.length && buffer[buffer.length - 1] === '') buffer.pop();
    if (current && !Object.prototype.hasOwnProperty.call(value, current)) value[current] = current === 'tags' ? buffer.join('\n') : buffer.join('\n').trim();
    buffer.length = 0;
  };
  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (fence) { inFence = !inFence; continue; }
    if (!inFence) {
      const heading = /^\s*\*{0,2}([^*\n]{1,24})\*{0,2}\s*[：:]?\s*$/.exec(line);
      if (heading) {
        const key = headingToKey(heading[1]);
        if (key) { flush(); current = key; continue; }
      }
    }
    if (current) buffer.push(line);
  }
  flush();
  const candidates = {};
  const failures = {};
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) candidates[key] = value[key];
    else failures[key] = { code: 'ai_candidate_missing', message: `${ITEMS[key].label}：供应商没有返回该节内容` };
  }
  return { candidates, failures, matched: Object.keys(candidates).length };
}
function parseResponse(text, keys, rulesByKey, facts) {
  const raw = String(text || '').trim();
  let parsedJson = null;
  try { parsedJson = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch (_) { parsedJson = null; }
  if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) return parseCandidates(raw, keys, rulesByKey, facts);
  const sections = parseSections(text, keys);
  const candidates = {};
  const failures = {};
  const warnings = {};
  for (const key of keys) {
    if (!sections.candidates[key]) {
      if (sections.failures[key]) failures[key] = sections.failures[key];
      continue;
    }
    const checked = parseCandidates(JSON.stringify({ [key]: sections.candidates[key] }), [key], rulesByKey, facts);
    if (checked.candidates[key]) {
      candidates[key] = checked.candidates[key];
      if (checked.warnings[key]) warnings[key] = checked.warnings[key];
    } else if (checked.failures[key]) {
      failures[key] = checked.failures[key];
    }
  }
  return { candidates, failures, warnings };
}
function promptFor(rules) {
  const lines = ['你是跨境电商商品资料编辑。只依据用户提供的“商品原始事实”生成中文候选，缺失信息不得猜测或补全。'];
  if (rules.global) lines.push(`全局规则（必须遵守）：${rules.global}`);
  lines.push(policyPrompt(rules));
  for (const item of rules.items) lines.push(`${item.label}规则（必须遵守）：${item.body}`);
  lines.push('按下面的版式一次性输出全部小节：每节一行节名、紧跟该节正文；节名必须完全使用下列中文原名，不得增删、不得改序，不要输出任何解释或前后缀：');
  for (const item of rules.items) lines.push(`**${item.sectionTitle}**`);
  // 内容格式（标签分隔、卖点编号等）一律由系统管理员规则决定，此处不再重复规定，避免与规则静默冲突。
  lines.push('每节正文使用中文；只使用原始事实中出现的数字与单位，原始事实没有的数据一律不写。');
  return lines.join('\n');
}

function validTags(body) {
  const tags = body.split(' ');
  return tags.length <= 30 && tags.every(tag =>
    /^#[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*$/u.test(tag) && Array.from(tag).length <= 30);
}

function compatibilityFacts(facts) {
  let value;
  try { value = JSON.parse(facts); } catch (_) { return []; }
  const rows = value && (value['适配资料'] || value.compatibility);
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 20 || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['brand', 'model'].includes(key)) || ['brand', 'model'].some(key => typeof row[key] !== 'string' || !row[key].trim() || row[key].length > 100 || /[\u0000-\u001f\u007f]/.test(row[key])))) throw fail('invalid_compatibility_facts', '适配资料只允许最多20组明确配对的适配品牌和型号，每项不超过100字。');
  return rows;
}

function compatibilitySource(value) {
  if (value === undefined) return { title: '', attributes: {} };
  const badControl = item => typeof item === 'string' ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item) : item && typeof item === 'object' ? Object.values(item).some(badControl) : false;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['title', 'attributes'].includes(key)) || typeof value.title !== 'string' || !value.attributes || typeof value.attributes !== 'object' || Array.isArray(value.attributes) || JSON.stringify(value).length > 8000 || badControl(value)) throw fail('invalid_compatibility_source', '适配原始资料格式不正确或超过8000字符，请保留原标题和商品属性后重试。');
  return cleanDimensionSource(value);
}

function verifiedCompatibility(rows, source) {
  if (rows === undefined) return [];
  const leaves = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [];
  if (!Array.isArray(rows) || rows.length > 20) throw fail('invalid_ai_compatibility', 'AI返回的适配资料无法确认，未采用本次内容，请核对原标题和商品属性后重新生成。', 422);
  const pairs = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['brand', 'model', 'source', 'evidence'].includes(key)) || !['title', 'attributes'].includes(row.source) || ['brand', 'model', 'evidence'].some(key => typeof row[key] !== 'string' || !row[key].trim() || row[key].length > (key === 'evidence' ? 1000 : 100) || /[\u0000-\u001f\u007f]/.test(row[key]))) throw fail('invalid_ai_compatibility', 'AI返回的适配品牌、型号或来源证据不完整，请核对原始资料后重新生成。', 422);
    const contains = value => new RegExp(identityPattern(value), 'iu').test(row.evidence);
    if (!(row.source === 'title' ? [source.title] : leaves(source.attributes)).some(text => text.includes(row.evidence)) || !contains(row.brand) || !contains(row.model)) throw fail('invalid_ai_compatibility', '适配品牌和型号未在同一段原始证据中确认，请核对原标题和商品属性后重新生成。', 422);
    pairs.push({ brand: row.brand.trim(), model: row.model.trim() });
  }
  return pairs;
}

function identityPattern(value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /\p{Script=Han}/u.test(value) ? escaped : '(?<![a-zа-яё0-9])' + escaped + '(?![a-zа-яё0-9])';
}

function materialPattern(term) {
  return '(?:(?<![\\p{L}\\p{N}\\p{M}_-])|(?<=\\p{Script=Han}))' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:(?![\\p{L}\\p{N}\\p{M}_-])|(?=\\p{Script=Han}))';
}
function materialMatches(facts, globalPolicy, sourceOverride, currentText) {
  validatePolicy('global', globalPolicy);
  let parsed;
  try { parsed = JSON.parse(facts); } catch (_) { parsed = {}; }
  const source = compatibilitySource(sourceOverride === undefined ? parsed?.['适配来源'] : sourceOverride);
  const evidence = [{ source: 'title', field: 'title', evidence: source.title }];
  const materialName = /^(?:材质|材料|主要材质|主材质|material|materials|материал|основной материал)$/i;
  const leaves = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [];
  for (const [field, value] of Object.entries(source.attributes)) if (materialName.test(field.trim())) for (const text of leaves(value)) evidence.push({ source: 'attributes', field, evidence: text });
  return globalPolicy.materialTerms.flatMap(term => {
    const pattern = new RegExp(materialPattern(term), 'iu');
    if (currentText !== undefined && !pattern.test(currentText)) return [];
    const found = evidence.find(row => pattern.test(row.evidence));
    return found ? [{ term, ...found }] : [];
  });
}
function stripMaterials(body, matches) {
  // 连续英文词组必须完整命中一项，不将词条拆成单词拼接放行英文句子。
  return body.replace(/[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*/gi, (run, offset) => {
    const boundary = new RegExp(materialPattern(run), 'iuy');
    boundary.lastIndex = offset;
    if (!boundary.test(body)) return run;
    return matches.some(row => row.term.toLowerCase() === run.toLowerCase()) ? '' : run;
  });
}
function withCompatibility(facts, metadata, sourceOverride) {
  let parsed;
  try { parsed = JSON.parse(facts); } catch (_) { parsed = { model: Array.from(identityWords(facts)).join(' ') }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
  const source = compatibilitySource(sourceOverride === undefined ? parsed['适配来源'] : sourceOverride);
  return JSON.stringify({ ...parsed, '适配来源': source, '适配资料': verifiedCompatibility(metadata, source), compatibility: undefined });
}

function phrasePresent(text, phrase) {
  return new RegExp(identityPattern(phrase), 'iu').test(text);
}
function policyPrompt(rules) {
  return '系统完整性：商品尺寸只可引用原标题或明确商品本体尺寸属性的可信证据；包装、兜底、来源不明尺寸一律省略，不为凑长度填尺寸，重量/容量/数量不因此删除。品牌身份只认当前明确字段，适配身份必须同次返回compatibility数组，每项{brand,model,source:"title"或"attributes",evidence:"含两者的原始单叶连续摘录"}；不能拼接或编造证据。以下管理员结构化策略优先于写作正文，不能关闭事实、数字、语言、结构及平台语法校验：' + JSON.stringify({ global: rules.globalPolicy, materialMatches: rules.materialMatches || [], materialFields: MATERIAL_FIELDS, items: rules.items.map(item => ({ key: item.key, policy: item.policy })) });
}
function prohibitedClaim(text, globalPolicy) {
  validatePolicy('global', globalPolicy);
  return Object.values(globalPolicy.prohibitedClaims).flat().some(phrase => phrasePresent(text, phrase));
}
function contentBoundaryError(text, key, facts, translating = false, rule = {}) {
  if (!REVIEW_FIELDS.includes(key)) { const dimension = dimensionError(text, facts); if (dimension) return dimension; }
  // 来源不足是人工核对警告；明确包装来源在双语解析中单独验证，不凭数值相同判定。
  const policy = key === 'attribute' ? null : validatePolicy(key, rule.policy);
  if (key === 'title' && policy.rejectBrandPlaceholder && /无品牌|無品牌|(?<![\p{L}])(?:без\s+бренда|нет\s+бренда|no\s+brand|unbranded)(?![\p{L}])/iu.test(text)) return translating ? '翻译结果包含“无品牌”占位，已保留原内容。' : '生成标题包含“无品牌”占位，请重新生成。';
  if (prohibitedClaim(text, rule.globalPolicy)) return '内容包含管理员策略禁止的宣称，系统已拒绝采用，请调整后重新生成或翻译。';
  let data;
  try { data = JSON.parse(facts); } catch (_) { data = {}; }
  const brands = [data.品牌, data.brand].filter(value => typeof value === 'string' && value.trim());
  const originalBrands = [];
  const readBrands = value => {
    if (!value || typeof value !== 'object') return;
    const label = value.name || value.attribute_name || value.label;
    if (/^(?:品牌|brand|Бренд)$/iu.test(String(label || '')) && typeof value.value === 'string') originalBrands.push(value.value);
    for (const [name, item] of Object.entries(value)) {
      if (/^(?:品牌|brand|Бренд)$/iu.test(name) && typeof item === 'string') originalBrands.push(item);
      else if (item && typeof item === 'object') readBrands(item);
    }
  };
  readBrands(data['适配来源']?.attributes);
  readBrands(data['原始属性']);
  if (!translating && key === 'title' && originalBrands.some(brand => brand.trim() && !brands.some(current => current.toLowerCase() === brand.toLowerCase()) && !compatibilityFacts(facts).some(row => row.brand.toLowerCase() === brand.toLowerCase()) && phrasePresent(text, brand))) return '标题使用了原始属性中的品牌，但该品牌不是当前明确设置的商品品牌，请先核对品牌字段。';
  const models = [data.型号名称, data.model].filter(value => typeof value === 'string' && value.trim());
  if (key === 'title' && policy.ownBrand === 'omit' && brands.some(value => phrasePresent(text, value))) return '当前标题策略要求省略商品自身品牌，请重新生成或翻译。';
  if (key === 'tags' && ((policy.excludeBrand && brands.some(value => phrasePresent(text, value))) || (policy.excludeModel && models.some(value => phrasePresent(text, value))))) return '标签包含当前策略禁止的商品品牌或型号，请重新生成。';
  for (const row of compatibilityFacts(facts)) {
    for (const [identityKey, identity] of Object.entries(row)) {
      const pattern = new RegExp(identityPattern(identity.trim()), 'giu');
      for (const match of text.matchAll(pattern)) {
        if (key === 'tags') {
          if ((identityKey === 'brand' && policy.excludeBrand) || (identityKey === 'model' && policy.excludeModel)) return '标签包含当前策略禁止的适配品牌或型号，请重新生成。';
          continue;
        }
        if (key === 'attribute') continue;
        if (!['title', 'summary'].includes(key) || policy.compatibility === 'deny') return '当前字段策略不允许适配品牌和型号，请重新生成或翻译。';
        const prefix = text.slice(Math.max(0, match.index - 200), match.index).split(/[\n.!?。！？;；]/).pop();
        if (!Object.values(policy.compatibilityExpressions).flat().some(phrase => phrasePresent(prefix, phrase))) return '适配品牌或型号未使用管理员配置的兼容表达，请重新生成或翻译。';
        const sentence = text.slice(0, match.index).split(/[\n.!?。！？;；]/).pop() + text.slice(match.index).split(/[\n.!?。！？;；]/)[0];
        if (!Object.values(row).every(value => phrasePresent(sentence, value.trim()))) return '适配品牌和型号必须按已确认资料成对表达，不能拆错适配关系，请重新生成或翻译。';
      }
    }
  }
  return '';
}
function numberSet(value) {
  return Array.from(new Set(numbers(value).map(token => {
    const [integer, fraction = ''] = token.replace(',', '.').split('.');
    const decimal = fraction.replace(/0+$/, '');
    return integer.replace(/^0+(?=\d)/, '') + (decimal ? '.' + decimal : '');
  }))).sort().join('|');
}

function identityValues(facts, includeCompatibility = false, kind) {
  const values = [];
  const identityKey = kind === 'model' ? /^(?:型号|型号名称|model|Модель)$/i : kind === 'size' ? /^(?:尺码|size|Размер)$/i : /^(?:品牌|型号|型号名称|尺码|brand|model|size|Бренд|Модель|Размер)$/i;
  let parsed;
  try { parsed = JSON.parse(facts); } catch (_) { parsed = null; }
  if (parsed && typeof parsed === 'object') {
    const visit = (object, topLevel = false) => {
      for (const [key, value] of Object.entries(object)) {
        if (/^(?:品牌|brand|Бренд)$/i.test(key)) {
          if (!kind && topLevel && typeof value === 'string' && !/^(?:无品牌|無品牌|нет бренда|без бренда|no brand|unbranded)$/i.test(value.trim())) values.push(value);
        } else if (identityKey.test(key) && typeof value === 'string') values.push(value);
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(parsed, true);
    if (includeCompatibility) for (const row of compatibilityFacts(facts)) values.push(...(kind === 'model' ? [row.model] : kind ? [] : Object.values(row)));
  } else {
    // 旧中文审核事实支持明确标注的单词标识，不从普通描述猜品牌或型号。
    for (const match of String(facts).matchAll(/(?:^|[\s；;，,])(型号名称|型号|尺码)\s*[:：]?\s*([a-z\d]+(?:-[a-z\d]+)*)(?=$|[\s；;，,])/gi)) if (identityKey.test(match[1])) values.push(match[2]);
  }
  return values;
}
function identityWords(facts, includeCompatibility = false) {
  return new Set(identityValues(facts, includeCompatibility).flatMap(value => value.match(/[a-z]+(?:[-\d][a-z\d]*)*/gi) || []).map(word => word.toLowerCase()));
}

function validRussian(body, facts, key, rule = {}) {
  // ponytail: 字符与明确身份字段仅拦明显错语，不能鉴定俄语语义；自然度仍需人工审核。
  if ((key !== 'tags' && !/[а-яё]{2}/i.test(body)) || /[^а-яёa-z]/iu.test((body.match(/\p{L}/gu) || []).join(''))) return false;
  // 标签规范禁止品牌/型号；每个标签独立满足俄语要求，不能用一个俄语标签掩盖英文标签。
  if (key === 'tags') {
    const identities = identityWords(facts, true);
    return body.split(' ').every(tag => {
      const words = tag.match(/[a-z]+(?:[-\d][a-z\d]*)*/gi) || [];
      return (/[а-яё]{2}/i.test(tag) || words.length > 0) && words.every(word => identities.has(word.toLowerCase()));
    });
  }
  const identities = identityWords(facts, MATERIAL_FIELDS.includes(key));
  const materials = MATERIAL_FIELDS.includes(key) ? materialMatches(facts, rule.globalPolicy, undefined, rule.materialSourceText) : [];
  const withoutMaterials = stripMaterials(body, materials);
  const withoutUnits = withoutMaterials.replace(/(?<![\p{L}\p{N}-])\d+(?:[.,]\d+)?\s*(?:mm|cm|ml|kg|mah|hz|w|v|a|l|g|m)\b/giu, '');
  return (withoutUnits.match(/[a-z]+(?:[-\d][a-z\d]*)*/gi) || []).every(word => identities.has(word.toLowerCase()));
}

function validChinese(body, facts, key, rule = {}) {
  if (!/\p{Script=Han}/u.test(body) || /[а-яё]/i.test(body)) return false;
  const materials = MATERIAL_FIELDS.includes(key) ? materialMatches(facts, rule.globalPolicy, undefined, rule.materialSourceText) : [];
  const remainder = stripMaterials(body, materials).replace(/(?<![\p{L}\p{N}-])\d+(?:[.,]\d+)?\s*(?:mm|cm|ml|kg|mah|hz|w|v|a|l|g|m)\b/giu, '');
  const identities = identityWords(facts, MATERIAL_FIELDS.includes(key));
  return (remainder.match(/[a-z]+(?:[-\d][a-z\d]*)*/gi) || []).every(word => identities.has(word.toLowerCase()));
}

function warningBundle(items) {
  const unique = [...new Map(items.filter(Boolean).map(item => [item.code + ':' + item.message + ':' + (item.language || 'both'), item])).values()];
  return unique.length ? { ...unique[0], items: unique } : null;
}
function languageReview(text, facts, key, rule, language) {
  if ((language === 'zh' ? validChinese : validRussian)(text, facts, key, rule)) return { hard: false };
  if (!REVIEW_FIELDS.includes(key) || !(language === 'zh' ? /\p{Script=Han}/u : /[а-яё]{2}/i).test(text) || (language === 'zh' ? /[а-яё]/i : /\p{Script=Han}/u).test(text)) return { hard: true };

  return { hard: false, warning: { code: 'ai_content_material_review', message: '局部材料术语或缩写的来源、语言边界尚未完全确认，请核对后再使用。' } };
}
function contentWarnings(text, facts, key, rule, claims) {
  if (!REVIEW_FIELDS.includes(key)) return [];
  const items = [];
  const dimension = dimensionError(text, facts);
  if (dimension) items.push({ code: 'ai_content_dimension_review', message: dimension.includes('展开或折叠') ? '商品尺寸可能遗漏展开或折叠状态限定，请对照原始资料核对。' : '商品尺寸来源尚未完全确认，请核对是否为商品本体尺寸；包装或兜底尺寸不能代替商品尺寸。' });
  if (Array.isArray(claims) && claims.some(row => row?.field === key && ['package', 'fallback'].includes(row.source)) && !claimedPackageDimension(text, key, facts, claims)) items.push({ code: 'ai_content_dimension_source_review', message: '尺寸来源说明无法与原始记录完全对应，请人工核对；未将该说明视为已确认事实。' });
  return items;
}
function claimedPackageDimension(text, key, facts, claims) {
  if (!Array.isArray(claims)) return '';
  let data; try { data = JSON.parse(facts); } catch (_) { return ''; }
  const sourceTexts = [];
  const visit = (value, forbidden = false) => {
    if (typeof value === 'string') { if (forbidden) sourceTexts.push(value); }
    else if (value && typeof value === 'object') for (const [name, item] of Object.entries(value)) visit(item, forbidden || PACKAGE_DIMENSION_KEY.test(name) || ['9454', '9455', '9456', '4082'].includes(String(value.id || value.attribute_id || '')) || PACKAGE_DIMENSION_KEY.test(String(value.name || value.label || '')) || value.source === 'fallback' || value.dimensionSource === 'fallback');
  };
  visit(data);
  for (const claim of claims) {
    if (claim?.field !== key || !['package','fallback'].includes(claim.source) || typeof claim.text !== 'string' || !claim.text || claim.text.length > 200 || typeof claim.evidence !== 'string' || claim.evidence.length > 1000) continue;
    if (text.includes(claim.text) && dimensionTokens(claim.text).length && sourceTexts.some(source => source.includes(claim.evidence) && claim.evidence.includes(claim.text))) return '候选明确将原始包装或兜底尺寸用作商品尺寸，已拒绝采用，请使用真实商品尺寸或省略尺寸。';
  }
  return '';
}
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function reviewHash(value) { return require('node:crypto').createHash('sha256').update(stableJson(value)).digest('hex'); }
function attachChecks(result, pairs, facts, rules, diagnosticId, scope = 'pair') {
  const checks = {};
  for (const [key, pair] of Object.entries(pairs)) {
    const warnings = result.warnings?.[key]?.items || [], failure = result.failures?.[key] || null;
    const contentHash = reviewHash(pair), factsHash = reviewHash(facts), rulesHash = reviewHash(rules[key] || {});
    const status = scope === 'translation' ? 'pending' : failure ? 'failed' : warnings.length ? 'warning' : 'passed';
    checks[key] = { scope, status, message: scope === 'translation' ? '仅已核对本次译文，双语内容待复核' : failure ? failure.message : warnings.length ? '内容含待人工核对风险' : '已完成本次规则核对', contentHash, factsHash, rulesHash, validatorVersion: VALIDATOR_VERSION, checkHash: reviewHash({ contentHash, factsHash, rulesHash, validatorVersion: VALIDATOR_VERSION, status }), checkedAt: new Date().toISOString(), diagnosticId, warnings, failure };
  }
  return { checks, reviewSource: { facts } };
}

function responsePairs(content, keys, bilingual = true) {
  let value; try { value = JSON.parse(String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch (_) { value = {}; }
  return Object.fromEntries(keys.map(key => [key, value?.[key] || (bilingual ? { zh: '', ru: '' } : '')]));
}
function reviewReasons(result) {
  return [...Object.entries(result.failures || {}).map(([field, failure]) => ({ field, kind: 'failure', ...failure })), ...Object.entries(result.warnings || {}).flatMap(([field, warning]) => (warning.items || [warning]).map(item => ({ field, kind: 'warning', code: item.code, message: item.message, language: item.language || 'both' })))];
}
function unitWarning(text, facts) {
  const odd = unitTokens(text).filter(token => !unitTokens(facts).includes(token));
  return odd.length ? { code: 'ai_candidate_units_unmatched', message: '单位写法与原始资料不一致，请人工核对。' } : null;
}
function reviewRussian(ru, key, rule, facts, compatibility, dimensionClaims) {
  const result = { candidates: {}, translations: {}, failures: {}, warnings: {} };
  const boundaryFacts = withCompatibility(facts, compatibility);
  const body = String(ru || '').trim();
  const reject = (code, message) => { result.failures[key] = { code, message }; return result; };
  if (!body) return reject('ai_candidate_missing', '俄语内容为空，无法完成本次核对。');
  const boundary = contentBoundaryError(body, key, boundaryFacts, false, rule) || claimedPackageDimension(body, key, facts, dimensionClaims);
  if (boundary) return reject('ai_candidate_content_boundary', boundary);
  const limit = Math.min(ITEMS[key].maxChars, declaredMaxChars(rule.item) || ITEMS[key].maxChars, declaredMaxChars(rule.global) || ITEMS[key].maxChars);
  if (Array.from(body).length > limit) return reject('ai_candidate_too_long', `俄语内容超过${limit}字上限，请缩短后再核对。`);
  if (numbers(body).some(token => !numbers(facts).includes(token))) return reject('ai_candidate_facts_changed', '俄语内容出现原始资料中没有的数字，请核对后调整。');
  const language = languageReview(body, boundaryFacts, key, rule, 'ru');
  if (language.hard) return reject('ai_candidate_language_invalid', '当前正式内容不符合俄语要求，请调整后再核对。');
  const warning = warningBundle([language.warning, unitWarning(body, facts), ...contentWarnings(body, facts, key, rule)].filter(Boolean).map(item => ({ ...item, language: 'ru' })));
  if (warning) result.warnings[key] = warning;
  result.candidates[key] = body;
  return result;
}

async function recheckPairs(pairs, facts, rules, diagnosticIds, restore) {
  const result = { candidates: {}, translations: {}, failures: {}, warnings: {} };
  for (const [key, pair] of Object.entries(pairs)) {
    try {
      let compatibility, dimensionClaims;
      if (diagnosticIds?.[key]) {
        const old = await restore(diagnosticIds[key]);
        const check = old.results?.[key];
        if (check && check.factsHash !== reviewHash(facts) && /compatibility/.test(String(old.rawResponse || ''))) throw fail('ai_content_review_source_changed', '原始资料已变化，旧适配证据不能沿用；请重新生成或提供可核验的原始资料。', 422);
        try { const raw = JSON.parse(String(old.rawResponse || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); compatibility = raw.compatibility; dimensionClaims = raw.dimensionClaims; } catch (_) {}
        if (old.purpose === 'product-content-recheck') { compatibility = old.input?.compatibility?.[key]; dimensionClaims = old.input?.dimensionClaims?.[key]; }
        if (compatibility && (!check || check.factsHash !== reviewHash(facts))) throw fail('ai_content_review_source_changed', '原始资料已变化或旧记录缺少事实摘要，适配证据不能沿用；请重新生成后再核对。', 422);
      }
      const phrases = Object.values(rules[key]?.policy?.compatibilityExpressions || {}).flat();
      if (!compatibility && /[a-z]/i.test(pair.ru) && phrases.some(phrase => phrasePresent(pair.ru, phrase))) throw fail('ai_content_compatibility_review_incomplete', '当前适配品牌型号的原始证据无法完成核对，请重新生成后再核对；已保留当前内容。', 422);
      const checked = reviewRussian(pair.ru, key, rules[key], facts, compatibility, dimensionClaims);
      for (const property of ['candidates', 'translations', 'failures', 'warnings']) Object.assign(result[property], checked[property]);
      if (compatibility) { result.compatibility ||= {}; result.compatibility[key] = compatibility; }
      if (dimensionClaims) { result.dimensionClaims ||= {}; result.dimensionClaims[key] = dimensionClaims; }
    } catch (error) {
      result.failures[key] = { code: error.publicCode || 'ai_content_review_failed', message: error.publicCode ? error.message : '当前内容无法完成规则核对，请稍后重试；已保留当前内容。' };
    }
  }
  return result;
}

function parseCandidates(text, keys, rulesByKey, facts) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(cleaned); } catch (_) { throw fail('ai_response_invalid', 'AI 未返回可解析的候选 JSON', 502); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('ai_response_invalid', 'AI 返回格式无效', 502);
  const boundaryFacts = withCompatibility(facts, value.compatibility);
  const candidates = {};
  const failures = {};
  const warnings = {};
  const factNumbers = numbers(facts);
  const factUnits = unitTokens(facts);
  for (const key of keys) {
    const definition = ITEMS[key];
    const rule = rulesByKey[key] || {};
    const raw = value[key];
    if (typeof raw !== 'string' || !raw.trim()) { failures[key] = { code: 'ai_candidate_missing', message: `${definition.label}：供应商没有返回可用内容` }; continue; }
    const body = raw.trim();
    const boundaryError = contentBoundaryError(body, key, boundaryFacts, false, rule);
    if (boundaryError) { failures[key] = { code: 'ai_candidate_content_boundary', message: `${definition.label}：${boundaryError}` }; continue; }
    const limit = Math.min(definition.maxChars, declaredMaxChars(rule.item) || definition.maxChars, declaredMaxChars(rule.global) || definition.maxChars);
    if (Array.from(body).length > limit) { failures[key] = { code: 'ai_candidate_too_long', message: `${definition.label}：超过 ${limit} 字上限` }; continue; }
    if (numbers(body).some(token => !factNumbers.includes(token))) { failures[key] = { code: 'ai_candidate_facts_changed', message: `${definition.label}：候选出现原始事实中没有的数字，需要人工处理` }; continue; }
    if (key === 'tags' && !validTags(raw)) { failures[key] = { code: 'ai_candidate_tags_invalid', message: '标签：AI返回的主题标签格式不符合要求，请重新生成' }; continue; }
    const oddUnits = unitTokens(body).filter(token => !factUnits.includes(token));
    if (oddUnits.length) warnings[key] = { code: 'ai_candidate_units_unmatched', message: definition.label + '：单位写法与原始事实不一致（' + oddUnits.join('、') + '），已保留内容，请人工核对' };
    const risk = warningBundle([...contentWarnings(body, facts, key, rule), warnings[key]]);
    if (risk) warnings[key] = risk;
    candidates[key] = body;
  }
  if (!Object.keys(candidates).length && !Object.keys(failures).length) throw fail('ai_response_invalid', 'AI 未返回候选内容', 502);
  return { candidates, failures, warnings };
}

const BILINGUAL_FIELD_PROTOCOL = '双语JSON字段输出协议：zh只写中文对照，ru只写俄语正式内容；允许的品牌、型号和材料词仍服从原有事实及语言例外，不能把俄语正文复制进zh。管理员规则要求“每条中文、俄文成对”或“相同序号”时，是同一条事实分别放入zh与ru并使用相同序号，不是在zh或ru任一字段内输出整对。zh不得嵌入“俄文：”行或俄语正文，ru不得嵌入“中文：”行或中文正文。此处仅规定JSON语言分工，不改变管理员指定的内容、条数、顺序或风格。';
function promptForBilingual(rules) {
  const lines = ['你是跨境电商商品资料编辑。只依据用户提供的“商品原始事实”整理商品文案，缺失信息不得猜测或补全。'];
  if (rules.global) lines.push(`全局规则（必须遵守）：${rules.global}`);
  lines.push(policyPrompt(rules));
  for (const item of rules.items) lines.push(`${item.label}规则（必须遵守）：${item.body}`);
  lines.push(RUSSIAN_OUTPUT_PROTOCOL);
  lines.push(BILINGUAL_FIELD_PROTOCOL);
  if (rules.items.some(item => item.key === 'tags')) lines.push('tags.zh必须是各俄语标签对应的中文词语，不能复制俄语标签或俄语词序列；中文对照不要求#。tags.ru仍须遵守正式俄语主题标签格式规则。');
  lines.push('每一项都必须同时输出中文对照和俄语正式版本；两种语言表达的事实、数字、单位、品牌和规格必须完全对应。俄语用于 Ozon 正式字段，中文只用于 ERP 翻译对照。');
  lines.push('只返回一个 JSON 对象，不要代码块、解释或前后缀。内容顶层键只能使用下列键（另可有compatibility证据数组）；每个内容值必须严格为 {"zh":"中文内容","ru":"俄语内容"}：');
  for (const item of rules.items) lines.push(item.key);
  lines.push('只使用原始事实中出现的数字与单位，原始事实没有的数据一律不写。');
  return lines.join('\n');
}
function parseBilingualResponse(text, keys, rulesByKey, facts) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(cleaned); } catch (_) { throw fail('ai_response_invalid', 'AI 未返回可解析的双语候选 JSON', 502); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('ai_response_invalid', 'AI 返回的双语候选格式无效', 502);
  const boundaryFacts = withCompatibility(facts, value.compatibility);
  const candidates = {}, translations = {}, failures = {}, warnings = {};
  const factNumbers = numbers(facts), factUnits = unitTokens(facts);
  for (const key of keys) {
    const definition = ITEMS[key], rule = rulesByKey[key] || {}, pair = value[key];
    if (!pair || typeof pair !== 'object' || Array.isArray(pair) || typeof pair.zh !== 'string' || typeof pair.ru !== 'string' || !pair.zh.trim() || !pair.ru.trim()) {
      failures[key] = { code: 'ai_candidate_missing', message: `${definition.label}：供应商没有返回完整的中俄双语内容` }; continue;
    }
    const zh = pair.zh.trim(), ru = pair.ru.trim();
    const zhReview = languageReview(zh, boundaryFacts, key, rule, 'zh');
    if (zhReview.hard) {
      if (!/\p{Script=Han}/u.test(zh)) failures[key] = { code: 'ai_candidate_chinese_invalid', reasonCode: 'chinese_text_missing', message: `${definition.label}：AI返回的中文对照没有中文内容，请重新生成。` };
      else if (/[а-яё]/i.test(zh)) failures[key] = { code: 'ai_candidate_chinese_invalid', reasonCode: 'chinese_contains_cyrillic', message: `${definition.label}：AI返回的中文对照混入了俄文字符，请重新生成。` };
      else failures[key] = { code: 'ai_candidate_chinese_invalid', reasonCode: 'chinese_unapproved_latin', message: `${definition.label}：AI返回的中文对照含有当前字段未获准的拉丁字母词，请重新生成。` };
      continue;
    }
    const boundaryError = contentBoundaryError(zh, key, boundaryFacts, false, rule) || contentBoundaryError(ru, key, boundaryFacts, false, rule) || claimedPackageDimension(zh + '\n' + ru, key, facts, value.dimensionClaims);
    if (boundaryError) { failures[key] = { code: 'ai_candidate_content_boundary', message: `${definition.label}：${boundaryError}` }; continue; }
    const limit = Math.min(definition.maxChars, declaredMaxChars(rule.item) || definition.maxChars, declaredMaxChars(rule.global) || definition.maxChars);
    if (Array.from(zh).length > limit || Array.from(ru).length > limit) { failures[key] = { code: 'ai_candidate_too_long', message: `${definition.label}：双语候选超过 ${limit} 字上限` }; continue; }
    if (numbers(zh).some(token => !factNumbers.includes(token)) || numbers(ru).some(token => !factNumbers.includes(token))) {
      failures[key] = { code: 'ai_candidate_facts_changed', message: `${definition.label}：双语候选出现原始事实中没有的数字，需要人工处理` }; continue;
    }
    if (numberSet(zh) !== numberSet(ru)) { failures[key] = { code: 'ai_candidate_bilingual_numbers_changed', message: `${definition.label}：中俄双语中的数字不一致，请重新生成` }; continue; }
    if (key === 'tags' && !validTags(pair.ru)) { failures[key] = { code: 'ai_candidate_tags_invalid', message: '标签：AI返回的主题标签格式不符合要求，请重新生成' }; continue; }
    const ruReview = languageReview(ru, boundaryFacts, key, rule, 'ru');
    if (ruReview.hard) { failures[key] = { code: 'ai_candidate_language_invalid', message: `${definition.label}：AI返回的正式内容不符合俄语要求，请重新生成` }; continue; }
    const oddUnits = unitTokens(zh + '\n' + ru).filter(token => !factUnits.includes(token));
    if (oddUnits.length) warnings[key] = { code: 'ai_candidate_units_unmatched', message: definition.label + '：单位写法与原始事实不一致（' + Array.from(new Set(oddUnits)).join('、') + '），请人工核对' };
    const risk = warningBundle([...(zhReview.warning ? [{ ...zhReview.warning, language: 'zh' }] : []), ...(ruReview.warning ? [{ ...ruReview.warning, language: 'ru' }] : []), ...contentWarnings(zh, facts, key, rule, value.dimensionClaims).map(item => ({ ...item, language: 'zh' })), ...contentWarnings(ru, facts, key, rule, value.dimensionClaims).map(item => ({ ...item, language: 'ru' })), ...(warnings[key] ? [{ ...warnings[key], language: 'both' }] : [])]);
    if (risk) warnings[key] = risk;
    candidates[key] = ru;
    translations[key] = { zh, ru };
  }
  if (!Object.keys(candidates).length && !Object.keys(failures).length) throw fail('ai_response_invalid', 'AI 未返回双语候选内容', 502);
  return { candidates, translations, failures, warnings };
}

function parseSellingPointsBilingual(content, rules, facts, review) {
  let modelPair;
  try { modelPair = JSON.parse(String(content).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch (_) { throw fail('ai_selling_points_bilingual_invalid', 'AI未返回可解析的中俄双语卖点，已保留当前内容，请重新提炼。', 422); }
  if (!modelPair || typeof modelPair !== 'object' || Array.isArray(modelPair) || Object.keys(modelPair).some(key => !['sellingPointsBilingual', 'dimensionClaims'].includes(key))) throw fail('ai_selling_points_bilingual_invalid', 'AI未返回完整的中俄双语卖点，已保留当前内容，请重新提炼。', 422);
  const checked = parseBilingualResponse(JSON.stringify({ sellingPoints: modelPair.sellingPointsBilingual, dimensionClaims: modelPair.dimensionClaims }), ['sellingPoints'], { sellingPoints: rules }, facts);
  if (!checked.translations.sellingPoints) throw fail('ai_selling_points_bilingual_invalid', Object.values(checked.failures)[0]?.message || 'AI未返回完整的中俄双语卖点，已保留当前内容，请重新提炼。', 422);
  if (review) Object.assign(review, checked);
  return checked.translations.sellingPoints;
}

function packageFacts(body) {
  const result = {}, axes = ['length', 'width', 'height'];
  if (body.packageDimensionsMm !== undefined) {
    const value = body.packageDimensionsMm;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([axis, number]) => !axes.includes(axis) || !(number === null || number === '' || (typeof number === 'number' && Number.isFinite(number) && number >= 0) || (typeof number === 'string' && number.length <= 40 && /^\d+(?:\.\d+)?$/.test(number.trim()))))) throw fail('invalid_content_package_dimensions', '原始包装尺寸资料格式不正确，请重新打开商品后重试。');
    result['包装尺寸毫米'] = { ...value };
  }
  if (body.packageDimensionSources !== undefined) {
    const value = body.packageDimensionSources;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([axis, source]) => !axes.includes(axis) || !['fallback', 'manual', 'unknown'].includes(source))) throw fail('invalid_content_package_source', '包装尺寸来源标记不正确，请重新打开商品后重试。');
    result.packageDimensionSources = { ...value };
  }
  return result;
}

function translationRequest(body) {
  if (!body || !['title', 'tags', 'summary', 'attribute', 'sellingPoints', 'richTitle', 'richDescription'].includes(body.fieldKey)) throw fail('invalid_translation_field', '请选择有效的翻译字段类型后重试。');
  const identities = body.identityFacts === undefined ? {} : body.identityFacts;
  if (!identities || typeof identities !== 'object' || Array.isArray(identities) || Object.entries(identities).some(([key, value]) => !['brand', 'model', 'size'].includes(key) || typeof value !== 'string' || value.length > 100 || /[\r\n\u0000-\u001f\u007f]/.test(value))) throw fail('invalid_translation_identity', '翻译身份资料只允许填写不超过100字的品牌、型号和尺码。');
  return { fieldKey: body.fieldKey, facts: JSON.stringify(identities), compatibilityEvidence: compatibilitySource(body.compatibilityEvidence) };
}

function parseTranslation(text, input, sourceText, target, rule = {}, review) {
  let parsed;
  try { parsed = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch (_) { parsed = null; }
  const raw = parsed && typeof parsed.text === 'string' ? parsed.text : '';
  const translated = raw.trim();
  if (!translated) throw fail('ai_translation_invalid', 'AI没有返回可用译文，请重试。', 502);
  if (prohibitedClaim(sourceText, rule.globalPolicy)) throw fail('ai_translation_prohibited_claim', '待翻译内容包含管理员策略禁止的宣称，已保留原文，请先人工调整后再翻译。', 422);
  const boundaryFacts = withCompatibility(input.facts, parsed.compatibility, input.compatibilityEvidence);
  for (const row of compatibilityFacts(boundaryFacts)) {
    const relevant = Object.values(row).filter(value => input.fieldKey !== 'attribute' || translated.toLowerCase().includes(value.toLowerCase()));
    if (!relevant.every(value => sourceText.toLowerCase().includes(value.toLowerCase()))) throw fail('ai_translation_compatibility_added', '译文不能新增当前原文没有的适配品牌或型号，已保留原文，请重新翻译。', 422);
  }
  const boundaryError = contentBoundaryError(translated, input.fieldKey, boundaryFacts, true, rule) || claimedPackageDimension(translated, input.fieldKey, input.facts, parsed.dimensionClaims);
  if (boundaryError) throw fail('ai_translation_content_boundary', boundaryError, 422);
  const definition = ITEMS[input.fieldKey];
  const limit = definition ? Math.min(definition.maxChars, declaredMaxChars(rule.item) || definition.maxChars, declaredMaxChars(rule.global) || definition.maxChars) : 20000;
  if (Array.from(translated).length > limit) throw fail('ai_translation_too_long', `翻译结果超过${limit}字上限，已保留原文，请缩短后重新翻译。`, 422);
  if (numberSet(translated) !== numberSet(sourceText)) throw fail('ai_translation_facts_changed', '翻译结果改变了数字信息，系统已拒绝回写。', 422);
  const identifiers = Object.values(JSON.parse(input.facts)).filter(value => typeof value === 'string').concat(compatibilityFacts(boundaryFacts).flatMap(row => Object.values(row)));
  if (input.fieldKey === 'attribute' && translated === sourceText.trim() && identifiers.some(value => value.toLowerCase() === translated.toLowerCase())) return translated;
  const matches = MATERIAL_FIELDS.includes(input.fieldKey) ? materialMatches(boundaryFacts, rule.globalPolicy, undefined, sourceText) : [];
  if (input.fieldKey === 'attribute' && translated === sourceText.trim() && matches.some(row => row.term.toLowerCase() === translated.toLowerCase())) return translated;
  if (target === 'ru') {
    if (input.fieldKey === 'tags' && !validTags(raw)) throw fail('ai_translation_tags_invalid', '翻译结果不符合主题标签格式要求，已保留原文，请重新翻译。', 422);
    if (languageReview(translated, boundaryFacts, input.fieldKey, { ...rule, materialSourceText: sourceText }, 'ru').hard) throw fail('ai_translation_language_invalid', '翻译结果不符合俄语要求，已保留原文，请重新翻译。', 422);
  } else {
    if (languageReview(translated, boundaryFacts, input.fieldKey, { ...rule, materialSourceText: sourceText }, 'zh').hard) throw fail('ai_translation_language_invalid', '翻译结果不符合中文要求，已保留原文，请重新翻译。', 422);
  }
  if (review) { const risk = warningBundle([unitWarning(translated, sourceText), languageReview(translated, boundaryFacts, input.fieldKey, { ...rule, materialSourceText: sourceText }, target).warning, ...contentWarnings(translated, boundaryFacts, input.fieldKey, rule)].filter(Boolean).map(item => ({ ...item, language: target }))); review.warnings = risk ? { [input.fieldKey]: risk } : {}; }
  return translated;
}

function validateFormalCandidate(candidate, fields, rulesByKey, review = {}) {
  review.warnings = {};
  const checked = {};
  const validate = (text, fieldKey, source) => {
    try { const fieldReview = {}; const translated = parseTranslation(JSON.stringify({ text }), { fieldKey, facts: JSON.stringify({ 原始内容: source }) }, source, 'ru', rulesByKey[fieldKey], fieldReview); Object.assign(review.warnings, fieldReview.warnings); return translated; }
    catch (error) {
      if (error.publicCode === 'ai_translation_language_invalid' && /[a-z]/i.test(text)) throw fail('ai_candidate_identity_required', '正式候选含有未明确身份的外文标识，请先设置品牌或型号，并使用单字段翻译入口。', 422);
      throw error;
    }
  };
  for (const [key, value] of Object.entries(candidate)) {
    if (key === 'attributes') {
      checked.attributes = {};
      for (const [name, text] of Object.entries(value)) checked.attributes[name] = validate(text, 'attribute', fields.attributes[name]);
    } else {
      const fieldKey = key === 'description' ? 'summary' : key;
      checked[key] = validate(value, fieldKey, fields[key]);
    }
  }
  return checked;
}

function ruleAuditMetadata(rules) {
  const digest = value => require('node:crypto').createHash('sha256').update(String(value || '')).digest('hex');
  return Object.entries(rules).map(([key, rule]) => ({ key, versions: rule.versions || {}, globalHash: digest(rule.global), itemHash: digest(rule.item), policyHash: digest(JSON.stringify({global: rule.globalPolicy, item: rule.policy})) }));
}

module.exports = { BILINGUAL_FIELD_PROTOCOL, packageFacts, reviewRussian, responsePairs, reviewReasons, recheckPairs, REVIEW_FIELDS, VALIDATOR_VERSION, warningBundle, contentWarnings, attachChecks, reviewHash, cleanDimensionSource, dimensionTokens, dimensionEvidence, parseSellingPointsBilingual, MATERIAL_FIELDS, materialMatches, materialPattern, RUSSIAN_OUTPUT_PROTOCOL, ITEMS, ITEM_KEYS, FACTS_MAX_CHARS, request, policyPrompt, prohibitedClaim, promptFor, promptForBilingual, parseCandidates, parseSections, parseResponse, parseBilingualResponse, translationRequest, parseTranslation, validateFormalCandidate, ruleAuditMetadata, numbers, numberSet, unitTokens, fail };
