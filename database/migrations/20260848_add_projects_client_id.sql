-- =============================================================================
-- Client -> Project -> Service PO -> Delivery Head — Phase 1: Project gets a
-- Client.
--
-- Every Project now belongs to exactly one Client (client_id). Nullable at
-- the DB level deliberately — there is no real Client to backfill existing
-- Projects with (unlike prior retrofits in this codebase that had a
-- sensible default to backfill onto, e.g. a "Default Project"/"Default
-- Entity"), so existing rows are left as-is rather than inventing a fake
-- placeholder Client. "Client is mandatory" is enforced at the application
-- layer (Joi + service validation) for NEW Project creation only — see
-- src/validations/projectValidation.js / src/services/projectService.js.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS client_id INT REFERENCES clients (id);

CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects (client_id);

COMMIT;
