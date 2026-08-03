-- =============================================================================
-- Backfill default service types for companies provisioned before
-- companyService.createWithAdmin() started seeding them (see that file for
-- the source-of-truth default list). Those companies already got their 3
-- default service_categories on creation, but nothing in service_types —
-- so every "create a service type" call for them either had to guess a
-- category ID (and typically guessed wrong / guessed another company's ID)
-- or had literally nothing to reference.
--
-- Resolves each company's own category IDs by NAME, never hardcoded —
-- every company has a different generated ID for "Billable" etc. Skips a
-- company already holding a given service type name (ON CONFLICT on
-- uq_service_types_company_name), so this is safe to re-run and safe for
-- companies that already have some/all of these.
--
-- created_at/updated_at are set explicitly to NOW() below rather than left
-- for a DB-level DEFAULT to fill in. This table's DEFAULT NOW() exists in
-- database/schema.sql's original CREATE TABLE and is present on any database
-- built from that file (e.g. a fresh local setup) — but Railway's actual
-- service_types.created_at/updated_at have no DEFAULT at all (confirmed by
-- this migration's first run there: "null value in column created_at
-- violates not-null constraint"), because those columns were retrofitted
-- there directly via a Sequelize model sync at some point instead of a
-- tracked migration — Sequelize manages timestamps at the application layer
-- and never adds a server-side DEFAULT for them. This is the same
-- local-vs-Railway drift already seen with the service_categories unique
-- index/constraint mismatch (20260803_ensure_service_categories_schema.sql)
-- and the service_category_id FK naming mismatch — so this migration both
-- works around it (explicit NOW()) and closes the gap for good (the
-- SET DEFAULT statements below) instead of relying on assumptions about
-- what the live schema already has.
-- =============================================================================

BEGIN;

-- Close the underlying gap so no future raw SQL against these two tables can
-- hit this same failure — safe/idempotent even where the default already
-- exists (locally) or the table doesn't have the column at all yet (won't
-- happen here, but IF EXISTS on the table guards it regardless).
ALTER TABLE IF EXISTS service_types      ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE IF EXISTS service_types      ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE IF EXISTS service_categories ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE IF EXISTS service_categories ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
DECLARE
  comp RECORD;
  cat_billable INT;
  cat_non_billable INT;
  cat_customer_non_billable INT;
  fallback_user INT;
BEGIN
  FOR comp IN SELECT id FROM companies WHERE is_deleted = false LOOP
    SELECT id INTO cat_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Billable' AND is_deleted = false
      LIMIT 1;

    SELECT id INTO cat_non_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Non-Billable' AND is_deleted = false
      LIMIT 1;

    SELECT id INTO cat_customer_non_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Customer Non-Billable' AND is_deleted = false
      LIMIT 1;

    -- created_by/updated_by are nullable — best-effort attribute to any user
    -- of this company, never blocks the insert if none is found.
    SELECT id INTO fallback_user FROM users WHERE company_id = comp.id ORDER BY id LIMIT 1;

    IF cat_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by, created_at, updated_at)
      VALUES
        (comp.id, 'Project',            cat_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Service Pack',       cat_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Staff Augmentation', cat_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'AMC',                cat_billable, fallback_user, fallback_user, NOW(), NOW())
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;

    IF cat_non_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by, created_at, updated_at)
      VALUES
        (comp.id, 'Internal Support', cat_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Team Management',  cat_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Leaves',           cat_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'L&D',              cat_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Others',           cat_non_billable, fallback_user, fallback_user, NOW(), NOW())
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;

    IF cat_customer_non_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by, created_at, updated_at)
      VALUES
        (comp.id, 'Customer Work',                              cat_customer_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Complimentary Hours',                        cat_customer_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Product/Solution/Framework Development',     cat_customer_non_billable, fallback_user, fallback_user, NOW(), NOW())
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;
  END LOOP;
END $$;

COMMIT;
