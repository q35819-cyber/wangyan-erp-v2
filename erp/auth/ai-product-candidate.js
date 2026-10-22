'use strict';

const { BILINGUAL_FIELD_PROTOCOL } = require('./ai-product-content');

const ALLOWED_MODES = new Set(['translate', 'translate-optimize', 'optimize-ru']);
const ALLOWED_FIELDS = new Set(['title', 'description', 'sellingPoints', 'attributes']);
const FIELD_LIMITS = Object.freeze({ title: 500, description: 20000, sellingPoints: 5000, attributes: 10000 });
const FIELD_CAPABILITIES = Object.freeze({ title: 'title-optimization', description: 'description-optimization', sellingPoints: 'selling-point-generation', attributes: 'attribute-text-optimization' });
function fail(code, message, status = 400) { return Object.assign(new Error(message), { publicCode: code, status }); }
function request(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid_ai_product_request', '商品优化请求格式不正确');
  const mode = String(input.mode || '');
  if (!ALLOWED_MODES.has(mode)) throw fail('invalid_ai_product_mode', '不支持的商品优化方式');
  const fields = input.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => !ALLOWED_FIELDS.has(key))) throw fail('invalid_ai_product_fields', '只允许优化标题、描述和卖点');
  const clean = {};
  for (const [field, value] of Object.entries(fields)) {
    if (field === 'attributes') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw fail('invalid_ai_product_content', '属性文字格式不正确');
      const attributes = {};
      for (const [name, text] of Object.entries(value)) {
        const key = String(name).trim(), content = String(text == null ? '' : text).trim();
        if (!key || key.length > 160 || !content || content.length > 2000) throw fail('invalid_ai_product_content', '属性文字为空或超过长度限制');
        attributes[key] = content;
      }
      if (JSON.stringify(attributes).length > FIELD_LIMITS.attributes) throw fail('invalid_ai_product_content', '属性文字超过长度限制');
      clean.attributes = attributes;
    } else {
      const text = String(value == null ? '' : value).trim();
      if (text) clean[field] = text;
    }
  }
  if (!Object.keys(clean).length || Object.entries(clean).some(([key, value]) => key !== 'attributes' && value.length > FIELD_LIMITS[key])) throw fail('invalid_ai_product_content', '商品文案为空或超过字段长度限制');
  const configurationId = String(input.configurationId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(configurationId)) throw fail('invalid_ai_configuration_id', '请选择有效的 AI 配置');
  const requiredCapabilities = mode === 'translate'
    ? ['product-translation']
    : Array.from(new Set([...(mode === 'translate-optimize' ? ['product-translation'] : []), ...Object.keys(clean).map(field => FIELD_CAPABILITIES[field])]));
  return { mode, fields: clean, configurationId, requiredCapabilities };
}
function prompt(input) {
  const task = input.mode === 'translate' ? '翻译为俄文' : input.mode === 'translate-optimize' ? '翻译为俄文后优化 Ozon 商品文案' : '优化俄文商品文案';
  return `仅处理用户提供的字段：${task}。不得编造或修改品牌、型号、认证、产地、材质、尺寸、数量、库存、价格、促销；保留全部数字和单位；不得使用“第一、最好、官方”等无法证明的宣传。资料不足时明确说明需要人工补充。仅返回 JSON 对象，键只能是输入中出现的 title、description、sellingPoints、attributes；前三项值必须为字符串，attributes必须保留原属性键且值为字符串。`;
}
function sellingPointsPrompt() {
  return '只提炼用户提供的卖点文字。输入可能为俄文或混合语言，必须先准确翻译为简体中文，再提炼中文卖点；最终卖点正文必须纯中文，输出前必须自检并重写，任何可翻译的俄文或外文描述都不得保留，正文不得出现任何西里尔字母（Unicode Cyrillic），禁止“俄文（中文）”双语格式。只有数字、原单位和无法翻译的必要技术标识或型号可保留，例如 ABS、USB Type-C、350 ml；不得把这些视为可保留的外文描述。不得编造或修改品牌、型号、认证、产地、材质、尺寸、数量、库存、价格、促销；不得把“出泡”改成“出液”，不得把原俄文替换为另一个俄文近义词。所有数字只能来自原始资料，引用某个数值时必须保持其原单位，不得换算、改写或替换为另一单位；可以省略非核心数字，但不得新增或修改数字。不得使用“第一、最好、官方”等无法证明的宣传。资料不足时明确说明需要人工补充。只返回 JSON 对象 {"sellingPoints":"卖点正文"}；卖点正文不得包含商品名称、SKU、店铺、原始描述标签、解释或 JSON 外壳，不得返回任何其他字段、包裹对象或图片生成内容。' + '\n' + BILINGUAL_FIELD_PROTOCOL + '\n本接口仅生成中文卖点核对稿，输出结构仍只包含 sellingPoints 字符串；正式双语字段在后续生成阶段按上述协议分别写入 zh 和 ru，不能混写或直接复制俄语进中文字段。';
}
function facts(value) { return String(value).match(/\d+(?:[.,]\d+)?\s*(?:mm|cm|m|ml|l|g|kg|毫米|厘米|米|毫升|升|克|千克|%|₽|руб|元)?/gi)?.map(item => item.replace(/\s+/g, '').toLowerCase()).sort() || []; }
function validateResponse(value, input) {
  let candidate;
  try { candidate = typeof value === 'string' ? JSON.parse(value) : value; } catch (_) { throw fail('ai_response_invalid', 'AI 未返回可用候选 JSON', 502); }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw fail('ai_response_invalid', 'AI 返回格式无效', 502);
  const keys = Object.keys(candidate);
  if (!keys.length || keys.some(field => !Object.hasOwn(input.fields, field) || !ALLOWED_FIELDS.has(field))) throw fail('ai_response_invalid', 'AI 返回了不允许的字段', 502);
  for (const key of keys) {
    if (key === 'attributes') {
      if (!candidate.attributes || typeof candidate.attributes !== 'object' || Array.isArray(candidate.attributes) || Object.keys(candidate.attributes).length !== Object.keys(input.fields.attributes).length || Object.keys(candidate.attributes).some(name => !Object.hasOwn(input.fields.attributes, name) || typeof candidate.attributes[name] !== 'string')) throw fail('ai_response_invalid', 'AI 返回了不允许的属性字段', 502);
      for (const name of Object.keys(candidate.attributes)) {
        const text = candidate.attributes[name].trim();
        if (!text || text.length > 2000 || facts(input.fields.attributes[name]).join('|') !== facts(text).join('|')) throw fail('ai_candidate_facts_changed', 'AI 候选改变了数字或单位，需要人工处理', 422);
        candidate.attributes[name] = text;
      }
      continue;
    }
    if (typeof candidate[key] !== 'string') throw fail('ai_response_invalid', 'AI 返回了不允许的字段', 502);
    const text = candidate[key].trim();
    if (!text || text.length > FIELD_LIMITS[key] || facts(input.fields[key]).join('|') !== facts(text).join('|')) throw fail('ai_candidate_facts_changed', 'AI 候选改变了数字或单位，需要人工处理', 422);
    candidate[key] = text;
  }
  return candidate;
}

