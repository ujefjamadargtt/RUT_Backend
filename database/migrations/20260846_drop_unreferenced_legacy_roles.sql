-- =============================================================================
-- RBAC Redesign — Phase 13: drop leftover unreferenced role rows.
--
-- Found during migration dry-run: 'Team Head' and 'test' role rows exist in
-- some environments (added out-of-band, like several other things flagged
-- during this redesign's analysis — never created by any tracked migration
-- or seed file) but hold zero users. They conflict with the new 9-role
-- hierarchy and have no holders to remap, so they're removed outright
-- rather than run through the remap machinery in 20260838.
--
-- Guarded by a zero-holders check so this is a no-op (does nothing, doesn't
-- error) if some environment turns out to have a real user on one of these
-- — that would need a manual remap decision instead, the same as any other
-- role this redesign didn't already know to plan for.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

DELETE FROM roles
WHERE role_name IN ('Team Head', 'test')
  AND id NOT IN (SELECT DISTINCT role_id FROM users WHERE role_id IS NOT NULL);

COMMIT;
