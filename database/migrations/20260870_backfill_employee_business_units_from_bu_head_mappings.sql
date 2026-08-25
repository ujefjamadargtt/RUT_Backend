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

BEGIN;

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

COMMIT;
