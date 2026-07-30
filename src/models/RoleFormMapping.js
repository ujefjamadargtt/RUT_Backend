'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class RoleFormMapping extends Model {}

  RoleFormMapping.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    role_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'roles', key: 'id' } },
    form_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'form_master', key: 'id' } },
    // Soft-mapping flag: true = form is mapped to the role (active), false =
    // unmapped (inactive). Rows are never physically deleted — mapping and
    // unmapping both just toggle this column. See rbacService.mapForm().
    status: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    sequelize,
    modelName: 'RoleFormMapping',
    tableName: 'role_form_mapping',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [{ unique: true, fields: ['role_id', 'form_id'] }],
  });

  return RoleFormMapping;
};
