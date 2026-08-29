import express from 'express';
import { verifyToken } from '../middlewares/authMiddleware.js';
import { uploadReceipts, handleUploadError } from '../middlewares/uploadMiddleware.js';
import { createVoucher, getAllVouchers, cancelVoucher } from '../controllers/voucherController.js';

const router = express.Router();

router.get('/', verifyToken, getAllVouchers);
router.post(
    '/',
    verifyToken,
    uploadReceipts.array('receipts', 5),
    handleUploadError,
    createVoucher
);
router.patch('/:id/cancel', verifyToken, cancelVoucher);

export default router;

