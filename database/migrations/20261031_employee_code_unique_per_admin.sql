-- =============================================================================
-- Employee code uniqueness is per ADMIN (tenant), not global / not per company.
--
-- Admin 1 and Admin 2 may both own an employee "001"; inside ONE Admin's tenant
-- (all of that Admin's companies/BUs) the code stays unique.
--
-- employees.admin_id = the owning Admin's employee id (NULL = platform level,
-- e.g. the Admin accounts themselves, created by the Platform Admin).
--
-- 1. Drops EVERY unique constraint/index on employees that is exactly
--    (employee_code) or (company_id, employee_code) — constraint names differ per
--    environment (uq_employees_employee_code, uq_employees_company_code,
--    employees_copy1_company_id_employee_code_key, ...), so they are found by columns.
-- 2. Adds admin_id and backfills it (company -> entity -> created_by; else first
--    active BU; else the creator's tenant).
-- 3. Creates UNIQUE (COALESCE(admin_id,0), employee_code). If existing data already
--    has duplicates inside one tenant the unique index cannot be built: a WARNING is
--    raised and a plain index is created instead (the app-level check still applies);
--    fix the listed duplicates and re-run to get the unique index.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS admin_id INTEGER;

-- 1. drop old code-uniqueness constraints (by columns, not by name)
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
     WHERE c.conrelid = 'employees'::regclass
       AND c.contype = 'u'
       AND (
         SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
       ) IN (ARRAY['employee_code'], ARRAY['company_id', 'employee_code'])
  LOOP
    EXECUTE format('ALTER TABLE employees DROP CONSTRAINT %I', r.conname);
  END LOOP;

  FOR r IN
    SELECT i.indexname
      FROM pg_indexes i
      JOIN pg_class ic ON ic.relname = i.indexname
      JOIN pg_index ix ON ix.indexrelid = ic.oid
     WHERE i.tablename = 'employees' AND i.schemaname = current_schema()
       AND ix.indisunique AND NOT ix.indisprimary AND ix.indpred IS NULL AND ix.indexprs IS NULL
       AND (
         SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(ix.indkey::int2[]) k JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k
       ) IN (ARRAY['employee_code'], ARRAY['company_id', 'employee_code'])
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I', r.indexname);
  END LOOP;
END $$;

-- 2. backfill admin_id (only rows not set yet; Admin / Platform Admin accounts stay NULL)
CREATE TEMP TABLE _emp_top ON COMMIT DROP AS
  SELECT DISTINCT er.employee_id
    FROM employee_roles er JOIN roles r ON r.id = er.role_id
   WHERE er.status = 'active' AND r.hierarchy_rank IS NOT NULL AND r.hierarchy_rank <= 2;

UPDATE employees e
   SET admin_id = ent.created_by
  FROM companies c JOIN entities ent ON ent.id = c.entity_id
 WHERE e.admin_id IS NULL AND e.company_id = c.id AND ent.created_by IS NOT NULL
   AND e.id NOT IN (SELECT employee_id FROM _emp_top);

UPDATE employees e
   SET admin_id = ent.created_by
  FROM (SELECT employee_id, MIN(business_unit_id) AS bu FROM employee_business_units WHERE status = 'active' GROUP BY employee_id) m
  JOIN companies c ON c.id = m.bu JOIN entities ent ON ent.id = c.entity_id
 WHERE e.admin_id IS NULL AND e.id = m.employee_id AND ent.created_by IS NOT NULL
   AND e.id NOT IN (SELECT employee_id FROM _emp_top);

-- no BU at all: inherit the creating actor's tenant (an Admin creator IS the tenant)
UPDATE employees e
   SET admin_id = CASE WHEN cr.id IN (SELECT employee_id FROM _emp_top)
                       AND EXISTS (SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id
                                    WHERE er.employee_id = cr.id AND er.status = 'active' AND r.hierarchy_rank = 2)
                       THEN cr.id ELSE cr.admin_id END
  FROM employees cr
 WHERE e.admin_id IS NULL AND e.created_by = cr.id AND e.id <> cr.id
   AND e.id NOT IN (SELECT employee_id FROM _emp_top);
UPDATE employees e
   SET admin_id = cr.admin_id
  FROM employees cr
 WHERE e.admin_id IS NULL AND e.created_by = cr.id AND e.id <> cr.id AND cr.admin_id IS NOT NULL
   AND e.id NOT IN (SELECT employee_id FROM _emp_top);

CREATE INDEX IF NOT EXISTS idx_employees_admin_id ON employees (admin_id);

-- 3. the scoped unique index
DO $$
DECLARE dup RECORD; dups INT := 0;
BEGIN
  DROP INDEX IF EXISTS uq_employees_admin_code;
  FOR dup IN
    SELECT COALESCE(admin_id, 0) AS tenant, employee_code, COUNT(*) AS n
      FROM employees GROUP BY 1, 2 HAVING COUNT(*) > 1 LIMIT 20
  LOOP
    dups := dups + 1;
    RAISE WARNING 'employee_code "%" is used % times inside tenant admin_id=% — fix before the unique index can be built', dup.employee_code, dup.n, dup.tenant;
  END LOOP;
  IF dups = 0 THEN
    CREATE UNIQUE INDEX uq_employees_admin_code ON employees ((COALESCE(admin_id, 0)), employee_code);
  ELSE
    CREATE INDEX uq_employees_admin_code ON employees ((COALESCE(admin_id, 0)), employee_code);
  END IF;
END $$;

COMMIT;
