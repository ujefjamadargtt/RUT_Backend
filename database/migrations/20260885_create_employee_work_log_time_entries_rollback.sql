-- Rollback for 20260885_create_employee_work_log_time_entries.sql
-- Run manually if this feature needs to be undone. Drops the table outright
-- (CASCADE drops its own trigger/indexes/constraints with it) — this is a
-- brand-new table, so there is no pre-existing data to preserve.

BEGIN;

DROP TABLE IF EXISTS employee_work_log_time_entries CASCADE;

DELETE FROM schema_migrations WHERE name = '20260885_create_employee_work_log_time_entries.sql';

COMMIT;
