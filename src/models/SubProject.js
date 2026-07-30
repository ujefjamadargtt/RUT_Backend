'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class SubProject extends Model {
    static associate(models) {
      SubProject.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
      SubProject.hasMany(models.Timesheet, {
        foreignKey: 'sub_project_id',
        as: 'timesheets',
      });
    }
  }

  SubProject.init(
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
      sub_project_code: {
        type: DataTypes.STRING(30),
        allowNull: false,
        // Uniqueness is now per-company — see the uq_sub_projects_company_code
        // composite index in this model's options below.
        validate: {
          notEmpty: { msg: 'Sub-project code cannot be empty.' },
          len: { args: [1, 30], msg: 'Sub-project code must be between 1 and 30 characters.' },
        },
      },
      service_po_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'service_pos',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Service PO is required.' },
        },
      },
      sub_project_name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Sub-project name cannot be empty.' },
          len: { args: [1, 200], msg: 'Sub-project name must be between 1 and 200 characters.' },
        },
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      start_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        validate: {
          isDate: { msg: 'Start date must be a valid date.' },
        },
      },
      end_date: {
        type: DataTypes.DATEONLY,
        allowNull: true,
        validate: {
          isDate: { msg: 'End date must be a valid date.' },
          isAfterStart(value) {
            if (value && this.start_date && value < this.start_date) {
              throw new Error('End date must be on or after start date.');
            }
          },
        },
      },
      status: {
        type: DataTypes.ENUM('active', 'inactive'),
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
      modelName: 'SubProject',
      tableName: 'sub_projects',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['company_id', 'sub_project_code'], name: 'uq_sub_projects_company_code' },
      ],
    }
  );

  return SubProject;
};
