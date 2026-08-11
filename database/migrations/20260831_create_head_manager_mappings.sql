-- =============================================================================
-- Head Manager Mapping — BU Admin's grant of a Manager to a Head Manager.
-- Replaces the old flat manager_mappings table (see 20260829). A Manager
-- belongs to EXACTLY ONE Head Manager at a time — enforced with a unique
-- index on manager_user_id ALONE (not the pair), unlike a typical
-- many-to-many junction table.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS head_manager_mappings (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  head_manager_user_id INT NOT NULL REFERENCES users (id),
  manager_user_id INT NOT NULL REFERENCES users (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_head_manager_mappings_not_self CHECK (head_manager_user_id <> manager_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_head_manager_mappings_manager ON head_manager_mappings (manager_user_id);
CREATE INDEX IF NOT EXISTS idx_head_manager_mappings_head_manager_user_id ON head_manager_mappings (head_manager_user_id);
CREATE INDEX IF NOT EXISTS idx_head_manager_mappings_company_id ON head_manager_mappings (company_id);

DROP TRIGGER IF EXISTS trg_head_manager_mappings_updated_at ON head_manager_mappings;
CREATE TRIGGER trg_head_manager_mappings_updated_at BEFORE UPDATE ON head_manager_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
