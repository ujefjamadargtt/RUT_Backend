'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Company Types — mapping table recording which companies adopted which
 * default type (provenance), plus custom types a company creates itself
 * (default_type_id NULL). Linked to CompanyCategory (not directly to
 * companies) — a company type always belongs to one of that same
 * company's category mappings. Does NOT replace service_types.
 */
module.exports = (sequelize) => {
  class CompanyType extends Model {
    static associate(models) {
      CompanyType.belongsTo(models.CompanyCategory, {
        foreignKey: 'company_category_id',
        as: 'companyCategory',
      });
      CompanyType.belongsTo(models.DefaultType, {
        foreignKey: 'default_type_id',
        as: 'defaultType',
      });
    }
  }

  CompanyType.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      company_category_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'company_categories',
          key: 'id',
        },
      },
      default_type_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'default_types',
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
      modelName: 'CompanyType',
      tableName: 'company_types',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // uq_company_types_category_default is a partial unique index (WHERE
      // default_type_id IS NOT NULL) — defined directly in
      // 20260818_create_company_types.sql.
    }
  );

  return CompanyType;
};
