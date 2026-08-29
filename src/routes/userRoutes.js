import express from 'express';
import { changePassword, getMe, updateMyAvatar, removeMyAvatar } from '../controllers/userController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { uploadAvatar, handleAvatarUploadError } from '../middlewares/uploadMiddleware.js';

const router = express.Router();

router.patch('/change-password',verifyToken, changePassword);

// Current user's own profile + avatar (self-service).
router.get('/me', verifyToken, getMe);
router.patch('/me/avatar', verifyToken, uploadAvatar.single('avatar'), handleAvatarUploadError, updateMyAvatar);
router.delete('/me/avatar', verifyToken, removeMyAvatar);

export default router;