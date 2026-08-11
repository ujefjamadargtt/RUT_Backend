-- Rollback for 20260822_create_entities.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Must be run AFTER rolling back the companies.entity_id column.

BEGIN;

DROP TRIGGER IF EXISTS trg_entities_updated_at ON entities;
DROP TABLE IF EXISTS entities;

COMMIT;
