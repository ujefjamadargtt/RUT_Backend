'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Off-Day Work Request — an Employee asking to log hours on a day their
 * BU's Week Off Policy marks as off (see weekOffPolicy.js). One row per
 * (employee_id, service_po_id, work_date) ever — a rejected request is
 * resubmitted by flipping this SAME row back to 'pending' (see
 * offDayWorkRequestService.resubmit), never inserted again. Approving one
 * of these does not itself create the Employee Work Log entry — it only
 * unlocks employeeTimesheetService.replaceDailyEntries to accept an entry
 * for that (employee, service_po, work_date) going forward.
 */
module.exports = (sequelize) => {
  class OffDayWorkRequest extends Model {
    static associate(models) {
      OffDayWorkRequest.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
      OffDayWorkRequest.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
      });
      OffDayWorkRequest.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
      OffDayWorkRequest.belongsTo(models.Employee, {
        foreignKey: 'approver_id',
        as: 'approver',
      });
    }
  }

  OffDayWorkRequest.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      employee_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'employees', key: 'id' },
        validate: {
          notNull: { msg: 'Employee is required.' },
        },
      },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'companies', key: 'id' },
      },
      service_po_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'service_pos', key: 'id' },
        validate: {
          notNull: { msg: 'Service PO is required.' },
        },
      },
      work_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        validate: {
          notNull: { msg: 'Work date is required.' },
          isDate: { msg: 'Work date must be a valid date.' },
        },
      },
      reason: {
        type: DataTypes.TEXT,
        allowNull: false,
        defaultValue: '',
      },
      // 'pending'  - awaiting the Project Manager's decision (or a
      //              Employee just resubmitted after a rejection).
      // 'approved' - unlocks Daily Timesheet for this exact
      //              (employee, service_po, work_date).
      // 'rejected' - only reachable from 'pending'; leaves via Resubmit
      //              (-> 'pending', never directly to 'approved').
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: {
            args: [['pending', 'approved', 'rejected']],
            msg: 'Status must be pending, approved, or rejected.',
          },
        },
      },
      approver_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
      },
      decided_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      decision_remark: {
        type: DataTypes.TEXT,
        allowNull: true,
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
      modelName: 'OffDayWorkRequest',
      tableName: 'off_day_work_requests',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // uq_off_day_work_requests_employee_po_date (employee_id, service_po_id,
      // work_date) is created directly by database/migrations/
      // 20260901_add_off_day_work_approval.sql, not declared here — a plain
      // Sequelize `indexes:` entry would just duplicate it.
    }
  );

  return OffDayWorkRequest;
};
