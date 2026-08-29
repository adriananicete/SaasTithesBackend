import express from 'express';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { blockInactiveChurch } from '../middlewares/tenantMiddleware.js';
import { authorizeRoles } from '../middlewares/roleMiddleware.js';
import { approveTithes, getAllTithes, rejectTithes, submitTithes, updateTithes } from '../controllers/tithesController.js';

const router = express.Router();

// Every route here belongs to one church. Applied at router level so a route
// added later cannot skip the guard; the per-route verifyToken calls below are
// now redundant but harmless, and left in place as a second line of defence.
router.use(verifyToken, blockInactiveChurch);

router.get('/', verifyToken, getAllTithes);
router.post('/', verifyToken, submitTithes);
router.patch('/:id', verifyToken, updateTithes);
router.patch('/:id/approve', verifyToken, authorizeRoles('do', 'auditor', 'admin'), approveTithes);
router.patch('/:id/reject', verifyToken, authorizeRoles('do', 'auditor', 'admin'), rejectTithes);

export default router;