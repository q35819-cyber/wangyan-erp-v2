'use strict';

const path = require('path');
const LABELS_MODULE = require.resolve('../assets/product-option-labels');
let labelsModule = require(LABELS_MODULE), labelsMtimeMs = 0;
function currentLabels() {
  try {
    const mtime = require('fs').statSync(LABELS_MODULE).mtimeMs;
    if (mtime !== labelsMtimeMs) { delete require.cache[LABELS_MODULE]; labelsModule = require(LABELS_MODULE); labelsMtimeMs = mtime; }
  } catch (_) {}
  return labelsModule;
}
function mappedTranslation(value) { return currentLabels().lookup(value, 'zh'); }
const { persistTermTranslation, getTranslationAiConfig } = require('./order-mapping-updater');
const { createAiConfigStore } = require('./ai-config-store');
const { chat } = require('./ai-provider');

/**
 * 检测术语是否未映射（返回true表示未映射）
 */
function isUnmappedTerm(value) {
  if (!value || typeof value !== 'string') return false;
  
  const trimmed = value.trim();
  if (!trimmed) return false;
  
  // 排除颜色属性（由product-color-labels处理）
  const colors = require('../assets/product-color-labels');
  if (colors && colors.isColor({ attribute_id: '85' })) return false;
  
  // 排除品牌属性
  if (isBrand(trimmed)) return false;
  
  // 排除尺码格式（如XS, S, M, L, XL, XXL等）
  if (/^(?:[2-9]?[XSML]{1,4}|OS|EU|US|UK|RU|CN)$/i.test(trimmed)) return false;
  
  // 排除纯数字
  if (/^\d+$/.test(trimmed)) return false;
  
  // 调用lookup检查是否已映射
  const translated = mappedTranslation(trimmed);
  return !translated; // 返回空字符串表示未映射
}

/**
 * 判断是否为品牌术语
 */
function isBrand(value) {
  const brands = [
    'nike', 'adidas', 'puma', 'reebok', 'new balance', 'skechers',
    'xiaomi', 'huawei', 'samsung', 'sony', 'lenovo', 'asus',
    'найк', 'адидас', 'пума', 'рибок', 'нью баланс', 'скетчерс',
    'сяоми', 'хуавей', 'самсунг', 'сони', 'леново', 'асус',
    '耐克', '阿迪达斯', '彪马', '锐步', '新百伦', '斯凯奇',
    '小米', '华为', '三星', '索尼', '联想', '华硕'
  ];
  const normalized = String(value).toLowerCase().trim();
  return brands.some(brand => brand.toLowerCase() === normalized);
}

/**
 * 构建AI翻译提示词（针对产品术语）
 */
function buildTranslationPrompt(unmappedTerms) {
  const termsList = unmappedTerms.map((term, index) => {
    return `${index + 1}. "${term}"`;
  }).join('\n  ');

  return `你是一个专业的俄语/英语到中文翻译助手，专门负责电商平台Ozon产品属性术语的翻译。

请将以下未映射的产品术语翻译成简体中文。要求：
1. 使用电商行业标准译名，保持专业术语准确性
2. 翻译要简洁明了，适合在ERP商品属性页面显示
3. 如果术语已经是中文，直接返回原文
4. 对于材质、颜色、风格、产地等常见属性，使用标准译名
5. 保留品牌名称的通用中文译法（如Nike→耐克）

待翻译的术语列表：
${termsList}

请以JSON格式返回，格式如下：
{
  "translations": [
    {
      "rawTerm": "<原始俄文/英文术语>",
      "chinese": "<中文翻译>"
    }
  ]
}

注意：
- 只返回JSON，不要包含其他说明文字
- rawTerm必须与输入的原始术语完全一致
- chinese必须是有效的中文翻译，不能为空
- 保持术语的业务含义准确`;
}

/**
 * 解析AI返回的翻译结果
 */
