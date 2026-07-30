'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class MonthlyCost extends Model {
    static associate(models) {
      MonthlyCost.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
    }
  }

  MonthlyCost.init(
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
      month_year: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          notNull: { msg: 'Month year is required.' },
          notEmpty: { msg: 'Month year is required.' },
        },
      },
      month: {
        type: DataTypes.VIRTUAL,
        get() {
          const value = this.getDataValue('month_year');
          const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
          return match ? parseInt(match[2], 10) : null;
        },
      },
      year: {
        type: DataTypes.VIRTUAL,
        get() {
          const value = this.getDataValue('month_year');
          const match = String(value || '').match(/^(\d{4})-(\d{2})$/);
          return match ? parseInt(match[1], 10) : null;
        },
      },
      salary_cost: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Salary cost cannot be negative.' },
        },
      },
      ops_cost: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Ops cost cannot be negative.' },
        },
      },
      total_cost: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Total cost cannot be negative.' },
        },
      },
      billable_cost: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Billable cost cannot be negative.' },
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
      modelName: 'MonthlyCost',
      tableName: 'monthly_costs',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
      indexes: [
        {
          unique: true,
          fields: ['employee_id', 'month_year'],
          name: 'monthly_costs_employee_month_year_unique',
        },
      ],
    }
  );

  return MonthlyCost;
};
