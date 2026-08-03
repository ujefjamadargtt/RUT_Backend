-- Migration: replace hardcoded "category name === 'Billable'" style string
-- comparisons with a data-driven column.
--
-- service_categories.report_bucket_key classifies each category into the
-- fixed set of output buckets the Dashboard/Analytics APIs already expose
-- (billable / non_billable / customer_non_billable). Those output field
-- names are a permanent API contract and are NOT changing — only how the
-- code decides which category maps to which bucket changes: from comparing
-- sc.name string literals to reading this column.
--
-- NULL means "no bucket" (falls into the existing "Other"/"Uncategorized"
-- catch-all everywhere that already exists) — so adding a brand new category
-- in the future needs no code change; it simply reports as Other until an
-- admin explicitly assigns it a bucket.
--
-- Backfill matches current live data exactly (verified before writing this
-- migration): id 1 "Billable" -> 'billable', id 2 "Non-Billable" ->
-- 'non_billable', id 3 "Customer Non-Billable" -> 'customer_non_billable'.
-- The soft-deleted "Test Billable" (id 6) is left NULL.
--
-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260721_add_service_category_report_bucket_key.sql

BEGIN;

ALTER TABLE IF EXISTS service_categories
  ADD COLUMN IF NOT EXISTS report_bucket_key VARCHAR(30);

-- DROP-then-ADD makes this re-runnable (ADD CONSTRAINT has no IF NOT EXISTS
-- form in Postgres) — matches the pattern used everywhere else in this repo.
ALTER TABLE IF EXISTS service_categories
  DROP CONSTRAINT IF EXISTS chk_service_categories_report_bucket_key;
ALTER TABLE IF EXISTS service_categories
  ADD CONSTRAINT chk_service_categories_report_bucket_key
  CHECK (report_bucket_key IS NULL OR report_bucket_key IN ('billable', 'non_billable', 'customer_non_billable'));

-- Guarded the same way the ALTERs above already are: on a brand-new
-- environment applying every migration in order for the first time (see
-- migrationRunner.js's hasPreRunnerMigrationHistory()), service_categories
-- doesn't exist yet at this point in the sequence — a bare UPDATE against it
-- would fail with "relation does not exist" instead of harmlessly no-op'ing
-- like the ALTERs above. There's nothing to backfill on such an environment
-- anyway (no categories exist yet to have a bucket key backfilled onto).
DO $$
BEGIN
  IF to_regclass('public.service_categories') IS NOT NULL THEN
    UPDATE service_categories SET report_bucket_key = 'billable'               WHERE LOWER(name) = 'billable';
    UPDATE service_categories SET report_bucket_key = 'non_billable'          WHERE LOWER(name) = 'non-billable';
    UPDATE service_categories SET report_bucket_key = 'customer_non_billable' WHERE LOWER(name) = 'customer non-billable';
  END IF;
END $$;

COMMIT;
