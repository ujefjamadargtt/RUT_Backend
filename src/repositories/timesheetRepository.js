'use strict';

const { Op, fn, col, literal } = require('sequelize');
const {
  Timesheet,
  Employee,
  ServicePO,
  SubProject,
  Client,
  ServiceType,
  ServiceCategory,
  sequelize,
} = require('../models');

/**
 * Timesheet Repository
 * Raw database access — no business logic.
 */

// Service PO statuses eligible for timesheet logging — every status except
// the two terminal/locked ones (cancelled, closed; see servicePOService.js's
// own update() guard, which treats exactly these two as locked). A
// 'completed' PO is still loggable — completion is not the same as
// cancelled/closed here. Shared by the Excel import's validateRows()
// (timesheetService.js) and the manual single-entry create path
// (findEligibleServicePOById below) so both paths can never silently drift
// apart on which PO statuses are loggable.
const ELIGIBLE_PO_STATUSES = ['in-progress', 'on-hold', 'pending', 'completed'];

/**
 * Fetch a single active, non-deleted employee by ID — the same eligibility
 * rule the Excel import's validateRows() applies when resolving an employee
 * by employee_code, just looked up directly by ID since the manual-entry API
 * already has a concrete ID (e.g. from an Admin Panel dropdown) rather than
 * free text needing to be matched.
 *
 * @param {number} id
 * @returns {Promise<Employee|null>}
 */
const findEligibleEmployeeById = async (id, companyId) => {
  return Employee.findOne({
    where: { id, status: 'active', is_deleted: false, company_id: companyId },
  });
};

/**
 * Fetch a single eligible Service PO by ID, with its Client, SubProjects, and
 * ServiceType -> ServiceCategory — the same eligibility rule (status in
 * ELIGIBLE_PO_STATUSES, not deleted) and the same associations the Excel
 * import's validateRows() resolves when a PO is matched by name. Used by the
 * manual single-entry create path to validate the selected project belongs
 * to the selected client, and the selected Service Type belongs to the
 * selected Service Category, exactly as the import implicitly guarantees by
 * only ever reading these values off the one resolved PO.
 *
 * @param {number} id
 * @returns {Promise<ServicePO|null>}
 */
const findEligibleServicePOById = async (id, companyId) => {
  return ServicePO.findOne({
    where: {
      id,
      status: { [Op.in]: ELIGIBLE_PO_STATUSES },
      is_deleted: false,
      company_id: companyId,
    },
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_name'],
      },
      {
        model: SubProject,
        as: 'subProjects',
        attributes: ['id', 'sub_project_name', 'status'],
        required: false,
      },
      {
        model: ServiceType,
        as: 'serviceType',
        attributes: ['id', 'service_type_name', 'service_category_id'],
        required: false,
        include: [
          {
            model: ServiceCategory,
            as: 'serviceCategory',
            attributes: ['id', 'name'],
            required: false,
          },
        ],
      },
    ],
  });
};

// ── Allowed sort columns (whitelist to prevent SQL injection) ─────────────────
const ALLOWED_SORT_COLUMNS = new Set([
  'timesheet_date',
  'hours_logged',
  'created_at',
]);

/**
 * Build the common `include` array used by findAll, findById, and
 * findByImportBatch.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.includeServiceCategory=false] - Also nest
 *   servicePO.serviceType.serviceCategory (one extra LEFT JOIN via the
 *   existing ServicePO->ServiceType->ServiceCategory relationships — no
 *   extra query, so no N+1). Opt-in and off by default so findAll/findById
 *   keep their exact current response shape; only findByImportBatch
 *   (GET /timesheets/import/:id/rows) turns it on.
 * @returns {object[]}
 */
function buildIncludes({ includeServiceCategory = false } = {}) {
  const servicePOInclude = {
    model: ServicePO,
    as: 'servicePO',
    attributes: [
      'id',
      'service_po_code',
      'service_po_name',
      'is_billable',
      'status',
    ],
    include: [
      {
        model: Client,
        as: 'client',
        attributes: ['id', 'client_code', 'client_name'],
      },
    ],
  };

  if (includeServiceCategory) {
    servicePOInclude.include.push({
      model: ServiceType,
      as: 'serviceType',
      attributes: ['id', 'service_type_name'],
      required: false,
      include: [
        {
          model: ServiceCategory,
          as: 'serviceCategory',
          attributes: ['id', 'name'],
          required: false,
        },
      ],
    });
  }

  return [
    {
      model: Employee,
      as: 'employee',
      attributes: ['id', 'employee_code', 'full_name', 'designation', 'status'],
    },
    servicePOInclude,
    {
      model: SubProject,
      as: 'subProject',
      attributes: [
        'id',
        'sub_project_code',
        'sub_project_name',
        'status',
      ],
      required: false,
    },
  ];
}

