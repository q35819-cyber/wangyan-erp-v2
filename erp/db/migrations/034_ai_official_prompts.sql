-- 官方图片提示词入库：由系统管理员维护，全系统共用，租户与子账号只能选用、不能改写。
-- 提示词模板只保存图片提示词；商品文字提示词模板已按 2026-09-14 规则废止，不在此表恢复。
CREATE TABLE ai_official_prompts (
  official_key varchar(64) PRIMARY KEY,
  function_key varchar(64) NOT NULL CHECK (function_key IN ('image-redraw','image-translation','image-repair')),
  name varchar(120) NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 12000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  enabled boolean NOT NULL DEFAULT true,
  created_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_official_prompts_function_idx ON ai_official_prompts(function_key, enabled, official_key);

-- 初始官方词即用户已验收页面展示的"纯净白底商品图 / 自然场景展示图"两张官方卡片，之后由系统管理员在页面维护。
INSERT INTO ai_official_prompts (official_key, function_key, name, body) VALUES
  ('image-clean-white-base', 'image-redraw', '纯净白底商品图', '保留商品主体、颜色、结构与比例不变，背景替换为干净纯白，光线均匀柔和，阴影自然轻微，无杂物、无文字、无水印、无额外道具。'),
  ('image-natural-scene', 'image-redraw', '自然场景展示图', '保留商品事实、颜色、数量与比例不变，将商品放入真实自然的日常使用场景中，光线与环境协调，不过度装饰、不改变商品本身，不新增文字或水印。')
ON CONFLICT (official_key) DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_official_prompts TO wyerp_app;
