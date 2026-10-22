'use strict';

const crypto = require('node:crypto');
const prompts = require('./ai-prompts');
const { sellingPointLines } = require('./sku-image-prompt');

const CYRILLIC = /[\u0400-\u052f]/;
const UNRESOLVED_PLACEHOLDER = /\{\{[^{}]+\}\}|\[[^\]]+\]|选择一种|无则删除/;
const STRICT_NUMBER_UNITS = Object.freeze(['%', 'mm', 'cm', 'm', 'km', '毫米', '厘米', '米', '千米', 'ml', 'l', '毫升', '升', 'mg', 'g', 'kg', '毫克', '克', '千克', '公斤', '秒', '分钟', '小时', '天', '月', '个月', '年', '℃', 'w', 'v', 'hz', 'khz', 'mhz', 'gb', 'tb']);
const NON_UNIT_CLASSIFIERS = Object.freeze(['种', '档', '级', '个', '件', '套', '只', '支', '条', '根', '张', '份', '盒', '包', '瓶', '台', '组']);
const KNOWN_SUFFIXES = Object.freeze([...STRICT_NUMBER_UNITS, ...NON_UNIT_CLASSIFIERS].sort((left, right) => right.length - left.length));
const NUMBER_HEAD = /\d+(?:\.\d+)?/g;
const REQUIRED_FIELDS = Object.freeze(['mainTitle', 'background', 'backgroundColor', 'accentColor', 'displayMode', 'secondaryStyle']);
const OPTIONAL_FIELDS = Object.freeze(['secondaryText', 'icons', 'colorMaterial']);
const FACT_FIELDS = Object.freeze(['mainTitle', 'secondaryText']);
const FIELD_LABELS = Object.freeze({ mainTitle: '主标题', secondaryText: '辅助短句' });
const FIELD_ALIASES = Object.freeze({
  mainTitle: ['主标题', '主文案', '标题文案'], secondaryText: ['辅助短句', '副标题', '辅助文案', '第二条卖点'],
  background: ['背景'], backgroundColor: ['背景色', '背景颜色'], accentColor: ['强调色', '点缀色', '主题色'],
  displayMode: ['展示方式', '展示模式'], secondaryStyle: ['辅助样式', '副标题样式'], icons: ['图标', '图标素材'], colorMaterial: ['颜色材质', '颜色/材质', '色彩材质']
});

