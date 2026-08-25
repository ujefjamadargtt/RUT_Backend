-- =============================================================================
-- Employee Work Log — Approve / Reject / Resubmit / Delete workflow.
--
-- Adds 'rejected' as a valid employee_work_logs.status value (alongside the
-- existing 'pending' / 'approved' / 'synced' — see
-- 20260852_add_approved_status_to_employee_work_logs.sql for that earlier
-- addition) plus the columns needed to carry a mandatory Manager remark
-- and who/when rejected it:
--
--   rejection_remark - the Manager's reason, required whenever status is
--                       set to 'rejected' (enforced in
--                       managerSelfServiceService.rejectWorkLogEntry /
--                       managerSelfServiceValidation.rejectWorkLogSchema,
--                       not by a DB constraint — mirrors how every other
--                       employee_work_logs business rule in this codebase
--                       lives at the service layer).
--   rejected_by       - the rejecting Manager's users.id (see
--                        EmployeeWorkLog.belongsTo(User, ..., as:
--                        'rejectedByUser') in src/models/index.js).
--   rejected_at       - when the rejection happened.
--
-- These three are deliberately NOT cleared when a rejected row is
-- resubmitted (status back to 'pending') — the most recent rejection stays
-- visible to the Employee even once the row is pending again; they are
-- only overwritten by a SUBSEQUENT rejection. Full history of every
-- reject/resubmit/approve action is additionally captured in the existing
-- audit_logs table (entity_type 'employee_work_logs') — no separate
-- history mechanism is introduced here.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS employee_work_logs_status_check;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT employee_work_logs_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'synced'));

ALTER TABLE employee_work_logs
  ADD COLUMN IF NOT EXISTS rejection_remark TEXT NULL,
  ADD COLUMN IF NOT EXISTS rejected_by INT NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP NULL;

COMMIT;
