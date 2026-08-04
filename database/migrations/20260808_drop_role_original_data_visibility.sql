-- =============================================================================
-- Drops roles.is_original_data_visible (added by
-- 20260723_add_role_original_data_visibility.sql). is_original_data_visible
-- is now COMPANY-level only — see
-- database/migrations/20260808_add_company_original_data_visibility.sql and
-- src/utils/timesheetPublishPolicy.js. It was already removed from `users`
-- in the same round of work (a short-lived design, never reaching real
-- usage). Neither `roles` nor `users` carries this flag anymore; `companies`
-- is the single source of truth.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE roles DROP COLUMN IF EXISTS is_original_data_visible;

COMMIT;
