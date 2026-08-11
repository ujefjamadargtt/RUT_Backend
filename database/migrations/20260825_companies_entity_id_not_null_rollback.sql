-- Rollback for 20260825_companies_entity_id_not_null.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

ALTER TABLE companies ALTER COLUMN entity_id DROP NOT NULL;

COMMIT;
