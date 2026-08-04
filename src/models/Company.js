'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Company extends Model {}

  Company.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    company_code: {
      type: DataTypes.STRING(20),
      allowNull: false,
      unique: { name: 'uq_companies_company_code', msg: 'Company code must be unique.' },
      validate: {
        notEmpty: { msg: 'Company code cannot be empty.' },
        len: { args: [1, 20], msg: 'Company code must be between 1 and 20 characters.' },
      },
    },
    company_name: {
      type: DataTypes.STRING(150),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Company name cannot be empty.' },
        len: { args: [1, 150], msg: 'Company name must be between 1 and 150 characters.' },
      },
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive'),
      allowNull: false,
      defaultValue: 'active',
      validate: {
        isIn: { args: [['active', 'inactive']], msg: 'Status must be active or inactive.' },
      },
    },
    is_deleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Drives the Original Timesheet publish rule (see
    // src/utils/timesheetPublishPolicy.js) — true means this company's users
    // work with original/unpublished data first (new timesheets/import
    // history rows created via Excel Import/Sync/manual entry start
    // is_publish=false); false means they should always see published data
    // (those rows start is_publish=true). See database/migrations/
    // 20260808_add_company_original_data_visibility.sql. COMPANY-level, not
    // per-user or per-role.
    is_original_data_visible: {
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
  }, {
    sequelize,
    modelName: 'Company',
    tableName: 'companies',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });

  return Company;
};
