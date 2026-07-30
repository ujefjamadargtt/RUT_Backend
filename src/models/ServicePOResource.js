'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class ServicePOResource extends Model {
    static associate(models) {
      ServicePOResource.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
      ServicePOResource.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
    }
  }

  ServicePOResource.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      // Derivable transitively through service_po_id/employee_id (both
      // already company-scoped), but stored directly too as a cheap
      // defense-in-depth filter for this join table's own queries.
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id',
        },
      },
      service_po_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'service_pos',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Service PO is required.' },
        },
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
    },
    {
      sequelize,
      modelName: 'ServicePOResource',
      tableName: 'service_po_resources',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
      indexes: [
        {
          unique: true,
          fields: ['service_po_id', 'employee_id'],
          name: 'service_po_resources_po_employee_unique',
        },
      ],
    }
  );

  return ServicePOResource;
};
