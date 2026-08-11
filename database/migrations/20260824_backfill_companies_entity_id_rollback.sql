-- Rollback for 20260824_backfill_companies_entity_id.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Only undoes companies still pointing at the auto-created Default Entity —
-- any company since reassigned to a real Entity is left untouched.

BEGIN;

UPDATE companies c
  SET entity_id = NULL
  FROM entities e
  WHERE c.entity_id = e.id AND e.entity_code = 'DEFAULT-ENTITY';

DELETE FROM entities WHERE entity_code = 'DEFAULT-ENTITY';

COMMIT;
