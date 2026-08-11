# RBAC Redesign Documentation

A complete redesign of authentication, authorization, and the role
hierarchy — Platform Admin → Admin → Entity Admin → BU Admin → Project
Admin → Service PO Admin → Manager → Employee, with HR as a parallel
branch. Backward compatibility was not required; this replaced the
previous flat/half-migrated RBAC system entirely.

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — role hierarchy, the
  permission-inheritance engine, Form Master, `ROLE_CREATION_MATRIX`,
  authentication/login flow, Employee creation flow, manager mapping
  flows, database changes summary, ER diagram.
- **[MIGRATIONS_AND_SEEDING.md](./MIGRATIONS_AND_SEEDING.md)** —
  migration-by-migration breakdown, the legacy-role remap table, seed
  strategy, and dry-run findings.
- **[MODIFIED_FILES.md](./MODIFIED_FILES.md)** — every model,
  repository, service, controller, route, validation, and config file
  this redesign touched, by layer.
- **[TESTING_SUMMARY.md](./TESTING_SUMMARY.md)** — what was verified
  live at each stage, the real bugs found and fixed along the way, and
  what's recommended before a production deploy.
- **[FRONTEND_INTEGRATION.md](./FRONTEND_INTEGRATION.md)** — self-contained
  frontend prompt: every new/modified/removed endpoint with real
  request/response payloads, the role hierarchy and creation matrix, and
  a "known gaps" section listing capabilities that are seeded but have no
  backend implementation yet (don't build UI for these).

Delivered in four implementation stages (DB schema → auth engine →
Employee/manager flows → remaining controllers/matrix wiring), each
verified live against a real database copy before moving to the next.
