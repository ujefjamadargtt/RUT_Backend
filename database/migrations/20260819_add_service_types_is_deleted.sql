-- =============================================================================
-- Missing-migration fix: service_types.is_deleted.
--
-- src/models/ServiceType.js has declared this column all along, and the
-- application reads/writes it constantly (serviceTypeRepository.js's
-- findAll/findById/findByName/softDelete, reportRepository.js's PO/resource
-- report joins, serviceTypeService.js's create path) — but no tracked
-- migration or database/schema.sql ever added it to the database. Every
-- environment that has worked so far only did so because this column was
-- added out-of-band (the same drift pattern already documented in
-- 20260803_ensure_service_categories_schema.sql for service_categories and
-- 20260730_add_employee_password.sql for employees.email_id).
--
-- Discovered by actually running every migration against a genuinely empty
-- database: 20260819_backfill_company_category_type_mappings.sql reads
-- service_types.is_deleted and fails outright ("column t.is_deleted does not
-- exist") on any database where the out-of-band add never happened — i.e.
-- every fresh install. Named to sort alphabetically before that file (same
-- date) so it runs first.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE service_types ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

COMMIT;
