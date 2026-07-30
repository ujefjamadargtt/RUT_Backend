-- Rollback for 20260729_seed_company_admin_form_mapping.sql
DELETE FROM role_form_mapping
WHERE role_id = (SELECT id FROM roles WHERE role_name = 'Company Admin');
