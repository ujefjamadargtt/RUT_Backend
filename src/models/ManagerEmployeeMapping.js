'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Manager Employee Mapping — an Employee's Primary/Secondary Manager
 * assignment. Each Employee has AT MOST one PRIMARY and one SECONDARY
 * manager row (unique index on (employee_id, mapping_type) — see
 * database/migrations/20260843_manager_employee_mappings_add_type.sql,
 * which replaced the old employee_id-alone uniqueness). PRIMARY is set
 * mandatorily by HR at Employee creation; SECONDARY is optional, settable
 * at creation or later via Manager self-service.
 */
module.exports = (sequelize) => {
  class ManagerEmployeeMapping extends Model {
    static associate(models) {
      ManagerEmployeeMapping.belongsTo(models.User, {
        foreignKey: 'manager_user_id',
        as: 'manager',
      });
      ManagerEmployeeMapping.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
    }
  }

  ManagerEmployeeMapping.init(
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
      mapping_type: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'PRIMARY',
        validate: {
          isIn: { args: [['PRIMARY', 'SECONDARY']], msg: 'Mapping type must be PRIMARY or SECONDARY.' },
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
      modelName: 'ManagerEmployeeMapping',
      tableName: 'manager_employee_mappings',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['employee_id', 'mapping_type'], name: 'uq_manager_employee_mappings_employee_type' },
      ],
    }
  );

  return ManagerEmployeeMapping;
};
