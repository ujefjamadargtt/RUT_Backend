-- =============================================================================
-- Fix: the live `timesheet_import_history.file_path` column has always been
-- NOT NULL at the DB level (inherited from database/schema.sql's baseline —
-- this table predates a dedicated migration), even though the Sequelize
-- model (src/models/TimesheetImportHistory.js) has always declared
-- `allowNull: true`. Sequelize's `allowNull` is a validation-layer setting
-- only; it never alters physical DDL, so this drift went unnoticed until
-- the "Sync Employee Work Logs" flow — the first caller to legitimately
-- have no uploaded file — tried to insert file_path = NULL and hit the
-- real Postgres constraint.
--
-- NULL is the semantically correct value here ("no file exists for this
-- import"), matching how sub_project_id/timesheet_import_id already use
-- NULL elsewhere in this schema for "not applicable" — a synthetic
-- placeholder string would be misleading (it would look like a real path).
-- Excel imports are entirely unaffected: they always supply a real
-- file_path value regardless of what the column allows.
--
-- Safe to re-run (DROP NOT NULL is a no-op if already nullable).
-- =============================================================================

BEGIN;

ALTER TABLE timesheet_import_history ALTER COLUMN file_path DROP NOT NULL;

COMMIT;
