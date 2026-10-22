-- 普通用户邀请注册与AI豆奖励：长期邀请码、终身唯一邀请关系、奖励/扣回账本类型。
-- 普通邀请体系与代理商奖励完全隔离；代理商身份只在应用层作为资格门禁，不复制代理返佣逻辑。

ALTER TABLE ai_bean_events DROP CONSTRAINT ai_bean_events_event_type_check;
ALTER TABLE ai_bean_events ADD CONSTRAINT ai_bean_events_event_type_check
  CHECK (event_type IN (
    'welcome_gift','recharge','consume','freeze','release','refund','admin_adjust',
    'agent_reward','agent_reward_reversal','membership_reward',
    'referral_signup_reward','referral_paid_reward','referral_reward_reversal'
  ));

CREATE TABLE referral_codes (
  inviter_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  inviter_tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  code varchar(16) NOT NULL UNIQUE CHECK (code ~ '^WY[A-F0-9]{10}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inviter_user_id, inviter_tenant_id)
);

-- 给迁移时已经存在的普通主账号生成稳定邀请码。
-- md5 这里只用于不可读的展示编号，不承担密码/Token安全职责。
INSERT INTO referral_codes(inviter_user_id, inviter_tenant_id, code)
SELECT tm.user_id, tm.tenant_id,
       'WY' || upper(substr(md5('wyerp-referral-v1:' || tm.user_id::text || ':' || tm.tenant_id::text || ':' || u.created_at::text),1,10))
FROM tenant_members tm
JOIN users u ON u.id=tm.user_id
JOIN tenants t ON t.id=tm.tenant_id
WHERE tm.member_type='owner' AND tm.status='active'
  AND u.status='active' AND u.is_system_admin=false AND t.status='active'
  AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.tenant_id=tm.tenant_id)
ON CONFLICT (inviter_user_id, inviter_tenant_id) DO NOTHING;

CREATE TABLE user_referrals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inviter_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  inviter_tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  invitee_user_id bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  invitee_tenant_id bigint NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  invitee_email_hash char(64) NOT NULL UNIQUE CHECK (invitee_email_hash ~ '^[a-f0-9]{64}$'),
  referral_code varchar(16) NOT NULL REFERENCES referral_codes(code) ON DELETE RESTRICT,
  signup_reward_event_id bigint NOT NULL UNIQUE REFERENCES ai_bean_events(id) ON DELETE RESTRICT,
  first_paid_period_id bigint UNIQUE REFERENCES membership_periods(id) ON DELETE RESTRICT,
  first_paid_activation_code_id bigint REFERENCES activation_codes(id) ON DELETE RESTRICT,
  paid_reward_event_id bigint UNIQUE REFERENCES ai_bean_events(id) ON DELETE RESTRICT,
  paid_reward_reversal_event_id bigint UNIQUE REFERENCES ai_bean_events(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_rewarded_at timestamptz,
  paid_reward_reversed_at timestamptz,
  CHECK (inviter_user_id <> invitee_user_id),
  CHECK (
    (paid_reward_event_id IS NULL AND first_paid_period_id IS NULL AND paid_rewarded_at IS NULL)
    OR
    (paid_reward_event_id IS NOT NULL AND first_paid_period_id IS NOT NULL AND paid_rewarded_at IS NOT NULL)
  ),
  CHECK (
    (paid_reward_reversal_event_id IS NULL AND paid_reward_reversed_at IS NULL)
    OR
    (paid_reward_reversal_event_id IS NOT NULL AND paid_reward_event_id IS NOT NULL AND paid_reward_reversed_at IS NOT NULL)
  )
);

CREATE INDEX user_referrals_inviter_idx ON user_referrals(inviter_tenant_id, inviter_user_id, id DESC);
CREATE INDEX user_referrals_paid_period_idx ON user_referrals(first_paid_period_id) WHERE first_paid_period_id IS NOT NULL;
CREATE INDEX user_referrals_paid_activation_idx ON user_referrals(first_paid_activation_code_id) WHERE first_paid_activation_code_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_user_referral_identity() RETURNS trigger AS $referral_guard$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'user_referrals lifetime binding cannot be deleted';
  END IF;
  IF NEW.inviter_user_id IS DISTINCT FROM OLD.inviter_user_id
     OR NEW.inviter_tenant_id IS DISTINCT FROM OLD.inviter_tenant_id
     OR NEW.invitee_user_id IS DISTINCT FROM OLD.invitee_user_id
     OR NEW.invitee_tenant_id IS DISTINCT FROM OLD.invitee_tenant_id
     OR NEW.invitee_email_hash IS DISTINCT FROM OLD.invitee_email_hash
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code
     OR NEW.signup_reward_event_id IS DISTINCT FROM OLD.signup_reward_event_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'user_referrals lifetime identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$referral_guard$ LANGUAGE plpgsql;

CREATE TRIGGER trg_user_referrals_identity_immutable
  BEFORE UPDATE OR DELETE ON user_referrals
  FOR EACH ROW EXECUTE FUNCTION protect_user_referral_identity();

GRANT SELECT, INSERT ON referral_codes TO wyerp_app;
GRANT SELECT, INSERT, UPDATE ON user_referrals TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE user_referrals_id_seq TO wyerp_app;
