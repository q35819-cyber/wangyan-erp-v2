-- AI 用户界面偏好：按 租户+用户 保存少量非敏感界面选择，当前只有“费用通道”（billing-channel: official/own）。
-- 服务端对 key/value 做白名单校验；通道是否真的可用、是否允许扣费，仍以任务提交时的服务端校验为准，
-- 偏好本身不授予任何权限。浏览器另用 localStorage 做即时缓存，每次打开仍以本表为准在后台核对。
CREATE TABLE ai_user_ui_preferences (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pref_key varchar(64) NOT NULL,
  pref_value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, pref_key)
);

GRANT SELECT, INSERT, UPDATE ON ai_user_ui_preferences TO wyerp_app;
