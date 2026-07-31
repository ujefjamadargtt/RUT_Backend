'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const { apiLimiter } = require('./middlewares/rateLimiters');
const sanitizeInput = require('./middlewares/sanitizeInput');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const path = require('path');

const logger = require('./utils/logger');
const { sendError } = require('./utils/response');
const dateHelper = require('./helpers/dateHelper');

// ─── Route Imports ────────────────────────────────────────────────────────────
const authRoutes = require('./routes/authRoutes');
const employeeRoutes = require('./routes/employee.routes');
const userRoutes = require('./routes/user.routes');
const roleRoutes = require('./routes/role.routes');
const companyRoutes = require('./routes/company.routes');
const rbacRoutes = require('./routes/rbac.routes');
const formMasterRoutes = require('./routes/formMaster.routes');
const clientRoutes = require('./routes/client.routes');
const servicePORoutes = require('./routes/servicePO.routes');
const serviceTypeRoutes = require('./routes/serviceType.routes');
const serviceCategoryRoutes = require('./routes/serviceCategory.routes');
const subProjectRoutes = require('./routes/subProject.routes');
const monthlyCostRoutes = require('./routes/monthlyCost.routes');
const timesheetRoutes = require('./routes/timesheet.routes');
const reportRoutes = require('./routes/report.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const notificationRoutes = require('./routes/notification.routes');
const aiInsightRoutes = require('./routes/aiInsight.routes');
const aiCopilotRoutes = require('./routes/aiCopilot.routes');
const employeeServicePOMappingRoutes = require('./routes/employeeServicePOMapping.routes');
const employeeTimesheetRoutes = require('./routes/employeeTimesheet.routes');
const employeeReportRoutes = require('./routes/employeeReport.routes');

const app = express();

// trust proxy: how many hops of X-Forwarded-* headers to trust when
// determining req.ip/req.protocol. Keep this at 1 when running behind a
// reverse proxy/IIS; set TRUST_PROXY=false if Node terminates SSL directly
// with no proxy in front, so client IPs/headers can't be spoofed.
const TRUST_PROXY = process.env.TRUST_PROXY !== undefined
  ? (process.env.TRUST_PROXY === 'false' ? false : Number(process.env.TRUST_PROXY))
  : 1;
app.set('trust proxy', TRUST_PROXY);


// ─── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  // Left as-is: uploaded files under /uploads are intentionally fetchable
  // cross-origin (e.g. a frontend hosted on a different origin/tunnel
  // rendering an employee/client's uploaded document) — narrowing this
  // globally would block that existing, working flow.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Swagger UI (served from this same app at /api-docs) needs inline
      // styles/scripts and its own asset requests — scoped to 'self' plus
      // what swagger-ui-express actually injects, so the docs page keeps
      // rendering exactly as before.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
  // Explicit even though these are already Helmet v7 defaults — enterprise
  // hardening should not depend on implicit defaults surviving a future
  // Helmet upgrade.
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true,
}));

// CORS: origins are read from CORS_ORIGIN (comma-separated list, e.g.
// "https://app.example.com,https://admin.example.com"). If it isn't set,
// production rejects all cross-origin requests (fail closed); every other
// environment keeps the previous permissive behavior so local/dev/staging
// setups that never configured CORS_ORIGIN keep working unchanged.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // same-origin / server-to-server / curl
    if (allowedOrigins.length > 0) return callback(null, allowedOrigins.includes(origin));
    if (process.env.NODE_ENV === 'production') {
      logger.warn('Rejected cross-origin request: CORS_ORIGIN is not configured in production', { origin });
      return callback(null, false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Company-Id'],
  credentials: true,
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
app.use(apiLimiter);

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── Input Sanitization ───────────────────────────────────────────────────────
// Rejects operator-injection ($gt/$ne/...) and prototype-pollution
// (__proto__/constructor/prototype) key shapes in body/query/params.
app.use(sanitizeInput);

// ─── Static Uploads ───────────────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ─── Request Logger ───────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.http(`${req.method} ${req.originalUrl} - IP: ${req.ip}`);
  next();
});

