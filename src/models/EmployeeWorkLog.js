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

  // NOTE: EmployeeWorkLog.hasMany(EmployeeWorkLogTimeEntry, { as: 'timeEntries' })
  // is declared in models/index.js (alongside every other cross-model
  // association in this codebase), not here.

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
      // start_time/end_time used to live directly on this row (a single
      // pair, added by database/migrations/20260860_add_work_log_start_end_time.sql)
      // but that can't represent multiple disjoint time segments against the
      // SAME Module/Task on the SAME date. Superseded by the
      // `timeEntries` association (EmployeeWorkLogTimeEntry, one row per
      // segment) — see database/migrations/
      // 20260886_backfill_and_drop_worklog_start_end_time.sql, which
      // migrated every historical non-null pair into that table before
      // dropping these two columns here. `hours` below is always the
      // authoritative total (the SUM of this row's timeEntries when any
      // exist — see employeeTimesheetService.resolveHoursAndTimeEntries —
      // or a plain caller-supplied value for a non-time-based entry).
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
      // NOT NULL (a value is always written — empty string when nothing was
      // supplied), but NOT required to be non-empty at the model layer: a
      // plain HOURLY line still requires a real description, enforced by
      // Joi (employeeTimesheetValidation.dailyEntryLineSchema); a TIME_BASED
      // line's description is fully optional (its segments may carry their
      // own instead — see EmployeeWorkLogTimeEntry.js) and simply defaults
      // to blank when nothing is supplied anywhere — see
      // employeeTimesheetService.js's withFallbackDescription().
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      // 'pending'  - entered by the employee, awaiting approval (or Sync,
      //              if approval isn't required for this employee). Also
      //              the state a 'rejected' row returns to on Resubmit.
      // 'approved' - approved (by a Manager, or automatically because
      //              approval isn't required for this employee) but Sync
      //              has not run yet. Eligible for Sync.
      // 'rejected' - a Manager rejected this PENDING row (see
      //              rejection_remark/rejected_by/rejected_at below). Only
      //              reachable from 'pending', and only leaves via Resubmit
      //              (-> 'pending', never directly to 'approved') or the
      //              Employee deleting it.
      // 'synced'   - included in a completed Sync run; the corresponding
      //              official record now lives in `timesheets`, linked via
      //              timesheet_import_id. Synced rows are read-only.
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: {
            args: [['pending', 'approved', 'rejected', 'synced']],
            msg: 'Status must be pending, approved, rejected, or synced.',
          },
        },
      },
      // Set together whenever a Manager rejects this row (see
      // managerSelfServiceService.rejectWorkLogEntry). Deliberately NOT
      // cleared on Resubmit (status back to 'pending') — the most recent
      // rejection stays visible to the Employee even while the row is
      // pending again; the full history also survives in audit_logs.
      rejection_remark: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      rejected_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      rejected_at: {
        type: DataTypes.DATE,
        allowNull: true,
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
