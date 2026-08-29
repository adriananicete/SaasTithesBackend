import express from 'express';
import { verifyToken } from '../../middlewares/authMiddleware.js';
import { authorizeRoles } from '../../middlewares/roleMiddleware.js';
import { getDashboard } from '../../controllers/superadmin/dashboardController.js';
import { ROLES } from '../../constants/roles.js';

const router = express.Router();

// Superadmin-only, gated once at router level like churchRoutes.
router.use(verifyToken, authorizeRoles(ROLES.SUPERADMIN));

// @desc   Owner overview: every church, its account totals, the per-role
//         breakdown with names, and activity counts
// @routes /api/superadmin/dashboard
router.get('/', getDashboard);

export default router;
