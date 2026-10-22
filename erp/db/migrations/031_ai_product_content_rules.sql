-- 系统管理员维护的商品内容规则：一条全局规则 + 六项单项规则，全系统共用，不按租户复制。
-- 只有数据库 is_system_admin=true 的账号可读写；租户与子账号不读取规则正文，规则只在服务端参与提示词组装。
CREATE TABLE ai_product_content_rules (
  rule_key varchar(32) PRIMARY KEY CHECK (rule_key IN ('global','title','tags','summary','richTitle','richDescription','sellingPoints')),
  name varchar(80) NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 12000),
  enabled boolean NOT NULL DEFAULT true,
  updated_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 初始内容即用户已验收静态页展示的七条文案，仅作为可编辑的默认值，不是代码固定禁词。
INSERT INTO ai_product_content_rules (rule_key, name, body) VALUES
  ('global', '商品内容全局规则', '所有内容必须忠于商品来源事实，保留数字和单位，不编造品牌、性能、认证、价格、促销或无法验证的承诺。'),
  ('title', '商品标题规则', '准确、清晰，突出品类与关键规格。'),
  ('tags', '标签规则', '使用相关、可检索的中文短语。'),
  ('summary', '商品简介规则', '简洁说明用途与已知商品事实。'),
  ('sellingPoints', '卖点提炼规则', '不把推测或主观话术包装成事实。'),
  ('richTitle', '图文标题规则', '短句表达，每张图聚焦一个主题。'),
  ('richDescription', '图文描述规则', '与对应图片和已知属性保持一致。')
ON CONFLICT (rule_key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE ON ai_product_content_rules TO wyerp_app;
