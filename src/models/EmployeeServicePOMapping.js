'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class EmployeeServicePOMapping extends Model {
    static associate(models) {
      EmployeeServicePOMapping.belongsTo(models.Employee, {
        foreignKey: 'employee_id',
        as: 'employee',
      });
      EmployeeServicePOMapping.belongsTo(models.ServicePO, {
        foreignKey: 'service_po_id',
        as: 'servicePO',
      });
      EmployeeServicePOMapping.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
      });
    }
  }

  EmployeeServicePOMapping.init(
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
      employee_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: {
          model: 'employees',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Employee is required.' },
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
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'active',
        validate: {
          isIn: { args: [['active', 'inactive']], msg: 'Status must be active or inactive.' },
        },
      },
      // True only when this SAME mapping row also carries Project
      // Manager/approver authority for this one Service PO — never implied
      // merely by the employee holding the Project Manager role or by the
      // existence of this mapping row itself. See
      // employeeServicePOMappingService.js's getProjectManagerServicePOIds()/
      // getProjectManagersForServicePOs() (the approval-routing consumers of
      // this flag) and database/migrations/
      // 20260903_add_is_project_manager_to_employee_servicepo_mapping.sql.
      is_project_manager: {
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
      modelName: 'EmployeeServicePOMapping',
      tableName: 'employee_servicepo_mapping',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['employee_id', 'service_po_id'], name: 'uq_employee_servicepo_mapping' },
      ],
    }
  );

  return EmployeeServicePOMapping;
};
