-- =============================================================================
-- Grant Project Manager access to the Client / Project / Service PO masters.
--
-- Until now, no route actually enforced any capability on Client/Project/
-- Service PO create/update/delete (client.routes.js/project.routes.js/
-- servicePO.routes.js only ran the generic authenticate() middleware) — any
-- authenticated role, including Team Lead/Employee/HR, could create one.
-- Business requirement: only Admin, BU Admin, and Project Manager should be
-- able to create/update/delete these three masters.
--
-- Admin/BU Admin already bypass authorize() entirely (senior-tier rank <= 4,
-- see roleHierarchyService.isSeniorTier), so only Project Manager needs an
-- explicit grant. Reuses the two capability keys BU Admin already holds
-- on paper for Client/Project (bu.create_client, bu.manage_projects) and the
-- one Project Admin already holds for Service PO (project.manage_servicepos)
-- — see 20260836_seed_target_roles_and_capabilities.sql — rather than
-- inventing near-duplicate keys for the same actions.
--
-- Side effect (intentional, not incidental): Project Admin (rank 5) already
-- inherits every Project Manager (rank 6) capability via inherits_role_id,
-- so this also extends Project Admin's own reach to Client/Project
-- management, not just Service PO. Team Lead/Employee/HR are unaffected —
-- inheritance runs the other direction (Project Manager inherits FROM Team
-- Lead, never the reverse).
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

INSERT INTO role_capabilities (role_id, capability_key)
SELECT r.id, g.capability_key
FROM (VALUES
  ('Project Manager', 'bu.create_client'),
  ('Project Manager', 'bu.manage_projects'),
  ('Project Manager', 'project.manage_servicepos')
) AS g(role_name, capability_key)
JOIN roles r ON r.role_name = g.role_name
ON CONFLICT (role_id, capability_key) DO NOTHING;

COMMIT;