function parseAiResponse(content, requestedTerms) {
  try {
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    
    if (!parsed.translations || !Array.isArray(parsed.translations)) {
      throw new Error('AI返回格式无效：缺少translations数组');
    }
    
    if (requestedTerms) {
      const allowed = new Set(requestedTerms), seen = new Set();
      for (const item of parsed.translations) {
        if (!item || typeof item.rawTerm !== 'string' || !allowed.has(item.rawTerm) || seen.has(item.rawTerm) || typeof item.chinese !== 'string' || !/[\u3400-\u9fff]/.test(item.chinese) || /[а-яё]/i.test(item.chinese) || item.chinese.length > 50) throw new Error('AI返回未请求、重复或不合格的属性映射，本批次未写入。');
        seen.add(item.rawTerm);
      }
    }
    return parsed.translations.map(item => ({
      rawTerm: String(item.rawTerm || ''),
      chinese: String(item.chinese || '')
    })).filter(item => item.rawTerm && item.chinese);
  } catch (error) {
    throw Object.assign(new Error('AI 返回的内容无法解析成可用映射，本次未写入任何译文。'), { code: 'ai_response_parse_failed', publicCode: 'ai_response_parse_failed', cause: error });
  }
}

/**
 * 调用AI进行批量翻译
 */
async function translateTermWithAi(aiConfig, unmappedTerms, options = {}) {
  const prompt = buildTranslationPrompt(unmappedTerms);
  const system = '你是专业的俄语/英语到中文翻译助手，负责电商产品术语翻译。';
  const diagnostics = options.diagnostics;
  if (!diagnostics) throw Object.assign(new Error('公共属性翻译处理记录尚未配置，未调用模型。'), { publicCode: 'option_diagnostic_unavailable', status: 503 });
  const context = await diagnostics.start(options.account, ['attribute'], [{ key: 'public-option-translation', version: '1', bodyHash: require('crypto').createHash('sha256').update(system + prompt).digest('hex') }], system + '\n' + prompt, { terms: unmappedTerms, sources: (options.sources || []).filter(row => unmappedTerms.includes(row.raw)) }, 'product-option-auto-map');
  options.context = context;
  const response = await (options.chat || chat)({
    configuration: aiConfig.configuration, apiKey: aiConfig.apiKey, system,
    input: { instruction: prompt }, capabilities: ['product-translation'],
    timeoutMs: aiConfig.configuration.timeout_ms || 30000, diagnostic: context.provider
  });
  await diagnostics.received(context, response);
  return parseAiResponse(response, unmappedTerms);
}

async function processMappingBatch(aiConfig, batch, account, options) {
  const state = { ...options, account }, diagnostics = options.diagnostics;
  let results;
  try {
    const translations = await translateTermWithAi(aiConfig, batch, state);
    state.context.results = batch.map((rawTerm, index) => ({ index, rawTerm, status: translations.some(row => row.rawTerm === rawTerm) ? 'validated' : 'missing' }));
    await diagnostics.record(state.context, 'persisting');
    results = await (options.persist || persistTranslations)(translations);
    for (const rawTerm of batch) if (!results.some(row => row.rawTerm === rawTerm)) results.push({ rawTerm, chinese: '', persisted: false, status: 'failed', error: '模型未返回该属性的中文映射，原值已保留。' });
    state.context.results = results;
    const failures = results.flatMap((row, index) => row.status === 'failed' ? [{ field: String(index), code: 'option_mapping_persist_failed', message: '该项公共映射未保存，原值已保留。' }] : []);
    await diagnostics.record(state.context, failures.length === results.length ? 'rejected' : failures.length ? 'partial' : 'accepted', failures);
    return { results, diagnosticId: state.context.diagnosticId };
  } catch (error) {
    if (results && state.context) {
      throw Object.assign(new Error(results.some(row => row.persisted) ? '公共映射已写入，但处理记录保存失败，请联系系统管理员。' : '公共映射处理记录保存失败，请联系系统管理员核对，当前结果未采用。'), { publicCode: 'option_mapping_diagnostic_failed', status: 503, diagnosticId: state.context.diagnosticId });
    }
    const failure = state.context ? await diagnostics.failed(state.context, error) : error;
    if (failure.publicCode === 'ai_content_diagnostic_failed' || !state.context) throw failure;
    return { diagnosticId: failure.diagnosticId, results: batch.map(rawTerm => ({ rawTerm, chinese: '', persisted: false, status: 'failed', error: failure.message })) };
  }
}

/**
 * 持久化翻译结果到映射文件
 */
