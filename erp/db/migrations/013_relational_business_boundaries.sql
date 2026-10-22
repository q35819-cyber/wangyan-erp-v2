CREATE TABLE business_data_versions (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_key varchar(100) NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  payload_shape varchar(10) NOT NULL CHECK (payload_shape IN ('array', 'object', 'scalar')),
  updated_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_key)
);

CREATE TABLE business_orders (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_key varchar(240) NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  posting_number varchar(180),
  shop_external_id varchar(120),
  platform_source varchar(30) NOT NULL CHECK (platform_source = 'ozon'),
  platform_record_id varchar(240) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_key)
);

CREATE INDEX business_orders_shop_idx ON business_orders (tenant_id, shop_external_id, position);
CREATE INDEX business_orders_posting_idx ON business_orders (tenant_id, posting_number);

CREATE TABLE business_products (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  record_key varchar(240) NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  offer_id varchar(180),
  shop_external_id varchar(120),
  platform_source varchar(30) NOT NULL CHECK (platform_source = 'ozon'),
  platform_record_id varchar(240) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  updated_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_key)
);

CREATE INDEX business_products_shop_idx ON business_products (tenant_id, shop_external_id, position);
CREATE INDEX business_products_offer_idx ON business_products (tenant_id, offer_id);

CREATE TABLE product_costs (
  tenant_id bigint NOT NULL,
  product_record_key varchar(240) NOT NULL,
  purchase_amount numeric(20, 4),
  source_amount numeric(20, 4),
  domestic_shipping_amount numeric(20, 4),
  currency char(3) NOT NULL DEFAULT 'CNY',
  supplier_url text,
  supplier_note varchar(1000),
  updated_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, product_record_key),
  FOREIGN KEY (tenant_id, product_record_key) REFERENCES business_products(tenant_id, record_key) ON DELETE CASCADE,
  CHECK (supplier_url IS NULL OR supplier_url LIKE 'https://%')
);

CREATE TABLE financial_records (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_key varchar(100) NOT NULL CHECK (document_key IN ('erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1')),
  record_key varchar(240) NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  order_record_key varchar(240),
  platform_source varchar(30) NOT NULL CHECK (platform_source = 'ozon'),
  platform_record_id varchar(240) NOT NULL,
  payload jsonb NOT NULL,
  updated_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_key, record_key)
);

CREATE INDEX financial_records_order_idx ON financial_records (tenant_id, order_record_key, document_key);

CREATE TABLE finance_settings (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  setting_key varchar(100) NOT NULL CHECK (setting_key IN ('erp_rate', 'erp_fee_manual')),
  value jsonb NOT NULL,
  updated_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, setting_key)
);

CREATE TABLE bug_reports (
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id varchar(90) NOT NULL,
  created_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title varchar(120) NOT NULL,
  severity varchar(20) NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, report_id)
);

CREATE INDEX bug_reports_owner_idx ON bug_reports (tenant_id, created_by_user_id, created_at DESC);

CREATE TABLE bug_attachments (
  tenant_id bigint NOT NULL,
  report_id varchar(90) NOT NULL,
  attachment_id uuid NOT NULL,
  created_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  original_name varchar(160) NOT NULL,
  stored_name varchar(100) NOT NULL,
  media_type varchar(80) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, attachment_id),
  UNIQUE (tenant_id, report_id, stored_name),
  FOREIGN KEY (tenant_id, report_id) REFERENCES bug_reports(tenant_id, report_id) ON DELETE CASCADE
);

