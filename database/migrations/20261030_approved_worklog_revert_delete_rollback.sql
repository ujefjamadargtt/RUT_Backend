-- Rollback for 20261030_approved_worklog_revert_delete.sql.
-- Any email_logs rows already written with the two new mail types must go first, or the old CHECK would fail.

BEGIN;

DELETE FROM email_logs WHERE mail_type IN ('WORKLOG_APPROVED_REVERTED', 'WORKLOG_APPROVED_DELETED');

ALTER TABLE email_logs DROP CONSTRAINT IF EXISTS email_logs_mail_type_check;
ALTER TABLE email_logs ADD CONSTRAINT email_logs_mail_type_check CHECK (mail_type IN (
  'PASSWORD_RESET_OTP', 'APPROVAL_REMINDER', 'WORKLOG_COMPLIANCE_REMINDER'
));

ALTER TABLE employee_work_logs
  DROP COLUMN IF EXISTS revert_reason,
  DROP COLUMN IF EXISTS reverted_by,
  DROP COLUMN IF EXISTS reverted_at;

COMMIT;
