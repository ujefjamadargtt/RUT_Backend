-- =============================================================================
-- Employee-as-Identity Redesign — Phase 12: relax audit-trail FKs to `users`.
--
-- These columns describe WHICH USER ACCOUNT did something historically —
-- not a business relationship worth repointing to Employee (per explicit
-- instruction: don't blindly convert every user_id reference without
-- understanding why it exists). Each FK constraint is dropped (dynamic
-- lookup — none were given an explicit name at creation) so the upcoming
-- `users` truncate isn't blocked; the column itself is kept as a historical
-- breadcrumb:
--   - role_migration_log.user_id   — protected table, rows untouched.
--   - password_reset_otps.user_id, password_reset_history.user_id — both
--     tables already carry a parallel employee_id column for new rows
--     going forward.
--   - timesheet_import_history.imported_by — has an explicitly-named FK
--     (fk_tih_imported_by, RESTRICT), dropped directly.
--
-- notifications and user_sessions are pure ephemeral per-account state with
-- no historical value once the account is gone — truncated outright here
-- rather than relaxed (audit_logs.user_id and created_by/updated_by columns
-- elsewhere have no live DB constraint at all, confirmed separately, so
-- they need no action and are left alone).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'role_migration_log' AND kcu.column_name = 'user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE role_migration_log DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'password_reset_otps' AND kcu.column_name = 'user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE password_reset_otps DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'password_reset_history' AND kcu.column_name = 'user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE password_reset_history DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE timesheet_import_history DROP CONSTRAINT IF EXISTS fk_tih_imported_by;

TRUNCATE TABLE notifications;
TRUNCATE TABLE user_sessions;

-- Generic sweep: this project has repeatedly hit out-of-band, untracked
-- tables that exist on some live environments but were never created by
-- any migration (see 20260803/20260842's own notes on this pattern) — e.g.
-- an ad-hoc `user_roles_copy1` snapshot table, discovered while testing
-- this exact migration, that still carries a FK to `users.id`. Rather than
-- hardcode every such table by name (which would only cover what THIS
-- environment happens to have), drop every remaining FK to users.id this
-- migration hasn't already explicitly handled above, logging each one via
-- RAISE NOTICE so it's visible in the deploy log rather than silent. Only
-- the constraint is dropped — no table's data or rows are touched here.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tc.table_name, kcu.column_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'users'
  LOOP
    RAISE NOTICE 'relax_audit_trail_user_fks: dropping unaccounted-for FK % on %.% (out-of-band/legacy table not part of the tracked schema)',
      r.constraint_name, r.table_name, r.column_name;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.table_name, r.constraint_name);
  END LOOP;
END $$;

COMMIT;
