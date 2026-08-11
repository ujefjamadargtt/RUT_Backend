'use strict';

const teamMappingRepository = require('../repositories/teamMappingRepository');
const managerServicePOMappingRepository = require('../repositories/managerServicePOMappingRepository');
const roleRepository = require('../repositories/roleRepository');
const { ServicePO } = require('../models');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Team Mapping Service — Service PO Admin's own "My Team" screen.
 *
 * Self-service, unlike the old headManagerMappingService this replaces: the
 * Service PO Admin IS the actor (their own req.userId), not a third party
 * (BU Admin) assigning on someone else's behalf — see the RBAC redesign's
 * decision that Service PO Admin now directly owns/creates Manager
 * accounts and the team they manage.
 *
 * Two related capabilities live here, matching the spec's two distinct
 * Service PO Admin responsibilities:
 *   - "Manage Team" (servicepo.manage_team) — the Manager roster itself
 *     (assign/remove which Managers are on my team) — team_mappings.
 *   - "Manage Team Mapping" (servicepo.manage_team_mapping) — which Service
 *     POs my team's Managers can operate on — reuses the existing
 *     manager_servicepo_mappings table/repository unmodified (its shape
 *     never depended on who the granting actor was).
 */

function notFoundError(message) {
  const err = new Error(message);
  err.statusCode = 404;
  return err;
}

