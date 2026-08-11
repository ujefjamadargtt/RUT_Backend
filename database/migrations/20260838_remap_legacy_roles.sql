-- =============================================================================
-- RBAC Redesign — Phase 5: remap holders of obsolete roles onto the nearest
-- new role, per the user's explicit decision (do not orphan existing
-- accounts — remap instead of drop).
--
--   Super Admin      -> Admin              (broad, near-platform-wide operational scope)
--   Head Manager     -> Service PO Admin   (Service PO Admin now owns the Manager "team")
--   BU HR Head       -> HR                 (both are HR-flavored at the BU tier)
--   Division Head    -> BU Admin           ("Division" ~ Business Unit)
--   Project Manager  -> Project Admin      (direct name match)
--   Management       -> Admin              (generic senior-oversight role)
--   Finance          -> Employee           (no equivalent in the new hierarchy;
--                                            least-privilege fallback — flagged
--                                            in role_migration_log for manual review)
--
-- Every remapped user is logged to role_migration_log BEFORE the update, so
-- ops can review exactly who moved where. The pre-existing 'HR' role (id 1
-- historically) is NOT remapped — it keeps its name; only its capabilities/
-- forms are redefined (see 20260836 and 20260845).
--
-- Must run AFTER 20260836 (target roles must already exist) and BEFORE
-- 20260839 (which deletes the obsolete role rows this migration reads from).
--
-- Safe to re-run: once a user's role_id has been moved off the obsolete
-- role, the WHERE role_id = v_old_id clause matches nothing on a second run.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  v_old_id INT;
  v_new_id INT;
  v_pair RECORD;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('Super Admin',     'Admin'),
      ('Head Manager',    'Service PO Admin'),
      ('BU HR Head',      'HR'),
      ('Division Head',   'BU Admin'),
      ('Project Manager', 'Project Admin'),
      ('Management',      'Admin'),
      ('Finance',         'Employee')
    ) AS t(old_role_name, new_role_name)
  LOOP
    SELECT id INTO v_old_id FROM roles WHERE role_name = v_pair.old_role_name;
    SELECT id INTO v_new_id FROM roles WHERE role_name = v_pair.new_role_name;

    IF v_old_id IS NOT NULL AND v_new_id IS NOT NULL THEN
      INSERT INTO role_migration_log (user_id, old_role_name, new_role_name, reason)
      SELECT id, v_pair.old_role_name, v_pair.new_role_name, 'RBAC redesign legacy-role remap'
      FROM users
      WHERE role_id = v_old_id;

      UPDATE users SET role_id = v_new_id, updated_at = NOW() WHERE role_id = v_old_id;
    END IF;
  END LOOP;
END $$;

COMMIT;
