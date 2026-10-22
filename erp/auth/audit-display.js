'use strict';

const ACTION_LABELS = {
  'auth.login': '登录系统', 'auth.logout': '退出登录', 'auth.password.change': '修改登录密码',
  'auth.sessions.revoke_all': '退出全部设备', 'audit.export': '导出审计日志',
  'system.page_data.clear': '清除页面同步数据', 'tenant.document.update': '更新业务数据',
  'tenant.document.delete': '删除业务数据', 'tenant.member.create': '创建子账号',
  'tenant.member.permissions.update': '修改子账号权限', 'tenant.member.status.update': '修改子账号状态',
  'logistics.preference.sync_members': '同步物流方案到子账号',
  'bug.attachment.upload': '上传BUG附件', 'bug.email.notify': '发送BUG邮件通知',
  'logistics.tariff.upload': '上传物流资费表', 'logistics.tariff.activate': '启用物流资费版本',
  'logistics.preference.update': '设置默认运输方式', 'logistics.profile.update': '设置物流方案',
  'category.attributes.sync': '同步三级类目属性',
  'contract.agent.version.update': '切换代理商合同版本',
  'user.security.freeze': '手动冻结用户', 'user.security.unfreeze': '解除用户冻结',
  'user.security.ban': '手动封禁用户', 'user.security.unban': '解除用户封号',
  'user.security.set_email': '设置安全提醒邮箱'
};
const RESOURCE_LABELS = { user: '用户账号', session: '登录会话', audit_events: '审计日志', page: '功能页面', tenant_document: '业务数据', bug_report: 'BUG反馈', logistics_tariff: '物流资费配置', contract_terms: '合同条款' };
const RESULT_LABELS = { success: '成功', failed: '失败', failure: '失败', denied: '已拒绝', skipped: '已跳过' };
const DOCUMENT_LABELS = {
  erp_shops_data: '店铺数据', erp_orders_data: '订单数据', erp_online_products: '在线商品数据',
  erp_category_tree: '类目数据', erp_collected_products: '商品采集箱', erp_favorite_products: '商品收藏夹',
  erp_watermark_templates: '水印模板', erp_watermark_preview_base: '水印预览底图', erp_shop_groups: '店铺分组', erp_dev_manual_backup: '订单人工数据备份', erp_ai_analysis_rules: '数据分析规则',
  erp_online_product_manual: '在线商品人工数据', erp_category_attributes: '三级类目属性库', erp_accruals_data: '订单费用数据',
  erp_acquiring_data: '收单费用数据', erp_amount_fix_v1: '订单金额修正状态', erp_bug_reports: 'BUG反馈数据'
};
const PAGE_LABELS = { orders: '订单管理', 'online-products': '在线商品' };
const PERMISSION_LABELS = {
  'shops.read': '查看店铺', 'shops.write': '编辑店铺', 'orders.read': '查看订单', 'orders.write': '修改订单',
  'orders.export': '导出订单', 'products.read': '查看商品', 'products.write': '修改商品', 'sync.run': '发起同步',
  'audit.read': '查看审计日志', 'overview.import': '导入大盘数据', 'tenant.roles.read': '查看账号与权限',
  'tenant.roles.write': '管理账号与权限'
};
const META_LABELS = {
  count: '数量', format: '文件格式', queriedTenantId: '查询租户编号', username: '用户名',
  permissions: '权限', shopScopeMode: '店铺范围', shopIds: '店铺编号', status: '账号状态', preservedDocument: '保留的人工数据',
  attachmentId: '附件编号', type: '附件类型', size: '附件大小', emailConfigured: '邮件服务已配置', reason: '处理原因',
  provider: '物流商', rules: '渠道规则数量', sha256: '文件校验值', sourceUpdatedAt: '资费表更新时间',
  promoted: '已升级系统物流表', defaults: '默认渠道数量', defaultScheme: '默认物流方案', appliedMembers: '已同步子账号数量', userIds: '绑定用户ID',
  totalCategories: '三级类目总数', processedCategories: '已处理类目数', successfulCategories: '成功类目数', failedCategories: '失败类目数', requiredAttributes: '必填属性数', optionalAttributes: '可选属性数', totalAttributes: '属性总数', version: '合同版本'
};
const SENSITIVE_KEY = /password|secret|token|cookie|authorization|credential|api.?key|session/i;

function localizeValue(key, value) {
  if (SENSITIVE_KEY.test(key)) return '已隐藏';
  if (Array.isArray(value)) return value.map(item => key === 'permissions' ? (PERMISSION_LABELS[item] || '其他权限') : localizeValue('', item));
  if (value && typeof value === 'object') return localizeMetadata(value);
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key === 'shopScopeMode') return value === 'all' ? '全部店铺' : value === 'selected' ? '指定店铺' : '其他范围';
  if (key === 'status') return value === 'active' ? '启用' : value === 'disabled' ? '停用' : String(value || '未知状态');
  if (key === 'format') return value === 'csv' ? '表格文件' : '其他文件';
  if (key === 'type') return ({ 'image/jpeg': 'JPEG图片', 'image/png': 'PNG图片', 'image/gif': 'GIF图片', 'image/webp': 'WebP图片', 'video/mp4': 'MP4视频', 'video/webm': 'WebM视频', 'video/quicktime': 'MOV视频' })[value] || '其他附件';
  if (key === 'size') return String(Number(value) || 0) + ' 字节';
  if (key === 'reason') return ({ smtp_not_configured: '服务器尚未配置邮件服务', send_failed: '邮件发送失败' })[value] || String(value || '无');
  if (key === 'preservedDocument') return DOCUMENT_LABELS[value] || '人工维护数据';
  if (key === 'version') return value === 'deposit' ? '押金版' : value === 'no_deposit' ? '免押金版' : String(value || '未知版本');
  return value;
}

function localizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const output = {};
  let unknownIndex = 0;
  for (const [key, value] of Object.entries(metadata)) {
    const label = META_LABELS[key] || ('其他信息' + (++unknownIndex));
    output[label] = localizeValue(key, value);
  }
  return output;
}

function localizeResourceId(resourceType, resourceId) {
  const value = String(resourceId == null ? '' : resourceId);
  if (!value) return '';
  if (resourceType === 'session') return '已隐藏';
  if (resourceType === 'tenant_document') return DOCUMENT_LABELS[value] || '其他业务数据';
  if (resourceType === 'page') return PAGE_LABELS[value] || '其他页面';
  return value;
}

function localizeAuditEvent(event) {
  return Object.assign({}, event, {
    action: ACTION_LABELS[event.action] || '其他操作',
    resourceType: RESOURCE_LABELS[event.resourceType] || '其他资源',
    resourceId: localizeResourceId(event.resourceType, event.resourceId),
    result: RESULT_LABELS[event.result] || '未知结果',
    metadata: localizeMetadata(event.metadata)
  });
}

function formatMetadataValue(value) {
  if (Array.isArray(value)) return value.length ? value.map(formatMetadataValue).join('、') : '无';
  if (value && typeof value === 'object') return formatAuditMetadata(value);
  if (value == null || value === '') return '无';
  return String(value);
}

function formatAuditMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '无';
  const entries = Object.entries(metadata);
  if (!entries.length) return '无';
  return entries.map(([key, value]) => key + '：' + formatMetadataValue(value)).join('；');
}

module.exports = { localizeAuditEvent, localizeMetadata, localizeResourceId, formatAuditMetadata, ACTION_LABELS, RESOURCE_LABELS, RESULT_LABELS };
