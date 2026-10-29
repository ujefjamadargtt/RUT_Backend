-- Rollback for 20261028_add_ai_copilot_form.sql: removes the "AI Copilot" form and every role mapping to it.
-- Note: once removed, the aiCopilot routes (requireFormAccess) have nothing to match, so non-Platform-Admin
-- roles get 403 until the forward migration is re-applied or the guard is reverted.

BEGIN;

DELETE FROM role_form_mapping
WHERE form_id IN (
  SELECT id FROM form_master WHERE form_name = 'AI Copilot' AND module_name IS NOT NULL
);

DELETE FROM form_master
WHERE form_name = 'AI Copilot' AND module_name IS NOT NULL;

COMMIT;
