-- Rollback for 20260854_add_service_po_monthly_budgets_company_id.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP INDEX IF EXISTS idx_service_po_monthly_budgets_company_id;
ALTER TABLE service_po_monthly_budgets DROP COLUMN IF EXISTS company_id;

COMMIT;
