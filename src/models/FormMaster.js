'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class FormMaster extends Model {}

  FormMaster.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // NULL here means this row IS a module (its form_name is the module's
    // name), not a form registered under one — see database/migrations/
    // 20260856_add_form_master_seq_and_modules.sql.
    module_name: { type: DataTypes.STRING(100), allowNull: true, validate: { len: [1, 100] } },
    form_name: { type: DataTypes.STRING(150), allowNull: false, validate: { notEmpty: true, len: [1, 150] } },
    // Display order — module ordering when module_name IS NULL, otherwise
    // this form's order within its own module. The two scales are
    // independent (see formMasterRepository.js's getMaxModuleSeq /
    // getMaxSeqInModule).
    seq: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
    // Optional parent category — only ever set on a FORM row (module_name
    // NOT NULL); NULL means this form sits directly under its module. See
    // database/migrations/20260881_add_form_master_categories.sql.
    category_id: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'FormMaster',
    tableName: 'form_master',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [{ unique: true, fields: ['module_name', 'form_name'] }],
  });

  return FormMaster;
};
