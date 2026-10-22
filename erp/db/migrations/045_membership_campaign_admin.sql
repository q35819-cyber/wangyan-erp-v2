-- 会员节假日活动管理员手工维护：只开放最小必要写权限，不允许业务角色 DELETE 历史活动。
GRANT SELECT, INSERT, UPDATE ON membership_campaigns TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE membership_campaigns_id_seq TO wyerp_app;
