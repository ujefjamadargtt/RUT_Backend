-- =============================================================================
-- Phase 3 of 3 for companies.entity_id — cut over to NOT NULL now that every
-- existing row has been backfilled (20260824). Every Company must belong to
-- exactly one Entity from this point forward.
--
-- Guarded: only runs the ALTER once every row already has an entity_id, so
-- this is safe to re-run and safe if applied out of order relative to a
-- delayed 20260824 in some environment.
-- =============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM companies WHERE entity_id IS NULL) THEN
    ALTER TABLE companies ALTER COLUMN entity_id SET NOT NULL;
  ELSE
    RAISE EXCEPTION 'companies still has rows with a NULL entity_id — run 20260824_backfill_companies_entity_id.sql first.';
  END IF;
END $$;

COMMIT;
