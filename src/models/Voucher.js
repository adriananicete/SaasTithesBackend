import mongoose from "mongoose";

const voucherSchema = new mongoose.Schema({
    church: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Church',
        required: true,
    },
    // Unique per church, not globally — each church numbers from PCF-0001.
    // See the compound index below.
    pcfNo: {
        type: String,
        required: true,
    },
    rfId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'RequestForm',
        required: true,
    },
    date: Date,
    category: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category',
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    receipts: [{type: String}],
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    status: {
        type: String,
        enum: ['approved', 'cancelled'],
        default: 'approved'
    },
    cancelledBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    cancelledAt: {
        type: Date,
    },
    cancellationNote: {
        type: String,
    }
}, {timestamps: true})

// getAllVouchers lists one church's vouchers newest-first.
voucherSchema.index({ church: 1, pcfNo: 1 }, { unique: true });
voucherSchema.index({ church: 1, createdAt: -1 });

export const Voucher = mongoose.model('Voucher', voucherSchema);