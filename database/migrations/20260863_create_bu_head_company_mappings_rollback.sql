-- Rollback for 20260863_create_bu_head_company_mappings.sql

BEGIN;

DROP TRIGGER IF EXISTS trg_bu_head_company_mappings_updated_at ON bu_head_company_mappings;
DROP TABLE IF EXISTS bu_head_company_mappings;

COMMIT;
