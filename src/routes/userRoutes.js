import express from 'express';
import { changePassword, getMe, updateMyAvatar, removeMyAvatar } from '../controllers/userController.js';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { blockInactiveChurch } from '../middlewares/tenantMiddleware.js';
import { uploadAvatar, handleAvatarUploadError } from '../middlewares/uploadMiddleware.js';

const router = express.Router();

// Every route here belongs to one church. Applied at router level so a route
// added later cannot skip the guard; the per-route verifyToken calls below are
// now redundant but harmless, and left in place as a second line of defence.
router.use(verifyToken, blockInactiveChurch);

router.patch('/change-password',verifyToken, changePassword);

// Current user's own profile + avatar (self-service).
router.get('/me', verifyToken, getMe);
router.patch('/me/avatar', verifyToken, uploadAvatar.single('avatar'), handleAvatarUploadError, updateMyAvatar);
router.delete('/me/avatar', verifyToken, removeMyAvatar);

export default router;