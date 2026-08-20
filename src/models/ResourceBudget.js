'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Resource Budget Master — planned monthly hours per Employee + Service PO.
 * See database/migrations/20260859_create_resource_budget_master.sql.
 */
module.exports = (sequelize) => {
  class ResourceBudget extends Model {
    static associate(models) {
      ResourceBudget.belongsTo(models.Employee, {
        foreignKey: 'emp_id',
        as: 'employee',
      });
      ResourceBudget.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
    }
  }

  ResourceBudget.init(
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
      emp_id: {
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
      month: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {
          notNull: { msg: 'Month is required.' },
          min: { args: [1], msg: 'Month must be between 1 and 12.' },
          max: { args: [12], msg: 'Month must be between 1 and 12.' },
        },
      },
      year: {
        type: DataTypes.INTEGER,
        allowNull: false,
        validate: {
          notNull: { msg: 'Year is required.' },
          min: { args: [2000], msg: 'Year must be a valid year.' },
          max: { args: [2100], msg: 'Year must be a valid year.' },
        },
      },
      hours: {
        type: DataTypes.DECIMAL(6, 2),
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: { args: [0], msg: 'Hours cannot be negative.' },
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
      modelName: 'ResourceBudget',
      tableName: 'resource_budget_master',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          unique: true,
          fields: ['emp_id', 'service_po_id', 'month', 'year'],
          name: 'uq_resource_budget_master_emp_po_month_year',
        },
      ],
    }
  );

  return ResourceBudget;
};
