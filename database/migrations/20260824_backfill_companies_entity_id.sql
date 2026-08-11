-- =============================================================================
-- Phase 2 of 3 for companies.entity_id — backfill.
--
-- One platform-wide "Default Entity" is created (unowned —
-- entity_admin_user_id NULL, since Entity Admin is a brand-new role with no
-- existing users to assign it to), and every pre-existing Company with
-- entity_id still NULL is assigned to it. This is a legacy/bridging
-- artifact only — no live Entity Admin workflow depends on it. New
-- Companies going forward must pick a real Entity their own Entity Admin
-- owns (see companyService.createWithAdmin).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO entities (entity_code, entity_name, entity_admin_user_id, status, created_at, updated_at)
VALUES ('DEFAULT-ENTITY', 'Default Entity', NULL, 'active', NOW(), NOW())
ON CONFLICT (entity_code) DO NOTHING;

DO $$
DECLARE
  default_entity_id INT;
BEGIN
  SELECT id INTO default_entity_id FROM entities WHERE entity_code = 'DEFAULT-ENTITY';

  IF default_entity_id IS NULL THEN
    RAISE EXCEPTION 'Default Entity row not found — cannot backfill companies.entity_id.';
  END IF;

  UPDATE companies SET entity_id = default_entity_id WHERE entity_id IS NULL;
END $$;

COMMIT;
