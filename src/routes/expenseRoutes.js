import express from 'express';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { authorizeRoles } from '../middlewares/roleMiddleware.js';
import { createManualExpense, getAllExpenses, getExpensesByCategory } from '../controllers/expenseController.js';

const router = express.Router();

router.get('/by-category', verifyToken, getExpensesByCategory);
router.get('/', verifyToken, getAllExpenses);
router.post('/', verifyToken, authorizeRoles('admin'), createManualExpense);

export default router;