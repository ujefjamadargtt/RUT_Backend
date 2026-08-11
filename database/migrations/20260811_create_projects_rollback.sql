-- Rollback for 20260811_create_projects.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Must be run AFTER rolling back 20260812_add_service_pos_project_id.sql
-- (service_pos.project_id references this table).

BEGIN;

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
DROP TABLE IF EXISTS projects;

COMMIT;