/* Historical draft retained for review only. P2 data movement is deliberately
   excluded from schema migration: backup and reconciliation gates must run
   before any legacy row is copied, and no legacy row may be deleted here.
INSERT INTO business_data_versions (tenant_id, document_key, version, payload_shape, updated_by_user_id, updated_at)
SELECT td.tenant_id, td.document_key, td.version,
       CASE jsonb_typeof(td.payload) WHEN 'array' THEN 'array' WHEN 'object' THEN 'object' ELSE 'scalar' END,
       COALESCE(td.updated_by_user_id, (SELECT tm.user_id FROM tenant_members tm WHERE tm.tenant_id = td.tenant_id AND tm.status = 'active' ORDER BY tm.member_type = 'owner' DESC, tm.created_at LIMIT 1)),
       td.updated_at
FROM tenant_documents td
WHERE td.document_key IN ('erp_orders_data', 'erp_online_products', 'erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1', 'erp_rate', 'erp_fee_manual', 'erp_bug_reports');

INSERT INTO business_orders (tenant_id, record_key, position, posting_number, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id, updated_at)
SELECT td.tenant_id,
       left(COALESCE(NULLIF(item->>'posting',''), NULLIF(item->>'posting_number',''), NULLIF(item->>'id',''), 'row') || '::legacy-' || ordinality, 240),
       ordinality - 1, left(COALESCE(item->>'posting', item->>'posting_number'), 180), left(COALESCE(item->>'clientId', item->>'shopId'), 120),
       'ozon', left(COALESCE(NULLIF(item->>'posting',''), NULLIF(item->>'posting_number',''), NULLIF(item->>'id',''), 'legacy-' || ordinality), 240),
       (item - 'platformSource' - 'sourcePlatform' - 'platformRecordId' - 'sourceRecordId' - 'platformSyncedAt') ||
         jsonb_build_object('platformSource', 'ozon', 'platformRecordId', left(COALESCE(NULLIF(item->>'posting',''), NULLIF(item->>'posting_number',''), NULLIF(item->>'id',''), 'legacy-' || ordinality), 240)),
       COALESCE(td.updated_by_user_id, (SELECT tm.user_id FROM tenant_members tm WHERE tm.tenant_id = td.tenant_id AND tm.status = 'active' ORDER BY tm.member_type = 'owner' DESC, tm.created_at LIMIT 1)), td.updated_at
FROM tenant_documents td
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(td.payload) = 'array' THEN td.payload ELSE '[]'::jsonb END) WITH ORDINALITY AS rows(item, ordinality)
WHERE td.document_key = 'erp_orders_data';

INSERT INTO business_products (tenant_id, record_key, position, offer_id, shop_external_id, platform_source, platform_record_id, payload, updated_by_user_id, updated_at)
SELECT td.tenant_id,
       left(COALESCE(NULLIF(item->>'id',''), NULLIF(item->>'productId',''), NULLIF(item->>'sku',''), NULLIF(item->>'article',''), 'row') || '::legacy-' || ordinality, 240),
       ordinality - 1, left(COALESCE(item->>'offer_id', item->>'article', item->>'sku'), 180), left(COALESCE(item->>'clientId', item->>'shopId'), 120),
       'ozon', left(COALESCE(NULLIF(item->>'id',''), NULLIF(item->>'productId',''), NULLIF(item->>'sku',''), NULLIF(item->>'article',''), 'legacy-' || ordinality), 240),
       (((item - 'platformSource' - 'sourcePlatform' - 'platformRecordId' - 'sourceRecordId' - 'platformSyncedAt') ||
         jsonb_build_object('platformSource', 'ozon', 'platformRecordId', left(COALESCE(NULLIF(item->>'id',''), NULLIF(item->>'productId',''), NULLIF(item->>'sku',''), NULLIF(item->>'article',''), 'legacy-' || ordinality), 240))) -
         CASE WHEN COALESCE(item->>'srcUrl','') ~* '^https://([a-z0-9-]+\.)*1688\.com(?::[0-9]+)?(?:[/?#]|$)' THEN '__keep__' ELSE 'srcUrl' END) -
         CASE WHEN COALESCE(item->>'sourceUrl','') ~* '^https://([a-z0-9-]+\.)*1688\.com(?::[0-9]+)?(?:[/?#]|$)' THEN '__keep__' ELSE 'sourceUrl' END,
       COALESCE(td.updated_by_user_id, (SELECT tm.user_id FROM tenant_members tm WHERE tm.tenant_id = td.tenant_id AND tm.status = 'active' ORDER BY tm.member_type = 'owner' DESC, tm.created_at LIMIT 1)), td.updated_at
FROM tenant_documents td
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(td.payload) = 'array' THEN td.payload ELSE '[]'::jsonb END) WITH ORDINALITY AS rows(item, ordinality)
WHERE td.document_key = 'erp_online_products';

INSERT INTO product_costs (tenant_id, product_record_key, purchase_amount, source_amount, domestic_shipping_amount, supplier_url, supplier_note, updated_by_user_id, updated_at)
SELECT product.tenant_id, product.record_key,
       CASE WHEN product.payload->>'purchasePrice' ~ '^-?[0-9]+(?:\.[0-9]+)?$' THEN (product.payload->>'purchasePrice')::numeric END,
       CASE WHEN product.payload->>'srcPrice' ~ '^-?[0-9]+(?:\.[0-9]+)?$' THEN (product.payload->>'srcPrice')::numeric END,
       CASE WHEN product.payload->>'domesticShipping' ~ '^-?[0-9]+(?:\.[0-9]+)?$' THEN (product.payload->>'domesticShipping')::numeric END,
       NULLIF(product.payload->>'srcUrl',''), left(product.payload->>'srcNote', 1000), product.updated_by_user_id, product.updated_at
FROM business_products product;

INSERT INTO financial_records (tenant_id, document_key, record_key, position, order_record_key, platform_source, platform_record_id, payload, updated_by_user_id, updated_at)
SELECT td.tenant_id, td.document_key, left(entry.record_key, 240), entry.position,
       left(COALESCE(entry.payload->>'posting', entry.payload->>'posting_number'), 240), 'ozon', left(entry.record_key, 240),
       CASE WHEN jsonb_typeof(entry.payload) = 'object' THEN
         (entry.payload - 'platformSource' - 'sourcePlatform' - 'platformRecordId' - 'sourceRecordId' - 'platformSyncedAt') || jsonb_build_object('platformSource','ozon','platformRecordId',left(entry.record_key,240))
       ELSE entry.payload END,
       COALESCE(td.updated_by_user_id, (SELECT tm.user_id FROM tenant_members tm WHERE tm.tenant_id = td.tenant_id AND tm.status = 'active' ORDER BY tm.member_type = 'owner' DESC, tm.created_at LIMIT 1)), td.updated_at
FROM tenant_documents td
CROSS JOIN LATERAL (
  SELECT key AS record_key, row_number() OVER (ORDER BY key)::integer - 1 AS position, value AS payload
  FROM jsonb_each(CASE WHEN jsonb_typeof(td.payload) = 'object' THEN td.payload ELSE '{}'::jsonb END)
  UNION ALL
  SELECT 'legacy-' || ordinality, ordinality::integer - 1, value
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(td.payload) = 'array' THEN td.payload ELSE '[]'::jsonb END) WITH ORDINALITY AS items(value, ordinality)
  UNION ALL
  SELECT 'value', 0, td.payload WHERE jsonb_typeof(td.payload) NOT IN ('object','array')
) entry
WHERE td.document_key IN ('erp_accruals_data', 'erp_acquiring_data', 'erp_amount_fix_v1');

INSERT INTO finance_settings (tenant_id, setting_key, value, updated_by_user_id, updated_at)
SELECT td.tenant_id, td.document_key, td.payload,
       COALESCE(td.updated_by_user_id, (SELECT tm.user_id FROM tenant_members tm WHERE tm.tenant_id = td.tenant_id AND tm.status = 'active' ORDER BY tm.member_type = 'owner' DESC, tm.created_at LIMIT 1)), td.updated_at
FROM tenant_documents td WHERE td.document_key IN ('erp_rate', 'erp_fee_manual');

INSERT INTO bug_reports (tenant_id, report_id, created_by_user_id, title, severity, payload, created_at, updated_at)
SELECT td.tenant_id, left(item->>'id', 90),
       COALESCE(td.updated_by_user_id, (SELECT tm.user_id FROM tenant_members tm WHERE tm.tenant_id = td.tenant_id AND tm.status = 'active' ORDER BY tm.member_type = 'owner' DESC, tm.created_at LIMIT 1)),
       left(COALESCE(NULLIF(item->>'title',''), '未命名反馈'), 120),
       CASE WHEN item->>'severity' IN ('high','medium','low') THEN item->>'severity' ELSE 'medium' END,
       item - 'id' - 'createdBy' - 'attachments' - 'createdAt',
       CASE WHEN item->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T' THEN (item->>'createdAt')::timestamptz ELSE td.updated_at END, td.updated_at
FROM tenant_documents td
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(td.payload) = 'array' THEN td.payload ELSE '[]'::jsonb END) AS reports(item)
WHERE td.document_key = 'erp_bug_reports' AND item->>'id' ~ '^BUG-[A-Z0-9-]{6,80}$';

INSERT INTO bug_attachments (tenant_id, report_id, attachment_id, created_by_user_id, original_name, stored_name, media_type, size_bytes, created_at)
SELECT br.tenant_id, br.report_id, (attachment->>'id')::uuid, br.created_by_user_id,
       left(COALESCE(NULLIF(attachment->>'name',''), '附件'), 160), regexp_replace(attachment->>'url', '^.+/', ''),
       left(COALESCE(attachment->>'type','application/octet-stream'), 80),
       GREATEST(1, CASE WHEN COALESCE(attachment->>'size', '') ~ '^[0-9]+$' THEN (attachment->>'size')::bigint ELSE 1 END), br.created_at
FROM tenant_documents td
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(td.payload) = 'array' THEN td.payload ELSE '[]'::jsonb END) AS reports(report)
JOIN bug_reports br ON br.tenant_id = td.tenant_id AND br.report_id = report->>'id'
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(report->'attachments') = 'array' THEN report->'attachments' ELSE '[]'::jsonb END) AS attachments(attachment)
WHERE attachment->>'id' ~* '^[a-f0-9-]{36}$'
  AND regexp_replace(attachment->>'url', '^.+/', '') ~* '^[a-f0-9-]{36}\.(jpg|png|gif|webp|mp4|webm|mov)$';

-- No legacy deletion is permitted in a schema migration.
*/

GRANT SELECT, INSERT, UPDATE, DELETE ON business_data_versions, business_orders, business_products, product_costs,
  financial_records, finance_settings, bug_reports, bug_attachments TO wyerp_app;
