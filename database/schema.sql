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

CREATE TABLE IF NOT EXISTS roles (
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

CREATE TABLE IF NOT EXISTS employees (
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

CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS user_roles (
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

CREATE TABLE IF NOT EXISTS form_master (
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

CREATE TABLE IF NOT EXISTS role_form_mapping (
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

CREATE TABLE IF NOT EXISTS clients (
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

CREATE TABLE IF NOT EXISTS service_types (
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

CREATE TABLE IF NOT EXISTS service_pos (
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

CREATE TABLE IF NOT EXISTS service_po_resources (
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

CREATE TABLE IF NOT EXISTS sub_projects (
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

CREATE TABLE IF NOT EXISTS monthly_costs (
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

CREATE TABLE IF NOT EXISTS timesheet_import_history (
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

CREATE TABLE IF NOT EXISTS timesheet_import_errors (
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

CREATE TABLE IF NOT EXISTS timesheets (
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

CREATE TABLE IF NOT EXISTS audit_logs (
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

CREATE TABLE IF NOT EXISTS user_sessions (
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

CREATE TABLE IF NOT EXISTS notifications (
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

CREATE TRIGGER trg_ai_insight_jobs_updated_at
  BEFORE UPDATE ON ai_insight_jobs
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- TABLE: ai_insights
-- AI Insights module — generated insights
-- =============================================================================

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

CREATE TRIGGER trg_ai_insights_updated_at
  BEFORE UPDATE ON ai_insights
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- =============================================================================
-- END OF SCHEMA
-- =============================================================================
