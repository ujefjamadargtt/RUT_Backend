'use strict';

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const dateHelper = require('../helpers/dateHelper');

// ── Upload Directories ────────────────────────────────────────────────────────
const UPLOAD_DIR          = path.resolve(__dirname, '../uploads/timesheets');
const FINANCE_UPLOAD_DIR  = path.resolve(__dirname, '../uploads/finance');
const EMPLOYEE_UPLOAD_DIR = path.resolve(__dirname, '../uploads/employees');
const CLIENT_UPLOAD_DIR   = path.resolve(__dirname, '../uploads/clients');
const SERVICE_PO_UPLOAD_DIR = path.resolve(__dirname, '../uploads/service-pos');

// Ensure upload directories exist at startup
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(FINANCE_UPLOAD_DIR)) {
  fs.mkdirSync(FINANCE_UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(EMPLOYEE_UPLOAD_DIR)) {
  fs.mkdirSync(EMPLOYEE_UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(CLIENT_UPLOAD_DIR)) {
  fs.mkdirSync(CLIENT_UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(SERVICE_PO_UPLOAD_DIR)) {
  fs.mkdirSync(SERVICE_PO_UPLOAD_DIR, { recursive: true });
}

// ── Allowed MIME Types & Extensions ──────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls (legacy)
  'text/csv',                                                           // .csv
  'application/csv',
  'text/plain',                                                         // some OS send .csv as text/plain
]);

const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.csv']);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ── Disk Storage Configuration ────────────────────────────────────────────────
const timesheetStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-z0-9_\-]/gi, '_') // sanitize original name
      .toLowerCase()
      .slice(0, 60); // cap length

    const datePrefix = dateHelper.nowFilenamePrefix();

    const userId = req.userId ? `_u${req.userId}` : '';
    const uniqueSuffix = `${datePrefix}${userId}_${baseName}${ext}`;

    cb(null, uniqueSuffix);
  },
});

// ── File Filter ───────────────────────────────────────────────────────────────
const timesheetFileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype.toLowerCase();

  if (ALLOWED_EXTENSIONS.has(ext) && ALLOWED_MIME_TYPES.has(mime)) {
    return cb(null, true);
  }

  // Allow .csv with application/octet-stream (common in some browsers/OS)
  if (ext === '.csv' && mime === 'application/octet-stream') {
    return cb(null, true);
  }

  const err = new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname);
  err.message = `Invalid file type. Only .xlsx and .csv files are accepted. Received: "${ext || mime}".`;
  cb(err, false);
};

// ── Multer Instance: Excel / CSV Upload (Timesheets) ─────────────────────────
const uploadExcel = multer({
  storage: timesheetStorage,
  fileFilter: timesheetFileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

// ── Disk Storage: Finance / Monthly Cost uploads ──────────────────────────────
const financeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, FINANCE_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-z0-9_\-]/gi, '_')
      .toLowerCase()
      .slice(0, 60);
    const datePrefix = dateHelper.nowFilenamePrefix();
    const userId = req.userId ? `_u${req.userId}` : '';
    cb(null, `${datePrefix}${userId}_${baseName}${ext}`);
  },
});

// ── Multer Instance: Finance Excel Upload ─────────────────────────────────────
const uploadFinanceExcel = multer({
  storage: financeStorage,
  fileFilter: timesheetFileFilter, // same MIME / extension rules
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 1,
  },
});

// ── Convenience middleware wrappers ───────────────────────────────────────────

/**
 * Single file upload for timesheet import.
 * Field name: "file"
 * Usage: router.post('/import', authenticate, uploadExcel.single('file'), handler)
 */
const uploadTimesheetSingle = uploadExcel.single('file');

/**
 * Wraps multer upload in a promise that passes MulterError to next()
 * instead of throwing, so the global errorHandler can catch it.
 */
const handleTimesheetUpload = (req, res, next) => {
  uploadTimesheetSingle(req, res, (err) => {
    if (err) {
      return next(err);
    }
    if (!req.file) {
      return res.status(400).json({
        success: false,
        code: 'NO_FILE',
        message: 'No file was uploaded. Please attach a .xlsx or .csv file in the "file" field.',
      });
    }
    next();
  });
};

