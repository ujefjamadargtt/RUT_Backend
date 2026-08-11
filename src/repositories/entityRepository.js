'use strict';

const { Op } = require('sequelize');
const { Entity, Company, User } = require('../models');

/**
 * Entity Repository
 * All direct database interaction for the entities table. No business
 * logic — that belongs in entityService.js. Entity Master management
 * (create/update/delete) is Admin-only (see requireAdmin.js) — Entity Admin
 * is ASSIGNED to an Entity, never creates/edits/deletes one. Both read
 * access (findAll/findById) and write access (update/softDelete) are
 * scoped to a caller-supplied set of Entity IDs (entityIds) — populated by
 * requireEntityAdminOrAdmin.js for reads (an Entity Admin's own assigned
 * Entities, or an Admin's derived scope — see findIdsOwnedByAdmin below)
 * and requireAdmin.js for writes (an Admin's derived scope only) — so
 * neither an Entity Admin nor another Admin can ever touch an Entity
 * outside their own scope.
 */

/**
 * Retrieve a paginated, filtered, sorted list of Entities the caller is
 * allowed to see.
 *
 * @param {object} filters - { search, status, entityIds }
 * @param {{ limit: number, offset: number }} pagination
 * @param {{ sortBy: string, sortOrder: string }} sort
 * @returns {Promise<{ rows: Entity[], count: number }>}
 */
const findAll = async (filters = {}, pagination = {}, sort = {}) => {
  const { search, status, entityIds = [] } = filters;
  const { limit = 10, offset = 0 } = pagination;
  const { sortBy = 'entity_name', sortOrder = 'ASC' } = sort;

  const where = { id: { [Op.in]: entityIds }, is_deleted: false };

  if (status && status !== 'all') {
    where.status = status;
  }

  if (search && search.trim()) {
    where[Op.or] = [
      { entity_name: { [Op.iLike]: `%${search.trim()}%` } },
      { entity_code: { [Op.iLike]: `%${search.trim()}%` } },
    ];
  }

  const allowedSortColumns = ['entity_name', 'entity_code', 'created_at', 'status'];
  const safeSortBy = allowedSortColumns.includes(sortBy) ? sortBy : 'entity_name';
  const safeSortOrder = ['ASC', 'DESC'].includes(sortOrder.toUpperCase())
    ? sortOrder.toUpperCase()
    : 'ASC';

  return Entity.findAndCountAll({
    where,
    limit,
    offset,
    order: [[safeSortBy, safeSortOrder]],
    attributes: ['id', 'entity_code', 'entity_name', 'entity_admin_user_id', 'status', 'created_at', 'updated_at', 'created_by'],
  });
};

/**
 * Find a single Entity by primary key, scoped to the caller's allowed set.
 *
 * @param {number} id
 * @param {number[]} entityIds - the caller's allowed Entity IDs
 * @returns {Promise<Entity|null>}
 */
const findById = async (id, entityIds = []) => {
  if (!entityIds.includes(id)) {
    return null;
  }
  return Entity.findOne({
    where: { id, is_deleted: false },
    attributes: ['id', 'entity_code', 'entity_name', 'entity_admin_user_id', 'status', 'created_at', 'updated_at', 'created_by', 'updated_by'],
  });
};

/**
 * Resolve the set of Entity IDs an Admin (hierarchy_rank 2) is allowed to
 * see — derived, not stored. An Entity belongs to an Admin's scope when
 * EITHER:
 *   (a) the Admin created it directly (entities.created_by = adminUserId —
 *       the normal case going forward: Entity Master is now an Admin-only
 *       flow, see entityService.js), OR
 *   (b) its assigned Entity Admin (entities.entity_admin_user_id) was
 *       created by that Admin (users.created_by) — covers an Entity the
 *       Admin created and later re-assigned, and legacy Entities from
 *       before Entity Master became Admin-only.
 * Both reuse relationships that already exist (Entity.created_by,
 * Entity -> owning Entity Admin User, User.created_by) — no new ownership
 * table. An Entity with neither condition true (e.g. self-created by an
 * Entity Admin before this fix, or owned by an Entity Admin created by
 * Platform Admin before the Admin tier existed) simply never matches any
 * Admin's scope — the deliberately safe outcome for pre-existing/legacy
 * data — see database/migrations/20260850_document_legacy_entity_ownership.sql.
 *
 * @param {number} adminUserId
 * @returns {Promise<number[]>}
 */
const findIdsOwnedByAdmin = async (adminUserId) => {
  const entities = await Entity.findAll({
    where: {
      is_deleted: false,
      [Op.or]: [
        { created_by: adminUserId },
        { '$entityAdmin.created_by$': adminUserId },
      ],
    },
    include: [
      {
        model: User,
        as: 'entityAdmin',
        attributes: [],
        required: false,
      },
    ],
    attributes: ['id'],
  });
  return entities.map((e) => e.id);
};

/**
 * Find an Entity by its code — global uniqueness (unlike Client/Project,
 * entity_code has no per-owner scoping; see uq_entities_entity_code).
 *
 * @param {string} code
 * @returns {Promise<Entity|null>}
 */
const findByCode = async (code) => {
  return Entity.findOne({
    where: { entity_code: code },
    attributes: ['id', 'entity_code', 'entity_name', 'status'],
  });
};

/**
 * Insert a new Entity.
 *
 * @param {object} data
 * @returns {Promise<Entity>}
 */
const create = async (data) => {
  return Entity.create(data);
};

/**
 * Update an existing Entity, scoped to the caller's allowed Entity set —
 * Entity Master management is Admin-only (see requireAdmin.js), so the
 * scope is req.entityIds (the Admin's own Entities), not a single
 * entity_admin_user_id (an Entity's assigned Entity Admin is data being
 * edited here, not necessarily the actor doing the editing).
 *
 * @param {number} id
 * @param {object} data
 * @param {number[]} entityIds - the caller's allowed Entity IDs
 * @returns {Promise<Entity|null>}
 */
const update = async (id, data, entityIds = []) => {
  if (!entityIds.includes(id)) {
    return null;
  }

  const [affectedRows, [updated]] = await Entity.update(data, {
    where: { id },
    returning: true,
  });

  if (affectedRows === 0) {
    return null;
  }

  return updated;
};

/**
 * Soft-delete an Entity, scoped to the caller's allowed Entity set — see
 * update()'s doc comment above for why this is entityIds, not a single owner.
 *
 * @param {number} id
 * @param {number} updatedBy
 * @param {number[]} entityIds - the caller's allowed Entity IDs
 * @returns {Promise<boolean>} true if a row was affected.
 */
const softDelete = async (id, updatedBy, entityIds = []) => {
  if (!entityIds.includes(id)) {
    return false;
  }

  const [affectedRows] = await Entity.update(
    { status: 'inactive', is_deleted: true, updated_by: updatedBy },
    { where: { id } }
  );
  return affectedRows > 0;
};

/**
 * Count non-deleted Companies linked to a given Entity — delete guard.
 *
 * @param {number} entityId
 * @returns {Promise<number>}
 */
const countCompaniesByEntity = async (entityId) => {
  return Company.count({
    where: { entity_id: entityId, is_deleted: false },
  });
};

module.exports = {
  findAll,
  findById,
  findByCode,
  findIdsOwnedByAdmin,
  create,
  update,
  softDelete,
  countCompaniesByEntity,
};
