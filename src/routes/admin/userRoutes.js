import express from 'express';
import { verifyToken } from '../../middlewares/authMiddleware.js';
import { authorizeRoles } from '../../middlewares/roleMiddleware.js';
import { createUser, deleteUser, getAllUsers, getUser, isActiveUser, updateUser, setUserAvatar, removeUserAvatar } from '../../controllers/admin/userController.js';
import { uploadAvatar, handleAvatarUploadError } from '../../middlewares/uploadMiddleware.js';

const router = express.Router();

// @desc   Get all users
// @routes /api/admin/users
router.get('/',verifyToken, authorizeRoles('admin'), getAllUsers);

// @desc   Get single user
// @routes /api/admin/users/:id
router.get('/:id',verifyToken, authorizeRoles('admin'), getUser);

// @desc   Create new user
// @routes /api/admin/users
router.post('/',verifyToken, authorizeRoles('admin'), createUser);

// @desc   Update user
// @routes /api/admin/users/:id
router.patch('/:id',verifyToken, authorizeRoles('admin'), updateUser);

// @desc   Update user
// @routes /api/admin/users/:id/deactivate
router.patch('/:id/deactivate',verifyToken, authorizeRoles('admin'), isActiveUser);

// @desc   Set/replace a user's avatar
// @routes /api/admin/users/:id/avatar
router.patch('/:id/avatar',verifyToken, authorizeRoles('admin'), uploadAvatar.single('avatar'), handleAvatarUploadError, setUserAvatar);

// @desc   Remove a user's avatar
// @routes /api/admin/users/:id/avatar
router.delete('/:id/avatar',verifyToken, authorizeRoles('admin'), removeUserAvatar);

// @desc   Delete user
// @routes /api/admin/users/:id
router.delete('/:id',verifyToken, authorizeRoles('admin'), deleteUser);

export default router;