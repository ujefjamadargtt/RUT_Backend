'use strict';

const { Op } = require('sequelize');
const { TimesheetImportHistory, TimesheetImportError, User, Employee, Company, sequelize } = require('../models');
const { QueryTypes } = require('sequelize');

/**
 * Timesheet Import Repository
 * Raw database access for timesheet_import_history and timesheet_import_errors.
 * No business logic lives here.
 */

/**
 * Builds a `company_id` WHERE fragment — Op.in-aware for an array (a
 * company-less Admin/Entity Admin's resolved owned-Company-id scope, see
 * companyAccessControlService.resolveActorCompanyScope), plain equality for
 * a number. Deliberately has NO "omit the filter when undefined" fallback
 * (unlike employeeRepository.js's companyScope) — every function below
 * touches timesheet import history/errors/files, which must always be
 * company-scoped; a caller that hasn't resolved a real scope should get a
 * thrown "invalid undefined value" error, not a silently unscoped
 * read/write/delete across every tenant's import batches (the
 * GET/PUT/DELETE /timesheets/import cross-tenant leak fix).
 *
 * @param {number|number[]} companyId
 * @returns {object}
 */
function companyScope(companyId) {
  if (Array.isArray(companyId)) {
    return { company_id: { [Op.in]: companyId } };
  }
  return { company_id: companyId };
}

/**
 * Insert a new import history record.
 *
 * @param {object} data
 * @param {number} data.imported_by  - User ID
 * @param {string} data.file_name
 * @param {string} data.file_path
 * @param {number} data.total_rows
 * @param {number} data.valid_rows
 * @param {number} data.error_rows
 * @param {string} data.status       - 'pending' | 'processing' | 'completed' | 'failed'
 * @returns {Promise<TimesheetImportHistory>}
 */
const createImportHistory = async (data) => {
  return TimesheetImportHistory.create(data);
};

/**
 * Update an existing import history record.
 *
 * @param {number} id
 * @param {object} data  - Partial fields to update
 * @param {object} [transaction]
 * @returns {Promise<TimesheetImportHistory|null>}
 */
const updateImportHistory = async (id, data, transaction = null, companyId) => {
  const where = { id, ...companyScope(companyId) };
  const record = await TimesheetImportHistory.findOne({ where, ...(transaction ? { transaction } : {}) });
  if (!record) return null;
  return record.update(data, transaction ? { transaction } : {});
};

/**
 * Bulk-insert error rows for a given import.
 * Each item in `errors` must include import_id, row_number, row_data, error_message.
 *
 * @param {object[]} errors
 * @returns {Promise<TimesheetImportError[]>}
 */
const createImportErrors = async (errors) => {
  if (!errors || errors.length === 0) return [];
  return TimesheetImportError.bulkCreate(errors, { validate: true, returning: true });
};

/**
 * Fetch a single import history record by primary key, including all error rows.
 *
 * @param {number} id
 * @returns {Promise<TimesheetImportHistory|null>}
 */
const findImportById = async (id, companyId) => {
  const where = { id, ...companyScope(companyId) };
  return TimesheetImportHistory.findOne({
    where,
    include: [
      {
        model: TimesheetImportError,
        as: 'errors',
        attributes: ['id', 'row_number', 'row_data', 'error_message', 'created_at'],
        order: [['row_number', 'ASC']],
        required: false,
      },
      {
        model: User,
        as: 'importer',
        attributes: ['id', 'email'],
        required: false,
        include: [
          {
            model: Employee,
            as: 'employee',
            attributes: ['id', 'full_name', 'employee_code'],
            required: false,
          },
        ],
      },
    ],
  });
};

/**
 * Fetch a paginated list of all import history records, newest first.
 *
 * When `companyId` resolves to MORE THAN ONE Business Unit (the
 * authenticateReadMultiBU "All BU" case — see timesheet.routes.js), each
 * row's own Company is also joined in as `company` ({id, company_code,
 * company_name}) — without it, two different BUs' same-named "Aug.xlsx"
 * rows would be visually indistinguishable in a combined list. Omitted
 * for the single-BU case (a plain number, or an array already narrowed to
 * exactly one id) since there's no ambiguity to resolve there and it's one
 * less join on the far more common request shape.
 *
 * @param {object} pagination     - { limit, offset }
 * @param {object} [filters]      - { month, year, companyId } — companyId is
 *   number|number[] (see companyScope()'s doc comment); month/year filter on
 *   import_month/import_year
 * @returns {Promise<{ rows: TimesheetImportHistory[], count: number }>}
 */
