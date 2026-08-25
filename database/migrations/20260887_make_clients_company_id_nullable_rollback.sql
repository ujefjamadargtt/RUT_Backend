-- Rollback for 20260887_make_clients_company_id_nullable.sql
-- Fails if any Client was created with company_id NULL in the meantime —
-- assign those a Business Unit before rolling back.
BEGIN;

ALTER TABLE clients
  ALTER COLUMN company_id SET NOT NULL;

COMMIT;
