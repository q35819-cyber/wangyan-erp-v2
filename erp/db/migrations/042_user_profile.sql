-- 基础信息栏（2026-09-21 用户直令：点头像打开居中大面板，可填姓名/手机号/邮箱/公司或店铺名称/性别/个性签名）。
-- 归属选择：邮箱与登录账号后续要改成邮箱登录，姓名/手机号/性别/签名都是“人”的属性，因此放在按 user_id 主键的 user_profiles，
-- 不放进按租户复制的 tenant_members——系统管理员会作为成员出现在客户租户里，若把姓名写进 tenant_members 会改掉他在别人空间里的显示名。
-- tenant_members.display_name 继续作为“本空间显示名”，只在调用方确实是该空间主账号时由本表同步，保证身份卡与子账号列表一致。
-- 手机号本轮按用户决定“暂不验证”，故不设 verified_at 之类的空列；将来做短信验证时再新增版本化迁移。
-- 邮箱必须验证后才算绑定：验证码只存 SHA-256 摘要，明文邮箱在 user_profiles 中只在验证通过时写入。
CREATE TABLE user_profiles (
  user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name varchar(120) NOT NULL DEFAULT '',
  phone varchar(40) NOT NULL DEFAULT '',
  email varchar(240) NOT NULL DEFAULT '',
  email_verified_at timestamptz,
  gender varchar(10) NOT NULL DEFAULT '' CHECK (gender IN ('', 'male', 'female')),
  signature varchar(200) NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email = '' OR email_verified_at IS NOT NULL)
);

-- 将来邮箱登录要求邮箱全局唯一；空串不参与唯一约束，避免多个未填邮箱的账号互相冲突。
CREATE UNIQUE INDEX user_profiles_email_lower_uq ON user_profiles (lower(email)) WHERE email <> '';

GRANT SELECT, INSERT, UPDATE ON user_profiles TO wyerp_app;

-- 邮箱验证码：一次申请一行，只追加不改写业务结论；验证通过写 verified_at。
-- code_hash 为 6 位数字码的 SHA-256 摘要，不保存明文验证码；expires_at 由服务端权威时间判断。
CREATE TABLE user_email_verifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email varchar(240) NOT NULL,
  code_hash char(64) NOT NULL,
  attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_email_verifications_user_time_idx
  ON user_email_verifications (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON user_email_verifications TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE user_email_verifications_id_seq TO wyerp_app;
