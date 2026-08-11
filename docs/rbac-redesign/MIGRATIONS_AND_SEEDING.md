# RBAC Redesign — Migration & Seed Strategy

## How migrations run

Per `database/README.md`: every `.sql` file in `database/migrations/`
(except `*_rollback.sql`) is applied automatically, in filename order, the
next time the server starts. Nothing manual is required beyond deploying
the code — this held true throughout this redesign; every migration below
was verified by letting the app's own migration runner apply it, not by
hand-running SQL.

Filenames in this repo use a `YYYYMMDD`-shaped counter that, for this
project, continues incrementing past calendar-valid days once several
changes land the same development day (e.g. `20260833` → `20260834`) —
this redesign's migrations continue that existing convention rather than
switching to real calendar dates, so they keep sorting correctly after
the last pre-existing migration (`20260833_create_manager_servicepo_mappings.sql`).

## Migration-by-migration

| File | Purpose |
|---|---|
| `20260834_add_role_hierarchy_columns` | `roles.+hierarchy_rank`, `+inherits_role_id`, `+is_system` |
| `20260835_create_role_capabilities` | New `role_capabilities` table |
| `20260836_seed_target_roles_and_capabilities` | Seeds/updates all 9 target roles (rank, inheritance edges, `is_system=true`) + their capability grants |
| `20260837_create_role_migration_log` | New audit table for the remap below |
| `20260838_remap_legacy_roles` | Moves every user off an obsolete role onto its nearest replacement, logging each move |
| `20260839_drop_obsolete_roles` | Deletes the now-unreferenced obsolete role rows (cascades their `role_form_mapping`/`user_roles` rows) |
| `20260840_collapse_user_roles` | Logs any `user_roles` row that disagreed with `users.role_id`, then drops the `user_roles` table |
| `20260841_drop_users_is_platform_admin` | Drops the boolean flag; de-duplicates any pre-existing `employee_id` collisions (with an HR-role tiebreaker) before adding a one-User-per-Employee unique index |
| `20260842_employees_drop_login_columns` | Drops `employees.password`/`email_id`; drops `employee_sessions` |
| `20260843_manager_employee_mappings_add_type` | Adds `mapping_type`, widens the unique constraint to `(employee_id, mapping_type)` |
| `20260844_rename_head_manager_mappings_to_team_mappings` | Table + column rename (`head_manager_user_id` → `service_po_admin_user_id`), guarded so it's safe to re-run |
| `20260845_reseed_form_master_and_role_form_mapping` | Adds 14 new forms; full reset-and-reseed of `role_form_mapping` for the 8 non-Platform-Admin target roles |
| `20260846_drop_unreferenced_legacy_roles` | Removes two out-of-band leftover roles (`Team Head`, `test`) discovered during the dry run — zero-holder guarded |
| `20260847_drop_users_company_id_default` | Drops a stray `DEFAULT 1` on `users.company_id` (see [TESTING_SUMMARY.md](./TESTING_SUMMARY.md)) |

Every migration above ships with a companion `_rollback.sql` file (manual
revert only, never auto-run), and every one was written to be idempotent
— confirmed by re-running each file's raw SQL a second time against the
dry-run database with zero errors.

## Legacy-role remap table (migration 20260838)

Decided with the user: **remap, don't drop**, so no existing account is
orphaned.

| Obsolete role | Remapped to | Rationale |
|---|---|---|
| Super Admin | Admin | Broad, near-platform-wide operational scope |
| Head Manager | Service PO Admin | Service PO Admin now owns the Manager "team" directly |
| BU HR Head | HR | Both are HR-flavored roles at the BU tier |
| Division Head | BU Admin | "Division" ≈ Business Unit |
| Project Manager | Project Admin | Direct name match |
| Management | Admin | Generic senior-oversight role |
| Finance | Employee | No equivalent in the new hierarchy — least-privilege fallback, flagged in `role_migration_log` for manual review |

The pre-existing `HR` role keeps its name and id — only its capabilities/
forms were redefined to the new spec.

**Two additional roles were found and removed during the dry run**, not
originally in this table: `Team Head` and `test` — both out-of-band,
zero-holder rows, removed outright in `20260846` rather than run through
the remap machinery.

## Seed strategy

1. **Roles**: 9 target roles, `is_system = true` (blocks delete/rename via
   the dynamic Role CRUD — see `roleService.js`).
2. **Capabilities**: one `role_capabilities` row per bullet in the spec's
   "ROLE RESPONSIBILITIES" section — see
   [ARCHITECTURE.md §3](./ARCHITECTURE.md#3-permission-inheritance-engine)
   for the full table. Inherited capabilities are **never** duplicated
   into a role's own rows — the resolver computes those at read time.
3. **Form Master**: 14 new forms created; `role_form_mapping` fully reset
   and reseeded per the spec's literal per-role list (not inherited —
   see ARCHITECTURE.md §4). Platform Admin gets no stored rows at all —
   its "All Forms" access is an implicit bypass in
   `rbacService.getActiveFormsForRoles()`.
4. **Legacy data**: handled via the remap (above), not a fresh-seed
   concern — this only matters for environments with pre-existing data
   (local dev, and eventually Railway prod).

## Dry-run verification performed

Every migration in this set was applied against a local copy of
`rut_db_live` (the developer's local Postgres) via the app's own
migration runner, **before** any of it reached a shared branch or
Railway. Findings from that dry run:

- One real duplicate-`employee_id` conflict on live data (two User
  accounts linked to the same Employee) — resolved per the user's
  explicit decision, logged in `role_migration_log`.
- Two out-of-band roles (`Team Head`, `test`) with zero holders —
  removed.
- Final `role_migration_log` after a full run: exactly 5 rows — 4 users
  moved off `Head Manager`/`Management`, 1 `user_roles` discrepancy
  discarded during the collapse. No orphaned users (`role_id IS NULL`)
  after the remap.

**Before this reaches Railway**: re-run the same dry-run process against
a fresh copy of the production database (per `database/README.md`'s
documented process) and review `role_migration_log`'s row count/contents
before merging to `main` — Railway auto-deploys and auto-migrates on
push to `main`, so this is the last manual checkpoint.
