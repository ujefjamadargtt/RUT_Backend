-- Rollback for 20260889_make_service_categories_and_types_company_id_nullable.sql
-- Fails if any global (company_id NULL) row exists — roll back
-- 20260890_seed_global_service_types_categories.sql first.
BEGIN;

ALTER TABLE service_types
  ALTER COLUMN company_id SET NOT NULL;

ALTER TABLE service_categories
  ALTER COLUMN company_id SET NOT NULL;

COMMIT;
