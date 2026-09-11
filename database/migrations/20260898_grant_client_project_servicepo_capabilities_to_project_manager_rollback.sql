-- =============================================================================
-- Rollback: revoke the Client / Project / Service PO capability grants this
-- migration's forward script gave to 'Project Manager'.
--
-- Only removes the grants keyed to 'Project Manager' — leaves BU Admin's and
-- Project Admin's own pre-existing direct grants of these same capability
-- keys untouched.
-- =============================================================================

BEGIN;

DELETE FROM role_capabilities
WHERE capability_key IN ('bu.create_client', 'bu.manage_projects', 'project.manage_servicepos')
  AND role_id = (SELECT id FROM roles WHERE role_name = 'Project Manager');

COMMIT;
