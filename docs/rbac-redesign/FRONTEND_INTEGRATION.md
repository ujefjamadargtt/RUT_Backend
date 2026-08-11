# RBAC Redesign — Frontend Integration Prompt

Hand this document to whoever (or whichever AI) is building the frontend
for this change. It is self-contained: role hierarchy, every new/modified
endpoint with real request/response payloads, every removed endpoint,
and — at the end — the things that are **not** implemented yet, so you
don't build UI against something that doesn't exist.

This is a **breaking change** to authentication. There is no dual-mode
transition — the old `loginType`/dual-account-type flow is gone entirely.

---

## 0. Role Hierarchy (context for every screen below)

```
Platform Admin (rank 1)
      |
    Admin (rank 2)
      |
Entity Admin (rank 3)
      |
  BU Admin (rank 4)
      |
Project Admin (rank 5) -> Service PO Admin (rank 6) -> Manager (rank 7)
      |
  Employee (rank 8)

HR (parallel branch — not part of the numeric chain)
```

**Who can create whom** (enforced server-side; a disallowed attempt
returns `403` naming the allowed roles):

| Actor | Can create |
|---|---|
| Platform Admin | Admin |
| Admin | Entity Admin, BU Admin |
| Entity Admin | BU Admin |
| BU Admin | Project Admin, Service PO Admin |
| Project Admin | Service PO Admin |
| Service PO Admin | Manager |
| HR | Employee (via a dedicated flow, not the generic user-creation endpoint) |

Platform Admin/Admin/Entity Admin have **no company** (`company_id: null`)
— they operate platform-wide or across a set of Entities, never inside
the `X-Company-Id` header scoping that every other role uses.

---

## 1. API Conventions

- Base path: `/api/v1`
- Every protected endpoint requires `Authorization: Bearer <accessToken>`.
- Company-scoped roles (BU Admin and below) must send `X-Company-Id: <id>`
  on every request — the backend validates it against the token's real
  company, it does not trust the header as the source of truth.
  Platform Admin/Admin/Entity Admin must **omit** it (or it's ignored).
- Standard success envelope: `{ "success": true, "message": "...", "data": ... }`
  (list endpoints add `"meta": { "page", "limit", "total", ... }`).
- Standard error envelope: `{ "success": false, "message": "..." }`, plus
  `"errors": [...]` for Joi validation failures (422).
- Common HTTP codes you'll see everywhere: `401` (no/bad/expired token),
  `403` (authenticated but not permitted — message explains why),
  `404` (not found / not in your scope — same response either way, by
  design, so scope leaks nothing), `409` (conflict, e.g. duplicate
  email), `422` (validation error).

---

## 2. Authentication

### 2.1 Login — breaking change

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "manager@example.com",
  "password": "Sm0keTest!23"
}
```

No `loginType` field anymore — remove any "which account are you"
disambiguation UI. Every account (including what used to be a separate
"Employee login") now authenticates identically.

**Response 200** (real captured example — a Manager account with a
linked Employee record):

```json
{
  "success": true,
  "message": "Login successful.",
  "data": {
    "accessToken": "eyJhbGciOi...",
    "refreshToken": "eyJhbGciOi...",
    "expiresIn": "15m",
    "user": {
      "id": 69,
      "company_id": 1,
      "employee_id": 419,
      "email": "stage3-smoketest-employee@example.com",
      "role_id": 26,
      "status": "active",
      "role": {
        "id": 26,
        "role_name": "Employee",
        "permission": "Read",
        "status": "active",
        "hierarchy_rank": 8,
        "inherits_role_id": null
      }
    },
    "employee": {
      "id": 419,
      "company_id": 1,
      "employee_code": "STG3TEST01",
      "full_name": "Stage3 Smoketest Employee",
      "designation": null,
      "status": "active"
    },
    "roles": [
      { "id": 26, "name": "Employee", "permission": "Read", "hierarchyRank": 8, "is_original_data_visible": false }
    ],
    "forms": {
      "Reports": [{ "id": 38, "name": "Reports" }],
      "Resources": [{ "id": 36, "name": "Timesheet" }]
    }
  }
}
```

Key points for the frontend:

- **`employee` is `null`** for any account with no linked Employee (every
  Admin/Manager-tier account that isn't also staff). Always null-check
  before rendering employee-specific UI (e.g. "my timesheet" widgets).
- **`roles` is always a one-element array** now (one role per user). Existing
  `.map()`/`[0]` code keeps working unchanged.
- **`forms` still drives the sidebar/menu exactly as before** — no
  rendering-logic change needed. Platform Admin now receives **every**
  active form (previously a curated subset) — its menu will be longer.
- JWT payload if you ever decode it client-side:
  ```json
  { "id": 69, "email": "...", "roleId": 26, "roleName": "Employee", "hierarchyRank": 8, "employeeId": 419, "iat": ..., "exp": ... }
  ```
  (previously: `roleId, roleIds[], roleNames[]` — now a single `roleId`/`roleName`.)

### 2.2 Refresh token — unchanged shape

```http
POST /api/v1/auth/refresh-token
{ "refresh_token": "..." }
```
Response mirrors login's `data` shape (`accessToken`, `refreshToken`, `expiresIn`, `user`, `roles`, `forms` — no `employee` key on this one, only on login).

### 2.3 Logout — unchanged

```http
POST /api/v1/auth/logout
{ "refresh_token": "..." }
```
Public route, no Bearer token needed, idempotent.

### 2.4 Forgot password / OTP — `loginType` removed from every step

```http
POST /api/v1/auth/forgot-password    { "email": "..." }
POST /api/v1/auth/resend-otp         { "email": "..." }
POST /api/v1/auth/verify-otp         { "email": "...", "otp": "582194" }
POST /api/v1/auth/reset-password     { "email": "...", "otp": "582194", "password": "NewPass!456", "confirmPassword": "NewPass!456" }
```
Responses no longer include/expect `loginType`/`accountTypes` — drop any
code that stored and replayed it between these steps.

### 2.5 Self-service change-password — requires the OLD password

```http
PUT /api/v1/auth/change-password
Authorization: Bearer <token>
{ "newPassword": "NewPass!456" }
```
Unchanged shape; works identically for every account tier now (no more
dual-token-type quirk).

### 2.6 User-management password endpoints (`/users/:id/...`)

Two **different** endpoints — don't conflate them:

```http
PUT /api/v1/users/:id/change-password
{ "old_password": "...", "new_password": "..." }
```
Self-service or an admin who somehow knows the old password. Requires
`old_password` to match, always.

```http
PUT /api/v1/users/:id/reset-password        ⭐ NEW in this redesign
{ "new_password": "NewPass!456", "confirm_password": "NewPass!456" }
```
**Use this one for "HR/Admin resets someone's forgotten password."** No
old password required. Restricted to HR or a senior admin tier
(Platform Admin/Admin/Entity Admin/BU Admin) — `403` otherwise. This
replaces the old, now-removed `PUT /employees/:id/reset-password` (an
Employee's login lives on their linked User now, not on the Employee
record itself).

---

## 3. Employee Management

### 3.1 Create Employee — payload shape changed

```http
POST /api/v1/employees
Authorization: Bearer <HR token>
X-Company-Id: 1
Content-Type: application/json

