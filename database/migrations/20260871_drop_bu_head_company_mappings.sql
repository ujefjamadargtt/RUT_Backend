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

BEGIN;

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

COMMIT;
