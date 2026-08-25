-- Rollback for 20260871_drop_bu_head_company_mappings.sql
-- Not auto-run by the migration runner — apply manually if needed.
--
-- Recreates the empty table structure only — original row data is not
-- recoverable once dropped; restore from a backup taken before this
-- migration ran if the data itself is needed back.

BEGIN;

CREATE TABLE IF NOT EXISTS bu_head_company_mappings (
  id SERIAL PRIMARY KEY,
  bu_head_user_id INT NOT NULL REFERENCES users (id),
  company_id INT NOT NULL REFERENCES companies (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bu_head_company_mappings_bu_head_company
  ON bu_head_company_mappings (bu_head_user_id, company_id);
CREATE INDEX IF NOT EXISTS idx_bu_head_company_mappings_bu_head_user_id
  ON bu_head_company_mappings (bu_head_user_id);
CREATE INDEX IF NOT EXISTS idx_bu_head_company_mappings_company_id
  ON bu_head_company_mappings (company_id);

DROP TRIGGER IF EXISTS trg_bu_head_company_mappings_updated_at ON bu_head_company_mappings;
CREATE TRIGGER trg_bu_head_company_mappings_updated_at BEFORE UPDATE ON bu_head_company_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
