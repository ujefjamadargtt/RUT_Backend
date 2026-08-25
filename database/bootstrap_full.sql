-- =============================================================================
-- RUT Portal — Full Database Bootstrap
-- Generated from database/schema.sql + database/migrations/*.sql (forward-only,
-- chronological order — identical to what src/database/migrationRunner.js applies
-- automatically against a blank database on server startup).
-- =============================================================================

BEGIN;

-- ================== database/schema.sql (baseline) ==================
-- =============================================================================
-- RUT Portal - Resource Utilization Tracking
-- PostgreSQL Schema
-- =============================================================================

-- Enable pgcrypto for UUID/hashing support (optional, used for extensions)
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- UTILITY: updated_at trigger function
-- =============================================================================

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- TABLE: roles
-- =============================================================================

DROP TABLE IF EXISTS roles CASCADE;
CREATE TABLE roles (
  id           SERIAL PRIMARY KEY,
  role_name    VARCHAR(50)  NOT NULL,
  permission   VARCHAR(20)  NOT NULL DEFAULT 'Read'
                             CHECK (permission IN ('Read', 'Read & Write')),
  status       VARCHAR(10)  NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'inactive')),
  is_original_data_visible BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  created_by   INT,
  updated_by   INT,
  CONSTRAINT uq_roles_role_name UNIQUE (role_name)
);

CREATE INDEX IF NOT EXISTS idx_roles_status ON roles (status);

CREATE TRIGGER trg_roles_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: employees
-- =============================================================================

DROP TABLE IF EXISTS employees CASCADE;
CREATE TABLE employees (
  id                   SERIAL PRIMARY KEY,
  employee_code        VARCHAR(20)    NOT NULL,
  full_name            VARCHAR(100)   NOT NULL,
  designation          VARCHAR(100),
  total_experience     DECIMAL(4,1),
  company_experience   DECIMAL(4,1),
  resource_description TEXT,
  date_of_joining      DATE,
  date_of_leaving      DATE,
  status               VARCHAR(10)    NOT NULL DEFAULT 'active'
                                      CHECK (status IN ('active', 'inactive')),
  created_at           TIMESTAMP      NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMP      NOT NULL DEFAULT NOW(),
  created_by           INT,
  updated_by           INT,
  CONSTRAINT uq_employees_employee_code UNIQUE (employee_code),
  CONSTRAINT chk_employees_experience CHECK (
    total_experience IS NULL OR total_experience >= 0
  ),
  CONSTRAINT chk_employees_company_exp CHECK (
    company_experience IS NULL OR company_experience >= 0
  ),
  CONSTRAINT chk_employees_dates CHECK (
    date_of_leaving IS NULL OR date_of_leaving >= date_of_joining
  )
);

CREATE INDEX IF NOT EXISTS idx_employees_status        ON employees (status);
CREATE INDEX IF NOT EXISTS idx_employees_employee_code ON employees (employee_code);
CREATE INDEX IF NOT EXISTS idx_employees_full_name     ON employees (full_name);

CREATE TRIGGER trg_employees_updated_at
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: users
-- =============================================================================

DROP TABLE IF EXISTS users CASCADE;
CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  employee_id  INT,
  email        VARCHAR(100)  NOT NULL,
  password     VARCHAR(255)  NOT NULL,
  role_id      INT,
  status       VARCHAR(10)   NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'inactive')),
  last_login   TIMESTAMP,
  created_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
  created_by   INT,
  updated_by   INT,
  CONSTRAINT uq_users_email UNIQUE (email),
  CONSTRAINT fk_users_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT fk_users_role FOREIGN KEY (role_id)
    REFERENCES roles (id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_users_email       ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_role_id     ON users (role_id);
CREATE INDEX IF NOT EXISTS idx_users_employee_id ON users (employee_id);
CREATE INDEX IF NOT EXISTS idx_users_status      ON users (status);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: user_roles
-- =============================================================================

DROP TABLE IF EXISTS user_roles CASCADE;
CREATE TABLE user_roles (
  id         SERIAL PRIMARY KEY,
  user_id    INT          NOT NULL,
  role_id    INT          NOT NULL,
  created_at TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_roles_user_role UNIQUE (user_id, role_id),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id)
    REFERENCES roles (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_roles_user_id ON user_roles (user_id);
CREATE INDEX IF NOT EXISTS idx_user_roles_role_id ON user_roles (role_id);

CREATE TRIGGER trg_user_roles_updated_at
  BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TABLE IF EXISTS form_master CASCADE;
CREATE TABLE form_master (
  id          SERIAL PRIMARY KEY,
  module_name VARCHAR(100) NOT NULL,
  form_name   VARCHAR(150) NOT NULL,
  status      VARCHAR(10)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_form_master_module_form UNIQUE (module_name, form_name)
);
CREATE INDEX IF NOT EXISTS idx_form_master_status ON form_master (status);
CREATE INDEX IF NOT EXISTS idx_form_master_module_name ON form_master (module_name);
CREATE TRIGGER trg_form_master_updated_at BEFORE UPDATE ON form_master
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

DROP TABLE IF EXISTS role_form_mapping CASCADE;
CREATE TABLE role_form_mapping (
  id          SERIAL PRIMARY KEY,
  role_id     INT NOT NULL REFERENCES roles (id) ON UPDATE CASCADE ON DELETE CASCADE,
  form_id     INT NOT NULL REFERENCES form_master (id) ON UPDATE CASCADE ON DELETE CASCADE,
  status      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_role_form_mapping_role_form UNIQUE (role_id, form_id)
);
CREATE INDEX IF NOT EXISTS idx_role_form_mapping_role_id ON role_form_mapping (role_id);
CREATE INDEX IF NOT EXISTS idx_role_form_mapping_form_id ON role_form_mapping (form_id);
CREATE INDEX IF NOT EXISTS idx_role_form_mapping_status ON role_form_mapping (status);
CREATE TRIGGER trg_role_form_mapping_updated_at BEFORE UPDATE ON role_form_mapping
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: clients
-- =============================================================================

DROP TABLE IF EXISTS clients CASCADE;
CREATE TABLE clients (
  id           SERIAL PRIMARY KEY,
  client_code  VARCHAR(20)   NOT NULL,
  client_name  VARCHAR(100)  NOT NULL,
  industry     VARCHAR(100),
  status       VARCHAR(10)   NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'inactive')),
  created_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
  created_by   INT,
  updated_by   INT,
  CONSTRAINT uq_clients_client_code UNIQUE (client_code)
);

CREATE INDEX IF NOT EXISTS idx_clients_status      ON clients (status);
CREATE INDEX IF NOT EXISTS idx_clients_client_name ON clients (client_name);

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: service_types
-- =============================================================================

DROP TABLE IF EXISTS service_types CASCADE;
CREATE TABLE service_types (
  id                SERIAL PRIMARY KEY,
  service_type_name VARCHAR(100)  NOT NULL,
  created_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
  created_by        INT,
  updated_by        INT,
  CONSTRAINT uq_service_types_name UNIQUE (service_type_name)
);

CREATE TRIGGER trg_service_types_updated_at
  BEFORE UPDATE ON service_types
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: service_pos
-- =============================================================================

DROP TABLE IF EXISTS service_pos CASCADE;
CREATE TABLE service_pos (
  id                  SERIAL PRIMARY KEY,
  service_po_code     VARCHAR(30)    NOT NULL,
  service_po_name     VARCHAR(200)   NOT NULL,
  client_id           INT            NOT NULL,
  service_type_id     INT            NOT NULL,
  po_value            DECIMAL(15,2),
  start_date          DATE,
  end_date            DATE,
  expected_man_hours  DECIMAL(10,2),
  is_billable         BOOLEAN        NOT NULL DEFAULT TRUE,
  account_manager     VARCHAR(100),
  service_description TEXT,
  invoice_frequency   VARCHAR(20)
                                    CHECK (invoice_frequency IN ('monthly', 'quarterly', 'bi-annual', 'annual', 'one-time')),
  status              VARCHAR(10)    NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('active', 'inactive', 'closed')),
  created_at          TIMESTAMP      NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP      NOT NULL DEFAULT NOW(),
  created_by          INT,
  updated_by          INT,
  CONSTRAINT uq_service_pos_code UNIQUE (service_po_code),
  CONSTRAINT fk_service_pos_client FOREIGN KEY (client_id)
    REFERENCES clients (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_service_pos_service_type FOREIGN KEY (service_type_id)
    REFERENCES service_types (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_service_pos_dates CHECK (
    end_date IS NULL OR start_date IS NULL OR end_date >= start_date
  ),
  CONSTRAINT chk_service_pos_po_value CHECK (
    po_value IS NULL OR po_value >= 0
  ),
  CONSTRAINT chk_service_pos_man_hours CHECK (
    expected_man_hours IS NULL OR expected_man_hours >= 0
  )
);

CREATE INDEX IF NOT EXISTS idx_service_pos_client_id       ON service_pos (client_id);
CREATE INDEX IF NOT EXISTS idx_service_pos_service_type_id ON service_pos (service_type_id);
CREATE INDEX IF NOT EXISTS idx_service_pos_status          ON service_pos (status);
CREATE INDEX IF NOT EXISTS idx_service_pos_is_billable     ON service_pos (is_billable);
CREATE INDEX IF NOT EXISTS idx_service_pos_start_date      ON service_pos (start_date);
CREATE INDEX IF NOT EXISTS idx_service_pos_end_date        ON service_pos (end_date);

CREATE TRIGGER trg_service_pos_updated_at
  BEFORE UPDATE ON service_pos
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: service_po_resources
-- =============================================================================

DROP TABLE IF EXISTS service_po_resources CASCADE;
CREATE TABLE service_po_resources (
  id             SERIAL PRIMARY KEY,
  service_po_id  INT       NOT NULL,
  employee_id    INT       NOT NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_service_po_resources UNIQUE (service_po_id, employee_id),
  CONSTRAINT fk_spr_service_po FOREIGN KEY (service_po_id)
    REFERENCES service_pos (id) ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_spr_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_spr_service_po_id ON service_po_resources (service_po_id);
CREATE INDEX IF NOT EXISTS idx_spr_employee_id   ON service_po_resources (employee_id);

-- =============================================================================
-- TABLE: sub_projects
-- =============================================================================

DROP TABLE IF EXISTS sub_projects CASCADE;
CREATE TABLE sub_projects (
  id                SERIAL PRIMARY KEY,
  sub_project_code  VARCHAR(30)   NOT NULL,
  service_po_id     INT           NOT NULL,
  sub_project_name  VARCHAR(200)  NOT NULL,
  description       TEXT,
  start_date        DATE,
  end_date          DATE,
  status            VARCHAR(10)   NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active', 'inactive', 'closed')),
  created_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP     NOT NULL DEFAULT NOW(),
  created_by        INT,
  updated_by        INT,
  CONSTRAINT uq_sub_projects_code UNIQUE (sub_project_code),
  CONSTRAINT fk_sub_projects_service_po FOREIGN KEY (service_po_id)
    REFERENCES service_pos (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_sub_projects_dates CHECK (
    end_date IS NULL OR start_date IS NULL OR end_date >= start_date
  )
);

CREATE INDEX IF NOT EXISTS idx_sub_projects_service_po_id ON sub_projects (service_po_id);
CREATE INDEX IF NOT EXISTS idx_sub_projects_status        ON sub_projects (status);

CREATE TRIGGER trg_sub_projects_updated_at
  BEFORE UPDATE ON sub_projects
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: monthly_costs
-- =============================================================================

DROP TABLE IF EXISTS monthly_costs CASCADE;
CREATE TABLE monthly_costs (
  id                     SERIAL PRIMARY KEY,
  employee_id            INT            NOT NULL,
  month_year             VARCHAR(7)     NOT NULL,
  salary_cost            DECIMAL(15,2),
  ops_cost               DECIMAL(15,2),
  total_cost             DECIMAL(15,2),
  billable_cost          DECIMAL(15,2),
  created_at             TIMESTAMP      NOT NULL DEFAULT NOW(),
  created_by             INT,
  updated_by             INT,
  CONSTRAINT uq_monthly_costs_employee_month_year UNIQUE (employee_id, month_year),
  CONSTRAINT chk_monthly_costs_month_year CHECK (month_year ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT fk_monthly_costs_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT chk_monthly_costs_salary   CHECK (salary_cost  IS NULL OR salary_cost  >= 0),
  CONSTRAINT chk_monthly_costs_ops      CHECK (ops_cost     IS NULL OR ops_cost     >= 0),
  CONSTRAINT chk_monthly_costs_total    CHECK (total_cost   IS NULL OR total_cost   >= 0),
  CONSTRAINT chk_monthly_costs_billable CHECK (billable_cost IS NULL OR billable_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_monthly_costs_employee_id ON monthly_costs (employee_id);
CREATE INDEX IF NOT EXISTS idx_monthly_costs_month_year ON monthly_costs (month_year);

-- =============================================================================
-- TABLE: timesheet_import_history
-- =============================================================================

DROP TABLE IF EXISTS timesheet_import_history CASCADE;
CREATE TABLE timesheet_import_history (
  id           SERIAL PRIMARY KEY,
  imported_by  INT           NOT NULL,
  file_name    VARCHAR(255)  NOT NULL,
  file_path    VARCHAR(500)  NOT NULL,
  total_rows   INT           NOT NULL DEFAULT 0,
  valid_rows   INT           NOT NULL DEFAULT 0,
  error_rows   INT           NOT NULL DEFAULT 0,
  status       VARCHAR(20)   NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'partial')),
  created_at   TIMESTAMP     NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_tih_imported_by FOREIGN KEY (imported_by)
    REFERENCES users (id) ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_tih_imported_by ON timesheet_import_history (imported_by);
CREATE INDEX IF NOT EXISTS idx_tih_status      ON timesheet_import_history (status);
CREATE INDEX IF NOT EXISTS idx_tih_created_at  ON timesheet_import_history (created_at);

-- =============================================================================
-- TABLE: timesheet_import_errors
-- =============================================================================

DROP TABLE IF EXISTS timesheet_import_errors CASCADE;
CREATE TABLE timesheet_import_errors (
  id             SERIAL PRIMARY KEY,
  import_id      INT       NOT NULL,
  row_number     INT       NOT NULL,
  row_data       JSONB,
  error_message  TEXT,
  created_at     TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_tie_import FOREIGN KEY (import_id)
    REFERENCES timesheet_import_history (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tie_import_id ON timesheet_import_errors (import_id);
CREATE INDEX IF NOT EXISTS idx_tie_row_data  ON timesheet_import_errors USING GIN (row_data);

-- =============================================================================
-- TABLE: timesheets
-- =============================================================================

DROP TABLE IF EXISTS timesheets CASCADE;
CREATE TABLE timesheets (
  id              SERIAL PRIMARY KEY,
  employee_id     INT            NOT NULL,
  service_po_id   INT            NOT NULL,
  sub_project_id  INT,
  timesheet_date  DATE           NOT NULL,
  hours_logged    DECIMAL(5,2)   NOT NULL CHECK (hours_logged >= 0),
  created_at      TIMESTAMP      NOT NULL DEFAULT NOW(),
  timesheet_import_id INT,
  created_by      INT,
  updated_by      INT,
  CONSTRAINT fk_timesheets_employee FOREIGN KEY (employee_id)
    REFERENCES employees (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_timesheets_service_po FOREIGN KEY (service_po_id)
    REFERENCES service_pos (id) ON UPDATE CASCADE ON DELETE RESTRICT,
  CONSTRAINT fk_timesheets_sub_project FOREIGN KEY (sub_project_id)
    REFERENCES sub_projects (id) ON UPDATE CASCADE ON DELETE SET NULL
  ,
  CONSTRAINT fk_timesheets_import FOREIGN KEY (timesheet_import_id)
    REFERENCES timesheet_import_history (id) ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_timesheets_employee_id    ON timesheets (employee_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_service_po_id  ON timesheets (service_po_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_sub_project_id ON timesheets (sub_project_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_date           ON timesheets (timesheet_date);
CREATE INDEX IF NOT EXISTS idx_timesheets_emp_date       ON timesheets (employee_id, timesheet_date);
CREATE INDEX IF NOT EXISTS idx_timesheets_import_id     ON timesheets (timesheet_import_id);

-- =============================================================================
-- TABLE: audit_logs
-- =============================================================================

DROP TABLE IF EXISTS audit_logs CASCADE;
CREATE TABLE audit_logs (
  id           SERIAL PRIMARY KEY,
  user_id      INT,
  action       VARCHAR(50),
  entity_type  VARCHAR(50),
  entity_id    INT,
  old_values   JSONB,
  new_values   JSONB,
  ip_address   VARCHAR(45),
  created_at   TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id     ON audit_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity      ON audit_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at  ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action      ON audit_logs (action);

-- GIN index for JSONB querying
CREATE INDEX IF NOT EXISTS idx_audit_logs_new_values  ON audit_logs USING GIN (new_values);
CREATE INDEX IF NOT EXISTS idx_audit_logs_old_values  ON audit_logs USING GIN (old_values);

-- =============================================================================
-- TABLE: user_sessions
-- =============================================================================

DROP TABLE IF EXISTS user_sessions CASCADE;
CREATE TABLE user_sessions (
  id             SERIAL PRIMARY KEY,
  user_id        INT       NOT NULL,
  refresh_token  TEXT      NOT NULL,
  expires_at     TIMESTAMP WITH TIME ZONE NOT NULL,
  ip_address     VARCHAR(45),
  user_agent     TEXT,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_user_sessions_refresh_token UNIQUE (refresh_token),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id       ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_refresh_token ON user_sessions (refresh_token);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at    ON user_sessions (expires_at);

-- =============================================================================
-- TABLE: notifications
-- =============================================================================

DROP TABLE IF EXISTS notifications CASCADE;
CREATE TABLE notifications (
  id          SERIAL PRIMARY KEY,
  user_id     INT           NOT NULL,
  title       VARCHAR(200)  NOT NULL,
  message     TEXT,
  type        VARCHAR(50),
  is_read     BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP     NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id  ON notifications (user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read  ON notifications (user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created  ON notifications (created_at);

-- =============================================================================
-- TABLE: ai_insight_jobs
-- AI Insights module — job configuration (see database/migrations/20260717_create_ai_insights.sql)
-- =============================================================================

DROP TABLE IF EXISTS ai_insight_jobs CASCADE;
CREATE TABLE ai_insight_jobs (
  id               SERIAL PRIMARY KEY,
  job_key          VARCHAR(100) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  frequency        VARCHAR(20)  NOT NULL
                                CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'event')),
  cron_expression  VARCHAR(50),
  audience_roles   JSONB        NOT NULL DEFAULT '[]',
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  last_run_at      TIMESTAMP,
  last_run_status  VARCHAR(20)  CHECK (last_run_status IN ('success', 'failed')),
  last_error       TEXT,
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ai_insight_jobs_job_key UNIQUE (job_key)
);

CREATE TRIGGER trg_ai_insight_jobs_updated_at
  BEFORE UPDATE ON ai_insight_jobs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: ai_insights
-- AI Insights module — generated insights
-- =============================================================================

DROP TABLE IF EXISTS ai_insights CASCADE;
CREATE TABLE ai_insights (
  id             SERIAL PRIMARY KEY,
  job_id         INT REFERENCES ai_insight_jobs(id),
  job_key        VARCHAR(100) NOT NULL,
  reference_id   INT,
  title          VARCHAR(300) NOT NULL,
  severity       VARCHAR(20)  NOT NULL DEFAULT 'info'
                              CHECK (severity IN ('critical', 'warning', 'info')),
  summary        TEXT,
  findings       JSONB        NOT NULL DEFAULT '[]',
  actions        JSONB        NOT NULL DEFAULT '[]',
  audience_roles JSONB        NOT NULL DEFAULT '[]',
  ai_response    JSONB,
  generated_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  status         VARCHAR(20)  NOT NULL DEFAULT 'completed'
                              CHECK (status IN ('completed', 'failed')),
  is_read        BOOLEAN      NOT NULL DEFAULT false,
  is_dismissed   BOOLEAN      NOT NULL DEFAULT false,
  created_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_job_key      ON ai_insights (job_key);
CREATE INDEX IF NOT EXISTS idx_ai_insights_is_read       ON ai_insights (is_read);
CREATE INDEX IF NOT EXISTS idx_ai_insights_is_dismissed  ON ai_insights (is_dismissed);
CREATE INDEX IF NOT EXISTS idx_ai_insights_generated_at  ON ai_insights (generated_at);

CREATE TRIGGER trg_ai_insights_updated_at
  BEFORE UPDATE ON ai_insights
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- END OF SCHEMA
-- =============================================================================

-- ================== database/migrations/20260626_remove_hours_upper_bound.sql ==================
-- Migration: remove upper-bound check on timesheets.hours_logged
-- Drops existing constraint (if present) and enforces only hours_logged >= 0

-- [bootstrap] stripped: BEGIN;

ALTER TABLE IF EXISTS timesheets
  DROP CONSTRAINT IF EXISTS timesheets_hours_logged_check;

-- Ensure column is numeric with two decimal places (no change if already appropriate)
ALTER TABLE IF EXISTS timesheets
  ALTER COLUMN hours_logged TYPE DECIMAL(5,2) USING hours_logged::numeric;

ALTER TABLE IF EXISTS timesheets
  ADD CONSTRAINT timesheets_hours_logged_check CHECK (hours_logged >= 0);

-- [bootstrap] stripped: COMMIT;

-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260626_remove_hours_upper_bound.sql

-- ================== database/migrations/20260626_remove_monthly_cost_ops_share.sql ==================
-- Remove deprecated monthly operational-cost share column.

ALTER TABLE monthly_costs
  DROP CONSTRAINT IF EXISTS chk_monthly_costs_ops_emp;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE monthly_costs DROP COLUMN IF EXISTS ' ||
          quote_ident('ops_cost' || '_per_employee');
END $$;

-- ================== database/migrations/20260717_add_timesheets_unique_constraint.sql ==================
-- Migration: add the missing unique constraint on timesheets(employee_id, service_po_id, timesheet_date)
--
-- The Sequelize Timesheet model has always declared this as a unique index
-- (name: timesheets_employee_po_date_unique), and the application layer
-- (timesheetRepository.checkDuplicate, and the comments in
-- timesheetService.confirmImport/detectDuplicateRows) assumes it exists at
-- the DB level as the authoritative guard against duplicate entries.
-- It was never actually created in the database — sequelize.sync({ alter: false })
-- only creates missing TABLES, not missing indexes on already-existing tables,
-- so this table has been running without it since its original creation.
--
-- Without this constraint, concurrent requests (or the monthly-import
-- bulkCreate path, which does not run the app-level duplicate check) could
-- insert duplicate employee+PO+date rows.
--
-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260717_add_timesheets_unique_constraint.sql

-- [bootstrap] stripped: BEGIN;

ALTER TABLE IF EXISTS timesheets
  ADD CONSTRAINT timesheets_employee_po_date_unique
  UNIQUE (employee_id, service_po_id, timesheet_date);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260717_create_ai_insights.sql ==================
-- Migration: create AI Insights module tables
-- ai_insight_jobs   : job configuration (one row per insight type)
-- ai_insights       : generated AI insights (one row per Claude generation)
--
-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260717_create_ai_insights.sql
--
-- NOTE: in development, these tables are also created automatically by
-- sequelize.sync({ alter: false }) on server startup (see server.js), since
-- they are brand-new tables with no pre-existing data to alter. This
-- migration exists for production environments where sync() is not run.

-- [bootstrap] stripped: BEGIN;

CREATE TABLE IF NOT EXISTS ai_insight_jobs (
  id               SERIAL PRIMARY KEY,
  job_key          VARCHAR(100) NOT NULL,
  title            VARCHAR(200) NOT NULL,
  description      TEXT,
  frequency        VARCHAR(20)  NOT NULL
                                CHECK (frequency IN ('daily', 'weekly', 'monthly', 'quarterly', 'event')),
  cron_expression  VARCHAR(50),
  audience_roles   JSONB        NOT NULL DEFAULT '[]',
  is_active        BOOLEAN      NOT NULL DEFAULT true,
  last_run_at      TIMESTAMP,
  last_run_status  VARCHAR(20)  CHECK (last_run_status IN ('success', 'failed')),
  last_error       TEXT,
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP    NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_ai_insight_jobs_job_key UNIQUE (job_key)
);

DROP TRIGGER IF EXISTS trg_ai_insight_jobs_updated_at ON ai_insight_jobs;
CREATE TRIGGER trg_ai_insight_jobs_updated_at
  BEFORE UPDATE ON ai_insight_jobs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS ai_insights (
  id             SERIAL PRIMARY KEY,
  job_id         INT REFERENCES ai_insight_jobs(id),
  job_key        VARCHAR(100) NOT NULL,
  reference_id   INT,
  title          VARCHAR(300) NOT NULL,
  severity       VARCHAR(20)  NOT NULL DEFAULT 'info'
                              CHECK (severity IN ('critical', 'warning', 'info')),
  summary        TEXT,
  findings       JSONB        NOT NULL DEFAULT '[]',
  actions        JSONB        NOT NULL DEFAULT '[]',
  audience_roles JSONB        NOT NULL DEFAULT '[]',
  ai_response    JSONB,
  generated_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  status         VARCHAR(20)  NOT NULL DEFAULT 'completed'
                              CHECK (status IN ('completed', 'failed')),
  is_read        BOOLEAN      NOT NULL DEFAULT false,
  is_dismissed   BOOLEAN      NOT NULL DEFAULT false,
  created_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_job_key      ON ai_insights (job_key);
CREATE INDEX IF NOT EXISTS idx_ai_insights_is_read       ON ai_insights (is_read);
CREATE INDEX IF NOT EXISTS idx_ai_insights_is_dismissed  ON ai_insights (is_dismissed);
CREATE INDEX IF NOT EXISTS idx_ai_insights_generated_at  ON ai_insights (generated_at);

DROP TRIGGER IF EXISTS trg_ai_insights_updated_at ON ai_insights;
CREATE TRIGGER trg_ai_insights_updated_at
  BEFORE UPDATE ON ai_insights
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260721_add_service_category_report_bucket_key.sql ==================
-- Migration: replace hardcoded "category name === 'Billable'" style string
-- comparisons with a data-driven column.
--
-- service_categories.report_bucket_key classifies each category into the
-- fixed set of output buckets the Dashboard/Analytics APIs already expose
-- (billable / non_billable / customer_non_billable). Those output field
-- names are a permanent API contract and are NOT changing — only how the
-- code decides which category maps to which bucket changes: from comparing
-- sc.name string literals to reading this column.
--
-- NULL means "no bucket" (falls into the existing "Other"/"Uncategorized"
-- catch-all everywhere that already exists) — so adding a brand new category
-- in the future needs no code change; it simply reports as Other until an
-- admin explicitly assigns it a bucket.
--
-- Backfill matches current live data exactly (verified before writing this
-- migration): id 1 "Billable" -> 'billable', id 2 "Non-Billable" ->
-- 'non_billable', id 3 "Customer Non-Billable" -> 'customer_non_billable'.
-- The soft-deleted "Test Billable" (id 6) is left NULL.
--
-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260721_add_service_category_report_bucket_key.sql

-- [bootstrap] stripped: BEGIN;

ALTER TABLE IF EXISTS service_categories
  ADD COLUMN IF NOT EXISTS report_bucket_key VARCHAR(30);

-- DROP-then-ADD makes this re-runnable (ADD CONSTRAINT has no IF NOT EXISTS
-- form in Postgres) — matches the pattern used everywhere else in this repo.
ALTER TABLE IF EXISTS service_categories
  DROP CONSTRAINT IF EXISTS chk_service_categories_report_bucket_key;
ALTER TABLE IF EXISTS service_categories
  ADD CONSTRAINT chk_service_categories_report_bucket_key
  CHECK (report_bucket_key IS NULL OR report_bucket_key IN ('billable', 'non_billable', 'customer_non_billable'));

-- Guarded the same way the ALTERs above already are: on a brand-new
-- environment applying every migration in order for the first time (see
-- migrationRunner.js's hasPreRunnerMigrationHistory()), service_categories
-- doesn't exist yet at this point in the sequence — a bare UPDATE against it
-- would fail with "relation does not exist" instead of harmlessly no-op'ing
-- like the ALTERs above. There's nothing to backfill on such an environment
-- anyway (no categories exist yet to have a bucket key backfilled onto).
DO $$
BEGIN
  IF to_regclass('public.service_categories') IS NOT NULL THEN
    UPDATE service_categories SET report_bucket_key = 'billable'               WHERE LOWER(name) = 'billable';
    UPDATE service_categories SET report_bucket_key = 'non_billable'          WHERE LOWER(name) = 'non-billable';
    UPDATE service_categories SET report_bucket_key = 'customer_non_billable' WHERE LOWER(name) = 'customer non-billable';
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260722_add_modified_hours_and_is_publish.sql ==================
-- Migration: add admin-adjustable "Modified Hours" + publish flags.
--
-- timesheets.modified_hours — the admin-editable effective hours value.
--   hours_logged (the original, imported/entered value) is NEVER modified by
--   this feature; modified_hours starts out equal to hours_logged at insert
--   time (set in application code, not a DB default/trigger — see
--   timesheetService.js's createTimesheet()/confirmImport()) and is only
--   ever changed via PATCH /timesheets/:id/modified-hours.
-- timesheets.is_publish — set true the first time modified_hours is edited
--   for that row via the dedicated endpoint. One-way flag: never reset to
--   false anywhere in this feature.
-- timesheet_import_history.is_publish — set true on the parent "monthly
--   sheet" the first time any of its child rows gets a modified_hours edit.
--
-- Same precision/scale as hours_logged (DECIMAL(5,2), 0-999.99) — see
-- database/migrations/20260626_remove_hours_upper_bound.sql for why
-- hours_logged itself is (5,2).
--
-- To apply:
-- psql -U <db_user> -d <database> -f database/migrations/20260722_add_modified_hours_and_is_publish.sql

-- [bootstrap] stripped: BEGIN;

ALTER TABLE IF EXISTS timesheets
  ADD COLUMN IF NOT EXISTS modified_hours DECIMAL(5,2) NULL;

ALTER TABLE IF EXISTS timesheets
  ADD CONSTRAINT chk_timesheets_modified_hours CHECK (modified_hours IS NULL OR modified_hours >= 0);

ALTER TABLE IF EXISTS timesheets
  ADD COLUMN IF NOT EXISTS is_publish BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE IF EXISTS timesheet_import_history
  ADD COLUMN IF NOT EXISTS is_publish BOOLEAN NOT NULL DEFAULT false;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260723_add_rbac_form_master.sql ==================
-- [bootstrap] stripped: BEGIN;

ALTER TABLE roles ADD COLUMN IF NOT EXISTS permission VARCHAR(20) NOT NULL DEFAULT 'Read';
ALTER TABLE roles DROP CONSTRAINT IF EXISTS chk_roles_permission;
ALTER TABLE roles ADD CONSTRAINT chk_roles_permission CHECK (permission IN ('Read', 'Read & Write'));

UPDATE roles
SET permission = 'Read & Write'
WHERE role_name IN ('Admin', 'Management', 'Manager', 'Division Head', 'Project Manager');

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
DROP TRIGGER IF EXISTS trg_user_roles_updated_at ON user_roles;
CREATE TRIGGER trg_user_roles_updated_at BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS form_master (
  id SERIAL PRIMARY KEY,
  module_name VARCHAR(100) NOT NULL,
  form_name VARCHAR(150) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_form_master_module_form UNIQUE (module_name, form_name)
);
CREATE INDEX IF NOT EXISTS idx_form_master_status ON form_master (status);
CREATE INDEX IF NOT EXISTS idx_form_master_module_name ON form_master (module_name);
DROP TRIGGER IF EXISTS trg_form_master_updated_at ON form_master;
CREATE TRIGGER trg_form_master_updated_at BEFORE UPDATE ON form_master
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS role_form_mapping (
  id SERIAL PRIMARY KEY,
  role_id INT NOT NULL REFERENCES roles (id) ON UPDATE CASCADE ON DELETE CASCADE,
  form_id INT NOT NULL REFERENCES form_master (id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_role_form_mapping_role_form UNIQUE (role_id, form_id)
);
CREATE INDEX IF NOT EXISTS idx_role_form_mapping_role_id ON role_form_mapping (role_id);
CREATE INDEX IF NOT EXISTS idx_role_form_mapping_form_id ON role_form_mapping (form_id);
DROP TRIGGER IF EXISTS trg_role_form_mapping_updated_at ON role_form_mapping;
CREATE TRIGGER trg_role_form_mapping_updated_at BEFORE UPDATE ON role_form_mapping
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260723_add_role_form_mapping_status.sql ==================
-- [bootstrap] stripped: BEGIN;

-- Soft-mapping flag for role_form_mapping: true = form currently mapped
-- (active) to the role, false = unmapped (inactive) — rows are never
-- physically deleted, only toggled. Existing rows predate this column and
-- represent mappings that were, by their mere existence, active — so they
-- default (and backfill) to true.
ALTER TABLE role_form_mapping ADD COLUMN IF NOT EXISTS status BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_role_form_mapping_status ON role_form_mapping (status);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260723_add_role_original_data_visibility.sql ==================
-- [bootstrap] stripped: BEGIN;

-- Whether users assigned to this role may view original/raw data in the
-- application (as opposed to whatever admin-adjusted/derived view applies
-- otherwise). Defaults to false — original data is hidden unless a role is
-- explicitly granted visibility.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_original_data_visible BOOLEAN NOT NULL DEFAULT false;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260728_add_company_tenancy_schema.sql ==================
-- =============================================================================
-- Multi-Tenancy Retrofit — Phase 0: additive schema only, zero behavior change.
-- Creates the companies table, seeds a default "GTT" company, and adds a
-- nullable company_id column (+ users.is_platform_admin) to every table that
-- will become company-scoped. Nothing in the application reads these columns
-- yet — this migration is a no-op from the running app's perspective.
-- Safe to re-run (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS companies CASCADE;
CREATE TABLE companies (
  id SERIAL PRIMARY KEY,
  company_code VARCHAR(20) NOT NULL,
  company_name VARCHAR(150) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_companies_company_code UNIQUE (company_code)
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies (status);
DROP TRIGGER IF EXISTS trg_companies_updated_at ON companies;
CREATE TRIGGER trg_companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Default tenant every pre-existing row will be backfilled onto in Phase 1.
INSERT INTO companies (company_code, company_name)
VALUES ('GTT', 'GTT (Default Company)')
ON CONFLICT (company_code) DO NOTHING;

-- Platform-level flag on users — Super Admin is the one row with company_id
-- NULL and this set true; every other user belongs to exactly one company.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

-- Nullable company_id on every company-owned table. Left nullable here on
-- purpose — Phase 1 backfills every existing row, Phase 2 then cuts over to
-- NOT NULL once backfill is verified complete. form_master, roles,
-- role_form_mapping, notifications, and user_sessions intentionally do NOT
-- get this column (global catalog / role definitions / transitively scoped
-- via user_id — see the retrofit plan).
ALTER TABLE users                      ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE clients                    ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE employees                  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE monthly_costs              ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE service_pos                ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE service_po_resources       ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE service_types              ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
-- service_categories specifically uses IF EXISTS here (unlike every other
-- line below) because, unlike the rest of these tables, it was never
-- actually created by database/schema.sql or any migration before this one —
-- it only ever existed on databases where it had been added out-of-band
-- (see 20260803_ensure_service_categories_schema.sql's header for the full
-- story). On a database that genuinely doesn't have it yet, this becomes a
-- safe no-op; 20260803_ensure_service_categories_schema.sql (which runs
-- later in filename order) creates the table AND applies this same
-- company_id retrofit to it unconditionally, so nothing is lost.
ALTER TABLE IF EXISTS service_categories ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE sub_projects               ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE timesheets                 ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE timesheet_import_history   ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE timesheet_import_errors    ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE ai_insights                ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);
ALTER TABLE ai_insight_jobs            ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);

CREATE INDEX IF NOT EXISTS idx_users_company_id                    ON users (company_id);
CREATE INDEX IF NOT EXISTS idx_clients_company_id                  ON clients (company_id);
CREATE INDEX IF NOT EXISTS idx_employees_company_id                ON employees (company_id);
CREATE INDEX IF NOT EXISTS idx_monthly_costs_company_id            ON monthly_costs (company_id);
CREATE INDEX IF NOT EXISTS idx_service_pos_company_id              ON service_pos (company_id);
CREATE INDEX IF NOT EXISTS idx_service_po_resources_company_id     ON service_po_resources (company_id);
CREATE INDEX IF NOT EXISTS idx_service_types_company_id            ON service_types (company_id);
-- CREATE INDEX has no "IF EXISTS <table>" form, so this one is guarded with
-- a DO block instead (DDL inside PL/pgSQL requires EXECUTE) — same reasoning
-- as the ALTER TABLE above.
DO $$ BEGIN
  IF to_regclass('public.service_categories') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_service_categories_company_id ON service_categories (company_id)';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_sub_projects_company_id             ON sub_projects (company_id);
CREATE INDEX IF NOT EXISTS idx_timesheets_company_id               ON timesheets (company_id);
CREATE INDEX IF NOT EXISTS idx_timesheet_import_history_company_id ON timesheet_import_history (company_id);
CREATE INDEX IF NOT EXISTS idx_timesheet_import_errors_company_id  ON timesheet_import_errors (company_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_company_id              ON ai_insights (company_id);
CREATE INDEX IF NOT EXISTS idx_ai_insight_jobs_company_id          ON ai_insight_jobs (company_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260729_backfill_company_id.sql ==================
-- =============================================================================
-- Multi-Tenancy Retrofit — Phase 1a: backfill company_id onto every existing
-- row, pointing at the default "GTT" company created in Phase 0. Idempotent
-- (WHERE company_id IS NULL guard on every statement) — safe to re-run.
-- Still leaves company_id NULLABLE; Phase 2 cuts over to NOT NULL once this
-- is verified complete.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE
  gtt_id INT;
BEGIN
  SELECT id INTO gtt_id FROM companies WHERE company_code = 'GTT';

  IF gtt_id IS NULL THEN
    RAISE EXCEPTION 'Default GTT company not found — run 20260728_add_company_tenancy_schema.sql first.';
  END IF;

  UPDATE users                    SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE clients                  SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE employees                SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE monthly_costs            SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE service_pos               SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE service_po_resources      SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE service_types             SET company_id = gtt_id WHERE company_id IS NULL;
  -- service_categories may not exist yet on a genuinely fresh database (see
  -- 20260803_ensure_service_categories_schema.sql's header) — this backfill
  -- is a no-op there anyway since 20260803 creates the table with company_id
  -- already populated, not NULL.
  IF to_regclass('public.service_categories') IS NOT NULL THEN
    UPDATE service_categories SET company_id = gtt_id WHERE company_id IS NULL;
  END IF;
  UPDATE sub_projects              SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE timesheets                SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE timesheet_import_history  SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE timesheet_import_errors   SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE ai_insights                SET company_id = gtt_id WHERE company_id IS NULL;
  UPDATE ai_insight_jobs            SET company_id = gtt_id WHERE company_id IS NULL;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260729_resync_serial_sequences.sql ==================
-- [bootstrap] stripped: BEGIN;

-- Root cause: database/seeds.sql (and any manual data restores/imports) insert
-- rows with explicit id values, which never advances the table's SERIAL
-- sequence. When the sequence falls behind MAX(id), the next DEFAULT-driven
-- INSERT (via Sequelize) asks Postgres for nextval(), gets a value that's
-- already taken, and fails with "duplicate key value violates unique
-- constraint ... _pkey".
--
-- This resyncs every SERIAL/IDENTITY primary key sequence in the public
-- schema to MAX(id) + 1, so it fixes clients_id_seq and every other table
-- seeded the same way (roles, employees, users, service_types, service_pos,
-- sub_projects, user_sessions, ...) in one idempotent pass. Safe to re-run;
-- safe on empty tables.
DO $$
DECLARE
  r RECORD;
  v_seq TEXT;
  v_next BIGINT;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_default LIKE 'nextval(%'
  LOOP
    v_seq := pg_get_serial_sequence(r.table_name, r.column_name);

    IF v_seq IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE(MAX(%I), 0) + 1 FROM %I', r.column_name, r.table_name) INTO v_next;
      PERFORM setval(v_seq, v_next, false);
      RAISE NOTICE 'Resynced %.% -> % will start at %', r.table_name, r.column_name, v_seq, v_next;
    END IF;
  END LOOP;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260729_seed_company_admin_form_mapping.sql ==================
-- Seed role_form_mapping for the "Company Admin" role (id from roles.role_name),
-- introduced by the multi-tenancy retrofit's 20260729_seed_platform_roles.sql.
-- That migration created the role row itself but never seeded its sidebar
-- form access, so a Company Admin could log in successfully (valid JWT) but
-- received an empty `forms` array — the frontend sidebar showed nothing and
-- blocked all further steps.
--
-- Mirrors the pre-existing "Super Admin" business role's form set exactly
-- (same forms, same status), since that is the closest existing definition
-- of "full access" already validated in this codebase. Idempotent: safe to
-- re-run, and does nothing if Company Admin already has any mapping seeded.

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'Company Admin') AS role_id,
  rfm.form_id,
  rfm.status,
  NOW(),
  NOW()
FROM role_form_mapping rfm
WHERE rfm.role_id = (SELECT id FROM roles WHERE role_name = 'Super Admin')
ON CONFLICT (role_id, form_id) DO NOTHING;

-- ================== database/migrations/20260729_seed_platform_roles.sql ==================
-- =============================================================================
-- Multi-Tenancy Retrofit — Phase 1b: add the two new role definitions this
-- retrofit introduces. Role definitions stay GLOBAL (per the retrofit spec),
-- exactly like the existing HR/Finance/Division Head/Project Manager/
-- Management rows.
--
-- Deliberately named "Platform Admin", NOT "Super Admin" — this database
-- already has a business-level "Super Admin" role (id 6, seeded by
-- database/rbac_seed.sql) that is assigned to a real existing user and
-- carries real role_form_mapping grants (Dashboard, Reports, Clients,
-- Employees, etc. — see rbac_seed.sql). Reusing that name/row for the new
-- platform-level operator would either (a) silently hand the new platform
-- role all of the old role's existing business-data access, directly
-- contradicting "Super Admin must not access Dashboard/Reports/Clients/...",
-- or (b) require stripping the old role's mappings, which would break the
-- existing user already assigned to it (user_roles row (41, 1, 6) in
-- rbac_seed.sql). "Platform Admin" avoids both problems.
--
-- This role exists ONLY so the platform admin user satisfies the existing
-- authenticate() middleware's "must have at least one active role" check
-- (src/middlewares/auth.js) — actual gating of platform-only endpoints
-- (POST/GET/PATCH /api/v1/companies) is done by the dedicated
-- requirePlatformAdmin middleware checking users.is_platform_admin, NOT by
-- this role name. No role_form_mapping rows are ever created for this role.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

-- created_at/updated_at set explicitly to NOW() rather than left to a
-- DB-level DEFAULT — see 20260804_backfill_default_service_types.sql's header
-- comment for why that assumption doesn't reliably hold across environments.
INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES ('Platform Admin', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES ('Company Admin', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260730_add_employee_password.sql ==================
-- =============================================================================
-- Employee Self Timesheet — Phase 1: give Employees a password column so they
-- can authenticate through the same /auth/login endpoint as Users. Nullable
-- (an Employee with no password set simply cannot log in yet, until an Admin
-- provisions one via POST/PUT /employees or PUT /employees/:id/reset-password).
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS password VARCHAR(255);

-- email_id itself is not in database/schema.sql or any earlier migration —
-- like service_categories (see 20260803_ensure_service_categories_schema.sql),
-- it only existed on already-migrated databases because it was added
-- out-of-band at some point. Add it here for real so a brand-new environment
-- ends up with it too, matching src/models/Employee.js's field definition.
ALTER TABLE employees ADD COLUMN IF NOT EXISTS email_id VARCHAR(150);

-- email_id lookups happen on every login attempt for an unrecognised-user
-- email; index it for that lookup (uniqueness itself stays an application-
-- level rule — see employeeRepository.findAllEmailsGlobal — not enforced here).
CREATE INDEX IF NOT EXISTS idx_employees_email_id ON employees (email_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260730_add_timesheet_description_and_indexes.sql ==================
-- =============================================================================
-- Employee Self Timesheet — Phase 3: a `description` column so Employee
-- self-service entries can carry a mandatory description (enforced at the
-- validation layer, not here — nullable at the DB level so existing
-- Admin/Excel-imported rows, which never had one, remain valid). Also adds
-- a composite index for the employee_id + date_range queries the Calendar/
-- Daily/Monthly APIs run. Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS description TEXT;

CREATE INDEX IF NOT EXISTS idx_timesheets_employee_date ON timesheets (employee_id, timesheet_date);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260730_add_timesheet_import_source.sql ==================
-- =============================================================================
-- Employee Self Timesheet — Phase 5: track whether an import batch came
-- from an Excel upload or a PMS sync, so confirmImport() knows whether to
-- re-parse the stored file or re-fetch from the PMS provider on confirm.
-- Every existing row defaults to 'excel' — fully backward-compatible.
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE timesheet_import_history
  ADD COLUMN IF NOT EXISTS source VARCHAR(10) NOT NULL DEFAULT 'excel'
  CHECK (source IN ('excel', 'pms'));

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260730_company_id_not_null_and_unique.sql ==================
-- =============================================================================
-- Multi-Tenancy Retrofit — Phase 2: NOT NULL cutover + per-company uniqueness.
--
-- Sequencing safety: Phase 1's backfill already guarantees zero NULL
-- company_id rows on every business table (verified live before this file is
-- run). We still add a temporary DEFAULT alongside NOT NULL so any insert
-- path not yet updated by Phase 5 keeps working (defaults silently to GTT)
-- instead of erroring outright. That DEFAULT must be dropped explicitly
-- (ALTER COLUMN company_id DROP DEFAULT) before a second real company is
-- ever provisioned for real use — leaving it in place past that point would
-- silently misfile a second company's data into GTT. Track that drop as its
-- own go/no-go gate, not part of this file.
--
-- Constraint names below are the REAL, verified names from database/schema.sql
-- (some differ from what the Sequelize model files declare, and two tables —
-- employees, service_types, service_pos — turned out to already have a
-- DB-level constraint the initial code inventory missed by only reading the
-- model files instead of the schema directly).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE
  gtt_id INT;
BEGIN
  SELECT id INTO gtt_id FROM companies WHERE company_code = 'GTT';

  EXECUTE format('ALTER TABLE users ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  -- users.company_id stays NULLABLE (the platform admin is the sole exception) — no SET NOT NULL here.

  EXECUTE format('ALTER TABLE clients ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE clients ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE employees ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE employees ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE monthly_costs ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE monthly_costs ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE service_pos ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE service_pos ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE service_po_resources ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE service_po_resources ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE service_types ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE service_types ALTER COLUMN company_id SET NOT NULL;

  -- service_categories may not exist yet on a genuinely fresh database (see
  -- 20260803_ensure_service_categories_schema.sql's header) — skip gracefully
  -- there; that later migration creates it with company_id already NOT NULL.
  IF to_regclass('public.service_categories') IS NOT NULL THEN
    EXECUTE format('ALTER TABLE service_categories ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
    ALTER TABLE service_categories ALTER COLUMN company_id SET NOT NULL;
  END IF;

  EXECUTE format('ALTER TABLE sub_projects ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE sub_projects ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE timesheets ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE timesheets ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE timesheet_import_history ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE timesheet_import_history ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE timesheet_import_errors ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE timesheet_import_errors ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE ai_insights ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE ai_insights ALTER COLUMN company_id SET NOT NULL;

  EXECUTE format('ALTER TABLE ai_insight_jobs ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
  ALTER TABLE ai_insight_jobs ALTER COLUMN company_id SET NOT NULL;
END $$;

-- Per-company uniqueness: drop the old single-column constraint, add the
-- composite (company_id, code) one. Real constraint names verified against
-- database/schema.sql.
ALTER TABLE clients DROP CONSTRAINT IF EXISTS uq_clients_client_code;
ALTER TABLE clients ADD CONSTRAINT uq_clients_company_code UNIQUE (company_id, client_code);

ALTER TABLE employees DROP CONSTRAINT IF EXISTS uq_employees_employee_code;
ALTER TABLE employees ADD CONSTRAINT uq_employees_company_code UNIQUE (company_id, employee_code);

ALTER TABLE service_types DROP CONSTRAINT IF EXISTS uq_service_types_name;
ALTER TABLE service_types ADD CONSTRAINT uq_service_types_company_name UNIQUE (company_id, service_type_name);

ALTER TABLE service_pos DROP CONSTRAINT IF EXISTS uq_service_pos_code;
ALTER TABLE service_pos ADD CONSTRAINT uq_service_pos_company_code UNIQUE (company_id, service_po_code);

ALTER TABLE sub_projects DROP CONSTRAINT IF EXISTS uq_sub_projects_code;
ALTER TABLE sub_projects ADD CONSTRAINT uq_sub_projects_company_code UNIQUE (company_id, sub_project_code);

-- service_categories.name had no prior DB-level constraint (app-layer check
-- only) — add the composite one fresh. IF EXISTS on the table: may not exist
-- yet on a genuinely fresh database (see
-- 20260803_ensure_service_categories_schema.sql's header), which applies
-- this same constraint unconditionally once it creates the table.
ALTER TABLE IF EXISTS service_categories DROP CONSTRAINT IF EXISTS uq_service_categories_company_name;
ALTER TABLE IF EXISTS service_categories ADD CONSTRAINT uq_service_categories_company_name UNIQUE (company_id, name);

-- users.email intentionally left untouched — stays globally unique (login identity).

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260730_create_employee_servicepo_mapping.sql ==================
-- =============================================================================
-- Employee Self Timesheet — Phase 2: which Service POs an Employee is
-- allowed to self-log time against. Distinct from the existing
-- service_po_resources allocation table (no status lifecycle there) — this
-- table drives Project Loading + eligibility checks in the Employee
-- Timesheet module (Phase 3). Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS employee_servicepo_mapping CASCADE;
CREATE TABLE employee_servicepo_mapping (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id),
  employee_id INT NOT NULL REFERENCES employees(id),
  service_po_id INT NOT NULL REFERENCES service_pos(id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_employee_servicepo_mapping UNIQUE (employee_id, service_po_id)
);

CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_company_id     ON employee_servicepo_mapping (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_employee_id    ON employee_servicepo_mapping (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_service_po_id  ON employee_servicepo_mapping (service_po_id);
CREATE INDEX IF NOT EXISTS idx_employee_servicepo_mapping_status         ON employee_servicepo_mapping (status);

DROP TRIGGER IF EXISTS trg_employee_servicepo_mapping_updated_at ON employee_servicepo_mapping;
CREATE TRIGGER trg_employee_servicepo_mapping_updated_at BEFORE UPDATE ON employee_servicepo_mapping
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260730_create_employee_sessions.sql ==================
-- =============================================================================
-- Employee Self Timesheet — Phase 1: session store for Employee refresh
-- tokens, mirroring user_sessions so Employee logins get the same
-- revocation/rotation behaviour as User logins. Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS employee_sessions CASCADE;
CREATE TABLE employee_sessions (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees(id),
  refresh_token TEXT UNIQUE,
  expires_at TIMESTAMP,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_sessions_employee_id ON employee_sessions (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_sessions_refresh_token ON employee_sessions (refresh_token);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260731_create_employee_work_logs.sql ==================
-- =============================================================================
-- Employee Self Timesheet — REDESIGN: Employee-entered work is no longer
-- written directly into `timesheets`. It is captured in this separate,
-- pre-official "draft" table instead. Only after an Admin runs the
-- Sync (Admin Timesheet -> "Sync Employee Work Logs") does the data become
-- part of the official `timesheets` table, via the SAME import pipeline
-- Excel uploads already use (see timesheetService.js runImportPreview()).
--
-- status: 'pending'  -> entered by employee, not yet synced.
--         'synced'   -> included in a completed sync; timesheet_import_id
--                       points at the resulting timesheet_import_history row.
--                       Synced rows are treated as read-only by the Employee
--                       module (the official record already exists).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS employee_work_logs CASCADE;
CREATE TABLE employee_work_logs (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id),
  employee_id INT NOT NULL REFERENCES employees(id),
  service_po_id INT NOT NULL REFERENCES service_pos(id),
  sub_project_id INT REFERENCES sub_projects(id),
  work_date DATE NOT NULL,
  hours DECIMAL(4, 2) NOT NULL CHECK (hours > 0 AND hours <= 12),
  description TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'synced')),
  synced_at TIMESTAMP,
  timesheet_import_id INT REFERENCES timesheet_import_history(id),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_employee_work_logs UNIQUE (employee_id, service_po_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_employee_work_logs_company_id    ON employee_work_logs (company_id);
CREATE INDEX IF NOT EXISTS idx_employee_work_logs_employee_id   ON employee_work_logs (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_work_logs_service_po_id ON employee_work_logs (service_po_id);
CREATE INDEX IF NOT EXISTS idx_employee_work_logs_status        ON employee_work_logs (status);
CREATE INDEX IF NOT EXISTS idx_employee_work_logs_employee_date ON employee_work_logs (employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_employee_work_logs_company_date  ON employee_work_logs (company_id, work_date);

DROP TRIGGER IF EXISTS trg_employee_work_logs_updated_at ON employee_work_logs;
CREATE TRIGGER trg_employee_work_logs_updated_at BEFORE UPDATE ON employee_work_logs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260731_drop_stale_global_unique_indexes.sql ==================
-- =============================================================================
-- Multi-Tenancy Retrofit — supplemental fix discovered during Phase 5.
--
-- Four GLOBAL partial-unique indexes exist on the live database that are
-- NOT present in any tracked migration file (database/schema.sql predates
-- them; they appear to have been added ad-hoc, outside migration tracking).
-- They enforce global (cross-company) uniqueness among active/non-deleted
-- rows, which directly contradicts the per-company composite unique
-- constraints added in 20260730_company_id_not_null_and_unique.sql — e.g.
-- idx_employees_code_active blocks two different companies from ever having
-- an employee with the same employee_code, even though
-- uq_employees_company_code (company_id, employee_code) already correctly
-- allows that. Discovered live: creating a second company's employee with a
-- code already used by an unrelated company's active employee failed with
-- "duplicate key value violates unique constraint idx_employees_code_active".
--
-- Each dropped index is fully superseded by the composite (company_id, code)
-- unique index already added in the prior migration — dropping these does
-- NOT reduce protection against duplicates within one company, it only
-- removes an incorrect cross-company restriction.
--
-- NOT touched (correct as-is, matches the "email stays globally unique"
-- design decision): idx_employees_email_active, employees_email_id_key.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP INDEX IF EXISTS idx_employees_code_active;
DROP INDEX IF EXISTS uq_service_pos_code_active;
DROP INDEX IF EXISTS uq_service_types_name_active;
DROP INDEX IF EXISTS uq_service_categories_name_active;
-- uq_service_categories_name is backed by a table CONSTRAINT (not a bare
-- index) — must be dropped via ALTER TABLE, not DROP INDEX. IF EXISTS on the
-- table itself too: service_categories may not exist yet on a genuinely
-- fresh database at this point in the migration sequence (see
-- 20260803_ensure_service_categories_schema.sql's header).
ALTER TABLE IF EXISTS service_categories DROP CONSTRAINT IF EXISTS uq_service_categories_name;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260731_employee_work_logs_import_fk_set_null.sql ==================
-- =============================================================================
-- Fix: employee_work_logs.timesheet_import_id was declared as a plain FK
-- with no ON DELETE action (defaults to NO ACTION/RESTRICT in Postgres),
-- so deleting a timesheet_import_history row blocked with:
--   "update or delete on table timesheet_import_history violates foreign
--    key constraint employee_work_logs_timesheet_import_id_fkey"
--
-- Business rule: Employee Work Logs are the source of truth and must
-- survive a Timesheet Import deletion — only the official Timesheet data
-- and its Import History should be removed. ON DELETE SET NULL makes this
-- a DB-level guarantee (not just an application convention): deleting an
-- import history row can never be blocked by, or cascade-delete, a work
-- log row again, regardless of which code path performs the delete.
--
-- This only clears the now-dangling FK column itself. The companion
-- application-level fix (timesheetService.js deleteImports ->
-- employeeWorkLogRepository.revertSyncStatusByImportIds) additionally
-- reverts status/synced_at back to 'pending'/null in the SAME transaction,
-- since a plain SET NULL would otherwise leave a row stuck at
-- status='synced' pointing at nothing.
--
-- Safe to re-run (DROP CONSTRAINT IF EXISTS + re-ADD).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employee_work_logs
  DROP CONSTRAINT IF EXISTS employee_work_logs_timesheet_import_id_fkey;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT employee_work_logs_timesheet_import_id_fkey
  FOREIGN KEY (timesheet_import_id)
  REFERENCES timesheet_import_history (id)
  ON DELETE SET NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260731_make_timesheet_import_history_file_path_nullable.sql ==================
-- =============================================================================
-- Fix: the live `timesheet_import_history.file_path` column has always been
-- NOT NULL at the DB level (inherited from database/schema.sql's baseline —
-- this table predates a dedicated migration), even though the Sequelize
-- model (src/models/TimesheetImportHistory.js) has always declared
-- `allowNull: true`. Sequelize's `allowNull` is a validation-layer setting
-- only; it never alters physical DDL, so this drift went unnoticed until
-- the "Sync Employee Work Logs" flow — the first caller to legitimately
-- have no uploaded file — tried to insert file_path = NULL and hit the
-- real Postgres constraint.
--
-- NULL is the semantically correct value here ("no file exists for this
-- import"), matching how sub_project_id/timesheet_import_id already use
-- NULL elsewhere in this schema for "not applicable" — a synthetic
-- placeholder string would be misleading (it would look like a real path).
-- Excel imports are entirely unaffected: they always supply a real
-- file_path value regardless of what the column allows.
--
-- Safe to re-run (DROP NOT NULL is a no-op if already nullable).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE timesheet_import_history ALTER COLUMN file_path DROP NOT NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260801_create_password_reset_otps.sql ==================
-- =============================================================================
-- Forgot Password module (User + Employee) — OTP storage.
--
-- One row per OTP issued. `otp` stores a bcrypt HASH, never plaintext
-- (Phase 8 allows this; a DB read can never expose a live, usable OTP).
-- login_type/user_id/employee_id mirror the same User-vs-Employee
-- resolution already used by /auth/login — exactly one of user_id/
-- employee_id is populated per row.
--
-- NOTE: kept as its own single-table file (not combined with
-- password_reset_history) — this migration runner executes each file as
-- one raw multi-statement query, and a second CREATE TABLE further down
-- the same file was observed to silently not apply even though no error
-- was raised. One table per migration file is also the convention every
-- other migration in this project already follows.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS password_reset_otps CASCADE;
CREATE TABLE password_reset_otps (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id),
  login_type VARCHAR(10) NOT NULL CHECK (login_type IN ('user', 'employee')),
  user_id INT REFERENCES users(id),
  employee_id INT REFERENCES employees(id),
  email VARCHAR(150) NOT NULL,
  otp VARCHAR(255) NOT NULL,
  purpose VARCHAR(30) NOT NULL DEFAULT 'password_reset',
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'used')),
  attempt_count INT NOT NULL DEFAULT 0,
  verified_at TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_ip VARCHAR(45),
  created_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_otps_email        ON password_reset_otps (email);
CREATE INDEX IF NOT EXISTS idx_password_reset_otps_email_status ON password_reset_otps (email, status);
CREATE INDEX IF NOT EXISTS idx_password_reset_otps_company_id   ON password_reset_otps (company_id);

DROP TRIGGER IF EXISTS trg_password_reset_otps_updated_at ON password_reset_otps;
CREATE TRIGGER trg_password_reset_otps_updated_at BEFORE UPDATE ON password_reset_otps
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260802_create_password_reset_history.sql ==================
-- =============================================================================
-- Forgot Password module (User + Employee) — audit trail.
--
-- Append-only log (no updated_at, matches the existing audit_logs
-- convention) — one row per meaningful action, written even when the
-- submitted email does not resolve to any account (user_id/employee_id/
-- company_id left NULL), so enumeration attempts stay auditable without
-- ever revealing account existence to the caller.
--
-- Kept as its own file — see 20260801_create_password_reset_otps.sql's
-- note on why multi-table migration files were split apart in this feature.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS password_reset_history CASCADE;
CREATE TABLE password_reset_history (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies(id),
  email VARCHAR(150) NOT NULL,
  login_type VARCHAR(10) CHECK (login_type IN ('user', 'employee')),
  user_id INT REFERENCES users(id),
  employee_id INT REFERENCES employees(id),
  action VARCHAR(30) NOT NULL CHECK (action IN (
    'OTP_SENT', 'OTP_RESENT', 'OTP_VERIFIED', 'OTP_FAILED',
    'PASSWORD_RESET', 'PASSWORD_RESET_FAILED'
  )),
  ip_address VARCHAR(45),
  user_agent TEXT,
  remarks TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_history_email      ON password_reset_history (email);
CREATE INDEX IF NOT EXISTS idx_password_reset_history_company_id ON password_reset_history (company_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_history_action     ON password_reset_history (action);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260803_ensure_service_categories_schema.sql ==================
-- =============================================================================
-- Reconcile service_categories / service_types.service_category_id schema.
--
-- Root cause of "POST /api/v1/service-types works locally, 500s on Railway":
-- the service_categories table and the service_types.service_category_id
-- column were never created by a tracked migration in this repo (grep
-- confirms zero hits for either across database/schema.sql and every prior
-- database/migrations/*.sql file). Both were introduced out-of-band — a
-- manual ALTER TABLE / sequelize sync({ alter: true }) run directly against
-- each environment independently — so local and Railway had no guarantee of
-- ending up with the same shape. 20260728_add_company_tenancy_schema.sql and
-- 20260730_company_id_not_null_and_unique.sql already both ALTER this table
-- unconditionally, so they already assumed it exists; this migration is the
-- missing "create it if it doesn't, patch it if it's partial" step that
-- should have preceded them.
--
-- Written to be safe to run against any of the possible current states:
-- table missing entirely, table present but missing a column/constraint, or
-- everything already present (pure no-op). Re-runnable.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

-- 1. Table itself, in case it doesn't exist at all on this database.
DROP TABLE IF EXISTS service_categories CASCADE;
CREATE TABLE service_categories (
  id                 SERIAL PRIMARY KEY,
  company_id         INT,
  name               VARCHAR(100) NOT NULL,
  status             VARCHAR(10)  NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active', 'inactive')),
  report_bucket_key  VARCHAR(30),
  is_deleted         BOOLEAN      NOT NULL DEFAULT false,
  created_by         INT,
  updated_by         INT,
  created_at         TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- 2. Any column that could be missing if the table already existed but
--    predates one of these fields being added.
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS company_id INT;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS report_bucket_key VARCHAR(30);
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS created_by INT;
ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS updated_by INT;

-- 3. company_id -> companies, backfilled to the default GTT tenant and cut
--    over to NOT NULL — the same pattern every other business table already
--    went through (20260729_backfill_company_id.sql /
--    20260730_company_id_not_null_and_unique.sql). No-op if already done.
DO $$
DECLARE
  gtt_id INT;
BEGIN
  SELECT id INTO gtt_id FROM companies WHERE company_code = 'GTT';

  IF gtt_id IS NOT NULL THEN
    UPDATE service_categories SET company_id = gtt_id WHERE company_id IS NULL;
    EXECUTE format('ALTER TABLE service_categories ALTER COLUMN company_id SET DEFAULT %L', gtt_id);
    ALTER TABLE service_categories ALTER COLUMN company_id SET NOT NULL;
  END IF;
END $$;

ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS service_categories_company_id_fkey;
ALTER TABLE service_categories
  ADD CONSTRAINT service_categories_company_id_fkey
  FOREIGN KEY (company_id) REFERENCES companies (id);

CREATE INDEX IF NOT EXISTS idx_service_categories_company_id ON service_categories (company_id);

-- 4. Uniqueness + check constraints under the exact names the app and later
--    migrations already assume exist.
--
--    uq_service_categories_company_name may already exist here as a plain
--    index rather than a table constraint — that happens when a prior
--    Sequelize model-level `indexes:` sync created it directly, instead of
--    the ALTER TABLE ... ADD CONSTRAINT this migration uses. DROP CONSTRAINT
--    IF EXISTS only looks in pg_constraint and silently no-ops against a
--    bare index of the same name, so ADD CONSTRAINT's implicit backing index
--    then collides with it ("relation ... already exists"). Drop both forms
--    before recreating it as a real constraint.
ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS uq_service_categories_company_name;
DROP INDEX IF EXISTS uq_service_categories_company_name;
ALTER TABLE service_categories
  ADD CONSTRAINT uq_service_categories_company_name UNIQUE (company_id, name);

ALTER TABLE service_categories DROP CONSTRAINT IF EXISTS chk_service_categories_report_bucket_key;
ALTER TABLE service_categories
  ADD CONSTRAINT chk_service_categories_report_bucket_key
  CHECK (report_bucket_key IS NULL OR report_bucket_key IN ('billable', 'non_billable', 'customer_non_billable'));

DROP TRIGGER IF EXISTS trg_service_categories_updated_at ON service_categories;
CREATE TRIGGER trg_service_categories_updated_at BEFORE UPDATE ON service_categories
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- 5. The column on service_types this migration exists to guarantee.
--    Constraint name/behavior (ON UPDATE CASCADE ON DELETE SET NULL) verified
--    against a working local database — deleting a category should clear the
--    reference on any service_type that used it, not block the delete or
--    cascade-delete the service_type itself.
ALTER TABLE service_types ADD COLUMN IF NOT EXISTS service_category_id INT;

-- Drop both the hand-written name (used locally) and Sequelize's
-- default-generated name (<table>_<column>_fkey, what a model-driven sync
-- would have produced instead) — whichever this database actually has.
ALTER TABLE service_types DROP CONSTRAINT IF EXISTS fk_service_types_category;
ALTER TABLE service_types DROP CONSTRAINT IF EXISTS service_types_service_category_id_fkey;
ALTER TABLE service_types
  ADD CONSTRAINT fk_service_types_category
  FOREIGN KEY (service_category_id) REFERENCES service_categories (id)
  ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_service_types_service_category_id ON service_types (service_category_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260804_backfill_default_service_types.sql ==================
-- =============================================================================
-- Backfill default service types for companies provisioned before
-- companyService.createWithAdmin() started seeding them (see that file for
-- the source-of-truth default list). Those companies already got their 3
-- default service_categories on creation, but nothing in service_types —
-- so every "create a service type" call for them either had to guess a
-- category ID (and typically guessed wrong / guessed another company's ID)
-- or had literally nothing to reference.
--
-- Resolves each company's own category IDs by NAME, never hardcoded —
-- every company has a different generated ID for "Billable" etc. Skips a
-- company already holding a given service type name (ON CONFLICT on
-- uq_service_types_company_name), so this is safe to re-run and safe for
-- companies that already have some/all of these.
--
-- created_at/updated_at are set explicitly to NOW() below rather than left
-- for a DB-level DEFAULT to fill in. This table's DEFAULT NOW() exists in
-- database/schema.sql's original CREATE TABLE and is present on any database
-- built from that file (e.g. a fresh local setup) — but Railway's actual
-- service_types.created_at/updated_at have no DEFAULT at all (confirmed by
-- this migration's first run there: "null value in column created_at
-- violates not-null constraint"), because those columns were retrofitted
-- there directly via a Sequelize model sync at some point instead of a
-- tracked migration — Sequelize manages timestamps at the application layer
-- and never adds a server-side DEFAULT for them. This is the same
-- local-vs-Railway drift already seen with the service_categories unique
-- index/constraint mismatch (20260803_ensure_service_categories_schema.sql)
-- and the service_category_id FK naming mismatch — so this migration both
-- works around it (explicit NOW()) and closes the gap for good (the
-- SET DEFAULT statements below) instead of relying on assumptions about
-- what the live schema already has.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

-- Close the underlying gap so no future raw SQL against these two tables can
-- hit this same failure — safe/idempotent even where the default already
-- exists (locally) or the table doesn't have the column at all yet (won't
-- happen here, but IF EXISTS on the table guards it regardless).
ALTER TABLE IF EXISTS service_types      ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE IF EXISTS service_types      ALTER COLUMN updated_at SET DEFAULT NOW();
ALTER TABLE IF EXISTS service_categories ALTER COLUMN created_at SET DEFAULT NOW();
ALTER TABLE IF EXISTS service_categories ALTER COLUMN updated_at SET DEFAULT NOW();

DO $$
DECLARE
  comp RECORD;
  cat_billable INT;
  cat_non_billable INT;
  cat_customer_non_billable INT;
  fallback_user INT;
BEGIN
  FOR comp IN SELECT id FROM companies WHERE is_deleted = false LOOP
    SELECT id INTO cat_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Billable' AND is_deleted = false
      LIMIT 1;

    SELECT id INTO cat_non_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Non-Billable' AND is_deleted = false
      LIMIT 1;

    SELECT id INTO cat_customer_non_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Customer Non-Billable' AND is_deleted = false
      LIMIT 1;

    -- created_by/updated_by are nullable — best-effort attribute to any user
    -- of this company, never blocks the insert if none is found.
    SELECT id INTO fallback_user FROM users WHERE company_id = comp.id ORDER BY id LIMIT 1;

    IF cat_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by, created_at, updated_at)
      VALUES
        (comp.id, 'Project',            cat_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Service Pack',       cat_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Staff Augmentation', cat_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'AMC',                cat_billable, fallback_user, fallback_user, NOW(), NOW())
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;

    IF cat_non_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by, created_at, updated_at)
      VALUES
        (comp.id, 'Internal Support', cat_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Team Management',  cat_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Leaves',           cat_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'L&D',              cat_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Others',           cat_non_billable, fallback_user, fallback_user, NOW(), NOW())
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;

    IF cat_customer_non_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by, created_at, updated_at)
      VALUES
        (comp.id, 'Customer Work',                              cat_customer_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Complimentary Hours',                        cat_customer_non_billable, fallback_user, fallback_user, NOW(), NOW()),
        (comp.id, 'Product/Solution/Framework Development',     cat_customer_non_billable, fallback_user, fallback_user, NOW(), NOW())
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;
  END LOOP;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260805_create_service_po_hierarchy.sql ==================
-- =============================================================================
-- Service PO Hierarchy — dedicated table, NOT a parent_id on service_pos.
--
-- Hierarchy belongs to exactly ONE Service PO. Inside that PO there are
-- PARENT nodes (parent_hierarchy_id NULL) and, under each PARENT, CHILD
-- nodes (parent_hierarchy_id = the PARENT's id). Max depth is 2 inside one
-- PO (Service PO -> Parent -> Child) — a CHILD can never itself be a
-- parent_hierarchy_id target; that's enforced in servicePOHierarchyService.js,
-- not here.
--
-- service_pos itself is untouched by this migration (no parent_id column) —
-- this is a completely separate concept from any prior self-referencing PO
-- hierarchy attempt.
--
-- company_id/created_by/updated_by are additive to the spec's column list,
-- added only for consistency with every other table in this multi-tenant
-- app (service_pos, employee_servicepo_mapping, employee_work_logs all
-- carry the same three columns) — see servicePOHierarchyService.js for how
-- they're populated.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS service_po_hierarchy CASCADE;
CREATE TABLE service_po_hierarchy (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  parent_hierarchy_id INT REFERENCES service_po_hierarchy (id),
  node_name VARCHAR(200) NOT NULL,
  node_type VARCHAR(10) NOT NULL CHECK (node_type IN ('PARENT', 'CHILD')),
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_po_hierarchy_service_po_id ON service_po_hierarchy (service_po_id);
CREATE INDEX IF NOT EXISTS idx_service_po_hierarchy_parent_hierarchy_id ON service_po_hierarchy (parent_hierarchy_id);
CREATE INDEX IF NOT EXISTS idx_service_po_hierarchy_company_id ON service_po_hierarchy (company_id);

DROP TRIGGER IF EXISTS trg_service_po_hierarchy_updated_at ON service_po_hierarchy;
CREATE TRIGGER trg_service_po_hierarchy_updated_at BEFORE UPDATE ON service_po_hierarchy
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Employee Timesheet integration: an employee's work log entry keeps its
-- existing, required service_po_id (sync only ever reads that column,
-- exactly as today) and optionally also tags which hierarchy node (Parent
-- or Child) the hours were logged against, purely for the employee's own
-- selection UI/history — never read by sync, import, or reports.
-- ON DELETE SET NULL mirrors this table's existing timesheet_import_id FK
-- (see 20260731_employee_work_logs_import_fk_set_null.sql) — deleting a
-- hierarchy node must never block or cascade-delete a historical work log
-- entry; the entry just loses its hierarchy tag and keeps its service_po_id.
ALTER TABLE employee_work_logs
  ADD COLUMN IF NOT EXISTS hierarchy_node_id INT REFERENCES service_po_hierarchy (id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_employee_work_logs_hierarchy_node_id ON employee_work_logs (hierarchy_node_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260806_fix_service_po_hierarchy_schema.sql ==================
-- =============================================================================
-- Corrects 20260805_create_service_po_hierarchy.sql's column types/shape to
-- match the finalized spec exactly:
--   - id/service_po_id/parent_hierarchy_id: BIGSERIAL/BIGINT, not SERIAL/INT
--   - node_name: VARCHAR(255), not VARCHAR(200)
--   - status: BOOLEAN DEFAULT TRUE, not VARCHAR('active'/'inactive')
--   - no company_id column — tenant scoping is derived through service_po_id
--     -> service_pos.company_id instead of a redundant column on this table
--     (see servicePOHierarchyService.js, which always resolves ownership via
--     servicePORepository.findById(node.service_po_id, companyId))
--
-- Safe to DROP and recreate rather than ALTER: service_po_hierarchy has zero
-- rows and employee_work_logs.hierarchy_node_id is NULL on every row as of
-- this migration (verified live before writing this file) — this feature
-- was added and immediately reverted/corrected within the same day, never
-- reaching real usage.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS hierarchy_node_id;
DROP INDEX IF EXISTS idx_employee_work_logs_hierarchy_node_id;

DROP TRIGGER IF EXISTS trg_service_po_hierarchy_updated_at ON service_po_hierarchy;
DROP TABLE IF EXISTS service_po_hierarchy;

CREATE TABLE service_po_hierarchy (
  id BIGSERIAL PRIMARY KEY,
  service_po_id BIGINT NOT NULL REFERENCES service_pos (id),
  parent_hierarchy_id BIGINT REFERENCES service_po_hierarchy (id),
  node_name VARCHAR(255) NOT NULL,
  node_type VARCHAR(20) NOT NULL CHECK (node_type IN ('PARENT', 'CHILD')),
  display_order INT NOT NULL DEFAULT 0,
  status BOOLEAN NOT NULL DEFAULT TRUE,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_service_po_hierarchy_service_po_id ON service_po_hierarchy (service_po_id);
CREATE INDEX idx_service_po_hierarchy_parent_hierarchy_id ON service_po_hierarchy (parent_hierarchy_id);

CREATE TRIGGER trg_service_po_hierarchy_updated_at BEFORE UPDATE ON service_po_hierarchy
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Re-add the Employee Timesheet integration column against the corrected
-- table/type. ON DELETE SET NULL matches employee_work_logs' existing
-- timesheet_import_id FK convention — never read by sync/import/reports.
ALTER TABLE employee_work_logs
  ADD COLUMN hierarchy_node_id BIGINT REFERENCES service_po_hierarchy (id) ON DELETE SET NULL;
CREATE INDEX idx_employee_work_logs_hierarchy_node_id ON employee_work_logs (hierarchy_node_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260807_hierarchy_node_id_unique_scope.sql ==================
-- =============================================================================
-- Employee Work Logs previously allowed only ONE row per
-- (employee_id, service_po_id, work_date), regardless of hierarchy_node_id.
-- Now that entries can be logged against individual Parent/Child hierarchy
-- nodes under the same Service PO (see service_po_hierarchy /
-- employeeTimesheetService.js), that constraint incorrectly blocked logging
-- hours against more than one node under the same PO on the same day —
-- e.g. 2 hrs against "Parent 1" and 3 hrs against "Parent 2" of the same PO,
-- same date, was rejected as a duplicate of the first insert.
--
-- Rescope uniqueness to (employee_id, service_po_id, hierarchy_node_id,
-- work_date) instead — one row per hierarchy node (or per PO itself, when
-- hierarchy_node_id is NULL) per employee per date.
--
-- hierarchy_node_id is nullable (NULL = hours logged directly against the
-- PO, no node tag), and Postgres treats NULL <> NULL in a plain multi-column
-- UNIQUE constraint — two NULL-hierarchy_node_id rows for the same
-- employee/PO/date would NOT violate a plain 4-column UNIQUE. Using
-- COALESCE(hierarchy_node_id, 0) in the index expression closes that gap —
-- 0 is never a real hierarchy_node id (BIGSERIAL starts at 1).
--
-- The app-level duplicate check (employeeWorkLogRepository.checkDuplicate)
-- enforces this same null-safe scope directly, so this index is a backstop
-- against races/direct DB writes, not the sole guard.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS uq_employee_work_logs;
DROP INDEX IF EXISTS uq_employee_work_logs;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_work_logs
  ON employee_work_logs (employee_id, service_po_id, COALESCE(hierarchy_node_id, 0), work_date);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260807_rename_company_admin_to_bu_admin.sql ==================
-- =============================================================================
-- Renames the "Company Admin" role (seeded by
-- 20260729_seed_platform_roles.sql) to "BU Admin" (Business Unit Admin) — a
-- naming clarification only, no behavior change. role_form_mapping,
-- user_roles, and users.role_id all reference roles.id, never role_name, so
-- no other table needs updating.
--
-- Every literal "Company Admin" string reference in application code has
-- been updated to "BU Admin" alongside this migration:
--   - src/repositories/roleRepository.js (EXCLUDED_ROLE_NAMES — and note
--     "BU Admin" is now deliberately NOT excluded from the role list, so it
--     appears as a selectable role on the Role-Form mapping screen)
--   - src/middlewares/authorize.js (SUPERUSER_ROLES)
--   - src/services/companyService.js (roleRepository.findByName lookup)
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

UPDATE roles
SET role_name = 'BU Admin', updated_at = NOW()
WHERE role_name = 'Company Admin';

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260807_restrict_admin_forms_to_platform_admin.sql ==================
-- =============================================================================
-- Restrict the "Roles" and "Forms" admin screens (form_master rows seeded in
-- database/rbac_seed.sql, module 'Administration') to the "Platform Admin"
-- role ONLY. These two screens ARE the RBAC configuration surface itself —
-- they manage which roles and forms exist system-wide — so access is being
-- tightened to the platform operator alone. Previously "Super Admin" (and
-- potentially other roles) had these mapped via rbac_seed.sql.
--
-- Soft-unmaps (status = false, never deletes — matches this table's existing
-- convention, see 20260723_add_role_form_mapping_status.sql) every OTHER
-- role's mapping to these two forms, then ensures Platform Admin has an
-- active mapping to both.
--
-- This is a deliberate, narrow exception to 20260729_seed_platform_roles.sql's
-- "no role_form_mapping rows are ever created for [Platform Admin]" — that
-- statement still holds for every OTHER form; only "Roles" and "Forms" are
-- carved out here. Going forward, this scope is also enforced at the
-- application layer — see rbacService.js's assertFormRoleMappingAllowed(),
-- called from mapForm()/replaceRoleFormMappings() — so these two forms can't
-- drift back onto another role, or be unmapped from Platform Admin, through
-- the Role-Form Mapping screen/API.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND form_id IN (
    SELECT id FROM form_master WHERE module_name = 'Administration' AND form_name IN ('Roles', 'Forms')
  )
  AND role_id <> (SELECT id FROM roles WHERE role_name = 'Platform Admin');

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'Platform Admin'),
  fm.id,
  true,
  NOW(),
  NOW()
FROM form_master fm
WHERE fm.module_name = 'Administration' AND fm.form_name IN ('Roles', 'Forms')
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260808_add_company_original_data_visibility.sql ==================
-- =============================================================================
-- Adds companies.is_original_data_visible — this is the authoritative,
-- COMPANY-LEVEL field driving the Original Timesheet publish rule (see
-- src/utils/timesheetPublishPolicy.js). Supersedes the short-lived
-- users.is_original_data_visible design (added and immediately reverted in
-- the same round of work, never reaching real usage — see
-- src/models/User.js's git history) and the earlier
-- roles.is_original_data_visible-based resolution before that. Neither of
-- those is consulted by this policy anymore.
--
-- true  -> this company's users work with Original (unpublished) data first
--          (is_publish = false on rows their imports/syncs create).
-- false -> this company's users should always see published data
--          (is_publish = true on rows their imports/syncs create).
--
-- Defaults to false.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_original_data_visible BOOLEAN NOT NULL DEFAULT false;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260808_drop_role_original_data_visibility.sql ==================
-- =============================================================================
-- Drops roles.is_original_data_visible (added by
-- 20260723_add_role_original_data_visibility.sql). is_original_data_visible
-- is now COMPANY-level only — see
-- database/migrations/20260808_add_company_original_data_visibility.sql and
-- src/utils/timesheetPublishPolicy.js. It was already removed from `users`
-- in the same round of work (a short-lived design, never reaching real
-- usage). Neither `roles` nor `users` carries this flag anymore; `companies`
-- is the single source of truth.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE roles DROP COLUMN IF EXISTS is_original_data_visible;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260809_set_bu_admin_default_form_mapping.sql ==================
-- =============================================================================
-- Sets BU Admin's (renamed from "Company Admin" — see
-- 20260807_rename_company_admin_to_bu_admin.sql) default form access to
-- exactly the set curated in the local/dev environment, instead of the full
-- mirror-of-"Super Admin" set that 20260729_seed_company_admin_form_mapping.sql
-- originally seeded.
--
-- That seed migration copied every one of Super Admin's form mappings verbatim
-- onto Company Admin, so any environment where it already ran (including a
-- fresh environment applying it for the first time) ends up with BU Admin
-- mapped to every admin-facing screen Super Admin has. In local, several of
-- those were deliberately unmapped afterward through the Role-Form Mapping
-- screen: "Role Form Mapping", "Service Categories", "Service Types", and
-- "Sub-Projects" — on top of "Roles"/"Forms", which
-- 20260807_restrict_admin_forms_to_platform_admin.sql already restricts
-- platform-wide. This migration replays that same curation as data, so every
-- environment converges on the same default regardless of when the mirror
-- seed ran or what Super Admin's form set looked like at the time.
--
-- Active (status = true) for BU Admin by default: Dashboard, AI Insights,
-- Employees, Users, Clients, Service POs, Timesheets, Monthly Costs, PO vs
-- Resource, Service PO Summary, Monthly Utilization, Resource Allocation,
-- Resource Project Utilization.
--
-- Explicitly NOT active for BU Admin: Forms, Roles, Role Form Mapping, User
-- Role Mapping, Service Categories, Service Types, Sub-Projects. Existing
-- inactive rows are soft-unmapped (status = false), never deleted, matching
-- this table's existing convention. No row is created for a form outside the
-- active set that doesn't already have one (e.g. "User Role Mapping"), so
-- this never grows BU Admin's mapping beyond what local already has.
--
-- Every other role's mappings are untouched.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'BU Admin'),
  fm.id,
  true,
  NOW(),
  NOW()
FROM form_master fm
WHERE (fm.module_name, fm.form_name) IN (
  ('Core', 'Dashboard'),
  ('Core', 'AI Insights'),
  ('People', 'Employees'),
  ('People', 'Users'),
  ('Business', 'Clients'),
  ('Business', 'Service POs'),
  ('Resources', 'Timesheets'),
  ('Resources', 'Monthly Costs'),
  ('Reports', 'PO vs Resource'),
  ('Reports', 'Service PO Summary'),
  ('Reports', 'Monthly Utilization'),
  ('Reports', 'Resource Allocation'),
  ('Reports', 'Resource Project Utilization')
)
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND role_id = (SELECT id FROM roles WHERE role_name = 'BU Admin')
  AND form_id IN (
    SELECT fm.id FROM form_master fm
    WHERE (fm.module_name, fm.form_name) NOT IN (
      ('Core', 'Dashboard'),
      ('Core', 'AI Insights'),
      ('People', 'Employees'),
      ('People', 'Users'),
      ('Business', 'Clients'),
      ('Business', 'Service POs'),
      ('Resources', 'Timesheets'),
      ('Resources', 'Monthly Costs'),
      ('Reports', 'PO vs Resource'),
      ('Reports', 'Service PO Summary'),
      ('Reports', 'Monthly Utilization'),
      ('Reports', 'Resource Allocation'),
      ('Reports', 'Resource Project Utilization')
    )
  );

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260810_add_monthly_work_log_support.sql ==================
-- =============================================================================
-- Monthly Work Log support for employee_work_logs.
--
-- Employees could previously only log hours day-by-day (Daily Work Log).
-- This adds a second mode, Monthly Work Log, where an employee submits one
-- month's hours in a single go, stored as row(s) dated on the month's LAST
-- calendar day (see employeeMonthlyWorkLogService.js). Both modes share this
-- same table — log_type distinguishes them.
--
-- hours is widened from NUMERIC(4,2) (max 99.99) to NUMERIC(6,2) (max
-- 9999.99) so a monthly line item can hold up to the 176-hour monthly cap;
-- Daily rows (still capped at 12 at the application layer) are unaffected.
--
-- No change to uq_employee_work_logs (employee_id, service_po_id,
-- COALESCE(hierarchy_node_id, 0), work_date) — Monthly submit deletes every
-- row (any log_type) in the month's date range before inserting, so nothing
-- from before that call can ever collide with what's being inserted.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employee_work_logs ADD COLUMN IF NOT EXISTS log_type VARCHAR(10) NOT NULL DEFAULT 'daily';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_employee_work_logs_log_type'
  ) THEN
    ALTER TABLE employee_work_logs
      ADD CONSTRAINT chk_employee_work_logs_log_type CHECK (log_type IN ('daily', 'monthly'));
  END IF;
END $$;

ALTER TABLE employee_work_logs ALTER COLUMN hours TYPE NUMERIC(6, 2);

-- The original table migration's `hours > 0 AND hours <= 12` CHECK is a
-- hard DB-level cap that would reject any Monthly row above 12 hours
-- regardless of the widened column precision above. Replace it with a
-- log_type-aware version: 12 for 'daily' (unchanged), 176 for 'monthly'.
ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS employee_work_logs_hours_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_employee_work_logs_hours_by_log_type'
  ) THEN
    ALTER TABLE employee_work_logs
      ADD CONSTRAINT chk_employee_work_logs_hours_by_log_type CHECK (
        hours > 0 AND (
          (log_type = 'daily' AND hours <= 12) OR
          (log_type = 'monthly' AND hours <= 176)
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_employee_work_logs_log_type
  ON employee_work_logs (employee_id, log_type, work_date);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260811_create_projects.sql ==================
-- =============================================================================
-- Project Master — every Service PO must belong to a Project (see the
-- following 3 migrations, which add service_pos.project_id in 3 phases:
-- nullable column -> backfill -> NOT NULL, mirroring this repo's own
-- company_id retrofit at 20260728/29/30_*.sql).
--
-- Project is a standalone, company-scoped grouping — independent of Client
-- (no client_id column here; a Service PO already has its own client_id).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS projects CASCADE;
CREATE TABLE projects (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  project_code VARCHAR(30) NOT NULL,
  project_name VARCHAR(200) NOT NULL,
  project_description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_company_code ON projects (company_id, project_code);
CREATE INDEX IF NOT EXISTS idx_projects_company_id ON projects (company_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);

DROP TRIGGER IF EXISTS trg_projects_updated_at ON projects;
CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260812_add_service_pos_project_id.sql ==================
-- =============================================================================
-- Phase 1 of 3 for service_pos.project_id (mirrors the company_id retrofit
-- pattern at 20260728/29/30_*.sql): add the column NULLABLE first.
-- 20260813_backfill_service_pos_project_id.sql backfills every existing row,
-- then 20260814_service_pos_project_id_not_null.sql cuts over to NOT NULL.
-- Never attempt this as a single migration on a populated table.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE service_pos ADD COLUMN IF NOT EXISTS project_id INT REFERENCES projects (id);
CREATE INDEX IF NOT EXISTS idx_service_pos_project_id ON service_pos (project_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260812_resync_serial_sequences_again.sql ==================
-- [bootstrap] stripped: BEGIN;

-- Recurrence of the drift fixed once already in
-- 20260729_resync_serial_sequences.sql. That migration only ever runs once
-- (tracked in schema_migrations), but manual data restores/imports done
-- directly against the database since then have again inserted rows with
-- explicit id values without advancing the affected SERIAL sequences —
-- surfacing everywhere as "<column> must be unique" on plain INSERTs
-- (companies, and reportedly other tables too).
--
-- Re-running the same idempotent resync: sets every SERIAL/IDENTITY primary
-- key sequence in the public schema to MAX(id) + 1. Safe to re-run; safe on
-- empty tables.
DO $$
DECLARE
  r RECORD;
  v_seq TEXT;
  v_next BIGINT;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_default LIKE 'nextval(%'
  LOOP
    v_seq := pg_get_serial_sequence(r.table_name, r.column_name);

    IF v_seq IS NOT NULL THEN
      EXECUTE format('SELECT COALESCE(MAX(%I), 0) + 1 FROM %I', r.column_name, r.table_name) INTO v_next;
      PERFORM setval(v_seq, v_next, false);
      RAISE NOTICE 'Resynced %.% -> % will start at %', r.table_name, r.column_name, v_seq, v_next;
    END IF;
  END LOOP;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260813_backfill_service_pos_project_id.sql ==================
-- =============================================================================
-- Phase 2 of 3 for service_pos.project_id — backfill.
--
-- Every company gets exactly one auto-created "Default Project"
-- (project_code 'PRJ-DEFAULT-<company_id>', idempotent via
-- ON CONFLICT DO NOTHING on uq_projects_company_code), and every one of
-- that company's existing Service POs with project_id still NULL is
-- assigned to it. New Service POs created after this must pick a real
-- Project via the normal API — this default only exists to satisfy the
-- upcoming NOT NULL constraint (20260814) for pre-existing rows.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE
  comp RECORD;
  default_project_id INT;
  fallback_user INT;
BEGIN
  FOR comp IN SELECT id FROM companies WHERE is_deleted = false LOOP
    -- created_by/updated_by are nullable — best-effort attribute to any user
    -- of this company, never blocks the insert if none is found (same
    -- pattern as 20260804_backfill_default_service_types.sql).
    SELECT id INTO fallback_user FROM users WHERE company_id = comp.id ORDER BY id LIMIT 1;

    INSERT INTO projects (company_id, project_code, project_name, project_description, status, created_by, updated_by, created_at, updated_at)
    VALUES (
      comp.id,
      'PRJ-DEFAULT-' || comp.id,
      'Default Project',
      'Auto-created during Project Master rollout to hold Service POs that existed before Projects were introduced.',
      'active',
      fallback_user,
      fallback_user,
      NOW(),
      NOW()
    )
    ON CONFLICT (company_id, project_code) DO NOTHING;

    SELECT id INTO default_project_id
      FROM projects
      WHERE company_id = comp.id AND project_code = 'PRJ-DEFAULT-' || comp.id
      LIMIT 1;

    UPDATE service_pos
      SET project_id = default_project_id
      WHERE company_id = comp.id AND project_id IS NULL;
  END LOOP;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260814_service_pos_project_id_not_null.sql ==================
-- =============================================================================
-- Phase 3 of 3 for service_pos.project_id — cut over to NOT NULL now that
-- every existing row has been backfilled (20260813). Every Service PO must
-- belong to exactly one Project from this point forward.
--
-- Guarded: only runs the ALTER once every row already has a project_id, so
-- this is safe to re-run and safe if applied out of order relative to a
-- delayed 20260813 in some environment.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM service_pos WHERE project_id IS NULL) THEN
    ALTER TABLE service_pos ALTER COLUMN project_id SET NOT NULL;
  ELSE
    RAISE EXCEPTION 'service_pos still has rows with a NULL project_id — run 20260813_backfill_service_pos_project_id.sql first.';
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260815_create_default_categories.sql ==================
-- =============================================================================
-- Default Categories Master — the single, platform-wide master copy of the
-- category names every new company previously got hardcoded into
-- companyService.js's DEFAULT_SERVICE_CATEGORIES array. That array's
-- literal content is preserved here verbatim (name + display_order only —
-- report_bucket_key stays out of this table and remains a small hardcoded
-- lookup in companyService.js, since it's not part of the requested column
-- list and only matters at service_categories insert time).
--
-- IMPORTANT: this table does NOT replace service_categories — every report/
-- dashboard/timesheet/import query in this codebase continues reading
-- service_categories exactly as before (same rows, same IDs). This table
-- is the new seeding source for company creation (see companyService.js)
-- and the target of company_categories' mapping (see
-- 20260817_create_company_categories.sql).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS default_categories CASCADE;
CREATE TABLE default_categories (
  id SERIAL PRIMARY KEY,
  category_name VARCHAR(100) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_categories_name ON default_categories (category_name);

INSERT INTO default_categories (category_name, display_order, status) VALUES
  ('Billable', 1, 'active'),
  ('Non-Billable', 2, 'active'),
  ('Customer Non-Billable', 3, 'active')
ON CONFLICT (category_name) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260816_create_default_types.sql ==================
-- =============================================================================
-- Default Types Master — mirrors 20260815_create_default_categories.sql,
-- preserving companyService.js's DEFAULT_SERVICE_TYPES array content
-- verbatim, each resolved to its default_category_id by name (never a
-- hardcoded ID — same convention this codebase already uses everywhere
-- else category IDs are per-company).
--
-- Does NOT replace service_types — see 20260815's header comment for why.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS default_types CASCADE;
CREATE TABLE default_types (
  id SERIAL PRIMARY KEY,
  default_category_id INT NOT NULL REFERENCES default_categories (id),
  type_name VARCHAR(100) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_default_types_name ON default_types (type_name);
CREATE INDEX IF NOT EXISTS idx_default_types_category_id ON default_types (default_category_id);

DO $$
DECLARE
  cat_billable INT;
  cat_non_billable INT;
  cat_customer_non_billable INT;
BEGIN
  SELECT id INTO cat_billable FROM default_categories WHERE category_name = 'Billable';
  SELECT id INTO cat_non_billable FROM default_categories WHERE category_name = 'Non-Billable';
  SELECT id INTO cat_customer_non_billable FROM default_categories WHERE category_name = 'Customer Non-Billable';

  INSERT INTO default_types (default_category_id, type_name, display_order, status) VALUES
    (cat_billable, 'Project', 1, 'active'),
    (cat_billable, 'Service Pack', 2, 'active'),
    (cat_billable, 'Staff Augmentation', 3, 'active'),
    (cat_billable, 'AMC', 4, 'active'),
    (cat_non_billable, 'Internal Support', 5, 'active'),
    (cat_non_billable, 'Team Management', 6, 'active'),
    (cat_non_billable, 'Leaves', 7, 'active'),
    (cat_non_billable, 'L&D', 8, 'active'),
    (cat_non_billable, 'Others', 9, 'active'),
    (cat_customer_non_billable, 'Customer Work', 10, 'active'),
    (cat_customer_non_billable, 'Complimentary Hours', 11, 'active'),
    (cat_customer_non_billable, 'Product/Solution/Framework Development', 12, 'active')
  ON CONFLICT (type_name) DO NOTHING;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260817_create_company_categories.sql ==================
-- =============================================================================
-- Company Categories — mapping table recording which companies adopted
-- which default category (provenance bookkeeping), plus custom categories
-- a company creates itself (default_category_id NULL in that case).
--
-- Does NOT replace service_categories as the physical row every report/
-- dashboard/timesheet query reads — this table exists alongside it. See
-- companyService.js (seeding) and serviceCategoryService.js (custom
-- category creation) for how rows land here.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS company_categories CASCADE;
CREATE TABLE company_categories (
  id SERIAL PRIMARY KEY,
  company_id INT NOT NULL REFERENCES companies (id),
  default_category_id INT REFERENCES default_categories (id),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_categories_company_default
  ON company_categories (company_id, default_category_id)
  WHERE default_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_categories_company_id ON company_categories (company_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260818_create_company_types.sql ==================
-- =============================================================================
-- Company Types — mapping table recording which companies adopted which
-- default type (provenance bookkeeping), plus custom types a company
-- creates itself (default_type_id NULL in that case). Linked to
-- company_categories (not directly to companies) per the requested schema —
-- a company type always belongs to one of that same company's category
-- mappings.
--
-- Does NOT replace service_types as the physical row every report/
-- dashboard/timesheet/import query reads — this table exists alongside it.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS company_types CASCADE;
CREATE TABLE company_types (
  id SERIAL PRIMARY KEY,
  company_category_id INT NOT NULL REFERENCES company_categories (id),
  default_type_id INT REFERENCES default_types (id),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_types_category_default
  ON company_types (company_category_id, default_type_id)
  WHERE default_type_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_company_types_company_category_id ON company_types (company_category_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260819_add_service_types_is_deleted.sql ==================
-- =============================================================================
-- Missing-migration fix: service_types.is_deleted.
--
-- src/models/ServiceType.js has declared this column all along, and the
-- application reads/writes it constantly (serviceTypeRepository.js's
-- findAll/findById/findByName/softDelete, reportRepository.js's PO/resource
-- report joins, serviceTypeService.js's create path) — but no tracked
-- migration or database/schema.sql ever added it to the database. Every
-- environment that has worked so far only did so because this column was
-- added out-of-band (the same drift pattern already documented in
-- 20260803_ensure_service_categories_schema.sql for service_categories and
-- 20260730_add_employee_password.sql for employees.email_id).
--
-- Discovered by actually running every migration against a genuinely empty
-- database: 20260819_backfill_company_category_type_mappings.sql reads
-- service_types.is_deleted and fails outright ("column t.is_deleted does not
-- exist") on any database where the out-of-band add never happened — i.e.
-- every fresh install. Named to sort alphabetically before that file (same
-- date) so it runs first.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE service_types ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260819_backfill_company_category_type_mappings.sql ==================
-- =============================================================================
-- Retroactively establish company_categories/company_types provenance for
-- every existing company's existing service_categories/service_types rows
-- that match a default by name — companies provisioned before this
-- migration never got a mapping row written (that only starts happening
-- going forward via companyService.js/serviceCategoryService.js/
-- serviceTypeService.js). Rows with no matching default name (genuinely
-- custom categories/types a company already created) are left unmapped,
-- exactly as a new custom category/type created after this migration would
-- be (default_*_id NULL) — this bulk pass only needs to backfill the
-- default-sourced ones.
--
-- service_categories/service_types themselves are read-only here — never
-- altered, never re-inserted, no ID ever changes.
--
-- Safe to re-run (ON CONFLICT DO NOTHING on both partial unique indexes).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE
  comp RECORD;
  sc RECORD;
  st RECORD;
  matched_default_category_id INT;
  new_company_category_id INT;
  matched_default_type_id INT;
BEGIN
  FOR comp IN SELECT id FROM companies WHERE is_deleted = false LOOP
    -- One company_categories row per existing service_categories row that
    -- matches a default_categories name.
    FOR sc IN SELECT id, name FROM service_categories WHERE company_id = comp.id AND is_deleted = false LOOP
      SELECT id INTO matched_default_category_id FROM default_categories WHERE category_name = sc.name;

      IF matched_default_category_id IS NOT NULL THEN
        INSERT INTO company_categories (company_id, default_category_id, status, created_at, updated_at)
        VALUES (comp.id, matched_default_category_id, 'active', NOW(), NOW())
        ON CONFLICT (company_id, default_category_id) WHERE default_category_id IS NOT NULL DO NOTHING;
      END IF;
    END LOOP;

    -- One company_types row per existing service_types row that matches a
    -- default_types name — linked to this company's own company_categories
    -- row for that category (resolved by the type's own category name).
    FOR st IN
      SELECT t.id, t.service_type_name, c.name AS category_name
      FROM service_types t
      LEFT JOIN service_categories c ON c.id = t.service_category_id
      WHERE t.company_id = comp.id AND t.is_deleted = false
    LOOP
      SELECT id INTO matched_default_type_id FROM default_types WHERE type_name = st.service_type_name;

      IF matched_default_type_id IS NOT NULL AND st.category_name IS NOT NULL THEN
        SELECT cc.id INTO new_company_category_id
          FROM company_categories cc
          JOIN default_categories dc ON dc.id = cc.default_category_id
          WHERE cc.company_id = comp.id AND dc.category_name = st.category_name
          LIMIT 1;

        IF new_company_category_id IS NOT NULL THEN
          INSERT INTO company_types (company_category_id, default_type_id, status, created_at, updated_at)
          VALUES (new_company_category_id, matched_default_type_id, 'active', NOW(), NOW())
          ON CONFLICT (company_category_id, default_type_id) WHERE default_type_id IS NOT NULL DO NOTHING;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260820_add_head_manager_role.sql ==================
-- =============================================================================
-- Adds the "Head Manager" role for the new Manager Mapping feature (view/
-- map/unmap Managers — see src/routes/managerMapping.routes.js). BU Admin
-- gets identical access with zero extra code: src/middlewares/authorize.js's
-- SUPERUSER_ROLES already bypasses every authorize([...]) check, so gating
-- these routes with authorize(['Head Manager']) alone already satisfies
-- "BU Admin must also be able to view/map/unmap Managers."
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES ('Head Manager', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260821_create_manager_mappings.sql ==================
-- =============================================================================
-- Manager Mapping — a Head Manager (or BU Admin, via the existing
-- authorize.js superuser bypass) maps other Users under themselves as
-- "Managers". Being mapped here is what makes a User a "Manager" in this
-- feature — there is no separate pre-existing "Manager" role a User must
-- already hold (mirrors employee_servicepo_mapping's own pattern of not
-- restricting which Employees can be mapped).
--
-- Duplicate-mapping protection is enforced at the DB level via the unique
-- constraint below (mirrors uq_employee_servicepo_mapping's pattern) —
-- never just an application-level check.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS manager_mappings CASCADE;
CREATE TABLE manager_mappings (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  manager_user_id INT NOT NULL REFERENCES users (id),
  mapped_user_id INT NOT NULL REFERENCES users (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_manager_mappings_not_self CHECK (manager_user_id <> mapped_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_mappings ON manager_mappings (manager_user_id, mapped_user_id);
CREATE INDEX IF NOT EXISTS idx_manager_mappings_company_id ON manager_mappings (company_id);
CREATE INDEX IF NOT EXISTS idx_manager_mappings_manager_user_id ON manager_mappings (manager_user_id);
CREATE INDEX IF NOT EXISTS idx_manager_mappings_mapped_user_id ON manager_mappings (mapped_user_id);

DROP TRIGGER IF EXISTS trg_manager_mappings_updated_at ON manager_mappings;
CREATE TRIGGER trg_manager_mappings_updated_at BEFORE UPDATE ON manager_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260822_create_entities.sql ==================
-- =============================================================================
-- Entity Master — new tenancy tier: Platform Admin -> Entity Admin -> Entity
-- -> Company (BU Admin) -> ... An Entity Admin owns zero or more Entities
-- (entity_admin_user_id, nullable so a freshly-created Entity Admin user
-- starts with none until they create their own via the Entity Master
-- screen — see entityService.js) and every Company must belong to exactly
-- one Entity (see the next 3 migrations for the companies.entity_id
-- retrofit).
--
-- Mirrors companies' own shape (id, code, name, status, is_deleted,
-- created_by/updated_by, timestamps) plus the ownership FK.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS entities CASCADE;
CREATE TABLE entities (
  id SERIAL PRIMARY KEY,
  entity_code VARCHAR(20) NOT NULL,
  entity_name VARCHAR(150) NOT NULL,
  entity_admin_user_id INT REFERENCES users (id),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entities_entity_code ON entities (entity_code);
CREATE INDEX IF NOT EXISTS idx_entities_entity_admin_user_id ON entities (entity_admin_user_id);
CREATE INDEX IF NOT EXISTS idx_entities_status ON entities (status);

DROP TRIGGER IF EXISTS trg_entities_updated_at ON entities;
CREATE TRIGGER trg_entities_updated_at BEFORE UPDATE ON entities
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260823_add_companies_entity_id.sql ==================
-- =============================================================================
-- Phase 1 of 3 for companies.entity_id (mirrors this repo's own company_id
-- retrofit at 20260728/29/30_*.sql): add the column NULLABLE first.
-- 20260824 backfills every existing row onto one platform-wide "Default
-- Entity", then 20260825 cuts over to NOT NULL. Never attempt this as a
-- single migration on a populated table.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS entity_id INT REFERENCES entities (id);
CREATE INDEX IF NOT EXISTS idx_companies_entity_id ON companies (entity_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260824_backfill_companies_entity_id.sql ==================
-- =============================================================================
-- Phase 2 of 3 for companies.entity_id — backfill.
--
-- One platform-wide "Default Entity" is created (unowned —
-- entity_admin_user_id NULL, since Entity Admin is a brand-new role with no
-- existing users to assign it to), and every pre-existing Company with
-- entity_id still NULL is assigned to it. This is a legacy/bridging
-- artifact only — no live Entity Admin workflow depends on it. New
-- Companies going forward must pick a real Entity their own Entity Admin
-- owns (see companyService.createWithAdmin).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO entities (entity_code, entity_name, entity_admin_user_id, status, created_at, updated_at)
VALUES ('DEFAULT-ENTITY', 'Default Entity', NULL, 'active', NOW(), NOW())
ON CONFLICT (entity_code) DO NOTHING;

DO $$
DECLARE
  default_entity_id INT;
BEGIN
  SELECT id INTO default_entity_id FROM entities WHERE entity_code = 'DEFAULT-ENTITY';

  IF default_entity_id IS NULL THEN
    RAISE EXCEPTION 'Default Entity row not found — cannot backfill companies.entity_id.';
  END IF;

  UPDATE companies SET entity_id = default_entity_id WHERE entity_id IS NULL;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260825_companies_entity_id_not_null.sql ==================
-- =============================================================================
-- Phase 3 of 3 for companies.entity_id — cut over to NOT NULL now that every
-- existing row has been backfilled (20260824). Every Company must belong to
-- exactly one Entity from this point forward.
--
-- Guarded: only runs the ALTER once every row already has an entity_id, so
-- this is safe to re-run and safe if applied out of order relative to a
-- delayed 20260824 in some environment.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM companies WHERE entity_id IS NULL) THEN
    ALTER TABLE companies ALTER COLUMN entity_id SET NOT NULL;
  ELSE
    RAISE EXCEPTION 'companies still has rows with a NULL entity_id — run 20260824_backfill_companies_entity_id.sql first.';
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260826_add_entity_admin_role.sql ==================
-- =============================================================================
-- Adds the "Entity Admin" role — sits between Platform Admin and BU Admin.
-- Gated by the new src/middlewares/requireEntityAdmin.js (a direct role-name
-- check, deliberately NOT routed through authorize()'s SUPERUSER_ROLES
-- bypass, which would otherwise wrongly let BU Admin through).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES ('Entity Admin', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260827_add_entity_admin_forms.sql ==================
-- =============================================================================
-- New form_master rows for the two screens Entity Admin is allowed to see —
-- a new "Entity Management" module, distinct from the existing
-- "Administration" module (Roles/Forms/User Role Mapping/Role Form Mapping
-- are company-internal admin screens; Entity Master/BU Admin Master are
-- platform/entity-tier screens Entity Admin needs instead).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO form_master (module_name, form_name, status, created_at, updated_at)
VALUES
  ('Entity Management', 'Entity Master', 'active', NOW(), NOW()),
  ('Entity Management', 'BU Admin Master', 'active', NOW(), NOW())
ON CONFLICT (module_name, form_name) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260828_set_entity_admin_default_form_mapping.sql ==================
-- =============================================================================
-- Default form mapping for the Entity Admin role — mirrors
-- 20260809_set_bu_admin_default_form_mapping.sql's exact pattern: upsert-
-- active exactly the allowed forms, then explicitly deactivate every other
-- form mapping for this role (defends against any future form_master row
-- silently becoming visible to Entity Admin by default).
--
-- Entity Admin must see ONLY Entity Master + BU Admin Master — nothing
-- else (no User Master, Employee, Work Log, Timesheets, Reports,
-- Dashboard, Service PO, Monthly Cost, Role Master, Form Master, or any
-- other admin functionality).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT
  (SELECT id FROM roles WHERE role_name = 'Entity Admin'),
  fm.id,
  true,
  NOW(),
  NOW()
FROM form_master fm
WHERE (fm.module_name, fm.form_name) IN (
  ('Entity Management', 'Entity Master'),
  ('Entity Management', 'BU Admin Master')
)
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND role_id = (SELECT id FROM roles WHERE role_name = 'Entity Admin')
  AND form_id IN (
    SELECT fm.id FROM form_master fm
    WHERE (fm.module_name, fm.form_name) NOT IN (
      ('Entity Management', 'Entity Master'),
      ('Entity Management', 'BU Admin Master')
    )
  );

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260829_drop_manager_mappings.sql ==================
-- =============================================================================
-- Drops the manager_mappings table — the flat "any User maps any other
-- User under themselves" design built earlier turned out not to match the
-- real requirement (a strict BU Admin -> Head Manager -> Manager ->
-- Employee/ServicePO delegation chain). Replaced by head_manager_mappings,
-- manager_employee_mappings, and manager_servicepo_mappings (see the
-- following migrations). The one existing row at drop time has no valid
-- translation into the new model.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TRIGGER IF EXISTS trg_manager_mappings_updated_at ON manager_mappings;
DROP TABLE IF EXISTS manager_mappings;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260830_add_manager_and_bu_hr_head_roles.sql ==================
-- =============================================================================
-- Adds the "Manager" and "BU HR Head" roles — completes the hierarchy
-- Platform Admin -> Entity Admin -> BU Admin -> BU HR Head / Head Manager
-- -> Manager -> Employee ("Head Manager" was already seeded — see
-- 20260820_add_head_manager_role.sql). BU Admin creates users holding
-- these two plus Head Manager (see userService.js's new role restriction);
-- BU HR Head has no further backend behavior defined by this feature.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO roles (role_name, permission, status, created_at, updated_at)
VALUES
  ('Manager', 'Read & Write', 'active', NOW(), NOW()),
  ('BU HR Head', 'Read & Write', 'active', NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260831_create_head_manager_mappings.sql ==================
-- [bootstrap patch] head_manager_mappings is renamed to team_mappings later
-- (20260844_rename_head_manager_mappings_to_team_mappings.sql), so the DROP-then-CREATE
-- conversion below only ever drops/recreates it under its ORIGINAL name. On a second run
-- of this script against an already-bootstrapped database, team_mappings (the renamed-to
-- name) still exists from the first run and blocks that later RENAME TO with
-- "relation team_mappings already exists". Drop it here too so a full reset is clean.
DROP TABLE IF EXISTS team_mappings CASCADE;
-- =============================================================================
-- Head Manager Mapping — BU Admin's grant of a Manager to a Head Manager.
-- Replaces the old flat manager_mappings table (see 20260829). A Manager
-- belongs to EXACTLY ONE Head Manager at a time — enforced with a unique
-- index on manager_user_id ALONE (not the pair), unlike a typical
-- many-to-many junction table.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS head_manager_mappings CASCADE;
CREATE TABLE head_manager_mappings (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  head_manager_user_id INT NOT NULL REFERENCES users (id),
  manager_user_id INT NOT NULL REFERENCES users (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_head_manager_mappings_not_self CHECK (head_manager_user_id <> manager_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_head_manager_mappings_manager ON head_manager_mappings (manager_user_id);
CREATE INDEX IF NOT EXISTS idx_head_manager_mappings_head_manager_user_id ON head_manager_mappings (head_manager_user_id);
CREATE INDEX IF NOT EXISTS idx_head_manager_mappings_company_id ON head_manager_mappings (company_id);

DROP TRIGGER IF EXISTS trg_head_manager_mappings_updated_at ON head_manager_mappings;
CREATE TRIGGER trg_head_manager_mappings_updated_at BEFORE UPDATE ON head_manager_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260832_create_manager_employee_mappings.sql ==================
-- =============================================================================
-- Manager Employee Mapping — a Head Manager's grant of an Employee to one
-- of their own Managers. An Employee belongs to EXACTLY ONE Manager at a
-- time — enforced with a unique index on employee_id ALONE (same pattern
-- as head_manager_mappings' manager_user_id uniqueness).
--
-- No pre-existing Employee->Manager relationship exists anywhere in this
-- schema (confirmed: employees has no manager_id) — this is entirely new.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS manager_employee_mappings CASCADE;
CREATE TABLE manager_employee_mappings (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  manager_user_id INT NOT NULL REFERENCES users (id),
  employee_id INT NOT NULL REFERENCES employees (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_employee_mappings_employee ON manager_employee_mappings (employee_id);
CREATE INDEX IF NOT EXISTS idx_manager_employee_mappings_manager_user_id ON manager_employee_mappings (manager_user_id);
CREATE INDEX IF NOT EXISTS idx_manager_employee_mappings_company_id ON manager_employee_mappings (company_id);

DROP TRIGGER IF EXISTS trg_manager_employee_mappings_updated_at ON manager_employee_mappings;
CREATE TRIGGER trg_manager_employee_mappings_updated_at BEFORE UPDATE ON manager_employee_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260833_create_manager_servicepo_mappings.sql ==================
-- =============================================================================
-- Manager Service PO Mapping — a Head Manager's grant of a Service PO to
-- one of their own Managers. Many-to-many (unlike the two mapping tables
-- above) — a Manager can be granted several Service POs, and the same
-- Service PO can be granted to several Managers; only exact-duplicate
-- grants are prevented.
--
-- This grant is a CASCADING RESTRICTION, not just informational: when a
-- Manager later assigns a Service PO to one of their own Employees (via
-- the existing employee_servicepo_mapping table/flow), the chosen Service
-- PO must already appear here for that Manager (see
-- managerSelfServiceService.js).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS manager_servicepo_mappings CASCADE;
CREATE TABLE manager_servicepo_mappings (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  manager_user_id INT NOT NULL REFERENCES users (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_servicepo_mappings ON manager_servicepo_mappings (manager_user_id, service_po_id);
CREATE INDEX IF NOT EXISTS idx_manager_servicepo_mappings_company_id ON manager_servicepo_mappings (company_id);

DROP TRIGGER IF EXISTS trg_manager_servicepo_mappings_updated_at ON manager_servicepo_mappings;
CREATE TRIGGER trg_manager_servicepo_mappings_updated_at BEFORE UPDATE ON manager_servicepo_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260834_add_role_hierarchy_columns.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 1: role hierarchy columns.
--
-- Adds the three columns the new permission-inheritance engine needs on
-- `roles`:
--   - hierarchy_rank: 1 (Platform Admin) .. 8 (Employee) for the admin chain;
--     NULL for roles outside the chain (HR is a parallel branch).
--   - inherits_role_id: self-referencing FK — "this role's users also get
--     every capability granted to the referenced role." Only set for the
--     two edges the spec actually states (Service PO Admin <- Manager,
--     Project Admin <- Service PO Admin); every other role's capability
--     list is self-contained, so this stays NULL for them.
--   - is_system: true for the 9 seeded roles this redesign defines — blocks
--     deletion/rename via the dynamic Role CRUD (src/services/roleService.js).
--
-- See 20260836_seed_target_roles_and_capabilities.sql for the actual values.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE roles ADD COLUMN IF NOT EXISTS hierarchy_rank SMALLINT;
ALTER TABLE roles ADD COLUMN IF NOT EXISTS inherits_role_id INT REFERENCES roles (id);
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_roles_hierarchy_rank ON roles (hierarchy_rank);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260835_create_role_capabilities.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 2: role_capabilities.
--
-- Fine-grained business-action grants per role (e.g. 'bu.create_client',
-- 'servicepo.manage_team', 'manager.approve_timesheets'), replacing every
-- scattered ad hoc role-name string check in the codebase
-- (authorize.js's SUPERUSER_ROLES bypass, requireEntityAdmin.js's hardcoded
-- check, userService.js's BU_ADMIN_CREATABLE_ROLES array, etc.) with one
-- data-driven grant table. Combined with roles.inherits_role_id (see
-- 20260834), src/services/roleHierarchyService.js walks this table to
-- compute a role's *effective* capabilities — this table only ever holds
-- a role's OWN directly-granted capabilities, never a duplicated/inherited
-- copy.
--
-- Distinct from form_master/role_form_mapping, which is UI form-visibility
-- (unrelated to backend authorization) and is not inherited — see
-- 20260845_reseed_form_master_and_role_form_mapping.sql.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS role_capabilities CASCADE;
CREATE TABLE role_capabilities (
  role_id INT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  capability_key VARCHAR(60) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, capability_key)
);

CREATE INDEX IF NOT EXISTS idx_role_capabilities_role_id ON role_capabilities (role_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260836_seed_target_roles_and_capabilities.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 3: seed the 9 target roles + their capabilities.
--
-- Target hierarchy (see plan doc):
--   Platform Admin -> Admin -> Entity Admin -> BU Admin -> Project Admin ->
--   Service PO Admin -> Manager -> Employee, with HR as a parallel branch
--   (hierarchy_rank NULL — not part of the numeric admin chain).
--
-- 'Admin', 'Project Admin', 'Service PO Admin', and 'Employee' are brand
-- new role rows (no such roles existed before this redesign). 'Platform
-- Admin', 'Entity Admin', 'BU Admin', 'Manager', 'HR' already exist and are
-- only updated here (rank/inheritance/is_system flag).
--
-- inherits_role_id is set ONLY for the two edges the spec explicitly states
-- ("Service PO Admin inherits every permission available to Manager",
-- "Project Admin inherits every permission available to Service PO Admin").
-- Every other role's capability list (below) is deliberately self-contained
-- per its own "ROLE RESPONSIBILITIES" section in the spec — no invented
-- inheritance for BU Admin/Entity Admin/Admin/Platform Admin.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO roles (role_name, permission, status, is_system, created_at, updated_at)
VALUES
  ('Platform Admin',    'Read & Write', 'active', true, NOW(), NOW()),
  ('Admin',             'Read & Write', 'active', true, NOW(), NOW()),
  ('Entity Admin',       'Read & Write', 'active', true, NOW(), NOW()),
  ('BU Admin',          'Read & Write', 'active', true, NOW(), NOW()),
  ('Project Admin',      'Read & Write', 'active', true, NOW(), NOW()),
  ('Service PO Admin',   'Read & Write', 'active', true, NOW(), NOW()),
  ('Manager',           'Read & Write', 'active', true, NOW(), NOW()),
  ('Employee',          'Read',         'active', true, NOW(), NOW()),
  ('HR',                'Read & Write', 'active', true, NOW(), NOW())
ON CONFLICT (role_name) DO UPDATE SET is_system = true, status = 'active';

-- Rank + inheritance edges (order matters: Manager before Service PO Admin
-- before Project Admin, since each later UPDATE looks up the previous one's id).
UPDATE roles SET hierarchy_rank = 1, inherits_role_id = NULL WHERE role_name = 'Platform Admin';
UPDATE roles SET hierarchy_rank = 2, inherits_role_id = NULL WHERE role_name = 'Admin';
UPDATE roles SET hierarchy_rank = 3, inherits_role_id = NULL WHERE role_name = 'Entity Admin';
UPDATE roles SET hierarchy_rank = 4, inherits_role_id = NULL WHERE role_name = 'BU Admin';
UPDATE roles SET hierarchy_rank = 7, inherits_role_id = NULL WHERE role_name = 'Manager';
UPDATE roles SET hierarchy_rank = 6, inherits_role_id = (SELECT id FROM roles WHERE role_name = 'Manager')
  WHERE role_name = 'Service PO Admin';
UPDATE roles SET hierarchy_rank = 5, inherits_role_id = (SELECT id FROM roles WHERE role_name = 'Service PO Admin')
  WHERE role_name = 'Project Admin';
UPDATE roles SET hierarchy_rank = 8, inherits_role_id = NULL WHERE role_name = 'Employee';
UPDATE roles SET hierarchy_rank = NULL, inherits_role_id = NULL WHERE role_name = 'HR';

-- Capability grants — one row per bullet in the spec's ROLE RESPONSIBILITIES
-- section. Inherited capabilities (e.g. Manager's onto Service PO Admin) are
-- NEVER duplicated here — src/services/roleHierarchyService.js computes
-- those at read time by walking inherits_role_id.
INSERT INTO role_capabilities (role_id, capability_key)
SELECT r.id, g.capability_key
FROM (VALUES
  ('Platform Admin', 'platform.create_admin'),
  ('Platform Admin', 'platform.manage_role_master'),
  ('Platform Admin', 'platform.manage_form_master'),
  ('Platform Admin', 'platform.manage_platform'),

  ('Admin', 'admin.create_entity_admin'),
  ('Admin', 'admin.create_bu_admin'),
  ('Admin', 'admin.view_entity_admins'),
  ('Admin', 'admin.view_bu_admins'),
  ('Admin', 'admin.manage_entity_admins'),
  ('Admin', 'admin.manage_bu_admins'),

  ('Entity Admin', 'entity.view_bu_admins'),
  ('Entity Admin', 'entity.create_bu_admin'),
  ('Entity Admin', 'entity.view_mapped_employees'),
  ('Entity Admin', 'entity.approve_timesheets'),

  ('BU Admin', 'bu.manage_projects'),
  ('BU Admin', 'bu.create_client'),
  ('BU Admin', 'bu.create_project_admin'),
  ('BU Admin', 'bu.create_servicepo_admin'),
  ('BU Admin', 'bu.view_mapped_employees'),
  ('BU Admin', 'bu.approve_timesheets'),

  ('Project Admin', 'project.manage_servicepos'),
  ('Project Admin', 'project.create_servicepo_admin'),
  ('Project Admin', 'project.view_mapped_employees'),
  ('Project Admin', 'project.approve_timesheets'),

  ('Service PO Admin', 'servicepo.manage_team'),
  ('Service PO Admin', 'servicepo.manage_team_mapping'),
  ('Service PO Admin', 'servicepo.manage_future_budget'),
  ('Service PO Admin', 'servicepo.view_mapped_employees'),
  ('Service PO Admin', 'servicepo.approve_timesheets'),

  ('Manager', 'manager.view_mapped_employees'),
  ('Manager', 'manager.map_employees'),
  ('Manager', 'manager.map_servicepos'),
  ('Manager', 'manager.approve_timesheets'),

  ('Employee', 'employee.view_timesheet'),
  ('Employee', 'employee.fill_worklog'),
  ('Employee', 'employee.view_reports'),

  ('HR', 'hr.create_employee'),
  ('HR', 'hr.manage_employee'),
  ('HR', 'hr.manage_employee_timesheets')
) AS g(role_name, capability_key)
JOIN roles r ON r.role_name = g.role_name
ON CONFLICT (role_id, capability_key) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260837_create_role_migration_log.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 4: role_migration_log.
--
-- Audit trail for every user whose role changed as a direct side effect of
-- this redesign (legacy-role remap, and the user_roles->users.role_id
-- collapse) — so ops can review post-deploy who moved where instead of the
-- remap being a silent, unreviewable UPDATE. Never written to outside this
-- redesign's migrations.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS role_migration_log CASCADE;
CREATE TABLE role_migration_log (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id),
  old_role_name VARCHAR(50) NOT NULL,
  new_role_name VARCHAR(50) NOT NULL,
  reason VARCHAR(255),
  migrated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_role_migration_log_user_id ON role_migration_log (user_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260838_remap_legacy_roles.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 5: remap holders of obsolete roles onto the nearest
-- new role, per the user's explicit decision (do not orphan existing
-- accounts — remap instead of drop).
--
--   Super Admin      -> Admin              (broad, near-platform-wide operational scope)
--   Head Manager     -> Service PO Admin   (Service PO Admin now owns the Manager "team")
--   BU HR Head       -> HR                 (both are HR-flavored at the BU tier)
--   Division Head    -> BU Admin           ("Division" ~ Business Unit)
--   Project Manager  -> Project Admin      (direct name match)
--   Management       -> Admin              (generic senior-oversight role)
--   Finance          -> Employee           (no equivalent in the new hierarchy;
--                                            least-privilege fallback — flagged
--                                            in role_migration_log for manual review)
--
-- Every remapped user is logged to role_migration_log BEFORE the update, so
-- ops can review exactly who moved where. The pre-existing 'HR' role (id 1
-- historically) is NOT remapped — it keeps its name; only its capabilities/
-- forms are redefined (see 20260836 and 20260845).
--
-- Must run AFTER 20260836 (target roles must already exist) and BEFORE
-- 20260839 (which deletes the obsolete role rows this migration reads from).
--
-- Safe to re-run: once a user's role_id has been moved off the obsolete
-- role, the WHERE role_id = v_old_id clause matches nothing on a second run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE
  v_old_id INT;
  v_new_id INT;
  v_pair RECORD;
BEGIN
  FOR v_pair IN
    SELECT * FROM (VALUES
      ('Super Admin',     'Admin'),
      ('Head Manager',    'Service PO Admin'),
      ('BU HR Head',      'HR'),
      ('Division Head',   'BU Admin'),
      ('Project Manager', 'Project Admin'),
      ('Management',      'Admin'),
      ('Finance',         'Employee')
    ) AS t(old_role_name, new_role_name)
  LOOP
    SELECT id INTO v_old_id FROM roles WHERE role_name = v_pair.old_role_name;
    SELECT id INTO v_new_id FROM roles WHERE role_name = v_pair.new_role_name;

    IF v_old_id IS NOT NULL AND v_new_id IS NOT NULL THEN
      INSERT INTO role_migration_log (user_id, old_role_name, new_role_name, reason)
      SELECT id, v_pair.old_role_name, v_pair.new_role_name, 'RBAC redesign legacy-role remap'
      FROM users
      WHERE role_id = v_old_id;

      UPDATE users SET role_id = v_new_id, updated_at = NOW() WHERE role_id = v_old_id;
    END IF;
  END LOOP;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260839_drop_obsolete_roles.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 6: remove roles that no longer exist in the new
-- hierarchy. Must run AFTER 20260838 (every holder has already been
-- remapped off these roles). role_form_mapping and user_roles rows for
-- these roles cascade-delete automatically (both FKs are ON DELETE CASCADE);
-- users.role_id is ON DELETE SET NULL, so any user missed by the remap
-- (there should be none) becomes roleless rather than erroring, and would
-- show up immediately via a failed authenticate() check post-deploy.
--
-- Safe to re-run (DELETE ... WHERE role_name IN (...) is a no-op once gone).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DELETE FROM roles
WHERE role_name IN ('Super Admin', 'Head Manager', 'BU HR Head', 'Division Head', 'Project Manager', 'Management', 'Finance');

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260840_collapse_user_roles.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 7: collapse dual role storage.
--
-- Today a user's role is stored twice — the single `users.role_id` FK and
-- the many-to-many `user_roles` table — with nothing indicating which is
-- authoritative (confirmed divergent in practice: user 1 holds different
-- role sets depending which one you read). The new hierarchy is strictly
-- one-role-per-user, so `users.role_id` becomes the SOLE source of truth.
--
-- Any user_roles row that names a role OTHER than the user's current
-- `role_id` is a discarded secondary role — logged to role_migration_log
-- for review before the table is dropped, not silently lost.
--
-- Safe to re-run: once user_roles is dropped, the SELECT/INSERT and the
-- DROP TABLE both become no-ops.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_roles') THEN
    INSERT INTO role_migration_log (user_id, old_role_name, new_role_name, reason)
    SELECT ur.user_id, r.role_name, COALESCE(pr.role_name, '(none)'),
      'user_roles secondary role discarded — users.role_id is now the sole source of truth'
    FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    JOIN users u ON u.id = ur.user_id
    LEFT JOIN roles pr ON pr.id = u.role_id
    WHERE ur.role_id IS DISTINCT FROM u.role_id;
  END IF;
END $$;

DROP TABLE IF EXISTS user_roles;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260841_drop_users_is_platform_admin.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 8: drop users.is_platform_admin.
--
-- This boolean was a THIRD, independent gating signal alongside role names
-- (see requireEntityAdmin.js's hardcoded string check and authorize.js's
-- SUPERUSER_ROLES bypass) — now fully superseded by `roles.hierarchy_rank = 1`
-- (Platform Admin), the single source of truth going forward.
--
-- Also adds a partial unique index enforcing "at most one User per
-- Employee" — the new Employee-creation flow always creates exactly one
-- linked User, and nothing else should ever create a second.
--
-- Pre-existing duplicate employee_id links (found in practice — two
-- different User accounts pointed at the same Employee row) are resolved
-- first, deterministically: for each duplicated employee_id, keep the link
-- on the HR-role user if one of the duplicates holds that role (matches the
-- decision made for the first such case found), else keep the earliest-
-- created user; every other duplicate has its employee_id cleared (it
-- remains a perfectly normal admin-tier User account with no linked
-- Employee). Each clear is logged via RAISE NOTICE so it's visible in the
-- deploy log, not silent.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS is_platform_admin;

DO $$
DECLARE
  v_emp INT;
  v_keep_id INT;
  v_cleared RECORD;
BEGIN
  FOR v_emp IN
    SELECT employee_id FROM users WHERE employee_id IS NOT NULL GROUP BY employee_id HAVING COUNT(*) > 1
  LOOP
    SELECT u.id INTO v_keep_id
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    WHERE u.employee_id = v_emp
    ORDER BY (r.role_name = 'HR') DESC, u.created_at ASC
    LIMIT 1;

    FOR v_cleared IN
      SELECT id, email FROM users WHERE employee_id = v_emp AND id <> v_keep_id
    LOOP
      RAISE NOTICE 'RBAC redesign: clearing duplicate employee_id % link on user % (%) — keeping user %',
        v_emp, v_cleared.id, v_cleared.email, v_keep_id;
      UPDATE users SET employee_id = NULL, updated_at = NOW() WHERE id = v_cleared.id;
    END LOOP;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_employee_id ON users (employee_id) WHERE employee_id IS NOT NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260842_employees_drop_login_columns.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 9: Employee becomes pure business data.
--
-- Employees no longer authenticate directly — login happens only through
-- User Master (see Stage 2). Drops the Employee-direct-login columns
-- (`password`, `email_id`) and their supporting indexes/constraints, and
-- drops `employee_sessions` (the refresh-token store for the old
-- Employee-direct-login JWT audience, now unused since employeeAuth.js /
-- the employee JWT audience are removed in Stage 2).
--
-- `idx_employees_email_active` and `employees_email_id_key` were added
-- out-of-band against the live DB (never created by a tracked migration —
-- see analysis notes), so both are dropped defensively with IF EXISTS
-- rather than assumed absent.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP INDEX IF EXISTS idx_employees_email_active;
DROP INDEX IF EXISTS idx_employees_email_id;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_email_id_key;
ALTER TABLE employees DROP COLUMN IF EXISTS email_id;
ALTER TABLE employees DROP COLUMN IF EXISTS password;

DROP TABLE IF EXISTS employee_sessions;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260843_manager_employee_mappings_add_type.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 10: Primary/Secondary Manager support.
--
-- HR must be able to assign a mandatory Primary Manager and an optional
-- Secondary Manager per Employee at creation time (see Stage 3). Replaces
-- the old "exactly one Manager per Employee" invariant (single-column
-- unique index on employee_id) with "exactly one PRIMARY and at most one
-- SECONDARY Manager per Employee" (composite unique on employee_id +
-- mapping_type). Manager's own self-service "Map Employees" action
-- (src/services/managerEmployeeMappingService.js, Stage 3) reuses this same
-- table/column rather than a separate mechanism.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE manager_employee_mappings
  ADD COLUMN IF NOT EXISTS mapping_type VARCHAR(10) NOT NULL DEFAULT 'PRIMARY'
  CHECK (mapping_type IN ('PRIMARY', 'SECONDARY'));

DROP INDEX IF EXISTS uq_manager_employee_mappings_employee;

CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_employee_mappings_employee_type
  ON manager_employee_mappings (employee_id, mapping_type);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260844_rename_head_manager_mappings_to_team_mappings.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 11: Head Manager -> Service PO Admin.
--
-- The "Head Manager" role is removed (see 20260838/20260839) — Service PO
-- Admin now directly owns/creates Manager accounts and the team they
-- manage. Repurposes the existing head_manager_mappings table (BU
-- Admin -> Head Manager -> Manager delegation) into team_mappings
-- (Service PO Admin -> Manager, one hop shorter), keeping its exact
-- 1-Head-Manager-per-... err, 1-Service-PO-Admin-per-Manager cardinality
-- (unique index on manager_user_id alone).
--
-- Wrapped in existence-checking DO blocks so this is safe to re-run even
-- after the rename has already happened once (plain RENAME statements
-- would otherwise error the second time, since Postgres 14 doesn't support
-- `RENAME COLUMN/CONSTRAINT IF EXISTS`).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'head_manager_mappings') THEN
    ALTER TABLE head_manager_mappings RENAME TO team_mappings;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'team_mappings' AND column_name = 'head_manager_user_id'
  ) THEN
    ALTER TABLE team_mappings RENAME COLUMN head_manager_user_id TO service_po_admin_user_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_head_manager_mappings_not_self'
  ) THEN
    ALTER TABLE team_mappings RENAME CONSTRAINT chk_head_manager_mappings_not_self TO chk_team_mappings_not_self;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'uq_head_manager_mappings_manager') THEN
    ALTER INDEX uq_head_manager_mappings_manager RENAME TO uq_team_mappings_manager;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_head_manager_mappings_head_manager_user_id') THEN
    ALTER INDEX idx_head_manager_mappings_head_manager_user_id RENAME TO idx_team_mappings_service_po_admin_user_id;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'idx_head_manager_mappings_company_id') THEN
    ALTER INDEX idx_head_manager_mappings_company_id RENAME TO idx_team_mappings_company_id;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_head_manager_mappings_updated_at ON team_mappings;
DROP TRIGGER IF EXISTS trg_team_mappings_updated_at ON team_mappings;
CREATE TRIGGER trg_team_mappings_updated_at BEFORE UPDATE ON team_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260845_reseed_form_master_and_role_form_mapping.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 12: Form Master reseed.
--
-- Form-visibility mapping per the spec's FORM MASTER section. Unlike the
-- capability engine (role_capabilities/roleHierarchyService — Stage 2),
-- this layer is NOT inherited: every role's form list below is exactly and
-- only what the spec lists for that role, taken verbatim. Platform Admin is
-- deliberately excluded — "All Forms" is implemented as an implicit bypass
-- in the forms-resolution query (hierarchy_rank = 1 ⇒ every active form),
-- not stored rows, so it never needs reseeding when a new form is added.
--
-- Pre-existing forms (Dashboard, AI Insights, old Employees/Users/Clients/
-- Service POs/Timesheets/Monthly Costs/Reports screens, Roles, Forms, User
-- Role Mapping, Role Form Mapping) are left untouched in form_master —
-- Platform Admin's bypass still needs them to exist and stay active. Only
-- role_form_mapping rows for the 8 non-Platform-Admin target roles are
-- reset here.
--
-- Safe to re-run (reset-then-insert every time).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO form_master (module_name, form_name, status, created_at, updated_at)
VALUES
  ('Entity Management', 'Entity Admin Master',     'active', NOW(), NOW()),
  ('Administration',    'Project Admin Master',    'active', NOW(), NOW()),
  ('Administration',    'Service PO Admin Master', 'active', NOW(), NOW()),
  ('Administration',    'Team Management',         'active', NOW(), NOW()),
  ('People',             'Employee List',           'active', NOW(), NOW()),
  ('People',             'Employee Mapping',        'active', NOW(), NOW()),
  ('People',             'Employee Master',         'active', NOW(), NOW()),
  ('Business',           'Client Master',           'active', NOW(), NOW()),
  ('Business',           'Project Master',          'active', NOW(), NOW()),
  ('Business',           'Service PO Master',       'active', NOW(), NOW()),
  ('Business',           'Service PO Mapping',      'active', NOW(), NOW()),
  ('Resources',          'Timesheet',               'active', NOW(), NOW()),
  ('Resources',          'Timesheet Approval',      'active', NOW(), NOW()),
  ('Reports',            'Reports',                 'active', NOW(), NOW())
ON CONFLICT (module_name, form_name) DO NOTHING;
-- 'Entity Master' and 'BU Admin Master' (module 'Entity Management') already
-- exist as of 20260827_add_entity_admin_forms.sql.

-- Reset every existing mapping for the 8 target roles that DO store rows
-- (Platform Admin is excluded — see header comment).
UPDATE role_form_mapping
SET status = false, updated_at = NOW()
WHERE status = true
  AND role_id IN (
    SELECT id FROM roles WHERE role_name IN
      ('Admin', 'Entity Admin', 'BU Admin', 'Project Admin', 'Service PO Admin', 'Manager', 'Employee', 'HR')
  );

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT r.id, fm.id, true, NOW(), NOW()
FROM (VALUES
  ('Admin', 'Entity Management', 'Entity Admin Master'),
  ('Admin', 'Entity Management', 'BU Admin Master'),

  ('Entity Admin', 'Entity Management', 'Entity Master'),
  ('Entity Admin', 'Entity Management', 'BU Admin Master'),
  ('Entity Admin', 'People', 'Employee List'),
  ('Entity Admin', 'Resources', 'Timesheet Approval'),

  ('BU Admin', 'Business', 'Client Master'),
  ('BU Admin', 'Business', 'Project Master'),
  ('BU Admin', 'Administration', 'Project Admin Master'),
  ('BU Admin', 'Administration', 'Service PO Admin Master'),
  ('BU Admin', 'People', 'Employee List'),
  ('BU Admin', 'Resources', 'Timesheet Approval'),

  ('Project Admin', 'Business', 'Project Master'),
  ('Project Admin', 'Business', 'Service PO Master'),
  ('Project Admin', 'Administration', 'Service PO Admin Master'),
  ('Project Admin', 'People', 'Employee List'),
  ('Project Admin', 'Resources', 'Timesheet Approval'),

  ('Service PO Admin', 'Administration', 'Team Management'),
  ('Service PO Admin', 'People', 'Employee List'),
  ('Service PO Admin', 'Resources', 'Timesheet Approval'),

  ('Manager', 'People', 'Employee Mapping'),
  ('Manager', 'Business', 'Service PO Mapping'),
  ('Manager', 'Resources', 'Timesheet Approval'),

  ('Employee', 'Resources', 'Timesheet'),
  ('Employee', 'Reports', 'Reports'),

  ('HR', 'People', 'Employee Master'),
  ('HR', 'Resources', 'Timesheet')
) AS grant_row(role_name, module_name, form_name)
JOIN roles r ON r.role_name = grant_row.role_name
JOIN form_master fm ON fm.module_name = grant_row.module_name AND fm.form_name = grant_row.form_name
ON CONFLICT (role_id, form_id) DO UPDATE SET status = true, updated_at = NOW();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260846_drop_unreferenced_legacy_roles.sql ==================
-- =============================================================================
-- RBAC Redesign — Phase 13: drop leftover unreferenced role rows.
--
-- Found during migration dry-run: 'Team Head' and 'test' role rows exist in
-- some environments (added out-of-band, like several other things flagged
-- during this redesign's analysis — never created by any tracked migration
-- or seed file) but hold zero users. They conflict with the new 9-role
-- hierarchy and have no holders to remap, so they're removed outright
-- rather than run through the remap machinery in 20260838.
--
-- Guarded by a zero-holders check so this is a no-op (does nothing, doesn't
-- error) if some environment turns out to have a real user on one of these
-- — that would need a manual remap decision instead, the same as any other
-- role this redesign didn't already know to plan for.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DELETE FROM roles
WHERE role_name IN ('Team Head', 'test')
  AND id NOT IN (SELECT DISTINCT role_id FROM users WHERE role_id IS NOT NULL);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260847_drop_users_company_id_default.sql ==================
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

-- [bootstrap] stripped: BEGIN;

ALTER TABLE users ALTER COLUMN company_id DROP DEFAULT;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260848_add_projects_client_id.sql ==================
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

-- [bootstrap] stripped: BEGIN;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS client_id INT REFERENCES clients (id);

CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects (client_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260849_add_service_pos_delivery_head.sql ==================
-- =============================================================================
-- Client -> Project -> Service PO -> Delivery Head — Phase 2: Service PO
-- gets a Delivery Head.
--
-- delivery_head_employee_id references employees(id) — the Employee
-- Master ID, NOT a User Master ID (Delivery Head is a business/staffing
-- attribute of the Service PO, unrelated to login/RBAC identity).
--
-- Nullable at the DB level: existing Service POs created before this
-- feature have no Delivery Head and must not break (see
-- src/services/servicePOService.js — Delivery Head is required by Joi
-- only on CREATE, optional on UPDATE, so a pre-existing PO can have one
-- added later without being forced through unrelated-field validation).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE service_pos
  ADD COLUMN IF NOT EXISTS delivery_head_employee_id INT REFERENCES employees (id);

CREATE INDEX IF NOT EXISTS idx_service_pos_delivery_head_employee_id ON service_pos (delivery_head_employee_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260850_add_user_additional_roles.sql ==================
-- =============================================================================
-- User Additional Roles — reintroduces multi-role support, but deliberately
-- NOT as a second authoritative source of truth (that's exactly what caused
-- the divergence bugs that led to dropping the old `user_roles` table — see
-- 20260840_collapse_user_roles.sql). users.role_id remains the SOLE source
-- of truth for hierarchy rank, company/entity scoping, senior-tier admin
-- bypass, and the role-creation matrix — nothing here ever competes with it
-- for those questions.
--
-- This table is a purely ADDITIVE capability grant: zero or more EXTRA
-- operational roles a user holds on top of their primary role, unioned only
-- into effective-capability checks (src/services/roleHierarchyService.js).
-- Restricted at the application layer (src/services/userService.js) to
-- operational roles only (never Platform Admin/Admin/Entity Admin/BU Admin)
-- — a role's hierarchy_rank can't be checked via a DB CHECK constraint
-- without a cross-table trigger, and this codebase has no precedent for
-- business-rule triggers (every existing trigger is a generic updated_at
-- bumper), so the rule lives in application code instead, matching how
-- ROLE_CREATION_MATRIX (a structurally identical rule) is also app-layer-only.
--
-- Named differently from the old, dropped `user_roles` table on purpose —
-- that table was authoritative and caused real bugs; this one never is.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS user_additional_roles CASCADE;
CREATE TABLE user_additional_roles (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_additional_roles_user_role
  ON user_additional_roles (user_id, role_id);

CREATE INDEX IF NOT EXISTS idx_user_additional_roles_user_id
  ON user_additional_roles (user_id);

DROP TRIGGER IF EXISTS trg_user_additional_roles_updated_at ON user_additional_roles;
CREATE TRIGGER trg_user_additional_roles_updated_at BEFORE UPDATE ON user_additional_roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260851_add_employee_timesheet_approval_required.sql ==================
-- =============================================================================
-- Employee-level Timesheet Approval Configuration.
--
-- Generalizes the existing is_publish policy (see src/utils/
-- timesheetPublishPolicy.js) from company-wide to employee-level. Before
-- this migration, whether a NEW timesheet row started is_publish=false
-- ("held back", someone must later explicitly Publish) or is_publish=true
-- (auto-published immediately) was decided ENTIRELY by
-- companies.is_original_data_visible — every employee in a company shared
-- the same behavior. This column makes that decision per-employee instead.
--
-- true  -> this employee's new timesheets start is_publish=false; someone
--          must later explicitly Publish them (the existing, untouched
--          Publish flow — see timesheetService.js's publishImport()).
-- false -> this employee's new timesheets are published immediately.
--
-- companies.is_original_data_visible is UNCHANGED and keeps its own,
-- separate job (a login-response UI hint in authService.js) — it is no
-- longer consulted for the is_publish decision itself after this migration.
--
-- Backfill preserves every EXISTING employee's current effective behavior
-- exactly, mirroring their company's is_original_data_visible at the time
-- of this migration, so no existing employee's timesheet behavior silently
-- changes. New employees created after this migration default to true
-- (require approval) unless the caller explicitly opts out.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS is_timesheet_approval_required BOOLEAN NOT NULL DEFAULT true;

UPDATE employees e
SET is_timesheet_approval_required = COALESCE(c.is_original_data_visible, false)
FROM companies c
WHERE e.company_id = c.id;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260852_add_approved_status_to_employee_work_logs.sql ==================
-- =============================================================================
-- Employee Work Log — add 'approved' status, between 'pending' and 'synced'.
--
-- The approval flow now happens BEFORE Sync, not after: a Manager approves
-- an Employee's pending Work Log entries directly; only once approved (or
-- immediately, for an Employee whose is_timesheet_approval_required is
-- false) can Sync ever pick a row up and turn it into an official
-- `timesheets` row. There was previously no status value representing
-- "Manager approved, not yet synced" — this migration adds it.
--
-- status: 'pending'  -> entered by employee, awaiting approval (or Sync,
--                        if approval isn't required for this employee).
--         'approved'  -> approved (by a Manager, or automatically because
--                        approval isn't required for this employee) but
--                        Sync has not run yet. Eligible for Sync.
--         'synced'    -> included in a completed sync; the corresponding
--                        official record now lives in `timesheets`.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS employee_work_logs_status_check;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT employee_work_logs_status_check
  CHECK (status IN ('pending', 'approved', 'synced'));

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260853_create_service_po_monthly_budgets.sql ==================
-- =============================================================================
-- Service PO Monthly Budget Master — month-wise Invoice Amount / Billed Amount
-- (+ descriptions/remarks) maintained per Service PO by the Service PO
-- Manager. Consumed by GET /api/v1/reports/service-po-summary, which reads
-- invoice_amount/billed_amount from here instead of computing them from
-- timesheets/monthly_costs for the report's selected month/year.
--
-- One row per (service_po_id, month, year) — enforced by the unique
-- constraint below, which the service layer's upsert relies on.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS service_po_monthly_budgets CASCADE;
CREATE TABLE service_po_monthly_budgets (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  invoice_amount DECIMAL(15, 2) NOT NULL DEFAULT 0 CHECK (invoice_amount >= 0),
  invoice_description TEXT,
  billed_amount DECIMAL(15, 2) NOT NULL DEFAULT 0 CHECK (billed_amount >= 0),
  billed_remark TEXT,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_service_po_monthly_budgets_po_month_year
  ON service_po_monthly_budgets (service_po_id, month, year);
CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_service_po_id
  ON service_po_monthly_budgets (service_po_id);
CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_company_id
  ON service_po_monthly_budgets (company_id);
CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_month
  ON service_po_monthly_budgets (month);
CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_year
  ON service_po_monthly_budgets (year);

DROP TRIGGER IF EXISTS trg_service_po_monthly_budgets_updated_at ON service_po_monthly_budgets;
CREATE TRIGGER trg_service_po_monthly_budgets_updated_at BEFORE UPDATE ON service_po_monthly_budgets
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260854_add_service_po_monthly_budgets_company_id.sql ==================
-- =============================================================================
-- Follow-up to 20260853_create_service_po_monthly_budgets.sql — that
-- migration's CREATE TABLE was edited to add `company_id` AFTER it had
-- already been applied on some environments (the migration runner tracks
-- applied files by name, so re-editing an already-applied file is a no-op).
-- This adds the missing column + backfill + index so every environment
-- ends up with the same schema regardless of which version of the CREATE
-- TABLE it originally ran.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE service_po_monthly_budgets
  ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies (id);

UPDATE service_po_monthly_budgets b
SET company_id = sp.company_id
FROM service_pos sp
WHERE sp.id = b.service_po_id
  AND b.company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_service_po_monthly_budgets_company_id
  ON service_po_monthly_budgets (company_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260855_grant_manager_future_budget_capability.sql ==================
-- =============================================================================
-- Grant Manager the servicepo.manage_future_budget capability.
--
-- POST /api/v1/service-po-monthly-budgets (upsert) was gated to
-- 'Service PO Admin' only (see 20260836_seed_target_roles_and_capabilities.sql)
-- — Manager doesn't inherit it (inheritance runs the other way: Service PO
-- Admin inherits Manager, not vice versa), so a Manager mapped to a Service
-- PO (see servicePOMonthlyBudgetService.getAllowedServicePOIds) could view
-- the GET endpoints but got 403 FORBIDDEN on save. BU Admin already bypasses
-- every capability check via the senior-tier rule (hierarchy_rank <= 4, see
-- roleHierarchyService.isSeniorTier) and needs no grant here.
--
-- Looked up by role_name, not role_id — role IDs diverge between
-- environments (see database/README.md's prod/local note).
--
-- Safe to re-run (PRIMARY KEY (role_id, capability_key) + ON CONFLICT).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO role_capabilities (role_id, capability_key)
SELECT id, 'servicepo.manage_future_budget'
FROM roles
WHERE role_name = 'Manager'
ON CONFLICT (role_id, capability_key) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260856_add_form_master_seq_and_modules.sql ==================
-- =============================================================================
-- Form Master — module-as-row + sequence support.
--
-- form_master stays the ONLY table for both modules and forms (no new
-- module_master/modules table). A module is now representable as a
-- form_master row in its own right:
--   module_name = NULL, form_name = <module name>
-- Every existing distinct module_name value gets exactly one such row
-- created here, backfilled with a module-level seq. Every existing child
-- form gets a seq assigned independently within its own module (not a
-- global sequence). Existing form_master ids, and every role_form_mapping
-- row referencing them, are left completely untouched.
--
-- Safe to re-run: the module backfill only inserts a module row that
-- doesn't already exist, and the seq backfill only assigns rows that don't
-- already have one, so a second run is a no-op.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE form_master ALTER COLUMN module_name DROP NOT NULL;
ALTER TABLE form_master ADD COLUMN IF NOT EXISTS seq INTEGER;

-- One module row per existing distinct module_name value, sequenced
-- alphabetically (there is no better existing signal to order modules by).
INSERT INTO form_master (module_name, form_name, status, seq, created_at, updated_at)
SELECT NULL, distinct_modules.module_name, 'active', distinct_modules.rn, NOW(), NOW()
FROM (
  SELECT module_name, ROW_NUMBER() OVER (ORDER BY module_name ASC) AS rn
  FROM (SELECT DISTINCT module_name FROM form_master WHERE module_name IS NOT NULL) AS m
) AS distinct_modules
WHERE NOT EXISTS (
  SELECT 1 FROM form_master existing
  WHERE existing.module_name IS NULL AND existing.form_name = distinct_modules.module_name
);

-- Sequence every existing child form independently within its own module,
-- preserving the (module_name, form_name) ordering the app already sorted
-- by before this column existed.
UPDATE form_master fm
SET seq = ranked.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY module_name ORDER BY form_name ASC, id ASC) AS rn
  FROM form_master
  WHERE module_name IS NOT NULL
) AS ranked
WHERE fm.id = ranked.id AND fm.seq IS NULL;

ALTER TABLE form_master ALTER COLUMN seq SET NOT NULL;

ALTER TABLE form_master DROP CONSTRAINT IF EXISTS chk_form_master_seq_positive;
ALTER TABLE form_master ADD CONSTRAINT chk_form_master_seq_positive CHECK (seq > 0);

-- Module names must be unique among module rows. The existing
-- uq_form_master_module_form constraint (module_name, form_name) already
-- keeps a module's own children unique, but a plain multi-column UNIQUE
-- constraint does not de-duplicate across rows where module_name IS NULL
-- (Postgres treats every NULL as distinct), so module-name uniqueness needs
-- its own partial index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_form_master_module_row_name
  ON form_master (form_name)
  WHERE module_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_form_master_seq ON form_master (seq);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260857_add_refresh_token_rotation.sql ==================
-- =============================================================================
-- Refresh token rotation + replay prevention (security fix).
--
-- user_sessions previously tracked only the raw refresh_token string, with
-- no per-token identifier and no way to distinguish "never existed" from
-- "already consumed" once a session row was hard-deleted on rotation/logout
-- — which also meant an already-rotated token being replayed couldn't be
-- detected (its row was simply gone). This adds:
--   jti              - unique per-issuance identifier, embedded in the
--                      refresh JWT's own `jti` claim (see src/config/jwt.js)
--                      and used as the sole lookup/rotation key going
--                      forward, instead of matching the raw token string.
--   family_id        - shared across every token descended from one login,
--                      so a detected replay can revoke the whole lineage.
--   revoked_at       - rotation/logout now SOFT-revoke (set this) instead
--                      of deleting the row, so a replayed already-consumed
--                      token is recognizable as "reuse", not "unknown".
--   replaced_by_jti  - which token a rotated session was replaced by, for
--                      tracing a family's lineage.
--
-- Existing, already-issued refresh tokens have no `jti` claim (signed
-- before this fix) and cannot be looked up by the new mechanism — they are
-- intentionally treated as invalid after this deploys; affected users
-- simply log in again once their current access token expires. This is an
-- expected, one-time consequence of closing the underlying rotation bug,
-- not a bug in this migration.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS jti VARCHAR(36),
  ADD COLUMN IF NOT EXISTS family_id VARCHAR(36),
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replaced_by_jti VARCHAR(36);

-- Partial unique index: NULL jti (every pre-existing row) is never compared
-- for uniqueness, so backfilling nothing here is safe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_jti
  ON user_sessions (jti) WHERE jti IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_sessions_family_id
  ON user_sessions (family_id);

-- The refresh flow's hot-path lookup: "is there a live, unrevoked session
-- for this jti", i.e. exactly the WHERE clause consumeSession()/
-- findActiveSessionByJti() use in authRepository.js.
CREATE INDEX IF NOT EXISTS idx_user_sessions_jti_revoked_at
  ON user_sessions (jti, revoked_at);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260858_create_cost_budget_master.sql ==================
-- =============================================================================
-- Cost Budget Master — month-wise Invoice Amount (+ description) maintained
-- per Service PO. New, isolated master table; independent of the existing
-- service_po_monthly_budgets table (which already tracks invoice_amount/
-- billed_amount per Service PO + month, but is kept unchanged here per the
-- isolation requirement of this feature).
--
-- One row per (service_po_id, month, year) regardless of status — enforced
-- by the unique constraint below. Deactivating a record (status='inactive')
-- does not free up the (service_po_id, month, year) key for a new row,
-- matching the manager_servicepo_mappings / employee_servicepo_mapping
-- soft-delete convention already used in this project.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS cost_budget_master CASCADE;
CREATE TABLE cost_budget_master (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  invoice_amount DECIMAL(15, 2) NOT NULL DEFAULT 0 CHECK (invoice_amount >= 0),
  description TEXT,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cost_budget_master_po_month_year
  ON cost_budget_master (service_po_id, month, year);
CREATE INDEX IF NOT EXISTS idx_cost_budget_master_service_po_id
  ON cost_budget_master (service_po_id);
CREATE INDEX IF NOT EXISTS idx_cost_budget_master_company_id
  ON cost_budget_master (company_id);
CREATE INDEX IF NOT EXISTS idx_cost_budget_master_month_year
  ON cost_budget_master (month, year);

DROP TRIGGER IF EXISTS trg_cost_budget_master_updated_at ON cost_budget_master;
CREATE TRIGGER trg_cost_budget_master_updated_at BEFORE UPDATE ON cost_budget_master
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260859_create_resource_budget_master.sql ==================
-- =============================================================================
-- Resource Budget Master — planned monthly hours per Employee + Service PO.
-- New, isolated master table. Feeds the 176-hour-per-employee-per-month
-- validation enforced in resourceBudgetService.js (SUM(hours) across every
-- active Service PO for one employee + month must never exceed 176).
--
-- One row per (emp_id, service_po_id, month, year) regardless of status —
-- enforced by the unique constraint below, same soft-delete convention as
-- cost_budget_master / manager_servicepo_mappings / employee_servicepo_mapping.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS resource_budget_master CASCADE;
CREATE TABLE resource_budget_master (
  id SERIAL PRIMARY KEY,
  company_id INT REFERENCES companies (id),
  emp_id INT NOT NULL REFERENCES employees (id),
  service_po_id INT NOT NULL REFERENCES service_pos (id),
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  year INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  hours DECIMAL(6, 2) NOT NULL DEFAULT 0 CHECK (hours >= 0),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_resource_budget_master_emp_po_month_year
  ON resource_budget_master (emp_id, service_po_id, month, year);
CREATE INDEX IF NOT EXISTS idx_resource_budget_master_emp_id
  ON resource_budget_master (emp_id);
CREATE INDEX IF NOT EXISTS idx_resource_budget_master_service_po_id
  ON resource_budget_master (service_po_id);
CREATE INDEX IF NOT EXISTS idx_resource_budget_master_company_id
  ON resource_budget_master (company_id);
-- Speeds up the 176-hour validation, which sums hours across every Service
-- PO for one employee + month.
CREATE INDEX IF NOT EXISTS idx_resource_budget_master_emp_month_year
  ON resource_budget_master (emp_id, month, year);

DROP TRIGGER IF EXISTS trg_resource_budget_master_updated_at ON resource_budget_master;
CREATE TRIGGER trg_resource_budget_master_updated_at BEFORE UPDATE ON resource_budget_master
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260860_add_work_log_start_end_time.sql ==================
-- =============================================================================
-- Employee Work Log — start_time / end_time. Additive only: the existing
-- `hours` column is untouched and remains the source of truth for every
-- historical row (which has NULL start_time/end_time). New time-based
-- entries have both start_time and end_time set, and the application layer
-- (employeeTimesheetService.js) always recalculates `hours` from them
-- server-side rather than trusting a caller-supplied value.
--
-- work_date already represents the date, so start_time/end_time are plain
-- TIME (no date component) — a time-of-day within that same work_date.
--
-- The CHECK below is a defense-in-depth backstop mirroring the application
-- layer's "end_time must be later than start_time" rule; either column
-- being NULL (an old row, or a non-time-based entry) always passes.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employee_work_logs
  ADD COLUMN IF NOT EXISTS start_time TIME NULL,
  ADD COLUMN IF NOT EXISTS end_time TIME NULL;

ALTER TABLE employee_work_logs
  DROP CONSTRAINT IF EXISTS chk_employee_work_logs_start_end_time;
ALTER TABLE employee_work_logs
  ADD CONSTRAINT chk_employee_work_logs_start_end_time
  CHECK (start_time IS NULL OR end_time IS NULL OR end_time > start_time);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260861_add_bu_head_role.sql ==================
-- =============================================================================
-- BU Head — new, purely additive role.
--
-- BU Head is a peer of BU Admin in terms of access (same forms/capabilities —
-- see 20260862_seed_bu_head_capabilities_and_forms.sql), but is scoped to a
-- SET of existing Companies ("BUs") rather than the single company_id a BU
-- Admin belongs to (see bu_head_company_mappings,
-- 20260863_create_bu_head_company_mappings.sql). It never creates a Company
-- (that stays Admin/Entity Admin's job via companyService.createWithAdmin).
--
-- hierarchy_rank / inherits_role_id are left NULL — the same "parallel
-- branch" shape already used for HR (see
-- 20260836_seed_target_roles_and_capabilities.sql) — rather than reusing BU
-- Admin's hierarchy_rank = 4. That would silently pull BU Head into
-- SENIOR_BYPASS_MAX_RANK's capability bypass (src/services/
-- roleHierarchyService.js) and resolveCompany.js's single-company branch,
-- neither of which is what a multi-BU role needs. BU Head's effective access
-- is instead 100% capability/form-driven (copied 1:1 from BU Admin), and its
-- company scope is resolved per-request against bu_head_company_mappings
-- (src/middlewares/resolveCompany.js).
--
-- is_system = false: unlike the original 9 seeded roles, BU Head is not
-- protected from rename/delete by the dynamic Role CRUD — it is a normal,
-- editable role like any other added after the RBAC redesign.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO roles (role_name, permission, status, is_system, hierarchy_rank, inherits_role_id, created_at, updated_at)
VALUES ('BU Head', 'Read & Write', 'active', false, NULL, NULL, NOW(), NOW())
ON CONFLICT (role_name) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260862_seed_bu_head_capabilities_and_forms.sql ==================
-- =============================================================================
-- BU Head — capability + form access, copied 1:1 from BU Admin's CURRENT
-- rows at migration time.
--
-- Neither role_capabilities (src/services/roleHierarchyService.js) nor
-- role_form_mapping is inherited between roles anywhere else in this
-- codebase — every role's access is a flat, directly-seeded set of rows
-- (see 20260836_seed_target_roles_and_capabilities.sql and
-- 20260845_reseed_form_master_and_role_form_mapping.sql). "BU Head gets the
-- SAME form/capability access as BU Admin" is implemented the same way:
-- a one-time copy of BU Admin's rows, not a new inheritance edge. If BU
-- Admin's own mappings change later, re-run (or write a follow-up migration
-- that re-syncs) rather than hand-editing BU Head's rows — see this
-- migration's rollback for the exact inverse.
--
-- Safe to re-run (ON CONFLICT DO NOTHING on both inserts).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO role_capabilities (role_id, capability_key)
SELECT bh.id, rc.capability_key
FROM role_capabilities rc
JOIN roles ba ON ba.id = rc.role_id AND ba.role_name = 'BU Admin'
JOIN roles bh ON bh.role_name = 'BU Head'
ON CONFLICT (role_id, capability_key) DO NOTHING;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT bh.id, rfm.form_id, true, NOW(), NOW()
FROM role_form_mapping rfm
JOIN roles ba ON ba.id = rfm.role_id AND ba.role_name = 'BU Admin'
JOIN roles bh ON bh.role_name = 'BU Head'
WHERE rfm.status = true
ON CONFLICT (role_id, form_id) DO NOTHING;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260863_create_bu_head_company_mappings.sql ==================
-- =============================================================================
-- BU Head <-> Company mapping — a BU Head may be mapped to one or many
-- existing Companies ("BUs"); a Company may equally be mapped to more than
-- one BU Head. Deliberately a join table, not a single owner column on
-- companies (the shape used for Entity <-> Entity Admin,
-- entities.entity_admin_user_id) — that shape only supports ONE owner per
-- row, and this relationship needs BOTH the "one BU Head, many Companies"
-- and the "same Company mapped twice to the same BU Head is rejected"
-- requirements a join table + unique index expresses directly.
--
-- BU Head never creates a Company (see companyService.createWithAdmin,
-- unchanged) — this table only ever links to a Company that already exists.
-- Unmapping (see buHeadCompanyMappingRepository.deleteMapping) removes only
-- the row here; it never touches companies/users/employees.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS bu_head_company_mappings CASCADE;
CREATE TABLE bu_head_company_mappings (
  id SERIAL PRIMARY KEY,
  bu_head_user_id INT NOT NULL REFERENCES users (id),
  company_id INT NOT NULL REFERENCES companies (id),
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Same BU can never be mapped twice to the same BU Head.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bu_head_company_mappings_bu_head_company
  ON bu_head_company_mappings (bu_head_user_id, company_id);
CREATE INDEX IF NOT EXISTS idx_bu_head_company_mappings_bu_head_user_id
  ON bu_head_company_mappings (bu_head_user_id);
CREATE INDEX IF NOT EXISTS idx_bu_head_company_mappings_company_id
  ON bu_head_company_mappings (company_id);

DROP TRIGGER IF EXISTS trg_bu_head_company_mappings_updated_at ON bu_head_company_mappings;
CREATE TRIGGER trg_bu_head_company_mappings_updated_at BEFORE UPDATE ON bu_head_company_mappings
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260864_add_employee_login_columns.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 1: Employee login columns.
--
-- Employees become the primary login identity going forward. Adds
-- `password` (bcrypt hash, mirrors users.password) and `email` — native to
-- Employee for the first time; previously only reachable by joining to a
-- linked User (see 20260842_employees_drop_login_columns.sql, which removed
-- an earlier Employee-direct-login attempt this redesign intentionally
-- reverses, on purpose, with explicit sign-off).
--
-- Both nullable at the DB level: an Employee with no linked User historically
-- has nothing to backfill, and "required to log in" is an app-layer rule,
-- not a NOT NULL constraint here. Every Employee that DOES have a linked
-- User (at most one, per uq_users_employee_id) gets its email+password
-- copied over below, so login continuity is preserved once `users` is
-- truncated later in this migration sequence.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS password VARCHAR(255),
  ADD COLUMN IF NOT EXISTS email VARCHAR(100);

UPDATE employees e
SET email = u.email,
    password = u.password
FROM users u
WHERE u.employee_id = e.id
  AND (e.email IS NULL OR e.password IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_email ON employees (email) WHERE email IS NOT NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260865_create_employee_roles.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 2: employee_roles.
--
-- An Employee may hold multiple roles simultaneously (many-to-many),
-- replacing the old single users.role_id + additive user_additional_roles
-- split. This table is the SOLE source of an employee's roles going
-- forward — there is no primary/additional distinction here; every
-- consumer (capability union, effective hierarchy rank = MIN(hierarchy_rank)
-- across active rows) treats the set uniformly. See roleHierarchyService.js.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS employee_roles CASCADE;
CREATE TABLE employee_roles (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  role_id INT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_roles_employee_role ON employee_roles (employee_id, role_id);
CREATE INDEX IF NOT EXISTS idx_employee_roles_employee_id ON employee_roles (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_roles_role_id ON employee_roles (role_id);

DROP TRIGGER IF EXISTS trg_employee_roles_updated_at ON employee_roles;
CREATE TRIGGER trg_employee_roles_updated_at BEFORE UPDATE ON employee_roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260866_create_employee_business_units.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 3: employee_business_units.
--
-- An Employee may belong to multiple Business Units simultaneously
-- (many-to-many), replacing the old single users.company_id column and the
-- BU-Head-only bu_head_company_mappings mechanism (retired separately, see
-- 20260871_drop_bu_head_company_mappings.sql — its data is migrated here
-- first). "Business Unit" = the existing `companies` table; no duplicate BU
-- table is created.
--
-- This is the table src/middlewares/resolveCompany.js reads to resolve a
-- request's active BU going forward, generalizing what today only the BU
-- Head role gets (a request-selected company validated against a mapping
-- table) to every role.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS employee_business_units CASCADE;
CREATE TABLE employee_business_units (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  business_unit_id INT NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_business_units_employee_bu ON employee_business_units (employee_id, business_unit_id);
CREATE INDEX IF NOT EXISTS idx_employee_business_units_employee_id ON employee_business_units (employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_business_units_business_unit_id ON employee_business_units (business_unit_id);

DROP TRIGGER IF EXISTS trg_employee_business_units_updated_at ON employee_business_units;
CREATE TRIGGER trg_employee_business_units_updated_at BEFORE UPDATE ON employee_business_units
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260867_synthesize_employees_for_userless_admins.sql ==================
-- [bootstrap patch] users.is_deleted is declared on the User model (src/models/User.js)
-- and read by this migration (u.is_deleted below), but no migration file ever adds it —
-- it only exists on the real deployed database via undocumented schema drift, the same
-- class of gap 20260819_add_service_types_is_deleted.sql fixed for service_types.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 4: synthesize Employee rows for
-- Users that never had one.
--
-- Platform Admin / Admin / Entity Admin accounts (and any other User created
-- without an Employee link) have users.employee_id IS NULL today — there is
-- no Employee record to promote to a login identity. Since login is moving
-- to Employee entirely, each such User gets a synthetic Employee row created
-- and linked back, using the best available data (email local-part as a
-- name, current role name as designation). This is a one-time, best-effort
-- synthesis — there is no better source data for these fields for an
-- account that was never an Employee.
--
-- Hard-fails if any user still lacks a linked employee afterward — every
-- later step in this migration sequence assumes full coverage.
--
-- Discovered while first running this migration: the live DB enforces
-- `employees.company_id NOT NULL DEFAULT 1` even though the Sequelize
-- model (src/models/Employee.js) has always declared it `allowNull: true`
-- — one more instance of the out-of-band schema drift this project has hit
-- before (see database/migrations/20260803_ensure_service_categories_schema.sql
-- and 20260842's own note). Platform Admin/Admin/Entity Admin accounts
-- legitimately have no home BU, so the correct fix is to relax the DB
-- constraint to match the model's already-correct intent, not to fabricate
-- a company_id=1 membership these accounts don't actually have.
--
-- Safe to re-run (loop only ever touches rows still matching employee_id
-- IS NULL).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employees ALTER COLUMN company_id DROP NOT NULL;
ALTER TABLE employees ALTER COLUMN company_id DROP DEFAULT;

DO $$
DECLARE
  u RECORD;
  v_new_employee_id INT;
BEGIN
  FOR u IN SELECT * FROM users WHERE employee_id IS NULL LOOP
    INSERT INTO employees (
      company_id, employee_code, full_name, designation, email, password,
      status, is_deleted, created_by, updated_by, created_at, updated_at
    ) VALUES (
      u.company_id,
      'SYS' || LPAD(u.id::text, 6, '0'),
      INITCAP(REPLACE(REPLACE(SPLIT_PART(u.email, '@', 1), '.', ' '), '_', ' ')),
      (SELECT role_name FROM roles WHERE id = u.role_id),
      u.email,
      u.password,
      u.status,
      u.is_deleted,
      u.created_by,
      u.updated_by,
      NOW(),
      NOW()
    )
    RETURNING id INTO v_new_employee_id;

    UPDATE users SET employee_id = v_new_employee_id WHERE id = u.id;
  END LOOP;
END $$;

DO $$
DECLARE v_remaining INT;
BEGIN
  SELECT COUNT(*) INTO v_remaining FROM users WHERE employee_id IS NULL;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'synthesize_employees_for_userless_admins: % users still have no linked employee', v_remaining;
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260868_backfill_employee_roles_from_users.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 5: backfill employee_roles.
--
-- Copies every User's primary role (users.role_id) and every active
-- additional role (user_additional_roles) onto that User's linked Employee
-- (guaranteed to exist after 20260867, and guaranteed unique per Employee
-- per uq_users_employee_id). Hard-fails if any source row wasn't copied —
-- every later step assumes full coverage before touching `users`.
--
-- Safe to re-run (ON CONFLICT DO NOTHING).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO employee_roles (employee_id, role_id, status, created_by, updated_by)
SELECT u.employee_id, u.role_id,
       CASE WHEN u.is_deleted OR u.status = 'inactive' THEN 'inactive' ELSE 'active' END,
       u.created_by, u.updated_by
FROM users u
WHERE u.role_id IS NOT NULL
ON CONFLICT (employee_id, role_id) DO NOTHING;

INSERT INTO employee_roles (employee_id, role_id, status, created_by, updated_by)
SELECT u.employee_id, uar.role_id,
       CASE WHEN u.is_deleted OR u.status = 'inactive' THEN 'inactive' ELSE 'active' END,
       uar.created_by, uar.updated_by
FROM user_additional_roles uar
JOIN users u ON u.id = uar.user_id
ON CONFLICT (employee_id, role_id) DO NOTHING;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM users u
  WHERE u.role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM employee_roles er WHERE er.employee_id = u.employee_id AND er.role_id = u.role_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill_employee_roles_from_users: % primary user roles not backfilled', v_missing;
  END IF;

  SELECT COUNT(*) INTO v_missing FROM user_additional_roles uar
  JOIN users u ON u.id = uar.user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM employee_roles er WHERE er.employee_id = u.employee_id AND er.role_id = uar.role_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill_employee_roles_from_users: % additional user roles not backfilled', v_missing;
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260869_backfill_employee_business_units_from_users.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 6: backfill employee_business_units
-- from users.company_id.
--
-- Copies every User's single company_id onto that User's linked Employee's
-- BU set. Hard-fails if any source row wasn't copied.
--
-- Safe to re-run (ON CONFLICT DO NOTHING).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO employee_business_units (employee_id, business_unit_id, status, created_by, updated_by)
SELECT u.employee_id, u.company_id,
       CASE WHEN u.is_deleted OR u.status = 'inactive' THEN 'inactive' ELSE 'active' END,
       u.created_by, u.updated_by
FROM users u
WHERE u.company_id IS NOT NULL
ON CONFLICT (employee_id, business_unit_id) DO NOTHING;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM users u
  WHERE u.company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM employee_business_units eb WHERE eb.employee_id = u.employee_id AND eb.business_unit_id = u.company_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill_employee_business_units_from_users: % user company links not backfilled', v_missing;
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260870_backfill_employee_business_units_from_bu_head_mappings.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 7: backfill employee_business_units
-- from bu_head_company_mappings.
--
-- Copies only the COMPANY side of each BU Head's mapping — a BU Head's role
-- itself is already captured by 20260868 (buHeadService.createBuHead
-- already grants "BU Head" via users.role_id, and "Employee" via
-- user_additional_roles), so re-inserting it here would just race the
-- earlier ON CONFLICT DO NOTHING for no benefit.
--
-- Safe to re-run (ON CONFLICT DO NOTHING).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO employee_business_units (employee_id, business_unit_id, status, created_by, updated_by)
SELECT u.employee_id, m.company_id, m.status, m.created_by, m.updated_by
FROM bu_head_company_mappings m
JOIN users u ON u.id = m.bu_head_user_id
ON CONFLICT (employee_id, business_unit_id) DO NOTHING;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM bu_head_company_mappings m
  JOIN users u ON u.id = m.bu_head_user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM employee_business_units eb
    WHERE eb.employee_id = u.employee_id AND eb.business_unit_id = m.company_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'backfill_employee_business_units_from_bu_head_mappings: % BU Head mappings not backfilled', v_missing;
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260871_drop_bu_head_company_mappings.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 8: retire bu_head_company_mappings.
--
-- BU Head is folded into the generic employee_roles/employee_business_units
-- model — there is no more separate BU-Head-only BU mapping mechanism.
-- Re-verifies full coverage (belt-and-suspenders on top of 20260870's own
-- check) before dropping, since this is destructive.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM bu_head_company_mappings m
  JOIN users u ON u.id = m.bu_head_user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM employee_business_units eb
    WHERE eb.employee_id = u.employee_id AND eb.business_unit_id = m.company_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'drop_bu_head_company_mappings: % BU Head mappings still not covered by employee_business_units', v_missing;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_bu_head_company_mappings_updated_at ON bu_head_company_mappings;
DROP TABLE IF EXISTS bu_head_company_mappings;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260872_add_manager_employee_mappings_manager_employee_id.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 9a: manager_employee_mappings gets
-- an employee-keyed manager column.
--
-- manager_employee_mappings.manager_user_id identifies WHO manages the
-- mapped employee (manager_employee_mappings.employee_id, untouched here —
-- that column already identifies the MANAGED employee and never referenced
-- users). Once `users` is truncated, manager identity must be an Employee
-- id — this adds manager_employee_id alongside the old column (dropped in
-- 20260876 once every repoint in this phase is verified).
--
-- This table has caused a real prior incident (a missing PRIMARY mapping
-- silently dropped an employee's timesheets from sync) — verification here
-- is intentionally strict: exact row-count match, zero NULLs, and the
-- existing uq_manager_employee_mappings_employee cardinality unchanged.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE manager_employee_mappings
  ADD COLUMN IF NOT EXISTS manager_employee_id INT REFERENCES employees (id);

UPDATE manager_employee_mappings m
SET manager_employee_id = u.employee_id
FROM users u
WHERE u.id = m.manager_user_id
  AND m.manager_employee_id IS NULL;

DO $$
DECLARE
  v_total INT;
  v_null INT;
  v_distinct_before INT;
  v_distinct_after INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM manager_employee_mappings;
  SELECT COUNT(*) INTO v_null FROM manager_employee_mappings WHERE manager_employee_id IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'add_manager_employee_mappings_manager_employee_id: % of % rows have no manager_employee_id', v_null, v_total;
  END IF;

  SELECT COUNT(DISTINCT employee_id) INTO v_distinct_before FROM manager_employee_mappings;
  SELECT COUNT(DISTINCT employee_id) INTO v_distinct_after FROM manager_employee_mappings WHERE manager_employee_id IS NOT NULL;
  IF v_distinct_before <> v_distinct_after THEN
    RAISE EXCEPTION 'add_manager_employee_mappings_manager_employee_id: managed-employee coverage changed (% vs %)', v_distinct_before, v_distinct_after;
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260873_add_manager_servicepo_mappings_manager_employee_id.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 9b: manager_servicepo_mappings gets
-- an employee-keyed manager column.
--
-- Same pattern as 20260872. This table is a genuine many-to-many
-- (manager_user_id, service_po_id) — verification confirms the pair-level
-- cardinality is unchanged after swapping in manager_employee_id.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE manager_servicepo_mappings
  ADD COLUMN IF NOT EXISTS manager_employee_id INT REFERENCES employees (id);

UPDATE manager_servicepo_mappings m
SET manager_employee_id = u.employee_id
FROM users u
WHERE u.id = m.manager_user_id
  AND m.manager_employee_id IS NULL;

DO $$
DECLARE
  v_null INT;
  v_pairs_before INT;
  v_pairs_after INT;
BEGIN
  SELECT COUNT(*) INTO v_null FROM manager_servicepo_mappings WHERE manager_employee_id IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'add_manager_servicepo_mappings_manager_employee_id: % rows have no manager_employee_id', v_null;
  END IF;

  SELECT COUNT(DISTINCT (manager_user_id, service_po_id)) INTO v_pairs_before FROM manager_servicepo_mappings;
  SELECT COUNT(DISTINCT (manager_employee_id, service_po_id)) INTO v_pairs_after FROM manager_servicepo_mappings;
  IF v_pairs_before <> v_pairs_after THEN
    RAISE EXCEPTION 'add_manager_servicepo_mappings_manager_employee_id: pair cardinality changed (% vs %)', v_pairs_before, v_pairs_after;
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260874_add_team_mappings_employee_columns.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 9c: team_mappings gets
-- employee-keyed manager + service_po_admin columns.
--
-- team_mappings.manager_user_id and .service_po_admin_user_id both identify
-- Users today (Service PO Admin -> Manager team roster, one row per
-- Manager — see uq_team_mappings_manager on manager_user_id alone). Adds
-- both employee-keyed equivalents; verification re-checks that same
-- one-Manager-per-team cardinality survives the swap.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE team_mappings
  ADD COLUMN IF NOT EXISTS manager_employee_id INT REFERENCES employees (id),
  ADD COLUMN IF NOT EXISTS service_po_admin_employee_id INT REFERENCES employees (id);

UPDATE team_mappings t
SET manager_employee_id = u.employee_id
FROM users u
WHERE u.id = t.manager_user_id
  AND t.manager_employee_id IS NULL;

UPDATE team_mappings t
SET service_po_admin_employee_id = u.employee_id
FROM users u
WHERE u.id = t.service_po_admin_user_id
  AND t.service_po_admin_employee_id IS NULL;

DO $$
DECLARE
  v_null INT;
  v_distinct_before INT;
  v_distinct_after INT;
BEGIN
  SELECT COUNT(*) INTO v_null FROM team_mappings
  WHERE manager_employee_id IS NULL OR service_po_admin_employee_id IS NULL;
  IF v_null > 0 THEN
    RAISE EXCEPTION 'add_team_mappings_employee_columns: % rows missing an employee-keyed column', v_null;
  END IF;

  SELECT COUNT(DISTINCT manager_user_id) INTO v_distinct_before FROM team_mappings;
  SELECT COUNT(DISTINCT manager_employee_id) INTO v_distinct_after FROM team_mappings;
  IF v_distinct_before <> v_distinct_after THEN
    RAISE EXCEPTION 'add_team_mappings_employee_columns: one-manager-per-team cardinality changed (% vs %)', v_distinct_before, v_distinct_after;
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260875_add_entities_entity_admin_employee_id.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 9d: entities gets an employee-keyed
-- admin column.
--
-- entities.entity_admin_user_id is nullable today (a freshly created Entity
-- starts with no admin) — entity_admin_employee_id mirrors that nullability.
-- Only non-NULL source values are backfilled; verification checks that
-- every non-NULL source produced a non-NULL target, not that every row has
-- one.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS entity_admin_employee_id INT REFERENCES employees (id);

UPDATE entities e
SET entity_admin_employee_id = u.employee_id
FROM users u
WHERE u.id = e.entity_admin_user_id
  AND e.entity_admin_employee_id IS NULL
  AND e.entity_admin_user_id IS NOT NULL;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM entities
  WHERE entity_admin_user_id IS NOT NULL AND entity_admin_employee_id IS NULL;
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'add_entities_entity_admin_employee_id: % entities with an admin not backfilled', v_missing;
  END IF;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260876_finalize_employee_fk_repoint.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 10: finalize the employee-id
-- repoint for entities / manager_employee_mappings / manager_servicepo_mappings
-- / team_mappings.
--
-- Re-verifies every backfill from 20260872-20260875 one more time (point of
-- no return for these four tables), then drops each old *_user_id column
-- (and its never-explicitly-named FK constraint, looked up dynamically —
-- none of these were given an explicit constraint name at creation time, so
-- guessing one would be unsafe) and recreates the equivalent unique/plain
-- indexes on the new *_employee_id column(s).
--
-- Safe to re-run (every step is IF EXISTS / IF NOT EXISTS guarded; the
-- verification DO block simply finds nothing left to fail on a second run).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE v_bad INT;
BEGIN
  SELECT COUNT(*) INTO v_bad FROM manager_employee_mappings WHERE manager_employee_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'finalize_employee_fk_repoint: manager_employee_mappings has % unbackfilled rows', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_bad FROM manager_servicepo_mappings WHERE manager_employee_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'finalize_employee_fk_repoint: manager_servicepo_mappings has % unbackfilled rows', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_bad FROM team_mappings WHERE manager_employee_id IS NULL OR service_po_admin_employee_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'finalize_employee_fk_repoint: team_mappings has % unbackfilled rows', v_bad;
  END IF;

  SELECT COUNT(*) INTO v_bad FROM entities WHERE entity_admin_user_id IS NOT NULL AND entity_admin_employee_id IS NULL;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'finalize_employee_fk_repoint: entities has % unbackfilled admin links', v_bad;
  END IF;
END $$;

-- Composite/singleton unique indexes referencing the old *_user_id columns
-- (both were given explicit names at creation, no dynamic lookup needed).
DROP INDEX IF EXISTS uq_manager_servicepo_mappings;
DROP INDEX IF EXISTS uq_team_mappings_manager;

-- CHECK constraint referencing both team_mappings *_user_id columns must go
-- before those columns can be dropped; recreated below on the new columns.
ALTER TABLE team_mappings DROP CONSTRAINT IF EXISTS chk_team_mappings_not_self;
ALTER TABLE team_mappings DROP CONSTRAINT IF EXISTS chk_head_manager_mappings_not_self;

-- manager_employee_mappings.manager_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'manager_employee_mappings' AND kcu.column_name = 'manager_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE manager_employee_mappings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
DROP INDEX IF EXISTS idx_manager_employee_mappings_manager_user_id;
ALTER TABLE manager_employee_mappings DROP COLUMN IF EXISTS manager_user_id;
ALTER TABLE manager_employee_mappings ALTER COLUMN manager_employee_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_manager_employee_mappings_manager_employee_id ON manager_employee_mappings (manager_employee_id);

-- manager_servicepo_mappings.manager_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'manager_servicepo_mappings' AND kcu.column_name = 'manager_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE manager_servicepo_mappings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
ALTER TABLE manager_servicepo_mappings DROP COLUMN IF EXISTS manager_user_id;
ALTER TABLE manager_servicepo_mappings ALTER COLUMN manager_employee_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_manager_servicepo_mappings ON manager_servicepo_mappings (manager_employee_id, service_po_id);

-- team_mappings.manager_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'team_mappings' AND kcu.column_name = 'manager_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE team_mappings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
ALTER TABLE team_mappings DROP COLUMN IF EXISTS manager_user_id;
ALTER TABLE team_mappings ALTER COLUMN manager_employee_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_team_mappings_manager ON team_mappings (manager_employee_id);

-- team_mappings.service_po_admin_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'team_mappings' AND kcu.column_name = 'service_po_admin_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE team_mappings DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
DROP INDEX IF EXISTS idx_team_mappings_service_po_admin_user_id;
ALTER TABLE team_mappings DROP COLUMN IF EXISTS service_po_admin_user_id;
ALTER TABLE team_mappings ALTER COLUMN service_po_admin_employee_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_team_mappings_service_po_admin_employee_id ON team_mappings (service_po_admin_employee_id);

ALTER TABLE team_mappings ADD CONSTRAINT chk_team_mappings_not_self
  CHECK (service_po_admin_employee_id <> manager_employee_id);

-- entities.entity_admin_user_id
DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'entities' AND kcu.column_name = 'entity_admin_user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE entities DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;
DROP INDEX IF EXISTS idx_entities_entity_admin_user_id;
ALTER TABLE entities DROP COLUMN IF EXISTS entity_admin_user_id;
CREATE INDEX IF NOT EXISTS idx_entities_entity_admin_employee_id ON entities (entity_admin_employee_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260877_drop_user_additional_roles.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 11: retire user_additional_roles.
--
-- Fully superseded by employee_roles (the sole source of an employee's
-- roles going forward). Re-verifies every row is represented there before
-- dropping, since this is destructive.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE v_missing INT;
BEGIN
  SELECT COUNT(*) INTO v_missing FROM user_additional_roles uar
  JOIN users u ON u.id = uar.user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM employee_roles er WHERE er.employee_id = u.employee_id AND er.role_id = uar.role_id
  );
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'drop_user_additional_roles: % additional roles still not covered by employee_roles', v_missing;
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_user_additional_roles_updated_at ON user_additional_roles;
DROP TABLE IF EXISTS user_additional_roles;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260878_relax_audit_trail_user_fks.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 12: relax audit-trail FKs to `users`.
--
-- These columns describe WHICH USER ACCOUNT did something historically —
-- not a business relationship worth repointing to Employee (per explicit
-- instruction: don't blindly convert every user_id reference without
-- understanding why it exists). Each FK constraint is dropped (dynamic
-- lookup — none were given an explicit name at creation) so the upcoming
-- `users` truncate isn't blocked; the column itself is kept as a historical
-- breadcrumb:
--   - role_migration_log.user_id   — protected table, rows untouched.
--   - password_reset_otps.user_id, password_reset_history.user_id — both
--     tables already carry a parallel employee_id column for new rows
--     going forward.
--   - timesheet_import_history.imported_by — has an explicitly-named FK
--     (fk_tih_imported_by, RESTRICT), dropped directly.
--
-- notifications and user_sessions are pure ephemeral per-account state with
-- no historical value once the account is gone — truncated outright here
-- rather than relaxed (audit_logs.user_id and created_by/updated_by columns
-- elsewhere have no live DB constraint at all, confirmed separately, so
-- they need no action and are left alone).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'role_migration_log' AND kcu.column_name = 'user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE role_migration_log DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'password_reset_otps' AND kcu.column_name = 'user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE password_reset_otps DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

DO $$
DECLARE v_conname TEXT;
BEGIN
  SELECT tc.constraint_name INTO v_conname
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = 'password_reset_history' AND kcu.column_name = 'user_id';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE password_reset_history DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

ALTER TABLE timesheet_import_history DROP CONSTRAINT IF EXISTS fk_tih_imported_by;

TRUNCATE TABLE notifications;
TRUNCATE TABLE user_sessions;

-- Generic sweep: this project has repeatedly hit out-of-band, untracked
-- tables that exist on some live environments but were never created by
-- any migration (see 20260803/20260842's own notes on this pattern) — e.g.
-- an ad-hoc `user_roles_copy1` snapshot table, discovered while testing
-- this exact migration, that still carries a FK to `users.id`. Rather than
-- hardcode every such table by name (which would only cover what THIS
-- environment happens to have), drop every remaining FK to users.id this
-- migration hasn't already explicitly handled above, logging each one via
-- RAISE NOTICE so it's visible in the deploy log rather than silent. Only
-- the constraint is dropped — no table's data or rows are touched here.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tc.table_name, kcu.column_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'users'
  LOOP
    RAISE NOTICE 'relax_audit_trail_user_fks: dropping unaccounted-for FK % on %.% (out-of-band/legacy table not part of the tracked schema)',
      r.constraint_name, r.table_name, r.column_name;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.table_name, r.constraint_name);
  END LOOP;
END $$;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260879_create_employee_login_sessions.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 13: employee_login_sessions.
--
-- Refresh-token store for Employee-based login, mirroring user_sessions'
-- final shape (jti/family_id rotation + replay detection, added to
-- user_sessions by 20260857_add_refresh_token_rotation.sql) from day one.
-- Deliberately NOT named `employee_sessions` — that name belonged to the
-- earlier Employee-direct-login attempt dropped by
-- 20260842_employees_drop_login_columns.sql, and reusing it would blur the
-- two designs; this is a fresh table for a fresh (if similarly-shaped)
-- mechanism.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS employee_login_sessions CASCADE;
CREATE TABLE employee_login_sessions (
  id SERIAL PRIMARY KEY,
  employee_id INT NOT NULL REFERENCES employees (id) ON DELETE CASCADE,
  jti VARCHAR(36),
  family_id VARCHAR(36),
  refresh_token VARCHAR(500) NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_jti VARCHAR(36),
  expires_at TIMESTAMP NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_login_sessions_employee_id ON employee_login_sessions (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_login_sessions_jti
  ON employee_login_sessions (jti) WHERE jti IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_employee_login_sessions_family_id ON employee_login_sessions (family_id);
CREATE INDEX IF NOT EXISTS idx_employee_login_sessions_jti_revoked_at ON employee_login_sessions (jti, revoked_at);

DROP TRIGGER IF EXISTS trg_employee_login_sessions_updated_at ON employee_login_sessions;
CREATE TRIGGER trg_employee_login_sessions_updated_at BEFORE UPDATE ON employee_login_sessions
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260880_truncate_users.sql ==================
-- =============================================================================
-- Employee-as-Identity Redesign — Phase 14: truncate `users`.
--
-- `users` is NEVER dropped — only its data is cleared, per explicit
-- instruction. This is the point-of-no-return step: an in-transaction guard
-- clause re-checks every backfill invariant this migration sequence has
-- been building toward (every user linked to an employee, every primary
-- role/company backfilled into employee_roles/employee_business_units) and
-- RAISES an exception rather than proceeding if anything is missing.
--
-- The TRUNCATE itself is deliberately bare (no CASCADE) — by this point in
-- the sequence every table that referenced users.id has either been
-- repointed to employees.id (20260872-20260876), dropped
-- (user_additional_roles, bu_head_company_mappings), had its FK relaxed
-- (20260878), or been truncated alongside it (notifications, user_sessions,
-- also 20260878). If some other, unaccounted-for FK to users.id still
-- exists, Postgres rejects the bare TRUNCATE outright — a second,
-- independent safety net beyond the explicit guard clause below, so a gap
-- in this plan fails loudly instead of silently cascading data loss.
--
-- LOCAL/DEV DATABASE ONLY — not intended for production in this form.
--
-- Safe to re-run (guard clause finds nothing to fail on an already-empty
-- `users` table; TRUNCATE of an empty table is a no-op).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DO $$
DECLARE
  v_null_emp INT;
  v_missing_role INT;
  v_missing_bu INT;
BEGIN
  SELECT COUNT(*) INTO v_null_emp FROM users WHERE employee_id IS NULL;

  SELECT COUNT(*) INTO v_missing_role FROM users u WHERE u.role_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM employee_roles er WHERE er.employee_id = u.employee_id AND er.role_id = u.role_id);

  SELECT COUNT(*) INTO v_missing_bu FROM users u WHERE u.company_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM employee_business_units eb WHERE eb.employee_id = u.employee_id AND eb.business_unit_id = u.company_id);

  IF v_null_emp > 0 OR v_missing_role > 0 OR v_missing_bu > 0 THEN
    RAISE EXCEPTION 'truncate_users blocked: % unlinked users, % unbackfilled roles, % unbackfilled BUs',
      v_null_emp, v_missing_role, v_missing_bu;
  END IF;
END $$;

TRUNCATE TABLE users RESTART IDENTITY;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260881_add_employee_microsoft_object_id.sql ==================
-- =============================================================================
-- Microsoft Entra ID SSO — Employee identifier column.
--
-- Adds employees.microsoft_object_id to store Microsoft's stable, per-tenant,
-- non-reassignable user identifier (the `oid` claim), captured on first
-- successful Microsoft SSO login (see authRepository.updateMicrosoftObjectId()).
--
-- Email remains the sole login-matching key (authRepository.findEmployeeByEmail)
-- — this column is purely additive, for audit/future hardening only, and does
-- not change how any existing employee logs in. NULL for every employee who
-- has never signed in via Microsoft SSO, which is fine: Postgres allows
-- unlimited NULLs under a plain/partial UNIQUE index (same pattern already
-- used by uq_employees_email, see 20260864_add_employee_login_columns.sql).
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS microsoft_object_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_employees_microsoft_object_id
  ON employees (microsoft_object_id) WHERE microsoft_object_id IS NOT NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260881_add_form_master_categories.sql ==================
-- =============================================================================
-- Form Master — optional Category layer between Module and Form.
--
-- Adds a new `categories` table (module_id -> form_master.id, i.e. a
-- module ROW's own id — see database/migrations/
-- 20260856_add_form_master_seq_and_modules.sql for how a module is
-- represented as a form_master row with module_name IS NULL) and a
-- nullable `form_master.category_id` pointing at it.
--
-- A form with category_id = NULL is still directly under its module
-- (Module -> Form, unchanged); category_id set means Module -> Category
-- -> Form. Every existing form_master row is untouched — category_id
-- defaults to NULL, so nothing already registered is reassigned.
--
-- The cross-table invariant "a form's category must belong to the same
-- module as the form" is NOT expressible as a plain CHECK (it needs a
-- join) and is enforced in formMasterService.js instead, consistent with
-- how this codebase already validates module_name in createForm()/
-- updateForm() at the service layer rather than via DB triggers (the only
-- DB function in this schema is the generic trigger_set_updated_at()).
--
-- Safe to re-run: every statement is IF NOT EXISTS / CREATE OR REPLACE /
-- guarded DROP+ADD CONSTRAINT.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS categories CASCADE;
CREATE TABLE categories (
  id          SERIAL PRIMARY KEY,
  module_id   INT NOT NULL REFERENCES form_master (id) ON DELETE RESTRICT,
  name        VARCHAR(100) NOT NULL,
  description VARCHAR(255),
  status      VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  seq         INT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_categories_module_name UNIQUE (module_id, name)
);

ALTER TABLE categories DROP CONSTRAINT IF EXISTS chk_categories_seq_positive;
ALTER TABLE categories ADD CONSTRAINT chk_categories_seq_positive CHECK (seq > 0);

CREATE INDEX IF NOT EXISTS idx_categories_module_id ON categories (module_id);
CREATE INDEX IF NOT EXISTS idx_categories_status ON categories (status);

DROP TRIGGER IF EXISTS trg_categories_updated_at ON categories;
CREATE TRIGGER trg_categories_updated_at BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

ALTER TABLE form_master ADD COLUMN IF NOT EXISTS category_id INT REFERENCES categories (id) ON DELETE RESTRICT;

-- A category can only ever be attached to a FORM row (module_name IS NOT
-- NULL) — module rows (module_name IS NULL) must never carry a category_id.
ALTER TABLE form_master DROP CONSTRAINT IF EXISTS chk_form_master_category_requires_form_row;
ALTER TABLE form_master ADD CONSTRAINT chk_form_master_category_requires_form_row
  CHECK (category_id IS NULL OR module_name IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_form_master_category_id ON form_master (category_id);

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260882_add_service_pos_is_centralised.sql ==================
-- =============================================================================
-- Centralised Service PO — a Service PO with is_centralised = true is
-- automatically mapped to every NEW employee created afterward (see
-- employeeServicePOMappingService.autoMapCentralisedServicePOs()). It stays
-- a normal service_pos row otherwise; no separate table. Existing rows
-- default to FALSE so current behavior is unchanged. Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE service_pos
  ADD COLUMN IF NOT EXISTS is_centralised BOOLEAN NOT NULL DEFAULT FALSE;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260883_add_worklog_rejection_workflow.sql ==================
-- =============================================================================
-- Employee Work Log — Approve / Reject / Resubmit / Delete workflow.
--
-- Adds 'rejected' as a valid employee_work_logs.status value (alongside the
-- existing 'pending' / 'approved' / 'synced' — see
-- 20260852_add_approved_status_to_employee_work_logs.sql for that earlier
-- addition) plus the columns needed to carry a mandatory Manager remark
-- and who/when rejected it:
--
--   rejection_remark - the Manager's reason, required whenever status is
--                       set to 'rejected' (enforced in
--                       managerSelfServiceService.rejectWorkLogEntry /
--                       managerSelfServiceValidation.rejectWorkLogSchema,
--                       not by a DB constraint — mirrors how every other
--                       employee_work_logs business rule in this codebase
--                       lives at the service layer).
--   rejected_by       - the rejecting Manager's users.id (see
--                        EmployeeWorkLog.belongsTo(User, ..., as:
--                        'rejectedByUser') in src/models/index.js).
--   rejected_at       - when the rejection happened.
--
-- These three are deliberately NOT cleared when a rejected row is
-- resubmitted (status back to 'pending') — the most recent rejection stays
-- visible to the Employee even once the row is pending again; they are
-- only overwritten by a SUBSEQUENT rejection. Full history of every
-- reject/resubmit/approve action is additionally captured in the existing
-- audit_logs table (entity_type 'employee_work_logs') — no separate
-- history mechanism is introduced here.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS employee_work_logs_status_check;

ALTER TABLE employee_work_logs
  ADD CONSTRAINT employee_work_logs_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'synced'));

ALTER TABLE employee_work_logs
  ADD COLUMN IF NOT EXISTS rejection_remark TEXT NULL,
  ADD COLUMN IF NOT EXISTS rejected_by INT NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260884_drop_service_pos_invoice_amount_and_expected_man_hours.sql ==================
-- =============================================================================
-- Drop service_pos.invoice_amount and service_pos.expected_man_hours.
--
-- Retired per explicit product decision — these two fields are no longer
-- captured on a Service PO. Downstream features that read them were
-- updated in the same change:
--   - GET /service-pos/:id/utilisation now returns only total_hours_logged
--     (no more expected_man_hours/remaining_hours/utilisation_percentage/
--     is_over_utilised — those all required an expected-hours target).
--   - Dashboard's overall_utilisation_pct (/dashboard/stats) and
--     capacity_utilisation_pct (/dashboard/analytics) are removed entirely.
--   - Management Report's "Service PO Budget & Timeline Exhaustion Risk"
--     report now reports date-elapsed risk only (on_track/overdue) — the
--     hours-budget dimension (consumed_hours_pct, at_risk/critical levels,
--     projected_exhaustion_date) is gone.
--   - Management Report's Delivery Head Performance report no longer has
--     an at_risk_po_count column.
--   - Report Service PO Summary report loses invoiced_amount/unbilled_amount/
--     available_hours/expected_man_hours entirely. Invoice PO Summary report
--     loses available_hours/expected_man_hours only — its invoiced_amount/
--     billed_amount/unbilled_amount already came from
--     service_po_monthly_budgets, not this table, and are unaffected.
--   - AI Insight "new PO staffing suggestion" context and the AI Copilot
--     Service PO summary picker no longer include expected_man_hours.
--   - The Service PO import (Excel/CSV) no longer recognizes either column.
--
-- cost_budget_master.invoice_amount and service_po_monthly_budgets.
-- invoice_amount are UNRELATED tables that happen to share the field name —
-- neither is touched by this migration.
--
-- Irreversible data-wise: the rollback re-adds both columns (nullable), but
-- any values they held are gone — same as every other DROP COLUMN migration
-- in this repo (e.g. 20260880_truncate_users.sql).
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE service_pos DROP COLUMN IF EXISTS invoice_amount;
ALTER TABLE service_pos DROP COLUMN IF EXISTS expected_man_hours;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260885_create_employee_work_log_time_entries.sql ==================
-- =============================================================================
-- Employee Work Log — detailed time entries.
--
-- Employee Self Timesheet Daily entries (employee_work_logs, log_type =
-- 'daily') are unique per (employee_id, service_po_id, hierarchy_node_id,
-- work_date) — see 20260807_hierarchy_node_id_unique_scope.sql — so a single
-- employee_work_logs row is "one Module/Task on one date," with at most ONE
-- start_time/end_time pair (20260860_add_work_log_start_end_time.sql). That
-- can't represent multiple disjoint time segments against the SAME
-- Module/Task on the SAME date (e.g. 09:30-10:20 and 14:00-15:00 both under
-- "Module A" on the same day).
--
-- This table holds exactly that: every individual Start Time/End Time
-- segment, many-to-one against the employee_work_logs row it belongs to
-- (which already identifies the date + Module/Task via its own
-- service_po_id/hierarchy_node_id/work_date). Multiple rows here for the
-- same employee_work_log_id are how "multiple entries for the same date and
-- same Module/Task" is represented.
--
-- employee_work_logs.hours remains what every existing consumer (12-hour/day
-- cap, Monthly exclusivity, Manager approval, Sync-to-timesheets, reports)
-- already reads — the application layer (employeeTimesheetService.js) sums
-- this table's duration_hours per employee_work_log_id and writes that sum
-- into employee_work_logs.hours, so none of those existing consumers need to
-- change. employee_work_logs.start_time/end_time are left NULL going forward
-- for any row backed by entries here (a single pair can't represent multiple
-- segments) — old rows created before this feature keep their existing
-- start_time/end_time/hours untouched, unaffected by this migration.
--
-- duration_hours is stored (not recomputed on every read) purely so
-- reporting queries can SUM/GROUP BY it directly — always derived from
-- start_time/end_time server-side (workLogTimeHelper.calculateHoursFromTimes),
-- never trusted from a caller.
--
-- Safe to re-run.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

DROP TABLE IF EXISTS employee_work_log_time_entries CASCADE;
CREATE TABLE employee_work_log_time_entries (
  id SERIAL PRIMARY KEY,
  employee_work_log_id INT NOT NULL REFERENCES employee_work_logs (id) ON DELETE CASCADE,
  entry_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  duration_hours DECIMAL(6, 2) NOT NULL,
  created_by INT,
  updated_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_employee_work_log_time_entries_end_after_start CHECK (end_time > start_time),
  CONSTRAINT chk_employee_work_log_time_entries_duration_positive CHECK (duration_hours > 0)
);

CREATE INDEX IF NOT EXISTS idx_employee_work_log_time_entries_work_log_id
  ON employee_work_log_time_entries (employee_work_log_id);
CREATE INDEX IF NOT EXISTS idx_employee_work_log_time_entries_entry_date
  ON employee_work_log_time_entries (entry_date);

DROP TRIGGER IF EXISTS trg_employee_work_log_time_entries_updated_at ON employee_work_log_time_entries;
CREATE TRIGGER trg_employee_work_log_time_entries_updated_at BEFORE UPDATE ON employee_work_log_time_entries
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260886_backfill_and_drop_worklog_start_end_time.sql ==================
-- =============================================================================
-- Employee Work Log — retire the single start_time/end_time pair on
-- employee_work_logs now that employee_work_log_time_entries (see
-- 20260885_create_employee_work_log_time_entries.sql) is the source of
-- truth for Start Time/End Time. That table's write path
-- (employeeTimesheetService.js) has already stopped populating these two
-- columns going forward; this migration is the one-time cutover for every
-- row created BEFORE that change.
--
-- Step 1: backfill. Every employee_work_logs row that still has a non-null
-- start_time/end_time pair (created under the old single-pair feature)
-- becomes exactly one row in employee_work_log_time_entries — no historical
-- Start Time/End Time data is lost. Rows with no time pair at all
-- (plain hours-only entries, the vast majority) have nothing to backfill.
--
-- Step 2: drop. Once every row's time data lives in the new table, the old
-- columns (and their CHECK constraint) are dropped from employee_work_logs —
-- per this feature's requirement that the detailed table become the sole
-- place Start Time/End Time is stored; employee_work_logs.hours remains the
-- aggregated total, unaffected.
--
-- Safe to re-run: the backfill INSERT is naturally a no-op on a second run
-- (the columns it reads no longer exist after Step 2 completes), and every
-- DDL statement uses IF EXISTS.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO employee_work_log_time_entries
  (employee_work_log_id, entry_date, start_time, end_time, duration_hours, created_by, updated_by, created_at, updated_at)
SELECT
  id,
  work_date,
  start_time,
  end_time,
  ROUND((EXTRACT(EPOCH FROM (end_time - start_time)) / 3600)::NUMERIC, 2),
  created_by,
  updated_by,
  created_at,
  updated_at
FROM employee_work_logs
WHERE start_time IS NOT NULL
  AND end_time IS NOT NULL;

ALTER TABLE employee_work_logs DROP CONSTRAINT IF EXISTS chk_employee_work_logs_start_end_time;
ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS start_time;
ALTER TABLE employee_work_logs DROP COLUMN IF EXISTS end_time;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260887_make_clients_company_id_nullable.sql ==================
-- =============================================================================
-- Business Unit is now optional when creating a Client (matching Employee's
-- existing "BU mapped later" treatment) — a company-less Admin/Entity Admin
-- may create a Client with no Business Unit at all, mapped afterward via
-- update(). See clientService.js's resolveOptionalCreateCompanyId() usage.
-- projects.company_id is already nullable; this brings clients in line.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE clients
  ALTER COLUMN company_id DROP NOT NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260888_make_service_pos_company_id_nullable.sql ==================
-- =============================================================================
-- Business Unit is now optional when creating a Service PO (matching
-- Employee/Client/Project's existing "BU mapped later" treatment) — a
-- company-less Admin/Entity Admin may create a Service PO with no Business
-- Unit at all, assigned afterward via update(). See servicePOService.js's
-- resolveOptionalCreateCompanyId() usage. clients.company_id and
-- projects.company_id are already nullable (see
-- 20260887_make_clients_company_id_nullable.sql); this brings service_pos
-- in line. The ServicePO model (src/models/ServicePO.js) already declares
-- `company_id: { allowNull: true }` — this migration is what makes the
-- live database actually match that.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE service_pos
  ALTER COLUMN company_id DROP NOT NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260889_make_service_categories_and_types_company_id_nullable.sql ==================
-- =============================================================================
-- Type and Category are becoming global masters instead of per-Business-Unit
-- data (see database/migrations/20260890_seed_global_service_types_categories.sql,
-- applied right after this one) — the global rows use `company_id = NULL`.
--
-- Both models (src/models/ServiceCategory.js, src/models/ServiceType.js)
-- already declare `company_id: { allowNull: true }`, but the live database
-- still enforces NOT NULL on both tables — the same drift
-- 20260887_make_clients_company_id_nullable.sql /
-- 20260888_make_service_pos_company_id_nullable.sql already fixed for
-- clients/service_pos. This is that same fix for service_categories and
-- service_types.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

ALTER TABLE service_categories
  ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE service_types
  ALTER COLUMN company_id DROP NOT NULL;

-- [bootstrap] stripped: COMMIT;

-- ================== database/migrations/20260890_seed_global_service_types_categories.sql ==================
-- =============================================================================
-- Seed ONE global (company_id IS NULL) Service Category / Service Type set.
--
-- Type and Category are becoming platform-wide masters instead of being
-- duplicated per Business Unit (Company) at BU-creation time — see
-- companyService.js's create(), which is being changed in the same
-- rollout to stop seeding a private copy for every new BU.
--
-- This migration is purely ADDITIVE: it inserts exactly one new global row
-- per active default_categories/default_types row (company_id = NULL —
-- already a nullable column, see 20260803_ensure_service_categories_schema.sql
-- and 20260728_add_company_tenancy_schema.sql). It does NOT touch, backfill,
-- or delete any of the existing per-BU service_categories/service_types rows
-- (each existing Business Unit's own historical copy, and every existing
-- service_pos.service_type_id FK pointing at one of them, is left completely
-- untouched) — those simply stop being reachable through the
-- ServiceType/ServiceCategory APIs once the application-layer change lands,
-- without any data loss.
--
-- Idempotent/re-runnable: each INSERT...SELECT is guarded by a NOT EXISTS
-- check against "does a global (company_id IS NULL) row already exist" so a
-- second run is a no-op.
-- =============================================================================

-- [bootstrap] stripped: BEGIN;

INSERT INTO service_categories (company_id, name, status, report_bucket_key, is_deleted, created_at, updated_at)
SELECT
  NULL,
  dc.category_name,
  'active',
  CASE dc.category_name
    WHEN 'Billable' THEN 'billable'
    WHEN 'Non-Billable' THEN 'non_billable'
    WHEN 'Customer Non-Billable' THEN 'customer_non_billable'
    ELSE NULL
  END,
  false,
  NOW(),
  NOW()
FROM default_categories dc
WHERE dc.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM service_categories WHERE company_id IS NULL);

INSERT INTO service_types (company_id, service_type_name, service_category_id, is_deleted, created_at, updated_at)
SELECT
  NULL,
  dt.type_name,
  gc.id,
  false,
  NOW(),
  NOW()
FROM default_types dt
JOIN default_categories dc ON dc.id = dt.default_category_id
JOIN service_categories gc ON gc.company_id IS NULL AND gc.name = dc.category_name
WHERE dt.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM service_types WHERE company_id IS NULL);

-- [bootstrap] stripped: COMMIT;

-- ================== bootstrap corrective patches ==================
-- The following columns are declared on their Sequelize models (src/models/*.js)
-- and are live on the deployed database via undocumented out-of-band schema drift
-- (the same class of gap already fixed once in-repo for service_types — see
-- 20260819_add_service_types_is_deleted.sql — and explicitly called out in
-- 20260867_synthesize_employees_for_userless_admins.sql's own comments for
-- employees.company_id) but no migration file ever creates them. Detected by
-- running the full concatenated bootstrap against a blank database and diffing
-- every model's attributes against information_schema.columns.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE service_pos ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sub_projects ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE timesheet_import_history ADD COLUMN IF NOT EXISTS import_month INTEGER;
ALTER TABLE timesheet_import_history ADD COLUMN IF NOT EXISTS import_year INTEGER;

-- ================== bootstrap: complete Form Master / Categories / Role-Form Mapping (current production state) ==================
-- form_master, categories, and role_form_mapping are dynamically managed through the app's own
-- Form Master / Role-Form Mapping admin screens (not migration-seeded) — every migration only ever
-- inserts a small starter subset (22 forms, 33 mappings). The full current catalog (77 forms, 8
-- report categories, 201 role-form mappings) was captured live from rut_db_live and is replayed
-- here verbatim so a fresh bootstrap matches the CURRENT application state exactly. Looked up/
-- inserted by name, never by hardcoded id, matching this project's own convention (see database/README.md
-- prod/local id-divergence note).

-- -- Modules (form_master rows with module_name IS NULL) --
INSERT INTO form_master (module_name, form_name, status, seq, created_at, updated_at)
VALUES
  (NULL, 'Administration', 'active', 2, NOW(), NOW()),
  (NULL, 'Business', 'active', 3, NOW(), NOW()),
  (NULL, 'Core', 'active', 1, NOW(), NOW()),
  (NULL, 'Employee Self-Service', 'active', 6, NOW(), NOW()),
  (NULL, 'Entity Management', 'active', 5, NOW(), NOW()),
  (NULL, 'People', 'active', 4, NOW(), NOW()),
  (NULL, 'Reports', 'active', 9, NOW(), NOW()),
  (NULL, 'Resources', 'active', 7, NOW(), NOW()),
  (NULL, 'Budget', 'active', 8, NOW(), NOW())
ON CONFLICT (form_name) WHERE module_name IS NULL DO UPDATE SET status = excluded.status, seq = excluded.seq, updated_at = NOW();

-- -- Categories (Reports module sub-groupings) --
INSERT INTO categories (module_id, name, description, status, seq, created_at, updated_at)
SELECT m.id, v.name, v.description, v.status, v.seq, NOW(), NOW()
FROM (VALUES
  ('Reports', 'PO & Invoice Management', NULL, 'active', 1),
  ('Reports', 'PO reports', 'test', 'active', 2),
  ('Reports', 'Resource & Utilization', NULL, 'active', 3),
  ('Reports', 'Financial & Profitability', NULL, 'active', 4),
  ('Reports', 'Client Analytics', NULL, 'active', 5),
  ('Reports', 'BU & Delivery Performance', NULL, 'active', 6),
  ('Reports', 'Forecast & Planning', NULL, 'active', 7),
  ('Reports', 'subreport', NULL, 'active', 8)
) AS v(module_name, name, description, status, seq)
JOIN form_master m ON m.module_name IS NULL AND m.form_name = v.module_name
ON CONFLICT (module_id, name) DO UPDATE SET description = excluded.description, status = excluded.status, seq = excluded.seq, updated_at = NOW();

-- -- Forms (form_master rows under a module, optionally under a category) --
INSERT INTO form_master (module_name, form_name, status, seq, category_id, created_at, updated_at)
SELECT v.module_name, v.form_name, v.status, v.seq, cat.id, NOW(), NOW()
FROM (VALUES
  ('Core', 'Dashboard', 'active', 1, NULL, NULL),
  ('Core', 'AI Insights', 'active', 2, NULL, NULL),
  ('People', 'Employees', 'inactive', 4, NULL, NULL),
  ('Administration', 'Roles', 'active', 5, NULL, NULL),
  ('Administration', 'Forms', 'active', 3, NULL, NULL),
  ('Administration', 'User Role Mapping', 'active', 2, NULL, NULL),
  ('Administration', 'Role Form Mapping', 'inactive', 1, NULL, NULL),
  ('People', 'Users', 'active', 6, NULL, NULL),
  ('Business', 'Clients', 'inactive', 4, NULL, NULL),
  ('Business', 'Service POs', 'inactive', 9, NULL, NULL),
  ('Business', 'Sub-Projects', 'active', 11, NULL, NULL),
  ('Business', 'Service Types', 'active', 10, NULL, NULL),
  ('Business', 'Service Categories', 'active', 7, NULL, NULL),
  ('Resources', 'Timesheets', 'active', 4, NULL, NULL),
  ('Resources', 'Monthly Costs', 'active', 1, NULL, NULL),
  ('Reports', 'PO vs Resource', 'active', 4, 'Reports', 'PO & Invoice Management'),
  ('Reports', 'Service PO Summary', 'active', 10, 'Reports', 'PO & Invoice Management'),
  ('Reports', 'Monthly Utilization', 'active', 3, 'Reports', 'Resource & Utilization'),
  ('Reports', 'Resource Allocation', 'active', 8, 'Reports', 'Resource & Utilization'),
  ('Reports', 'Resource Project Utilization', 'active', 9, 'Reports', 'Resource & Utilization'),
  ('Reports', 'Client × Service PO', 'active', 1, 'Reports', 'PO reports'),
  ('Business', 'Project master', 'active', 2, NULL, NULL),
  ('Entity Management', 'Entity Master', 'active', 3, NULL, NULL),
  ('Entity Management', 'BU Admin Master', 'active', 1, NULL, NULL),
  ('Entity Management', 'Entity Admin Master', 'inactive', 2, NULL, NULL),
  ('Administration', 'Project Admin Master', 'inactive', 4, NULL, NULL),
  ('Administration', 'Service PO Admin Master', 'inactive', 6, NULL, NULL),
  ('Administration', 'Team Management', 'active', 7, NULL, NULL),
  ('People', 'Employee List', 'inactive', 1, NULL, NULL),
  ('People', 'Employee Mapping', 'inactive', 2, NULL, NULL),
  ('People', 'Employee Master', 'active', 3, NULL, NULL),
  ('Business', 'Client Master', 'active', 1, NULL, NULL),
  ('Business', 'Project Master', 'inactive', 5, NULL, NULL),
  ('Business', 'Service PO Master', 'active', 3, NULL, NULL),
  ('Business', 'Service PO Mapping', 'active', 8, NULL, NULL),
  ('Resources', 'Timesheet', 'inactive', 2, NULL, NULL),
  ('Resources', 'Timesheet Approval', 'active', 3, NULL, NULL),
  ('Core', 'Employee Dashboard', 'active', 3, NULL, NULL),
  ('Employee Self-Service', 'My Work Log', 'active', 1, NULL, NULL),
  ('Employee Self-Service', 'Monthly Summary', 'active', 2, NULL, NULL),
  ('Reports', 'PO Wise Report', 'active', 5, 'Reports', 'PO & Invoice Management'),
  ('Business', 'Monthly PO Reporting', 'active', 6, NULL, NULL),
  ('Reports', 'Invoice PO Summary', 'active', 2, 'Reports', 'PO & Invoice Management'),
  ('People', 'My Team', 'active', 5, NULL, NULL),
  ('Reports', 'Project Hours Report', 'active', 6, 'Reports', 'Resource & Utilization'),
  ('Reports', 'Timesheet Approval Status Report', 'active', 11, 'Reports', 'BU & Delivery Performance'),
  ('Budget', 'Cost Budget', 'active', 1, NULL, NULL),
  ('Budget', 'Resource Budget', 'active', 2, NULL, NULL),
  ('Reports', 'Service PO Profitability', 'active', 12, 'Reports', 'Financial & Profitability'),
  ('Reports', 'Budgeted Margin Forecast', 'active', 13, 'Reports', 'Financial & Profitability'),
  ('Reports', 'Resource Staffing Plan Accuracy', 'active', 14, 'Reports', 'Forecast & Planning'),
  ('Reports', 'Client Profitability & Concentration', 'active', 15, 'Reports', 'Client Analytics'),
  ('Reports', 'BU Performance Scorecard', 'active', 16, 'Reports', 'BU & Delivery Performance'),
  ('Reports', 'Employee Capacity & Bench Forecast', 'active', 17, 'Reports', 'Resource & Utilization'),
  ('Reports', 'Service PO Timeline Risk', 'active', 18, 'Reports', 'PO & Invoice Management'),
  ('Reports', 'Delivery Head Performance', 'active', 19, 'Reports', 'BU & Delivery Performance'),
  ('Reports', 'Invoice Realization Trend', 'active', 20, 'Reports', 'PO & Invoice Management'),
  ('Reports', 'Service Line Business Mix', 'active', 21, 'Reports', 'Client Analytics'),
  ('Reports', 'Budget vs Billed', 'active', 22, 'Reports', 'Financial & Profitability'),
  ('Reports', 'Client Cost Analytics', 'active', 23, 'Reports', 'Financial & Profitability'),
  ('Reports', 'Client Wise Analytics', 'active', 24, 'Reports', 'Client Analytics'),
  ('Reports', 'Monthly Hours Trend', 'active', 25, 'Reports', 'Forecast & Planning'),
  ('Reports', 'Employee Bench Percentage', 'active', 26, 'Reports', 'Resource & Utilization'),
  ('Entity Management', 'BU Head Master', 'active', 4, NULL, NULL),
  ('Core', 'Category1', 'active', 4, NULL, NULL),
  ('Employee Self-Service', 'Time Entry', 'active', 3, NULL, NULL),
  ('Employee Self-Service', 'Rejected Entries', 'active', 4, NULL, NULL),
  ('Employee Self-Service', 'Timesheet Approval Status Report', 'active', 5, NULL, NULL)
) AS v(module_name, form_name, status, seq, cat_module_name, cat_name)
LEFT JOIN form_master cat_module ON cat_module.module_name IS NULL AND cat_module.form_name = v.cat_module_name
LEFT JOIN categories cat ON cat.module_id = cat_module.id AND cat.name = v.cat_name
ON CONFLICT (module_name, form_name) DO UPDATE SET status = excluded.status, seq = excluded.seq, category_id = excluded.category_id, updated_at = NOW();

-- -- Role-Form Mapping (full current grant/deny matrix) --
INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT r.id, fm.id, v.status, NOW(), NOW()
FROM (VALUES
  ('Admin', 'Budget', 'Cost Budget', true),
  ('Admin', 'Budget', 'Resource Budget', true),
  ('Admin', 'Business', 'Client Master', true),
  ('Admin', 'Business', 'Monthly PO Reporting', true),
  ('Admin', 'Business', 'Project master', true),
  ('Admin', 'Business', 'Service PO Master', true),
  ('Admin', 'Core', 'Dashboard', true),
  ('Admin', 'Entity Management', 'BU Admin Master', true),
  ('Admin', 'Entity Management', 'BU Head Master', false),
  ('Admin', 'Entity Management', 'Entity Admin Master', false),
  ('Admin', 'Entity Management', 'Entity Master', true),
  ('Admin', 'People', 'Employee Master', true),
  ('Admin', 'Reports', 'BU Performance Scorecard', true),
  ('Admin', 'Reports', 'Budget vs Billed', true),
  ('Admin', 'Reports', 'Budgeted Margin Forecast', true),
  ('Admin', 'Reports', 'Client × Service PO', true),
  ('Admin', 'Reports', 'Client Cost Analytics', true),
  ('Admin', 'Reports', 'Client Profitability & Concentration', true),
  ('Admin', 'Reports', 'Client Wise Analytics', true),
  ('Admin', 'Reports', 'Delivery Head Performance', true),
  ('Admin', 'Reports', 'Employee Bench Percentage', true),
  ('Admin', 'Reports', 'Employee Capacity & Bench Forecast', true),
  ('Admin', 'Reports', 'Invoice PO Summary', true),
  ('Admin', 'Reports', 'Invoice Realization Trend', true),
  ('Admin', 'Reports', 'Monthly Hours Trend', true),
  ('Admin', 'Reports', 'Monthly Utilization', true),
  ('Admin', 'Reports', 'PO vs Resource', true),
  ('Admin', 'Reports', 'PO Wise Report', true),
  ('Admin', 'Reports', 'Project Hours Report', true),
  ('Admin', 'Reports', 'Resource Allocation', true),
  ('Admin', 'Reports', 'Resource Project Utilization', true),
  ('Admin', 'Reports', 'Resource Staffing Plan Accuracy', true),
  ('Admin', 'Reports', 'Service Line Business Mix', true),
  ('Admin', 'Reports', 'Service PO Profitability', true),
  ('Admin', 'Reports', 'Service PO Summary', true),
  ('Admin', 'Reports', 'Service PO Timeline Risk', true),
  ('Admin', 'Reports', 'Timesheet Approval Status Report', true),
  ('Admin', 'Resources', 'Monthly Costs', true),
  ('Admin', 'Resources', 'Timesheets', true),
  ('BU Admin', 'Administration', 'Forms', false),
  ('BU Admin', 'Administration', 'Project Admin Master', false),
  ('BU Admin', 'Administration', 'Role Form Mapping', false),
  ('BU Admin', 'Administration', 'Roles', false),
  ('BU Admin', 'Administration', 'Service PO Admin Master', false),
  ('BU Admin', 'Budget', 'Cost Budget', true),
  ('BU Admin', 'Budget', 'Resource Budget', true),
  ('BU Admin', 'Business', 'Client Master', true),
  ('BU Admin', 'Business', 'Clients', true),
  ('BU Admin', 'Business', 'Monthly PO Reporting', true),
  ('BU Admin', 'Business', 'Project master', true),
  ('BU Admin', 'Business', 'Project Master', true),
  ('BU Admin', 'Business', 'Service Categories', false),
  ('BU Admin', 'Business', 'Service PO Mapping', false),
  ('BU Admin', 'Business', 'Service PO Master', true),
  ('BU Admin', 'Business', 'Service POs', true),
  ('BU Admin', 'Business', 'Service Types', false),
  ('BU Admin', 'Business', 'Sub-Projects', false),
  ('BU Admin', 'Core', 'AI Insights', false),
  ('BU Admin', 'Core', 'Dashboard', true),
  ('BU Admin', 'Core', 'Employee Dashboard', false),
  ('BU Admin', 'Employee Self-Service', 'Monthly Summary', false),
  ('BU Admin', 'Employee Self-Service', 'My Work Log', false),
  ('BU Admin', 'Entity Management', 'BU Admin Master', false),
  ('BU Admin', 'Entity Management', 'Entity Admin Master', true),
  ('BU Admin', 'Entity Management', 'Entity Master', false),
  ('BU Admin', 'People', 'Employee List', true),
  ('BU Admin', 'People', 'Employee Mapping', true),
  ('BU Admin', 'People', 'Employee Master', true),
  ('BU Admin', 'People', 'Employees', true),
  ('BU Admin', 'People', 'Users', true),
  ('BU Admin', 'Reports', 'BU Performance Scorecard', false),
  ('BU Admin', 'Reports', 'Budget vs Billed', true),
  ('BU Admin', 'Reports', 'Budgeted Margin Forecast', true),
  ('BU Admin', 'Reports', 'Client × Service PO', true),
  ('BU Admin', 'Reports', 'Client Cost Analytics', true),
  ('BU Admin', 'Reports', 'Client Profitability & Concentration', true),
  ('BU Admin', 'Reports', 'Client Wise Analytics', true),
  ('BU Admin', 'Reports', 'Delivery Head Performance', true),
  ('BU Admin', 'Reports', 'Employee Bench Percentage', true),
  ('BU Admin', 'Reports', 'Employee Capacity & Bench Forecast', true),
  ('BU Admin', 'Reports', 'Invoice PO Summary', true),
  ('BU Admin', 'Reports', 'Invoice Realization Trend', true),
  ('BU Admin', 'Reports', 'Monthly Hours Trend', true),
  ('BU Admin', 'Reports', 'Monthly Utilization', true),
  ('BU Admin', 'Reports', 'PO vs Resource', true),
  ('BU Admin', 'Reports', 'PO Wise Report', false),
  ('BU Admin', 'Reports', 'Resource Allocation', true),
  ('BU Admin', 'Reports', 'Resource Project Utilization', true),
  ('BU Admin', 'Reports', 'Resource Staffing Plan Accuracy', true),
  ('BU Admin', 'Reports', 'Service Line Business Mix', true),
  ('BU Admin', 'Reports', 'Service PO Profitability', true),
  ('BU Admin', 'Reports', 'Service PO Summary', true),
  ('BU Admin', 'Reports', 'Service PO Timeline Risk', true),
  ('BU Admin', 'Resources', 'Monthly Costs', true),
  ('BU Admin', 'Resources', 'Timesheet', true),
  ('BU Admin', 'Resources', 'Timesheet Approval', true),
  ('BU Admin', 'Resources', 'Timesheets', true),
  ('BU Head', 'Budget', 'Cost Budget', true),
  ('BU Head', 'Budget', 'Resource Budget', true),
  ('BU Head', 'Business', 'Client Master', true),
  ('BU Head', 'Business', 'Clients', true),
  ('BU Head', 'Business', 'Monthly PO Reporting', true),
  ('BU Head', 'Business', 'Project master', true),
  ('BU Head', 'Business', 'Project Master', true),
  ('BU Head', 'Business', 'Service PO Master', true),
  ('BU Head', 'Business', 'Service POs', true),
  ('BU Head', 'Core', 'Dashboard', true),
  ('BU Head', 'Entity Management', 'BU Admin Master', false),
  ('BU Head', 'Entity Management', 'Entity Admin Master', false),
  ('BU Head', 'Entity Management', 'Entity Master', false),
  ('BU Head', 'People', 'Employee List', true),
  ('BU Head', 'People', 'Employee Mapping', true),
  ('BU Head', 'People', 'Employee Master', true),
  ('BU Head', 'People', 'Employees', true),
  ('BU Head', 'People', 'Users', true),
  ('BU Head', 'Reports', 'Budget vs Billed', true),
  ('BU Head', 'Reports', 'Budgeted Margin Forecast', true),
  ('BU Head', 'Reports', 'Client × Service PO', true),
  ('BU Head', 'Reports', 'Client Cost Analytics', true),
  ('BU Head', 'Reports', 'Client Profitability & Concentration', true),
  ('BU Head', 'Reports', 'Client Wise Analytics', true),
  ('BU Head', 'Reports', 'Delivery Head Performance', true),
  ('BU Head', 'Reports', 'Employee Bench Percentage', true),
  ('BU Head', 'Reports', 'Employee Capacity & Bench Forecast', true),
  ('BU Head', 'Reports', 'Invoice PO Summary', true),
  ('BU Head', 'Reports', 'Invoice Realization Trend', true),
  ('BU Head', 'Reports', 'Monthly Hours Trend', true),
  ('BU Head', 'Reports', 'Monthly Utilization', true),
  ('BU Head', 'Reports', 'PO vs Resource', true),
  ('BU Head', 'Reports', 'Resource Allocation', true),
  ('BU Head', 'Reports', 'Resource Project Utilization', true),
  ('BU Head', 'Reports', 'Resource Staffing Plan Accuracy', true),
  ('BU Head', 'Reports', 'Service Line Business Mix', true),
  ('BU Head', 'Reports', 'Service PO Profitability', true),
  ('BU Head', 'Reports', 'Service PO Summary', true),
  ('BU Head', 'Reports', 'Service PO Timeline Risk', true),
  ('BU Head', 'Resources', 'Monthly Costs', true),
  ('BU Head', 'Resources', 'Timesheet', true),
  ('BU Head', 'Resources', 'Timesheet Approval', true),
  ('BU Head', 'Resources', 'Timesheets', true),
  ('Employee', 'Core', 'Employee Dashboard', true),
  ('Employee', 'Employee Self-Service', 'Monthly Summary', true),
  ('Employee', 'Employee Self-Service', 'My Work Log', true),
  ('Employee', 'Employee Self-Service', 'Rejected Entries', true),
  ('Employee', 'Employee Self-Service', 'Time Entry', true),
  ('Employee', 'Employee Self-Service', 'Timesheet Approval Status Report', false),
  ('Employee', 'Reports', 'PO Wise Report', true),
  ('Employee', 'Reports', 'Project Hours Report', true),
  ('Employee', 'Reports', 'Timesheet Approval Status Report', true),
  ('Employee', 'Resources', 'Timesheet', false),
  ('Entity Admin', 'Entity Management', 'BU Admin Master', true),
  ('Entity Admin', 'Entity Management', 'BU Head Master', true),
  ('Entity Admin', 'Entity Management', 'Entity Master', true),
  ('Entity Admin', 'People', 'Employee List', true),
  ('Entity Admin', 'Resources', 'Timesheet Approval', false),
  ('HR', 'Business', 'Clients', false),
  ('HR', 'Business', 'Service Categories', false),
  ('HR', 'Business', 'Service POs', false),
  ('HR', 'Business', 'Service Types', false),
  ('HR', 'Business', 'Sub-Projects', false),
  ('HR', 'Core', 'AI Insights', false),
  ('HR', 'Core', 'Dashboard', false),
  ('HR', 'People', 'Employee Master', true),
  ('HR', 'People', 'Employees', false),
  ('HR', 'People', 'Users', false),
  ('HR', 'Reports', 'Monthly Utilization', false),
  ('HR', 'Reports', 'PO vs Resource', false),
  ('HR', 'Reports', 'Resource Allocation', false),
  ('HR', 'Reports', 'Resource Project Utilization', false),
  ('HR', 'Reports', 'Service PO Summary', false),
  ('HR', 'Resources', 'Monthly Costs', false),
  ('HR', 'Resources', 'Timesheet', true),
  ('HR', 'Resources', 'Timesheets', false),
  ('Manager', 'Business', 'Monthly PO Reporting', false),
  ('Manager', 'Business', 'Service PO Mapping', true),
  ('Manager', 'People', 'Employee Mapping', true),
  ('Manager', 'People', 'My Team', true),
  ('Manager', 'Reports', 'Invoice PO Summary', false),
  ('Manager', 'Resources', 'Timesheet', false),
  ('Manager', 'Resources', 'Timesheet Approval', true),
  ('Manager', 'Resources', 'Timesheets', true),
  ('Platform Admin', 'Administration', 'Forms', true),
  ('Platform Admin', 'Administration', 'Roles', true),
  ('Project Admin', 'Administration', 'Service PO Admin Master', true),
  ('Project Admin', 'Business', 'Client Master', true),
  ('Project Admin', 'Business', 'Monthly PO Reporting', true),
  ('Project Admin', 'Business', 'Project master', true),
  ('Project Admin', 'Business', 'Project Master', true),
  ('Project Admin', 'Business', 'Service PO Master', true),
  ('Project Admin', 'People', 'Employee List', true),
  ('Project Admin', 'People', 'My Team', true),
  ('Project Admin', 'Reports', 'Invoice PO Summary', true),
  ('Project Admin', 'Resources', 'Timesheet Approval', true),
  ('Service PO Admin', 'Administration', 'Team Management', true),
  ('Service PO Admin', 'Budget', 'Cost Budget', true),
  ('Service PO Admin', 'Budget', 'Resource Budget', true),
  ('Service PO Admin', 'Business', 'Monthly PO Reporting', true),
  ('Service PO Admin', 'People', 'Employee List', false),
  ('Service PO Admin', 'People', 'My Team', true),
  ('Service PO Admin', 'Reports', 'Invoice PO Summary', true),
  ('Service PO Admin', 'Resources', 'Timesheet Approval', true)
) AS v(role_name, module_name, form_name, status)
JOIN roles r ON r.role_name = v.role_name
JOIN form_master fm ON fm.module_name = v.module_name AND fm.form_name = v.form_name
ON CONFLICT (role_id, form_id) DO UPDATE SET status = excluded.status, updated_at = NOW();

-- ================== bootstrap: retire forms/mappings no longer in current production state ==================
-- These 3 rows were seeded by earlier migrations (20260845's 'Reports'/'Reports' form and its
-- Employee mapping; 20260862's copy-BU-Admin-mappings-to-BU-Head, which included Administration/
-- Project Admin Master and Administration/Service PO Admin Master) but no longer exist in the live
-- rut_db_live catalog captured above — removed there via the Form Master / Role-Form Mapping admin
-- screens at some point. Dropped here so a fresh bootstrap matches the CURRENT catalog exactly rather
-- than also carrying stale rows the live database no longer has.
DELETE FROM role_form_mapping
WHERE role_id = (SELECT id FROM roles WHERE role_name = 'BU Head')
  AND form_id IN (
    SELECT id FROM form_master WHERE module_name = 'Administration'
    AND form_name IN ('Project Admin Master', 'Service PO Admin Master')
  );

-- ON DELETE CASCADE on role_form_mapping.form_id also removes the stale Employee mapping to it.
DELETE FROM form_master WHERE module_name = 'Reports' AND form_name = 'Reports';

-- ================== bootstrap: Platform Admin seed ==================
-- Reuses the exact email + bcrypt password hash of the real Platform Admin
-- employee rows already in use locally (rut_db_live) — copied verbatim, per
-- explicit request, so this bootstrap produces a database that can log in with
-- the SAME credentials as the local dev environment. Both hashes are bcrypt/12
-- rounds (matches BCRYPT_ROUNDS in src/models/Employee.js) — never a plaintext
-- password. Role is looked up by name, not a hardcoded id, matching this
-- project's own convention.
--   - admin@rutportal.com (employees.id 508, employee_code SYS000001) — the
--     main/original Platform Admin.
--   - platform-admin@gttdata.ai (employees.id 496, employee_code SYS000005) —
--     the secondary Platform Admin seeded via scripts/seedPlatformAdmin.js.
INSERT INTO employees (employee_code, full_name, designation, email, password, status, company_id, is_deleted, created_at, updated_at)
VALUES
  ('SYS000001', 'Admin', 'Platform Admin', 'admin@rutportal.com', '$2b$12$plEI52oc1Yx.SKAOU6zhD.h6lbsHtWQfqs1ya0BHJhnG56x29FlAy', 'active', NULL, false, NOW(), NOW()),
  ('SYS000005', 'Platform-Admin', 'Platform Admin', 'platform-admin@gttdata.ai', '$2b$12$XwTcd2yXykhWPSTgMpu0Nuu3Tk4OVCQat82Bfb95OiUzwvVqP6p32', 'active', NULL, false, NOW(), NOW())
ON CONFLICT (email) WHERE email IS NOT NULL DO NOTHING;

INSERT INTO employee_roles (employee_id, role_id, status, created_by, updated_by, created_at, updated_at)
SELECT e.id, r.id, 'active', NULL, NULL, NOW(), NOW()
FROM employees e, roles r
WHERE e.email IN ('admin@rutportal.com', 'platform-admin@gttdata.ai') AND r.role_name = 'Platform Admin'
ON CONFLICT (employee_id, role_id) DO NOTHING;

COMMIT;