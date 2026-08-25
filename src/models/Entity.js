'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Entity Master — the new tenancy tier between Platform Admin and Company/
 * BU Admin. Owned by exactly one Entity Admin User at a time
 * (entity_admin_user_id, nullable — a freshly-created Entity Admin starts
 * with none until they create their own via the Entity Master screen; see
 * entityService.js). Every Company must belong to exactly one Entity (see
 * Company.js's entity_id).
 */
module.exports = (sequelize) => {
  class Entity extends Model {
    static associate(models) {
      Entity.hasMany(models.Company, {
        foreignKey: 'entity_id',
        as: 'companies',
      });
    }
  }

  Entity.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      entity_code: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Entity code cannot be empty.' },
          len: { args: [1, 20], msg: 'Entity code must be between 1 and 20 characters.' },
        },
      },
      entity_name: {
        type: DataTypes.STRING(150),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Entity name cannot be empty.' },
          len: { args: [1, 150], msg: 'Entity name must be between 1 and 150 characters.' },
        },
      },
      entity_admin_employee_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'employees',
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
      modelName: 'Entity',
      tableName: 'entities',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['entity_code'], name: 'uq_entities_entity_code' },
      ],
    }
  );

  return Entity;
};
