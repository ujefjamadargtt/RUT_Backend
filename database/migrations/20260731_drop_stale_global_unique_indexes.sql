-- =============================================================================
-- Multi-Tenancy Retrofit — supplemental fix discovered during Phase 5.
--
-- Four GLOBAL partial-unique indexes exist on the live database that are
-- NOT present in any tracked migration file (database/schema.sql predates
-- them; they appear to have been added ad-hoc, outside migration tracking).
-- They enforce global (cross-company) uniqueness among active/non-deleted
-- rows, which directly contradicts the per-company composite unique
-- constraints added in 20260730_company_id_not_null_and_unique.sql — e.g.
-- idx_employees_code_active blocks two different companies from ever having
-- an employee with the same employee_code, even though
-- uq_employees_company_code (company_id, employee_code) already correctly
-- allows that. Discovered live: creating a second company's employee with a
-- code already used by an unrelated company's active employee failed with
-- "duplicate key value violates unique constraint idx_employees_code_active".
--
-- Each dropped index is fully superseded by the composite (company_id, code)
-- unique index already added in the prior migration — dropping these does
-- NOT reduce protection against duplicates within one company, it only
-- removes an incorrect cross-company restriction.
--
-- NOT touched (correct as-is, matches the "email stays globally unique"
-- design decision): idx_employees_email_active, employees_email_id_key.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_employees_code_active;
DROP INDEX IF EXISTS uq_service_pos_code_active;
DROP INDEX IF EXISTS uq_service_types_name_active;
DROP INDEX IF EXISTS uq_service_categories_name_active;
-- uq_service_categories_name is backed by a table CONSTRAINT (not a bare
-- index) — must be dropped via ALTER TABLE, not DROP INDEX.
ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS uq_service_categories_name;

COMMIT;
