-- Rollback for 20260856_add_form_master_seq_and_modules.sql.
-- Removes every synthesized module row (and any role_form_mapping rows that
-- came to reference one), drops the seq column and its supporting
-- constraints/indexes, and restores module_name NOT NULL. Pre-existing
-- child form rows are untouched — they already carried a non-null
-- module_name before the migration ran.

BEGIN;

DROP INDEX IF EXISTS uq_form_master_module_row_name;
DROP INDEX IF EXISTS idx_form_master_seq;
ALTER TABLE form_master DROP CONSTRAINT IF EXISTS chk_form_master_seq_positive;

DELETE FROM role_form_mapping
WHERE form_id IN (SELECT id FROM form_master WHERE module_name IS NULL);

DELETE FROM form_master WHERE module_name IS NULL;

ALTER TABLE form_master DROP COLUMN IF EXISTS seq;
ALTER TABLE form_master ALTER COLUMN module_name SET NOT NULL;

COMMIT;
