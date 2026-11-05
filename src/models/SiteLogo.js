'use strict';

const { Model, DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  class SiteLogo extends Model {}

  SiteLogo.init(
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      file_name: { type: DataTypes.STRING(255), allowNull: false },
      mime_type: { type: DataTypes.STRING(50), allowNull: false },
      file_size: { type: DataTypes.INTEGER, allowNull: false },
      image_data: { type: DataTypes.BLOB, allowNull: false },
      is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
      uploaded_by: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
      },
    },
    {
      sequelize,
      modelName: 'SiteLogo',
      tableName: 'site_logos',
      underscored: true,
      timestamps: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      // The (potentially large) bytes are never loaded unless a query asks for them by name.
      defaultScope: { attributes: { exclude: ['image_data'] } },
    }
  );

  return SiteLogo;
};
