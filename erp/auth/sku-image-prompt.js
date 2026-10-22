'use strict';

const prompts = require('./ai-prompts');

const CYRILLIC = /[\u0400-\u052f]/;
const UNRESOLVED_PLACEHOLDER = /\{\{[^{}]+\}\}|\[[^\]]+\]|选择一种|无则删除/;

function fail(code, message) {
  return Object.assign(new Error(message), { publicCode: code, status: 409, retryable: false });
}

function sellingPointLines(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:[•*\-]|\d+[.、])\s*/, '').trim())
    .filter(Boolean);
  if (!lines.length) throw fail('sku_image_selling_points_required', '没有可用于图片文案的中文卖点，系统不会调用图片模型');
  if (CYRILLIC.test(lines.join('\n'))) throw fail('sku_image_selling_points_not_chinese', '图片卖点含有俄文，系统不会调用图片模型');
  return lines;
}

function finalTextBlock(primary, secondary) {
  return [
    '【全部画面文案（系统已确定）】',
    `主标题：${primary}`,
    secondary ? `辅助短句：${secondary}` : ''
  ].filter(Boolean).join('\n');
}

function replaceTextSlots(value, primary, secondary) {
  const text = finalTextBlock(primary, secondary);
  return value
    .replace(/[【\[](?:全部画面文案|画面文案|最终文案)[】\]]/g, text)
    .replace(/[【\[](?:主标题|主文案|标题文案)[】\]]/g, primary)
    .replace(/[【\[](?:辅助短句|副标题|辅助文案|第二条卖点)[】\]]/g, secondary)
    .replace(/^.*(?:选择一种|无则删除).*$(?:\r?\n)?/gmi, '');
}

function build(templateBody, sellingPoints) {
  const lines = sellingPointLines(sellingPoints);
  const primary = lines[0];
  const secondary = lines[1] || '';
  let prompt = prompts.render(templateBody, {
    title: primary,
    description: secondary,
    sellingPoints: lines.join('\n'),
    attributes: '',
    prompt: lines.join('\n')
  });
  prompt = replaceTextSlots(prompt, primary, secondary).trim();
  if (UNRESOLVED_PLACEHOLDER.test(prompt)) throw fail('sku_image_prompt_placeholder_unresolved', '官方图片模板仍有未替换占位符，系统不会调用图片模型');
  prompt += '\n\n' + [
    '【系统最终文案门禁（优先级最高）】',
    '本图唯一允许的画面文案如下：',
    `主标题：${primary}`,
    secondary ? `辅助短句：${secondary}` : '',
    '画面文案只能使用上述简体中文，不得补充、改写或翻译为其它语言。',
    '禁止所有西里尔字母、俄文及中俄双语；仅商品实体真实印刷的品牌、型号或必要技术标识（如 ABS、USB Type-C）可保留。',
    '参考图只用于商品外观参考，不继承其广告标题、卖点、背景文字或排版；商品资料中的原始标题、描述和属性不得作为画面文案来源。'
  ].filter(Boolean).join('\n');
  if (CYRILLIC.test(prompt)) throw fail('sku_image_prompt_not_chinese', '最终图片提示词含有俄文，系统不会调用图片模型');
  if (prompt.length > 8000) throw fail('sku_image_prompt_too_long', '最终图片提示词超过长度限制，系统不会调用图片模型');
  return { prompt, primary, secondary };
}

module.exports = { build, sellingPointLines, finalTextBlock };
