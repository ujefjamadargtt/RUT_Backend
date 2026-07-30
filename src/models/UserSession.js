'use strict';

const { Model, DataTypes } = require('sequelize');
const dateHelper = require('../helpers/dateHelper');

module.exports = (sequelize) => {
  class UserSession extends Model {
    static associate(models) {
      UserSession.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user',
      });
    }
  }

  UserSession.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'User is required.' },
        },
      },
      refresh_token: {
        type: DataTypes.TEXT,
        allowNull: true,
        unique: {
          name: 'user_sessions_refresh_token_key',
          msg: 'Refresh token must be unique.',
        },
      },
      expires_at: {
        type: DataTypes.DATE,
        allowNull: true,
        validate: {
          isDate: { msg: 'Expires at must be a valid timestamp.' },
        },
      },
      ip_address: {
        type: DataTypes.STRING(45),
        allowNull: true,
        validate: {
          len: { args: [0, 45], msg: 'IP address must be at most 45 characters.' },
        },
      },
      user_agent: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'UserSession',
      tableName: 'user_sessions',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
      hooks: {
        beforeCreate: (instance) => {
          if (!instance.created_at) {
            instance.created_at = dateHelper.nowDate();
          }
        },
      },
    }
  );

  return UserSession;
};
