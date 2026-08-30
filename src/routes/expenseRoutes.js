import express from 'express';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { blockInactiveChurch } from '../middlewares/tenantMiddleware.js';
import { authorizeRoles } from '../middlewares/roleMiddleware.js';
import { createManualExpense, getAllExpenses, getExpensesByCategory } from '../controllers/expenseController.js';
import { EXPENSE_READ_ROLES, EXPENSE_WRITE_ROLES } from '../constants/roles.js';

const router = express.Router();

// Every route here belongs to one church. Applied at router level so a route
// added later cannot skip the guard; the per-route verifyToken calls below are
// now redundant but harmless, and left in place as a second line of defence.
router.use(verifyToken, blockInactiveChurch);

// by-category is aggregated only and open to every role in the church; the
// full ledger is admin/auditor only. That gate was missing entirely until now
// — any member could pull every expense with requester and approver names
// (businessRequirements §7, §14 item 1). The UI hid the page; the API did not.
router.get('/by-category', verifyToken, getExpensesByCategory);
router.get('/', verifyToken, authorizeRoles(...EXPENSE_READ_ROLES), getAllExpenses);
router.post('/', verifyToken, authorizeRoles(...EXPENSE_WRITE_ROLES), createManualExpense);

export default router;