-- =============================================================================
-- "AI Copilot" form — lets RBAC decide, role by role, who gets the floating AI
-- Copilot chat widget.
--
-- The frontend shows the widget only when the user's accessible forms contain a
-- form named exactly "AI Copilot" (case-sensitive); the aiCopilot routes enforce
-- the same rule on the server (middlewares/requireFormAccess.js). The form has no
-- page of its own and is not a sidebar item.
--
-- 1. Form Master row: module = the module "AI Insights" lives in (falls back to
--    'Core'), seq = next free position in that module.
-- 2. Default mapping: every role that currently has "AI Insights" actively mapped
--    also gets "AI Copilot", so nobody who sees the chatbot today loses it. After
--    this, admins change it from Role Form Mapping like any other form.
--
-- Safe to re-run: the form is only inserted when no "AI Copilot" form exists yet,
-- and existing mappings are left untouched (ON CONFLICT DO NOTHING), so a re-run
-- never creates duplicates or overrides a mapping an admin has since changed.
-- Roles are matched through the existing "AI Insights" mapping, never by id.
-- =============================================================================

BEGIN;

WITH target AS (
  SELECT COALESCE(
    (SELECT module_name FROM form_master
      WHERE form_name = 'AI Insights' AND module_name IS NOT NULL
      ORDER BY id LIMIT 1),
    'Core'
  ) AS module_name
)
INSERT INTO form_master (module_name, form_name, status, seq, created_at, updated_at)
SELECT
  t.module_name,
  'AI Copilot',
  'active',
  COALESCE((SELECT MAX(fm.seq) FROM form_master fm WHERE fm.module_name = t.module_name), 0) + 1,
  NOW(),
  NOW()
FROM target t
WHERE NOT EXISTS (
  SELECT 1 FROM form_master existing
  WHERE existing.form_name = 'AI Copilot' AND existing.module_name IS NOT NULL
)
ON CONFLICT (module_name, form_name) DO NOTHING;

INSERT INTO role_form_mapping (role_id, form_id, status, created_at, updated_at)
SELECT DISTINCT
  rfm.role_id,
  copilot.id,
  true,
  NOW(),
  NOW()
FROM role_form_mapping rfm
INNER JOIN form_master insights
  ON insights.id = rfm.form_id
 AND insights.form_name = 'AI Insights'
 AND insights.module_name IS NOT NULL
CROSS JOIN (
  SELECT id FROM form_master
  WHERE form_name = 'AI Copilot' AND module_name IS NOT NULL
  ORDER BY id LIMIT 1
) copilot
WHERE rfm.status = true
ON CONFLICT (role_id, form_id) DO NOTHING;

COMMIT;
