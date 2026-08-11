-- =============================================================================
-- Retroactively establish company_categories/company_types provenance for
-- every existing company's existing service_categories/service_types rows
-- that match a default by name — companies provisioned before this
-- migration never got a mapping row written (that only starts happening
-- going forward via companyService.js/serviceCategoryService.js/
-- serviceTypeService.js). Rows with no matching default name (genuinely
-- custom categories/types a company already created) are left unmapped,
-- exactly as a new custom category/type created after this migration would
-- be (default_*_id NULL) — this bulk pass only needs to backfill the
-- default-sourced ones.
--
-- service_categories/service_types themselves are read-only here — never
-- altered, never re-inserted, no ID ever changes.
--
-- Safe to re-run (ON CONFLICT DO NOTHING on both partial unique indexes).
-- =============================================================================

BEGIN;

DO $$
DECLARE
  comp RECORD;
  sc RECORD;
  st RECORD;
  matched_default_category_id INT;
  new_company_category_id INT;
  matched_default_type_id INT;
BEGIN
  FOR comp IN SELECT id FROM companies WHERE is_deleted = false LOOP
    -- One company_categories row per existing service_categories row that
    -- matches a default_categories name.
    FOR sc IN SELECT id, name FROM service_categories WHERE company_id = comp.id AND is_deleted = false LOOP
      SELECT id INTO matched_default_category_id FROM default_categories WHERE category_name = sc.name;

      IF matched_default_category_id IS NOT NULL THEN
        INSERT INTO company_categories (company_id, default_category_id, status, created_at, updated_at)
        VALUES (comp.id, matched_default_category_id, 'active', NOW(), NOW())
        ON CONFLICT (company_id, default_category_id) WHERE default_category_id IS NOT NULL DO NOTHING;
      END IF;
    END LOOP;

    -- One company_types row per existing service_types row that matches a
    -- default_types name — linked to this company's own company_categories
    -- row for that category (resolved by the type's own category name).
    FOR st IN
      SELECT t.id, t.service_type_name, c.name AS category_name
      FROM service_types t
      LEFT JOIN service_categories c ON c.id = t.service_category_id
      WHERE t.company_id = comp.id AND t.is_deleted = false
    LOOP
      SELECT id INTO matched_default_type_id FROM default_types WHERE type_name = st.service_type_name;

      IF matched_default_type_id IS NOT NULL AND st.category_name IS NOT NULL THEN
        SELECT cc.id INTO new_company_category_id
          FROM company_categories cc
          JOIN default_categories dc ON dc.id = cc.default_category_id
          WHERE cc.company_id = comp.id AND dc.category_name = st.category_name
          LIMIT 1;

        IF new_company_category_id IS NOT NULL THEN
          INSERT INTO company_types (company_category_id, default_type_id, status, created_at, updated_at)
          VALUES (new_company_category_id, matched_default_type_id, 'active', NOW(), NOW())
          ON CONFLICT (company_category_id, default_type_id) WHERE default_type_id IS NOT NULL DO NOTHING;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