function unwrapSellingPoints(value) {
  const text = typeof value === 'string' ? value.trim().replace(/^```(?:json|text|plaintext)?\s*/i, '').replace(/\s*```$/, '').trim() : value;
  if (typeof text !== 'string') return text;
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { throw fail('ai_response_invalid', 'AI 未返回可用卖点 JSON', 502); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('ai_response_invalid', 'AI 返回的卖点格式无效', 502);
  if (Object.keys(parsed).length === 1 && typeof parsed.sellingPoints === 'string') return parsed;
  const wrapper = Object.keys(parsed).length === 1 && ['result', 'data', 'candidate', 'output'].includes(Object.keys(parsed)[0]) ? parsed[Object.keys(parsed)[0]] : null;
  if (wrapper && typeof wrapper === 'object' && !Array.isArray(wrapper) && Object.keys(wrapper).length === 1 && typeof wrapper.sellingPoints === 'string') return wrapper;
  if (Object.keys(parsed).some(key => ['image', 'images', 'prompt', 'prompts'].includes(key))) throw fail('ai_response_invalid', 'AI 返回了图片生成字段，卖点解析已拒绝该响应', 502);
  throw fail('ai_response_invalid', 'AI 返回的卖点 JSON 只能包含 sellingPoints，或 result/data/candidate/output 中唯一的 sellingPoints', 502);
}

function validateSellingPointsResponse(value, input) {
  if (!input || Object.keys(input.fields || {}).length !== 1 || typeof input.fields.sellingPoints !== 'string') throw fail('invalid_ai_product_fields', '卖点解析只接受 sellingPoints 输入');
  const candidate = unwrapSellingPoints(value);
  const sellingPoints = candidate && candidate.sellingPoints;
  if (typeof sellingPoints !== 'string' || !sellingPoints.trim()) throw fail('ai_response_invalid', 'AI 返回的 sellingPoints 正文为空', 502);
  if (/(?:^|\n)\s*(?:商品名称?|SKU|店铺|原始(?:商品)?描述|描述|说明|解释|JSON|title|description|shop|store)\s*[:：]/i.test(sellingPoints)) throw fail('ai_response_invalid', 'AI 返回包含商品元数据或解释标签，卖点解析已拒绝该响应', 502);
  return { sellingPoints };
}

module.exports = { request, prompt, sellingPointsPrompt, validateResponse, validateSellingPointsResponse, fail, ALLOWED_MODES, ALLOWED_FIELDS, FIELD_CAPABILITIES };
