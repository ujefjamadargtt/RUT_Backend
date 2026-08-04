'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * Service PO Hierarchy — Parent/Child nodes belonging to exactly ONE
 * Service PO. Max depth 2 inside a PO (Service PO -> Parent -> Child); a
 * CHILD row can never itself be a parent_hierarchy_id target — enforced in
 * servicePOHierarchyService.js, not at this model layer.
 *
 * No company_id column — tenant scoping is derived through service_po_id ->
 * service_pos.company_id (see servicePOHierarchyService.js), not stored
 * redundantly here.
 */
module.exports = (sequelize) => {
  class ServicePOHierarchy extends Model {}

  ServicePOHierarchy.init(
    {
      id: {
        type: DataTypes.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      service_po_id: {
        type: DataTypes.BIGINT,
        allowNull: false,
        references: {
          model: 'service_pos',
          key: 'id',
        },
        validate: {
          notNull: { msg: 'Service PO is required.' },
        },
      },
      parent_hierarchy_id: {
        type: DataTypes.BIGINT,
        allowNull: true,
        references: {
          model: 'service_po_hierarchy',
          key: 'id',
        },
      },
      node_name: {
        type: DataTypes.STRING(255),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Node name cannot be empty.' },
          len: { args: [1, 255], msg: 'Node name must be between 1 and 255 characters.' },
        },
      },
      node_type: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
          isIn: { args: [['PARENT', 'CHILD']], msg: 'Node type must be PARENT or CHILD.' },
        },
      },
      display_order: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      status: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
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
      modelName: 'ServicePOHierarchy',
      tableName: 'service_po_hierarchy',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    }
  );

  return ServicePOHierarchy;
};
