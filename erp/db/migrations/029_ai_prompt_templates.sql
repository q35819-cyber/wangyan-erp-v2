CREATE TABLE ai_prompt_templates (
  id uuid PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  owner_user_id bigint NOT NULL,
  name varchar(120) NOT NULL,
  function_key varchar(64) NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 12000),
  enabled boolean NOT NULL DEFAULT true,
  official_key varchar(64) NOT NULL,
  official_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT
);

CREATE TABLE ai_prompt_selections (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  function_key varchar(64) NOT NULL,
  prompt_id uuid NOT NULL,
  updated_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, function_key),
  FOREIGN KEY (prompt_id, tenant_id) REFERENCES ai_prompt_templates(id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX ai_prompt_templates_tenant_function_idx ON ai_prompt_templates(tenant_id, function_key, enabled);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_prompt_templates, ai_prompt_selections TO wyerp_app;
