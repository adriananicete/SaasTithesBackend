import express from 'express';
import { getNotifications, markAllAsRead, markAsRead } from '../controllers/notificationController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';

const router = express.Router();

router.get('/', verifyToken, getNotifications);
router.patch('/read-all', verifyToken, markAllAsRead);
router.patch('/:id/read', verifyToken, markAsRead);

export default router;