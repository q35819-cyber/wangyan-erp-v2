'use strict';

const path = require('path');
const { returnStatusZh } = require('../assets/order-mappings');
const { persistReturnStatusTranslation, getTranslationAiConfig, validateAiTranslationBatch } = require('./order-mapping-updater');
const { createAiConfigStore } = require('./ai-config-store');
const { chat } = require('./ai-provider');

const MAPPINGS_FILE = path.join(__dirname, '..', 'assets', 'order-mappings.js');

/**
 * 检测退货状态是否未映射（返回true表示未映射）
 */
function isUnmappedStatus(returnInfo) {
  const status = extractRawStatus(returnInfo);
  if (!status) return false; // 空状态不算未映射
  
  const chinese = returnStatusZh(status);
  // 如果返回的结果不包含中文字符，说明未映射
  if (!/[\u3400-\u9fff]/.test(chinese)) return true;
  
  return false;
}

/**
 * 从退货信息对象中提取原始状态值
 */
function extractRawStatus(returnInfo) {
  if (!returnInfo || typeof returnInfo !== 'object') return '';
  
  // 尝试多种可能的字段名
  const candidates = [
    returnInfo.state,
    returnInfo.status,
    returnInfo.return_status,
    returnInfo.returnState,
    returnInfo.returnStatus,
    returnInfo.state_name,
    returnInfo.status_name
  ];
  
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }
  
  // fallback: 如果是字符串或数字，直接返回
  if (typeof returnInfo === 'string' || typeof returnInfo === 'number') {
    return String(returnInfo).trim();
  }
  
  return '';
}

/**
 * 构建AI翻译提示词（针对退货状态）
 */
function buildTranslationPrompt(unmappedStatuses) {
  const statusesList = unmappedStatuses.map((status, index) => {
    return `${index + 1}. "${status}"`;
  }).join('\n  ');

  return `你是一个专业的俄语到中文翻译助手，专门负责电商平台Ozon退货状态的翻译。

请将以下未映射的Ozon退货状态翻译成简体中文。要求：
1. 保持业务含义准确，区分销毁、运输、在仓库、退回卖家等不同阶段
2. 翻译要简洁明了，适合在ERP退货管理页面显示
3. 如果状态已经是中文，直接返回原文
4. 如果是技术性代码或标识符，保留原文但添加中文注释
5. 常见状态包括：Utilizing（销毁中）、MovingToOzon（运往Ozon仓库）、ReturnedToOzon / ArrivedAtWarehouse（在仓库）、MovingToSeller（退回卖家途中）等

待翻译的退货状态列表：
${statusesList}

请以JSON格式返回，格式如下：
{
  "translations": [
    {
      "rawStatus": "<原始状态值>",
      "chinese": "<中文翻译>"
    }
  ]
}

注意：
- 只返回JSON，不要包含其他说明文字
- rawStatus必须与输入的原始状态完全一致
- chinese必须是有效的中文翻译，不能为空`;
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
      rawStatus: String(item.rawStatus || ''),
      chinese: String(item.chinese || '')
    })).filter(item => item.rawStatus && item.chinese);
  } catch (error) {
    throw Object.assign(new Error('AI 返回的内容无法解析成可用映射，本次未写入任何译文。'), { code: 'ai_response_parse_failed', cause: error });
  }
}

/**
 * 调用AI进行批量翻译
 */