/**
 * Fetch a paginated, filtered, sorted list of timesheets.
 *
 * @param {object} filters    - { startDate, endDate, employeeId, poId, subProjectId }
 * @param {object} pagination - { limit, offset }
 * @param {object} sort       - { sortBy, sortOrder }
 * @returns {Promise<{ rows: Timesheet[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { startDate, endDate, employeeId, poId, subProjectId, companyId } = filters;
  const { limit = 20, offset = 0 } = pagination;

  let { sortBy = 'timesheet_date', sortOrder = 'DESC' } = sort;
  if (!ALLOWED_SORT_COLUMNS.has(sortBy)) {
    sortBy = 'timesheet_date';
  }
  const order = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const where = { company_id: companyId };

  if (startDate) {
    where.timesheet_date = { ...where.timesheet_date, [Op.gte]: startDate };
  }
  if (endDate) {
    where.timesheet_date = { ...where.timesheet_date, [Op.lte]: endDate };
  }
  if (employeeId) {
    where.employee_id = parseInt(employeeId, 10);
  }
  if (poId) {
    where.service_po_id = parseInt(poId, 10);
  }
  if (subProjectId) {
    where.sub_project_id = parseInt(subProjectId, 10);
  }

  return Timesheet.findAndCountAll({
    where,
    include: buildIncludes(),
    limit,
    offset,
    order: [[sortBy, order]],
    distinct: true,
  });
};

/**
 * Fetch a single timesheet entry by primary key with full associations.
 * @param {number} id
 * @returns {Promise<Timesheet|null>}
 */
const findById = async (id, companyId) => {
  return Timesheet.findOne({
    where: { id, company_id: companyId },
    include: buildIncludes(),
  });
};

/**
 * Fetch multiple timesheet records by their IDs (no associations).
 * Used by the monthly-sheet delete API to detect the common mix-up of a
 * caller passing raw timesheets.id values instead of a
 * timesheet_import_history.id.
 *
 * @param {number[]} ids
 * @param {number} companyId
 * @returns {Promise<Timesheet[]>}
 */
const findByIds = async (ids, companyId) => {
  if (!ids || ids.length === 0) return [];
  return Timesheet.findAll({
    where: { id: { [Op.in]: ids }, company_id: companyId },
    attributes: ['id'],
  });
};

/**
 * Check whether a timesheet entry already exists for the given
 * employee / PO / date combination.
 *
 * The unique index `timesheets_employee_po_date_unique` enforces this at
 * the DB level; this function lets the service layer produce a friendly
 * error before the DB constraint fires.
 *
 * @param {number} employeeId
 * @param {number} poId
 * @param {string} date  - ISO date string (YYYY-MM-DD)
 * @param {number} [excludeId] - Exclude this ID from the check (used on updates)
 * @returns {Promise<Timesheet|null>}
 */
const checkDuplicate = async (employeeId, poId, date, excludeId = null, companyId) => {
  const where = {
    employee_id: employeeId,
    service_po_id: poId,
    timesheet_date: date,
    company_id: companyId,
  };

  if (excludeId) {
    where.id = { [Op.ne]: excludeId };
  }

  return Timesheet.findOne({ where });
};

/**
 * Insert a new timesheet record.
 * @param {object} data
 * @returns {Promise<Timesheet>}
 */
const create = async (data) => {
  return Timesheet.create(data);
};

/**
 * Bulk-insert timesheet records within a single transaction.
 * Each object in `records` must already be validated.
 *
 * @param {object[]} records
 * @param {object}   [transaction] - Sequelize transaction object
 * @returns {Promise<Timesheet[]>}
 */
const bulkCreate = async (records, transaction = null) => {
  return Timesheet.bulkCreate(records, {
    validate: true,
    returning: true,
    ...(transaction ? { transaction } : {}),
  });
};

