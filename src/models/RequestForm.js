import mongoose from "mongoose";

const requestFormSchema = new mongoose.Schema({
  church: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Church",
    required: true,
  },
  // Unique per church, not globally — each church numbers from RF-0001.
  // See the compound index below.
  rfNo: {
    type: String,
    required: true,
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
// (member-role scoping), sorting by createdAt — all within one church, so
// church leads every index.
requestFormSchema.index({ church: 1, rfNo: 1 }, { unique: true });
requestFormSchema.index({ church: 1, status: 1, createdAt: -1 });
requestFormSchema.index({ church: 1, entryDate: 1 });
requestFormSchema.index({ church: 1, requestedBy: 1 });

export const RequestForm  = mongoose.model(
  "RequestForm",
  requestFormSchema,
);
