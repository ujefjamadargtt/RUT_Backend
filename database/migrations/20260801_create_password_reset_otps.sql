-- =============================================================================
-- Forgot Password module (User + Employee) — OTP storage.
--
-- One row per OTP issued. `otp` stores a bcrypt HASH, never plaintext
-- (Phase 8 allows this; a DB read can never expose a live, usable OTP).
-- login_type/user_id/employee_id mirror the same User-vs-Employee
-- resolution already used by /auth/login — exactly one of user_id/
-- employee_id is populated per row.
--
-- NOTE: kept as its own single-table file (not combined with
-- password_reset_history) — this migration runner executes each file as
-- one raw multi-statement query, and a second CREATE TABLE further down
-- the same file was observed to silently not apply even though no error
-- was raised. One table per migration file is also the convention every
-- other migration in this project already follows.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS password_reset_otps (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id),
  login_type VARCHAR(10) NOT NULL CHECK (login_type IN ('user', 'employee')),
  user_id INT REFERENCES users(id),
  employee_id INT REFERENCES employees(id),
  email VARCHAR(150) NOT NULL,
  otp VARCHAR(255) NOT NULL,
  purpose VARCHAR(30) NOT NULL DEFAULT 'password_reset',
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'used')),
  attempt_count INT NOT NULL DEFAULT 0,
  verified_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_ip VARCHAR(45),
  created_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_otps_email        ON password_reset_otps (email);
CREATE INDEX IF NOT EXISTS idx_password_reset_otps_email_status ON password_reset_otps (email, status);
CREATE INDEX IF NOT EXISTS idx_password_reset_otps_company_id   ON password_reset_otps (company_id);

DROP TRIGGER IF EXISTS trg_password_reset_otps_updated_at ON password_reset_otps;
CREATE TRIGGER trg_password_reset_otps_updated_at BEFORE UPDATE ON password_reset_otps
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
