-- Rollback for 20260878_relax_audit_trail_user_fks.sql
-- Not auto-run by the migration runner — apply manually if needed.
-- Restores the FK constraints (values are still intact, since only the
-- constraint was dropped, not the column) — will fail if `users` has since
-- been truncated, since the referenced rows would no longer exist.

BEGIN;

ALTER TABLE role_migration_log
  ADD CONSTRAINT role_migration_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE password_reset_otps
  ADD CONSTRAINT password_reset_otps_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE password_reset_history
  ADD CONSTRAINT password_reset_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES users (id);

ALTER TABLE timesheet_import_history
  ADD CONSTRAINT fk_tih_imported_by FOREIGN KEY (imported_by) REFERENCES users (id);

-- notifications/user_sessions data is not recoverable once truncated.

COMMIT;
