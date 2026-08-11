-- Rollback for 20260842_employees_drop_login_columns.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Restores column/table structure only — original password hashes and
-- refresh tokens are not recoverable.

BEGIN;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS password VARCHAR(255);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS email_id VARCHAR(150);
CREATE INDEX IF NOT EXISTS idx_employees_email_id ON employees (email_id);

CREATE TABLE IF NOT EXISTS employee_sessions (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees (id),
  refresh_token TEXT UNIQUE,
  expires_at TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_sessions_employee_id ON employee_sessions (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_sessions_refresh_token ON employee_sessions (refresh_token);

COMMIT;