/**
 * Single file upload for monthly cost / finance Excel import.
 * Field name: "file"
 * Usage: router.post('/import', authenticate, handleMonthlyCostUpload, handler)
 */
const uploadMonthlyCostSingle = uploadFinanceExcel.single('file');

const handleMonthlyCostUpload = (req, res, next) => {
  uploadMonthlyCostSingle(req, res, (err) => {
    if (err) {
      return next(err);
    }
    if (!req.file) {
      return res.status(400).json({
        success: false,
        code: 'NO_FILE',
        message: 'No file was uploaded. Please attach a .xlsx file in the "file" field.',
      });
    }
    next();
  });
};

// ── Disk Storage: Employee Import uploads ─────────────────────────────────────
const employeeStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, EMPLOYEE_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-z0-9_\-]/gi, '_')
      .toLowerCase()
      .slice(0, 60);
    const datePrefix = dateHelper.nowFilenamePrefix();
    const userId = req.userId ? `_u${req.userId}` : '';
    cb(null, `${datePrefix}${userId}_${baseName}${ext}`);
  },
});

const uploadEmployeeExcel = multer({
  storage: employeeStorage,
  fileFilter: timesheetFileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
});

const handleEmployeeUpload = (req, res, next) => {
  uploadEmployeeExcel.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) {
      return res.status(400).json({
        success: false,
        code: 'NO_FILE',
        message: 'No file was uploaded. Please attach a .xlsx or .csv file in the "file" field.',
      });
    }
    next();
  });
};

// ── Disk Storage: Client Import uploads ───────────────────────────────────────
const clientStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, CLIENT_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext      = path.extname(file.originalname).toLowerCase();
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-z0-9_\-]/gi, '_')
      .toLowerCase()
      .slice(0, 60);
    const datePrefix = dateHelper.nowFilenamePrefix();
    const userId     = req.userId ? `_u${req.userId}` : '';
    cb(null, `${datePrefix}${userId}_${baseName}${ext}`);
  },
});

const uploadClientExcel = multer({
  storage: clientStorage,
  fileFilter: timesheetFileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
});

const handleClientUpload = (req, res, next) => {
  uploadClientExcel.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) {
      return res.status(400).json({
        success: false,
        code: 'NO_FILE',
        message: 'No file was uploaded. Please attach a .xlsx or .csv file in the "file" field.',
      });
    }
    next();
  });
};

// ── Disk Storage: Service PO Import uploads ───────────────────────────────────
const servicePOStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, SERVICE_PO_UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    const ext      = path.extname(file.originalname).toLowerCase();
    const baseName = path
      .basename(file.originalname, ext)
      .replace(/[^a-z0-9_\-]/gi, '_')
      .toLowerCase()
      .slice(0, 60);
    const datePrefix = dateHelper.nowFilenamePrefix();
    const userId     = req.userId ? `_u${req.userId}` : '';
    cb(null, `${datePrefix}${userId}_${baseName}${ext}`);
  },
});

const uploadServicePOExcel = multer({
  storage: servicePOStorage,
  fileFilter: timesheetFileFilter,
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
});

const handleServicePOUpload = (req, res, next) => {
  uploadServicePOExcel.single('file')(req, res, (err) => {
    if (err) return next(err);
    if (!req.file) {
      return res.status(400).json({
        success: false,
        code: 'NO_FILE',
        message: 'No file was uploaded. Please attach a .xlsx or .csv file in the "file" field.',
      });
    }
    next();
  });
};

module.exports = {
  uploadExcel,
  handleTimesheetUpload,
  UPLOAD_DIR,
  uploadFinanceExcel,
  handleMonthlyCostUpload,
  FINANCE_UPLOAD_DIR,
  uploadEmployeeExcel,
  handleEmployeeUpload,
  EMPLOYEE_UPLOAD_DIR,
  uploadClientExcel,
  handleClientUpload,
  CLIENT_UPLOAD_DIR,
  uploadServicePOExcel,
  handleServicePOUpload,
  SERVICE_PO_UPLOAD_DIR,
};
