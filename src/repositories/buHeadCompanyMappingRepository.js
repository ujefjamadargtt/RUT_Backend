'use strict';

const { Op } = require('sequelize');
const { BuHeadCompanyMapping, Company } = require('../models');

/**
 * BU Head <-> Company Mapping Repository
 * Raw database access only — no business logic. See
 * database/migrations/20260863_create_bu_head_company_mappings.sql.
 */

/**
 * @param {number} buHeadUserId
 * @returns {Promise<number[]>}
 */
const findCompanyIdsForBuHead = async (buHeadUserId) => {
  const mappings = await BuHeadCompanyMapping.findAll({
    where: { bu_head_user_id: buHeadUserId, status: 'active' },
    attributes: ['company_id'],
  });
  return mappings.map((m) => m.company_id);
};

/**
 * Mapped companies for a BU Head, with company display fields joined in —
 * used by both authService.login()'s `mapped_bu` response field and the
 * dedicated GET /bu-heads/:id/companies endpoint.
 *
 * @param {number} buHeadUserId
 * @returns {Promise<{ id: number, company_id: number, company: Company }[]>}
 */
const findMappingsForBuHead = async (buHeadUserId) => {
  return BuHeadCompanyMapping.findAll({
    where: { bu_head_user_id: buHeadUserId, status: 'active' },
    include: [
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'company_code', 'company_name', 'status'],
      },
    ],
    order: [[{ model: Company, as: 'company' }, 'company_name', 'ASC']],
  });
};

/**
 * Distinct BU Head user ids mapped to ANY of the given Companies — the
 * resolution step "BU Head Master"'s list view needs before it can query
 * Users by id (mirrors companyRepository.findIdsByEntityIds's role in
 * entityBuAdminService.js).
 *
 * @param {number[]} companyIds
 * @returns {Promise<number[]>}
 */
const findBuHeadUserIdsForCompanyIds = async (companyIds) => {
  if (!companyIds || companyIds.length === 0) return [];

  const mappings = await BuHeadCompanyMapping.findAll({
    where: { company_id: { [Op.in]: companyIds }, status: 'active' },
    attributes: ['bu_head_user_id'],
    group: ['bu_head_user_id'],
  });
  return mappings.map((m) => m.bu_head_user_id);
};

/**
 * Whether an active mapping exists between this BU Head and this Company —
 * the exact check resolveCompany.js relies on before trusting a selected-BU
 * header.
 *
 * @param {number} buHeadUserId
 * @param {number} companyId
 * @returns {Promise<boolean>}
 */
const exists = async (buHeadUserId, companyId) => {
  const mapping = await BuHeadCompanyMapping.findOne({
    where: { bu_head_user_id: buHeadUserId, company_id: companyId, status: 'active' },
    attributes: ['id'],
  });
  return !!mapping;
};

/**
 * @param {object} data - { bu_head_user_id, company_id, created_by, updated_by }
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<BuHeadCompanyMapping>}
 */
const create = async (data, options = {}) => {
  return BuHeadCompanyMapping.create(data, options);
};

/**
 * @param {number[]} companyIds
 * @param {number} buHeadUserId
 * @param {number} actorId
 * @param {object} [options] - Sequelize options (e.g. { transaction })
 * @returns {Promise<BuHeadCompanyMapping[]>}
 */
const bulkCreate = async (companyIds, buHeadUserId, actorId, options = {}) => {
  return BuHeadCompanyMapping.bulkCreate(
    companyIds.map((companyId) => ({
      bu_head_user_id: buHeadUserId,
      company_id: companyId,
      created_by: actorId,
      updated_by: actorId,
    })),
    options
  );
};

/**
 * Remove a single mapping — deletes only this join row, never the Company/
 * User/Employee it points at.
 *
 * @param {number} buHeadUserId
 * @param {number} companyId
 * @returns {Promise<number>} number of rows deleted (0 or 1)
 */
const deleteMapping = async (buHeadUserId, companyId) => {
  return BuHeadCompanyMapping.destroy({
    where: { bu_head_user_id: buHeadUserId, company_id: companyId },
  });
};

module.exports = {
  findCompanyIdsForBuHead,
  findMappingsForBuHead,
  findBuHeadUserIdsForCompanyIds,
  exists,
  create,
  bulkCreate,
  deleteMapping,
};
