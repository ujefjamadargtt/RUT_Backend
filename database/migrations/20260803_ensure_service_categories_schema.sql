-- =============================================================================
-- Reconcile service_categories / service_types.service_category_id schema.
--
-- Root cause of "POST /api/v1/service-types works locally, 500s on Railway":
-- the service_categories table and the service_types.service_category_id
-- column were never created by a tracked migration in this repo (grep
-- confirms zero hits for either across database/schema.sql and every prior
-- database/migrations/*.sql file). Both were introduced out-of-band — a
-- manual ALTER TABLE / sequelize sync({ alter: true }) run directly against
-- each environment independently — so local and Railway had no guarantee of
-- ending up with the same shape. 20260728_add_company_tenancy_schema.sql and
-- 20260730_company_id_not_null_and_unique.sql already both ALTER this table
-- unconditionally, so they already assumed it exists; this migration is the
-- missing "create it if it doesn't, patch it if it's partial" step that
-- should have preceded them.
--
-- Written to be safe to run against any of the possible current states:
-- table missing entirely, table present but missing a column/constraint, or
-- everything already present (pure no-op). Re-runnable.
-- =============================================================================

BEGIN;

-- 1. Table itself, in case it doesn't exist at all on this database.
CREATE TABLE IF NOT EXISTS service_categories (
  id                 SERIAL PRIMARY KEY,
  company_id         INT,
  name               VARCHAR(100) NOT NULL,
  status             VARCHAR(10)  NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active', 'inactive')),
  report_bucket_key  VARCHAR(30),
  is_deleted         BOOLEAN      NOT NULL DEFAULT false,
  created_by         INT,
  updated_by         INT,
  created_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- 2. Any column that could be missing if the table already existed but
--    predates one of these fields being added.
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS company_id INT;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS report_bucket_key VARCHAR(30);
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS created_by INT;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS updated_by INT;

-- 3. company_id -> companies, backfilled to the default GTT tenant and cut
--    over to NOT NULL — the same pattern every other business table already
--    went through (20260729_backfill_company_id.sql /
--    20260730_company_id_not_null_and_unique.sql). No-op if already done.
DO $$
DECLARE
  gtt_id INT;
BEGIN
  SELECT id INTO gtt_id FROM companies WHERE company_code = 'GTT';

  IF gtt_id IS NOT NULL THEN
    UPDATE service_categories SET company_id = gtt_id WHERE company_id IS NULL;
    EXECUTE format('ALTER TABLE service_categories ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
    ALTER TABLE service_categories ALTER COLUMN company_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS service_categories_company_id_fkey;
ALTER TABLE service_categories
  ADD CONSTRAINT service_categories_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies (id);

CREATE INDEX IF NOT EXISTS idx_service_categories_company_id ON service_categories (company_id);

-- 4. Uniqueness + check constraints under the exact names the app and later
--    migrations already assume exist.
--
--    uq_service_categories_company_name may already exist here as a plain
--    index rather than a table constraint — that happens when a prior
--    Sequelize model-level `indexes:` sync created it directly, instead of
--    the ALTER TABLE ... ADD CONSTRAINT this migration uses. DROP CONSTRAINT
--    IF EXISTS only looks in pg_constraint and silently no-ops against a
--    bare index of the same name, so ADD CONSTRAINT's implicit backing index
--    then collides with it ("relation ... already exists"). Drop both forms
--    before recreating it as a real constraint.
ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS uq_service_categories_company_name;
DROP INDEX IF EXISTS uq_service_categories_company_name;
ALTER TABLE service_categories
  ADD CONSTRAINT uq_service_categories_company_name UNIQUE (company_id, name);

ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS chk_service_categories_report_bucket_key;
ALTER TABLE service_categories
  ADD CONSTRAINT chk_service_categories_report_bucket_key
  CHECK (report_bucket_key IS NULL OR report_bucket_key IN ('billable', 'non_billable', 'customer_non_billable'));

DROP TRIGGER IF EXISTS trg_service_categories_updated_at ON service_categories;
CREATE TRIGGER trg_service_categories_updated_at BEFORE UPDATE ON service_categories
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- 5. The column on service_types this migration exists to guarantee.
--    Constraint name/behavior (ON UPDATE CASCADE ON DELETE SET NULL) verified
--    against a working local database — deleting a category should clear the
--    reference on any service_type that used it, not block the delete or
--    cascade-delete the service_type itself.
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS service_category_id INT;

-- Drop both the hand-written name (used locally) and Sequelize's
-- default-generated name (<table>_<column>_fkey, what a model-driven sync
-- would have produced instead) — whichever this database actually has.
ALTER TABLE service_types DROP CONSTRAINT IF EXISTS fk_service_types_category;
ALTER TABLE service_types DROP CONSTRAINT IF EXISTS service_types_service_category_id_fkey;
ALTER TABLE service_types
  ADD CONSTRAINT fk_service_types_category
  FOREIGN KEY (service_category_id) REFERENCES service_categories (id)
  ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_service_types_service_category_id ON service_types (service_category_id);

COMMIT;
