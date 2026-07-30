'use strict';

const { Model, DataTypes } = require('sequelize');

/**
 * AiInsight — a single generated AI insight (one row per Claude generation).
 * Written once by aiInsightService.runJob() after Claude returns; read_status
 * and dismiss_status are the only fields updated afterwards, via the
 * mark-as-read / dismiss endpoints.
 */
module.exports = (sequelize) => {
  class AiInsight extends Model {
    static associate(models) {
      AiInsight.belongsTo(models.AiInsightJob, {
        foreignKey: 'job_id',
        as: 'job',
      });
    }
  }

  AiInsight.init(
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
      job_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        references: {
          model: 'ai_insight_jobs',
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
      // Optional pointer to the record that triggered an event-driven insight
      // (e.g. the service_pos.id for a New PO Staffing Suggestion).
      reference_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      title: {
        type: DataTypes.STRING(300),
        allowNull: false,
      },
      severity: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'info',
        validate: {
          isIn: {
            args: [['critical', 'warning', 'info']],
            msg: 'Severity must be critical, warning, or info.',
          },
        },
      },
      summary: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      findings: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      actions: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      audience_roles: {
        type: DataTypes.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      ai_response: {
        type: DataTypes.JSONB,
        allowNull: true,
        // Full raw JSON returned by Claude, kept for traceability/debugging.
      },
      generated_at: {
        type: DataTypes.DATE,
        allowNull: false,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'completed',
        validate: {
          isIn: {
            args: [['completed', 'failed']],
            msg: 'Status must be completed or failed.',
          },
        },
      },
      is_read: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      is_dismissed: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      sequelize,
      modelName: 'AiInsight',
      tableName: 'ai_insights',
      timestamps: true,
      underscored: true,
      createdAt: 'created_at',
      updatedAt: 'updated_at',
      indexes: [
        { fields: ['job_key'] },
        { fields: ['is_read'] },
        { fields: ['is_dismissed'] },
        { fields: ['generated_at'] },
      ],
    }
  );

  return AiInsight;
};
