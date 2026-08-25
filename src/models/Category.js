'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Category extends Model {}

  Category.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    // The parent module's OWN form_master row id (a module is a form_master
    // row with module_name IS NULL — see database/migrations/
    // 20260856_add_form_master_seq_and_modules.sql). A category always
    // belongs to exactly one module and is never moved between modules.
    module_id: { type: DataTypes.INTEGER, allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false, validate: { notEmpty: true, len: [1, 100] } },
    description: { type: DataTypes.STRING(255), allowNull: true },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
    // Display order among this module's own categories — independent of
    // form_master's module/form seq scales.
    seq: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
  }, {
    sequelize,
    modelName: 'Category',
    tableName: 'categories',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [{ unique: true, fields: ['module_id', 'name'] }],
  });

  return Category;
};
