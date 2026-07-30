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

BEGIN;

ALTER TABLE IF EXISTS timesheets
  ADD CONSTRAINT timesheets_employee_po_date_unique
  UNIQUE (employee_id, service_po_id, timesheet_date);

COMMIT;
