-- Rollback for 20260819_backfill_company_category_type_mappings.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Removes every mapping row that originated from a default (leaves any
-- custom, default_*_id-NULL rows created via the app untouched).

BEGIN;

DELETE FROM company_types WHERE default_type_id IS NOT NULL;
DELETE FROM company_categories WHERE default_category_id IS NOT NULL;

COMMIT;
