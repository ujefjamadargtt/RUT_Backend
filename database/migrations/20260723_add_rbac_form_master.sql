BEGIN;

ALTER TABLE roles ADD COLUMN IF NOT EXISTS permission VARCHAR(20) NOT NULL DEFAULT 'Read';
ALTER TABLE roles DROP CONSTRAINT IF EXISTS chk_roles_permission;
ALTER TABLE roles ADD CONSTRAINT chk_roles_permission CHECK (permission IN ('Read', 'Read & Write'));

UPDATE roles
SET permission = 'Read & Write'
WHERE role_name IN ('Admin', 'Management', 'Manager', 'Division Head', 'Project Manager');

ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();
DROP TRIGGER IF EXISTS trg_user_roles_updated_at ON user_roles;
CREATE TRIGGER trg_user_roles_updated_at BEFORE UPDATE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS form_master (
  id SERIAL PRIMARY KEY,
  module_name VARCHAR(100) NOT NULL,
  form_name VARCHAR(150) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_form_master_module_form UNIQUE (module_name, form_name)
);
CREATE INDEX IF NOT EXISTS idx_form_master_status ON form_master (status);
CREATE INDEX IF NOT EXISTS idx_form_master_module_name ON form_master (module_name);
DROP TRIGGER IF EXISTS trg_form_master_updated_at ON form_master;
CREATE TRIGGER trg_form_master_updated_at BEFORE UPDATE ON form_master
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TABLE IF NOT EXISTS role_form_mapping (
  id SERIAL PRIMARY KEY,
  role_id INT NOT NULL REFERENCES roles (id) ON UPDATE CASCADE ON DELETE CASCADE,
  form_id INT NOT NULL REFERENCES form_master (id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_role_form_mapping_role_form UNIQUE (role_id, form_id)
);
CREATE INDEX IF NOT EXISTS idx_role_form_mapping_role_id ON role_form_mapping (role_id);
CREATE INDEX IF NOT EXISTS idx_role_form_mapping_form_id ON role_form_mapping (form_id);
DROP TRIGGER IF EXISTS trg_role_form_mapping_updated_at ON role_form_mapping;
CREATE TRIGGER trg_role_form_mapping_updated_at BEFORE UPDATE ON role_form_mapping
  FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMIT;
