-- =============================================================================
-- Rollback for 20260808_add_company_original_data_visibility.sql.
-- Revert src/models/Company.js, src/validations/companyValidation.js,
-- src/services/companyService.js, and src/utils/timesheetPublishPolicy.js
-- too if this rollback is meant to fully undo the feature, not just the
-- column.
-- =============================================================================

BEGIN;

ALTER TABLE companies DROP COLUMN IF EXISTS is_original_data_visible;

COMMIT;
