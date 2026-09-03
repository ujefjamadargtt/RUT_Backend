-- =============================================================================
-- Email Logs — a single, application-wide audit trail of every outbound
-- email the backend sends (subject, full HTML body, recipient, mail type,
-- and whether the Company Email API actually accepted it), regardless of
-- WHICH feature triggered it (Forgot Password OTP, Approval Reminder, Work
-- Log Compliance Reminder, and any future email).
--
-- Append-only log (no updated_at), same convention as
-- password_reset_history (20260802_create_password_reset_history.sql) — one
-- row per send attempt, written for BOTH success and failure so a failed
-- delivery is never silently lost.
--
-- `mail_type` is intentionally its own free-standing column (not a foreign
-- key to anything) so a new email feature can start writing a new type
-- value immediately; the CHECK list below only needs a follow-up migration
-- to WIDEN (never to narrow — existing rows must keep validating).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS email_logs (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id),
  mail_type VARCHAR(40) NOT NULL CHECK (mail_type IN (
    'PASSWORD_RESET_OTP', 'APPROVAL_REMINDER', 'WORKLOG_COMPLIANCE_REMINDER'
  )),
  recipient_email VARCHAR(150) NOT NULL,
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(10) NOT NULL CHECK (status IN ('sent', 'failed')),
  error_message TEXT,
  -- The employee who triggered the send (e.g. clicked "Remind"). NULL for a
  -- system-triggered email with no acting employee (e.g. Forgot Password,
  -- which runs unauthenticated).
  triggered_by_employee_id INT REFERENCES employees(id),
  -- The employee the email is ABOUT/FOR, when applicable — e.g. on an
  -- Approval Reminder this is the employee whose work logs are pending
  -- (the email itself goes to their manager); on a Work Log Compliance
  -- Reminder this is the same person as the recipient. NULL when not
  -- applicable (e.g. Forgot Password OTP).
  related_employee_id INT REFERENCES employees(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_logs_recipient_email       ON email_logs (recipient_email);
CREATE INDEX IF NOT EXISTS idx_email_logs_mail_type             ON email_logs (mail_type);
CREATE INDEX IF NOT EXISTS idx_email_logs_company_id            ON email_logs (company_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_related_employee_id   ON email_logs (related_employee_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_created_at            ON email_logs (created_at);

COMMIT;
