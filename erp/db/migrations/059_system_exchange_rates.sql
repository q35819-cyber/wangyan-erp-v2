CREATE TABLE IF NOT EXISTS system_exchange_rates (
  currency_pair text NOT NULL,
  rate_date date NOT NULL,
  rate numeric(18,8),
  source text NOT NULL DEFAULT 'bank_of_russia',
  fetch_status text NOT NULL CHECK (fetch_status IN ('success','failed')),
  last_error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (currency_pair, rate_date),
  CONSTRAINT system_exchange_rates_pair_chk CHECK (currency_pair ~ '^[A-Z]{3}_[A-Z]{3}$'),
  CONSTRAINT system_exchange_rates_value_chk CHECK (
    (fetch_status='success' AND rate IS NOT NULL AND rate > 0)
    OR (fetch_status='failed' AND rate IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS system_exchange_rates_success_date_idx
  ON system_exchange_rates(currency_pair, rate_date DESC)
  WHERE fetch_status='success';

GRANT SELECT, INSERT, UPDATE ON system_exchange_rates TO wyerp_app;
