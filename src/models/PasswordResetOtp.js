'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class PasswordResetOtp extends Model {
    static associate(models) {
      PasswordResetOtp.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
      PasswordResetOtp.belongsTo(models.Employee, { foreignKey: 'employee_id', as: 'employee' });
      PasswordResetOtp.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
    }
  }

  PasswordResetOtp.init(
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
      login_type: {
        type: DataTypes.STRING(10),
        allowNull: false,
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
      email: {
        type: DataTypes.STRING(150),
        allowNull: false,
        validate: {
          isEmail: { msg: 'Email must be a valid email address.' },
        },
      },
      // bcrypt hash — never plaintext. See PasswordResetOtp.validateOtp().
      otp: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      purpose: {
        type: DataTypes.STRING(30),
        allowNull: false,
        defaultValue: 'password_reset',
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: { args: [['pending', 'verified', 'expired', 'used']], msg: 'Invalid OTP status.' },
        },
      },
      attempt_count: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      verified_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      used_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      created_ip: {
        type: DataTypes.STRING(45),
        allowNull: true,
      },
      created_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'PasswordResetOtp',
      tableName: 'password_reset_otps',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return PasswordResetOtp;
};
