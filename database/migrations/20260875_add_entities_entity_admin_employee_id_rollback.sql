-- Rollback for 20260875_add_entities_entity_admin_employee_id.sql
-- Not auto-run by the migration runner — apply manually if needed.

BEGIN;

ALTER TABLE entities DROP COLUMN IF EXISTS entity_admin_employee_id;

COMMIT;
