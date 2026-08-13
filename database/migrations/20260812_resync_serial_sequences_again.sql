BEGIN;

-- Recurrence of the drift fixed once already in
-- 20260729_resync_serial_sequences.sql. That migration only ever runs once
-- (tracked in schema_migrations), but manual data restores/imports done
-- directly against the database since then have again inserted rows with
-- explicit id values without advancing the affected SERIAL sequences —
-- surfacing everywhere as "<column> must be unique" on plain INSERTs
-- (companies, and reportedly other tables too).
--
-- Re-running the same idempotent resync: sets every SERIAL/IDENTITY primary
-- key sequence in the public schema to MAX(id) + 1. Safe to re-run; safe on
-- empty tables.
DO $$
DECLARE
  r RECORD;
  v_seq TEXT;
  v_next BIGINT;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_default LIKE 'nextval(%'
  LOOP
    v_seq := pg_get_serial_sequence(r.table_name, r.column_name);

    IF v_seq IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE(MAX(%I), 0) + 1 FROM %I', r.column_name, r.table_name) INTO v_next;
      PERFORM setval(v_seq, v_next, false);
      RAISE NOTICE 'Resynced %.% -> % will start at %', r.table_name, r.column_name, v_seq, v_next;
    END IF;
  END LOOP;
END $$;

COMMIT;
