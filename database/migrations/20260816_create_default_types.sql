-- =============================================================================
-- Default Types Master — mirrors 20260815_create_default_categories.sql,
-- preserving companyService.js's DEFAULT_SERVICE_TYPES array content
-- verbatim, each resolved to its default_category_id by name (never a
-- hardcoded ID — same convention this codebase already uses everywhere
-- else category IDs are per-company).
--
-- Does NOT replace service_types — see 20260815's header comment for why.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS default_types (
  id SERIAL PRIMARY KEY,
  default_category_id INT NOT NULL REFERENCES default_categories (id),
  type_name VARCHAR(100) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_types_name ON default_types (type_name);
CREATE INDEX IF NOT EXISTS idx_default_types_category_id ON default_types (default_category_id);

DO $$
DECLARE
  cat_billable INT;
  cat_non_billable INT;
  cat_customer_non_billable INT;
BEGIN
  SELECT id INTO cat_billable FROM default_categories WHERE category_name = 'Billable';
  SELECT id INTO cat_non_billable FROM default_categories WHERE category_name = 'Non-Billable';
  SELECT id INTO cat_customer_non_billable FROM default_categories WHERE category_name = 'Customer Non-Billable';

  INSERT INTO default_types (default_category_id, type_name, display_order, status) VALUES
    (cat_billable, 'Project', 1, 'active'),
    (cat_billable, 'Service Pack', 2, 'active'),
    (cat_billable, 'Staff Augmentation', 3, 'active'),
    (cat_billable, 'AMC', 4, 'active'),
    (cat_non_billable, 'Internal Support', 5, 'active'),
    (cat_non_billable, 'Team Management', 6, 'active'),
    (cat_non_billable, 'Leaves', 7, 'active'),
    (cat_non_billable, 'L&D', 8, 'active'),
    (cat_non_billable, 'Others', 9, 'active'),
    (cat_customer_non_billable, 'Customer Work', 10, 'active'),
    (cat_customer_non_billable, 'Complimentary Hours', 11, 'active'),
    (cat_customer_non_billable, 'Product/Solution/Framework Development', 12, 'active')
  ON CONFLICT (type_name) DO NOTHING;
END $$;

COMMIT;
