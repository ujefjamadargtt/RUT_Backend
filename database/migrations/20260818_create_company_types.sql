-- =============================================================================
-- Company Types — mapping table recording which companies adopted which
-- default type (provenance bookkeeping), plus custom types a company
-- creates itself (default_type_id NULL in that case). Linked to
-- company_categories (not directly to companies) per the requested schema —
-- a company type always belongs to one of that same company's category
-- mappings.
--
-- Does NOT replace service_types as the physical row every report/
-- dashboard/timesheet/import query reads — this table exists alongside it.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS company_types (
  id SERIAL PRIMARY KEY,
  company_category_id INT NOT NULL REFERENCES company_categories (id),
  default_type_id INT REFERENCES default_types (id),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_types_category_default
  ON company_types (company_category_id, default_type_id)
  WHERE default_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_types_company_category_id ON company_types (company_category_id);

COMMIT;
