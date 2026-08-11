-- Rollback for 20260849_add_service_pos_delivery_head.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DROP INDEX IF EXISTS idx_service_pos_delivery_head_employee_id;
ALTER TABLE service_pos DROP COLUMN IF EXISTS delivery_head_employee_id;

COMMIT;
