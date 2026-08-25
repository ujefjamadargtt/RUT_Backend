-- Rollback for 20260881_add_form_master_categories.sql.
-- Drops the category_id column/constraint/index from form_master, then
-- drops the categories table and its trigger. No form_master row besides
-- the category_id column itself is touched — forms and modules are left
-- completely intact.

BEGIN;

ALTER TABLE form_master DROP CONSTRAINT IF EXISTS chk_form_master_category_requires_form_row;
DROP INDEX IF EXISTS idx_form_master_category_id;
ALTER TABLE form_master DROP COLUMN IF EXISTS category_id;

DROP TRIGGER IF EXISTS trg_categories_updated_at ON categories;
DROP INDEX IF EXISTS idx_categories_status;
DROP INDEX IF EXISTS idx_categories_module_id;
DROP TABLE IF EXISTS categories;

COMMIT;
