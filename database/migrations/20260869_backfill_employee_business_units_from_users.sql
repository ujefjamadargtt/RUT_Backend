-- =============================================================================
-- Employee-as-Identity Redesign — Phase 6: backfill employee_business_units
-- from users.company_id.
--
-- Copies every User's single company_id onto that User's linked Employee's
-- BU set. Hard-fails if any source row wasn't copied.
--
-- Safe to re-run (ON CONFLICT DO NOTHING).
-- =============================================================================

BEGIN;

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

COMMIT;
