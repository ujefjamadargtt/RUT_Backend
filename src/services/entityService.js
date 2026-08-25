'use strict';

const entityRepository = require('../repositories/entityRepository');
const roleRepository = require('../repositories/roleRepository');
const { generateEntityCode } = require('../helpers/codeGenerator');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const { getPaginationParams, getPaginationMeta } = require('../utils/pagination');
const logger = require('../utils/logger');

/**
 * Entity Service
 * Business logic for the Entity Master module. Reachable by both Admin and
 * Entity Admin (see requireEntityAdminOrAdmin.js). All operations are
 * scoped to a caller-supplied entityIds array (req.entityIds) — an Entity
 * Admin's own assigned Entities, or an Admin's owned Entities — so the same
 * update()/deleteEntity() code path already refuses to touch anything
 * outside that scope for either caller, with no extra branching needed.
 * create() is the one place that DOES branch: an Entity Admin creating an
 * Entity always gets it self-assigned (see the isEntityAdmin param), while
 * an Admin may optionally assign it to any Entity Admin they created.
 */

/**
 * Validate an entity_admin_employee_id being assigned/reassigned to an
 * Entity: must exist, hold an active "Entity Admin" role, and have been
 * created by THIS Admin — an Admin may only assign Entities to Entity
 * Admins they themselves created, never someone else's.
 *
 * @param {number|null|undefined} entityAdminEmployeeId
 * @param {number} actorId - the calling Admin
 * @returns {Promise<void>}
 */
async function assertValidEntityAdminAssignment(entityAdminEmployeeId, actorId) {
  if (entityAdminEmployeeId === undefined || entityAdminEmployeeId === null) {
    return;
  }

  const { Employee, Role } = require('../models');
  const [employee, entityAdminRole] = await Promise.all([
    Employee.findOne({
      where: { id: entityAdminEmployeeId, is_deleted: false },
      include: [{
        model: Role,
        as: 'roles',
        attributes: ['role_name'],
        through: { attributes: ['status'] },
      }],
    }),
    roleRepository.findByName('Entity Admin'),
  ]);

  const holdsEntityAdmin = !!employee && !!entityAdminRole && (employee.roles || []).some(
    (role) => role.role_name === entityAdminRole.role_name && role.EmployeeRole && role.EmployeeRole.status === 'active'
  );

  if (!holdsEntityAdmin) {
    const err = new Error('Entity Admin not found.');
    err.statusCode = 404;
    throw err;
  }

  if (employee.created_by !== actorId) {
    const err = new Error('You can only assign an Entity to an Entity Admin you created.');
    err.statusCode = 403;
    throw err;
  }
}

/**
 * @param {object} query - Express req.query (page, limit, status, search, sort_by, sort_order)
 * @param {number[]} entityIds - the caller's allowed Entity IDs (req.entityIds)
 * @returns {Promise<{ data: Entity[], meta: object }>}
 */
const getAll = async (query = {}, entityIds = []) => {
  const { page, limit, offset } = getPaginationParams(query);

  const filters = {
    search: query.search || null,
    status: query.status || 'active',
    entityIds,
  };

  const sort = {
    sortBy: query.sort_by || 'entity_name',
    sortOrder: query.sort_order || 'ASC',
  };

  const { rows, count } = await entityRepository.findAll(filters, { limit, offset }, sort);
  const meta = getPaginationMeta(count, page, limit);

  return { data: rows, meta };
};

/**
 * @param {number} id
 * @param {number[]} entityIds - the caller's allowed Entity IDs
 * @returns {Promise<Entity>}
 */
const getById = async (id, entityIds = []) => {
  const entity = await entityRepository.findById(id, entityIds);

  if (!entity) {
    const err = new Error('Entity not found.');
    err.statusCode = 404;
    throw err;
  }

  return entity;
};

/**
 * Create a new Entity. created_by is always the calling user (Admin or
 * Entity Admin). entity_admin_employee_id resolution branches on the caller:
 *   - Entity Admin: always forced to their own actorId — never trusted
 *     from the request body, since an Entity Admin must only ever create
 *     an Entity for themselves, not assign one to someone else.
 *   - Admin: optionally assigned to an existing Entity Admin THEY created
 *     (assertValidEntityAdminAssignment), or left unassigned for a later
 *     reassignment via update() — unchanged from before.
 *
 * @param {object} data - { entity_name, [entity_code], [status], [entity_admin_employee_id] }
 * @param {number} actorId - the calling Admin or Entity Admin
 * @param {object} req
 * @param {boolean} [isEntityAdmin] - true when the caller is an Entity Admin
 * @returns {Promise<Entity>}
 */
