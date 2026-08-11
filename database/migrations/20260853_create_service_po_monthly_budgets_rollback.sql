-- Rollback for 20260853_create_service_po_monthly_budgets.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP TRIGGER IF EXISTS trg_service_po_monthly_budgets_updated_at ON service_po_monthly_budgets;
DROP TABLE IF EXISTS service_po_monthly_budgets;

COMMIT;
