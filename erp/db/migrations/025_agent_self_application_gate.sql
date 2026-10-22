ALTER TABLE billing_settings
  ADD COLUMN agent_self_application_enabled boolean NOT NULL DEFAULT false;
