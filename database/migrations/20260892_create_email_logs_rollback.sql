-- Rollback for 20260892_create_email_logs.sql
-- Run manually if needed — the migration runner never picks this up
-- automatically (see migrationRunner.js's *_rollback.sql exclusion).

DROP TABLE IF EXISTS email_logs;
