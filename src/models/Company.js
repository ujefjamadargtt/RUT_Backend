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
    // Every Company must belong to exactly one Entity (Entity Admin tier —
    // see Entity.js) — backfilled onto a single platform-wide "Default
    // Entity" for every pre-existing row (see database/migrations/
    // 20260824_backfill_companies_entity_id.sql), required for every new
    // Company from companyService.createWithAdmin onward.
    entity_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      references: {
        model: 'entities',
        key: 'id',
      },
      validate: {
        notNull: { msg: 'Entity is required.' },
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
    // BU Hierarchy / Sub-BU support — NULL means this Company is a
    // Parent/Main BU; a non-NULL value means it's a Sub-BU of that parent.
    // Capped at 2 levels (Parent BU -> Sub-BU) — enforced in
    // companyService.js, not here. See database/migrations/
    // 20260904_add_parent_business_unit_id_to_companies.sql.
    parent_business_unit_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
      references: {
        model: 'companies',
        key: 'id',
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
    // Which Saturdays count as off, for the Off-Day Approval Gate (see
    // src/utils/weekOffPolicy.js) — Sunday is always off for every BU, so it
    // has no column of its own. See database/migrations/
    // 20260901_add_off_day_work_approval.sql.
    saturday_off_rule: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'ALL',
      validate: {
        isIn: {
          args: [['ALL', 'ALT_1_3', 'ALT_2_4', 'NONE']],
          msg: 'saturday_off_rule must be ALL, ALT_1_3, ALT_2_4, or NONE.',
        },
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
