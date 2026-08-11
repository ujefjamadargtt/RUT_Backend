# RBAC Redesign — Modified Files

Scope note: this backend already had in-progress, uncommitted work
(Entity/BU Admin, Projects, default categories/types) before this
redesign started. The entries below describe what **this RBAC redesign**
changed in each file — some files already carried unrelated prior edits,
which are not this document's concern.

## Database (all new)

26 files (13 forward migrations + 13 rollbacks) under
`database/migrations/20260834_*` through `20260847_*` — see
[MIGRATIONS_AND_SEEDING.md](./MIGRATIONS_AND_SEEDING.md) for the full list
and purpose of each.

## Models

| File | Change |
|---|---|
| `src/models/Role.js` | **New fields**: `hierarchy_rank`, `inherits_role_id`, `is_system`. Removed dead `static associate()` (never invoked — see `index.js`). |
| `src/models/User.js` | **Removed**: `is_platform_admin` field. Removed dead `belongsToMany(Role, through: UserRole)` from `static associate()`. |
| `src/models/Employee.js` | **Removed**: `password`, `email_id` fields, their bcrypt hooks, `validatePassword()`, the `EmployeeSession` association. |
| `src/models/RoleCapability.js` | **New** — composite-PK `(role_id, capability_key)` model backing the inheritance engine. |
| `src/models/TeamMapping.js` | **New** — replaces `HeadManagerMapping.js` (deleted); `service_po_admin_user_id` instead of `head_manager_user_id`. |
| `src/models/ManagerEmployeeMapping.js` | **Rewritten** — added `mapping_type` field (`PRIMARY`/`SECONDARY`), unique index widened to `(employee_id, mapping_type)`. |
| `src/models/index.js` | Removed `UserRole`/`EmployeeSession` imports and every association referencing them; added `RoleCapability` associations, `Role` self-referencing `inherits_role_id`/`inheritedBy`; swapped `HeadManagerMapping` associations for `TeamMapping`. |
| `src/models/HeadManagerMapping.js` | **Deleted** — replaced by `TeamMapping.js`. |
| `src/models/UserRole.js` | **Deleted** — the `user_roles` many-to-many table is gone; `users.role_id` is the sole source of truth. |
| `src/models/EmployeeSession.js` | **Deleted** — Employees no longer authenticate directly. |

## Config

| File | Change |
|---|---|
| `src/config/roleHierarchy.js` | **New** — `ROLE_CREATION_MATRIX` and `canActorCreateRole()`/`getCreatableRoleNames()`. |
| `src/config/jwt.js` | Removed every Employee-specific token function (`signEmployeeToken`, `verifyEmployeeToken`, `signEmployeeRefreshToken`, `verifyEmployeeRefreshToken`, `generateEmployeeTokens`); `generateTokens()` payload simplified to `{ id, email, roleId, roleName, hierarchyRank, employeeId }`. |

## Middlewares

| File | Change |
|---|---|
| `src/middlewares/auth.js` | Rewritten: single-role load (no `roles` many-to-many include), computes `req.capabilities` via `roleHierarchyService`, gates on `hierarchy_rank` instead of `is_platform_admin`. |
| `src/middlewares/authorize.js` | Rewritten to accept capability keys instead of role-name arrays; `SUPERUSER_ROLES` hardcoded bypass replaced by `roleHierarchyService.isSeniorTier()`. |
| `src/middlewares/resolveCompany.js` | Company-scoping skip extended from `is_platform_admin` to `hierarchyRank === 1 \|\| 2 \|\| 3` (Platform Admin/Admin/Entity Admin). |
| `src/middlewares/requirePlatformAdmin.js` | Checks `hierarchyRank === 1` instead of the `is_platform_admin` boolean. |
| `src/middlewares/requireEntityAdmin.js` | Doc comment corrected (stale `SUPERUSER_ROLES` reference); scope narrowed to Entity-Admin-**only** endpoints (Entity Master). |
| `src/middlewares/requireEntityAdminOrAdmin.js` | **New** — shared scope resolver for BU-Admin-Master-adjacent screens reachable by both Admin (platform-wide) and Entity Admin (owned Entities only). |
| `src/middlewares/employeeAuth.js` | **Deleted** — Employees authenticate through `auth.js` like everyone else. |
| `src/middlewares/dualAuth.js` | **Deleted** — no second account type to dispatch between. |
| `src/utils/loginTypeResolver.js` | **Deleted** — no dual-account disambiguation needed. |

