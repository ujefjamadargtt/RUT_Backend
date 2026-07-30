'use strict';

const Joi = require('joi');

/**
 * Monthly Cost Validation Schemas
 */

// Shared cost field — non-negative decimal with 2 decimal places, max 15 digits total
const costField = (label) =>
  Joi.number()
    .precision(2)
    .min(0)
    .max(999_999_999_999_999)
    .messages({
      'number.base': `${label} must be a number.`,
      'number.min': `${label} cannot be negative.`,
      'number.max': `${label} exceeds the maximum allowed value.`,
    });

/**
 * POST /monthly-costs — Create monthly cost record
 */
const createMonthlyCostSchema = Joi.object({
  employee_id: Joi.number()
    .integer()
    .positive()
    .required()
    .messages({
      'number.base': 'Employee ID must be a number.',
      'number.positive': 'Employee ID must be a positive integer.',
      'any.required': 'Employee is required.',
    }),

  month: Joi.number()
    .integer()
    .min(1)
    .max(12)
    .required()
    .messages({
      'number.base': 'Month must be a number.',
      'number.integer': 'Month must be a whole number.',
      'number.min': 'Month must be between 1 (January) and 12 (December).',
      'number.max': 'Month must be between 1 (January) and 12 (December).',
      'any.required': 'Month is required.',
    }),

  year: Joi.number()
    .integer()
    .min(2020)
    .max(2100)
    .required()
    .messages({
      'number.base': 'Year must be a number.',
      'number.integer': 'Year must be a whole number.',
      'number.min': 'Year must be 2020 or later.',
      'number.max': 'Year cannot exceed 2100.',
      'any.required': 'Year is required.',
    }),

  salary_cost: costField('Salary cost').required().messages({
    'any.required': 'Salary cost is required.',
  }),

  ops_cost: costField('Operational cost')
    .optional()
    .allow(null)
    .default(0),

  billable_cost: costField('Billable cost')
    .optional()
    .allow(null),
});

/**
 * PUT /monthly-costs/:id — Update monthly cost record
 * All fields optional, at least one required.
 */
const updateMonthlyCostSchema = Joi.object({
  employee_id: Joi.number()
    .integer()
    .positive()
    .optional()
    .messages({
      'number.base': 'Employee ID must be a number.',
      'number.positive': 'Employee ID must be a positive integer.',
    }),

  month: Joi.number()
    .integer()
    .min(1)
    .max(12)
    .optional()
    .messages({
      'number.min': 'Month must be between 1 and 12.',
      'number.max': 'Month must be between 1 and 12.',
    }),

  year: Joi.number()
    .integer()
    .min(2020)
    .max(2100)
    .optional()
    .messages({
      'number.min': 'Year must be 2020 or later.',
      'number.max': 'Year cannot exceed 2100.',
    }),

  salary_cost: costField('Salary cost').optional(),

  ops_cost: costField('Operational cost').optional().allow(null),

  billable_cost: costField('Billable cost').optional().allow(null),
})
  .min(1)
  .messages({
    'object.min': 'At least one field must be provided for update.',
  });

/**
 * POST /monthly-costs/bulk — Bulk upsert from Excel import
 */
const bulkMonthlyCostSchema = Joi.object({
  records: Joi.array()
    .items(
      Joi.object({
        employee_id: Joi.number().integer().positive().required(),
        month: Joi.number().integer().min(1).max(12).required(),
        year: Joi.number().integer().min(2020).max(2100).required(),
        salary_cost: costField('Salary cost').required(),
        ops_cost: costField('Operational cost').optional().allow(null),
        billable_cost: costField('Billable cost').optional().allow(null),
      })
    )
    .min(1)
    .max(500)
    .required()
    .messages({
      'array.min': 'At least one record is required.',
      'array.max': 'Cannot process more than 500 records at once.',
      'any.required': 'records array is required.',
    }),
});

/**
 * DELETE /monthly-costs — bulk delete by id(s)
 */
const idsField = Joi.alternatives()
  .try(
    Joi.array().items(Joi.number().integer().positive()).min(1),
    Joi.number().integer().positive()
  )
  .messages({
    'alternatives.match': 'ids must be a positive integer or a non-empty array of positive integers.',
  });

const bulkIdsSchema = Joi.object({
  ids: idsField,
  id: Joi.number().integer().positive().optional(),
})
  .or('ids', 'id')
  .messages({
    'object.missing': 'ids (or id) is required.',
  });

/**
 * :id path param — used by GET/PUT/DELETE /monthly-costs/:id
 */
const idParamSchema = Joi.object({
  id: Joi.number().integer().positive().required().messages({
    'number.base': 'id must be a number.',
    'number.positive': 'id must be a positive integer.',
    'any.required': 'id is required.',
  }),
});

/**
 * DELETE /monthly-costs/sheet — delete all records for given month(s)/year(s)
 */
const deleteBySheetSchema = Joi.object({
  months: Joi.array()
    .items(
      Joi.object({
        month: Joi.number().integer().min(1).max(12).required(),
        year: Joi.number().integer().min(2020).max(2100).required(),
      })
    )
    .min(1)
    .required()
    .messages({
      'array.min': 'At least one month/year entry is required.',
      'any.required': 'months array is required.',
    }),
});

/**
 * GET /monthly-costs — list query params
 */
const listMonthlyCostsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  employee_id: Joi.number().integer().positive().optional(),
  month: Joi.number().integer().min(1).max(12).optional(),
  year: Joi.number().integer().min(2020).max(2100).optional(),
  // Matches against the joined employee's full_name or employee_code.
  search: Joi.string().trim().max(100).optional().allow(''),
  // .empty('') treats an empty-string value (e.g. ?sort_by= sent by a UI
  // whose sort dropdown is unset, rather than omitting the param entirely)
  // the same as the key being absent, so the default below applies instead
  // of failing validation on an empty value that isn't in the enum.
  // 'employee' sorts by the joined employee's full_name (see
  // monthlyCostRepository.findAll()'s association-ordering branch).
  sort_by: Joi.string().valid('year', 'month', 'salary_cost', 'ops_cost', 'total_cost', 'billable_cost', 'created_at', 'employee').empty('').default('year'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').empty('').default('DESC'),
});

module.exports = {
  createMonthlyCostSchema,
  updateMonthlyCostSchema,
  bulkMonthlyCostSchema,
  bulkIdsSchema,
  deleteBySheetSchema,
  idParamSchema,
  listMonthlyCostsQuerySchema,
};
