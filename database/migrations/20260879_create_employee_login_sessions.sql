-- =============================================================================
-- Employee-as-Identity Redesign — Phase 13: employee_login_sessions.
--
-- Refresh-token store for Employee-based login, mirroring user_sessions'
-- final shape (jti/family_id rotation + replay detection, added to
-- user_sessions by 20260857_add_refresh_token_rotation.sql) from day one.
-- Deliberately NOT named `employee_sessions` — that name belonged to the
-- earlier Employee-direct-login attempt dropped by
-- 20260842_employees_drop_login_columns.sql, and reusing it would blur the
-- two designs; this is a fresh table for a fresh (if similarly-shaped)
-- mechanism.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS employee_login_sessions (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  jti VARCHAR(36),
  family_id VARCHAR(36),
  refresh_token VARCHAR(500) NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_jti VARCHAR(36),
  expires_at TIMESTAMP NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_login_sessions_employee_id ON employee_login_sessions (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_login_sessions_jti
  ON employee_login_sessions (jti) WHERE jti IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employee_login_sessions_family_id ON employee_login_sessions (family_id);
CREATE INDEX IF NOT EXISTS idx_employee_login_sessions_jti_revoked_at ON employee_login_sessions (jti, revoked_at);

DROP TRIGGER IF EXISTS trg_employee_login_sessions_updated_at ON employee_login_sessions;
CREATE TRIGGER trg_employee_login_sessions_updated_at BEFORE UPDATE ON employee_login_sessions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
