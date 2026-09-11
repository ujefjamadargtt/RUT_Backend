'use strict';

const teamMappingRepository = require('../repositories/teamMappingRepository');
const managerServicePOMappingRepository = require('../repositories/managerServicePOMappingRepository');
const roleRepository = require('../repositories/roleRepository');
const { ServicePO } = require('../models');
const { createAuditLog, getIpAddress } = require('../middlewares/auditLog');
const logger = require('../utils/logger');

/**
 * Team Mapping Service — Project Manager's own "My Team" screen.
 *
 * Self-service, unlike the old headManagerMappingService this replaces: the
 * Project Manager IS the actor (their own req.userId), not a third party
 * (BU Admin) assigning on someone else's behalf — see the RBAC redesign's
 * decision that Project Manager now directly owns/creates Team Lead
 * accounts and the team they manage.
 *
 * "Team Lead" is the role_name this file's Managers/managerUserId
 * params/variables/DB columns (manager_user_id, manager_servicepo_mappings,
 * team_mappings.manager_user_id, ...) refer to — renamed from "Manager" in
 * 20260897_rename_manager_role_to_team_lead.sql (same role_id, so none of
 * that internal plumbing needed to change, only the display name callers
 * resolve by).
 *
 * Two related capabilities live here, matching the spec's two distinct
 * Project Manager responsibilities:
 *   - "Manage Team" (servicepo.manage_team) — the Team Lead roster itself
 *     (assign/remove which Team Leads are on my team) — team_mappings.
 *   - "Manage Team Mapping" (servicepo.manage_team_mapping) — which Service
 *     POs my team's Team Leads can operate on — reuses the existing
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
 * The calling Project Manager's own Team Leads.
 *
 * @param {number} servicePOAdminUserId
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
const getMyTeam = async (servicePOAdminUserId, companyId) => {
  return teamMappingRepository.findByServicePOAdmin(servicePOAdminUserId, companyId);
};

/**
 * ALL Team Leads of the company, each flagged with whether they're already
 * on a team (and whose) — powers the "Add Team Lead to my team" drawer.
 *
 * @param {number} companyId
 * @returns {Promise<Array>}
 */
const getAvailableManagers = async (companyId) => {
  const managerRoleId = await resolveRoleId('Team Lead');
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
 * Add a Team Lead to the calling Project Manager's own team.
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

  const managerRoleId = await resolveRoleId('Team Lead');
  const candidates = await teamMappingRepository.findUsersByRole(managerRoleId, companyId);
  const target = candidates.find((u) => u.id === managerUserId);
  if (!target) {
    throw notFoundError('Team Lead not found in this company.');
  }
  if (target.status !== 'active') {
    throw badRequestError('Cannot map an inactive Team Lead.');
  }

  const existing = await teamMappingRepository.findByManager(managerUserId);
  if (existing) {
    throw conflictError(
      existing.service_po_admin_user_id === servicePOAdminUserId
        ? 'This Team Lead is already on your team.'
        : 'This Team Lead already belongs to a different Project Manager\'s team.'
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
 * Remove a Team Lead from the calling Project Manager's own team.
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
    throw notFoundError('This Team Lead is not on your team.');
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
 * Confirm a Team Lead is on the calling Project Manager's own team — the
 * scoping check both grantServicePO()/revokeServicePO() below use, so a
 * Project Manager can only grant Service PO access to Team Leads actually on
 * their own team.
 */
async function assertOwnTeamMember(servicePOAdminUserId, managerUserId, companyId) {
  const mapping = await teamMappingRepository.findByServicePOAdminAndManager(servicePOAdminUserId, managerUserId, companyId);
  if (!mapping) {
    throw forbiddenError('This Team Lead is not on your team.');
  }
}

/**
 * Grant a Service PO to one of the Project Manager's own team Team Leads —
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
    throw conflictError('This Service PO is already granted to this Team Lead.');
  }

  const grant = await managerServicePOMappingRepository.create({
    company_id: companyId,
    manager_user_id: managerUserId,
    service_po_id: servicePOId,
    status: 'active',
    created_by: actorId,
    updated_by: actorId,
  });

  logger.info('Service PO granted to team member (Team Lead)', { servicePOAdminUserId, managerUserId, servicePOId, actorId });

  return grant;
};

/**
 * Revoke a Service PO grant from one of the Project Manager's own team
 * Team Leads.
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
    throw notFoundError('This Service PO is not granted to this Team Lead.');
  }

  await managerServicePOMappingRepository.deleteById(existing.id);

  logger.info('Service PO revoked from team member (Team Lead)', { servicePOAdminUserId, managerUserId, servicePOId });
};

/**
 * Every Service PO grant across the Project Manager's own team of Team
 * Leads — powers the "Manage Team Mapping" screen's listing.
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
