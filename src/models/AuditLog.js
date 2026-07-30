'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class AuditLog extends Model {
    static associate(models) {
      AuditLog.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user',
      });
    }
  }

  AuditLog.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id',
        },
      },
      action: {
        type: DataTypes.STRING(50),
        allowNull: true,
        validate: {
          len: { args: [0, 50], msg: 'Action must be at most 50 characters.' },
        },
      },
      entity_type: {
        type: DataTypes.STRING(50),
        allowNull: true,
        validate: {
          len: { args: [0, 50], msg: 'Entity type must be at most 50 characters.' },
        },
      },
      entity_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      old_values: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      new_values: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      ip_address: {
        type: DataTypes.STRING(45),
        allowNull: true,
        validate: {
          len: { args: [0, 45], msg: 'IP address must be at most 45 characters.' },
        },
      },
    },
    {
      sequelize,
      modelName: 'AuditLog',
      tableName: 'audit_logs',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return AuditLog;
};
