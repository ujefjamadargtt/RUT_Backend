-- =============================================================================
-- service_pos.status was created as VARCHAR(10) with an old CHECK constraint
-- allowing only ('active', 'inactive', 'closed'). The application (ServicePO
-- model + servicePOValidation.js) has since moved to a 6-value status enum
-- ('in-progress', 'completed', 'on-hold', 'pending', 'cancelled', 'closed'),
-- and 'in-progress' alone is 11 characters — one over the column's old
-- 10-char limit. No prior migration ever widened the column or updated the
-- constraint, so inserts/updates with the new statuses fail with
-- "value too long for type character varying(10)".
--
-- invoice_frequency has the same drift: its CHECK constraint still lists the
-- old ('monthly', 'quarterly', 'bi-annual', 'annual', 'one-time') set while
-- the app now uses ('monthly', 'milestone-based', 'internal-no-invoice',
-- 'poc', 'yearly-amc'). The column width (VARCHAR(20)) already fits the new
-- values, only the CHECK constraint is stale.
--
-- Existing rows may still hold old values ('active', 'inactive' for status;
-- 'quarterly', 'bi-annual', 'annual', 'one-time' for invoice_frequency) that
-- don't fit the new enums. Adding the new CHECK constraints as NOT VALID
-- skips validating those pre-existing rows (no full-table scan / lock risk
-- on a live table) while still enforcing the new enum on every future
-- insert/update. Old rows can be backfilled and the constraint VALIDATEd
-- later as a separate, non-urgent step.
--
-- Safe to re-run: every DROP uses IF EXISTS, and widening an already-wide
-- column is a no-op.
-- =============================================================================

BEGIN;

ALTER TABLE service_pos ALTER COLUMN status TYPE VARCHAR(20);
ALTER TABLE service_pos ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE service_pos DROP CONSTRAINT IF EXISTS service_pos_status_check;
ALTER TABLE service_pos
  ADD CONSTRAINT service_pos_status_check
  CHECK (status::text = ANY (ARRAY['in-progress', 'completed', 'on-hold', 'pending', 'cancelled', 'closed']::text[]))
  NOT VALID;

ALTER TABLE service_pos DROP CONSTRAINT IF EXISTS service_pos_invoice_frequency_check;
ALTER TABLE service_pos
  ADD CONSTRAINT service_pos_invoice_frequency_check
  CHECK (invoice_frequency::text = ANY (ARRAY['monthly', 'milestone-based', 'internal-no-invoice', 'poc', 'yearly-amc']::text[]))
  NOT VALID;

COMMIT;
