# RUT Portal — Database Setup

Resource Utilization Tracking · PostgreSQL 14+

---

## Prerequisites

| Requirement | Minimum version |
|-------------|----------------|
| PostgreSQL  | 14.x           |
| psql CLI    | bundled with PostgreSQL |
| Node.js     | 18.x (for bcrypt re-hash step) |

---

## Quick Start

### 1. Create the database and user

Connect to PostgreSQL as a superuser (e.g. `postgres`) and run:

```sql
CREATE USER rut_user WITH PASSWORD 'change_this_password';
CREATE DATABASE rut_portal OWNER rut_user;
GRANT ALL PRIVILEGES ON DATABASE rut_portal TO rut_user;
```

> **Security note:** Pick a strong password and store it only in your `.env` file.
> Never commit credentials to source control.

---

### 2. Apply the schema

```bash
psql -U rut_user -d rut_portal -f database/schema.sql
```

This creates all 15 tables, indexes, foreign keys, and `updated_at` triggers.

---

### 3. Regenerate the admin password hash

Before seeding, generate a fresh bcrypt hash for `Admin@123`
(or your chosen admin password) inside the project:

```js
// scripts/hash-password.js
const bcrypt = require('bcrypt');
bcrypt.hash('Admin@123', 12).then(hash => console.log(hash));
```

```bash
node scripts/hash-password.js
# copy the printed hash
```

Open `database/seeds.sql` and replace the placeholder hash on the line:

```sql
'$2b$12$K8HJZ3xQ2vL9mN4pR7tWOeYsF1dCgBiA0uE6jM5nP3qV8wX2yZ4aK',
```

with the hash you just generated.

---

### 4. Apply the seed data

```bash
psql -U rut_user -d rut_portal -f database/seeds.sql
```

This inserts:
- 5 roles: HR, Finance, Division Head, Project Manager, Management
- 4 service types: Project, Service Pack, Resource Outsourcing, Managed Services
- 1 admin employee (`EMP-001 / System Administrator`)
- 1 admin user (`admin@rutportal.com` / `Admin@123`, role: Management)

---

## Environment Variables

Create a `.env` file at the project root (copy `.env.example` if it exists):

```env
# PostgreSQL
DB_HOST=localhost
DB_PORT=5432
DB_NAME=rut_portal
DB_USER=rut_user
DB_PASSWORD=change_this_password
DB_POOL_MIN=2
DB_POOL_MAX=10

# JWT
JWT_SECRET=replace_with_a_long_random_string
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=replace_with_another_long_random_string
JWT_REFRESH_EXPIRES_IN=7d

# App
NODE_ENV=development
PORT=3000
```

Generate strong secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Sequelize Setup (reference)

`config/database.js` should read from `process.env`:

```js
module.exports = {
  development: {
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT) || 5432,
    dialect:  'postgres',
    pool: {
      min: Number(process.env.DB_POOL_MIN) || 2,
      max: Number(process.env.DB_POOL_MAX) || 10,
    },
    logging: false,
  },
};
```

---

## Resetting the Database (development only)

To wipe everything and start fresh:

```bash
psql -U rut_user -d rut_portal -c "
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;
  GRANT ALL ON SCHEMA public TO rut_user;
"
psql -U rut_user -d rut_portal -f database/schema.sql
psql -U rut_user -d rut_portal -f database/seeds.sql
```

> Never run this against a production database.

---

## Table Overview

| Table | Description |
|-------|-------------|
| `roles` | User role definitions (HR, Finance, etc.) |
| `employees` | Employee master records |
| `users` | Auth accounts linked to employees |
| `clients` | Client / customer master |
| `service_types` | PO service categories |
| `service_pos` | Service Purchase Orders |
| `service_po_resources` | Employee–PO assignments |
| `sub_projects` | Sub-projects under a PO |
| `monthly_costs` | Per-employee monthly cost breakdown |
| `timesheets` | Daily hour logs per employee per PO |
| `audit_logs` | Full audit trail (JSONB old/new values) |
| `user_sessions` | Refresh-token store |
| `timesheet_import_history` | Bulk import job records |
| `timesheet_import_errors` | Row-level errors from bulk imports |
| `notifications` | In-app notifications per user |

---

## Notes

- All tables that track changes include `created_at`, `updated_at`, `created_by`, and `updated_by` columns.
- `updated_at` is maintained automatically by PostgreSQL triggers — no application-level logic needed.
- `audit_logs.old_values` and `audit_logs.new_values` are indexed with GIN for fast JSONB queries.
- `user_sessions` cascades deletes from `users` — removing a user clears all their sessions.
- `timesheet_import_errors` cascades deletes from `timesheet_import_history`.
