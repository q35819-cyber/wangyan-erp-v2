'use strict';

// R2 only: inspect stored-size metadata without reading any JSON payload or
// tenant/user/shop identifiers into the report. A key named "cache" is not
// automatically disposable: order/advertising fee snapshots affect profits.
const PUBLIC_REFERENCE = new Set(['erp_category_attributes', 'erp_category_tree']);
const BUSINESS_RECORDS = new Set([
  'erp_orders_data', 'erp_online_products', 'erp_collected_products',
  'erp_online_product_manual', 'erp_product_drafts', 'erp_favorite_products',
  'erp_shops_data', 'erp_shop_groups', 'erp_online_categories',
  'erp_accrual_types', 'erp_accruals_data', 'erp_acquiring_data',
  'erp_rate', 'erp_fee_manual', 'erp_amount_fix_v1', 'erp_dev_manual_backup',
  'erp_message_sendlog', 'erp_message_blacklist', 'erp_bug_reports'
]);
const SHARED_SETTINGS = new Set([
  'erp_ai_analysis_rules', 'erp_promotion_rules', 'erp_message_templates',
  'erp_watermark_templates', 'erp_watermark_preview_base',
  'erp_pricing_settings', 'erp_logistics_templates', 'erp_logistics_config'
]);

const FAMILY_PATTERNS = [
  [/^erp_order_(?:fee|acquiring)_cache_[a-f0-9]{16}$/, 'erp_order_fee_or_acquiring_cache_*', 'financial_protected'],
  [/^erp_order_performance_cpo_[A-Za-z0-9._-]+$/, 'erp_order_performance_cpo_*', 'financial_protected'],
  [/^erp_order_advertising_[A-Za-z0-9._-]+$/, 'erp_order_advertising_*', 'financial_protected'],
  [/^erp_order_.*cache.*/, 'erp_order_other_cache_*', 'financial_protected'],
  [/^erp_logistics_user_config_.*/, 'erp_logistics_user_config_*', 'tenant_settings'],
  [/^erp_logistics_preference_.*/, 'erp_logistics_preference_*', 'tenant_settings']
];

function classifyDocumentKey(key) {
  const value = String(key || '');
  if (PUBLIC_REFERENCE.has(value)) return { family: value, tier: 'public_reference_candidate' };
  if (BUSINESS_RECORDS.has(value)) return { family: value, tier: 'business_truth' };
  if (SHARED_SETTINGS.has(value)) return { family: value, tier: 'tenant_settings' };
  for (const [pattern, family, tier] of FAMILY_PATTERNS) {
    if (pattern.test(value)) return { family, tier };
  }
  // Do not print unknown raw keys: some keys embed shop or user identifiers.
  return { family: 'unclassified_document_keys', tier: 'manual_review_preserve' };
}

function recommendation(tier) {
  switch (tier) {
    case 'public_reference_candidate': return '核对所有租户官方来源差异后，才允许切换版本化公共只读文件；旧数据库暂时保留';
    case 'business_truth': return '属于业务真值或用户历史，不迁移、不自动删除';
    case 'financial_protected': return '影响订单费用、广告归属或利润对账，必须先完成财务来源与重建能力审计，不允许按缓存自动过期';
    case 'tenant_settings': return '跨设备共享配置，应保留可靠持久化；只有纯UI偏好可评估本地缓存';
    default: return '用途尚未核实，保留原记录并执行代码级读写追踪';
  }
}

function aggregateDocumentSizes(rows) {
  const families = new Map();
  for (const row of rows || []) {
    const { family, tier } = classifyDocumentKey(row.document_key);
    let item = families.get(family);
    if (!item) {
      item = { family, tier, rows: 0, totalPayloadBytes: 0, maxPayloadBytes: 0,
        distinctKeyVariants: 0, recommendation: recommendation(tier) };
      families.set(family, item);
    }
    const count = Number(row.row_count || 0), size = Number(row.total_payload_bytes || 0);
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(size) || count < 0 || size < 0) {
      throw new Error('数据库返回的审计汇总结果不正确，拒绝生成误导性的容量报告。');
    }
    item.rows += count;
    item.totalPayloadBytes += size;
    item.maxPayloadBytes = Math.max(item.maxPayloadBytes, Number(row.max_payload_bytes || 0));
    item.distinctKeyVariants += 1;
  }
  return [...families.values()].sort((a, b) => b.totalPayloadBytes - a.totalPayloadBytes || a.family.localeCompare(b.family));
}

// Deliberately SELECT-only. No tenant_id, payload or account/credential data
// returned, and no write statements, VACUUM or ALTER statements are run.
const AUDIT_SQL = `
  SELECT document_key,
         count(*)::bigint AS row_count,
         coalesce(sum(pg_column_size(payload)),0)::bigint AS total_payload_bytes,
         coalesce(max(pg_column_size(payload)),0)::bigint AS max_payload_bytes
  FROM tenant_documents
  GROUP BY document_key
`;

async function auditTenantDocuments(client) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout='15000ms'");
    await client.query("SET LOCAL lock_timeout='2000ms'");
    const result = await client.query(AUDIT_SQL);
    await client.query('COMMIT');
    return { auditedAt: new Date().toISOString(), metric: 'pg_column_size(payload): compressed/inline column bytes, not total heap/WAL/disk size',
      note: 'Rows and bytes are grouped by safe document families; tenant IDs, raw unknown keys and payload are never exported. Actual read/write frequency cannot be inferred from this snapshot.',
      families: aggregateDocumentSizes(result.rows) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

module.exports = { classifyDocumentKey, aggregateDocumentSizes, auditTenantDocuments, AUDIT_SQL };
