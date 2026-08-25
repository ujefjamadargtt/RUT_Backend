'use strict';

const { Model, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;

module.exports = (sequelize) => {
  class Employee extends Model {
    static associate(models) {
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
      Employee.belongsToMany(models.Role, {
        through: models.EmployeeRole,
        foreignKey: 'employee_id',
        otherKey: 'role_id',
        as: 'roles',
      });
      Employee.belongsToMany(models.Company, {
        through: models.EmployeeBusinessUnit,
        foreignKey: 'employee_id',
        otherKey: 'business_unit_id',
        as: 'businessUnits',
      });
      Employee.hasMany(models.EmployeeLoginSession, {
        foreignKey: 'employee_id',
        as: 'loginSessions',
      });
    }

    /**
     * Compares a plain-text password against the stored bcrypt hash.
     * @param {string} plainPassword
     * @returns {Promise<boolean>}
     */
    async validatePassword(plainPassword) {
      return bcrypt.compare(plainPassword, this.password);
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
      // Login identity, native to Employee now — see database/migrations/
      // 20260864_add_employee_login_columns.sql. Nullable: only Employees
      // who actually need portal access carry credentials; pure business-
      // data Employees (no portal login) leave both NULL.
      email: {
        type: DataTypes.STRING(100),
        allowNull: true,
        unique: {
          name: 'employees_email_key',
          msg: 'Email address must be unique.',
        },
        validate: {
          isEmail: { msg: 'Must be a valid email address.' },
          len: { args: [0, 100], msg: 'Email must be at most 100 characters.' },
        },
      },
      password: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      // Microsoft Entra ID's stable, per-tenant, non-reassignable identifier
      // (the `oid` claim) — captured on first successful Microsoft SSO login,
      // see authRepository.updateMicrosoftObjectId(). Email remains the sole
      // login-matching key; this is stored for audit/future hardening only,
      // not currently used to gate access. NULL for every employee who has
      // never signed in via Microsoft SSO — see database/migrations/
      // 20260881_add_employee_microsoft_object_id.sql.
      microsoft_object_id: {
        type: DataTypes.STRING(64),
        allowNull: true,
        unique: {
          name: 'uq_employees_microsoft_object_id',
          msg: 'This Microsoft account is already linked to another employee.',
        },
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
      // Password excluded by default; use Employee.scope('withPassword') when needed.
      defaultScope: {
        attributes: { exclude: ['password'] },
      },
      scopes: {
        withPassword: {
          attributes: {},
        },
      },
      hooks: {
        beforeCreate: async (employee) => {
          if (!employee.employee_code) {
            // Generate a unique code: EMP + last 6 digits of epoch + 3-digit random
            const timestamp = Date.now().toString().slice(-6);
            const random = Math.floor(Math.random() * 900 + 100);
            employee.employee_code = `EMP${timestamp}${random}`;
          }
          if (employee.password) {
            employee.password = await bcrypt.hash(employee.password, BCRYPT_ROUNDS);
          }
        },
        beforeUpdate: async (employee) => {
          if (employee.changed('password') && employee.password) {
            employee.password = await bcrypt.hash(employee.password, BCRYPT_ROUNDS);
          }
        },
      },
    }
  );

  return Employee;
};
