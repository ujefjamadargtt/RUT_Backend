-- Rollback for 20260884_drop_service_pos_invoice_amount_and_expected_man_hours.sql.
-- Re-adds both columns as nullable — this restores the SHAPE only. Any
-- values they previously held were lost when the forward migration ran and
-- cannot be recovered here.

BEGIN;

ALTER TABLE service_pos ADD COLUMN IF NOT EXISTS expected_man_hours NUMERIC(10, 2);
ALTER TABLE service_pos ADD COLUMN IF NOT EXISTS invoice_amount NUMERIC(15, 2);

COMMIT;
