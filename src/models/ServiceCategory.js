'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class ServiceCategory extends Model {
    static associate(models) {
      ServiceCategory.hasMany(models.ServiceType, {
        foreignKey: 'service_category_id',
        as: 'serviceTypes',
      });
    }
  }

  ServiceCategory.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id',
        },
      },
      name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Service category name cannot be empty.' },
          len: { args: [1, 100], msg: 'Service category name must be between 1 and 100 characters.' },
        },
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'active',
        validate: {
          isIn: {
            args: [['active', 'inactive']],
            msg: 'Status must be active or inactive.',
          },
        },
      },
      // Classifies this category into one of the fixed report buckets the
      // Dashboard/Analytics APIs expose (billable / non_billable /
      // customer_non_billable) — the single source of truth business logic
      // reads instead of comparing `name` string literals. NULL falls into
      // the existing "Other"/"Uncategorized" catch-all everywhere.
      report_bucket_key: {
        type: DataTypes.STRING(30),
        allowNull: true,
        validate: {
          isIn: {
            args: [['billable', 'non_billable', 'customer_non_billable']],
            msg: 'Report bucket key must be billable, non_billable, or customer_non_billable.',
          },
        },
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
      modelName: 'ServiceCategory',
      tableName: 'service_categories',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['company_id', 'name'], name: 'uq_service_categories_company_name' },
      ],
    }
  );

  return ServiceCategory;
};
