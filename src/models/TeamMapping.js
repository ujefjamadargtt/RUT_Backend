'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Team Mapping — Service PO Admin's own roster of Managers (self-service:
 * the Service PO Admin IS the actor, not a third party assigning on their
 * behalf). Replaces the old head_manager_mappings table (BU Admin ->
 * Head Manager -> Manager, one hop longer) now that the "Head Manager"
 * role is retired — see database/migrations/
 * 20260844_rename_head_manager_mappings_to_team_mappings.sql, which
 * renamed the table and its head_manager_user_id column in place.
 *
 * A Manager belongs to exactly ONE Service PO Admin's team at a time
 * (unique index on manager_user_id alone — same cardinality the table had
 * before the rename).
 */
module.exports = (sequelize) => {
  class TeamMapping extends Model {
    static associate(models) {
      TeamMapping.belongsTo(models.Employee, {
        foreignKey: 'service_po_admin_employee_id',
        as: 'servicePOAdmin',
      });
      TeamMapping.belongsTo(models.Employee, {
        foreignKey: 'manager_employee_id',
        as: 'manager',
      });
    }
  }

  TeamMapping.init(
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
      service_po_admin_employee_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'employees',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Service PO Admin employee is required.' },
        },
      },
      manager_employee_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'employees',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Manager employee is required.' },
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
      modelName: 'TeamMapping',
      tableName: 'team_mappings',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['manager_employee_id'], name: 'uq_team_mappings_manager' },
      ],
    }
  );

  return TeamMapping;
};
