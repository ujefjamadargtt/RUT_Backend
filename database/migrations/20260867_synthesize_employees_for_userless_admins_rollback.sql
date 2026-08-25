-- Rollback for 20260867_synthesize_employees_for_userless_admins.sql
-- Not auto-run by the migration runner — apply manually if needed.
--
-- Best-effort only: removes exactly the synthetic employee_code='SYS######'
-- rows this migration created, and clears the employee_id link this
-- migration set on their source users. Does NOT attempt to distinguish a
-- synthetic row that has since acquired real business data (e.g. it started
-- appearing in employee_roles/timesheets) — check before running this in an
-- environment where the redesign has been live for a while.

BEGIN;

UPDATE users u
SET employee_id = NULL
FROM employees e
WHERE u.employee_id = e.id AND e.employee_code LIKE 'SYS%' AND LENGTH(e.employee_code) = 9;

DELETE FROM employees
WHERE employee_code LIKE 'SYS%' AND LENGTH(employee_code) = 9
  AND id NOT IN (SELECT employee_id FROM users WHERE employee_id IS NOT NULL);

COMMIT;
