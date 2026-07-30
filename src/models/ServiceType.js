'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * ServiceType model — seed defaults: Project, Service Pack,
 * Resource Outsourcing, Managed Services.
 */
module.exports = (sequelize) => {
  class ServiceType extends Model {
    static associate(models) {
      ServiceType.hasMany(models.ServicePO, {
        foreignKey: 'service_type_id',
        as: 'servicePOs',
      });
      ServiceType.belongsTo(models.ServiceCategory, {
        foreignKey: 'service_category_id',
        as: 'serviceCategory',
      });
    }
  }

  ServiceType.init(
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
      service_type_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Service type name cannot be empty.' },
          len: { args: [1, 100], msg: 'Service type name must be between 1 and 100 characters.' },
        },
      },
      service_category_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'service_categories', key: 'id' },
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
      modelName: 'ServiceType',
      tableName: 'service_types',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['company_id', 'service_type_name'], name: 'uq_service_types_company_name' },
      ],
    }
  );

  return ServiceType;
};
