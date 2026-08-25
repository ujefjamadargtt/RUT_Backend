-- Rollback for 20260888_make_service_pos_company_id_nullable.sql
-- Fails if any Service PO was created with company_id NULL in the meantime —
-- assign those a Business Unit before rolling back.
BEGIN;

ALTER TABLE service_pos
  ALTER COLUMN company_id SET NOT NULL;

COMMIT;
