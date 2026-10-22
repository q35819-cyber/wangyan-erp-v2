'use strict';

const CYRILLIC = /[Ѐ-ԯ]/;
const HAN = /[㐀-鿿]/;
const LABELED_LINE = /^\s*(?:(\d{1,3})\s*[.、)）]\s*)?(中文(?:核对版)?|俄(?:文|语)(?:正式版)?|zh(?:-cn)?|ru(?:-ru)?)\s*[:：]\s*(.+?)\s*$/i;

function fail(code, message) {
  throw Object.assign(new Error(message), { publicCode: code, status: 400, retryable: false });
}

function normalizeLanguage(value) {
  const language = String(value || 'ru').trim().toLowerCase();
  if (language === 'ru' || language === 'ru-ru') return 'ru';
  if (language === 'zh' || language === 'zh-cn') return 'zh';
  fail('invalid_sku_image_text_language', '图片文案语言只支持俄语或中文，请重新选择。');
}

function labelLanguage(value) {
  const label = String(value || '').toLowerCase();
  return /^(?:俄文|俄语|ru)/i.test(label) ? 'ru' : 'zh';
}

function parse(value) {
  const lines = String(value || '').split(/\r?\n/);
  const result = { labeled: false, zh: [], ru: [] };
  let currentOrder = 0;
  let previousLanguage = '';
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(LABELED_LINE);
    if (!match) continue;
    result.labeled = true;
    const language = labelLanguage(match[2]);
    const explicitOrder = match[1] ? Number(match[1]) : 0;
    if (explicitOrder) currentOrder = explicitOrder;
    else if (!currentOrder || language === 'zh' && previousLanguage !== 'zh') currentOrder += 1;
    const text = String(match[3] || '').trim();
    if (text) result[language].push({ order: currentOrder || result[language].length + 1, text });
    previousLanguage = language;
  }
  return result;
}

function select(value, requestedLanguage) {
  const text = String(value || '').trim();
  if (!text) fail('invalid_sku_image_selling_points', '请先填写或解析卖点后再开始生图。');
  const language = normalizeLanguage(requestedLanguage);
  const parsed = parse(text);
  if (parsed.labeled) {
    const entries = parsed[language];
    if (!entries.length) {
      fail(
        'sku_image_text_language_missing',
        language === 'ru'
          ? '当前卖点没有俄文正式版，请重新解析卖点，或把“图片文案”切换为中文。'
          : '当前卖点没有中文核对版，请重新解析卖点，或把“图片文案”切换为俄语。'
      );
    }
    return {
      language,
      labeled: true,
      text: entries.map((entry, index) => (entry.order || index + 1) + '. ' + entry.text).join('\n')
    };
  }
  // 兼容用户手工粘贴的单语卖点：只有内容确实包含所选语言文字时才直接采用。
  if (language === 'ru' && CYRILLIC.test(text)) return { language, labeled: false, text };
  if (language === 'zh' && HAN.test(text)) return { language, labeled: false, text };
  fail(
    'sku_image_text_language_missing',
    language === 'ru'
      ? '当前手工卖点中没有可识别的俄文内容，请补充俄文，或把“图片文案”切换为中文。'
      : '当前手工卖点中没有可识别的中文内容，请补充中文，或把“图片文案”切换为俄语。'
  );
}

module.exports = { select, parse, normalizeLanguage, CYRILLIC, HAN };
