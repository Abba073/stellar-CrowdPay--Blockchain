-- Add Soroban contract ID fields to campaigns
ALTER TABLE campaigns ADD COLUMN escrow_contract_id TEXT;
ALTER TABLE campaigns ADD COLUMN milestones_contract_id TEXT;

-- Add contract fields to milestones table if needed (to store on-chain status/index)
ALTER TABLE milestones ADD COLUMN contract_index INTEGER;

-- Enforce StrKey contract ID format (^C[0-9A-Z]{55}$) on non-null contract IDs.
-- Added NOT VALID first so existing rows are not blocked, then validated so
-- invalid IDs cannot be persisted even outside the API path.
ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_escrow_contract_id_strkey_check
  CHECK (escrow_contract_id IS NULL OR escrow_contract_id ~ '^C[0-9A-Z]{55}$') NOT VALID;

ALTER TABLE campaigns
  ADD CONSTRAINT campaigns_milestones_contract_id_strkey_check
  CHECK (milestones_contract_id IS NULL OR milestones_contract_id ~ '^C[0-9A-Z]{55}$') NOT VALID;

ALTER TABLE campaigns VALIDATE CONSTRAINT campaigns_escrow_contract_id_strkey_check;
ALTER TABLE campaigns VALIDATE CONSTRAINT campaigns_milestones_contract_id_strkey_check;