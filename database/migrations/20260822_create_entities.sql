-- =============================================================================
-- Entity Master — new tenancy tier: Platform Admin -> Entity Admin -> Entity
-- -> Company (BU Admin) -> ... An Entity Admin owns zero or more Entities
-- (entity_admin_user_id, nullable so a freshly-created Entity Admin user
-- starts with none until they create their own via the Entity Master
-- screen — see entityService.js) and every Company must belong to exactly
-- one Entity (see the next 3 migrations for the companies.entity_id
-- retrofit).
--
-- Mirrors companies' own shape (id, code, name, status, is_deleted,
-- created_by/updated_by, timestamps) plus the ownership FK.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS entities (
  id SERIAL PRIMARY KEY,
  entity_code VARCHAR(20) NOT NULL,
  entity_name VARCHAR(150) NOT NULL,
  entity_admin_user_id INT REFERENCES users (id),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entities_entity_code ON entities (entity_code);
CREATE INDEX IF NOT EXISTS idx_entities_entity_admin_user_id ON entities (entity_admin_user_id);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities (status);

DROP TRIGGER IF EXISTS trg_entities_updated_at ON entities;
CREATE TRIGGER trg_entities_updated_at BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
