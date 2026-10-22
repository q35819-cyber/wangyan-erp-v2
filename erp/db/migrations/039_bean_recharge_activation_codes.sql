-- mem01（#44/#46/#47，2026-09-19 调度与用户裁决确认）：AI豆充值激活码 + 代理商整万返佣。
-- 激活码扩类型：benefit_type 区分会员码与AI豆充值码；豆码不绑会员方案、必须携带豆面额（1..1000000，1豆=1分口径由服务端收款核对使用）。
-- 会员码保持原形状：必须绑方案且无豆面额；存量行 default 'membership' 自动满足条件约束。
ALTER TABLE activation_codes
  ALTER COLUMN plan_version_id DROP NOT NULL,
  ADD COLUMN benefit_type varchar(24) NOT NULL DEFAULT 'membership'
    CHECK (benefit_type IN ('membership', 'bean_recharge')),
  ADD COLUMN bean_amount integer
    CHECK (bean_amount IS NULL OR bean_amount BETWEEN 1 AND 1000000);

ALTER TABLE activation_codes
  ADD CONSTRAINT activation_codes_benefit_shape_check CHECK (
    (benefit_type = 'membership' AND plan_version_id IS NOT NULL AND bean_amount IS NULL)
    OR (benefit_type = 'bean_recharge' AND plan_version_id IS NULL AND bean_amount IS NOT NULL)
  );

-- 豆账本流水类型扩展：agent_reward=发放豆码时按整万口径计入代理商余额的返佣（平台侧出资，direction credit）；
-- agent_reward_reversal=豆码在核销前被作废或24小时自动过期时对代理商的同额扣回（direction debit）。
-- 记账仍走既有账户行 FOR UPDATE + (tenant_id,idempotency_key) UNIQUE + append-only 触发器，核心扣账逻辑不变。
ALTER TABLE ai_bean_events DROP CONSTRAINT ai_bean_events_event_type_check;
ALTER TABLE ai_bean_events ADD CONSTRAINT ai_bean_events_event_type_check
  CHECK (event_type IN ('welcome_gift','recharge','consume','freeze','release','refund','admin_adjust','agent_reward','agent_reward_reversal'));
