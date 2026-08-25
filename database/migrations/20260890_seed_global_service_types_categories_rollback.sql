-- Rollback for 20260889_seed_global_service_types_categories.sql
--
-- Deletes ONLY the global (company_id IS NULL) rows this migration created.
-- Every existing per-BU service_categories/service_types row (company_id NOT
-- NULL) is untouched.

BEGIN;

DELETE FROM service_types WHERE company_id IS NULL;
DELETE FROM service_categories WHERE company_id IS NULL;

COMMIT;