async function persistTranslations(translations, termsFile = path.join(__dirname, '..', 'assets', 'product-option-labels.js')) {
  const results = [];
  
  for (const translation of translations) {
    try {
      const result = await persistTermTranslation(
        termsFile,
        translation.rawTerm,
        translation.chinese
      );
      results.push({
        ...translation,
        chinese: result.chinese,
        persisted: result.changed,
        status: result.changed ? 'added' : 'exists'
      });
    } catch (error) {
      console.error('[option-label-auto-mapper] 公共映射持久化失败');
      results.push({
        ...translation,
        persisted: false,
        status: 'failed',
        error: '公共属性映射保存失败，原值已保留，请联系系统管理员。'
      });
    }
  }
  
  return results;
}

/**
 * 主函数：检测未映射的术语并自动翻译
 * @param {Array} terms - 术语数组
 * @param {Object} account - 账户信息
 * @param {Object} options - 可选参数
 * @param {number} options.batchSize - 批次大小(默认10,最大20)
 * @param {Object} options.pool - 数据库连接池
 * @param {Function} options.writeAudit - 审计写入函数
 * @returns {Promise<Object>} 处理结果
 */
async function autoMapUnmappedTerms(terms, account, options = {}) {
  const batchSize = Math.min(options.batchSize || 10, 20); // 单次最多处理20个
  
  // 1. 检测未映射的术语（去重）
  const seen = new Set();
  const unmapped = [];
  
  for (const term of terms) {
    if (!isUnmappedTerm(term)) continue;
    
    const trimmed = String(term).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    
    seen.add(trimmed);
    unmapped.push(trimmed);
  }
  
  if (!unmapped.length) {
    return { detected: 0, translated: 0, persisted: 0, skipped: 0, details: [] };
  }
  
  console.log(`[option-label-auto-mapper] 检测到 ${unmapped.length} 个未映射术语`);
  
  // 2. 获取AI配置
  const pool = options.pool;
  const writeAudit = options.writeAudit || (async () => {});
  
  if (!pool) {
    console.warn('[option-label-auto-mapper] 缺少数据库连接池,无法获取AI配置');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'no_database_pool',
      unmappedTerms: unmapped
    };
  }
  
  const aiConfigStore = createAiConfigStore(pool, writeAudit);
  const aiConfig = await getTranslationAiConfig(account, aiConfigStore);
  
  if (!aiConfig) {
    console.warn('[option-label-auto-mapper] 没有可用的AI配置,跳过自动翻译');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'no_ai_config',
      unmappedTerms: unmapped
    };
  }
  
  // 3. 分批调用AI进行翻译
  const allResults = [];
  const diagnosticIds = [];
  const diagnosticsByTerm = {};
  let translatedCount = 0;
  let persistedCount = 0;
  
  for (let i = 0; i < unmapped.length; i += batchSize) {
    const batch = unmapped.slice(i, i + batchSize);
    
    try {
      console.log(`[option-label-auto-mapper] 正在翻译第 ${Math.floor(i / batchSize) + 1} 批 (${batch.length} 个术语)`);
      
      const processed = await processMappingBatch(aiConfig, batch, account, options);
      if (processed.diagnosticId) { diagnosticIds.push(processed.diagnosticId); for (const term of batch) diagnosticsByTerm[term] = processed.diagnosticId; }
      const persistResults = processed.results;
      translatedCount += persistResults.filter(row => row.status !== 'failed').length;
      persistedCount += persistResults.filter(r => r.persisted).length;
      
      allResults.push(...persistResults);
      
      // 避免频繁调用,批次间延迟
      if (i + batchSize < unmapped.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      if (error.diagnosticId) diagnosticIds.push(error.diagnosticId);
      if (error.status === 503) { error.diagnosticIds = diagnosticIds; throw error; }
      console.error(`[option-label-auto-mapper] 批次翻译失败:`, error.publicCode || 'option_mapping_failed');
      // 标记该批次为失败
      batch.forEach(term => {
        allResults.push({
          rawTerm: term,
          chinese: '',
          persisted: false,
          status: 'failed',
          error: error.message
        });
      });
    }
  }
  
  return {
    detected: unmapped.length,
    translated: translatedCount,
    persisted: persistedCount,
    failed: allResults.filter(r => r.status === 'failed').length,
    details: allResults,
    diagnosticIds, diagnosticsByTerm
  };
}

module.exports = {
  isUnmappedTerm,
  autoMapUnmappedTerms,
  translateTermWithAi,
  processMappingBatch,
  buildTranslationPrompt,
  parseAiResponse,
  persistTranslations,
  getTranslationAiConfig,
  mappedTranslation
};
