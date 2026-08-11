'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class RoleCapability extends Model {}

  RoleCapability.init({
    role_id: { type: DataTypes.INTEGER, allowNull: false, primaryKey: true, references: { model: 'roles', key: 'id' } },
    // Fine-grained business-action key, e.g. 'bu.create_client',
    // 'servicepo.manage_team', 'manager.approve_timesheets' — see
    // database/migrations/20260836_seed_target_roles_and_capabilities.sql
    // for the full seeded set. Never duplicated for an inherited capability;
    // src/services/roleHierarchyService.js computes those at read time.
    capability_key: { type: DataTypes.STRING(60), allowNull: false, primaryKey: true },
  }, {
    sequelize,
    modelName: 'RoleCapability',
    tableName: 'role_capabilities',
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: false,
  });

  return RoleCapability;
};
