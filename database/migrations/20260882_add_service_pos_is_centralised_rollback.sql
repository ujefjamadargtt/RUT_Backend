-- Rollback for 20260882_add_service_pos_is_centralised.sql
BEGIN;

ALTER TABLE service_pos
  DROP COLUMN IF EXISTS is_centralised;

COMMIT;
