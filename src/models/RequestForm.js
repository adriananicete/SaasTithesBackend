import mongoose from "mongoose";

const requestFormSchema = new mongoose.Schema({
  rfNo: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  entryDate: {
    type: Date,
    required: true,
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
    required: true,
  },
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  estimatedAmount: {
    type: Number,
    required: true,
  },
  remarks: {
    type: String,
  },
  status: {
    type: String,
    enum: [
      "draft",
      "submitted",
      "for_approval",
      "approved",
      "rejected",
      "voucher_created",
      "disbursed",
      "received",
    ],
    default: 'draft'
  },
  attachments: [{type: String}],
  submittedAt: {
    type: Date,
  },
  validatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  validatedAt: {
    type: Date,
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
  },
  approvedAt: {
    type: Date,
  },
  rejectionNote: {
    type: String,
  },
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectedAt: {
    type: Date
  },
  voucherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Voucher'
  },
  voucherCreatedAt: {
    type: Date,
  },
  disbursedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  disbursedAt: {
    type: Date,
  },
  receivedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  receivedAt: {
    type: Date,
  },
}, {timestamps: true});

// getAllRequestForms filters by status, entryDate range, and requestedBy
// (member-role scoping), sorting by createdAt. rfNo is already indexed.
requestFormSchema.index({ status: 1, createdAt: -1 });
requestFormSchema.index({ entryDate: 1 });
requestFormSchema.index({ requestedBy: 1 });

export const RequestForm  = mongoose.model(
  "RequestForm",
  requestFormSchema,
);
