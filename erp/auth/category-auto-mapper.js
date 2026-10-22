'use strict';

const path = require('path');
const { translateCat } = require('../assets/category-trans');
const { persistCategoryTranslation, getTranslationAiConfig } = require('./order-mapping-updater');
const { createAiConfigStore } = require('./ai-config-store');
const { chat } = require('./ai-provider');

const MAPPINGS_FILE = path.join(__dirname, '..', 'assets', 'category-trans.js');

/**
 * 检测类目名称是否未映射（返回true表示未映射）
 */
function isUnmappedCategory(name) {
  if (!name || typeof name !== 'string') return false;
  
  const trimmed = name.trim();
  if (!trimmed) return false;
  
  // 如果translateCat返回原值，说明未映射
  const translated = translateCat(trimmed);
  return translated === trimmed;
}

/**
 * 构建AI翻译提示词（针对电商类目名称）
 */
function buildTranslationPrompt(unmappedNames) {
  const namesList = unmappedNames.map((name, index) => {
    return `${index + 1}. "${name}"`;
  }).join('\n  ');

  return `你是一个专业的俄语到中文翻译助手，专门负责电商平台Ozon类目名称的翻译。

请将以下未映射的Ozon类目名称翻译成简体中文。要求：
1. 使用电商行业标准译名，保持专业术语准确性
2. 翻译要简洁明了，适合在ERP商品管理页面显示
3. 如果类目名称已经是中文，直接返回原文
4. 对于复合类目（如"Аксессуары и запчасти"），翻译要体现两个部分的关系
5. 常见类目包括：电子产品、汽车配件、家居用品、玩具、文具、服装等

待翻译的类目名称列表：
${namesList}

请以JSON格式返回，格式如下：
{
  "translations": [
    {
      "rawName": "<原始俄文类目名>",
      "chinese": "<中文翻译>"
    }
  ]
}

注意：
- 只返回JSON，不要包含其他说明文字
- rawName必须与输入的原始类目名完全一致
- chinese必须是有效的中文翻译，不能为空
- 保持类目的层级关系和业务含义准确`;
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
      rawName: String(item.rawName || ''),
      chinese: String(item.chinese || '')
    })).filter(item => item.rawName && item.chinese);
  } catch (error) {
    throw Object.assign(new Error('AI 返回的内容无法解析成可用映射，本次未写入任何译文。'), { code: 'ai_response_parse_failed', cause: error });
  }
}

/**
 * 调用AI进行批量翻译
 */
async function translateCategoryWithAi(aiConfig, unmappedNames) {
  const prompt = buildTranslationPrompt(unmappedNames);
  const system = '你是专业的俄语到中文翻译助手，负责电商类目名称翻译。';
  
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
      const result = await persistCategoryTranslation(
        MAPPINGS_FILE,
        translation.rawName,
        translation.chinese
      );
      results.push({
        ...translation,
        persisted: result.changed,
        status: result.changed ? 'added' : 'exists'
      });
    } catch (error) {
      console.error(`[category-auto-mapper] 持久化失败 [${translation.rawName}]:`, error.message);
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
 * 主函数：检测未映射的类目名称并自动翻译
 * @param {Array} names - 类目名称数组
 * @param {Object} account - 账户信息（tenantId, userId等）
 * @param {Object} options - 可选参数
 * @param {number} options.batchSize - 批次大小(默认10,最大20)
 * @param {Object} options.pool - 数据库连接池
 * @param {Function} options.writeAudit - 审计写入函数
 * @returns {Promise<Object>} 处理结果
 */
async function autoMapUnmappedCategories(names, account, options = {}) {
  const batchSize = Math.min(options.batchSize || 10, 20); // 单次最多处理20个
  
  // 1. 检测未映射的类目名称（去重）
  const seen = new Set();
  const unmapped = [];
  
  for (const name of names) {
    if (!isUnmappedCategory(name)) continue;
    
    const trimmed = String(name).trim();
    if (!trimmed || seen.has(trimmed)) continue;
    
    seen.add(trimmed);
    unmapped.push(trimmed);
  }
  
  if (!unmapped.length) {
    return { detected: 0, translated: 0, persisted: 0, skipped: 0, details: [] };
  }
  
  console.log(`[category-auto-mapper] 检测到 ${unmapped.length} 个未映射类目名称`);
  
  // 2. 获取AI配置
  const pool = options.pool;
  const writeAudit = options.writeAudit || (async () => {});
  
  if (!pool) {
    console.warn('[category-auto-mapper] 缺少数据库连接池,无法获取AI配置');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'no_database_pool',
      unmappedNames: unmapped
    };
  }
  
  const aiConfigStore = createAiConfigStore(pool, writeAudit);
  const aiConfig = await getTranslationAiConfig(account, aiConfigStore);
  
  if (!aiConfig) {
    console.warn('[category-auto-mapper] 没有可用的AI配置,跳过自动翻译');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'no_ai_config',
      unmappedNames: unmapped
    };
  }
  
  // 3. 分批调用AI进行翻译
  const allResults = [];
  let translatedCount = 0;
  let persistedCount = 0;
  
  for (let i = 0; i < unmapped.length; i += batchSize) {
    const batch = unmapped.slice(i, i + batchSize);
    
    try {
      console.log(`[category-auto-mapper] 正在翻译第 ${Math.floor(i / batchSize) + 1} 批 (${batch.length} 个类目)`);
      
      const translations = await translateCategoryWithAi(aiConfig, batch);
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
      console.error(`[category-auto-mapper] 批次翻译失败:`, error.message);
      // 标记该批次为失败
      batch.forEach(name => {
        allResults.push({
          rawName: name,
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
  isUnmappedCategory,
  autoMapUnmappedCategories,
  translateCategoryWithAi,
  buildTranslationPrompt,
  parseAiResponse,
  persistTranslations,
  getTranslationAiConfig
};
