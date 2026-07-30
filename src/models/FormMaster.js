'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class FormMaster extends Model {}

  FormMaster.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    module_name: { type: DataTypes.STRING(100), allowNull: false, validate: { notEmpty: true, len: [1, 100] } },
    form_name: { type: DataTypes.STRING(150), allowNull: false, validate: { notEmpty: true, len: [1, 150] } },
    status: { type: DataTypes.ENUM('active', 'inactive'), allowNull: false, defaultValue: 'active' },
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
