-- A-10-RBAC-CATALOG-T1: expand tenant permission catalog for business modules.
-- New permission rows are data, so a real migration is required.
INSERT INTO permissions (code, module, action, description) VALUES
  ('analytics.read', 'analytics', 'read', '查看店铺数据分析'),
  ('analytics.fetch', 'analytics', 'fetch', '获取天眼、Seerfar等外部分析数据'),
  ('selection.read', 'selection', 'read', '查看选品、大盘、榜单与标签数据'),
  ('selection.manage', 'selection', 'manage', '管理收藏、选品与选品数据'),
  ('collection.read', 'collection', 'read', '查看采集箱'),
  ('collection.write', 'collection', 'write', '新增、编辑和删除采集箱商品'),
  ('promotions.read', 'promotions', 'read', '查看促销活动与规则'),
  ('promotions.write', 'promotions', 'write', '管理促销活动与自动规则'),
  ('messages.read', 'messages', 'read', '查看消息模板与发送记录'),
  ('messages.write', 'messages', 'write', '管理消息模板与发送操作'),
  ('dashboard.read', 'dashboard', 'read', '查看数据大屏'),
  ('tools.use', 'tools', 'use', '使用定价、利润等业务工具')
ON CONFLICT (code) DO UPDATE SET
  module=EXCLUDED.module,
  action=EXCLUDED.action,
  description=EXCLUDED.description;

-- Tenant owners historically receive every permission. Keep that invariant when
-- new catalog rows are introduced after tenant creation.
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT r.tenant_id, r.id, p.code
FROM roles r
JOIN permissions p ON p.code IN (
  'analytics.read','analytics.fetch','selection.read','selection.manage',
  'collection.read','collection.write','promotions.read','promotions.write',
  'messages.read','messages.write','dashboard.read','tools.use'
)
WHERE r.code='owner'
ON CONFLICT DO NOTHING;

-- Compatibility: collection and selection pages previously inherited the
-- products.* permission in PAGE_PERMISSION. Preserve that exact historical
-- reach for existing custom/staff roles instead of broad-granting new modules.
INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT DISTINCT rp.tenant_id, rp.role_id, p.code
FROM role_permissions rp
JOIN permissions p ON p.code IN ('collection.read','selection.read')
WHERE rp.permission_code='products.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (tenant_id, role_id, permission_code)
SELECT DISTINCT rp.tenant_id, rp.role_id, p.code
FROM role_permissions rp
JOIN permissions p ON p.code IN ('collection.write','selection.manage')
WHERE rp.permission_code='products.write'
ON CONFLICT DO NOTHING;