// ─── Swagger / OpenAPI ────────────────────────────────────────────────────────
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'RUT Portal API',
      version: '1.0.0',
      description: 'Resource Utilization Tracking System — REST API Documentation',
      contact: {
        name: 'RUT Portal Support',
        email: 'support@rutportal.com',
      },
    },
    servers: [
      {
        url: `https://633b17xt-5555.inc1.devtunnels.ms/api/v1`,
        description: 'Local server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: [
    path.join(__dirname, 'routes', '*.js').replace(/\\/g, '/'),
    path.join(__dirname, 'controllers', '*.js').replace(/\\/g, '/'),
    path.join(__dirname, 'models', '*.js').replace(/\\/g, '/'),
  ],
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'RUT Portal API Docs',
  swaggerOptions: { persistAuthorization: true },
}));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'RUT Portal API is running',
    timestamp: dateHelper.nowISO(),
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0',
  });
});

// ─── API Routes ───────────────────────────────────────────────────────────────
// Allow overriding the API prefix via environment for flexibility (e.g. "/api")
const API_PREFIX = process.env.API_PREFIX || '/api/v1';

app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/employees`, employeeRoutes);
app.use(`${API_PREFIX}/users`, userRoutes);
app.use(`${API_PREFIX}/roles`, roleRoutes);
app.use(`${API_PREFIX}/companies`, companyRoutes);
app.use(`${API_PREFIX}/roles`, rbacRoutes);
app.use(`${API_PREFIX}/forms`, formMasterRoutes);
app.use(`${API_PREFIX}/clients`, clientRoutes);
app.use(`${API_PREFIX}/service-pos`, servicePORoutes);
app.use(`${API_PREFIX}/service-categories`, serviceCategoryRoutes);
app.use(`${API_PREFIX}/service-types`, serviceTypeRoutes);
app.use(`${API_PREFIX}/sub-projects`, subProjectRoutes);
app.use(`${API_PREFIX}/monthly-costs`, monthlyCostRoutes);
app.use(`${API_PREFIX}/timesheets`, timesheetRoutes);
app.use(`${API_PREFIX}/reports`, reportRoutes);
app.use(`${API_PREFIX}/dashboard`, dashboardRoutes);
app.use(`${API_PREFIX}/notifications`, notificationRoutes);
app.use(`${API_PREFIX}/ai-insights`, aiInsightRoutes);
app.use(`${API_PREFIX}/ai`, aiCopilotRoutes);
app.use(`${API_PREFIX}/employee-servicepo-mapping`, employeeServicePOMappingRoutes);
app.use(`${API_PREFIX}/employee-timesheets`, employeeTimesheetRoutes);
app.use(`${API_PREFIX}/employee-reports`, employeeReportRoutes);

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  sendError(res, `Route not found: ${req.method} ${req.originalUrl}`, 404);
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error('Unhandled error:', {
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
  });

  // Sequelize validation errors
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    const errors = err.errors
      ? err.errors.map((e) => ({ field: e.path, message: e.message }))
      : [];
    return sendError(res, 'Validation error', 422, errors);
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    return sendError(res, 'Invalid token', 401);
  }
  if (err.name === 'TokenExpiredError') {
    return sendError(res, 'Token has expired', 401);
  }

  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return sendError(res, 'File size exceeds the allowed limit', 413);
  }

  // Joi validation errors
  if (err.isJoi) {
    const errors = err.details.map((d) => ({ field: d.path.join('.'), message: d.message }));
    return sendError(res, 'Validation error', 422, errors);
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = process.env.NODE_ENV === 'production' && statusCode === 500
    ? 'An internal server error occurred'
    : err.message || 'Internal server error';

  sendError(res, message, statusCode);
});

module.exports = app;
