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
      work_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        validate: {
          notNull: { msg: 'Work date is required.' },
          isDate: { msg: 'Work date must be a valid date.' },
        },
      },
      hours: {
        type: DataTypes.DECIMAL(4, 2),
        allowNull: false,
        validate: {
          notNull: { msg: 'Hours is required.' },
          min: { args: [0.01], msg: 'Hours must be greater than 0.' },
          max: { args: [12], msg: 'Hours cannot exceed 12 per day.' },
        },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Description is required.' },
        },
      },
      // 'pending'  - entered by the employee, not yet part of the official
      //              Timesheet.
      // 'synced'   - included in a completed Sync run; the corresponding
      //              official record now lives in `timesheets`, linked via
      //              timesheet_import_id. Synced rows are read-only.
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: { args: [['pending', 'synced']], msg: 'Status must be pending or synced.' },
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
      indexes: [
        {
          unique: true,
          fields: ['employee_id', 'service_po_id', 'work_date'],
          name: 'uq_employee_work_logs',
        },
      ],
    }
  );

  return EmployeeWorkLog;
};