const findAllImports = async (pagination = {}, filters = {}) => {
  const { limit = 20, offset = 0 } = pagination;
  const { month, year, companyId } = filters;

  const where = { ...companyScope(companyId) };
  if (month) where.import_month = month;
  if (year) where.import_year = year;

  const isMultiBU = Array.isArray(companyId) && companyId.length > 1;

  const include = [
    {
      model: User,
      as: 'importer',
      attributes: ['id', 'email'],
      required: false,
      include: [
        {
          model: Employee,
          as: 'employee',
          attributes: ['id', 'full_name', 'employee_code'],
          required: false,
        },
      ],
    },
  ];

  if (isMultiBU) {
    include.push({
      model: Company,
      as: 'company',
      attributes: ['id', 'company_code', 'company_name'],
      required: false,
    });
  }

  return TimesheetImportHistory.findAndCountAll({
    where,
    include,
    limit,
    offset,
    order: [['created_at', 'DESC']],
    distinct: true,
  });
};

/**
 * Count distinct employees covered by each import batch, for a given set of
 * import IDs. Used to annotate the import history list with a total_employees
 * figure without an N+1 query per row.
 *
 * @param {number[]} importIds
 * @param {number|number[]} companyId
 * @returns {Promise<Map<number, number>>} import_id -> distinct employee count
 */
const getEmployeeCountsByImportIds = async (importIds, companyId) => {
  const counts = new Map();
  if (!importIds || importIds.length === 0) return counts;

  const companyIds = Array.isArray(companyId) ? companyId : [companyId];
  const rows = await sequelize.query(
    `SELECT timesheet_import_id, COUNT(DISTINCT employee_id) AS total_employees
     FROM timesheets
     WHERE timesheet_import_id IN (:importIds) AND company_id IN (:companyIds)
     GROUP BY timesheet_import_id`,
    { replacements: { importIds, companyIds }, type: QueryTypes.SELECT }
  );

  rows.forEach((r) => {
    counts.set(r.timesheet_import_id, parseInt(r.total_employees, 10));
  });

  return counts;
};

/**
 * Delete timesheet_import_errors rows for one or more import batches.
 *
 * NOTE: fk_tie_import (timesheet_import_errors.import_id -> timesheet_import_history.id)
 * is declared ON DELETE CASCADE at the DB level, so this call is technically
 * redundant with deleteImportsById() below — but it is kept explicit (and run
 * first, in the same transaction) so the reported deletedErrorRows count is
 * accurate and the deletion doesn't silently depend on the DB cascade alone.
 *
 * @param {number[]} importIds
 * @param {object}   [transaction]
 * @returns {Promise<number>} number of deleted error rows
 */
const deleteErrorsByImportIds = async (importIds, transaction = null, companyId) => {
  if (!importIds || importIds.length === 0) return 0;
  const where = { import_id: { [Op.in]: importIds }, ...companyScope(companyId) };
  return TimesheetImportError.destroy({
    where,
    ...(transaction ? { transaction } : {}),
  });
};

/**
 * Find the existing INCOMPLETE import history record for one
 * company/month/year/source combination, if any — the lookup behind the
 * "Sync Employee Work Logs" idempotency rule: there must only ever be ONE
 * IN-PROGRESS Sync import per Company + Month + Year, so a repeat sync
 * UPDATES this row instead of creating a new one (see
 * timesheetService.previewPmsImport/runImportPreview). A previously
 * 'pending', 'processing', or 'failed' attempt is safe to reuse/reset back
 * to 'pending' — nothing has ever been committed to `timesheets` for it.
 *
 * Deliberately EXCLUDES 'completed'/'partial' rows: those already have real
 * timesheets rows linked via timesheet_import_id (confirmImport() actually
 * ran). Reusing/overwriting one back to 'pending' here would silently
 * disconnect that live, already-committed data from its own history
 * record — the reported bug where an import that had successfully
 * confirmed (0 errors, all rows inserted) reverted to 'pending' forever
 * the moment Sync was previewed again for the same month, even though
 * nothing about the already-imported data changed. A repeat preview over
 * an already-completed period instead falls through to creating a NEW
 * history row (below) — confirmImport()'s own full-replace logic
 * (deleteImportsByIds) is what correctly retires the old completed row for
 * this period, at the moment the NEW one is actually confirmed, not
 * eagerly on a read-ish preview call.
 *
 * @param {number} companyId
 * @param {number} month
 * @param {number} year
 * @param {string} source - 'excel' | 'pms'
 * @returns {Promise<TimesheetImportHistory|null>}
 */
