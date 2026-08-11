'use strict';

const { Model, DataTypes } = require('sequelize');
const bcrypt = require('bcrypt');

const BCRYPT_ROUNDS = 12;

module.exports = (sequelize) => {
  class User extends Model {
    static associate(models) {
      User.belongsTo(models.Role, {
        foreignKey: 'role_id',
        as: 'role',
      });
      User.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
      User.hasMany(models.UserSession, {
        foreignKey: 'user_id',
        as: 'sessions',
      });
      User.hasMany(models.AuditLog, {
        foreignKey: 'user_id',
        as: 'auditLogs',
      });
      User.hasMany(models.Notification, {
        foreignKey: 'user_id',
        as: 'notifications',
      });
    }

    /**
     * Compares a plain-text password against the stored bcrypt hash.
     * @param {string} plainPassword
     * @returns {Promise<boolean>}
     */
    async validatePassword(plainPassword) {
      return bcrypt.compare(plainPassword, this.password);
    }
  }

  User.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      // Nullable: Platform Admin (role.hierarchy_rank === 1) and Entity
      // Admin (scoped to a set of Entities, not one company) have no
      // company_id; every other user belongs to exactly one company.
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id',
        },
      },
      employee_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'employees',
          key: 'id',
        },
      },
      email: {
        type: DataTypes.STRING(100),
        allowNull: false,
        unique: {
          name: 'users_email_key',
          msg: 'Email address must be unique.',
        },
        validate: {
          notEmpty: { msg: 'Email cannot be empty.' },
          isEmail: { msg: 'Must be a valid email address.' },
          len: { args: [1, 100], msg: 'Email must be at most 100 characters.' },
        },
      },
      password: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Password cannot be empty.' },
        },
      },
      role_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'roles',
          key: 'id',
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
      last_login: {
        type: DataTypes.DATE,
        allowNull: true,
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
      modelName: 'User',
      tableName: 'users',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // Exclude password by default; use User.scope('withPassword') when needed
      defaultScope: {
        attributes: { exclude: ['password'] },
      },
      scopes: {
        withPassword: {
          attributes: {},
        },
      },
      hooks: {
        beforeCreate: async (user) => {
          if (user.password) {
            user.password = await bcrypt.hash(user.password, BCRYPT_ROUNDS);
          }
        },
        beforeUpdate: async (user) => {
          if (user.changed('password') && user.password) {
            user.password = await bcrypt.hash(user.password, BCRYPT_ROUNDS);
          }
        },
      },
    }
  );

  return User;
};
