-- =============================================================================
-- BU Head — capability + form access, copied 1:1 from BU Admin's CURRENT
-- rows at migration time.
--
-- Neither role_capabilities (src/services/roleHierarchyService.js) nor
-- role_form_mapping is inherited between roles anywhere else in this
-- codebase — every role's access is a flat, directly-seeded set of rows
-- (see 20260836_seed_target_roles_and_capabilities.sql and
-- 20260845_reseed_form_master_and_role_form_mapping.sql). "BU Head gets the
-- SAME form/capability access as BU Admin" is implemented the same way:
-- a one-time copy of BU Admin's rows, not a new inheritance edge. If BU
-- Admin's own mappings change later, re-run (or write a follow-up migration
-- that re-syncs) rather than hand-editing BU Head's rows — see this
-- migration's rollback for the exact inverse.
--
-- Safe to re-run (ON CONFLICT DO NOTHING on both inserts).
-- =============================================================================

BEGIN;

INSERT INTO role_capabilities (role_id, capability_key)
SELECT bh.id, rc.capability_key
FROM role_capabilities rc
JOIN roles ba ON ba.id = rc.role_id AND ba.role_name = 'BU Admin'
JOIN roles bh ON bh.role_name = 'BU Head'
ON CONFLICT (role_id, capability_key) DO NOTHING;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT bh.id, rfm.form_id, true, NOW(), NOW()
FROM role_form_mapping rfm
JOIN roles ba ON ba.id = rfm.role_id AND ba.role_name = 'BU Admin'
JOIN roles bh ON bh.role_name = 'BU Head'
WHERE rfm.status = true
ON CONFLICT (role_id, form_id) DO NOTHING;

COMMIT;
