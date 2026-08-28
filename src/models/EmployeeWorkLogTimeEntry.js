'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Employee Work Log Time Entry — one Start Time/End Time segment against a
 * parent `employee_work_logs` row (see EmployeeWorkLog.js). The parent row
 * already identifies "which Module/Task, on which date" (via its
 * service_po_id/hierarchy_node_id/work_date, unique per employee — see
 * database/migrations/20260807_hierarchy_node_id_unique_scope.sql); this
 * table is what allows MULTIPLE disjoint time segments against that SAME
 * parent row/date, which a single start_time/end_time pair on the parent
 * can't represent. See database/migrations/
 * 20260885_create_employee_work_log_time_entries.sql for the full design
 * rationale.
 *
 * duration_hours is always server-computed from start_time/end_time (see
 * workLogTimeHelper.calculateHoursFromTimes) — never trusted from a caller —
 * and the SUM of every entry under one employee_work_log_id is what gets
 * written into that parent row's own `hours` column, so every existing
 * consumer of employee_work_logs.hours (12-hour/day cap, Manager approval,
 * Sync-to-timesheets, reports) keeps working unchanged.
 */
module.exports = (sequelize) => {
  class EmployeeWorkLogTimeEntry extends Model {
    static associate(models) {
      EmployeeWorkLogTimeEntry.belongsTo(models.EmployeeWorkLog, {
        foreignKey: 'employee_work_log_id',
        as: 'workLog',
      });
    }
  }

  EmployeeWorkLogTimeEntry.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      employee_work_log_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'employee_work_logs',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Work log is required.' },
        },
      },
      // Denormalised from the parent row's work_date, so a report can query
      // this table directly by date without a join — kept in sync with the
      // parent by the service layer, which always writes both together.
      entry_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        validate: {
          notNull: { msg: 'Entry date is required.' },
          isDate: { msg: 'Entry date must be a valid date.' },
        },
      },
      start_time: {
        type: DataTypes.TIME,
        allowNull: false,
        validate: {
          notNull: { msg: 'Start time is required.' },
        },
      },
      end_time: {
        type: DataTypes.TIME,
        allowNull: false,
        validate: {
          notNull: { msg: 'End time is required.' },
          isAfterStartTime(value) {
            if (value && this.start_time && value <= this.start_time) {
              throw new Error('End time must be greater than start time.');
            }
          },
        },
      },
      duration_hours: {
        type: DataTypes.DECIMAL(6, 2),
        allowNull: false,
        validate: {
          notNull: { msg: 'Duration is required.' },
          min: { args: [0.01], msg: 'Duration must be greater than 0.' },
        },
      },
      // Each slot's OWN description — deliberately separate from the parent
      // employee_work_logs.description (which Sync/reports/older rows still
      // read for the Module/Task as a whole). Introduced by
      // database/migrations/20260887_add_time_entry_description.sql;
      // backfilled from the parent row's description for every pre-existing
      // segment. Never merged with other slots' text — a caller that DOES
      // supply its own per-segment description gets exactly that text.
      // Fully OPTIONAL, including genuinely blank: a caller that omits it
      // (e.g. one time_entry per line, description sent once at the line
      // level, or no description anywhere at all) gets it defaulted — to
      // the line's own description, or an empty string if that's ALSO
      // absent — applied by the service layer BEFORE this table is ever
      // written to (see employeeTimesheetService.withFallbackDescription) —
      // this column is NOT NULL but never required to be non-empty.
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      created_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      updated_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'EmployeeWorkLogTimeEntry',
      tableName: 'employee_work_log_time_entries',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return EmployeeWorkLogTimeEntry;
};
