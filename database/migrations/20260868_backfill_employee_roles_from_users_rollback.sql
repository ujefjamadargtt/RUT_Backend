-- Rollback for 20260868_backfill_employee_roles_from_users.sql
-- Not auto-run by the migration runner — apply manually if needed.
--
-- Best-effort: removes only rows exactly matching current users/
-- user_additional_roles state. If either table has since been truncated,
-- this cannot reconstruct which employee_roles rows came from this
-- migration — in that case leave employee_roles alone instead.

BEGIN;

DELETE FROM employee_roles er
WHERE EXISTS (
  SELECT 1 FROM users u WHERE u.employee_id = er.employee_id AND u.role_id = er.role_id
) OR EXISTS (
  SELECT 1 FROM user_additional_roles uar
  JOIN users u ON u.id = uar.user_id
  WHERE u.employee_id = er.employee_id AND uar.role_id = er.role_id
);

COMMIT;
