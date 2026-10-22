CREATE TABLE IF NOT EXISTS ai_pricing_config (
  singleton_key text PRIMARY KEY CHECK (singleton_key = 'default'),
  image_original_bean integer NOT NULL DEFAULT 30 CHECK (image_original_bean BETWEEN 1 AND 100000000),
  image_discount_bean integer NOT NULL DEFAULT 10 CHECK (image_discount_bean BETWEEN 0 AND 100000000),
  analysis_original_bean integer NOT NULL DEFAULT 10 CHECK (analysis_original_bean BETWEEN 1 AND 100000000),
  analysis_discount_bean integer NOT NULL DEFAULT 0 CHECK (analysis_discount_bean BETWEEN 0 AND 100000000),
  updated_by_user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ai_pricing_config(singleton_key)
VALUES ('default')
ON CONFLICT (singleton_key) DO NOTHING;

GRANT SELECT, UPDATE ON ai_pricing_config TO wyerp_app;

