-- =============================================================================
-- Adds companies.is_original_data_visible — this is the authoritative,
-- COMPANY-LEVEL field driving the Original Timesheet publish rule (see
-- src/utils/timesheetPublishPolicy.js). Supersedes the short-lived
-- users.is_original_data_visible design (added and immediately reverted in
-- the same round of work, never reaching real usage — see
-- src/models/User.js's git history) and the earlier
-- roles.is_original_data_visible-based resolution before that. Neither of
-- those is consulted by this policy anymore.
--
-- true  -> this company's users work with Original (unpublished) data first
--          (is_publish = false on rows their imports/syncs create).
-- false -> this company's users should always see published data
--          (is_publish = true on rows their imports/syncs create).
--
-- Defaults to false.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_original_data_visible BOOLEAN NOT NULL DEFAULT false;

COMMIT;
