-- =============================================================================
-- RBAC Redesign — Phase 14: drop the stray DEFAULT 1 on users.company_id.
--
-- Discovered during Stage 4 live testing: this column carries a Postgres-
-- level `DEFAULT 1` left over from the original multi-tenancy retrofit's
-- nullable -> backfill -> NOT NULL cutover (the backfill phase needed a
-- default to populate pre-existing rows, and it was never dropped
-- afterward — the same pattern flagged during this redesign's initial
-- analysis for several other company-scoped tables, e.g. service_pos,
-- timesheets, clients — those are pre-existing, out of this migration's
-- scope, and unaffected by anything this RBAC redesign does).
--
-- It was harmless as long as every User-creation code path always had a
-- real company_id from context. This redesign introduces the first actors
-- that legitimately create Users with NO company_id at all (Platform
-- Admin creating Admin; Admin creating Entity Admin) — passing
-- `company_id: undefined` to Sequelize's User.create() omits the column
-- from the INSERT entirely, letting Postgres silently apply DEFAULT 1
-- instead of NULL. Confirmed live: an Admin (company_id NULL) creating a
-- BU Admin via POST /users ended up with company_id=1 on the new row
-- instead of NULL/the intended company. Dropping the default is the fix;
-- userService.js additionally now passes `company_id ?? null` explicitly
-- rather than relying on the column default at all.
--
-- Safe to re-run.
-- =============================================================================

BEGIN;

ALTER TABLE users ALTER COLUMN company_id DROP DEFAULT;

COMMIT;
