-- =============================================================================
-- Approver "Revert" / "Delete" of an APPROVED, not-yet-synced Employee Work Log.
--
-- Revert: approved -> pending, and the reason / who / when are kept on the row
--   itself (revert_reason, reverted_by, reverted_at), like the rejection_* columns.
-- Delete: the row is removed exactly as every other work-log delete is (hard delete);
--   its full snapshot + reason live on in audit_logs (action DELETE_APPROVED_LOG), so no
--   second history table is created. Both actions are audited there
--   (REVERT_APPROVED_LOG / DELETE_APPROVED_LOG).
-- The two e-mails reuse email_logs, whose mail_type CHECK must list the new types.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employee_work_logs
  ADD COLUMN IF NOT EXISTS revert_reason TEXT,
  ADD COLUMN IF NOT EXISTS reverted_by INTEGER,
  ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ;

ALTER TABLE email_logs DROP CONSTRAINT IF EXISTS email_logs_mail_type_check;
ALTER TABLE email_logs ADD CONSTRAINT email_logs_mail_type_check CHECK (mail_type IN (
  'PASSWORD_RESET_OTP', 'APPROVAL_REMINDER', 'WORKLOG_COMPLIANCE_REMINDER',
  'WORKLOG_APPROVED_REVERTED', 'WORKLOG_APPROVED_DELETED'
));

COMMIT;