function fail(code, message, diagnostic) { return Object.assign(new Error(message), { publicCode: code, status: 409, retryable: false, safeDiagnostic: diagnostic }); }
function normalizedToken(value) { return String(value || '').replace(/\s+/g, '').toLowerCase(); }
function normalizedNumber(value) { return String(Number(String(value || '').replace(/\s+/g, ''))); }
function scanNumberTokens(value) {
  const text = String(value || ''), tokens = [];
  NUMBER_HEAD.lastIndex = 0;
  let match;
  while ((match = NUMBER_HEAD.exec(text))) {
    const number = match[0], afterNumber = text.slice(NUMBER_HEAD.lastIndex);
    const spaces = (afterNumber.match(/^\s*/) || [''])[0], tail = afterNumber.slice(spaces.length), lowerTail = tail.toLowerCase();
    let suffix = KNOWN_SUFFIXES.find(item => lowerTail.startsWith(item) && (!/^[a-z]+$/.test(item) || !/[a-z]/i.test(tail[item.length] || '')));
    let kind = suffix ? (STRICT_NUMBER_UNITS.includes(normalizedToken(suffix)) ? 'unit' : 'classifier') : 'bare';
    if (!suffix) {
      const unlisted = tail.match(/^(?:[a-z%℃]+|[\u4e00-\u9fff]{1,8})/i);
      if (unlisted) { suffix = unlisted[0]; kind = 'unlisted'; }
    }
    const raw = number + (suffix ? spaces + suffix : '');
    tokens.push({ raw, normalized: normalizedToken(raw), number: normalizedNumber(number), suffix: normalizedToken(suffix), kind });
    NUMBER_HEAD.lastIndex += spaces.length + (suffix ? suffix.length : 0);
  }
  return tokens;
}
function numberTokens(value) { return new Set(scanNumberTokens(value).map(item => item.normalized)); }
function slotPattern(aliases) { return new RegExp('[【\\[](?:' + aliases.join('|') + ')[】\\]]', 'g'); }
function responseSummary(raw, value) {
  const text = String(raw || '');
  return {
    sha256: crypto.createHash('sha256').update(text).digest('hex'), chars: text.length,
    jsonFields: value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value).map(([name, item]) => ({ name, type: Array.isArray(item) ? 'array' : item === null ? 'null' : typeof item })) : []
  };
}
function validateFactNumbers(decision, sellingPoints, diagnostic) {
  const sourceTokens = scanNumberTokens(sellingPointLines(sellingPoints).join('\n'));
  const sourceNumbers = new Set(sourceTokens.map(item => item.number));
  const sourceUnits = new Set(sourceTokens.filter(item => item.kind === 'unit').map(item => `${item.number}:${item.suffix}`));
  diagnostic.unitDecisions = [];
  for (const field of FACT_FIELDS) {
    const tokens = scanNumberTokens(decision[field]);
    for (const token of tokens) {
      const hasNumber = sourceNumbers.has(token.number), hasUnit = token.kind !== 'unit' || sourceUnits.has(`${token.number}:${token.suffix}`);
      const action = !hasNumber ? 'rejected_number_changed'
        : !hasUnit ? 'rejected_unit_changed'
          : token.kind === 'unit' ? 'validated_strict_unit'
            : token.kind === 'bare' ? 'validated_number' : 'passed_unlisted_unit';
      const reason = !hasNumber ? 'number_value_not_in_confirmed_selling_points'
        : !hasUnit ? 'strict_unit_not_in_confirmed_selling_points'
          : token.kind === 'unit' ? 'number_and_strict_unit_match'
            : token.kind === 'bare' ? 'number_value_match' : 'suffix_not_in_strict_unit_list';
      diagnostic.unitDecisions.push({ field, modelToken: token.normalized, numberValue: token.number, strictUnit: token.kind === 'unit', action, reason });
    }
    diagnostic.fieldNumbers[field] = tokens.map(item => item.normalized);
    const invalid = tokens.find(token => !sourceNumbers.has(token.number) || token.kind === 'unit' && !sourceUnits.has(`${token.number}:${token.suffix}`));
    if (invalid) {
      diagnostic.validation = { stage: 'visible_fact_numbers', field, invalidNumber: invalid.normalized };
      throw fail('sku_image_prompt_number_changed', `${FIELD_LABELS[field]}新增或改变了未确认数字/单位 ${invalid.normalized}；图片模型未调用`, diagnostic);
    }
  }
}

function parseDecision(raw, sellingPoints) {
  let value;
  try { value = JSON.parse(String(raw || '')); } catch (_) { throw fail('sku_image_prompt_response_invalid', '文字模型没有返回受限结构JSON；图片模型未调用', { response: responseSummary(raw), fieldNumbers: {}, validation: { stage: 'json_parse' } }); }
  const diagnostic = { response: responseSummary(raw, value), fieldNumbers: {}, validation: { stage: 'structure' } };
  if (!value || Array.isArray(value) || typeof value !== 'object') throw fail('sku_image_prompt_response_invalid', '文字模型返回字段不符合图片提示词结构契约；图片模型未调用', diagnostic);
  const allowed = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]), keys = Object.keys(value);
  if (keys.some(key => !allowed.has(key)) || REQUIRED_FIELDS.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw fail('sku_image_prompt_response_invalid', '文字模型返回了不允许或缺少的图片提示词字段；图片模型未调用', diagnostic);
  const decision = {};
  for (const key of [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) { decision[key] = ''; continue; }
    if (typeof value[key] !== 'string') throw fail('sku_image_prompt_response_invalid', '文字模型图片提示词字段必须为文本；图片模型未调用', diagnostic);
    decision[key] = value[key].trim();
    diagnostic.fieldNumbers[key] = [...numberTokens(decision[key])];
    if (decision[key].length > 300 || (REQUIRED_FIELDS.includes(key) && !decision[key])) throw fail('sku_image_prompt_response_invalid', '文字模型图片提示词字段长度或必填值无效；图片模型未调用', diagnostic);
  }
  const responseText = Object.values(decision).join('\n');
  if (CYRILLIC.test(responseText)) throw fail('sku_image_prompt_not_chinese', '文字模型返回的图片提示词字段含有俄文；图片模型未调用', diagnostic);
  if (UNRESOLVED_PLACEHOLDER.test(responseText)) throw fail('sku_image_prompt_placeholder_unresolved', '文字模型返回的图片提示词字段含有占位符；图片模型未调用', diagnostic);
  validateFactNumbers(decision, sellingPoints, diagnostic);
  diagnostic.validation = { stage: 'structured_fields_passed' };
  return { decision, diagnostic };
}

