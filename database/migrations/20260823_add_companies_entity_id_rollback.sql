-- Rollback for 20260823_add_companies_entity_id.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP INDEX IF EXISTS idx_companies_entity_id;
ALTER TABLE companies DROP COLUMN IF EXISTS entity_id;

COMMIT;
