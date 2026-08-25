-- =============================================================================
-- Centralised Service PO — a Service PO with is_centralised = true is
-- automatically mapped to every NEW employee created afterward (see
-- employeeServicePOMappingService.autoMapCentralisedServicePOs()). It stays
-- a normal service_pos row otherwise; no separate table. Existing rows
-- default to FALSE so current behavior is unchanged. Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE service_pos
  ADD COLUMN IF NOT EXISTS is_centralised BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
