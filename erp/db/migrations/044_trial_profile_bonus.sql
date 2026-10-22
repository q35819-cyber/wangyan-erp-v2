-- mem15（#免费体验 15+15，2026-09-21 用户直令“按15+15天的改”）：注册段 15 天 + 完善资料段 15 天，合计上限 30 天。
-- G-1：已执行迁移不得回改，故按“价格版本”规则发布 trial version_no=2、duration_days=15；
--      唯一索引 membership_plan_versions_published_uq 限定每个方案只有一个已发布版，必须先退休 v1。
--      v1 只置为 retired 不删除：历史 membership_periods.plan_version_id 以 ON DELETE RESTRICT 指向它，
--      所有读写路径都带 status='published'（listMembershipPlans / registerOwner / 发放路径），因此只影响新注册，
--      不改写任何历史 membership_periods 行。
--      valid_until 用 GREATEST 保证 CHECK (valid_until > valid_from) 在同秒执行的一次性测试库上也成立。
UPDATE membership_plan_versions
  SET status = 'retired',
      valid_until = GREATEST(valid_from + interval '1 second', now())
  WHERE plan_code = 'trial' AND version_no = 1;

-- 权益门禁键与 v1 完全一致（店铺1、每日上品10、收藏100、子账号0、AI编辑关闭），只把期限与完善资料赠送天数改为 15。
INSERT INTO membership_plan_versions
  (plan_code, version_no, name, currency, price_minor, duration_days, benefit_rank, status, public_visible, benefits)
VALUES
  ('trial', 2, '免费体验', 'CNY', 0, 15, 0, 'published', true,
   '{"shopLimit":1,"dailySkuLimit":10,"favoriteLimit":100,"childAccountLimit":0,"relist":true,"resell":false,"analytics":false,"aiEdit":false,"profileBonusDays":15}'::jsonb);

-- G-2：完善资料段的“每人只领一次”判据。本轮手机号只有正则格式校验、没有短信验证（用户 2026-09-21 决定），
--      经用户裁决改用“已验证邮箱”代替“已验证手机号”，故新增邮箱摘要列，不复用 verified_phone_hash（语义不同，旧列继续留给将来的短信验证）。
--      只加列加索引，不改 023 已有列与约束；旧行 verified_email_hash 为 NULL，不参与部分唯一索引。
ALTER TABLE membership_trial_claims
  ADD COLUMN verified_email_hash char(64);

ALTER TABLE membership_trial_claims
  ADD CONSTRAINT membership_trial_claims_email_hash_shape_chk
  CHECK (verified_email_hash IS NULL OR claim_type = 'profile_complete');

-- 同一个已验证邮箱在所有客户空间合计只能领取一次完善资料赠送（空哈希不参与）。
CREATE UNIQUE INDEX membership_trial_email_once_uq
  ON membership_trial_claims (verified_email_hash)
  WHERE claim_type = 'profile_complete' AND verified_email_hash IS NOT NULL;
