'use strict';

const { Model, DataTypes } = require('sequelize');
const dateHelper = require('../helpers/dateHelper');

/**
 * Employee Login Session — refresh-token store for Employee-based login,
 * mirroring user_sessions' final shape (jti/family_id rotation + replay
 * detection). Deliberately NOT named `employee_sessions` (that name
 * belonged to the earlier, dropped Employee-direct-login attempt) — see
 * database/migrations/20260879_create_employee_login_sessions.sql.
 */
module.exports = (sequelize) => {
  class EmployeeLoginSession extends Model {
    static associate(models) {
      EmployeeLoginSession.belongsTo(models.Employee, { foreignKey: 'employee_id', as: 'employee' });
    }
  }

  EmployeeLoginSession.init(
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
        validate: { notNull: { msg: 'Employee is required.' } },
      },
      refresh_token: {
        type: DataTypes.STRING(500),
        allowNull: false,
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
        validate: { isDate: { msg: 'Expires at must be a valid timestamp.' } },
      },
      ip_address: {
        type: DataTypes.STRING(45),
        allowNull: true,
      },
      user_agent: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      jti: {
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      family_id: {
        type: DataTypes.STRING(36),
        allowNull: true,
      },
      revoked_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      replaced_by_jti: {
        type: DataTypes.STRING(36),
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'EmployeeLoginSession',
      tableName: 'employee_login_sessions',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      hooks: {
        beforeCreate: (instance) => {
          if (!instance.created_at) {
            instance.created_at = dateHelper.nowDate();
          }
        },
      },
    }
  );

  return EmployeeLoginSession;
};
