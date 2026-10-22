-- 阶段18-A：代理商会员码人工确认付款的首开/后续赠豆流水类型。
-- 仅扩展既有追加账本的受控枚举；不得修改、重算或补写历史流水。
ALTER TABLE ai_bean_events DROP CONSTRAINT ai_bean_events_event_type_check;
ALTER TABLE ai_bean_events ADD CONSTRAINT ai_bean_events_event_type_check
  CHECK (event_type IN ('welcome_gift','recharge','consume','freeze','release','refund','admin_adjust','agent_reward','agent_reward_reversal','membership_reward'));

CREATE INDEX activation_codes_agent_payment_pending_idx
  ON activation_codes (requested_at DESC, id DESC)
  WHERE issuance_type IN ('agent','agent_delegated') AND payment_confirmed_at IS NULL
    AND state IN ('used_temporary','payment_review','frozen');
