-- =============================================================================
-- RBAC Redesign — Phase 11: Head Manager -> Service PO Admin.
--
-- The "Head Manager" role is removed (see 20260838/20260839) — Service PO
-- Admin now directly owns/creates Manager accounts and the team they
-- manage. Repurposes the existing head_manager_mappings table (BU
-- Admin -> Head Manager -> Manager delegation) into team_mappings
-- (Service PO Admin -> Manager, one hop shorter), keeping its exact
-- 1-Head-Manager-per-... err, 1-Service-PO-Admin-per-Manager cardinality
-- (unique index on manager_user_id alone).
--
-- Wrapped in existence-checking DO blocks so this is safe to re-run even
-- after the rename has already happened once (plain RENAME statements
-- would otherwise error the second time, since Postgres 14 doesn't support
-- `RENAME COLUMN/CONSTRAINT IF EXISTS`).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'head_manager_mappings') THEN
    ALTER TABLE head_manager_mappings RENAME TO team_mappings;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_mappings' AND column_name = 'head_manager_user_id'
  ) THEN
    ALTER TABLE team_mappings RENAME COLUMN head_manager_user_id TO service_po_admin_user_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_head_manager_mappings_not_self'
  ) THEN
    ALTER TABLE team_mappings RENAME CONSTRAINT chk_head_manager_mappings_not_self TO chk_team_mappings_not_self;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_head_manager_mappings_manager') THEN
    ALTER INDEX uq_head_manager_mappings_manager RENAME TO uq_team_mappings_manager;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_head_manager_mappings_head_manager_user_id') THEN
    ALTER INDEX idx_head_manager_mappings_head_manager_user_id RENAME TO idx_team_mappings_service_po_admin_user_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_head_manager_mappings_company_id') THEN
    ALTER INDEX idx_head_manager_mappings_company_id RENAME TO idx_team_mappings_company_id;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_head_manager_mappings_updated_at ON team_mappings;
DROP TRIGGER IF EXISTS trg_team_mappings_updated_at ON team_mappings;
CREATE TRIGGER trg_team_mappings_updated_at BEFORE UPDATE ON team_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
