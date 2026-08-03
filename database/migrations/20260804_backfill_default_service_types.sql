-- =============================================================================
-- Backfill default service types for companies provisioned before
-- companyService.createWithAdmin() started seeding them (see that file for
-- the source-of-truth default list). Those companies already got their 3
-- default service_categories on creation, but nothing in service_types —
-- so every "create a service type" call for them either had to guess a
-- category ID (and typically guessed wrong / guessed another company's ID)
-- or had literally nothing to reference.
--
-- Resolves each company's own category IDs by NAME, never hardcoded —
-- every company has a different generated ID for "Billable" etc. Skips a
-- company already holding a given service type name (ON CONFLICT on
-- uq_service_types_company_name), so this is safe to re-run and safe for
-- companies that already have some/all of these.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  comp RECORD;
  cat_billable INT;
  cat_non_billable INT;
  cat_customer_non_billable INT;
  fallback_user INT;
BEGIN
  FOR comp IN SELECT id FROM companies WHERE is_deleted = false LOOP
    SELECT id INTO cat_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Billable' AND is_deleted = false
      LIMIT 1;

    SELECT id INTO cat_non_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Non-Billable' AND is_deleted = false
      LIMIT 1;

    SELECT id INTO cat_customer_non_billable
      FROM service_categories
      WHERE company_id = comp.id AND name = 'Customer Non-Billable' AND is_deleted = false
      LIMIT 1;

    -- created_by/updated_by are nullable — best-effort attribute to any user
    -- of this company, never blocks the insert if none is found.
    SELECT id INTO fallback_user FROM users WHERE company_id = comp.id ORDER BY id LIMIT 1;

    IF cat_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by)
      VALUES
        (comp.id, 'Project',            cat_billable, fallback_user, fallback_user),
        (comp.id, 'Service Pack',       cat_billable, fallback_user, fallback_user),
        (comp.id, 'Staff Augmentation', cat_billable, fallback_user, fallback_user),
        (comp.id, 'AMC',                cat_billable, fallback_user, fallback_user)
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;

    IF cat_non_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by)
      VALUES
        (comp.id, 'Internal Support', cat_non_billable, fallback_user, fallback_user),
        (comp.id, 'Team Management',  cat_non_billable, fallback_user, fallback_user),
        (comp.id, 'Leaves',           cat_non_billable, fallback_user, fallback_user),
        (comp.id, 'L&D',              cat_non_billable, fallback_user, fallback_user),
        (comp.id, 'Others',           cat_non_billable, fallback_user, fallback_user)
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;

    IF cat_customer_non_billable IS NOT NULL THEN
      INSERT INTO service_types (company_id, service_type_name, service_category_id, created_by, updated_by)
      VALUES
        (comp.id, 'Customer Work',                              cat_customer_non_billable, fallback_user, fallback_user),
        (comp.id, 'Complimentary Hours',                        cat_customer_non_billable, fallback_user, fallback_user),
        (comp.id, 'Product/Solution/Framework Development',     cat_customer_non_billable, fallback_user, fallback_user)
      ON CONFLICT (company_id, service_type_name) DO NOTHING;
    END IF;
  END LOOP;
END $$;

COMMIT;
