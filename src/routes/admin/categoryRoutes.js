import express from 'express';
import { createCategory, deleteCategory, getAllCategories, updateCategory } from '../../controllers/admin/categoryController.js';
import { verifyToken } from '../../middlewares/authMiddleware.js';
import { blockInactiveChurch } from '../../middlewares/tenantMiddleware.js';
import { authorizeRoles } from '../../middlewares/roleMiddleware.js';

const router = express.Router();

// Every route here belongs to one church. Applied at router level so a route
// added later cannot skip the guard; the per-route verifyToken calls below are
// now redundant but harmless, and left in place as a second line of defence.
router.use(verifyToken, blockInactiveChurch);

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