'use strict';

const MAX_BEAN = 100000000;

function fail(code, message, status = 400) {
  return Object.assign(new Error(message), { publicCode: code, status });
}

function requireSystemAdmin(account) {
  if (!account || account.isSystemAdmin !== true || String(account.username || '') !== 'admin') {
    throw fail('system_admin_required', '只有唯一系统管理员 admin 可以查看或修改AI豆价格。', 403);
  }
}

function price(value, label, allowZero) {
  const n = Number(value);
  const min = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(n) || n < min || n > MAX_BEAN) {
    throw fail('ai_pricing_invalid', label + '必须是' + min + '到' + MAX_BEAN + '之间的整数AI豆。');
  }
  return n;
}

function mapRow(row) {
  const imageOriginalBean = Number(row.image_original_bean);
  const imageDiscountBean = Number(row.image_discount_bean);
  const analysisOriginalBean = Number(row.analysis_original_bean);
  const analysisDiscountBean = Number(row.analysis_discount_bean);
  return {
    image: { originalBean: imageOriginalBean, discountBean: imageDiscountBean, effectiveBean: imageDiscountBean > 0 ? imageDiscountBean : imageOriginalBean },
    analysis: { originalBean: analysisOriginalBean, discountBean: analysisDiscountBean, effectiveBean: analysisDiscountBean > 0 ? analysisDiscountBean : analysisOriginalBean, batchSize: 100 },
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

function createAiPricingStore(pool, writeAudit) {
  async function current(client = pool) {
    const result = await client.query("SELECT * FROM ai_pricing_config WHERE singleton_key='default'");
    if (!result.rows[0]) throw fail('ai_pricing_missing', 'AI豆价格配置不存在，请联系系统管理员检查数据库迁移。', 503);
    return mapRow(result.rows[0]);
  }
  async function getForAdmin(account) {
    requireSystemAdmin(account);
    return current();
  }
  async function effective(kind) {
    const value = await current();
    if (kind === 'image') return value.image.effectiveBean;
    if (kind === 'analysis') return value.analysis.effectiveBean;
    throw fail('ai_pricing_kind_invalid', '未知的AI豆计费类型，请联系系统管理员。', 500);
  }
  async function save(account, input) {
    requireSystemAdmin(account);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('ai_pricing_invalid', 'AI豆价格配置格式不正确。');
    const imageOriginalBean = price(input.imageOriginalBean, '生图原价', false);
    const imageDiscountBean = price(input.imageDiscountBean == null || input.imageDiscountBean === '' ? 0 : input.imageDiscountBean, '生图折扣价', true);
    const analysisOriginalBean = price(input.analysisOriginalBean, '数据分析原价', false);
    const analysisDiscountBean = price(input.analysisDiscountBean == null || input.analysisDiscountBean === '' ? 0 : input.analysisDiscountBean, '数据分析折扣价', true);
    if (imageDiscountBean > imageOriginalBean) throw fail('ai_pricing_invalid', '生图折扣价不能高于生图原价。');
    if (analysisDiscountBean > analysisOriginalBean) throw fail('ai_pricing_invalid', '数据分析折扣价不能高于数据分析原价。');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        "UPDATE ai_pricing_config SET image_original_bean=$1,image_discount_bean=$2,analysis_original_bean=$3,analysis_discount_bean=$4,updated_by_user_id=$5,updated_at=now() WHERE singleton_key='default'",
        [imageOriginalBean, imageDiscountBean, analysisOriginalBean, analysisDiscountBean, account.userId]
      );
      if (updated.rowCount !== 1) throw fail('ai_pricing_missing', 'AI豆价格配置不存在，请联系系统管理员检查数据库迁移。', 503);
      if (typeof writeAudit === 'function') {
        await writeAudit(client, account, 'ai.pricing.save', 'ai_pricing', 'default', 'success', { imageOriginalBean, imageDiscountBean, analysisOriginalBean, analysisDiscountBean });
      }
      await client.query('COMMIT');
      return current();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return { current, getForAdmin, effective, save };
}

module.exports = { createAiPricingStore };
