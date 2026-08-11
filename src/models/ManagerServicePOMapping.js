'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Manager Service PO Mapping — a Head Manager's grant of a Service PO to
 * one of their own Managers. Many-to-many (unlike HeadManagerMapping/
 * ManagerEmployeeMapping) — only exact-duplicate grants are prevented
 * (unique on the pair). This grant cascades: a Manager may only assign a
 * Service PO to one of their own Employees (via the existing
 * EmployeeServicePOMapping) if it appears here for them — see
 * managerSelfServiceService.js.
 */
module.exports = (sequelize) => {
  class ManagerServicePOMapping extends Model {
    static associate(models) {
      ManagerServicePOMapping.belongsTo(models.User, {
        foreignKey: 'manager_user_id',
        as: 'manager',
      });
      ManagerServicePOMapping.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
    }
  }

  ManagerServicePOMapping.init(
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
      manager_user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Manager user is required.' },
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
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'active',
        validate: {
          isIn: { args: [['active', 'inactive']], msg: 'Status must be active or inactive.' },
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
      modelName: 'ManagerServicePOMapping',
      tableName: 'manager_servicepo_mappings',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['manager_user_id', 'service_po_id'], name: 'uq_manager_servicepo_mappings' },
      ],
    }
  );

  return ManagerServicePOMapping;
};
