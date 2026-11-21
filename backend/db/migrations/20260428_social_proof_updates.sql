-- 20260428_social_proof_updates.sql
-- Add display_name to contributions and social proof settings to campaigns

ALTER TABLE contributions ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS show_backer_amounts BOOLEAN DEFAULT TRUE;
