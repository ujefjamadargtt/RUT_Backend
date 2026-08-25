-- =============================================================================
-- Type and Category are becoming global masters instead of per-Business-Unit
-- data (see database/migrations/20260890_seed_global_service_types_categories.sql,
-- applied right after this one) — the global rows use `company_id = NULL`.
--
-- Both models (src/models/ServiceCategory.js, src/models/ServiceType.js)
-- already declare `company_id: { allowNull: true }`, but the live database
-- still enforces NOT NULL on both tables — the same drift
-- 20260887_make_clients_company_id_nullable.sql /
-- 20260888_make_service_pos_company_id_nullable.sql already fixed for
-- clients/service_pos. This is that same fix for service_categories and
-- service_types.
-- =============================================================================

BEGIN;

ALTER TABLE service_categories
  ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE service_types
  ALTER COLUMN company_id DROP NOT NULL;

COMMIT;
