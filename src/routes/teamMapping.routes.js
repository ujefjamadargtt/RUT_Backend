'use strict';

/**
 * @swagger
 * tags:
 *   name: Team Mapping
 *   description: >
 *     Service PO Admin's own "My Team" screen — self-service: lists and
 *     manages the calling Service PO Admin's own Managers ("Manage Team")
 *     and which Service POs those Managers can operate on ("Manage Team
 *     Mapping"). Replaces the old BU-Admin-assigns-Head-Manager flow now
 *     that the "Head Manager" role is retired.
 */

const express = require('express');
const router = express.Router();

const authenticate = require('../middlewares/auth');
const authorize = require('../middlewares/authorize');
const { validate } = require('../middlewares/validateRequest');
const { addManagerSchema, grantServicePOSchema } = require('../validations/teamMappingValidation');
const controller = require('../controllers/teamMappingController');

router.get(
  '/',
  authenticate,
  authorize('servicepo.manage_team'),
  controller.getMyTeam
);

router.get(
  '/available-managers',
  authenticate,
  authorize('servicepo.manage_team'),
  controller.getAvailableManagers
);

router.post(
  '/managers',
  authenticate,
  authorize('servicepo.manage_team'),
  validate(addManagerSchema),
  controller.addManager
);

router.delete(
  '/managers/:managerUserId',
  authenticate,
  authorize('servicepo.manage_team'),
  controller.removeManager
);

router.get(
  '/service-po-grants',
  authenticate,
  authorize('servicepo.manage_team_mapping'),
  controller.getMyTeamServicePOGrants
);

router.post(
  '/managers/:managerUserId/service-pos',
  authenticate,
  authorize('servicepo.manage_team_mapping'),
  validate(grantServicePOSchema),
  controller.grantServicePO
);

router.delete(
  '/managers/:managerUserId/service-pos/:servicePOId',
  authenticate,
  authorize('servicepo.manage_team_mapping'),
  controller.revokeServicePO
);

module.exports = router;