/**
 * Update an existing timesheet by primary key.
 * @param {number} id
 * @param {object} data
 * @param {object} [transaction]
 * @returns {Promise<Timesheet|null>}
 */
const update = async (id, data, transaction = null, companyId) => {
  const where = { id };
  if (companyId !== undefined) where.company_id = companyId;
  const timesheet = await Timesheet.findOne({ where, ...(transaction ? { transaction } : {}) });
  if (!timesheet) return null;
  return timesheet.update(data, transaction ? { transaction } : {});
};

/**
 * Set is_publish = true for every timesheet row belonging to one import
 * batch, in a single UPDATE statement (PUT /timesheets/import/:id/publish).
 * Never touches hours_logged/modified_hours.
 *
 * @param {number} importId
 * @param {object} [transaction]
 * @returns {Promise<number>} number of rows updated
 */
const publishByImportId = async (importId, transaction = null, companyId) => {
  const where = { timesheet_import_id: importId };
  if (companyId !== undefined) where.company_id = companyId;
  const [count] = await Timesheet.update(
    { is_publish: true },
    {
      where,
      ...(transaction ? { transaction } : {}),
    }
  );
  return count;
};

/**
 * Force-publish a SINGLE timesheet row — the per-row analog of
 * publishByImportId above, used by the Manager "Approve" action
 * (src/services/managerSelfServiceService.js's approveTimesheet()) to
 * approve one employee's one timesheet entry without touching every other
 * row in that entry's import batch.
 * @param {number} id
 * @param {number} companyId
 * @param {object} [transaction]
 * @returns {Promise<number>} number of rows updated (0 or 1)
 */
const publishById = async (id, companyId, transaction = null) => {
  const [count] = await Timesheet.update(
    { is_publish: true },
    {
      where: { id, company_id: companyId },
      ...(transaction ? { transaction } : {}),
    }
  );
  return count;
};

/**
 * Hard-delete a timesheet record.
 * @param {number} id
 * @param {number} companyId
 * @returns {Promise<number>} 1 if deleted, 0 if not found.
 */
const deleteById = async (id, companyId) => {
  return Timesheet.destroy({ where: { id, company_id: companyId } });
};

/**
 * Hard-delete all timesheet rows belonging to one or more import batches
 * (identified by timesheet_import_id). Used when deleting a "monthly sheet"
 * (a TimesheetImportHistory record) so its child timesheet rows go with it.
 *
 * @param {number[]} importIds
 * @param {object} [transaction]
 * @param {number} companyId
 * @returns {Promise<number>} number of deleted rows
 */
const deleteByImportIds = async (importIds, transaction = null, companyId) => {
  if (!importIds || importIds.length === 0) return 0;
  const where = { timesheet_import_id: { [Op.in]: importIds } };
  if (companyId !== undefined) where.company_id = companyId;
  return Timesheet.destroy({
    where,
    ...(transaction ? { transaction } : {}),
  });
};

/**
 * Aggregate total hours grouped by employee for the given filters.
 *
 * @param {object} filters - { startDate, endDate, employeeId, poId }
 * @returns {Promise<Array<{ employeeId, employeeCode, fullName, totalHours }>>}
 */
const getSummaryByEmployee = async (filters = {}) => {
  const { startDate, endDate, employeeId, poId, companyId } = filters;

  const where = { company_id: companyId };
  if (startDate) where.timesheet_date = { ...where.timesheet_date, [Op.gte]: startDate };
  if (endDate)   where.timesheet_date = { ...where.timesheet_date, [Op.lte]: endDate };
  if (employeeId) where.employee_id = parseInt(employeeId, 10);
  if (poId)       where.service_po_id = parseInt(poId, 10);

  const rows = await Timesheet.findAll({
    attributes: [
      'employee_id',
      [fn('SUM', col('Timesheet.hours_logged')), 'total_hours'],
      [fn('COUNT', col('Timesheet.id')), 'entry_count'],
    ],
    where,
    include: [
      {
        model: Employee,
        as: 'employee',
        attributes: ['id', 'employee_code', 'full_name', 'designation'],
      },
    ],
    group: [
      'Timesheet.employee_id',
      'employee.id',
      'employee.employee_code',
      'employee.full_name',
      'employee.designation',
    ],
    order: [[fn('SUM', col('Timesheet.hours_logged')), 'DESC']],
    raw: false,
  });

  return rows;
};

