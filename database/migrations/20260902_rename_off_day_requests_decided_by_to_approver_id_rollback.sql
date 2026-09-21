-- Rollback for 20260902_rename_off_day_requests_decided_by_to_approver_id.sql.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'off_day_work_requests' AND column_name = 'approver_id'
  ) THEN
    ALTER TABLE off_day_work_requests RENAME COLUMN approver_id TO decided_by;
  END IF;
END $$;

COMMIT;