function renderDecision(templateBody, sellingPoints, decision) {
  const points = sellingPointLines(sellingPoints);
  let prompt = prompts.render(templateBody, { title: decision.mainTitle, description: decision.secondaryText, sellingPoints: points.join('\n'), attributes: '', prompt: points.join('\n') });
  prompt = prompt.split(/\r?\n/).filter(line => !/选择一种|无则删除/.test(line) && !OPTIONAL_FIELDS.some(key => !decision[key] && slotPattern(FIELD_ALIASES[key]).test(line))).join('\n');
  for (const [key, aliases] of Object.entries(FIELD_ALIASES)) prompt = prompt.replace(slotPattern(aliases), decision[key] || '');
  prompt = prompt.split(/\r?\n/).filter(line => !UNRESOLVED_PLACEHOLDER.test(line)).join('\n').trim();
  prompt += '\n\n' + ['【系统最终文案门禁（优先级最高）】', '本图唯一允许的画面文案如下：', `主标题：${decision.mainTitle}`, decision.secondaryText ? `辅助短句：${decision.secondaryText}` : '', '画面文案只能使用上述简体中文，不得补充、改写或翻译为其它语言。', '禁止所有西里尔字母、俄文及中俄双语；仅商品实体真实印刷的品牌、型号或必要技术标识（如 ABS、USB Type-C）可保留。', '参考图只用于商品外观参考，不继承其广告标题、卖点、背景文字或排版；商品资料中的原始标题、描述和属性不得作为画面文案来源。'].filter(Boolean).join('\n');
  return validateFinalPrompt(prompt);
}

function prepareInput(templateBody, sellingPoints) {
  return {
    system: ['你是网研ERP的图片提示词字段整理器。只返回一个JSON对象，不得输出解释、Markdown或JSON外壳文字。', 'JSON只允许以下字段：mainTitle、secondaryText、background、backgroundColor、accentColor、displayMode、secondaryStyle、icons、colorMaterial。除secondaryText、icons、colorMaterial可省略外，其余字段必须是非空字符串。', '只能从已确认中文卖点和官方模板要求中选择、组织字段；mainTitle和secondaryText不得新增、换算或改变商品数字及原单位。背景、颜色、比例、版式和图标可按模板要求使用合法设计参数。', '禁止占位符、任何西里尔字母、俄文和中俄双语。源图仅作商品外观参考，不得引用其广告文字、原始商品标题、描述或属性。'].join('\n'),
    input: { confirmedSellingPoints: sellingPointLines(sellingPoints), templateRequirements: String(templateBody || '').trim() }
  };
}

function validateFinalPrompt(promptValue) {
  const prompt = String(promptValue || '').trim();
  if (!prompt || prompt.length > 8000) throw fail('sku_image_prompt_response_invalid', '最终图片提示词长度无效；图片模型未调用');
  if (UNRESOLVED_PLACEHOLDER.test(prompt)) throw fail('sku_image_prompt_placeholder_unresolved', '最终图片提示词仍含占位符；图片模型未调用');
  if (CYRILLIC.test(prompt)) throw fail('sku_image_prompt_not_chinese', '最终图片提示词含有俄文；图片模型未调用');
  return prompt;
}

function parseResponseDetailed(raw, templateBody, sellingPoints) {
  const parsed = parseDecision(raw, sellingPoints);
  const prompt = renderDecision(templateBody, sellingPoints, parsed.decision);
  parsed.diagnostic.validation = { stage: 'rendered_prompt_passed' };
  parsed.diagnostic.rendered = { sha256: crypto.createHash('sha256').update(prompt).digest('hex'), chars: prompt.length };
  return { prompt, diagnostic: parsed.diagnostic };
}
function parseResponse(raw, templateBody, sellingPoints) { return parseResponseDetailed(raw, templateBody, sellingPoints).prompt; }

module.exports = { prepareInput, parseResponse, parseResponseDetailed, validateFinalPrompt, numberTokens, STRICT_NUMBER_UNITS, NON_UNIT_CLASSIFIERS };
