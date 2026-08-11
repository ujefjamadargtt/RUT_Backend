-- Rollback for 20260831_create_head_manager_mappings.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_head_manager_mappings_updated_at ON head_manager_mappings;
DROP TABLE IF EXISTS head_manager_mappings;

COMMIT;
