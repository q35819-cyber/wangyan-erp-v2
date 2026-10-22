-- AI 豆：租户级虚拟币账户与不可变流水。
-- 定价规则：1 元 = 100 豆；AI 图片处理（生成/翻译/重绘/修复）10 豆/张；AI 普通文字翻译免费。
-- 金额一律整数豆记账，禁止浮点；所有变动在事务内对账户行 SELECT ... FOR UPDATE 串行化，
-- 并以 (tenant_id, idempotency_key) 唯一约束保证重试/并发不重复扣款。
CREATE TABLE ai_bean_accounts (
  tenant_id bigint PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
  balance_bean bigint NOT NULL DEFAULT 0 CHECK (balance_bean >= 0),
  frozen_bean bigint NOT NULL DEFAULT 0 CHECK (frozen_bean >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 流水只允许追加，不提供 UPDATE/DELETE 业务入口。
-- freeze：余额 → 冻结（提交任务时）；consume：冻结扣减（出图成功结算）；
-- release：冻结退回余额（失败/处理中放弃）；refund：事后补偿入余额。
CREATE TABLE ai_bean_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  event_type varchar(24) NOT NULL CHECK (event_type IN ('welcome_gift','recharge','consume','freeze','release','refund','admin_adjust')),
  direction varchar(8) NOT NULL CHECK (direction IN ('credit','debit')),
  amount_bean bigint NOT NULL CHECK (amount_bean > 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  frozen_after bigint NOT NULL CHECK (frozen_after >= 0),
  idempotency_key varchar(160) NOT NULL,
  business_ref varchar(160) NOT NULL DEFAULT '',
  reason varchar(500) NOT NULL DEFAULT '',
  actor_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX ai_bean_events_tenant_time_idx ON ai_bean_events (tenant_id, id DESC);

-- 流水只追加：业务角色只能 SELECT/INSERT，UPDATE/DELETE 由触发器直接拒绝（含库属主之外的直改）。
CREATE OR REPLACE FUNCTION ai_bean_events_append_only() RETURNS trigger AS $ai_bean_append$
BEGIN
  RAISE EXCEPTION 'ai_bean_events is append-only';
END;
$ai_bean_append$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ai_bean_events_no_update
  BEFORE UPDATE ON ai_bean_events
  FOR EACH ROW EXECUTE FUNCTION ai_bean_events_append_only();
CREATE TRIGGER trg_ai_bean_events_no_delete
  BEFORE DELETE ON ai_bean_events
  FOR EACH ROW EXECUTE FUNCTION ai_bean_events_append_only();

GRANT SELECT, INSERT, UPDATE ON ai_bean_accounts TO wyerp_app;
GRANT SELECT, INSERT ON ai_bean_events TO wyerp_app;
GRANT USAGE, SELECT ON SEQUENCE ai_bean_events_id_seq TO wyerp_app;
