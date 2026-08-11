-- Rollback for 20260821_create_manager_mappings.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_manager_mappings_updated_at ON manager_mappings;
DROP TABLE IF EXISTS manager_mappings;

COMMIT;
