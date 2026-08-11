'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Join table for a User's ADDITIONAL operational roles — never authoritative
 * for hierarchy rank, company/entity scoping, or the role-creation matrix
 * (those stay governed solely by users.role_id). Only ever unioned into
 * effective-capability checks — see src/services/roleHierarchyService.js's
 * getEffectiveCapabilitiesForRoleIds() and
 * database/migrations/20260850_add_user_additional_roles.sql.
 */
module.exports = (sequelize) => {
  class UserAdditionalRole extends Model {}

  UserAdditionalRole.init({
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'users', key: 'id' } },
    role_id: { type: DataTypes.INTEGER, allowNull: false, references: { model: 'roles', key: 'id' } },
    created_by: { type: DataTypes.INTEGER, allowNull: true },
    updated_by: { type: DataTypes.INTEGER, allowNull: true },
  }, {
    sequelize,
    modelName: 'UserAdditionalRole',
    tableName: 'user_additional_roles',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    indexes: [{ unique: true, fields: ['user_id', 'role_id'] }],
  });

  return UserAdditionalRole;
};
