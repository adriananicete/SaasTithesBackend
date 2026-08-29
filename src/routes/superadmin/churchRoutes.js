import express from 'express';
import { verifyToken } from '../../middlewares/authMiddleware.js';
import { authorizeRoles } from '../../middlewares/roleMiddleware.js';
import {
    getAllChurches,
    getChurch,
    createChurch,
    updateChurch,
    activateChurch,
    deactivateChurch,
    softDeleteChurch,
    restoreChurch,
    purgeChurch,
} from '../../controllers/superadmin/churchController.js';
import { ROLES } from '../../constants/roles.js';

const router = express.Router();

// Every route here is superadmin-only. Applied once at the router level rather
// than repeated per route, so a new endpoint cannot be added ungated by
// accident — these are the only routes in the API that cross church boundaries.
router.use(verifyToken, authorizeRoles(ROLES.SUPERADMIN));

// @desc   List every church, including soft-deleted ones
// @routes /api/superadmin/churches
router.get('/', getAllChurches);

// @desc   Create a church + its first admin, starter categories and counters
// @routes /api/superadmin/churches
router.post('/', createChurch);

// @desc   Get one church
// @routes /api/superadmin/churches/:id
router.get('/:id', getChurch);

// @desc   Update a church's name, acronym or contact details
// @routes /api/superadmin/churches/:id
router.patch('/:id', updateChurch);

// @desc   Activate a church (restores login for all its users)
// @routes /api/superadmin/churches/:id/activate
router.patch('/:id/activate', activateChurch);

// @desc   Deactivate a church (hides it from the dropdown, blocks its users)
// @routes /api/superadmin/churches/:id/deactivate
router.patch('/:id/deactivate', deactivateChurch);

// @desc   Restore a soft-deleted church
// @routes /api/superadmin/churches/:id/restore
router.patch('/:id/restore', restoreChurch);

// @desc   Permanently delete a church and all its data. Requires confirmName.
//         Declared before /:id so the more specific path wins.
// @routes /api/superadmin/churches/:id/purge
router.delete('/:id/purge', purgeChurch);

// @desc   Soft delete a church — hidden and blocked, data retained
// @routes /api/superadmin/churches/:id
router.delete('/:id', softDeleteChurch);

export default router;
