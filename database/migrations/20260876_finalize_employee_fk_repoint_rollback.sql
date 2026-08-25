-- Rollback for 20260876_finalize_employee_fk_repoint.sql
-- Not auto-run by the migration runner — apply manually if needed.
--
-- Best-effort only: recreates the old *_user_id columns (nullable, no data
-- — the original values are gone once dropped) so application code
-- expecting them doesn't hard-crash on missing columns. Does NOT restore
-- original data; restore from a backup taken before this migration ran if
-- the actual user_id values are needed back.

BEGIN;

ALTER TABLE manager_employee_mappings ADD COLUMN IF NOT EXISTS manager_user_id INT REFERENCES users (id);
ALTER TABLE manager_employee_mappings ALTER COLUMN manager_employee_id DROP NOT NULL;

ALTER TABLE manager_servicepo_mappings ADD COLUMN IF NOT EXISTS manager_user_id INT REFERENCES users (id);
ALTER TABLE manager_servicepo_mappings ALTER COLUMN manager_employee_id DROP NOT NULL;
DROP INDEX IF EXISTS uq_manager_servicepo_mappings;

ALTER TABLE team_mappings DROP CONSTRAINT IF EXISTS chk_team_mappings_not_self;
ALTER TABLE team_mappings ADD COLUMN IF NOT EXISTS manager_user_id INT REFERENCES users (id);
ALTER TABLE team_mappings ADD COLUMN IF NOT EXISTS service_po_admin_user_id INT REFERENCES users (id);
ALTER TABLE team_mappings ALTER COLUMN manager_employee_id DROP NOT NULL;
ALTER TABLE team_mappings ALTER COLUMN service_po_admin_employee_id DROP NOT NULL;
DROP INDEX IF EXISTS uq_team_mappings_manager;

ALTER TABLE entities ADD COLUMN IF NOT EXISTS entity_admin_user_id INT REFERENCES users (id);

COMMIT;