## Repositories

| File | Change |
|---|---|
| `src/repositories/authRepository.js` | Rewritten: single `findUserByEmail`/`findUserById`; removed every Employee-specific function (`findEmployeeByEmail`, `createEmployeeSession`, `findEmployeeSession`, `deleteEmployeeSession`). |
| `src/repositories/userRepository.js` | **Bug fix**: removed a dangling `Role` "roles" (plural) include referencing the deleted `User↔Role` many-to-many association, which would have crashed every user list/lookup; simplified the `role_id` filter; added `findByRole()` (platform-wide, unscoped). |
| `src/repositories/roleRepository.js` | Removed `UserRole`-based checks from `countUsersByRole`/`hasAssignedUsers` — `users.role_id` is now the only signal. |
| `src/repositories/employeeRepository.js` | Removed `findByEmail`/`findAllEmailsGlobal` and every `email_id` reference (column dropped); `create()`/`update()` made transaction-aware (`options`/`{transaction}`). |
| `src/repositories/rbacRepository.js` | Removed every `user_roles`-based function; added `findAllActiveForms()` for Platform Admin's implicit "All Forms" bypass. |
| `src/repositories/managerEmployeeMappingRepository.js` | Rewritten for `mapping_type` awareness: `findAllByEmployee`, `findByEmployeeAndType` replace the old single-slot `findByEmployee`. |
| `src/repositories/managerServicePOMappingRepository.js` | Doc comment updated (Head Manager → Service PO Admin). |
| `src/repositories/teamMappingRepository.js` | **New** — replaces `headManagerMappingRepository.js` (deleted). |
| `src/repositories/headManagerMappingRepository.js` | **Deleted**. |

## Services

| File | Change |
|---|---|
| `src/services/roleHierarchyService.js` | **New** — the capability-inheritance resolver (see ARCHITECTURE.md §3). |
| `src/services/authService.js` | Rewritten: single login path, `{ user, employee }` response shape, `changePassword()` no longer branches on account type. |
| `src/services/forgotPasswordService.js` | Rewritten to User-only — dropped the dual-lookup/`loginType`/`accountTypes` machinery. |
| `src/services/rbacService.js` | Removed every `user_roles`-based function; `getActiveFormsForRoles()` gained the Platform Admin "all forms" bypass. |
| `src/services/roleService.js` | `update()`/`delete()` now block renaming/deleting a role where `is_system = true`. |
| `src/services/userService.js` | `BU_ADMIN_CREATABLE_ROLES` array replaced by `assertActorCanAssignRoles()` (`ROLE_CREATION_MATRIX`-driven), applied to both `create()` and `update()`; fixed a stray `DEFAULT 1` data-corruption path (`company_id ?? null`); **added `resetPassword()`** — admin-side reset with no old-password check, closing the gap left by removing Employee's own reset-password endpoint. |
| `src/services/employeeService.js` | Rewritten: `create()` now runs the Employee+User+manager-mapping transaction (see ARCHITECTURE.md §7); `resetPassword()` removed. |
| `src/services/employeeImportService.js` | Removed `email_id`/default-password handling — bulk-imported rows are pure Employee business data, no linked User. |
| `src/services/managerSelfServiceService.js` | Added `mapEmployeeToSelf()`/`unmapEmployeeFromSelf()` — Manager's own "Map Employees" capability. |
| `src/services/entityAdminService.js` | Extended with `getAll`/`getById`/`update`/`setStatus` — Admin's "View/Manage Entity Admins." |
| `src/services/teamMappingService.js` | **New** — replaces `headManagerMappingService.js` (deleted); self-service roster + Service-PO-grant management. |
| `src/services/adminService.js` | **New** — Platform Admin's `createAdmin()`. |
| `src/services/headManagerMappingService.js` | **Deleted**. |
| `src/services/managerDelegationService.js` | **Deleted** — the Head-Manager-delegates-to-Manager flow is fully retired. |

## Controllers

