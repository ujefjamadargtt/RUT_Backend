-- Rollback for 20260891_fix_service_pos_status_and_invoice_frequency_constraints.sql
-- Reverts service_pos.status/invoice_frequency to their original narrow
-- constraints. NOTE: will fail if any row currently holds a value outside
-- the old enums (e.g. status = 'in-progress') — clean up such rows first.

BEGIN;

ALTER TABLE service_pos DROP CONSTRAINT IF EXISTS service_pos_invoice_frequency_check;
ALTER TABLE service_pos
  ADD CONSTRAINT service_pos_invoice_frequency_check
  CHECK (invoice_frequency::text = ANY (ARRAY['monthly', 'quarterly', 'bi-annual', 'annual', 'one-time']::text[]));

ALTER TABLE service_pos DROP CONSTRAINT IF EXISTS service_pos_status_check;
ALTER TABLE service_pos
  ADD CONSTRAINT service_pos_status_check
  CHECK (status::text = ANY (ARRAY['active', 'inactive', 'closed']::text[]));

ALTER TABLE service_pos ALTER COLUMN status SET DEFAULT 'active';
ALTER TABLE service_pos ALTER COLUMN status TYPE VARCHAR(10);

COMMIT;
