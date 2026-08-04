'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Timesheet extends Model {
    static associate(models) {
      Timesheet.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
      Timesheet.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
      Timesheet.belongsTo(models.SubProject, {
        foreignKey: 'sub_project_id',
        as: 'subProject',
      });
      Timesheet.belongsTo(models.TimesheetImportHistory, {
        foreignKey: 'timesheet_import_id',
        as: 'importHistory',
      });
    }
  }

  Timesheet.init(
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
      timesheet_import_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'timesheet_import_history',
          key: 'id',
        },
      },
      timesheet_date: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        validate: {
          notNull: { msg: 'Timesheet date is required.' },
          isDate:  { msg: 'Timesheet date must be a valid date.' },
        },
      },
      hours_logged: {
        // Matches the DB column exactly (see database/migrations/20260626_remove_hours_upper_bound.sql) —
        // 3 whole-number digits + 2 decimal places, max 999.99.
        // This is the original, immutable, imported/entered value — it must
        // never become editable through the Modified Hours feature (see
        // modified_hours below).
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        validate: {
          notNull: { msg: 'Hours logged is required.' },
          min: { args: [0], msg: 'Hours logged must be greater than or equal to 0.' },
          max: { args: [999.99], msg: 'Hours logged cannot exceed 999.99.' },
        },
      },
      // Admin-adjustable "effective" hours (see database/migrations/
      // 20260722_add_modified_hours_and_is_publish.sql). Set equal to
      // hours_logged at insert time in application code (createTimesheet(),
      // confirmImport()) — never left null on a newly-created row, never a
      // DB default/trigger. Only ever changed afterward via
      // PATCH /timesheets/:id/modified-hours.
      modified_hours: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Modified hours must be greater than or equal to 0.' },
          max: { args: [999.99], msg: 'Modified hours cannot exceed 999.99.' },
        },
      },
      // Initial value set at insert time in application code (createTimesheet(),
      // confirmImport()) via timesheetPublishPolicy.resolveInitialIsPublish() —
      // based on the COMPANY's OWN companies.is_original_data_visible (see
      // database/migrations/20260808_add_company_original_data_visibility.sql;
      // NOT per-user or per-role): that flag true -> false (work with
      // original data first); false -> true (published immediately). The DB
      // default (false) below is a fallback only — every live insert site
      // sets it explicitly. Afterward it's a one-way flag: only ever
      // flipped true via PATCH /timesheets/:id/modified-hours or the
      // Publish API, never reset to
      // false anywhere.
      is_publish: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // Nullable — mandatory only for Employee self-service entries
      // (enforced in employeeTimesheetValidation.js), never required for
      // Admin manual entries or Excel/PMS-imported rows.
      description: {
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
      modelName: 'Timesheet',
      tableName: 'timesheets',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
      indexes: [
        {
          unique: true,
          fields: ['employee_id', 'service_po_id', 'timesheet_date'],
          name: 'timesheets_employee_po_date_unique',
        },
      ],
    }
  );

  

  return Timesheet;
};
