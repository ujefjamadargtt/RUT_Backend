'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class EmployeeWorkLog extends Model {
    static associate(models) {
      EmployeeWorkLog.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
      EmployeeWorkLog.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
      EmployeeWorkLog.belongsTo(models.SubProject, {
        foreignKey: 'sub_project_id',
        as: 'subProject',
      });
      EmployeeWorkLog.belongsTo(models.TimesheetImportHistory, {
        foreignKey: 'timesheet_import_id',
        as: 'importHistory',
      });
      EmployeeWorkLog.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
      });
    }
  }

  EmployeeWorkLog.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id',
        },
      },
      employee_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'employees',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Employee is required.' },
        },
      },
      service_po_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'service_pos',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Service PO is required.' },
        },
      },
      sub_project_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'sub_projects',
          key: 'id',
        },
      },
      // Optional tag for which Service PO Hierarchy node (Parent or Child —
      // see ServicePOHierarchy.js) the hours were logged against. Purely
      // for the employee's own selection UI/history; service_po_id above
      // remains the required, authoritative field sync/import/reports read.
      hierarchy_node_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        references: {
          model: 'service_po_hierarchy',
          key: 'id',
        },
        onDelete: 'SET NULL',
      },
      work_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        validate: {
          notNull: { msg: 'Work date is required.' },
          isDate: { msg: 'Work date must be a valid date.' },
        },
      },
      // Optional time-of-day pair within work_date (no date component is
      // stored here — work_date already represents the date). Nullable so
      // every pre-existing row (and any non-time-based entry) keeps working
      // unchanged; `hours` remains the source of truth for those. When both
      // are present, employeeTimesheetService.js always (re)computes `hours`
      // from them server-side — see resolveHoursAndTimes() — never trusting
      // a caller-supplied hours value alongside a time pair. The isAfterStartTime
      // check here is a defense-in-depth backstop (mirrors the DB CHECK
      // constraint); the service layer's calculateHoursFromTimes() is the
      // authoritative validation.
      start_time: {
        type: DataTypes.TIME,
        allowNull: true,
      },
      end_time: {
        type: DataTypes.TIME,
        allowNull: true,
        validate: {
          isAfterStartTime(value) {
            if (value && this.start_time && value <= this.start_time) {
              throw new Error('End time must be greater than start time.');
            }
          },
        },
      },
      hours: {
        type: DataTypes.DECIMAL(6, 2),
        allowNull: false,
        validate: {
          notNull: { msg: 'Hours is required.' },
          min: { args: [0.01], msg: 'Hours must be greater than 0.' },
          // Daily rows (log_type: 'daily', the column default) keep the
          // original 12-hours/day ceiling exactly as before; Monthly rows
          // (log_type: 'monthly') allow up to the 176-hour monthly cap
          // (see employeeMonthlyWorkLogService.MONTHLY_HOUR_CAP).
          isWithinLogTypeCap(value) {
            const cap = this.log_type === 'monthly' ? 176 : 12;
            if (parseFloat(value) > cap) {
              throw new Error(`Hours cannot exceed ${cap} for a ${this.log_type || 'daily'} entry.`);
            }
          },
        },
      },
      // 'daily'   - one row per calendar date (existing Daily Work Log).
      // 'monthly' - one row per Service PO/hierarchy node for an entire
      //             month, dated on that month's last calendar day (Monthly
      //             Work Log — see employeeMonthlyWorkLogService.js).
      log_type: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'daily',
        validate: {
          isIn: { args: [['daily', 'monthly']], msg: 'log_type must be daily or monthly.' },
        },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Description is required.' },
        },
      },
      // 'pending'  - entered by the employee, awaiting approval (or Sync,
      //              if approval isn't required for this employee).
      // 'approved' - approved (by a Manager, or automatically because
      //              approval isn't required for this employee) but Sync
      //              has not run yet. Eligible for Sync.
      // 'synced'   - included in a completed Sync run; the corresponding
      //              official record now lives in `timesheets`, linked via
      //              timesheet_import_id. Synced rows are read-only.
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: { args: [['pending', 'approved', 'synced']], msg: 'Status must be pending, approved, or synced.' },
        },
      },
      synced_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      timesheet_import_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'timesheet_import_history',
          key: 'id',
        },
        // Matches the migration's ON DELETE SET NULL — deleting an import
        // history row must never be blocked by, or cascade-delete, a work
        // log row (Employee Work Logs are the source of truth and survive
        // an import deletion). Declared here too so the model's own
        // contract matches the live DB, avoiding the same drift that
        // previously caused the file_path NOT NULL bug.
        onDelete: 'SET NULL',
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
      modelName: 'EmployeeWorkLog',
      tableName: 'employee_work_logs',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // NOTE: uq_employee_work_logs is NOT declared here as a Sequelize
      // model-level index. It's a functional unique index — UNIQUE on
      // (employee_id, service_po_id, COALESCE(hierarchy_node_id, 0),
      // work_date) — created directly by
      // database/migrations/20260807_hierarchy_node_id_unique_scope.sql,
      // which Sequelize's `indexes: [{ fields: [...] }]` shorthand can't
      // express (it would emit a plain column list, and a plain multi-
      // column UNIQUE never catches two NULL-hierarchy_node_id rows as
      // duplicates of each other — see the migration's comment). The app
      // enforces the same null-safe scope at the service layer via
      // employeeWorkLogRepository.checkDuplicate.
    }
  );

  return EmployeeWorkLog;
};
