-- 代理商专属邀请：只记录邀请与资格抵扣事实，不发普通邀请AI豆奖励。
-- 抵扣消费继续落在 agent_monthly_stats.metadata / agent_qualification_events，避免第二套资格任务系统。

CREATE TABLE agent_referrals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inviter_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  inviter_tenant_id bigint NOT NULL REFERENCES agents(tenant_id) ON DELETE RESTRICT,
  invitee_user_id bigint NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  invitee_tenant_id bigint NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  invitee_email_hash char(64) NOT NULL UNIQUE CHECK (invitee_email_hash ~ '^[a-f0-9]{64}$'),
  referral_code varchar(16) NOT NULL REFERENCES referral_codes(code) ON DELETE RESTRICT,
  paid_credit_source_kind varchar(24) CHECK (paid_credit_source_kind IN ('membership','bean_recharge')),
  paid_credit_source_id bigint,
  paid_credit_granted_at timestamptz,
  paid_credit_reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (inviter_user_id <> invitee_user_id),
  CHECK (
    (paid_credit_source_kind IS NULL AND paid_credit_source_id IS NULL AND paid_credit_granted_at IS NULL AND paid_credit_reversed_at IS NULL)
    OR
    (paid_credit_source_kind IS NOT NULL AND paid_credit_source_id IS NOT NULL AND paid_credit_granted_at IS NOT NULL)
  )
);

CREATE INDEX agent_referrals_inviter_idx ON agent_referrals(inviter_tenant_id, inviter_user_id, id DESC);
CREATE UNIQUE INDEX agent_referrals_paid_source_uq
  ON agent_referrals(paid_credit_source_kind, paid_credit_source_id)
  WHERE paid_credit_source_kind IS NOT NULL AND paid_credit_source_id IS NOT NULL;

-- 已存在的有效代理商主账号也获得稳定邀请码；已有普通邀请码则直接复用，不制造第二个码。
INSERT INTO referral_codes(inviter_user_id, inviter_tenant_id, code)
SELECT a.owner_user_id, a.tenant_id,
       'WY' || upper(substr(md5('wyerp-agent-referral-v1:' || a.owner_user_id::text || ':' || a.tenant_id::text || ':' || a.created_at::text),1,10))
FROM agents a
JOIN users u ON u.id=a.owner_user_id
JOIN tenants t ON t.id=a.tenant_id
JOIN tenant_members tm ON tm.tenant_id=a.tenant_id AND tm.user_id=a.owner_user_id
WHERE a.status='active' AND u.status='active' AND u.is_system_admin=false
  AND t.status='active' AND tm.member_type='owner' AND tm.status='active'
ON CONFLICT (inviter_user_id, inviter_tenant_id) DO NOTHING;

CREATE OR REPLACE FUNCTION protect_agent_referral_identity() RETURNS trigger AS $agent_referral_guard$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'agent_referrals lifetime binding cannot be deleted';
  END IF;
  IF NEW.inviter_user_id IS DISTINCT FROM OLD.inviter_user_id
     OR NEW.inviter_tenant_id IS DISTINCT FROM OLD.inviter_tenant_id
     OR NEW.invitee_user_id IS DISTINCT FROM OLD.invitee_user_id
     OR NEW.invitee_tenant_id IS DISTINCT FROM OLD.invitee_tenant_id
     OR NEW.invitee_email_hash IS DISTINCT FROM OLD.invitee_email_hash
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_referrals lifetime identity fields are immutable';
  END IF;
  RETURN NEW;
END;
$agent_referral_guard$ LANGUAGE plpgsql;

CREATE TRIGGER trg_agent_referrals_identity_immutable
  BEFORE UPDATE OR DELETE ON agent_referrals
  FOR EACH ROW EXECUTE FUNCTION protect_agent_referral_identity();

GRANT SELECT, INSERT, UPDATE ON agent_referrals TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE agent_referrals_id_seq TO wyerp_app;
