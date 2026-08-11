# RBAC Redesign — Testing Summary

No automated test suite exists in this repo for these flows, so every
stage was verified **live** against a local copy of the developer's real
Postgres database (`rut_db_live`), using the app's own migration runner
and a running server instance on a scratch port — never the shared dev
port (5555) already in use. Every test user/company/entity created for
verification was deleted afterward; none of this is left in the database.

## Stage 1 — DB schema & migrations

- Applied all 13 forward migrations via the app's real migration runner
  (not manual SQL) against `rut_db_live`.
- Re-ran every migration's raw SQL a second time (bypassing the
  `schema_migrations` tracking table) to confirm true idempotency — zero
  errors on any of the 13.
- **Found and fixed a real data conflict during the dry run**: two User
  accounts (`hr@gttdata.ai`, `management1@rutportal.com`) both linked to
  the same Employee (id 331). Resolved per explicit user decision (kept
  the HR-role account's link); the dedup logic added to the migration
  generalizes the same tiebreaker (prefer the HR-role holder, else
  earliest-created) for any other environment with the same issue.
- **Found two more out-of-band leftover roles** (`Team Head`, `test`)
  not in the original remap plan — zero holders, removed outright.
- Verified post-migration: `role_migration_log` contained exactly 5 rows
  (4 legacy-role remaps + 1 `user_roles` discrepancy), zero users left
  with `role_id IS NULL`.

## Stage 2 — Auth/login unification & capability engine

Live HTTP tests against a running server, one throwaway User per role
tier (Platform Admin, BU Admin, Manager, Service PO Admin, Project Admin):

- **Login response shape**: confirmed JWT payload
  `{ id, email, roleId, roleName, hierarchyRank, employeeId }` and
  response body `{ user, employee: null, roles: [...], forms: {...} }`
  for a non-Employee-linked account.
- **Form Master per role**: Platform Admin received the full active-form
  catalog (the implicit bypass); BU Admin and Manager each received
  exactly their seeded set (verified field-by-field against the seed
  migration).
- **Capability inheritance — the core new mechanism**:
  - Service PO Admin (no senior-tier bypass, rank 6) successfully hit a
    Manager-only-gated endpoint (`GET /my-team/employees`) via the
    1-hop `inherits_role_id` edge.
  - Project Admin (rank 5) successfully hit the same endpoint via the
    **2-hop** chain (Project Admin ← Service PO Admin ← Manager),
    confirming the resolver walks transitively, not just one level.
- **Senior-tier bypass**: BU Admin (rank 4) passed the same Manager-only
  endpoint via the rank-based bypass, not a direct capability grant.
- **Platform Admin business-route block**: confirmed 403
  `PLATFORM_ADMIN_FORBIDDEN` on `GET /companies`; confirmed 200 on the
  allow-listed `GET /roles`.
- Regression: `GET /auth/profile` returned correct data for a Manager.

## Stage 3 — Employee/User sync + manager mapping flows

- **Bug found before any HTTP test ran**: `userRepository.js` still
  included a `Role` include aliased `roles` (plural) against the
  many-to-many association removed in Stage 2 — would have thrown a
  Sequelize association error on every user list/lookup. Fixed and
  re-verified with a direct `findAll`/role-filter call against the live
  DB before proceeding.
- **Bug found via the first live employee-creation attempt**:
  `ManagerEmployeeMapping.js`'s model definition was never updated for
  the Stage 1 `mapping_type` column — Sequelize's own stale-metadata
  validation produced two confusing "must be unique" errors instead of
  succeeding. Fixed the model, restarted the server, confirmed the
  transaction had cleanly rolled back with no orphaned Employee/User
  rows from the failed attempt, then retried successfully.
- **Full employee-creation flow, live**: HR created an Employee with
  both a Primary and Secondary Manager in one call — confirmed via
  direct DB query that both `manager_employee_mappings` rows
  (`PRIMARY`/`SECONDARY`) were created with the correct `manager_user_id`s.
- **New Employee login**: the auto-created User logged in successfully
  and the response's top-level `employee` field was fully populated
  (matching the spec's `{user, employee}` example exactly); `forms`
  correctly matched the Employee role's seeded set (Timesheet, Reports).
- **Team Mapping self-service**: Service PO Admin added a Manager to
  their own team (`POST /team-mappings/managers`), then listed it back;
  a Manager account was correctly **blocked** (403) from the same
  Service-PO-Admin-only endpoint.
- **Manager self-service "Map Employees"**: a second Manager
  self-mapped as an Employee's Secondary Manager, confirmed the
  Employee appeared in `GET /my-team/employees`, then successfully
  unmapped (`DELETE`, 204).
- Regression: `GET /employees`, `GET /users`, `GET /roles` all still
  200.

## Stage 4 — Remaining controllers/routes + `ROLE_CREATION_MATRIX`

Full hierarchy chain exercised live, each hop confirmed both for the
**allowed** creation and at least one **blocked** shortcut:

| Actor | Action | Result |
|---|---|---|
| Platform Admin | creates Admin | ✅ 201 |
| Platform Admin | creates Entity Admin directly | ✅ blocked, 403 |
| Admin | creates Entity Admin | ✅ 201 |
| Admin | views Entity Admins list | ✅ 200, correct data |
| Entity Admin | creates its own Entity | ✅ 201 (prerequisite) |
| Entity Admin | creates Company + first BU Admin | ✅ 201, transactional |
| BU Admin | creates Project Admin | ✅ 201 |
| BU Admin | creates another BU Admin | ✅ blocked, 403, message names the allowed roles |
| Project Admin | creates Service PO Admin | ✅ 201 |
| Project Admin | creates Manager directly | ✅ blocked, 403 |
| Service PO Admin | creates Manager | ✅ 201 |
| Admin | views BU Admins platform-wide (not just owned Entities) | ✅ 200, confirms `requireEntityAdminOrAdmin`'s scope resolution |

- **Bug found via this same test sequence**: an Admin (whose own
  `company_id` is `NULL`) creating a BU Admin via `POST /users` produced
  a BU Admin with `company_id = 1` instead of `NULL` — traced to a stray
  Postgres-level `DEFAULT 1` on `users.company_id`, a leftover from the
  original multi-tenancy backfill migration that had sat harmless until
  this redesign introduced the first actors with a legitimately absent
  company. Audited all company-scoped tables and found the **same stray
  default on 8 other tables** (`service_pos`, `timesheets`, `clients`,
  etc.) — those are pre-existing and out of this redesign's scope, left
  untouched and flagged for separate follow-up. Fixed `users.company_id`
  specifically (migration + defensive `?? null` in code), corrected the
  corrupted test row, and re-verified the full chain produced correct
  `NULL`/real company ids afterward.

## Post-Stage-4 fix — admin password reset

While writing the frontend integration doc, re-checking every removed
endpoint's replacement surfaced a real regression: removing Employee's
own `PUT /employees/:id/reset-password` left **no working way** for
HR/Admin to reset someone else's forgotten password — the only
remaining password-change route (`PUT /users/:id/change-password`)
requires the *old* password even for an admin actor, which an admin
resetting a forgotten password wouldn't have. A schema for the correct
behavior (`adminResetPasswordSchema`) already existed in
`userValidation.js` but was never wired to any route — dead code,
pre-existing this redesign.

Fixed: added `userService.resetPassword()` (no old-password check),
`userController.resetPassword`, and `PUT /users/:id/reset-password`
(HR or senior-tier only, `403` otherwise). Verified live: HR reset a
target user's password without knowing the old one; the target logged
in with the new password (`200`) and the old password was rejected
(`401`).

## What was not automated-tested (manual verification only)

- No unit/integration test suite exists for any of these flows; all
  verification above was manual, live HTTP + direct DB queries.
- CSV bulk employee import was **not** re-tested end-to-end after its
  `email_id`/password fields were stripped — the change is a pure
  removal (verified to load and not reference dropped columns) but a
  live import run was not performed.
- The two intentionally-left-broken route files
  (`headManagerMapping.routes.js`, `managerMapping.routes.js` — deleted
  entirely in Stage 3) are gone, so there is nothing left to test there.

## Recommended before production deploy

1. Re-run the full Stage 1 migration dry-run against a fresh copy of the
   **Railway** production database specifically (not just local dev) —
   `role_migration_log` row counts will differ from local, and this is
   the last chance to review them before `main` auto-deploys.
2. Smoke-test login for at least one real (non-test) account per role
   tier post-deploy, since the legacy-role remap changes real users'
   effective role.
3. Confirm the 8 other stray `company_id` defaults (flagged above,
   left untouched) don't need the same fix before any future feature
   introduces a no-company actor writing to those tables.
