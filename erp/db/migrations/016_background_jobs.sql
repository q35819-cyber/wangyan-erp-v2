CREATE TABLE background_jobs (
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id VARCHAR(120) NOT NULL,
  actor_user_id BIGINT NOT NULL,
  job_type VARCHAR(40) NOT NULL CHECK (job_type ~ '^[a-z][a-z0-9_]{1,39}$'),
  dedupe_key VARCHAR(180) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'retry', 'done', 'failed', 'cancelled', 'unknown')),
  context JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(context) = 'object' AND octet_length(context::text) <= 65536),
  attempts SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  max_attempts SMALLINT NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 10),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner VARCHAR(120),
  lease_expires_at TIMESTAMPTZ,
  last_error VARCHAR(1500) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, job_id),
  FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX background_jobs_active_dedupe_idx
  ON background_jobs (tenant_id, job_type, dedupe_key)
  WHERE state IN ('queued', 'running', 'retry');

CREATE INDEX background_jobs_claim_idx
  ON background_jobs (available_at, created_at)
  WHERE state IN ('queued', 'retry', 'running');

GRANT SELECT, INSERT, UPDATE, DELETE ON background_jobs TO wyerp_app;
