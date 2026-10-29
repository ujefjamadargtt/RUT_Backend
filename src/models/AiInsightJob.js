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
      // Schedule — see utils/scheduleExpression.js. All null for frequency = 'event'
      // (triggered by application events, not a schedule).
      schedule_type: {
        type: DataTypes.STRING(2),
        allowNull: true,
        validate: {
          isIn: {
            args: [['MI', 'DL', 'WL', 'ML', 'QL']],
            msg: 'Schedule type must be one of: MI, DL, WL, ML, QL.',
          },
        },
        // DL daily | WL weekly | ML monthly | QL quarterly | MI every N minutes
      },
      scheduled_time: {
        type: DataTypes.TIME,
        allowNull: true,
        // 24-hour time of day (DL / WL / ML / QL), app timezone
      },
      week_day: {
        type: DataTypes.STRING(3),
        allowNull: true,
        validate: {
          isIn: {
            args: [['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']],
            msg: 'Week day must be one of: MON, TUE, WED, THU, FRI, SAT, SUN.',
          },
        },
        // WL only
      },
      month_day: {
        type: DataTypes.SMALLINT,
        allowNull: true,
        validate: { min: 1, max: 28 },
        // ML / QL only (QL = that day of Jan/Apr/Jul/Oct)
      },
      interval_minutes: {
        type: DataTypes.SMALLINT,
        allowNull: true,
        // MI only — must divide 60 evenly (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30)
      },
      // Legacy fallback: a hand-written cron, honoured only when schedule_type is null.
      cron_expression: {
        type: DataTypes.STRING(50),
        allowNull: true,
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
