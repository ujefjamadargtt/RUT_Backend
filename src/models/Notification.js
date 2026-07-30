'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Notification extends Model {
    static associate(models) {
      Notification.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user',
      });
    }
  }

  Notification.init(
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
      title: {
        type: DataTypes.STRING(200),
        allowNull: true,
        validate: {
          len: { args: [0, 200], msg: 'Title must be at most 200 characters.' },
        },
      },
      message: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      type: {
        type: DataTypes.ENUM('info', 'warning', 'error', 'success'),
        allowNull: false,
        defaultValue: 'info',
        validate: {
          isIn: {
            args: [['info', 'warning', 'error', 'success']],
            msg: 'Type must be info, warning, error, or success.',
          },
        },
      },
      is_read: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      sequelize,
      modelName: 'Notification',
      tableName: 'notifications',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return Notification;
};
