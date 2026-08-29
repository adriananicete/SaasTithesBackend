import express from 'express';
import { createCategory, deleteCategory, getAllCategories, updateCategory } from '../../controllers/admin/categoryController.js';
import { verifyToken } from '../../middlewares/authMiddleware.js';
import { authorizeRoles } from '../../middlewares/roleMiddleware.js';

const router = express.Router();

// @desc   Get all categories (readable by every authenticated role —
//         non-admins need this to populate Select dropdowns in
//         CreateRfDialog / CreateVoucherDialog / RecordExpenseDialog).
//         Write endpoints below stay admin-only.
// @routes /api/admin/categories
router.get('/', verifyToken, getAllCategories);

// @desc   Create new category
// @routes /api/admin/categories
router.post('/',verifyToken, authorizeRoles('admin'), createCategory);

// @desc   Update category
// @routes /api/admin/categories/:id
router.patch('/:id',verifyToken, authorizeRoles('admin'), updateCategory);

// @desc   Delete category
// @routes /api/admin/categories/:id
router.delete('/:id',verifyToken, authorizeRoles('admin'), deleteCategory);

export default router;