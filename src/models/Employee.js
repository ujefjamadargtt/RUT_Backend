'use strict';

const { Model, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;

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
      Employee.hasMany(models.EmployeeSession, {
        foreignKey: 'employee_id',
        as: 'sessions',
      });
      Employee.hasMany(models.EmployeeServicePOMapping, {
        foreignKey: 'employee_id',
        as: 'servicePOMappings',
      });
    }

    /**
     * Compares a plain-text password against the stored bcrypt hash.
     * @param {string} plainPassword
     * @returns {Promise<boolean>}
     */
    async validatePassword(plainPassword) {
      if (!this.password) return false;
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
      email_id: {
        type: DataTypes.STRING(150),
        allowNull: true,
        validate: {
          isEmail: { msg: 'Email address must be a valid email.' },
        },
      },
      // Nullable — an Employee with no password set cannot log in yet.
      // Admin-provisioned via POST/PUT /employees or the dedicated
      // reset-password endpoint; hashed by the beforeCreate/beforeUpdate
      // hooks below, same as users.password.
      password: {
        type: DataTypes.STRING(255),
        allowNull: true,
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
      // Exclude password by default; use Employee.scope('withPassword') when needed
      defaultScope: {
        attributes: { exclude: ['password'] },
      },
      scopes: {
        withPassword: {
          attributes: {},
        },
      },
      indexes: [
        { unique: true, fields: ['company_id', 'employee_code'], name: 'uq_employees_company_code' },
      ],
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
