'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class PasswordResetHistory extends Model {
    static associate(models) {
      PasswordResetHistory.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
      PasswordResetHistory.belongsTo(models.Employee, { foreignKey: 'employee_id', as: 'employee' });
      PasswordResetHistory.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
    }
  }

  PasswordResetHistory.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'companies', key: 'id' },
      },
      email: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      login_type: {
        type: DataTypes.STRING(10),
        allowNull: true,
        validate: {
          isIn: { args: [['user', 'employee']], msg: 'login_type must be user or employee.' },
        },
      },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'users', key: 'id' },
      },
      employee_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
      },
      action: {
        type: DataTypes.STRING(30),
        allowNull: false,
        validate: {
          isIn: {
            args: [['OTP_SENT', 'OTP_RESENT', 'OTP_VERIFIED', 'OTP_FAILED', 'PASSWORD_RESET', 'PASSWORD_RESET_FAILED']],
            msg: 'Invalid password reset history action.',
          },
        },
      },
      ip_address: {
        type: DataTypes.STRING(45),
        allowNull: true,
      },
      user_agent: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      remarks: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'PasswordResetHistory',
      tableName: 'password_reset_history',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return PasswordResetHistory;
};
