-- Rollback for 20260728_add_company_tenancy_schema.sql — safe to run only
-- while Phase 0 is the latest applied tenancy migration (i.e. before Phase 1's
-- backfill/company-module work depends on these columns existing).

BEGIN;

ALTER TABLE users                    DROP COLUMN IF EXISTS company_id;
ALTER TABLE users                    DROP COLUMN IF EXISTS is_platform_admin;
ALTER TABLE clients                  DROP COLUMN IF EXISTS company_id;
ALTER TABLE employees                DROP COLUMN IF EXISTS company_id;
ALTER TABLE monthly_costs            DROP COLUMN IF EXISTS company_id;
ALTER TABLE service_pos              DROP COLUMN IF EXISTS company_id;
ALTER TABLE service_po_resources     DROP COLUMN IF EXISTS company_id;
ALTER TABLE service_types            DROP COLUMN IF EXISTS company_id;
ALTER TABLE service_categories       DROP COLUMN IF EXISTS company_id;
ALTER TABLE sub_projects             DROP COLUMN IF EXISTS company_id;
ALTER TABLE timesheets               DROP COLUMN IF EXISTS company_id;
ALTER TABLE timesheet_import_history DROP COLUMN IF EXISTS company_id;
ALTER TABLE timesheet_import_errors  DROP COLUMN IF EXISTS company_id;
ALTER TABLE ai_insights              DROP COLUMN IF EXISTS company_id;
ALTER TABLE ai_insight_jobs          DROP COLUMN IF EXISTS company_id;

DROP TABLE IF EXISTS companies;

COMMIT;
