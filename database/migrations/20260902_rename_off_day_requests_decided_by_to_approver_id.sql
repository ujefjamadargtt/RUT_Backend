-- Off-Day Approval Gate — rename off_day_work_requests.decided_by to
-- approver_id, matching the field name the frontend's already-built
-- Weekend Requests feature actually calls it (see the consolidated
-- backend spec this migration was written against). Purely cosmetic —
-- the FK behavior (references employees(id)) is unaffected by a column
-- rename in Postgres.
--
-- Safe to re-run (guarded).

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'off_day_work_requests' AND column_name = 'decided_by'
  ) THEN
    ALTER TABLE off_day_work_requests RENAME COLUMN decided_by TO approver_id;
  END IF;
END $$;

COMMIT;
