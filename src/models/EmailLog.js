'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class EmailLog extends Model {
    static associate(models) {
      EmailLog.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
      EmailLog.belongsTo(models.Employee, { foreignKey: 'triggered_by_employee_id', as: 'triggeredByEmployee' });
      EmailLog.belongsTo(models.Employee, { foreignKey: 'related_employee_id', as: 'relatedEmployee' });
    }
  }

  EmailLog.init(
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
      mail_type: {
        type: DataTypes.STRING(40),
        allowNull: false,
        validate: {
          isIn: {
            args: [['PASSWORD_RESET_OTP', 'APPROVAL_REMINDER', 'WORKLOG_COMPLIANCE_REMINDER']],
            msg: 'Invalid email log mail_type.',
          },
        },
      },
      recipient_email: {
        type: DataTypes.STRING(150),
        allowNull: false,
      },
      subject: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },
      body: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        validate: {
          isIn: { args: [['sent', 'failed']], msg: 'status must be sent or failed.' },
        },
      },
      error_message: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      triggered_by_employee_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
      },
      related_employee_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
      },
    },
    {
      sequelize,
      modelName: 'EmailLog',
      tableName: 'email_logs',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return EmailLog;
};
