'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Employee extends Model {
    static associate(models) {
      Employee.hasMany(models.User, {
        foreignKey: 'employee_id',
        as: 'users',
      });
      Employee.hasMany(models.ServicePOResource, {
        foreignKey: 'employee_id',
        as: 'servicePOResources',
      });
      Employee.hasMany(models.MonthlyCost, {
        foreignKey: 'employee_id',
        as: 'monthlyCosts',
      });
      Employee.hasMany(models.Timesheet, {
        foreignKey: 'employee_id',
        as: 'timesheets',
      });
      Employee.hasMany(models.EmployeeServicePOMapping, {
        foreignKey: 'employee_id',
        as: 'servicePOMappings',
      });
    }
  }

  Employee.init(
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
      employee_code: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Employee code cannot be empty.' },
          len: { args: [1, 20], msg: 'Employee code must be between 1 and 20 characters.' },
        },
      },
      full_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Full name cannot be empty.' },
          len: { args: [1, 100], msg: 'Full name must be between 1 and 100 characters.' },
        },
      },
      designation: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      total_experience: {
        type: DataTypes.DECIMAL(4, 1),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Total experience cannot be negative.' },
        },
      },
      company_experience: {
        type: DataTypes.DECIMAL(4, 1),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Company experience cannot be negative.' },
        },
      },
      resource_description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      date_of_joining: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        validate: {
          isDate: { msg: 'Date of joining must be a valid date.' },
        },
      },
      date_of_leaving: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        validate: {
          isDate: { msg: 'Date of leaving must be a valid date.' },
          isAfterJoining(value) {
            if (value && this.date_of_joining && value < this.date_of_joining) {
              throw new Error('Date of leaving must be after date of joining.');
            }
          },
        },
      },
      status: {
        type: DataTypes.ENUM('active', 'inactive'),
        allowNull: false,
        defaultValue: 'active',
        validate: {
          isIn: { args: [['active', 'inactive']], msg: 'Status must be active or inactive.' },
        },
      },
      is_deleted: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // Governs whether this employee's timesheets start held-back
      // (is_publish=false, awaiting an explicit Publish) or auto-published
      // (is_publish=true) at creation/import/sync time — see
      // src/utils/timesheetPublishPolicy.js. Replaces the old, company-wide
      // companies.is_original_data_visible-based decision with a per-employee
      // one; see database/migrations/20260851_add_employee_timesheet_approval_required.sql.
      is_timesheet_approval_required: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
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
      modelName: 'Employee',
      tableName: 'employees',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['company_id', 'employee_code'], name: 'uq_employees_company_code' },
      ],
      hooks: {
        beforeCreate: (employee) => {
          if (!employee.employee_code) {
            // Generate a unique code: EMP + last 6 digits of epoch + 3-digit random
            const timestamp = Date.now().toString().slice(-6);
            const random = Math.floor(Math.random() * 900 + 100);
            employee.employee_code = `EMP${timestamp}${random}`;
          }
        },
      },
    }
  );

  return Employee;
};