| File | Change |
|---|---|
| `src/controllers/authController.js` | `login`/`forgotPassword`/`resendOtp`/`verifyOtp`/`resetPassword`/`changePassword` all simplified — no `loginType`, no `req.authId`/`req.userType`. |
| `src/controllers/rbacController.js` | Removed the four `user-mappings` endpoints. |
| `src/controllers/userController.js` | `create`/`update` pass `req.userRoleName` (not `req.userRoles`); `changePassword`'s authorization check replaced; **added `resetPassword`** action (HR/senior-tier only). |
| `src/controllers/employeeController.js` | `create` returns the new `{ employee, user, temporaryPassword? }` shape; `resetPassword` removed. |
| `src/controllers/entityAdminController.js` | Extended with `getAll`/`getById`/`update`/`setStatus`. |
| `src/controllers/managerSelfServiceController.js` | Added `mapEmployee`/`unmapEmployee`. |
| `src/controllers/teamMappingController.js` | **New**. |
| `src/controllers/adminController.js` | **New**. |
| `src/controllers/headManagerMappingController.js` | **Deleted**. |
| `src/controllers/managerDelegationController.js` | **Deleted**. |

## Routes

| File | Change |
|---|---|
| `src/routes/authRoutes.js` | Removed `dualAuth`; `/change-password` now uses `authenticate`. |
| `src/routes/user.routes.js` | **Added** `PUT /users/:id/reset-password` (wires the previously-defined-but-unused `adminResetPasswordSchema`). |
| `src/routes/rbac.routes.js` | Removed the four `user-mappings` routes and their schema imports. |
| `src/routes/employee.routes.js` | `POST /` gated by `authorize('hr.create_employee')`; `/reset-password` route removed. |
| `src/routes/employeeTimesheet.routes.js` | `employeeAuth` → `authenticate` + `authorize('employee.view_timesheet'\|'employee.fill_worklog')`. |
| `src/routes/employeeMonthlyWorkLog.routes.js` | Same pattern as above. |
| `src/routes/employeeReport.routes.js` | `employeeAuth` → `authenticate` + `authorize('employee.view_reports')`. |
| `src/routes/managerSelfService.routes.js` | `authorize(['Manager'])` → capability keys; added `POST/DELETE /employees`. |
| `src/routes/entityAdmin.routes.js` | `POST /` regated from `requirePlatformAdmin` to `authorize('admin.create_entity_admin')`; added `GET /`, `GET /:id`, `PUT /:id`, `PATCH /:id/status`. |
| `src/routes/company.routes.js` | `requireEntityAdmin` → `requireEntityAdminOrAdmin`. |
| `src/routes/entityBuAdmin.routes.js` | Same. |
| `src/routes/admin.routes.js` | **New** — `POST /admins`. |
| `src/routes/teamMapping.routes.js` | **New** — replaces `headManagerMapping.routes.js` (deleted). |
| `src/routes/headManagerMapping.routes.js` | **Deleted**. |
| `src/routes/managerMapping.routes.js` | **Deleted** — see ARCHITECTURE.md §8 for what replaced it. |
| `src/app.js` | Mount changes: `+/admins`, `+/team-mappings`; `-/manager-mappings`, `-/head-manager-mappings`. |

## Validations

| File | Change |
|---|---|
| `src/validations/authValidation.js` | Removed `loginType` from every schema. |
| `src/validations/rbacValidation.js` | Removed the `user-mappings` schemas. |
| `src/validations/employeeValidation.js` | `createEmployeeSchema`: `-email_id`, `-password`(Employee's) as required-login fields; `+email`, `+password`(optional, User's), `+primary_manager_user_id`(required), `+secondary_manager_user_id`(optional). `updateEmployeeSchema`: same column removals, `+` optional manager reassignment fields. `resetEmployeePasswordSchema` removed. |
| `src/validations/entityAdminValidation.js` | Added `updateEntityAdminSchema`, `setStatusSchema`, `listEntityAdminsQuerySchema`. |
| `src/validations/managerSelfServiceValidation.js` | Added `mapEmployeeSchema`. |
| `src/validations/teamMappingValidation.js` | **New**. |
| `src/validations/adminValidation.js` | **New**. |
| `src/validations/headManagerMappingValidation.js` | **Deleted**. |
| `src/validations/managerDelegationValidation.js` | **Deleted**. |
