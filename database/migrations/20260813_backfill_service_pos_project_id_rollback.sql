-- Rollback for 20260813_backfill_service_pos_project_id.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Only undoes the auto-created "Default Project" assignments — any Service
-- PO a user has since manually reassigned to a different real Project is
-- left untouched (this only targets rows still pointing at a
-- 'PRJ-DEFAULT-%' project).

BEGIN;

UPDATE service_pos sp
  SET project_id = NULL
  FROM projects p
  WHERE sp.project_id = p.id AND p.project_code LIKE 'PRJ-DEFAULT-%';

DELETE FROM projects WHERE project_code LIKE 'PRJ-DEFAULT-%';

COMMIT;
