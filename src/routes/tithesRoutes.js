import express from 'express';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { authorizeRoles } from '../middlewares/roleMiddleware.js';
import { approveTithes, getAllTithes, rejectTithes, submitTithes, updateTithes } from '../controllers/tithesController.js';

const router = express.Router();

router.get('/', verifyToken, getAllTithes);
router.post('/', verifyToken, submitTithes);
router.patch('/:id', verifyToken, updateTithes);
router.patch('/:id/approve', verifyToken, authorizeRoles('do', 'auditor', 'admin'), approveTithes);
router.patch('/:id/reject', verifyToken, authorizeRoles('do', 'auditor', 'admin'), rejectTithes);

export default router;