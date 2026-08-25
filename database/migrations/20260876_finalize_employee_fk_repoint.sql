-- =============================================================================
-- Employee-as-Identity Redesign — Phase 10: finalize the employee-id
-- repoint for entities / manager_employee_mappings / manager_servicepo_mappings
-- / team_mappings.
--
-- Re-verifies every backfill from 20260872-20260875 one more time (point of
-- no return for these four tables), then drops each old *_user_id column
-- (and its never-explicitly-named FK constraint, looked up dynamically —
-- none of these were given an explicit constraint name at creation time, so
-- guessing one would be unsafe) and recreates the equivalent unique/plain
-- indexes on the new *_employee_id column(s).
--
-- Safe to re-run (every step is IF EXISTS / IF NOT EXISTS guarded; the
-- verification DO block simply finds nothing left to fail on a second run).
-- =============================================================================

BEGIN;

DO $$
DECLARE v_bad INT;
BEGIN
  SELECT COUNT(*) INTO v_bad FROM manager_employee_mappings WHERE manager_employee_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'finalize_employee_fk_repoint: manager_employee_mappings has % unbackfilled rows', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_bad FROM manager_servicepo_mappings WHERE manager_employee_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'finalize_employee_fk_repoint: manager_servicepo_mappings has % unbackfilled rows', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_bad FROM team_mappings WHERE manager_employee_id IS NULL OR service_po_admin_employee_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'finalize_employee_fk_repoint: team_mappings has % unbackfilled rows', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_bad FROM entities WHERE entity_admin_user_id IS NOT NULL AND entity_admin_employee_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'finalize_employee_fk_repoint: entities has % unbackfilled admin links', v_bad;
  END IF;
END $$;

-- Composite/singleton unique indexes referencing the old *_user_id columns
-- (both were given explicit names at creation, no dynamic lookup needed).
DROP INDEX IF EXISTS uq_manager_servicepo_mappings;
DROP INDEX IF EXISTS uq_team_mappings_manager;

-- CHECK constraint referencing both team_mappings *_user_id columns must go
-- before those columns can be dropped; recreated below on the new columns.
ALTER TABLE team_mappings DROP CONSTRAINT IF EXISTS chk_team_mappings_not_self;
ALTER TABLE team_mappings DROP CONSTRAINT IF EXISTS chk_head_manager_mappings_not_self;

-- manager_employee_mappings.manager_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'manager_employee_mappings' AND kcu.column_name = 'manager_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE manager_employee_mappings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
DROP INDEX IF EXISTS idx_manager_employee_mappings_manager_user_id;
ALTER TABLE manager_employee_mappings DROP COLUMN IF EXISTS manager_user_id;
ALTER TABLE manager_employee_mappings ALTER COLUMN manager_employee_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_manager_employee_mappings_manager_employee_id ON manager_employee_mappings (manager_employee_id);

-- manager_servicepo_mappings.manager_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'manager_servicepo_mappings' AND kcu.column_name = 'manager_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE manager_servicepo_mappings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
ALTER TABLE manager_servicepo_mappings DROP COLUMN IF EXISTS manager_user_id;
ALTER TABLE manager_servicepo_mappings ALTER COLUMN manager_employee_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_servicepo_mappings ON manager_servicepo_mappings (manager_employee_id, service_po_id);

-- team_mappings.manager_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'team_mappings' AND kcu.column_name = 'manager_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE team_mappings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
ALTER TABLE team_mappings DROP COLUMN IF EXISTS manager_user_id;
ALTER TABLE team_mappings ALTER COLUMN manager_employee_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_mappings_manager ON team_mappings (manager_employee_id);

-- team_mappings.service_po_admin_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'team_mappings' AND kcu.column_name = 'service_po_admin_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE team_mappings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
DROP INDEX IF EXISTS idx_team_mappings_service_po_admin_user_id;
ALTER TABLE team_mappings DROP COLUMN IF EXISTS service_po_admin_user_id;
ALTER TABLE team_mappings ALTER COLUMN service_po_admin_employee_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_mappings_service_po_admin_employee_id ON team_mappings (service_po_admin_employee_id);

ALTER TABLE team_mappings ADD CONSTRAINT chk_team_mappings_not_self
  CHECK (service_po_admin_employee_id <> manager_employee_id);

-- entities.entity_admin_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'entities' AND kcu.column_name = 'entity_admin_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE entities DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
DROP INDEX IF EXISTS idx_entities_entity_admin_user_id;
ALTER TABLE entities DROP COLUMN IF EXISTS entity_admin_user_id;
CREATE INDEX IF NOT EXISTS idx_entities_entity_admin_employee_id ON entities (entity_admin_employee_id);

COMMIT;
