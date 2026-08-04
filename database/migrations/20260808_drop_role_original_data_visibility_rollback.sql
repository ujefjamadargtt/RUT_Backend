-- =============================================================================
-- Rollback for 20260808_drop_role_original_data_visibility.sql.
-- Restores the column with its original default (false) — any per-role
-- values previously set are NOT recoverable (DROP COLUMN is destructive).
-- Revert src/models/Role.js, src/validations/roleValidation.js,
-- src/repositories/rbacRepository.js, src/repositories/userRepository.js,
-- src/repositories/authRepository.js, and src/middlewares/auth.js too if
-- this rollback is meant to fully undo the removal, not just the column.
-- =============================================================================

BEGIN;

ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_original_data_visible BOOLEAN NOT NULL DEFAULT false;

COMMIT;
