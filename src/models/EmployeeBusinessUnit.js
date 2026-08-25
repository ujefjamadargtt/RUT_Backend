'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Employee Business Unit — many-to-many Employee <-> Company ("Business
 * Unit"), replacing the old single users.company_id column and the
 * BU-Head-only bu_head_company_mappings mechanism. This is the table
 * resolveCompany.js reads to resolve a request's active BU. See
 * database/migrations/20260866_create_employee_business_units.sql.
 */
module.exports = (sequelize) => {
  class EmployeeBusinessUnit extends Model {
    static associate(models) {
      EmployeeBusinessUnit.belongsTo(models.Employee, { foreignKey: 'employee_id', as: 'employee' });
      EmployeeBusinessUnit.belongsTo(models.Company, { foreignKey: 'business_unit_id', as: 'businessUnit' });
    }
  }

  EmployeeBusinessUnit.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      employee_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'employees', key: 'id' },
      },
      business_unit_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'companies', key: 'id' },
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'active',
        validate: {
          isIn: { args: [['active', 'inactive']], msg: 'Status must be active or inactive.' },
        },
      },
      created_by: { type: DataTypes.INTEGER, allowNull: true },
      updated_by: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      sequelize,
      modelName: 'EmployeeBusinessUnit',
      tableName: 'employee_business_units',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['employee_id', 'business_unit_id'], name: 'uq_employee_business_units_employee_bu' },
      ],
    }
  );

  return EmployeeBusinessUnit;
};
