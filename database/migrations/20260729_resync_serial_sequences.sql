BEGIN;

-- Root cause: database/seeds.sql (and any manual data restores/imports) insert
-- rows with explicit id values, which never advances the table's SERIAL
-- sequence. When the sequence falls behind MAX(id), the next DEFAULT-driven
-- INSERT (via Sequelize) asks Postgres for nextval(), gets a value that's
-- already taken, and fails with "duplicate key value violates unique
-- constraint ... _pkey".
--
-- This resyncs every SERIAL/IDENTITY primary key sequence in the public
-- schema to MAX(id) + 1, so it fixes clients_id_seq and every other table
-- seeded the same way (roles, employees, users, service_types, service_pos,
-- sub_projects, user_sessions, ...) in one idempotent pass. Safe to re-run;
-- safe on empty tables.
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
