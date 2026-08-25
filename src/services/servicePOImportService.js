'use strict';

const xlsx = require('xlsx');
const { sequelize, Client, ServiceType, ServiceCategory, ServicePO, Project, Employee, User, Role } = require('../models');
const servicePORepository = require('../repositories/servicePORepository');
const servicePOHierarchyRepository = require('../repositories/servicePOHierarchyRepository');
const { generatePOCode } = require('../helpers/codeGenerator');
const { createServicePOSchema } = require('../validations/servicePOValidation');
const { resolveCreateCompanyId } = require('./companyAccessControlService');
const logger = require('../utils/logger');

// Sentinel stored in ctx.employeeByName when two employees in the same
// company share the exact same full_name — resolution must reject the name
// as ambiguous rather than silently picking whichever one happened to be
// read last, per "do not silently map to a different employee".
const AMBIGUOUS_EMPLOYEE = Symbol('AMBIGUOUS_EMPLOYEE');

// Roles allowed to be assigned as a Service PO's Delivery Head Manager.
// NOTE: this is business logic ADDED specifically for import, deliberately
// stricter than assertValidDeliveryHead() (the single-record create/update
// API's check in servicePOService.js), which has no role requirement at all
// — a manually-created/edited Service PO may set ANY active employee as
// Delivery Head. Import enforces this extra role gate on top.
const DELIVERY_HEAD_ALLOWED_ROLES = ['Manager', 'Service PO Admin', 'Project Admin', 'BU Admin'];

// Flexible column-header → field mapping (matched after normalising to lowercase + collapsed spaces)
// NOTE: Service PO Code is intentionally NOT mapped here — it is always auto-generated
// during import (format PO-YYYYMMDD-XXXX, via generatePOCode()), even if the sheet has a
// PO Code column. Any such column is ignored.
const HEADER_MAP = {
  'service po name': 'service_po_name',
  'po name': 'service_po_name',
  'name': 'service_po_name',
  'service_po_name': 'service_po_name',

  'client code': 'client_code',
  'client_code': 'client_code',
  'clt code': 'client_code',

  'client name': 'client_name',
  'client': 'client_name',
  'customer': 'client_name',
  'client_name': 'client_name',

  'project code': 'project_code',
  'project_code': 'project_code',

  'project name': 'project_name',
  'project': 'project_name',
  'project_name': 'project_name',

  'service type': 'service_type_name',
  'service type name': 'service_type_name',
  'servicetype': 'service_type_name',
  'service_type_name': 'service_type_name',
  'service_type': 'service_type_name',

  'po value': 'po_value',
  'value': 'po_value',
  'po_value': 'po_value',

  'start date': 'start_date',
  'start_date': 'start_date',

  'end date': 'end_date',
  'end_date': 'end_date',

  // NOTE: Is Billable is intentionally NOT mapped here — it is always derived
  // from the selected Service Type's category (see resolveRowFields()), never read
  // from the sheet, so any such column is ignored.

  'delivery head manager': 'delivery_head_manager_name',
  'delivery_head_manager': 'delivery_head_manager_name',
  'delivery head': 'delivery_head_manager_name',

  'service description': 'service_description',
  'description': 'service_description',
  'service_description': 'service_description',

  'invoice frequency': 'invoice_frequency',
  'invoice_frequency': 'invoice_frequency',

  'status': 'status',

  'hierarchy parent': 'hierarchy_parent',
  'hierarchy_parent': 'hierarchy_parent',
  'parent': 'hierarchy_parent',

  'hierarchy child': 'hierarchy_child',
  'hierarchy_child': 'hierarchy_child',
  'child': 'hierarchy_child',
};

// client_id / service_type_id / project_id / delivery_head_employee_id are all resolved by
// DB lookup (each with its own required/not-found/inactive/relationship messages, mirroring
// assertValidDeliveryHead()'s own checks for the last one — see resolveDeliveryHead()) before
// this schema runs, so they're relaxed to optional here — Joi is only responsible for
// format/range/enum/required rules on the remaining fields, reusing the exact same rules the
// single-record create API enforces.
const rowSchema = createServicePOSchema.fork(
  ['client_id', 'service_type_id', 'project_id', 'delivery_head_employee_id'],
  (s) => s.optional()
);

