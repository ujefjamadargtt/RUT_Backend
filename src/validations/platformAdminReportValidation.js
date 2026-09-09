'use strict';

const Joi = require('joi');

/**
 * Validation schemas for Platform Admin's "Total Admins" and "Employee Work
 * Log" report tabs (see platformAdmin.routes.js).
 */

const listTotalAdminsQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  sort_by: Joi.string().valid('email', 'created_at', 'full_name', 'employee_code').default('created_at'),
  sort_order: Joi.string().valid('ASC', 'DESC', 'asc', 'desc').default('DESC'),
});

const employeeWorkLogSyncedQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).required(),
  year: Joi.number().integer().min(2000).required(),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
  sortBy: Joi.string().valid('employee_name', 'employee_code', 'total_hours').default('employee_name'),
  sortOrder: Joi.string().valid('ASC', 'DESC').default('ASC'),
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(200).default(20),
});

const employeeWorkLogSyncedExportQuerySchema = Joi.object({
  month: Joi.number().integer().min(1).max(12).required(),
  year: Joi.number().integer().min(2000).required(),
  status: Joi.string().valid('active', 'inactive', 'all').default('active'),
  search: Joi.string().trim().max(100).optional().allow(''),
});

module.exports = {
  listTotalAdminsQuerySchema,
  employeeWorkLogSyncedQuerySchema,
  employeeWorkLogSyncedExportQuerySchema,
};
