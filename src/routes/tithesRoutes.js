import express from 'express';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { blockInactiveChurch } from '../middlewares/tenantMiddleware.js';
import { authorizeRoles } from '../middlewares/roleMiddleware.js';
import { approveTithes, getAllTithes, rejectTithes, submitTithes, updateTithes } from '../controllers/tithesController.js';
import { TITHES_REVIEWER_ROLES } from '../constants/roles.js';

const router = express.Router();

// Every route here belongs to one church. Applied at router level so a route
// added later cannot skip the guard; the per-route verifyToken calls below are
// now redundant but harmless, and left in place as a second line of defence.
router.use(verifyToken, blockInactiveChurch);

router.get('/', verifyToken, getAllTithes);
router.post('/', verifyToken, submitTithes);
router.patch('/:id', verifyToken, updateTithes);
// auditor is deliberately absent: it is read-only oversight, and the
// controller has always refused it. The route used to let it through and the
// controller then 403'd, which is businessRequirements §14 item 3.
router.patch('/:id/approve', verifyToken, authorizeRoles(...TITHES_REVIEWER_ROLES), approveTithes);
router.patch('/:id/reject', verifyToken, authorizeRoles(...TITHES_REVIEWER_ROLES), rejectTithes);

export default router;