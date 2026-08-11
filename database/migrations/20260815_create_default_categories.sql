-- =============================================================================
-- Default Categories Master — the single, platform-wide master copy of the
-- category names every new company previously got hardcoded into
-- companyService.js's DEFAULT_SERVICE_CATEGORIES array. That array's
-- literal content is preserved here verbatim (name + display_order only —
-- report_bucket_key stays out of this table and remains a small hardcoded
-- lookup in companyService.js, since it's not part of the requested column
-- list and only matters at service_categories insert time).
--
-- IMPORTANT: this table does NOT replace service_categories — every report/
-- dashboard/timesheet/import query in this codebase continues reading
-- service_categories exactly as before (same rows, same IDs). This table
-- is the new seeding source for company creation (see companyService.js)
-- and the target of company_categories' mapping (see
-- 20260817_create_company_categories.sql).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS default_categories (
  id SERIAL PRIMARY KEY,
  category_name VARCHAR(100) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_categories_name ON default_categories (category_name);

INSERT INTO default_categories (category_name, display_order, status) VALUES
  ('Billable', 1, 'active'),
  ('Non-Billable', 2, 'active'),
  ('Customer Non-Billable', 3, 'active')
ON CONFLICT (category_name) DO NOTHING;

COMMIT;
