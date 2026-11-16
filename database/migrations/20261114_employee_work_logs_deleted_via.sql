-- =============================================================================
-- Tells apart HOW a soft-deleted work log (employee_work_logs.deleted_at) was removed:
--   deleted_via = 'single'  -> removed one at a time (employee's DELETE /entries/:id, or an approver
--                              deleting an approved log)
--   deleted_via = NULL      -> swapped out by a whole-day / whole-month replace-save
-- GET /employee-timesheets/entries?include_deleted=true lists only the 'single' ones.
-- deleted_by = the employee who performed the delete (the owner, or the approving manager).
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs ADD COLUMN IF NOT EXISTS deleted_by INTEGER NULL;
ALTER TABLE employee_work_logs ADD COLUMN IF NOT EXISTS deleted_via VARCHAR(20) NULL;

COMMIT;
