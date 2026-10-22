CREATE TABLE tenant_documents (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  document_key varchar(100) NOT NULL,
  payload jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_user_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_key),
  FOREIGN KEY (tenant_id, updated_by_user_id)
    REFERENCES tenant_members(tenant_id, user_id) ON DELETE RESTRICT,
  CHECK (document_key ~ '^[a-z0-9_]{1,100}$')
);

CREATE INDEX tenant_documents_updated_idx
  ON tenant_documents (tenant_id, updated_at DESC, document_key);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_documents TO wyerp_app;
