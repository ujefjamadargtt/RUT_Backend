-- =============================================================================
-- Employee Self Timesheet — Phase 1: session store for Employee refresh
-- tokens, mirroring user_sessions so Employee logins get the same
-- revocation/rotation behaviour as User logins. Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS employee_sessions (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees(id),
  refresh_token TEXT UNIQUE,
  expires_at TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_sessions_employee_id ON employee_sessions (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_sessions_refresh_token ON employee_sessions (refresh_token);

COMMIT;
