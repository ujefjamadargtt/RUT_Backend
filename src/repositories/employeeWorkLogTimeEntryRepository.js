'use strict';

const { Op } = require('sequelize');
const { EmployeeWorkLogTimeEntry } = require('../models');

/**
 * Employee Work Log Time Entry Repository
 * Raw database access for `employee_work_log_time_entries` — the detailed
 * Start Time/End Time segments backing one `employee_work_logs` row (see
 * EmployeeWorkLogTimeEntry.js). Always scoped to a parent employee_work_log
 * id — ownership/company scoping is enforced one level up, by whichever
 * employeeWorkLogRepository call already resolved that parent row.
 */

/**
 * Bulk-insert every time entry for ONE parent employee_work_log row, in the
 * given transaction. Rows are pre-resolved (start_time/end_time/duration_hours
 * already computed server-side — see workLogTimeHelper.calculateHoursFromTimes)
 * by the service layer; this is a plain insert.
 * @param {number} employeeWorkLogId
 * @param {Array<{ entry_date: string, start_time: string, end_time: string, duration_hours: number, description: string }>} entries
 * @param {number} actorId
 * @param {object} transaction
 * @returns {Promise<EmployeeWorkLogTimeEntry[]>}
 */
const bulkCreate = async (employeeWorkLogId, entries, actorId, transaction) => {
  if (!entries || entries.length === 0) return [];
  return EmployeeWorkLogTimeEntry.bulkCreate(
    entries.map((entry) => ({
      employee_work_log_id: employeeWorkLogId,
      entry_date: entry.entry_date,
      start_time: entry.start_time,
      end_time: entry.end_time,
      duration_hours: entry.duration_hours,
      description: entry.description,
      created_by: actorId,
      updated_by: actorId,
    })),
    { transaction, returning: true }
  );
};

/**
 * Every time entry for one parent employee_work_log row, oldest start_time
 * first — the breakdown shown alongside that row's own aggregated `hours`.
 * @param {number} employeeWorkLogId
 * @returns {Promise<EmployeeWorkLogTimeEntry[]>}
 */
const findByWorkLogId = async (employeeWorkLogId) => {
  return EmployeeWorkLogTimeEntry.findAll({
    where: { employee_work_log_id: employeeWorkLogId },
    order: [['start_time', 'ASC'], ['id', 'ASC']],
  });
};

/**
 * Every time entry across several parent employee_work_log rows in one
 * query — used by list/report views that already fetched a page of
 * employee_work_logs rows and need each one's breakdown without N+1.
 * @param {number[]} employeeWorkLogIds
 * @returns {Promise<EmployeeWorkLogTimeEntry[]>}
 */
const findByWorkLogIds = async (employeeWorkLogIds) => {
  if (!employeeWorkLogIds || employeeWorkLogIds.length === 0) return [];
  return EmployeeWorkLogTimeEntry.findAll({
    where: { employee_work_log_id: { [Op.in]: employeeWorkLogIds } },
    order: [['employee_work_log_id', 'ASC'], ['start_time', 'ASC'], ['id', 'ASC']],
  });
};

/**
 * Hard-delete every time entry for ONE parent employee_work_log row — the
 * "replace the breakdown" half of an edit that supplies a new `time_entries`
 * array (employeeTimesheetService.updateEntry). Always paired, in the same
 * transaction, with a bulkCreate() of the new segments.
 * @param {number} employeeWorkLogId
 * @param {object} transaction
 * @returns {Promise<number>} rows deleted
 */
const deleteByWorkLogId = async (employeeWorkLogId, transaction) => {
  return EmployeeWorkLogTimeEntry.destroy({
    where: { employee_work_log_id: employeeWorkLogId },
    transaction,
  });
};

module.exports = {
  bulkCreate,
  findByWorkLogId,
  findByWorkLogIds,
  deleteByWorkLogId,
};
