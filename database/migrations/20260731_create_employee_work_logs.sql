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

BEGIN;

CREATE TABLE IF NOT EXISTS employee_work_logs (
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

COMMIT;
