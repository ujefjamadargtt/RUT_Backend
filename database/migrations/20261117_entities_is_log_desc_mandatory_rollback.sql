BEGIN;
ALTER TABLE entities DROP COLUMN IF EXISTS is_log_desc_mandatory;
COMMIT;
