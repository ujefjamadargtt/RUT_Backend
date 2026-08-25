-- =============================================================================
-- Seed ONE global (company_id IS NULL) Service Category / Service Type set.
--
-- Type and Category are becoming platform-wide masters instead of being
-- duplicated per Business Unit (Company) at BU-creation time — see
-- companyService.js's create(), which is being changed in the same
-- rollout to stop seeding a private copy for every new BU.
--
-- This migration is purely ADDITIVE: it inserts exactly one new global row
-- per active default_categories/default_types row (company_id = NULL —
-- already a nullable column, see 20260803_ensure_service_categories_schema.sql
-- and 20260728_add_company_tenancy_schema.sql). It does NOT touch, backfill,
-- or delete any of the existing per-BU service_categories/service_types rows
-- (each existing Business Unit's own historical copy, and every existing
-- service_pos.service_type_id FK pointing at one of them, is left completely
-- untouched) — those simply stop being reachable through the
-- ServiceType/ServiceCategory APIs once the application-layer change lands,
-- without any data loss.
--
-- Idempotent/re-runnable: each INSERT...SELECT is guarded by a NOT EXISTS
-- check against "does a global (company_id IS NULL) row already exist" so a
-- second run is a no-op.
-- =============================================================================

BEGIN;

INSERT INTO service_categories (company_id, name, status, report_bucket_key, is_deleted, created_at, updated_at)
SELECT
  NULL,
  dc.category_name,
  'active',
  CASE dc.category_name
    WHEN 'Billable' THEN 'billable'
    WHEN 'Non-Billable' THEN 'non_billable'
    WHEN 'Customer Non-Billable' THEN 'customer_non_billable'
    ELSE NULL
  END,
  false,
  NOW(),
  NOW()
FROM default_categories dc
WHERE dc.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM service_categories WHERE company_id IS NULL);

INSERT INTO service_types (company_id, service_type_name, service_category_id, is_deleted, created_at, updated_at)
SELECT
  NULL,
  dt.type_name,
  gc.id,
  false,
  NOW(),
  NOW()
FROM default_types dt
JOIN default_categories dc ON dc.id = dt.default_category_id
JOIN service_categories gc ON gc.company_id IS NULL AND gc.name = dc.category_name
WHERE dt.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM service_types WHERE company_id IS NULL);

COMMIT;
