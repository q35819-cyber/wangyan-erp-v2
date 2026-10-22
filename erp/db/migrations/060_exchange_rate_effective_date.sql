ALTER TABLE system_exchange_rates
  ADD COLUMN IF NOT EXISTS effective_date date;

UPDATE system_exchange_rates
SET effective_date = rate_date
WHERE fetch_status='success' AND effective_date IS NULL;

ALTER TABLE system_exchange_rates
  DROP CONSTRAINT IF EXISTS system_exchange_rates_effective_date_chk;
ALTER TABLE system_exchange_rates
  ADD CONSTRAINT system_exchange_rates_effective_date_chk CHECK (
    (fetch_status='success' AND effective_date IS NOT NULL AND effective_date <= rate_date)
    OR (fetch_status='failed' AND effective_date IS NULL)
  );
