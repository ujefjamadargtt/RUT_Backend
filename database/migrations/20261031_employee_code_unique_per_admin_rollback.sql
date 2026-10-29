-- Rollback for 20261031_employee_code_unique_per_admin.sql
-- Restores the per-company unique constraint (fails if two tenants now share a code inside one company).
BEGIN;
DROP INDEX IF EXISTS uq_employees_admin_code;
DROP INDEX IF EXISTS idx_employees_admin_id;
ALTER TABLE employees DROP COLUMN IF EXISTS admin_id;
ALTER TABLE employees ADD CONSTRAINT uq_employees_company_code UNIQUE (company_id, employee_code);
COMMIT;
