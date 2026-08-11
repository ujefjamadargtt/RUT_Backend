-- =============================================================================
-- User Additional Roles — reintroduces multi-role support, but deliberately
-- NOT as a second authoritative source of truth (that's exactly what caused
-- the divergence bugs that led to dropping the old `user_roles` table — see
-- 20260840_collapse_user_roles.sql). users.role_id remains the SOLE source
-- of truth for hierarchy rank, company/entity scoping, senior-tier admin
-- bypass, and the role-creation matrix — nothing here ever competes with it
-- for those questions.
--
-- This table is a purely ADDITIVE capability grant: zero or more EXTRA
-- operational roles a user holds on top of their primary role, unioned only
-- into effective-capability checks (src/services/roleHierarchyService.js).
-- Restricted at the application layer (src/services/userService.js) to
-- operational roles only (never Platform Admin/Admin/Entity Admin/BU Admin)
-- — a role's hierarchy_rank can't be checked via a DB CHECK constraint
-- without a cross-table trigger, and this codebase has no precedent for
-- business-rule triggers (every existing trigger is a generic updated_at
-- bumper), so the rule lives in application code instead, matching how
-- ROLE_CREATION_MATRIX (a structurally identical rule) is also app-layer-only.
--
-- Named differently from the old, dropped `user_roles` table on purpose —
-- that table was authoritative and caused real bugs; this one never is.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_additional_roles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_additional_roles_user_role
  ON user_additional_roles (user_id, role_id);

CREATE INDEX IF NOT EXISTS idx_user_additional_roles_user_id
  ON user_additional_roles (user_id);

DROP TRIGGER IF EXISTS trg_user_additional_roles_updated_at ON user_additional_roles;
CREATE TRIGGER trg_user_additional_roles_updated_at BEFORE UPDATE ON user_additional_roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