function badRequestError(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function conflictError(message) {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
}

function forbiddenError(message) {
  const err = new Error(message);
  err.statusCode = 403;
  return err;
}

async function resolveRoleId(roleName) {
  const role = await roleRepository.findByName(roleName);
  if (!role) {
    const err = new Error(`The "${roleName}" role is not seeded.`);
    err.statusCode = 500;
    throw err;
  }
  return role.id;
}

/**
 * The calling Service PO Admin's own Managers.
 *
 * @param {number} servicePOAdminUserId
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
const getMyTeam = async (servicePOAdminUserId, companyId) => {
  return teamMappingRepository.findByServicePOAdmin(servicePOAdminUserId, companyId);
};

/**
 * ALL Managers of the company, each flagged with whether they're already on
 * a team (and whose) — powers the "Add Manager to my team" drawer.
 *
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
const getAvailableManagers = async (companyId) => {
  const managerRoleId = await resolveRoleId('Manager');
  const [managers, mappings] = await Promise.all([
    teamMappingRepository.findUsersByRole(managerRoleId, companyId),
    teamMappingRepository.findAllMappingsInCompany(companyId),
  ]);

  const ownerByManagerId = new Map(mappings.map((m) => [m.manager_user_id, m.service_po_admin_user_id]));

  return managers.map((m) => ({
    id: m.id,
    email: m.email,
    status: m.status,
    service_po_admin_user_id: ownerByManagerId.get(m.id) || null,
  }));
};

/**
 * Add a Manager to the calling Service PO Admin's own team.
 *
 * @param {number} servicePOAdminUserId
 * @param {number} managerUserId
 * @param {number} companyId
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<TeamMapping>}
 */
const addManager = async (servicePOAdminUserId, managerUserId, companyId, actorId, req) => {
  if (servicePOAdminUserId === managerUserId) {
    throw badRequestError('You cannot map yourself as your own team member.');
  }

  const managerRoleId = await resolveRoleId('Manager');
  const candidates = await teamMappingRepository.findUsersByRole(managerRoleId, companyId);
  const target = candidates.find((u) => u.id === managerUserId);
  if (!target) {
    throw notFoundError('Manager not found in this company.');
  }
  if (target.status !== 'active') {
    throw badRequestError('Cannot map an inactive Manager.');
  }

  const existing = await teamMappingRepository.findByManager(managerUserId);
  if (existing) {
    throw conflictError(
      existing.service_po_admin_user_id === servicePOAdminUserId
        ? 'This Manager is already on your team.'
        : 'This Manager already belongs to a different Service PO Admin\'s team.'
    );
  }

  const mapping = await teamMappingRepository.create({
    company_id: companyId,
    service_po_admin_user_id: servicePOAdminUserId,
    manager_user_id: managerUserId,
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  });

  await createAuditLog(
    actorId,
    'CREATE',
    'team_mappings',
    mapping.id,
    null,
    { service_po_admin_user_id: servicePOAdminUserId, manager_user_id: managerUserId },
    getIpAddress(req)
  );

  logger.info('Team mapping created', { mappingId: mapping.id, servicePOAdminUserId, managerUserId, actorId });

  return mapping;
};

/**
 * Remove a Manager from the calling Service PO Admin's own team.
 *
 * @param {number} servicePOAdminUserId
 * @param {number} managerUserId
 * @param {number} companyId
 * @param {number} actorId
 * @param {object} req
 * @returns {Promise<void>}
 */
const removeManager = async (servicePOAdminUserId, managerUserId, companyId, actorId, req) => {
  const existing = await teamMappingRepository.findByServicePOAdminAndManager(servicePOAdminUserId, managerUserId, companyId);
  if (!existing) {
    throw notFoundError('This Manager is not on your team.');
  }

  await teamMappingRepository.deleteById(existing.id);

  await createAuditLog(
    actorId,
    'DELETE',
    'team_mappings',
    existing.id,
    { service_po_admin_user_id: servicePOAdminUserId, manager_user_id: managerUserId },
    null,
    getIpAddress(req)
  );

  logger.info('Team mapping removed', { servicePOAdminUserId, managerUserId, actorId });
};

/**
 * Confirm a Manager is on the calling Service PO Admin's own team — the
 * scoping check both grantServicePO()/revokeServicePO() below use, so a
 * Service PO Admin can only grant Service PO access to Managers actually on
 * their own team.
 */
async function assertOwnTeamMember(servicePOAdminUserId, managerUserId, companyId) {
  const mapping = await teamMappingRepository.findByServicePOAdminAndManager(servicePOAdminUserId, managerUserId, companyId);
  if (!mapping) {
    throw forbiddenError('This Manager is not on your team.');
  }
}

/**
 * Grant a Service PO to one of the Service PO Admin's own team Managers —
 * "Manage Team Mapping". Reuses manager_servicepo_mappings unmodified.
 *
 * @param {number} servicePOAdminUserId
 * @param {number} managerUserId
 * @param {number} servicePOId
 * @param {number} companyId
 * @param {number} actorId
 * @returns {Promise<ManagerServicePOMapping>}
 */
const grantServicePO = async (servicePOAdminUserId, managerUserId, servicePOId, companyId, actorId) => {
  await assertOwnTeamMember(servicePOAdminUserId, managerUserId, companyId);

  const servicePO = await ServicePO.findOne({ where: { id: servicePOId, company_id: companyId } });
  if (!servicePO) {
    throw notFoundError('Service PO not found in this company.');
  }

  const existing = await managerServicePOMappingRepository.findByManagerAndServicePO(managerUserId, servicePOId, companyId);
  if (existing) {
    throw conflictError('This Service PO is already granted to this Manager.');
  }

  const grant = await managerServicePOMappingRepository.create({
    company_id: companyId,
    manager_user_id: managerUserId,
    service_po_id: servicePOId,
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  });

  logger.info('Service PO granted to team Manager', { servicePOAdminUserId, managerUserId, servicePOId, actorId });

  return grant;
};

/**
 * Revoke a Service PO grant from one of the Service PO Admin's own team
 * Managers.
 *
 * @param {number} servicePOAdminUserId
 * @param {number} managerUserId
 * @param {number} servicePOId
 * @param {number} companyId
 * @returns {Promise<void>}
 */
const revokeServicePO = async (servicePOAdminUserId, managerUserId, servicePOId, companyId) => {
  await assertOwnTeamMember(servicePOAdminUserId, managerUserId, companyId);

  const existing = await managerServicePOMappingRepository.findByManagerAndServicePO(managerUserId, servicePOId, companyId);
  if (!existing) {
    throw notFoundError('This Service PO is not granted to this Manager.');
  }

  await managerServicePOMappingRepository.deleteById(existing.id);

  logger.info('Service PO revoked from team Manager', { servicePOAdminUserId, managerUserId, servicePOId });
};

/**
 * Every Service PO grant across the Service PO Admin's own team — powers
 * the "Manage Team Mapping" screen's listing.
 *
 * @param {number} servicePOAdminUserId
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
const getMyTeamServicePOGrants = async (servicePOAdminUserId, companyId) => {
  const team = await teamMappingRepository.findByServicePOAdmin(servicePOAdminUserId, companyId);
  const managerIds = team.map((t) => t.manager_user_id);
  if (managerIds.length === 0) return [];

  const grants = await managerServicePOMappingRepository.findAllMappingsInCompany(companyId);
  return grants.filter((g) => managerIds.includes(g.manager_user_id));
};

module.exports = {
  getMyTeam,
  getAvailableManagers,
  addManager,
  removeManager,
  grantServicePO,
  revokeServicePO,
  getMyTeamServicePOGrants,
};
