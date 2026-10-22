'use strict';

const crypto = require('node:crypto');
const VARIABLES = Object.freeze(['title', 'text', 'description', 'sellingPoints', 'attributes', 'sourceLanguage', 'targetLanguage', 'prompt']);
const OFFICIAL = Object.freeze([
  { key: 'image-main', version: 1, name: '主图提示词', functionKey: 'image-main', body: '待系统管理员或租户填写。' },
  { key: 'image-scene', version: 1, name: '场景图提示词', functionKey: 'image-scene', body: '待系统管理员或租户填写。' },
  { key: 'image-selling', version: 1, name: '卖点图提示词', functionKey: 'image-selling', body: '待系统管理员或租户填写。' },
  { key: 'image-accessory', version: 1, name: '配件赠品图提示词', functionKey: 'image-accessory', body: '待系统管理员或租户填写。' },
  { key: 'image-white-base', version: 1, name: '白底图提示词', functionKey: 'image-white-base', body: '保留商品主体、颜色、结构与比例不变，背景替换为干净纯白，光线均匀柔和，阴影自然轻微，无杂物、无文字、无水印。' },
  { key: 'image-size', version: 1, name: '尺寸图提示词', functionKey: 'image-size', body: '待系统管理员或租户填写。' },  { key: 'product-zh-ru', version: 1, name: '商品中文转俄文', functionKey: 'product-zh-ru', body: '将{{title}}及提供的商品字段从中文准确翻译为俄文。保留数字、单位、品牌和规格，只返回请求字段。' },
  { key: 'product-en-ru', version: 1, name: '商品英文转俄文', functionKey: 'product-en-ru', body: '将{{title}}及提供的商品字段从英文准确翻译为俄文。保留数字、单位、品牌和规格，只返回请求字段。' },
  { key: 'product-ru-zh', version: 1, name: '商品俄文转中文', functionKey: 'product-ru-zh', body: '将{{text}}从俄文准确翻译为中文。保留数字、单位、品牌和规格，不添加原文没有的信息。' },
  { key: 'product-copy', version: 1, name: '商品文字优化', functionKey: 'product-copy', body: '优化{{title}}和{{description}}，保持事实准确，不虚构认证、功效或规格。只返回请求字段。' },
  { key: 'selling-points', version: 1, name: '卖点生成', functionKey: 'selling-points', body: '依据{{title}}、{{description}}和{{attributes}}生成简洁卖点，不添加输入中不存在的事实。' },
  { key: 'image-translation', version: 1, name: '图片翻译', functionKey: 'image-translation', body: '把图片文字从{{sourceLanguage}}翻译为{{targetLanguage}}，保持原布局、品牌、数字和单位。' },
  { key: 'image-redraw', version: 1, name: 'AI重绘与场景生成', functionKey: 'image-redraw', body: '按{{prompt}}重绘商品背景与场景，保持商品主体、比例、颜色和可见细节准确。' },
  { key: 'image-repair', version: 1, name: '图片局部修复', functionKey: 'image-repair', body: '仅修复蒙版区域并遵循{{prompt}}，蒙版外内容保持不变。' },
  { key: 'ocr-image-text', version: 1, name: 'OCR图片文字识别', functionKey: 'ocr-image-text', body: '识别图片中的可见文字与结构，保持原文，不猜测模糊内容，不输出隐私或凭据。' }
]);
const FUNCTIONS = Object.freeze(OFFICIAL.map(item => item.functionKey));
function fail(code, text, status = 400) { return Object.assign(new Error(text || '服务端未给出中文提示，请按页面提示重试；仍未成功请联系管理员。'), { publicCode: code, status }); }
function validateBody(value) {
  const body = String(value || '').trim();
  if (!body || body.length > 12000) throw fail('ai_prompt_body_invalid', '提示词内容不能为空，且长度不能超过12000字，请精简后再保存。');
  const matches = body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g);
  for (const match of matches) if (!VARIABLES.includes(match[1])) throw fail('ai_prompt_variable_unknown', '提示词里使用了不支持的变量，请只保留系统提供的变量占位符。');
  if (/api[_ -]?key|authorization\s*:|bearer\s+\{\{/i.test(body)) throw fail('ai_prompt_sensitive_instruction_denied', '提示词内容不得包含密钥、授权头等凭证信息，请删除后再保存。');
  return body;
}
function normalize(input, existing) {
  const functionKey = String(input.functionKey || existing?.function_key || '');
  if (!FUNCTIONS.includes(functionKey)) throw fail('ai_prompt_function_invalid', '该功能编号不受支持，请刷新页面后重新选择功能。');
  const name = String(input.name || '').trim();
  if (!name || name.length > 120) throw fail('ai_prompt_name_invalid', '提示词名称不能为空，且长度不能超过120字，请修改后再保存。');
  const official = OFFICIAL.find(item => item.key === String(input.officialKey || existing?.official_key || functionKey));
  if (!official) throw fail('ai_prompt_official_not_found', '该官方提示词不存在或已下线，请另选一个提示词。', 404);
  return { id: existing?.id || crypto.randomUUID(), name, functionKey, body: validateBody(input.body), enabled: input.enabled !== false, officialKey: official.key, officialVersion: Number(existing?.official_version || official.version) };
}
function render(body, values = {}) { return validateBody(body).replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name) => String(values[name] ?? '')); }
module.exports = { OFFICIAL, FUNCTIONS, VARIABLES, validateBody, normalize, render, fail };
