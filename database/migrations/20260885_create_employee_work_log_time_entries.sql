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

BEGIN;

CREATE TABLE IF NOT EXISTS employee_work_log_time_entries (
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

COMMIT;
