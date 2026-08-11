-- Rollback for 20260844_rename_head_manager_mappings_to_team_mappings.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_mappings' AND column_name = 'service_po_admin_user_id'
  ) THEN
    ALTER TABLE team_mappings RENAME COLUMN service_po_admin_user_id TO head_manager_user_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_team_mappings_not_self') THEN
    ALTER TABLE team_mappings RENAME CONSTRAINT chk_team_mappings_not_self TO chk_head_manager_mappings_not_self;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_team_mappings_manager') THEN
    ALTER INDEX uq_team_mappings_manager RENAME TO uq_head_manager_mappings_manager;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_team_mappings_service_po_admin_user_id') THEN
    ALTER INDEX idx_team_mappings_service_po_admin_user_id RENAME TO idx_head_manager_mappings_head_manager_user_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_team_mappings_company_id') THEN
    ALTER INDEX idx_team_mappings_company_id RENAME TO idx_head_manager_mappings_company_id;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_team_mappings_updated_at ON team_mappings;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'team_mappings') THEN
    ALTER TABLE team_mappings RENAME TO head_manager_mappings;
  END IF;
END $$;

CREATE TRIGGER trg_head_manager_mappings_updated_at BEFORE UPDATE ON head_manager_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
