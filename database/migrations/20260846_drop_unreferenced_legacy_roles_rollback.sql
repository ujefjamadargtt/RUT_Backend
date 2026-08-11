-- Rollback for 20260846_drop_unreferenced_legacy_roles.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.

BEGIN;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES
  ('Team Head', 'Read & Write', 'active', NOW(), NOW()),
  ('test', 'Read', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

COMMIT;