function normaliseHeader(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Same normalisation, for grouping/matching cell VALUES (Service PO Name, hierarchy
// node names, etc.) rather than headers.
function normaliseKey(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Convert Excel date serial number → YYYY-MM-DD
function excelSerialToISO(serial) {
  const utcMs = (serial - 25569) * 86400 * 1000;
  const d = new Date(utcMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Rejects syntactically-shaped but calendar-invalid dates (e.g. month 13, Feb 30)
// so callers get a clean "not a valid date" error instead of it silently reaching
// downstream validation as a bogus ISO string.
function isValidISODate(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day >= 1 && day <= daysInMonth;
}

function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return excelSerialToISO(value);
  if (value instanceof Date) {
    const yyyy = value.getUTCFullYear();
    const mm = String(value.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(value.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
  const str = String(value).trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return isValidISODate(str) ? str : null;
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmy) {
    const iso = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    return isValidISODate(iso) ? iso : null;
  }
  return null;
}

/**
 * Parse a numeric cell that may carry currency symbols and/or thousands
 * separators (e.g. "₹5,00,000.00", "$1,234.56", "500,000") — common when a
 * finance-authored sheet formats the PO Value / Invoice Amount column as
 * currency. Strips everything except digits, the decimal point, and a
 * leading minus sign before parsing.
 */
function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;
  const cleaned = String(value).trim().replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function isBlank(v) {
  return v === null || v === undefined || v === '';
}

/**
 * Parse the first sheet of the uploaded Excel/CSV file.
 * Returns an array of raw row objects keyed by canonical field names.
 */
function parseServicePOFile(filePath) {
  const workbook = xlsx.readFile(filePath, { cellDates: false, raw: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const raw = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

  if (!raw.length) return [];

  // Detect header row: first row with at least 2 recognised columns in first 5 rows
  let headerRowIdx = -1;
  let mappedHeaders = [];

  for (let i = 0; i < Math.min(5, raw.length); i++) {
    const mapped = raw[i].map((h) => HEADER_MAP[normaliseHeader(h)] || null);
    if (mapped.filter(Boolean).length >= 2) {
      headerRowIdx = i;
      mappedHeaders = mapped;
      break;
    }
  }

  if (headerRowIdx === -1) {
    const err = new Error(
      'Could not detect a valid header row. ' +
      'Expected columns like "Service PO Name", "Client Code"/"Client Name", "Project Name", "Service Type", "Start Date", "End Date", etc.'
    );
    err.statusCode = 422;
    throw err;
  }

  const rows = [];
  for (let i = headerRowIdx + 1; i < raw.length; i++) {
    const cells = raw[i];
    const row = { _rowNum: i + 1 };
    let hasData = false;

    mappedHeaders.forEach((field, colIdx) => {
      if (!field) return;
      const val = cells[colIdx];
      if (!isBlank(val)) hasData = true;
      row[field] = isBlank(val) ? '' : val;
    });

    if (!hasData) continue; // skip entirely blank rows
    rows.push(row);
  }

  return rows;
}

/**
 * Build the row_data snapshot returned alongside error messages, so a failed
 * row can be located and corrected in the source sheet without guesswork.
 */
function buildRowData(raw) {
  const { _rowNum, ...fields } = raw;
  return fields;
}

// Columns that identify/define the Service PO itself (as opposed to columns
// that only ever carry hierarchy data). A row that has ANY of these filled in
// is attempting to (re)state the Service PO's own definition — used both to
// find "the" defining row of a group and to detect a later row trying to
// redefine it differently (see resolveRowFields() + processGroup()).
const RELATIONSHIP_FIELDS = ['client_code', 'client_name', 'project_code', 'project_name', 'service_type_name', 'delivery_head_manager_name'];

function hasAnyValue(raw, fields) {
  return fields.some((f) => !isBlank(raw[f]));
}

/**
 * Resolve Client (by code or name) for one row against pre-fetched company
 * reference data. Pushes a message onto `errors` and returns null on failure
 * — never throws, so the caller can keep collecting every error in the row.
 */
function resolveClient(raw, ctx, errors) {
  const clientCodeRaw = String(raw.client_code || '').trim();
  const clientNameRaw = String(raw.client_name || '').trim();
  if (!clientCodeRaw && !clientNameRaw) {
    errors.push('Client Code or Client Name is required.');
    return null;
  }
  const client = clientCodeRaw
    ? ctx.clientByCode.get(clientCodeRaw.toLowerCase())
    : ctx.clientByName.get(clientNameRaw.toLowerCase());
  if (!client) {
    errors.push(`Client "${clientCodeRaw || clientNameRaw}" not found.`);
    return null;
  }
  if (client.status !== 'active') {
    errors.push(`Client "${client.client_name}" is inactive.`);
    return null;
  }
  return client;
}

/**
 * Resolve Project (by code or name) for one row — MUST belong to the row's
 * already-resolved Client (Client -> Project -> Service PO is the critical
 * relationship this whole feature enforces). Distinguishes "doesn't exist at
 * all" from "exists, but under a different client" for a clearer error.
 */
function resolveProject(raw, ctx, client, errors) {
  const projectCodeRaw = String(raw.project_code || '').trim();
  const projectNameRaw = String(raw.project_name || '').trim();
  if (!projectCodeRaw && !projectNameRaw) {
    errors.push('Project Code or Project Name is required.');
    return null;
  }
  if (!client) {
    // Client itself already failed to resolve — its own error is already
    // pushed by resolveClient(); avoid a second, confusing message here.
    return null;
  }

  const byCodeKey = projectCodeRaw ? `${client.id}::${projectCodeRaw.toLowerCase()}` : null;
  const byNameKey = projectNameRaw ? `${client.id}::${projectNameRaw.toLowerCase()}` : null;
  const project = (byCodeKey && ctx.projectByClientAndCode.get(byCodeKey))
    || (byNameKey && ctx.projectByClientAndName.get(byNameKey));

  if (!project) {
    const label = projectCodeRaw || projectNameRaw;
    const existsElsewhere = (projectCodeRaw && ctx.projectCodeExistsAnywhere.has(projectCodeRaw.toLowerCase()))
      || (projectNameRaw && ctx.projectNameExistsAnywhere.has(projectNameRaw.toLowerCase()));
    if (existsElsewhere) {
      errors.push(`Project "${label}" does not belong to Client "${client.client_name}".`);
    } else {
      errors.push(`Project "${label}" not found.`);
    }
    return null;
  }
  if (project.status !== 'active' || project.is_deleted) {
    errors.push(`Project "${project.project_name}" is inactive.`);
    return null;
  }
  return project;
}

/**
 * Resolve Service Type by name. Never auto-creates one — an unrecognised
 * Service Type is always a hard validation failure.
 */
function resolveServiceType(raw, ctx, errors) {
  const name = String(raw.service_type_name || '').trim();
  if (!name) {
    errors.push('Service Type is required.');
    return null;
  }
  const serviceType = ctx.serviceTypeByName.get(name.toLowerCase());
  if (!serviceType) {
    errors.push(`Service Type "${name}" does not exist.`);
    return null;
  }
  return serviceType;
}

/**
 * Resolve Delivery Head Manager (Excel employee-name column) to an Employee
 * — always by full_name, exact match after trim + case-fold, never a fuzzy
 * or partial match (never silently maps to a different, similarly-named
 * employee). Applies the same active/not-soft-deleted/same-company checks
 * assertValidDeliveryHead() applies for the single-record create/update API,
 * PLUS an import-specific role gate: the employee must have an active login
 * (Users row) holding one of DELIVERY_HEAD_ALLOWED_ROLES. This role check is
 * NEW business logic scoped to import only — the manual create/update API
 * has no such requirement (see DELIVERY_HEAD_ALLOWED_ROLES's doc comment).
 * Required — mirrors createServicePOSchema's own `.required()` rule for
 * delivery_head_employee_id on create.
 */
function resolveDeliveryHead(raw, ctx, errors) {
  const name = String(raw.delivery_head_manager_name || '').trim();
  if (!name) {
    errors.push('Delivery Head Manager is required.');
    return null;
  }

  const entry = ctx.employeeByName.get(name.toLowerCase());
  if (!entry || entry === AMBIGUOUS_EMPLOYEE) {
    if (entry === AMBIGUOUS_EMPLOYEE) {
      errors.push(`Delivery Head Manager "${name}" matches more than one employee — cannot determine which one.`);
    } else {
      errors.push(`Delivery Head Manager "${name}" does not exist.`);
    }
    return null;
  }
  if (!entry.employeeActive) {
    errors.push(`Delivery Head Manager "${name}" is inactive.`);
    return null;
  }
  if (!entry.roleName) {
    errors.push(`Delivery Head Manager "${name}" has no active user account/role and cannot be assigned as Delivery Head Manager.`);
    return null;
  }
  if (!DELIVERY_HEAD_ALLOWED_ROLES.includes(entry.roleName)) {
    errors.push(
      `Delivery Head Manager "${name}" has role "${entry.roleName}" — only ${DELIVERY_HEAD_ALLOWED_ROLES.join('/')} may be assigned as Delivery Head Manager.`
    );
    return null;
  }
  return entry;
}

/**
 * Full field resolution + shared Joi rules for a row that is attempting to
 * define (or confirm) a Service PO's own data — i.e. the first row of a
 * group, or any later row in the group that also supplies relationship
 * fields (see RELATIONSHIP_FIELDS). Mirrors the pre-hierarchy validateRow()
 * exactly for every field it already handled, plus resolves Project and
 * Delivery Head Manager (both new).
 *
 * @returns {{ errors: string[], data: object, resolved: { clientId, projectId, serviceTypeId, deliveryHeadEmployeeId } }}
 */
function resolveRowFields(raw, ctx) {
  const errors = [];
  const candidate = {};
  const invalidFields = new Set();

  const client = resolveClient(raw, ctx, errors);
  if (client) candidate.client_id = client.id;

  const project = resolveProject(raw, ctx, client, errors);
  if (project) candidate.project_id = project.id;

  const serviceType = resolveServiceType(raw, ctx, errors);
  if (serviceType) {
    candidate.service_type_id = serviceType.id;
    // is_billable is always derived from the Service Type's category — never
    // taken from the sheet and never left to the schema's default.
    candidate.is_billable = serviceType.is_billable;
  }

  const deliveryHead = resolveDeliveryHead(raw, ctx, errors);
  // Store the resolved Employee's id — never the raw sheet text — per
  // "do not store the employee name directly in the Service PO table".
  if (deliveryHead) candidate.delivery_head_employee_id = deliveryHead.id;

  // ── service_po_name ──────────────────────────────────────────────────────────
  if (!isBlank(raw.service_po_name)) {
    candidate.service_po_name = String(raw.service_po_name).trim();
  }

  // ── po_value (required for import, even though optional on the single-create API) ──
  if (isBlank(raw.po_value)) {
    errors.push('PO value is required.');
  } else {
    const poValue = parseNumber(raw.po_value);
    if (poValue === null) {
      errors.push(`PO value "${raw.po_value}" is not a valid number.`);
      invalidFields.add('po_value');
    } else {
      candidate.po_value = poValue;
    }
  }

  // ── start_date / end_date ────────────────────────────────────────────────────
  if (!isBlank(raw.start_date)) {
    const startDate = parseDate(raw.start_date);
    if (!startDate) {
      errors.push(`Start date "${raw.start_date}" is not a valid date (expected YYYY-MM-DD or DD/MM/YYYY).`);
      // An invalid start_date also makes end_date's "must be after start_date"
      // ref-check meaningless — suppress its confusing Joi message too.
      invalidFields.add('start_date');
      invalidFields.add('end_date');
    } else {
      candidate.start_date = startDate;
    }
  }

  if (!isBlank(raw.end_date)) {
    const endDate = parseDate(raw.end_date);
    if (!endDate) {
      errors.push(`End date "${raw.end_date}" is not a valid date (expected YYYY-MM-DD or DD/MM/YYYY).`);
      invalidFields.add('end_date');
    } else {
      candidate.end_date = endDate;
    }
  }


  // ── free-text / enum fields (Joi validates length, enum membership) ─────────
  if (!isBlank(raw.service_description)) candidate.service_description = String(raw.service_description).trim();
  if (!isBlank(raw.invoice_frequency)) candidate.invoice_frequency = String(raw.invoice_frequency).trim().toLowerCase();
  if (!isBlank(raw.status)) candidate.status = String(raw.status).trim().toLowerCase();

  // ── delegate required/length/range/enum/pattern rules to the shared schema ──
  const { error, value } = rowSchema.validate(candidate, { abortEarly: false, stripUnknown: true });
  if (error) {
    errors.push(...error.details.filter((d) => !invalidFields.has(d.path[0])).map((d) => d.message));
  }

  return {
    errors,
    data: error ? {} : value,
    resolved: {
      clientId: client ? client.id : null,
      projectId: project ? project.id : null,
      serviceTypeId: serviceType ? serviceType.id : null,
      deliveryHeadEmployeeId: deliveryHead ? deliveryHead.id : null,
    },
  };
}

/**
 * A later row in a group that only PARTIALLY restates relationship fields
 * (e.g. just repeats Client Name) — checked field-by-field against the
 * group's already-established defining values, per section 13's "Conflicting
 * Client/Project/Service Type/Delivery Head Manager" requirement. Only the
 * fields actually present on this row are checked; a field this row leaves
 * blank is never treated as a conflict.
 *
 * @returns {string[]} conflict error messages (empty = no conflict)
 */
function detectPartialConflicts(raw, ctx, defining) {
  const errors = [];

  if (hasAnyValue(raw, ['client_code', 'client_name'])) {
    const client = resolveClient(raw, ctx, errors);
    if (client && client.id !== defining.resolved.clientId) {
      errors.push(`Conflicting Client for Service PO "${defining.data.service_po_name}" — a different Client was already given earlier in this file.`);
    }
  }
  if (hasAnyValue(raw, ['project_code', 'project_name'])) {
    // Resolve against THIS row's own client if it gave one, else the group's defining client.
    const rowClient = hasAnyValue(raw, ['client_code', 'client_name'])
      ? resolveClient(raw, ctx, [])
      : { id: defining.resolved.clientId };
    const project = resolveProject(raw, ctx, rowClient, errors);
    if (project && project.id !== defining.resolved.projectId) {
      errors.push(`Conflicting Project for Service PO "${defining.data.service_po_name}" — a different Project was already given earlier in this file.`);
    }
  }
  if (hasAnyValue(raw, ['service_type_name'])) {
    const serviceType = resolveServiceType(raw, ctx, errors);
    if (serviceType && serviceType.id !== defining.resolved.serviceTypeId) {
      errors.push(`Conflicting Service Type for Service PO "${defining.data.service_po_name}" — a different Service Type was already given earlier in this file.`);
    }
  }
  if (hasAnyValue(raw, ['delivery_head_manager_name'])) {
    const deliveryHead = resolveDeliveryHead(raw, ctx, errors);
    if (deliveryHead && deliveryHead.id !== defining.resolved.deliveryHeadEmployeeId) {
      errors.push(`Conflicting Delivery Head Manager for Service PO "${defining.data.service_po_name}" — a different Delivery Head Manager was already given earlier in this file.`);
    }
  }

  return errors;
}

/**
 * Parse the Hierarchy Parent / Hierarchy Child columns of one row into a
 * group's accumulating hierarchy state. Detects: Child without Parent on the
 * same row, exact duplicate (Parent, Child) pairs within the file, and names
 * longer than the DB's node_name limit (255, same as manual creation).
 *
 * @returns {string[]} error messages for this row (empty = fine, or no hierarchy present)
 */
function parseHierarchyRow(raw, group) {
  const parentRaw = String(raw.hierarchy_parent || '').trim();
  const childRaw = String(raw.hierarchy_child || '').trim();
  if (!parentRaw && !childRaw) return [];

  const errors = [];

  if (!parentRaw && childRaw) {
    errors.push(`Hierarchy Child "${childRaw}" requires Hierarchy Parent to also be filled in on the same row.`);
    return errors;
  }
  if (parentRaw.length > 255) {
    errors.push(`Hierarchy Parent "${parentRaw}" exceeds 255 characters.`);
    return errors;
  }
  if (childRaw.length > 255) {
    errors.push(`Hierarchy Child "${childRaw}" exceeds 255 characters.`);
    return errors;
  }

  const parentKey = normaliseKey(parentRaw);
  if (!group.parentNames.has(parentKey)) {
    group.parentNames.set(parentKey, parentRaw);
  }

  if (childRaw) {
    const childKey = normaliseKey(childRaw);
    const pairSignature = `${parentKey} ${childKey}`;
    if (group.seenPairSignatures.has(pairSignature)) {
      errors.push(`Duplicate hierarchy mapping: "${parentRaw}" → "${childRaw}" is already defined for this Service PO in this file.`);
      return errors;
    }
    group.seenPairSignatures.add(pairSignature);
    group.pairs.push({ parentKey, parentName: parentRaw, childKey, childName: childRaw });
  }

  return errors;
}

/**
 * Group raw rows by Service PO Name, case-insensitively (trimmed, collapsed
 * whitespace) — every row sharing the same normalised name belongs to one
 * Service PO. Order within a group is preserved.
 *
 * @returns {Map<string, object[]>} normalised name -> raw rows, in file order
 */
function groupRowsByServicePOName(rawRows) {
  const groups = new Map();
  for (const raw of rawRows) {
    const key = normaliseKey(raw.service_po_name);
    if (!key) continue; // handled as a per-row error separately (name is required)
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(raw);
  }
  return groups;
}

/**
 * Process one Service-PO-name group end-to-end through validation (no DB
 * writes here): resolve/validate the defining row, detect conflicting
 * redefinitions, parse hierarchy rows, detect duplicate/circular hierarchy
 * both within the file and against any already-existing Service PO's
 * hierarchy.
 *
 * @returns {{ ok: true, group: object } | { ok: false, errorRows: object[] }}
 */
function processGroup(key, rows, ctx) {
  const errorRows = [];
  const group = {
    key,
    rows,
    isNew: null,       // set once the defining row resolves or an existing PO match is found
    existingPO: null,  // set when this group matches an already-existing Service PO
    candidate: null,   // resolved fields to create() with, when isNew
    code: null,         // freshly generated service_po_code, assigned later, when isNew
    definingRowNum: null,
    definingRowData: null,
    parentNames: new Map(),   // parentKeyLower -> original-cased name
    pairs: [],                 // { parentKey, parentName, childKey, childName }
    seenPairSignatures: new Set(),
  };

  // Rows with no service_po_name at all never reach groupRowsByServicePOName,
  // so every row here does carry a name — but a row missing it entirely is
  // still reported per-row via resolveRowFields()'s own required-field rule
  // whenever it's also treated as a defining candidate. A completely blank
  // service_po_name row is filtered out upstream and simply doesn't count.

  let defining = null;
  let definingRawRow = null;

  for (const raw of rows) {
    // Only relationship fields (Client/Project/Service Type/Delivery Head Manager)
    // trigger full-row (re)definition handling — a stray PO Value or date on
    // an otherwise hierarchy-only continuation row is intentionally ignored,
    // never validated/compared, per the "only these four fields can conflict"
    // rule (see detectPartialConflicts()).
    const isDefiningCandidate = hasAnyValue(raw, RELATIONSHIP_FIELDS);

    if (isDefiningCandidate) {
      if (!defining) {
        const result = resolveRowFields(raw, ctx);
        if (result.errors.length > 0) {
          errorRows.push({ row_number: raw._rowNum, row_data: buildRowData(raw), errors: result.errors });
          // The whole group can't proceed without a valid defining row —
          // every other row in this group is reported as skipped-due-to-group-failure below.
          return { ok: false, errorRows: errorRows.concat(reportRemainingRowsAsSkipped(rows, raw, ctx)) };
        }
        defining = result;
        definingRawRow = raw;
        group.definingRowNum = raw._rowNum;
        group.definingRowData = buildRowData(raw);
        group.candidate = result.data;
      } else {
        const conflicts = detectPartialConflicts(raw, ctx, defining);
        if (conflicts.length > 0) {
          errorRows.push({ row_number: raw._rowNum, row_data: buildRowData(raw), errors: conflicts });
          return { ok: false, errorRows: errorRows.concat(reportRemainingRowsAsSkipped(rows, raw, ctx, [raw._rowNum])) };
        }
      }
    }

    const hierarchyErrors = parseHierarchyRow(raw, group);
    if (hierarchyErrors.length > 0) {
      errorRows.push({ row_number: raw._rowNum, row_data: buildRowData(raw), errors: hierarchyErrors });
    }
  }

  if (errorRows.length > 0) {
    return { ok: false, errorRows };
  }

  if (!defining) {
    // Pure hierarchy-only group — every row only referenced hierarchy columns.
    // Must match exactly one already-existing Service PO by name alone.
    const matches = ctx.existingPOByNameOnly.get(key) || [];
    if (matches.length === 0) {
      return {
        ok: false,
        errorRows: rows.map((raw) => ({
          row_number: raw._rowNum,
          row_data: buildRowData(raw),
          errors: [`Service PO "${rows[0].service_po_name}" was not found, and no Client/Project/Service Type was provided in this file to create it.`],
        })),
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        errorRows: rows.map((raw) => ({
          row_number: raw._rowNum,
          row_data: buildRowData(raw),
          errors: [`Service PO name "${rows[0].service_po_name}" matches more than one existing Service PO — specify Client/Project/Service Type to disambiguate.`],
        })),
      };
    }
    group.existingPO = matches[0];
    group.isNew = false;
  } else {
    const key2 = `${key}::${defining.resolved.clientId}::${defining.resolved.projectId}`;
    const existing = ctx.existingPOByKey.get(key2);
    if (existing) {
      group.existingPO = existing;
      group.isNew = false;
    } else {
      group.isNew = true;
    }
  }

  // ── Circular / invalid-depth check: a name cannot be both a Parent and a Child ──
  const childKeys = new Set(group.pairs.map((p) => p.childKey));
  for (const parentKey of group.parentNames.keys()) {
    if (childKeys.has(parentKey)) {
      const name = group.parentNames.get(parentKey);
      errorRows.push({
        row_number: group.definingRowNum || rows[0]._rowNum,
        row_data: group.definingRowData || buildRowData(rows[0]),
        errors: [`Hierarchy node "${name}" cannot be both a Parent and a Child under the same Service PO — maximum depth is Service PO → Parent → Child.`],
      });
    }
  }

  // NOTE: the cross-check against an existing PO's already-saved hierarchy
  // shape can't run here — ctx.existingHierarchyByPOId isn't populated until
  // after this first pass over every group finishes (see importServicePOs()'s
  // step 6, which re-runs this exact check once the existing hierarchy for
  // every matched PO has been batch-fetched in one query).

  if (errorRows.length > 0) {
    return { ok: false, errorRows };
  }

  return { ok: true, group };
}

/**
 * When a group fails because its defining row (or a later conflicting row)
 * is invalid, every OTHER row in the group is still accounted for in the
 * response as skipped — never silently dropped — without repeating the
 * actual failure reason on each one.
 */
function reportRemainingRowsAsSkipped(rows, failedRaw, ctx, alsoExclude = []) {
  const excludeRowNums = new Set([failedRaw._rowNum, ...alsoExclude]);
  return rows
    .filter((raw) => !excludeRowNums.has(raw._rowNum))
    .map((raw) => ({
      row_number: raw._rowNum,
      row_data: buildRowData(raw),
      errors: [`Skipped — Service PO "${raw.service_po_name}" failed validation (see row ${failedRaw._rowNum}).`],
    }));
}

/**
 * Parse, validate, and import Service POs (and their hierarchy) from the
 * uploaded file.
 *
 * Validation-first, all-or-nothing: every row/group is fully validated
 * before anything is written to the database. If even one row/group fails,
 * the import is aborted immediately and NOTHING is inserted — only once
 * every group passes does the insert phase run. This mirrors
 * employeeImportService.js / clientImportService.js's parse → validate →
 * insert structure and response shape, extended with `existing_po_reused`
 * and `hierarchy_created`.
 *
 * Rows sharing the same Service PO Name (case-insensitive) are grouped into
 * one Service PO. Within the insert phase, each group's Service PO
 * create-or-reuse + all of its hierarchy node creates run inside a single
 * DB transaction — a failure partway through a group rolls back that whole
 * group (never "PO created but hierarchy partially created"), while other
 * groups in the same file continue independently, exactly like the existing
 * per-row insert loop's failure semantics.
 *
 * @param {string} filePath - Absolute path to the saved upload file
 * @param {number} userId   - ID of the authenticated user performing the import
 * @param {import('express').Request} req - for resolveCreateCompanyId: a
 *   BU-scoped actor's own req.companyId always wins; a company-less
 *   Admin/Entity Admin must supply `company_id` in the multipart form body,
 *   validated against their own owned Companies — replaces the previous
 *   raw `req.companyId` passthrough, which crashed for those actors.
 * @returns {Promise<{ total, imported, existing_po_reused, hierarchy_created, skipped, error_rows }>}
 */
async function importServicePOs(filePath, userId, req) {
  const bodyCompanyId = req.body && req.body.company_id ? parseInt(req.body.company_id, 10) : undefined;
  const companyId = await resolveCreateCompanyId(
    { companyId: req.companyId, hierarchyRank: req.hierarchyRank, employeeId: req.employeeId },
    bodyCompanyId,
    'a Service PO import'
  );

  // 1. Parse Excel / CSV
  const rawRows = parseServicePOFile(filePath);

  if (!rawRows.length) {
    const err = new Error('The uploaded file contains no data rows.');
    err.statusCode = 422;
    throw err;
  }

  // 2. Batch-fetch reference data to avoid N+1 queries — scoped to this
  // company, so a code/name that only exists in another company never
  // resolves here (matches uq_service_pos_company_code's per-company scope).
  const [existingPOs, clients, projects, serviceTypes, employees] = await Promise.all([
    ServicePO.findAll({ where: { company_id: companyId }, attributes: ['id', 'service_po_code', 'service_po_name', 'client_id', 'project_id'], raw: true }),
    Client.findAll({ where: { company_id: companyId }, attributes: ['id', 'client_code', 'client_name', 'status'], raw: true }),
    Project.findAll({ where: { company_id: companyId, is_deleted: false }, attributes: ['id', 'project_code', 'project_name', 'client_id', 'status', 'is_deleted'], raw: true }),
    ServiceType.findAll({
      where: { is_deleted: false, company_id: companyId },
      attributes: ['id', 'service_type_name'],
      include: [{ model: ServiceCategory, as: 'serviceCategory', attributes: ['id', 'name', 'report_bucket_key'] }],
    }),
    Employee.findAll({
      where: { company_id: companyId, is_deleted: false },
      attributes: ['id', 'full_name', 'status'],
      include: [{
        model: User,
        as: 'users',
        attributes: ['id', 'is_deleted'],
        required: false,
        include: [{ model: Role, as: 'role', attributes: ['id', 'role_name'] }],
      }],
    }),
  ]);

  const existingCodes = new Set(existingPOs.map((p) => p.service_po_code.toUpperCase()));
  const clientByCode = new Map(clients.map((c) => [c.client_code.toLowerCase(), c]));
  const clientByName = new Map(clients.map((c) => [c.client_name.toLowerCase(), c]));

  const projectByClientAndCode = new Map();
  const projectByClientAndName = new Map();
  const projectCodeExistsAnywhere = new Set();
  const projectNameExistsAnywhere = new Set();
  for (const p of projects) {
    projectByClientAndCode.set(`${p.client_id}::${p.project_code.toLowerCase()}`, p);
    projectByClientAndName.set(`${p.client_id}::${p.project_name.toLowerCase()}`, p);
    projectCodeExistsAnywhere.add(p.project_code.toLowerCase());
    projectNameExistsAnywhere.add(p.project_name.toLowerCase());
  }

  // is_billable is derived here (the resolved Service Type's category has
  // report_bucket_key = 'billable' → true, anything else → false) so
  // resolveRowFields() never has to touch the DB or fall back to the schema default.
  const serviceTypeByName = new Map(
    serviceTypes.map((s) => [
      s.service_type_name.toLowerCase(),
      {
        id: s.id,
        service_type_name: s.service_type_name,
        is_billable: s.serviceCategory?.report_bucket_key === 'billable',
      },
    ])
  );

  // Keyed by full_name (trimmed, case-folded) for Delivery Head Manager
  // resolution. Two employees sharing the exact same full_name mark the key
  // AMBIGUOUS rather than letting whichever one was read last silently win —
  // resolveDeliveryHead() rejects that case explicitly.
  const employeeByName = new Map();
  for (const emp of employees) {
    const key = emp.full_name.toLowerCase();
    if (employeeByName.has(key)) {
      employeeByName.set(key, AMBIGUOUS_EMPLOYEE);
      continue;
    }
    const activeUser = (emp.users || []).find((u) => !u.is_deleted);
    employeeByName.set(key, {
      id: emp.id,
      fullName: emp.full_name,
      employeeActive: emp.status === 'active',
      roleName: activeUser && activeUser.role ? activeUser.role.role_name : null,
    });
  }

  const existingPOByKey = new Map();
  const existingPOByNameOnly = new Map();
  for (const po of existingPOs) {
    const nameKey = normaliseKey(po.service_po_name);
    existingPOByKey.set(`${nameKey}::${po.client_id}::${po.project_id}`, po);
    if (!existingPOByNameOnly.has(nameKey)) existingPOByNameOnly.set(nameKey, []);
    existingPOByNameOnly.get(nameKey).push(po);
  }

  const ctx = {
    clientByCode,
    clientByName,
    projectByClientAndCode,
    projectByClientAndName,
    projectCodeExistsAnywhere,
    projectNameExistsAnywhere,
    serviceTypeByName,
    employeeByName,
    existingPOByKey,
    existingPOByNameOnly,
    existingHierarchyByPOId: new Map(), // filled in below, after we know which existing POs are actually referenced
  };

  // 3. Detect a completely unnamed row up front (never reaches a group).
  const errorRows = [];
  for (const raw of rawRows) {
    if (isBlank(raw.service_po_name)) {
      errorRows.push({ row_number: raw._rowNum, row_data: buildRowData(raw), errors: ['Service PO Name is required.'] });
    }
  }

  // 4. Group remaining rows by Service PO Name (case-insensitive).
  const groups = groupRowsByServicePOName(rawRows.filter((r) => !isBlank(r.service_po_name)));

  // 5. First pass over groups WITHOUT the existing-hierarchy cross-check
  // (that needs to know which existing POs are referenced first) — this pass
  // resolves defining rows, detects conflicts, and parses hierarchy shape.
  const pendingGroups = [];
  for (const [key, rows] of groups) {
    const result = processGroup(key, rows, ctx);
    if (!result.ok) {
      errorRows.push(...result.errorRows);
    } else {
      pendingGroups.push(result.group);
    }
  }

  // 6. Batch-fetch existing hierarchy for every matched existing PO in one
  // query, then re-run ONLY the existing-hierarchy cross-check per group
  // (cheap, in-memory) — this is why processGroup() is structured to accept
  // a pre-populated ctx.existingHierarchyByPOId and re-validate is safe/idempotent.
  const existingPOIds = pendingGroups.filter((g) => g.existingPO).map((g) => g.existingPO.id);
  if (existingPOIds.length > 0) {
    const existingNodes = await servicePOHierarchyRepository.findByServicePOIds(existingPOIds);
    for (const node of existingNodes) {
      // service_po_id is a BIGINT column — pg/Sequelize return it as a string,
      // not a number, so every map key derived from it must be coerced with
      // Number() to match the plain-integer ServicePO.id values used elsewhere,
      // or the lookup below silently misses and re-creates duplicate nodes.
      const poIdKey = Number(node.service_po_id);
      if (!ctx.existingHierarchyByPOId.has(poIdKey)) ctx.existingHierarchyByPOId.set(poIdKey, []);
      ctx.existingHierarchyByPOId.get(poIdKey).push(node);
    }

    for (const group of pendingGroups) {
      if (!group.existingPO) continue;
      const existingNodesForPO = ctx.existingHierarchyByPOId.get(group.existingPO.id) || [];
      const existingParentKeys = new Set(existingNodesForPO.filter((n) => n.node_type === 'PARENT').map((n) => normaliseKey(n.node_name)));
      const existingChildKeys = new Set(existingNodesForPO.filter((n) => n.node_type === 'CHILD').map((n) => normaliseKey(n.node_name)));
      const childKeys = new Set(group.pairs.map((p) => p.childKey));

      for (const parentKey of group.parentNames.keys()) {
        if (existingChildKeys.has(parentKey)) {
          errorRows.push({
            row_number: group.definingRowNum || group.rows[0]._rowNum,
            row_data: group.definingRowData || buildRowData(group.rows[0]),
            errors: [`Hierarchy node "${group.parentNames.get(parentKey)}" already exists as a Child under this Service PO — cannot also use it as a Parent.`],
          });
        }
      }
      for (const childKey of childKeys) {
        if (existingParentKeys.has(childKey)) {
          const pair = group.pairs.find((p) => p.childKey === childKey);
          errorRows.push({
            row_number: group.definingRowNum || group.rows[0]._rowNum,
            row_data: group.definingRowData || buildRowData(group.rows[0]),
            errors: [`Hierarchy node "${pair.childName}" already exists as a Parent under this Service PO — cannot also use it as a Child.`],
          });
        }
      }
    }
  }

  // 6a. Validation gate — if anything failed anywhere, stop here. Nothing is inserted.
  if (errorRows.length > 0) {
    logger.info('Service PO import aborted — validation errors found, nothing inserted', {
      userId,
      total: rawRows.length,
      skipped: errorRows.length,
    });

    return {
      total: rawRows.length,
      imported: 0,
      existing_po_reused: 0,
      hierarchy_created: 0,
      skipped: errorRows.length,
      error_rows: errorRows,
    };
  }

  // 7. Every group passed validation — auto-generate a unique PO code for
  // each NEW Service PO (never taken from the sheet) before inserting.
  const seenCodes = new Set();
  for (const group of pendingGroups) {
    if (!group.isNew) continue;
    let code = generatePOCode();
    let attempts = 0;
    while (existingCodes.has(code) || seenCodes.has(code)) {
      if (attempts >= 5) {
        code = null;
        break;
      }
      code = generatePOCode();
      attempts++;
    }

    if (!code) {
      group.codeGenerationFailed = true;
      continue;
    }
    group.code = code;
    seenCodes.add(code);
  }

  // 8. Insert phase — one transaction per Service PO group (create-or-reuse
  // the PO, then create every genuinely-missing hierarchy node under it).
  // A failure partway through a group rolls back that whole group only;
  // other groups continue independently — same failure granularity the
  // existing per-row insert loop already had, now scoped to "one PO + its
  // hierarchy" as the atomic unit instead of "one row".
  let importedCount = 0;
  let existingReusedCount = 0;
  let hierarchyCreatedCount = 0;

  for (const group of pendingGroups) {
    if (group.codeGenerationFailed) {
      errorRows.push({
        row_number: group.definingRowNum,
        row_data: group.definingRowData,
        errors: [`Failed to generate a unique Service PO code for "${group.candidate.service_po_name}".`],
      });
      continue;
    }

    try {
      let hierarchyCreatedThisGroup = 0;

      await sequelize.transaction(async (transaction) => {
        let servicePOId;
        if (group.existingPO) {
          servicePOId = group.existingPO.id;
        } else {
          const created = await servicePORepository.create(
            { ...group.candidate, service_po_code: group.code, company_id: companyId, created_by: userId, updated_by: userId },
            { transaction }
          );
          servicePOId = created.id;
        }

        const existingNodesForPO = group.existingPO ? (ctx.existingHierarchyByPOId.get(servicePOId) || []) : [];
        const existingParentByName = new Map(existingNodesForPO.filter((n) => n.node_type === 'PARENT').map((n) => [normaliseKey(n.node_name), n]));
        // id / parent_hierarchy_id are BIGINT columns — pg/Sequelize return
        // them as strings, not numbers. Every composite map key below is
        // built with Number(...) so a freshly-created node's id compares
        // equal to the same id read back from a query, and vice versa.
        const existingChildByParentAndName = new Map(
          existingNodesForPO.filter((n) => n.node_type === 'CHILD').map((n) => [`${Number(n.parent_hierarchy_id)}::${normaliseKey(n.node_name)}`, n])
        );

        const parentIdByKey = new Map();
        for (const [parentKey, parentName] of group.parentNames) {
          const existingParent = existingParentByName.get(parentKey);
          if (existingParent) {
            parentIdByKey.set(parentKey, Number(existingParent.id));
            continue;
          }
          const node = await servicePOHierarchyRepository.create(
            {
              service_po_id: servicePOId,
              parent_hierarchy_id: null,
              node_name: parentName,
              node_type: 'PARENT',
              display_order: 0,
              created_by: userId,
              updated_by: userId,
            },
            { transaction }
          );
          parentIdByKey.set(parentKey, Number(node.id));
          hierarchyCreatedThisGroup++;
        }

        for (const pair of group.pairs) {
          const parentId = parentIdByKey.get(pair.parentKey);
          const existingChild = existingChildByParentAndName.get(`${parentId}::${pair.childKey}`);
          if (existingChild) continue; // already present under this PO — never overwritten, just skipped

          await servicePOHierarchyRepository.create(
            {
              service_po_id: servicePOId,
              parent_hierarchy_id: parentId,
              node_name: pair.childName,
              node_type: 'CHILD',
              display_order: 0,
              created_by: userId,
              updated_by: userId,
            },
            { transaction }
          );
          hierarchyCreatedThisGroup++;
        }
      });

      if (group.existingPO) {
        existingReusedCount++;
      } else {
        importedCount++;
      }
      hierarchyCreatedCount += hierarchyCreatedThisGroup;
    } catch (dbErr) {
      logger.error('Service PO import DB error', { servicePOName: group.candidate?.service_po_name || group.key, error: dbErr.message });
      errorRows.push({
        row_number: group.definingRowNum || group.rows[0]._rowNum,
        row_data: group.definingRowData || buildRowData(group.rows[0]),
        errors: [`Database error while saving this Service PO/hierarchy: ${dbErr.message}`],
      });
    }
  }

  logger.info('Service PO import completed', {
    userId,
    total: rawRows.length,
    imported: importedCount,
    existing_po_reused: existingReusedCount,
    hierarchy_created: hierarchyCreatedCount,
    skipped: errorRows.length,
  });

  return {
    total: rawRows.length,
    imported: importedCount,
    existing_po_reused: existingReusedCount,
    hierarchy_created: hierarchyCreatedCount,
    skipped: errorRows.length,
    error_rows: errorRows,
  };
}

module.exports = { importServicePOs };
