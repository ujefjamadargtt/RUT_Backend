-- =============================================================================
-- BU Hierarchy / Sub-BU Support — companies self-reference.
--
-- Adds a purely additive, nullable self-FK to companies:
--   parent_business_unit_id INT REFERENCES companies(id)
--
-- NULL (the default for every existing row) means "this is a Parent/Main
-- BU" — zero behavior change for any existing Company. A non-NULL value
-- means "this Company is a Sub-BU of that parent." Depth is capped at 2
-- levels (Parent BU -> Sub-BU); enforced in companyService.js, not here —
-- a Sub-BU can never itself be given children.
--
-- Employee<->BU mapping needs no schema change: employee_business_units
-- already maps employee_id to ANY companies.id, Sub-BU included.
-- Safe to re-run (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
-- =============================================================================

BEGIN;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS parent_business_unit_id INT REFERENCES companies (id);

CREATE INDEX IF NOT EXISTS idx_companies_parent_business_unit_id
  ON companies (parent_business_unit_id);

COMMIT;
