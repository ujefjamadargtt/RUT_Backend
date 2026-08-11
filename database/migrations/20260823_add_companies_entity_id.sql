-- =============================================================================
-- Phase 1 of 3 for companies.entity_id (mirrors this repo's own company_id
-- retrofit at 20260728/29/30_*.sql): add the column NULLABLE first.
-- 20260824 backfills every existing row onto one platform-wide "Default
-- Entity", then 20260825 cuts over to NOT NULL. Never attempt this as a
-- single migration on a populated table.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS entity_id INT REFERENCES entities (id);
CREATE INDEX IF NOT EXISTS idx_companies_entity_id ON companies (entity_id);

COMMIT;
