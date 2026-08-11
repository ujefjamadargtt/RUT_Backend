'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Default Categories Master — the single platform-wide source of category
 * names every company's service_categories rows are seeded from (see
 * companyService.js). Does NOT replace service_categories; see that
 * table's own model for what every report/dashboard/timesheet query
 * actually reads.
 */
module.exports = (sequelize) => {
  class DefaultCategory extends Model {
    static associate(models) {
      DefaultCategory.hasMany(models.DefaultType, {
        foreignKey: 'default_category_id',
        as: 'defaultTypes',
      });
    }
  }

  DefaultCategory.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      category_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Category name cannot be empty.' },
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
      modelName: 'DefaultCategory',
      tableName: 'default_categories',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['category_name'], name: 'uq_default_categories_name' },
      ],
    }
  );

  return DefaultCategory;
};
