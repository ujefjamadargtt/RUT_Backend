-- =============================================================================
-- Project Master — every Service PO must belong to a Project (see the
-- following 3 migrations, which add service_pos.project_id in 3 phases:
-- nullable column -> backfill -> NOT NULL, mirroring this repo's own
-- company_id retrofit at 20260728/29/30_*.sql).
--
-- Project is a standalone, company-scoped grouping — independent of Client
-- (no client_id column here; a Service PO already has its own client_id).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS projects (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  project_code VARCHAR(30) NOT NULL,
  project_name VARCHAR(200) NOT NULL,
  project_description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_company_code ON projects (company_id, project_code);
CREATE INDEX IF NOT EXISTS idx_projects_company_id ON projects (company_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