const findByMonthYearSource = async (companyId, month, year, source) => {
  return TimesheetImportHistory.findOne({
    where: {
      company_id: companyId,
      import_month: month,
      import_year: year,
      source,
      status: { [Op.notIn]: ['completed', 'partial'] },
    },
    order: [['id', 'DESC']],
  });
};

/**
 * Fetch multiple import history records by their IDs (no associations).
 * Used by the monthly-sheet delete API to look up file_path/file_name
 * for each import before removing the DB rows and the files on disk.
 *
 * @param {number[]} ids
 * @returns {Promise<TimesheetImportHistory[]>}
 */
const findImportsByIds = async (ids, companyId) => {
  if (!ids || ids.length === 0) return [];
  const where = { id: { [Op.in]: ids }, ...companyScope(companyId) };
  return TimesheetImportHistory.findAll({ where });
};

/**
 * Delete import history record(s) by ID — no exclusions.
 * timesheet_import_errors rows are removed automatically via ON DELETE CASCADE.
 * Used by the public monthly-sheet delete API (single ID or many at once).
 *
 * @param {number[]} ids
 * @param {object}   [transaction]
 * @returns {Promise<number>} number of deleted records
 */
const deleteImportsById = async (ids, transaction = null, companyId) => {
  if (!ids || ids.length === 0) return 0;
  const where = { id: { [Op.in]: ids }, ...companyScope(companyId) };
  return TimesheetImportHistory.destroy({
    where,
    ...(transaction ? { transaction } : {}),
  });
};

/**
 * Delete import history records by their IDs, excluding one (the current import).
 * timesheet_import_errors rows are removed automatically via ON DELETE CASCADE.
 *
 * @param {number[]} ids        - IDs to delete
 * @param {number}   excludeId  - The current import being confirmed — never deleted
 * @param {object}   [transaction]
 * @returns {Promise<number>} number of deleted records
 */
const deleteImportsByIds = async (ids, excludeId, transaction = null, companyId) => {
  const targets = ids.filter((id) => id !== excludeId);
  if (!targets.length) return 0;
  const where = { id: { [Op.in]: targets }, ...companyScope(companyId) };
  return TimesheetImportHistory.destroy({
    where,
    ...(transaction ? { transaction } : {}),
  });
};

/**
 * Check whether every COMPLETED timesheet_import_history batch touching the
 * given (year, month) pairs has been published. A month with zero completed
 * import batches at all, or with at least one completed batch still
 * unpublished, counts as NOT published — the safest default: "no data yet"
 * and "partially published" both mean there's nothing guaranteed-complete
 * to show.
 *
 * Only status = 'completed' batches count — a 'pending'/'processing'/
 * 'failed' import was never confirmed (confirmImport() never ran for it, so
 * it has zero associated timesheets rows) and doesn't represent real data
 * that could be published. Without this filter, an abandoned/never-finished
 * upload sitting in 'pending' would incorrectly block an otherwise fully
 * published month forever, since it can never be "published" (there's
 * nothing there to publish).
 *
 * @param {{ year: number, month: number }[]} yearMonths - distinct periods to check
 * @returns {Promise<boolean>} true only if every given month has at least
 *   one completed import AND all completed imports for every given month
 *   are published
 */
const arePeriodsFullyPublished = async (yearMonths, companyId) => {
  if (!yearMonths || yearMonths.length === 0) return true;

  const where = {
    status: 'completed',
    [Op.or]: yearMonths.map(({ year, month }) => ({ import_year: year, import_month: month })),
    ...companyScope(companyId),
  };

  const rows = await TimesheetImportHistory.findAll({
    attributes: ['import_year', 'import_month', 'is_publish'],
    where,
  });

  const monthsWithImports = new Set();
  let anyUnpublished = false;
  for (const row of rows) {
    monthsWithImports.add(`${row.import_year}-${row.import_month}`);
    if (!row.is_publish) anyUnpublished = true;
  }

  const everyMonthHasAnImport = yearMonths.every(({ year, month }) => monthsWithImports.has(`${year}-${month}`));

  return everyMonthHasAnImport && !anyUnpublished;
};

module.exports = {
  createImportHistory,
  updateImportHistory,
  createImportErrors,
  findImportById,
  findByMonthYearSource,
  findAllImports,
  findImportsByIds,
  getEmployeeCountsByImportIds,
  arePeriodsFullyPublished,
  deleteImportsByIds,
  deleteImportsById,
  deleteErrorsByImportIds,
};