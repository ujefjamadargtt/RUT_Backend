-- =============================================================================
-- Phase 1 of 3 for service_pos.project_id (mirrors the company_id retrofit
-- pattern at 20260728/29/30_*.sql): add the column NULLABLE first.
-- 20260813_backfill_service_pos_project_id.sql backfills every existing row,
-- then 20260814_service_pos_project_id_not_null.sql cuts over to NOT NULL.
-- Never attempt this as a single migration on a populated table.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE service_pos ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects (id);
CREATE INDEX IF NOT EXISTS idx_service_pos_project_id ON service_pos (project_id);

COMMIT;
