'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Role extends Model {
    static associate(models) {
      Role.hasMany(models.User, {
        foreignKey: 'role_id',
        as: 'users',
      });
      Role.belongsToMany(models.User, {
        through: models.UserRole,
        foreignKey: 'role_id',
        otherKey: 'user_id',
        as: 'usersWithRoles',
      });
    }
  }

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
      // Whether users assigned to this role may view original/raw data in
      // the application. Defaults to false — hidden unless explicitly granted.
      is_original_data_visible: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      is_deleted: {
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
