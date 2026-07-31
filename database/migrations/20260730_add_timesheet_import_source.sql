-- =============================================================================
-- Employee Self Timesheet — Phase 5: track whether an import batch came
-- from an Excel upload or a PMS sync, so confirmImport() knows whether to
-- re-parse the stored file or re-fetch from the PMS provider on confirm.
-- Every existing row defaults to 'excel' — fully backward-compatible.
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE timesheet_import_history
  ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'excel'
  CHECK (source IN ('excel', 'pms'));

COMMIT;
