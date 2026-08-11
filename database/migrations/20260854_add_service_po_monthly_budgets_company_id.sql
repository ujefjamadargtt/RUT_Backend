-- =============================================================================
-- Follow-up to 20260853_create_service_po_monthly_budgets.sql — that
-- migration's CREATE TABLE was edited to add `company_id` AFTER it had
-- already been applied on some environments (the migration runner tracks
-- applied files by name, so re-editing an already-applied file is a no-op).
-- This adds the missing column + backfill + index so every environment
-- ends up with the same schema regardless of which version of the CREATE
-- TABLE it originally ran.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE service_po_monthly_budgets
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);

UPDATE service_po_monthly_budgets b
SET company_id = sp.company_id
FROM service_pos sp
WHERE sp.id = b.service_po_id
  AND b.company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_company_id
  ON service_po_monthly_budgets (company_id);

COMMIT;
