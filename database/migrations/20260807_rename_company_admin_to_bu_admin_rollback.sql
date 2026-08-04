-- =============================================================================
-- Rollback for 20260807_rename_company_admin_to_bu_admin.sql.
-- Reverts application code's roleRepository.js/authorize.js/companyService.js
-- string references back to "Company Admin" too if this rollback is meant to
-- fully undo the rename, not just the data.
-- =============================================================================

BEGIN;

UPDATE roles
SET role_name = 'Company Admin', updated_at = NOW()
WHERE role_name = 'BU Admin';

COMMIT;
