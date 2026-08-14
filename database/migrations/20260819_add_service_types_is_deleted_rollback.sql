-- Rollback for 20260819_add_service_types_is_deleted.sql.
-- Only safe if nothing has written non-default is_deleted data yet — check
-- before running against a database with real soft-deleted service types.

BEGIN;

ALTER TABLE service_types DROP COLUMN IF EXISTS is_deleted;

COMMIT;
