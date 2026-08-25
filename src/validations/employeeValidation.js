'use strict';

const Joi = require('joi');

/**
 * Employee Validation Schemas
 */

const employeeCodePattern = /^[A-Z0-9_/#-]{2,20}$/;

// Reusable sub-schemas
const passwordField = Joi.string().min(8).max(72).messages({
  'string.min': 'Password must be at least 8 characters.',
  'string.max': 'Password cannot exceed 72 characters.',
});

// Employee's own native login email — Employee is the sole login identity
// now (Employee-as-Identity redesign, database/migrations/
// 20260864-20260880); there is no more linked User account.
const employeeEmailField = Joi.string()
  .trim()
  .lowercase()
  .email({ tlds: { allow: false } })
  .max(100)
  .messages({
    'string.email': 'Email must be a valid email address.',
    'string.max': 'Email cannot exceed 100 characters.',
  });

const managerIdField = Joi.number().integer().positive().messages({
  'number.base': 'Must be a positive integer employee ID.',
});

const roleIdsField = Joi.array().items(Joi.number().integer().positive()).messages({
  'array.base': 'role_ids must be an array of role IDs.',
});

const businessUnitIdsField = Joi.array().items(Joi.number().integer().positive()).messages({
  'array.base': 'business_unit_ids must be an array of Business Unit (Company) IDs.',
});

const experienceField = Joi.number()
  .precision(1)
  .min(0)
  .max(60)
  .messages({
    'number.base': 'Experience must be a number.',
    'number.min': 'Experience cannot be negative.',
    'number.max': 'Experience cannot exceed 60 years.',
  });

/**
 * POST /employees
 */
const createEmployeeSchema = Joi.object({
  employee_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(employeeCodePattern)
    .required()
    .messages({
      'string.pattern.base': 'Employee code must be 2-20 uppercase alphanumeric characters (- / # _ allowed).',
      'any.required': 'Employee code is required.',
    }),

  full_name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .required()
    .messages({
      'string.min': 'Full name must be at least 2 characters.',
      'string.max': 'Full name cannot exceed 100 characters.',
      'any.required': 'Full name is required.',
    }),

  designation: Joi.string()
    .trim()
    .max(100)
    .optional()
    .allow('', null)
    .messages({
      'string.max': 'Designation cannot exceed 100 characters.',
    }),

  total_experience: experienceField.optional().allow(null),

  company_experience: experienceField
    .optional()
    .allow(null)
    .when('total_experience', {
      is: Joi.number().required(),
      then: Joi.number()
        .max(Joi.ref('total_experience'))
        .messages({
          'number.max': 'Company experience cannot exceed total experience.',
        }),
    }),

  resource_description: Joi.string()
    .trim()
    .max(2000)
    .optional()
    .allow('', null)
    .messages({
      'string.max': 'Resource description cannot exceed 2000 characters.',
    }),

  date_of_joining: Joi.date()
    .iso()
    .max('now')
    .optional()
    .allow(null)
    .messages({
      'date.base': 'Date of joining must be a valid date.',
      'date.format': 'Date of joining must be in ISO format (YYYY-MM-DD).',
      'date.max': 'Date of joining cannot be in the future.',
    }),

  date_of_leaving: Joi.date()
    .iso()
    .min(Joi.ref('date_of_joining'))
    .optional()
    .allow(null)
    .messages({
      'date.base': 'Date of leaving must be a valid date.',
      'date.format': 'Date of leaving must be in ISO format (YYYY-MM-DD).',
      'date.min': 'Date of leaving must be on or after the date of joining.',
    }),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive')
    .default('active')
    .messages({
      'any.only': 'Status must be either "active" or "inactive".',
    }),

  // ── Native login credentials — see database/migrations/
  // 20260864_add_employee_login_columns.sql.
  email: employeeEmailField.required().messages({
    'any.required': 'Email is required to create the Employee\'s login account.',
  }),

  // Optional — if omitted, a temporary password is generated and returned
  // ONCE in the create response (never retrievable again).
  password: passwordField.optional(),

  // ── Roles (employee_roles) — optional; omitted/empty defaults to the
  // single "Employee" role (see employeeService.js's
  // resolveDefaultRoleIds()). At most one supplied role may be senior-tier
  // (Platform Admin/Admin/Entity Admin/BU Admin) — enforced in
  // employeeService.js.
  role_ids: roleIdsField.optional(),

  // ── Business Units (employee_business_units) — fully optional. BU
  // mapping is done separately (a dedicated mapping flow, not this form) —
  // the caller's own company_id is still auto-injected if present (see
  // employeeService.js's resolveBusinessUnitIds()), but an Employee can be
  // created with no BUs at all.
  business_unit_ids: businessUnitIdsField.optional(),

  // ── Manager assignment — both optional. When provided, must belong to
  // the same Company (enforced in employeeService.js) and hold a role
  // capable of managing Employees (Manager or above). An Employee can be
  // created with no manager assigned yet and have one set later via update.
  primary_manager_employee_id: managerIdField.optional().allow(null),
  secondary_manager_employee_id: managerIdField.optional().allow(null)
    .invalid(Joi.ref('primary_manager_employee_id'))
    .messages({
      'any.invalid': 'Secondary Manager must be different from the Primary Manager.',
    }),

  // Whether this employee's timesheets require approval (held back until
  // explicitly Published) or are auto-published immediately — see
  // src/utils/timesheetPublishPolicy.js. Defaults to true (require
  // approval) — the safer default when the caller doesn't specify.
  is_timesheet_approval_required: Joi.boolean().optional().default(true).messages({
    'boolean.base': 'is_timesheet_approval_required must be true or false.',
  }),
});

/**
 * PUT /employees/:id
 * All fields optional, but at least one required.
 */
const updateEmployeeSchema = Joi.object({
  employee_code: Joi.string()
    .trim()
    .uppercase()
    .pattern(employeeCodePattern)
    .optional()
    .messages({
      'string.pattern.base': 'Employee code must be 2-20 uppercase alphanumeric characters (- / # _ allowed).',
    }),

  full_name: Joi.string()
    .trim()
    .min(2)
    .max(100)
    .optional()
    .messages({
      'string.min': 'Full name must be at least 2 characters.',
      'string.max': 'Full name cannot exceed 100 characters.',
    }),

  designation: Joi.string()
    .trim()
    .max(100)
    .optional()
    .allow('', null),

  total_experience: experienceField.optional().allow(null),

  company_experience: experienceField.optional().allow(null),

  resource_description: Joi.string()
    .trim()
    .max(2000)
    .optional()
    .allow('', null),

  date_of_joining: Joi.date()
    .iso()
    .max('now')
    .optional()
    .allow(null),

  date_of_leaving: Joi.date()
    .iso()
    .optional()
    .allow(null),

  status: Joi.string()
    .trim()
    .lowercase()
    .valid('active', 'inactive')
    .optional()
    .messages({
      'any.only': 'Status must be either "active" or "inactive".',
    }),

  // Reassign Primary/Secondary Manager — same validation as create (same
  // company, capable role). Pass secondary_manager_employee_id: null to clear it.
  primary_manager_employee_id: managerIdField.optional(),
  secondary_manager_employee_id: managerIdField.optional().allow(null),

  // Full-replace (diff-sync) semantics — resending role_ids/business_unit_ids
  // replaces the employee's ENTIRE set; omitting either leaves it untouched.
  // An explicitly empty role_ids defaults back to the "Employee" role
  // rather than being rejected (see employeeService.js's resolveDefaultRoleIds()).
  role_ids: roleIdsField.optional(),
  business_unit_ids: businessUnitIdsField.optional(),

  // Updates the Employee's own native login email. Validated for
  // uniqueness against other employees in employeeService.js.
  email: employeeEmailField.optional(),

  // Changing this updates the employee's approval configuration — see
  // src/utils/timesheetPublishPolicy.js. Only affects NEW timesheets
  // created/imported/synced after the change; existing rows are untouched.
  is_timesheet_approval_required: Joi.boolean().optional().messages({
    'boolean.base': 'is_timesheet_approval_required must be true or false.',
  }),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * GET /employees — query params schema
 */
const listEmployeesQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  designation: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string()
    .valid('full_name', 'employee_code', 'date_of_joining', 'created_at', 'designation')
    .default('full_name'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('ASC'),
});

module.exports = {
  createEmployeeSchema,
  updateEmployeeSchema,
  listEmployeesQuerySchema,
};
