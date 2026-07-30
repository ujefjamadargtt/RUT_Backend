'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class ServicePO extends Model {
    static associate(models) {
      ServicePO.belongsTo(models.Client, {
        foreignKey: 'client_id',
        as: 'client',
      });
      ServicePO.belongsTo(models.ServiceType, {
        foreignKey: 'service_type_id',
        as: 'serviceType',
      });
      ServicePO.hasMany(models.ServicePOResource, {
        foreignKey: 'service_po_id',
        as: 'resources',
      });
      ServicePO.hasMany(models.SubProject, {
        foreignKey: 'service_po_id',
        as: 'subProjects',
      });
      ServicePO.hasMany(models.Timesheet, {
        foreignKey: 'service_po_id',
        as: 'timesheets',
      });
      ServicePO.belongsToMany(models.Employee, {
        through: models.ServicePOResource,
        foreignKey: 'service_po_id',
        otherKey: 'employee_id',
        as: 'employees',
      });
    }
  }

  ServicePO.init(
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
      service_po_code: {
        type: DataTypes.STRING(30),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Service PO code cannot be empty.' },
          len: { args: [1, 30], msg: 'Service PO code must be between 1 and 30 characters.' },
        },
      },
      service_po_name: {
        type: DataTypes.STRING(200),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Service PO name cannot be empty.' },
          len: { args: [1, 200], msg: 'Service PO name must be between 1 and 200 characters.' },
        },
      },
      client_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'clients',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Client is required.' },
        },
      },
      service_type_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'service_types',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Service type is required.' },
        },
      },
      po_value: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'PO value cannot be negative.' },
        },
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
      expected_man_hours: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Expected man hours cannot be negative.' },
        },
      },
      is_billable: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      account_manager: {
        type: DataTypes.STRING(100),
        allowNull: true,
        validate: {
          len: { args: [0, 100], msg: 'Account manager name cannot exceed 100 characters.' },
        },
      },
      service_description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      invoice_frequency: {
        type: DataTypes.ENUM('monthly', 'milestone-based', 'internal-no-invoice', 'poc', 'yearly-amc'),
        allowNull: true,
        validate: {
          isIn: {
            args: [['monthly', 'milestone-based', 'internal-no-invoice', 'poc', 'yearly-amc']],
            msg: 'Invoice frequency must be one of: monthly, milestone-based, internal-no-invoice, poc, yearly-amc.',
          },
        },
      },
      invoice_amount: {
        type: DataTypes.DECIMAL(15, 2),
        allowNull: true,
        validate: {
          min: { args: [0], msg: 'Invoice amount cannot be negative.' },
        },
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
        validate: {
          isIn: {
            args: [['in-progress', 'completed', 'on-hold', 'pending', 'cancelled', 'closed']],
            msg: 'Status must be one of: in-progress, completed, on-hold, pending, cancelled, closed.',
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
      modelName: 'ServicePO',
      tableName: 'service_pos',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['company_id', 'service_po_code'], name: 'uq_service_pos_company_code' },
      ],
    }
  );

  return ServicePO;
};