/**
 * Aggregate total hours grouped by Service PO for the given filters.
 *
 * @param {object} filters - { startDate, endDate, employeeId, poId }
 * @returns {Promise<Array>}
 */
const getSummaryByPO = async (filters = {}) => {
  const { startDate, endDate, employeeId, poId, companyId } = filters;

  const where = { company_id: companyId };
  if (startDate) where.timesheet_date = { ...where.timesheet_date, [Op.gte]: startDate };
  if (endDate)   where.timesheet_date = { ...where.timesheet_date, [Op.lte]: endDate };
  if (employeeId) where.employee_id = parseInt(employeeId, 10);
  if (poId)       where.service_po_id = parseInt(poId, 10);

  const rows = await Timesheet.findAll({
    attributes: [
      'service_po_id',
      [fn('SUM', col('Timesheet.hours_logged')), 'total_hours'],
      [fn('COUNT', col('Timesheet.id')), 'entry_count'],
    ],
    where,
    include: [
      {
        model: ServicePO,
        as: 'servicePO',
        attributes: [
          'id',
          'service_po_code',
          'service_po_name',
          'is_billable',
          'status',
        ],
      },
    ],
    group: [
      'Timesheet.service_po_id',
      'servicePO.id',
      'servicePO.service_po_code',
      'servicePO.service_po_name',
      'servicePO.is_billable',
      'servicePO.status',
    ],
    order: [[fn('SUM', col('Timesheet.hours_logged')), 'DESC']],
    raw: false,
  });

  return rows;
};

/**
 * Get total logged hours for a specific employee in a given month/year.
 * If employeeId is omitted, returns the monthly total across all employees.
 * Pass excludeId (a timesheets.id) to leave that one record out of the sum —
 * used when validating an Update, where the record's OLD hours must not be
 * double-counted alongside the new hours being applied.
 *
 * @param {number} month      - 1-12
 * @param {number} year       - e.g. 2025
 * @param {number} [employeeId]
 * @param {number} [excludeId] - a timesheets.id to exclude from the sum
 * @returns {Promise<number>}  Total hours (or 0 if no entries found)
 */
const getMonthlyHours = async (month, year, employeeId = null, excludeId = null, companyId) => {
  const monthNum = parseInt(month, 10);
  const yearNum = parseInt(year, 10);
  if (!Number.isInteger(monthNum) || !Number.isInteger(yearNum)) {
    // month/year are interpolated directly into a raw SQL literal below, not
    // bound as query parameters — a non-numeric value (e.g. NaN from a
    // caller that passed a Date object through String()/split('-') instead
    // of extracting real numbers) would otherwise corrupt the query text
    // instead of failing safely.
    throw new Error(`getMonthlyHours: month/year must be numbers (got month=${month}, year=${year}).`);
  }

  const where = {
    [Op.and]: [
      literal(`EXTRACT(MONTH FROM timesheet_date) = ${monthNum}`),
      literal(`EXTRACT(YEAR  FROM timesheet_date) = ${yearNum}`),
    ],
    company_id: companyId,
  };

  if (employeeId) {
    where.employee_id = parseInt(employeeId, 10);
  }
  if (excludeId) {
    where.id = { [Op.ne]: parseInt(excludeId, 10) };
  }

  const result = await Timesheet.findOne({
    attributes: [[fn('SUM', col('hours_logged')), 'total_hours']],
    where,
    raw: true,
  });

  return parseFloat(result?.total_hours ?? 0) || 0;
};

/**
 * Get total logged hours for a specific employee within one specific
 * timesheet import batch (timesheet_import_id) — used to enforce the
 * 176-hour cap for a manually-created entry that's being attached to an
 * already-uploaded monthly sheet. The `timesheets` table has no soft-delete
 * flag, so every row for this (employee, import) pair is a live record.
 *
 * @param {number} employeeId
 * @param {number} timesheetImportId
 * @returns {Promise<number>} Total hours (or 0 if no entries found)
 */
const getImportHours = async (employeeId, timesheetImportId, companyId) => {
  const result = await Timesheet.findOne({
    attributes: [[fn('SUM', col('hours_logged')), 'total_hours']],
    where: {
      employee_id: parseInt(employeeId, 10),
      timesheet_import_id: parseInt(timesheetImportId, 10),
      company_id: companyId,
    },
    raw: true,
  });

  return parseFloat(result?.total_hours ?? 0) || 0;
};

