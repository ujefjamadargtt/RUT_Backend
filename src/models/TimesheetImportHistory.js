'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class TimesheetImportHistory extends Model {
    static associate(models) {
      TimesheetImportHistory.belongsTo(models.User, {
        foreignKey: 'imported_by',
        as: 'importer',
      });
      TimesheetImportHistory.hasMany(models.TimesheetImportError, {
        foreignKey: 'import_id',
        as: 'errors',
      });
    }
  }

  TimesheetImportHistory.init(
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
      imported_by: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Importer user is required.' },
        },
      },
      file_name: {
        type: DataTypes.STRING(255),
        allowNull: true,
      },
      file_path: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      total_rows: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
        validate: {
          isInt: { msg: 'Total rows must be an integer.' },
          min:   { args: [0], msg: 'Total rows cannot be negative.' },
        },
      },
      valid_rows: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
        validate: {
          isInt: { msg: 'Valid rows must be an integer.' },
          min:   { args: [0], msg: 'Valid rows cannot be negative.' },
        },
      },
      error_rows: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
        validate: {
          isInt: { msg: 'Error rows must be an integer.' },
          min:   { args: [0], msg: 'Error rows cannot be negative.' },
        },
      },
      import_month: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: {
          min: { args: [1],  msg: 'Month must be between 1 and 12.' },
          max: { args: [12], msg: 'Month must be between 1 and 12.' },
        },
      },
      import_year: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: {
          min: { args: [2000], msg: 'Year must be 2000 or later.' },
        },
      },
      status: {
        type: DataTypes.ENUM('pending', 'processing', 'completed', 'failed', 'partial'),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: {
            args: [['pending', 'processing', 'completed', 'failed', 'partial']],
            msg: 'Status must be pending, processing, completed, failed, or partial.',
          },
        },
      },
      // One-way flag: set true when any child timesheet row's modified_hours
      // is edited via PATCH /timesheets/:id/modified-hours. Never reset to
      // false anywhere in this feature.
      is_publish: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      sequelize,
      modelName: 'TimesheetImportHistory',
      tableName: 'timesheet_import_history',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return TimesheetImportHistory;
};
