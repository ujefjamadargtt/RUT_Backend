'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Default Types Master — mirrors DefaultCategory.js. See that file's doc.
 */
module.exports = (sequelize) => {
  class DefaultType extends Model {
    static associate(models) {
      DefaultType.belongsTo(models.DefaultCategory, {
        foreignKey: 'default_category_id',
        as: 'defaultCategory',
      });
    }
  }

  DefaultType.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      default_category_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'default_categories',
          key: 'id',
        },
      },
      type_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Type name cannot be empty.' },
        },
      },
      display_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
        validate: {
          isIn: { args: [['active', 'inactive']], msg: 'Status must be active or inactive.' },
        },
      },
    },
    {
      sequelize,
      modelName: 'DefaultType',
      tableName: 'default_types',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['type_name'], name: 'uq_default_types_name' },
      ],
    }
  );

  return DefaultType;
};
