'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Employee Role — many-to-many Employee <-> Role, replacing the old
 * users.role_id (single primary) + user_additional_roles (extras) split now
 * that login lives on Employee. At most one senior-tier role (hierarchy_rank
 * <= 4) per employee is enforced in employeeService.js, not here — see
 * database/migrations/20260865_create_employee_roles.sql.
 */
module.exports = (sequelize) => {
  class EmployeeRole extends Model {
    static associate(models) {
      EmployeeRole.belongsTo(models.Employee, { foreignKey: 'employee_id', as: 'employee' });
      EmployeeRole.belongsTo(models.Role, { foreignKey: 'role_id', as: 'role' });
    }
  }

  EmployeeRole.init(
    {
      id: {
        type: DataTypes.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      employee_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'employees', key: 'id' },
      },
      role_id: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'roles', key: 'id' },
      },
      status: {
        type: DataTypes.STRING(10),
        allowNull: false,
        defaultValue: 'active',
        validate: {
          isIn: { args: [['active', 'inactive']], msg: 'Status must be active or inactive.' },
        },
      },
      created_by: { type: DataTypes.INTEGER, allowNull: true },
      updated_by: { type: DataTypes.INTEGER, allowNull: true },
    },
    {
      sequelize,
      modelName: 'EmployeeRole',
      tableName: 'employee_roles',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['employee_id', 'role_id'], name: 'uq_employee_roles_employee_role' },
      ],
    }
  );

  return EmployeeRole;
};
