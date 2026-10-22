'use strict';

const path = require('path');
const { accrualFeeNameZh } = require('../assets/order-mappings');
const { persistFeeTranslation, getTranslationAiConfig } = require('./order-mapping-updater');
const { createAiConfigStore } = require('./ai-config-store');
const { chat } = require('./ai-provider');

const MAPPINGS_FILE = path.join(__dirname, '..', 'assets', 'order-mappings.js');

/**
 * 检测费用项是否未映射（返回俄文或英文原名而非中文）
 */
function isUnmapped(item) {
  const chinese = accrualFeeNameZh(item);
  // 如果返回的结果不包含中文字符，说明未映射
  return !/[\u3400-\u9fff]/.test(chinese);
}

/**
 * 从费用项中提取原始名称
 */
function extractRawName(item) {
  return String(item.name || item.rawName || item.desc || item.rawType || item.type || '');
}

/**
 * 构建AI翻译提示词
 */
function buildTranslationPrompt(unmappedFees) {
  const feesList = unmappedFees.map(fee => {
    const typeId = fee.type != null ? String(fee.type) : 'N/A';
    const rawName = extractRawName(fee);
    return `- type_id: ${typeId}, name: "${rawName}"`;
  }).join('\n  ');

  return `你是一个专业的俄语到中文翻译助手，专门负责电商平台Ozon的费用名称翻译。

请将以下未映射的Ozon费用名称翻译成简体中文。要求：
1. 保持专业术语准确性
2. 翻译要简洁明了，适合在ERP界面显示
3. 如果费用名称已经是中文，直接返回原文
4. 如果是纯技术性代码或标识符，保留原文但添加中文注释

待翻译的费用列表：
${feesList}

请以JSON格式返回，格式如下：
{
  "translations": [
    {
      "typeId": <数字类型ID>,
      "rawName": "<原始名称>",
      "chinese": "<中文翻译>"
    }
  ]
}

注意：只返回JSON，不要包含其他说明文字。`;
}

/**
 * 解析AI返回的翻译结果
 */
function parseAiResponse(content) {
  try {
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    
    if (!parsed.translations || !Array.isArray(parsed.translations)) {
      throw new Error('AI返回格式无效：缺少translations数组');
    }
    
    return parsed.translations.map(item => ({
      typeId: item.typeId,
      rawName: String(item.rawName || ''),
      chinese: String(item.chinese || '')
    }));
  } catch (error) {
    throw Object.assign(new Error('AI 返回的内容无法解析成可用映射，本次未写入任何译文。'), { code: 'ai_response_parse_failed', cause: error });
  }
}

/**
 * 调用AI进行批量翻译
 */
async function translateWithAi(aiConfig, unmappedFees) {
  const prompt = buildTranslationPrompt(unmappedFees);
  const system = '你是专业的俄语到中文翻译助手，负责电商费用名称翻译。';
  
  const response = await chat({
    configuration: aiConfig.configuration,
    apiKey: aiConfig.apiKey,
    system,
    input: { instruction: prompt },
    capabilities: ['product-translation'],
    timeoutMs: aiConfig.configuration.timeout_ms || 30000
  });
  
  return parseAiResponse(response);
}

/**
 * 持久化翻译结果到映射文件
 */
async function persistTranslations(translations) {
  const results = [];
  
  for (const translation of translations) {
    try {
      const result = await persistFeeTranslation(
        MAPPINGS_FILE,
        translation.typeId,
        translation.rawName,
        translation.chinese
      );
      results.push({
        ...translation,
        persisted: result.changed,
        status: result.changed ? 'added' : 'exists'
      });
    } catch (error) {
      console.error(`[order-fee-auto-mapper] 持久化失败 [type_id=${translation.typeId}]:`, error.message);
      results.push({
        ...translation,
        persisted: false,
        status: 'failed',
        error: error.message
      });
    }
  }
  
  return results;
}

/**
 * 主函数：检测未映射费用并自动翻译
 * @param {Array} feeItems - 费用项数组
 * @param {Object} account - 账户信息（tenantId, userId等）
 * @param {Object} options - 可选参数
 * @param {number} options.batchSize - 批次大小(默认10,最大20)
 * @param {Object} options.pool - 数据库连接池
 * @param {Function} options.writeAudit - 审计写入函数
 * @returns {Promise<Object>} 处理结果
 */
async function autoMapUnmappedFees(feeItems, account, options = {}) {
  const batchSize = Math.min(options.batchSize || 10, 20); // 单次最多处理20个
  
  // 1. 检测未映射的费用
  const unmapped = feeItems.filter(isUnmapped);
  
  if (!unmapped.length) {
    return { detected: 0, translated: 0, persisted: 0, skipped: 0, details: [] };
  }
  
  console.log(`[order-fee-auto-mapper] 检测到 ${unmapped.length} 个未映射费用`);
  
  // 2. 获取AI配置
  const pool = options.pool;
  const writeAudit = options.writeAudit || (async () => {});
  
  if (!pool) {
    console.warn('[order-fee-auto-mapper] 缺少数据库连接池,无法获取AI配置');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'no_database_pool',
      unmappedItems: unmapped.map(item => ({
        typeId: item.type,
        rawName: extractRawName(item)
      }))
    };
  }
  
  const aiConfigStore = createAiConfigStore(pool, writeAudit);
  const aiConfig = await getTranslationAiConfig(account, aiConfigStore);
  
  if (!aiConfig) {
    console.warn('[order-fee-auto-mapper] 没有可用的AI配置,跳过自动翻译');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'no_ai_config',
      unmappedItems: unmapped.map(item => ({
        typeId: item.type,
        rawName: extractRawName(item)
      }))
    };
  }
  
  // 3. 分批调用AI进行翻译
  const allResults = [];
  let translatedCount = 0;
  let persistedCount = 0;
  
  for (let i = 0; i < unmapped.length; i += batchSize) {
    const batch = unmapped.slice(i, i + batchSize);
    
    try {
      console.log(`[order-fee-auto-mapper] 正在翻译第 ${Math.floor(i / batchSize) + 1} 批 (${batch.length} 个费用)`);
      
      const translations = await translateWithAi(aiConfig, batch);
      translatedCount += translations.length;
      
      // 4. 持久化翻译结果
      const persistResults = await persistTranslations(translations);
      persistedCount += persistResults.filter(r => r.persisted).length;
      
      allResults.push(...persistResults);
      
      // 避免频繁调用,批次间延迟
      if (i + batchSize < unmapped.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`[order-fee-auto-mapper] 批次翻译失败:`, error.message);
      // 标记该批次为失败
      batch.forEach(item => {
        allResults.push({
          typeId: item.type,
          rawName: extractRawName(item),
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
    details: allResults
  };
}

module.exports = {
  isUnmapped,
  extractRawName,
  autoMapUnmappedFees,
  buildTranslationPrompt,
  parseAiResponse,
  persistTranslations,
  translateWithAi,
  getTranslationAiConfig
};
