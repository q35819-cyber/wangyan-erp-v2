-- 官方图片提示词增加"租户可读"开关：由系统管理员在 AI配置-图片提示词列表中直接勾选。
-- 关闭后，租户与子账号仍可在业务流程中使用该官方模板（服务端照常取正文），但列表与界面不显示正文，也不能复制为自定义。
-- 默认 true 与当前行为一致；开关是系统级设置，对所有租户生效。
ALTER TABLE ai_official_prompts ADD COLUMN IF NOT EXISTS tenant_readable boolean NOT NULL DEFAULT true;
