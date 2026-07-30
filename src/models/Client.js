'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class Client extends Model {
    static associate(models) {
      Client.hasMany(models.ServicePO, {
        foreignKey: 'client_id',
        as: 'servicePOs',
      });
    }
  }

  Client.init(
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
      client_code: {
        type: DataTypes.STRING(20),
        allowNull: false,
        // Uniqueness is now per-company — see the uq_clients_company_code
        // composite index in this model's options below, not a single-field
        // constraint here.
        validate: {
          notEmpty: { msg: 'Client code cannot be empty.' },
          len: { args: [1, 20], msg: 'Client code must be between 1 and 20 characters.' },
        },
      },
      client_name: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Client name cannot be empty.' },
          len: { args: [1, 100], msg: 'Client name must be between 1 and 100 characters.' },
        },
      },
      industry: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      status: {
        type: DataTypes.ENUM('active', 'inactive'),
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
      modelName: 'Client',
      tableName: 'clients',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['company_id', 'client_code'], name: 'uq_clients_company_code' },
      ],
    }
  );

  return Client;
};
