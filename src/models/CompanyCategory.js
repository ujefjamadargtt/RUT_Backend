'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Company Categories — mapping table recording which companies adopted
 * which default category (provenance), plus custom categories a company
 * creates itself (default_category_id NULL). Does NOT replace
 * service_categories, which remains the physical row every report/
 * dashboard/timesheet/import query reads. See companyService.js and
 * serviceCategoryService.js for how rows land here.
 */
module.exports = (sequelize) => {
  class CompanyCategory extends Model {
    static associate(models) {
      CompanyCategory.belongsTo(models.DefaultCategory, {
        foreignKey: 'default_category_id',
        as: 'defaultCategory',
      });
      CompanyCategory.hasMany(models.CompanyType, {
        foreignKey: 'company_category_id',
        as: 'companyTypes',
      });
    }
  }

  CompanyCategory.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'companies',
          key: 'id',
        },
      },
      default_category_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'default_categories',
          key: 'id',
        },
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
      modelName: 'CompanyCategory',
      tableName: 'company_categories',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // uq_company_categories_company_default is a partial unique index
      // (WHERE default_category_id IS NOT NULL) — cannot be expressed via
      // Sequelize's indexes: [] shorthand, defined directly in
      // 20260817_create_company_categories.sql.
    }
  );

  return CompanyCategory;
};
