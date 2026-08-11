-- =============================================================================
-- Company Categories — mapping table recording which companies adopted
-- which default category (provenance bookkeeping), plus custom categories
-- a company creates itself (default_category_id NULL in that case).
--
-- Does NOT replace service_categories as the physical row every report/
-- dashboard/timesheet query reads — this table exists alongside it. See
-- companyService.js (seeding) and serviceCategoryService.js (custom
-- category creation) for how rows land here.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS company_categories (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies (id),
  default_category_id INT REFERENCES default_categories (id),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_categories_company_default
  ON company_categories (company_id, default_category_id)
  WHERE default_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_categories_company_id ON company_categories (company_id);

COMMIT;
