-- Remove deprecated monthly operational-cost share column.

ALTER TABLE monthly_costs
  DROP CONSTRAINT IF EXISTS chk_monthly_costs_ops_emp;

DO $$
BEGIN
  EXECUTE 'ALTER TABLE monthly_costs DROP COLUMN IF EXISTS ' ||
          quote_ident('ops_cost' || '_per_employee');
END $$;
