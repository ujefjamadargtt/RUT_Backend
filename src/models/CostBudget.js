'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Cost Budget Master — month-wise Invoice Amount + description maintained
 * per Service PO. See database/migrations/20260858_create_cost_budget_master.sql.
 */
module.exports = (sequelize) => {
  class CostBudget extends Model {
    static associate(models) {
      CostBudget.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
    }
  }

  CostBudget.init(
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
      invoice_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: { args: [0], msg: 'Invoice amount cannot be negative.' },
        },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
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
      modelName: 'CostBudget',
      tableName: 'cost_budget_master',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        {
          unique: true,
          fields: ['service_po_id', 'month', 'year'],
          name: 'uq_cost_budget_master_po_month_year',
        },
      ],
    }
  );

  return CostBudget;
};
