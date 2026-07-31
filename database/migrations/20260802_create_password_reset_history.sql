-- =============================================================================
-- Forgot Password module (User + Employee) — audit trail.
--
-- Append-only log (no updated_at, matches the existing audit_logs
-- convention) — one row per meaningful action, written even when the
-- submitted email does not resolve to any account (user_id/employee_id/
-- company_id left NULL), so enumeration attempts stay auditable without
-- ever revealing account existence to the caller.
--
-- Kept as its own file — see 20260801_create_password_reset_otps.sql's
-- note on why multi-table migration files were split apart in this feature.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS password_reset_history (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id),
  email VARCHAR(150) NOT NULL,
  login_type VARCHAR(10) CHECK (login_type IN ('user', 'employee')),
  user_id INT REFERENCES users(id),
  employee_id INT REFERENCES employees(id),
  action VARCHAR(30) NOT NULL CHECK (action IN (
    'OTP_SENT', 'OTP_RESENT', 'OTP_VERIFIED', 'OTP_FAILED',
    'PASSWORD_RESET', 'PASSWORD_RESET_FAILED'
  )),
  ip_address VARCHAR(45),
  user_agent TEXT,
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_history_email      ON password_reset_history (email);
CREATE INDEX IF NOT EXISTS idx_password_reset_history_company_id ON password_reset_history (company_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_history_action     ON password_reset_history (action);

COMMIT;
