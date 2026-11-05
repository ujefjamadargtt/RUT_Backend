-- Rollback for 20261104_site_logos.sql (drops all stored logos).
BEGIN;
DROP INDEX IF EXISTS uq_site_logos_single_active;
DROP TABLE IF EXISTS site_logos;
COMMIT;
