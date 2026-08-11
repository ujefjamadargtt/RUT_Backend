-- Rollback for 20260839_drop_obsolete_roles.sql
-- NOT auto-run by the migration runner — apply manually if ever needed.
-- Best-effort only: recreates the role rows so users.role_id updates can be
-- reverted (see 20260838's rollback), but their original role_form_mapping /
-- user_roles rows were cascade-deleted and are NOT recoverable from here.

BEGIN;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES
  ('Super Admin', 'Read & Write', 'active', NOW(), NOW()),
  ('Head Manager', 'Read & Write', 'active', NOW(), NOW()),
  ('BU HR Head', 'Read & Write', 'active', NOW(), NOW()),
  ('Division Head', 'Read & Write', 'active', NOW(), NOW()),
  ('Project Manager', 'Read & Write', 'active', NOW(), NOW()),
  ('Management', 'Read & Write', 'active', NOW(), NOW()),
  ('Finance', 'Read', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

COMMIT;
