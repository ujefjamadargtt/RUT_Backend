'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * AiInsightJob — job configuration for the AI Insights module.
 * One row per insight job (weekly_resource_digest, po_ending_alerts, ...).
 * Seeded from the static definitions in aiInsightJobRepository.js on
 * startup (insert-if-missing, never overwritten), so an admin can later
 * toggle is_active or adjust cron_expression directly in the DB without a
 * code deploy.
 */
module.exports = (sequelize) => {
  class AiInsightJob extends Model {
    static associate(models) {
      AiInsightJob.hasMany(models.AiInsight, {
        foreignKey: 'job_id',
        as: 'insights',
      });
    }
  }

  AiInsightJob.init(
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
      job_key: {
        type: DataTypes.STRING(100),
        allowNull: false,
        validate: {
          notEmpty: { msg: 'Job key cannot be empty.' },
        },
      },
      title: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      description: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      frequency: {
        type: DataTypes.STRING(20),
        allowNull: false,
        validate: {
          isIn: {
            args: [['daily', 'weekly', 'monthly', 'quarterly', 'event']],
            msg: 'Frequency must be one of: daily, weekly, monthly, quarterly, event.',
          },
        },
      },
      cron_expression: {
        type: DataTypes.STRING(50),
        allowNull: true,
        // null for frequency = 'event' (triggered by application events, not cron)
      },
      audience_roles: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      is_active: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      last_run_at: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      last_run_status: {
        type: DataTypes.STRING(20),
        allowNull: true,
        validate: {
          isIn: {
            args: [['success', 'failed']],
            msg: 'Last run status must be success or failed.',
          },
        },
      },
      last_error: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
    },
    {
      sequelize,
      modelName: 'AiInsightJob',
      tableName: 'ai_insight_jobs',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { unique: true, fields: ['job_key'], name: 'ai_insight_jobs_job_key_unique' },
      ],
    }
  );

  return AiInsightJob;
};
