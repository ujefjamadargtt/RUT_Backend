'use strict';

const { Model, DataTypes } = require('sequelize');
const dateHelper = require('../helpers/dateHelper');

module.exports = (sequelize) => {
  class EmployeeSession extends Model {
    static associate(models) {
      EmployeeSession.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
    }
  }

  EmployeeSession.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
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
      refresh_token: {
        type: DataTypes.TEXT,
        allowNull: true,
        unique: {
          name: 'employee_sessions_refresh_token_key',
          msg: 'Refresh token must be unique.',
        },
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: true,
        validate: {
          isDate: { msg: 'Expires at must be a valid timestamp.' },
        },
      },
      ip_address: {
        type: DataTypes.STRING(45),
        allowNull: true,
        validate: {
          len: { args: [0, 45], msg: 'IP address must be at most 45 characters.' },
        },
      },
      user_agent: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'EmployeeSession',
      tableName: 'employee_sessions',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
      hooks: {
        beforeCreate: (instance) => {
          if (!instance.created_at) {
            instance.created_at = dateHelper.nowDate();
          }
        },
      },
    }
  );

  return EmployeeSession;
};
