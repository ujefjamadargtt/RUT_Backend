'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Role extends Model {}

  Role.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      role_name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: {
          name: 'roles_role_name_key',
          msg: 'Role name must be unique.',
        },
        validate: {
          notEmpty: { msg: 'Role name cannot be empty.' },
          len: { args: [1, 50], msg: 'Role name must be between 1 and 50 characters.' },
        },
      },
      permission: {
        type: DataTypes.ENUM('Read', 'Read & Write'),
        allowNull: false,
        defaultValue: 'Read',
        validate: {
          isIn: { args: [['Read', 'Read & Write']], msg: 'Permission must be Read or Read & Write.' },
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
      // 1 (Platform Admin) .. 8 (Employee) for the admin chain; NULL for
      // roles outside it (HR is a parallel branch, not part of the numeric
      // hierarchy). See database/migrations/20260836_seed_target_roles_and_capabilities.sql.
      hierarchy_rank: {
        type: DataTypes.SMALLINT,
        allowNull: true,
      },
      // Self-referencing FK — this role's users also get every capability
      // granted (directly or transitively) to the referenced role. Only set
      // for the two edges the RBAC spec states (Service PO Admin <- Manager,
      // Project Admin <- Service PO Admin); NULL otherwise. See
      // src/services/roleHierarchyService.js.
      inherits_role_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'roles', key: 'id' },
      },
      // True for the 9 roles this RBAC redesign seeds — blocks
      // delete/rename via the dynamic Role CRUD (see roleService.js).
      is_system: {
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
    },
    {
      sequelize,
      modelName: 'Role',
      tableName: 'roles',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return Role;
};
