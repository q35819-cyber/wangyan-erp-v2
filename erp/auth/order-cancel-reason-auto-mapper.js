'use strict';

const path = require('path');
const { extractCancellationReason, cancelReasonZh } = require('../assets/order-mappings');
const { persistTranslation, getTranslationAiConfig, validateAiTranslationBatch } = require('./order-mapping-updater');
const { createAiConfigStore } = require('./ai-config-store');
const { chat } = require('./ai-provider');

const MAPPINGS_FILE = path.join(__dirname, '..', 'assets', 'order-mappings.js');

/**
 * 检测订单的取消原因是否未映射（返回true表示未映射）
 */
function isUnmappedReason(order) {
  const reason = extractRawReason(order);
  if (!reason) return false; // 空原因不算未映射
  
  const chinese = cancelReasonZh(reason);
  // 如果返回的结果不包含中文字符，或者返回的是默认提示语，说明未映射
  if (!/[\u3400-\u9fff]/.test(chinese)) return true;
  if (chinese === '取消/拒收原因待补充映射') return true;
  
  return false;
}

/**
 * 从订单对象中提取原始俄文取消原因
 */
function extractRawReason(order) {
  if (!order || typeof order !== 'object') return '';
  
  // 优先使用已有的提取函数
  const posting = order.posting || order;
  const reason = extractCancellationReason(posting);
  
  if (reason) return String(reason).trim();
  
  // fallback: 尝试从订单其他字段提取
  const candidates = [
    order.cancel_reason,
    order.cancellation_reason,
    order.rejection_reason,
    order.refusal_reason,
    order.return_reason,
    order.reason
  ];
  
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text) return text;
  }
  
  return '';
}

/**
 * 构建AI翻译提示词（针对取消原因）
 */
function buildTranslationPrompt(unmappedReasons) {
  const reasonsList = unmappedReasons.map((reason, index) => {
    return `${index + 1}. "${reason}"`;
  }).join('\n  ');

  return `你是一个专业的俄语到中文翻译助手，专门负责电商平台Ozon订单取消原因的翻译。

请将以下未映射的Ozon订单取消原因翻译成简体中文。要求：
1. 保持业务含义准确，区分买家取消、卖家取消、Ozon取消、配送失败等不同场景
2. 翻译要简洁明了，适合在ERP订单列表和详情页面显示
3. 如果原因已经是中文，直接返回原文
4. 如果是技术性代码或标识符，保留原文但添加中文注释
5. 对于长句，提取核心含义，不要逐字翻译

待翻译的取消原因列表：
${reasonsList}

请以JSON格式返回，格式如下：
{
  "translations": [
    {
      "rawReason": "<原始俄文原因>",
      "chinese": "<中文翻译>"
    }
  ]
}

注意：
- 只返回JSON，不要包含其他说明文字
- rawReason必须与输入的原始原因完全一致
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
      rawReason: String(item.rawReason || ''),
      chinese: String(item.chinese || '')
    })).filter(item => item.rawReason && item.chinese);
  } catch (error) {
    throw Object.assign(new Error('AI 返回的内容无法解析成可用映射，本次未写入任何译文。'), { code: 'ai_response_parse_failed', cause: error });
  }
}

/**
 * 调用AI进行批量翻译
 */
async function translateReasonWithAi(aiConfig, unmappedReasons, options = {}) {
  const prompt = buildTranslationPrompt(unmappedReasons);
  const system = '你是专业的俄语到中文翻译助手，负责电商订单取消原因翻译。';
  
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
      const result = await persistTranslation(
        MAPPINGS_FILE,
        translation.rawReason,
        translation.chinese
      );
      results.push({
        ...translation,
        persisted: result.changed,
        status: result.changed ? 'added' : 'exists'
      });
    } catch (error) {
      console.error(`[order-cancel-reason-auto-mapper] 持久化失败 [${translation.rawReason}]:`, error.message);
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
 * 主函数：检测未映射的取消原因并自动翻译
 * @param {Array} orders - 订单数组（包含取消订单）
 * @param {Object} account - 账户信息（tenantId, userId等）
 * @param {Object} options - 可选参数
 * @param {number} options.batchSize - 批次大小(默认10,最大20)
 * @param {Object} options.pool - 数据库连接池
 * @param {Function} options.writeAudit - 审计写入函数
 * @returns {Promise<Object>} 处理结果
 */
async function autoMapUnmappedReasons(orders, account, options = {}) {
  const batchSize = Math.min(options.batchSize || 10, 20); // 单次最多处理20个
  
  // 1. 检测未映射的取消原因（去重）
  const seen = new Set();
  const unmapped = [];
  
  for (const order of orders) {
    if (!isUnmappedReason(order)) continue;
    
    const reason = extractRawReason(order);
    if (!reason || seen.has(reason)) continue;
    
    seen.add(reason);
    unmapped.push(reason);
  }
  
  if (!unmapped.length) {
    return { detected: 0, translated: 0, persisted: 0, skipped: 0, details: [] };
  }
  
  console.log(`[order-cancel-reason-auto-mapper] 检测到 ${unmapped.length} 个未映射取消原因`);
  
  // 2. 获取AI配置
  const pool = options.pool;
  const writeAudit = options.writeAudit || (async () => {});
  
  if (!pool) {
    console.warn('[order-cancel-reason-auto-mapper] 缺少数据库连接池,无法获取AI配置');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'no_database_pool',
      unmappedReasons: unmapped
    };
  }
  
  const aiConfigStore = createAiConfigStore(pool, writeAudit);
  const aiConfig = await getTranslationAiConfig(account, aiConfigStore);
  
  if (!aiConfig) {
    console.warn('[order-cancel-reason-auto-mapper] 系统官方AI服务不可用，本次保留原始取消/拒收原因');
    return {
      detected: unmapped.length,
      translated: 0,
      persisted: 0,
      skipped: unmapped.length,
      reason: 'official_ai_unavailable',
      message: '系统官方AI服务暂不可用，本次未写入映射，已保留原始取消/拒收原因。',
      unmappedReasons: unmapped
    };
  }
  
  // 3. 分批调用AI进行翻译
  const allResults = [];
  let translatedCount = 0;
  let persistedCount = 0;
  
  for (let i = 0; i < unmapped.length; i += batchSize) {
    const batch = unmapped.slice(i, i + batchSize);
    
    try {
      console.log(`[order-cancel-reason-auto-mapper] 正在翻译第 ${Math.floor(i / batchSize) + 1} 批 (${batch.length} 个原因)`);
      
      const providerDiagnostic = {};
      const translations = validateAiTranslationBatch(batch, await translateReasonWithAi(aiConfig, batch, { diagnostic: providerDiagnostic }), 'rawReason');
      await writeAudit(pool, account, 'ai.order.cancel-reason.auto-map', 'ai_configuration', String(aiConfig.configuration.id || 'official'), 'success', {
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
      console.error(`[order-cancel-reason-auto-mapper] 批次翻译失败:`, error.message);
      await writeAudit(pool, account, 'ai.order.cancel-reason.auto-map', 'ai_configuration', String(aiConfig.configuration.id || 'official'), 'failed', {
        official: true,
        requested: batch.length,
        error: String(error.publicCode || error.code || 'ai_mapping_failed').slice(0, 120)
      }).catch(() => {});
      // 标记该批次为失败
      batch.forEach(reason => {
        allResults.push({
          rawReason: reason,
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
  isUnmappedReason,
  extractRawReason,
  autoMapUnmappedReasons,
  buildTranslationPrompt,
  parseAiResponse,
  persistTranslations,
  translateReasonWithAi,
  getTranslationAiConfig
};