async function translateStatusWithAi(aiConfig, unmappedStatuses, options = {}) {
  const prompt = buildTranslationPrompt(unmappedStatuses);
  const system = '你是专业的俄语到中文翻译助手，负责电商退货状态翻译。';
  
  const response = await chat({
    configuration: aiConfig.configuration,
    apiKey: aiConfig.apiKey,
    system,
    input: { instruction: prompt },
    capabilities: ['product-translation'],
    timeoutMs: aiConfig.configuration.timeout_ms || 30000,
    diagnostic: options.diagnostic
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
      const result = await persistReturnStatusTranslation(
        MAPPINGS_FILE,
        translation.rawStatus,
        translation.chinese
      );
      results.push({
        ...translation,
        persisted: result.changed,
        status: result.changed ? 'added' : 'exists'
      });
    } catch (error) {
      console.error(`[order-return-status-auto-mapper] 持久化失败 [${translation.rawStatus}]:`, error.message);
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
 * 主函数：检测未映射的退货状态并自动翻译
 * @param {Array} returnInfos - 退货信息数组
 * @param {Object} account - 账户信息（tenantId, userId等）
 * @param {Object} options - 可选参数
 * @param {number} options.batchSize - 批次大小(默认10,最大20)
 * @param {Object} options.pool - 数据库连接池
 * @param {Function} options.writeAudit - 审计写入函数
 * @returns {Promise<Object>} 处理结果
 */
async function autoMapUnmappedStatuses(returnInfos, account, options = {}) {
  const batchSize = Math.min(options.batchSize || 10, 20); // 单次最多处理20个
  
  // 1. 检测未映射的退货状态（去重）
  const seen = new Set();
  const unmapped = [];
  
  for (const returnInfo of returnInfos) {
    if (!isUnmappedStatus(returnInfo)) continue;
    
    const status = extractRawStatus(returnInfo);
    if (!status || seen.has(status)) continue;
    
    seen.add(status);
    unmapped.push(status);
  }
  
  if (!unmapped.length) {
    return { detected: 0, translated: 0, persisted: 0, skipped: 0, details: [] };
  }
  
  console.log(`[order-return-status-auto-mapper] 检测到 ${unmapped.length} 个未映射退货状态`);
  
  // 2. 获取AI配置
  const pool = options.pool;
  const writeAudit = options.writeAudit || (async () => {});
  
  if (!pool) {
    console.warn('[order-return-status-auto-mapper] 缺少数据库连接池,无法获取AI配置');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'no_database_pool',
      unmappedStatuses: unmapped
    };
  }
  
  const aiConfigStore = createAiConfigStore(pool, writeAudit);
  const aiConfig = await getTranslationAiConfig(account, aiConfigStore);
  
  if (!aiConfig) {
    console.warn('[order-return-status-auto-mapper] 系统官方AI服务不可用，本次保留原始退货状态');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'official_ai_unavailable',
      message: '系统官方AI服务暂不可用，本次未写入映射，已保留原始退货状态。',
      unmappedStatuses: unmapped
    };
  }
  
  // 3. 分批调用AI进行翻译
  const allResults = [];
  let translatedCount = 0;
  let persistedCount = 0;
  
  for (let i = 0; i < unmapped.length; i += batchSize) {
    const batch = unmapped.slice(i, i + batchSize);
    
    try {
      console.log(`[order-return-status-auto-mapper] 正在翻译第 ${Math.floor(i / batchSize) + 1} 批 (${batch.length} 个状态)`);
      
      const providerDiagnostic = {};
      const translations = validateAiTranslationBatch(batch, await translateStatusWithAi(aiConfig, batch, { diagnostic: providerDiagnostic }), 'rawStatus');
      await writeAudit(pool, account, 'ai.order.return-status.auto-map', 'ai_configuration', String(aiConfig.configuration.id || 'official'), 'success', {
        official: true,
        requested: batch.length,
        protocol: String(providerDiagnostic.protocol || aiConfig.configuration.protocol || ''),
        model: String(providerDiagnostic.actualModel || ''),
        httpStatus: Number(providerDiagnostic.httpStatus || 0),
        providerRequestId: String(providerDiagnostic.providerRequestId || '').slice(0, 120)
      });
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
      console.error(`[order-return-status-auto-mapper] 批次翻译失败:`, error.message);
      await writeAudit(pool, account, 'ai.order.return-status.auto-map', 'ai_configuration', String(aiConfig.configuration.id || 'official'), 'failed', {
        official: true,
        requested: batch.length,
        error: String(error.publicCode || error.code || 'ai_mapping_failed').slice(0, 120)
      }).catch(() => {});
      // 标记该批次为失败
      batch.forEach(status => {
        allResults.push({
          rawStatus: status,
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
  isUnmappedStatus,
  extractRawStatus,
  autoMapUnmappedStatuses,
  buildTranslationPrompt,
  parseAiResponse,
  persistTranslations,
  translateStatusWithAi,
  getTranslationAiConfig
};
