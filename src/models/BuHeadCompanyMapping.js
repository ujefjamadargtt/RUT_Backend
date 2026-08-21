'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * BU Head <-> Company mapping — a BU Head User (users.role_id = 'BU Head')
 * mapped to one or more existing Companies ("BUs"). Unique on
 * (bu_head_user_id, company_id) — the same Company can never be mapped
 * twice to the same BU Head (see
 * database/migrations/20260863_create_bu_head_company_mappings.sql).
 * Unmapping deletes only this row — never the Company/User/Employee it
 * points at.
 */
module.exports = (sequelize) => {
  class BuHeadCompanyMapping extends Model {
    static associate(models) {
      BuHeadCompanyMapping.belongsTo(models.User, {
        foreignKey: 'bu_head_user_id',
        as: 'buHead',
      });
      BuHeadCompanyMapping.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
      });
    }
  }

  BuHeadCompanyMapping.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      bu_head_user_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'BU Head user is required.' },
        },
      },
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'companies',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Company is required.' },
        },
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'active',
        validate: {
          isIn: { args: [['active', 'inactive']], msg: 'Status must be active or inactive.' },
        },
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
      modelName: 'BuHeadCompanyMapping',
      tableName: 'bu_head_company_mappings',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['bu_head_user_id', 'company_id'], name: 'uq_bu_head_company_mappings_bu_head_company' },
      ],
    }
  );

  return BuHeadCompanyMapping;
};