/**
 * Return distinct non-null timesheet_import_id values for all timesheets
 * in a given month/year, scoped to one company. Used to identify old import
 * history records to clean up. Without the company_id filter this would
 * pick up every other company's import batches for the same month/year too.
 *
 * @param {number} month  - 1-12
 * @param {number} year
 * @param {object} [transaction]
 * @param {number} companyId
 * @returns {Promise<number[]>}
 */
const getImportIdsByMonth = async (month, year, transaction = null, companyId) => {
  const rows = await Timesheet.findAll({
    attributes: ['timesheet_import_id'],
    where: {
      [Op.and]: [
        literal(`EXTRACT(MONTH FROM timesheet_date) = ${parseInt(month, 10)}`),
        literal(`EXTRACT(YEAR  FROM timesheet_date) = ${parseInt(year, 10)}`),
        { timesheet_import_id: { [Op.not]: null } },
      ],
      company_id: companyId,
    },
    group: ['timesheet_import_id'],
    raw: true,
    ...(transaction ? { transaction } : {}),
  });
  return rows.map((r) => r.timesheet_import_id);
};

/**
 * Delete ALL timesheet records for a given month and year, scoped to one
 * company. Used by the import so re-uploading a monthly file fully replaces
 * the month's data for THAT company — employees absent from the new file
 * are removed. Without the company_id filter this would wipe every other
 * company's timesheets for the same month/year too — this was a real,
 * confirmed data-loss bug.
 *
 * @param {number} month  - 1-12
 * @param {number} year
 * @param {object} [transaction]
 * @param {number} companyId
 * @returns {Promise<number>} number of deleted rows
 */
const deleteByMonth = async (month, year, transaction = null, companyId) => {
  return Timesheet.destroy({
    where: {
      [Op.and]: [
        literal(`EXTRACT(MONTH FROM timesheet_date) = ${parseInt(month, 10)}`),
        literal(`EXTRACT(YEAR  FROM timesheet_date) = ${parseInt(year, 10)}`),
      ],
      company_id: companyId,
    },
    ...(transaction ? { transaction } : {}),
  });
};

/**
 * Fetch all timesheet records associated with a specific import batch.
 * Uses `timesheet_import_id` to link rows to the import history record.
 *
 * Each row's servicePO also carries its serviceType and, nested inside that,
 * serviceCategory (e.g. Billable / Non-Billable / Customer Non-Billable) —
 * fetched via the existing ServicePO -> ServiceType -> ServiceCategory
 * relationships in a single query (LEFT JOINs), not a per-row lookup.
 *
 * @param {number} importId
 * @returns {Promise<Timesheet[]>}
 */
const findByImportBatch = async (importId, companyId) => {
  return Timesheet.findAll({
    where: { timesheet_import_id: importId, company_id: companyId },
    include: buildIncludes({ includeServiceCategory: true }),
    order: [['timesheet_date', 'ASC']],
  });
};

/**
 * Whether ANY official timesheet row exists for a Service PO — one half of
 * the delete guard in servicePOService.delete() (the other half is
 * employeeWorkLogRepository.existsForServicePOOrHierarchy). The official
 * `timesheets` table has no hierarchy_node_id column (hierarchy tagging is
 * an Employee Self Timesheet / employee_work_logs-only concept), so this is
 * scoped to service_po_id alone.
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
const existsForServicePO = async (servicePOId, companyId) => {
  const row = await Timesheet.findOne({
    where: { service_po_id: servicePOId, company_id: companyId },
    attributes: ['id'],
  });
  return !!row;
};

module.exports = {
  findAll,
  findById,
  findByIds,
  checkDuplicate,
  create,
  bulkCreate,
  getImportIdsByMonth,
  deleteByMonth,
  update,
  publishByImportId,
  publishById,
  deleteById,
  deleteByImportIds,
  getSummaryByEmployee,
  getSummaryByPO,
  getMonthlyHours,
  getImportHours,
  findByImportBatch,
  findEligibleEmployeeById,
  findEligibleServicePOById,
  ELIGIBLE_PO_STATUSES,
  existsForServicePO,
};