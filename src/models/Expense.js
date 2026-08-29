import mongoose from "mongoose";

const expenseSchema = new mongoose.Schema({
    source: {
        type: String,
        enum: ['voucher','manual'],
        required: true,
    },
    linkedId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Voucher',
    },
    amount: {
        type: Number,
        required: true
    },
    category: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category',
        required: true
    },
    date: {
        type: Date,
        required: true,
    },
    recordedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    remarks: {
        type: String,
    }
}, {timestamps: true})

// getExpensesByCategory matches `date` (last 6 months) then groups by
// `category`; the report endpoints filter `date` range.
expenseSchema.index({ date: 1 });
expenseSchema.index({ category: 1 });

export const Expense = mongoose.model('Expense', expenseSchema);