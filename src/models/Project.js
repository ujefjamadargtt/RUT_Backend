'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Project extends Model {
    static associate(models) {
      Project.hasMany(models.ServicePO, {
        foreignKey: 'project_id',
        as: 'servicePOs',
      });
      Project.belongsTo(models.Client, {
        foreignKey: 'client_id',
        as: 'client',
      });
    }
  }

  Project.init(
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
      // Every Project belongs to exactly one Client. Nullable at the DB
      // level only for Projects that pre-date this feature (no real Client
      // to backfill onto) — required at the application layer for every
      // NEW Project (see projectValidation.js / projectService.js).
      client_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'clients',
          key: 'id',
        },
      },
      project_code: {
        type: DataTypes.STRING(30),
        allowNull: false,
        // Uniqueness is per-company — see the uq_projects_company_code
        // composite index in this model's options below.
        validate: {
          notEmpty: { msg: 'Project code cannot be empty.' },
          len: { args: [1, 30], msg: 'Project code must be between 1 and 30 characters.' },
        },
      },
      project_name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Project name cannot be empty.' },
          len: { args: [1, 200], msg: 'Project name must be between 1 and 200 characters.' },
        },
      },
      project_description: {
        type: DataTypes.TEXT,
        allowNull: true,
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
      modelName: 'Project',
      tableName: 'projects',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['company_id', 'project_code'], name: 'uq_projects_company_code' },
      ],
    }
  );

  return Project;
};