const create = async (data, actorId, req, isEntityAdmin = false) => {
  let entityAdminUserId;
  if (isEntityAdmin) {
    entityAdminUserId = actorId;
  } else {
    await assertValidEntityAdminAssignment(data.entity_admin_employee_id, actorId);
    entityAdminUserId = data.entity_admin_employee_id || null;
  }

  let entity_code = data.entity_code || generateEntityCode();
  let attempts = 0;
  while (await entityRepository.findByCode(entity_code)) {
    if (data.entity_code) {
      const err = new Error(`Entity code "${data.entity_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
    if (attempts >= 5) {
      const err = new Error('Failed to generate a unique entity code. Please try again.');
      err.statusCode = 500;
      throw err;
    }
    entity_code = generateEntityCode();
    attempts++;
  }

  const payload = {
    ...data,
    entity_code,
    entity_admin_employee_id: entityAdminUserId,
    created_by: actorId,
    updated_by: actorId,
  };

  const entity = await entityRepository.create(payload);

  await createAuditLog(
    actorId,
    'CREATE',
    'entities',
    entity.id,
    null,
    { entity_code: entity.entity_code, entity_name: entity.entity_name, entity_admin_employee_id: entity.entity_admin_employee_id },
    getIpAddress(req)
  );

  logger.info('Entity created', { entityId: entity.id, entity_code: entity.entity_code, actorId });

  return entity;
};

/**
 * @param {number} id
 * @param {object} data - may include entity_admin_employee_id to (re)assign
 * @param {number} userId - the calling Admin
 * @param {object} req
 * @param {number[]} entityIds - the caller's allowed Entity IDs (req.entityIds)
 * @returns {Promise<Entity>}
 */
const update = async (id, data, userId, req, entityIds) => {
  const existing = await entityRepository.findById(id, entityIds);
  if (!existing) {
    const err = new Error('Entity not found.');
    err.statusCode = 404;
    throw err;
  }

  if (data.entity_code && data.entity_code !== existing.entity_code) {
    const conflict = await entityRepository.findByCode(data.entity_code);
    if (conflict) {
      const err = new Error(`Entity code "${data.entity_code}" is already in use.`);
      err.statusCode = 409;
      throw err;
    }
  }

  if (data.entity_admin_employee_id !== undefined && data.entity_admin_employee_id !== existing.entity_admin_employee_id) {
    await assertValidEntityAdminAssignment(data.entity_admin_employee_id, userId);
  }

  const oldValues = {
    entity_code: existing.entity_code,
    entity_name: existing.entity_name,
    status: existing.status,
    entity_admin_employee_id: existing.entity_admin_employee_id,
  };

  const payload = { ...data, updated_by: userId };
  const updated = await entityRepository.update(id, payload, entityIds);

  await createAuditLog(userId, 'UPDATE', 'entities', id, oldValues, payload, getIpAddress(req));

  logger.info('Entity updated', { entityId: id, userId });

  return updated;
};

/**
 * Soft-delete an Entity. Refuses to delete if any Company still references it.
 *
 * @param {number} id
 * @param {number} userId - the calling Admin
 * @param {object} req
 * @param {number[]} entityIds - the caller's allowed Entity IDs (req.entityIds)
 * @returns {Promise<void>}
 */
const deleteEntity = async (id, userId, req, entityIds) => {
  const existing = await entityRepository.findById(id, entityIds);
  if (!existing) {
    const err = new Error('Entity not found.');
    err.statusCode = 404;
    throw err;
  }

  if (existing.status === 'inactive') {
    const err = new Error('Entity is already inactive.');
    err.statusCode = 400;
    throw err;
  }

  const companyCount = await entityRepository.countCompaniesByEntity(id);
  if (companyCount > 0) {
    const err = new Error(
      `Cannot delete entity "${existing.entity_name}". ` +
      `${companyCount} Compan${companyCount === 1 ? 'y is' : 'ies are'} linked to this entity. ` +
      'Reassign or remove them before deleting.'
    );
    err.statusCode = 409;
    throw err;
  }

  await entityRepository.softDelete(id, userId, entityIds);

  await createAuditLog(userId, 'DELETE', 'entities', id, { status: 'active' }, { status: 'inactive' }, getIpAddress(req));

  logger.info('Entity soft-deleted', { entityId: id, userId });
};

module.exports = {
  getAll,
  getById,
  create,
  update,
  deleteEntity,
};