{
  "employee_code": "EMP2026001",
  "full_name": "Jane Doe",
  "designation": "Software Engineer",
  "total_experience": 3.5,
  "company_experience": 1.0,
  "date_of_joining": "2026-08-08",
  "email": "jane.doe@example.com",
  "password": "OptionalPass!23",
  "primary_manager_user_id": 65,
  "secondary_manager_user_id": 66
}
```

Field changes from before:

| Field | Status |
|---|---|
| `email_id` | ❌ removed — Employee no longer carries an email |
| `password` (Employee's own) | ❌ removed |
| `email` | ✅ **new, required** — becomes the auto-created linked User's login email |
| `password` (User's) | ✅ new, **optional** — omit to auto-generate |
| `primary_manager_user_id` | ✅ new, **required** — a **User id**, not an Employee id |
| `secondary_manager_user_id` | ✅ new, optional |

Manager ids must reference active Users, in the **same company**, holding
Manager (or a role that inherits Manager's capabilities — Service PO
Admin, Project Admin). A simple picker backed by
`GET /users?role_id=<manager_role_id>` (scoped by your own `X-Company-Id`)
is enough — the backend re-validates regardless.

**Response 201**:

```json
{
  "success": true,
  "message": "Employee created successfully.",
  "data": {
    "employee": {
      "id": 419,
      "employee_code": "EMP2026001",
      "full_name": "Jane Doe",
      "company_id": 1,
      "status": "active"
    },
    "user": {
      "id": 69,
      "email": "jane.doe@example.com",
      "role_id": 26,
      "employee_id": 419,
      "company_id": 1,
      "status": "active"
    },
    "temporaryPassword": "RP54#v$3uvA2sDN7"
  }
}
```

`temporaryPassword` appears **only** when `password` was omitted from the
request, and is returned **exactly once** — it cannot be retrieved again
after this response. If your UI has a "credentials created" confirmation
screen, this is the value to show/copy for the new hire; there is
currently no automatic "email the new employee their password" step.

### 3.2 Update Employee — manager reassignment added

```http
PUT /api/v1/employees/:id
{
  "designation": "Senior Software Engineer",
  "primary_manager_user_id": 70,
  "secondary_manager_user_id": null
}
```
`primary_manager_user_id`/`secondary_manager_user_id` are both optional
on update; pass `secondary_manager_user_id: null` explicitly to clear it.
`email`/`password` are **not** valid fields here anymore (they never were
on Employee — see above).

### 3.3 Everything else about Employees is unchanged

`GET /employees`, `GET /employees/:id`, `DELETE /employees/:id`,
`GET /employees/active/list`, `POST /employees/import` — same shapes as
before. **Removed**: `PUT /employees/:id/reset-password` (see §2.6).

---

## 4. User Management

`GET /users`, `GET /users/:id`, `POST /users`, `PUT /users/:id`,
`DELETE /users/:id` are shape-unchanged, but `POST`/`PUT` now enforce the
Role Creation Matrix (§0) server-side. A disallowed role assignment
returns:

```json
{ "success": false, "message": "\"BU Admin\" cannot assign role \"BU Admin\". Allowed roles: Project Admin, Service PO Admin." }
```

Safe to surface directly in a toast/error banner — no need to
pre-validate the matrix client-side, but you may want to filter the
"assign role" dropdown to the actor's allowed roles for a better UX (the
matrix in §0 is fixed, so it's safe to hardcode client-side too).

```http
POST /api/v1/users
{
  "email": "newadmin@example.com",
  "password": "Str0ng!Pass",
  "confirm_password": "Str0ng!Pass",
  "role_id": 23,
  "status": "active"
}
```

---

## 5. Role Master

`GET /roles` now returns two new-relevant fields per role:

```json
{
  "id": 23,
  "role_name": "Project Admin",
  "permission": "Read & Write",
  "status": "active",
  "hierarchy_rank": 5,
  "inherits_role_id": 24,
  "is_system": true
}
```

**The assignable role list is now exactly these 9**:
`Platform Admin, Admin, Entity Admin, BU Admin, Project Admin, Service PO Admin, Manager, Employee, HR`.

Removed entirely (existing holders were auto-remapped server-side, no
frontend action needed): `Super Admin, Head Manager, BU HR Head,
Division Head, Project Manager, Management, Finance`. If any UI has
these hardcoded, they will just never match anything post-deploy.

`PUT /roles/:id` and `DELETE /roles/:id` now return **403** for any role
with `is_system: true` (all 9 of the above) — disable rename/delete
controls in the Role Master UI when that flag is set.

---

## 6. Platform → Admin → Entity Admin → BU Admin chain

### 6.1 Platform Admin creates Admin — ⭐ new

```http
POST /api/v1/admins
Authorization: Bearer <Platform Admin token>
{ "email": "admin@example.com", "password": "Str0ng!Pass" }
```
```json
{ "success": true, "message": "Admin created successfully.", "data": { "id": 72, "email": "admin@example.com", "role_id": 20, "company_id": null } }
```
Platform Admin can **no longer** call `POST /entity-admins` — that
returns `403` now (Platform Admin should not create Entity Admin/BU Admin
directly; only Admin does).

### 6.2 Admin manages Entity Admins — create existed, list/view/edit/status are ⭐ new

```http
POST   /api/v1/entity-admins                    { "email": "...", "password": "..." }
GET    /api/v1/entity-admins?page=1&limit=20&status=active&search=&sort_by=created_at&sort_order=DESC
GET    /api/v1/entity-admins/:id
PUT    /api/v1/entity-admins/:id                { "email": "new@example.com" }
PATCH  /api/v1/entity-admins/:id/status         { "status": "inactive" }
```
List/view are platform-wide (Entity Admins have no company/entity of
their own to scope by) — same paginated envelope as every other list
endpoint in the app.

### 6.3 Admin or Entity Admin manages BU Admins — unchanged shape, wider access

`GET/POST /companies`, `PATCH /companies/:id`, and
`GET/PUT/PATCH /bu-admins/*` are **unchanged in request/response shape**,
but now reachable by **both** Admin (sees everything platform-wide) and
Entity Admin (sees only their own owned Entities) — no frontend branching
needed, the same calls just return a wider result set for an Admin actor.

```http
POST /api/v1/companies
Authorization: Bearer <Entity Admin or Admin token>
{
  "entity_id": 7,
  "company_code": "ACME",
  "company_name": "Acme Corporation",
  "admin_email": "admin@acme.com",
  "admin_password": "Str0ng!Pass"
}
```
```json
{
  "success": true,
  "message": "Company and its first BU Admin created successfully.",
  "data": {
    "company": { "id": 47, "entity_id": 7, "company_code": "ACME", "company_name": "Acme Corporation", "status": "active" },
    "admin": { "id": 77, "email": "admin@acme.com", "role_id": 11, "company_id": 47 }
  }
}
```

---

## 7. Team Mapping — ⭐ entirely new (Service PO Admin self-service)

Replaces the old `/head-manager-mappings` (BU-Admin-assigns-on-someone's-
behalf model). Service PO Admin now manages their own team directly —
every call below uses the caller's own identity, there's no "which Head
Manager" path param anymore.

```http
GET    /api/v1/team-mappings                                    # my own team roster
GET    /api/v1/team-mappings/available-managers                 # company Managers, flagged with current owner (if any)
POST   /api/v1/team-mappings/managers          { "manager_user_id": 65 }   # add to my team
DELETE /api/v1/team-mappings/managers/:managerUserId                       # remove from my team
GET    /api/v1/team-mappings/service-po-grants                  # PO grants across my whole team
POST   /api/v1/team-mappings/managers/:managerUserId/service-pos  { "service_po_id": 12 }  # grant a PO to my team Manager
DELETE /api/v1/team-mappings/managers/:managerUserId/service-pos/:servicePOId              # revoke that grant
```

`POST /managers` response:
```json
{ "success": true, "message": "Manager added to your team successfully.", "data": { "id": 3, "company_id": 1, "service_po_admin_user_id": 67, "manager_user_id": 65, "status": "active" } }
```

Errors follow the standard shape — e.g. adding a Manager already on
someone else's team: `409 { "message": "This Manager already belongs to a different Service PO Admin's team." }`.

---

## 8. Manager Self-Service (`/my-team/*`)

Existing endpoints, unchanged:
```http
GET    /api/v1/my-team/employees
GET    /api/v1/my-team/service-pos
POST   /api/v1/my-team/employees/:employeeId/service-pos   { "service_po_id": 12 }
DELETE /api/v1/my-team/employees/:employeeId/service-pos/:servicePOId
```

**⭐ New** — a Manager's own "Map Employees" capability (claims/releases
the *Secondary*-manager slot on an Employee already in the same company;
Primary is HR's job at creation time):

```http
POST /api/v1/my-team/employees
{ "employee_id": 420 }
```
```json
{ "success": true, "message": "Employee mapped successfully.", "data": { "id": 8, "manager_user_id": 66, "employee_id": 420, "mapping_type": "SECONDARY", "status": "active" } }
```
```http
DELETE /api/v1/my-team/employees/:employeeId
```
`204 No Content` on success; `404` if that Employee isn't yours (Primary
or Secondary).

---

## 9. Removed Endpoints (do not call these anymore)

| Removed | Use instead |
|---|---|
| `PUT /employees/:id/reset-password` | `PUT /users/:id/reset-password` (§2.6) — target the Employee's **linked User id**, not the Employee id |
| `POST /roles/user-mappings`, `GET/PUT/DELETE /roles/user-mappings/*` | None — a user has exactly one role, set via `PUT /users/:id { role_id }` |
| `GET/POST/DELETE /manager-mappings/*` | `/my-team/employees` (§8) and `/my-team/service-pos` (unchanged) |
| `GET/POST/DELETE /head-manager-mappings/*` | `/team-mappings/*` (§7) |
| `loginType` field anywhere | Removed, not replaced — see §2 |

---

## 10. ⚠️ Known Gaps — Do NOT Build UI For These Yet

Two capabilities are **seeded in the role/permission data but have no
backend implementation at all** — confirmed by code search, not an
oversight in this document:

1. **"Approve Timesheets"** — every role from Manager up through Entity
   Admin lists this as a responsibility, and the capability keys
   (`manager.approve_timesheets`, `servicepo.approve_timesheets`, etc.)
   exist in the database. **There is no approve endpoint anywhere in the
   codebase** — not before this redesign, not after. Timesheet approval
   as a feature has never been built. Do not add an "Approve" button
   expecting a `PUT /timesheets/:id/approve`-style route to exist.

2. **Org-scoped "View Mapped Employees" for BU Admin / Entity Admin /
   Project Admin** — their capability keys
   (`bu.view_mapped_employees`, `entity.view_mapped_employees`,
   `project.view_mapped_employees`) exist, but the only implemented
   "mapped employees" view is Manager/Service-PO-Admin-tier self-service
   (`GET /my-team/employees`, §8), scoped to mappings where the caller
   is literally listed as the manager. A BU Admin calling that endpoint
   would get an empty list, not "all employees in my company." The
   closest existing thing for a BU Admin today is the generic
   `GET /employees` (company-scoped, no capability gate) — usable as a
   stand-in, but it's not what the capability name implies.

Both are real, valuably-scoped features consistent with the new
hierarchy — they just weren't part of this redesign's approved scope
(which was the role/permission system itself, not new business
features). Flag these to product/backend before committing frontend
work against them.
