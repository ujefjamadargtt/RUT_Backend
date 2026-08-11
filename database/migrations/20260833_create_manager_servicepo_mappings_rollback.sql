-- Rollback for 20260833_create_manager_servicepo_mappings.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_manager_servicepo_mappings_updated_at ON manager_servicepo_mappings;
DROP TABLE IF EXISTS manager_servicepo_mappings;

COMMIT;
