-- =============================================================================
-- BU Head <-> Company mapping — a BU Head may be mapped to one or many
-- existing Companies ("BUs"); a Company may equally be mapped to more than
-- one BU Head. Deliberately a join table, not a single owner column on
-- companies (the shape used for Entity <-> Entity Admin,
-- entities.entity_admin_user_id) — that shape only supports ONE owner per
-- row, and this relationship needs BOTH the "one BU Head, many Companies"
-- and the "same Company mapped twice to the same BU Head is rejected"
-- requirements a join table + unique index expresses directly.
--
-- BU Head never creates a Company (see companyService.createWithAdmin,
-- unchanged) — this table only ever links to a Company that already exists.
-- Unmapping (see buHeadCompanyMappingRepository.deleteMapping) removes only
-- the row here; it never touches companies/users/employees.
--
-- Safe to re-run.
-- =============================================================================

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

-- Same BU can never be mapped twice to the same BU Head.
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
