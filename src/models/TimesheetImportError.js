'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class TimesheetImportError extends Model {
    static associate(models) {
      TimesheetImportError.belongsTo(models.TimesheetImportHistory, {
        foreignKey: 'import_id',
        as: 'importHistory',
      });
    }
  }

  TimesheetImportError.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      // Derivable transitively through the parent TimesheetImportHistory row,
      // stored directly too for defense-in-depth on any direct query.
      company_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id',
        },
      },
      import_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'timesheet_import_history',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Import history reference is required.' },
        },
      },
      row_number: {
        type: DataTypes.INTEGER,
        allowNull: true,
        validate: {
          isInt: { msg: 'Row number must be an integer.' },
          min:   { args: [1], msg: 'Row number must be at least 1.' },
        },
      },
      row_data: {
        type: DataTypes.JSONB,
        allowNull: true,
      },
      error_message: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'TimesheetImportError',
      tableName: 'timesheet_import_errors',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: false,
    }
  );

  return TimesheetImportError;
};
