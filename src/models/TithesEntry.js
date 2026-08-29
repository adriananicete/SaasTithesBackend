import mongoose from "mongoose";

const tithesSchema = new mongoose.Schema(
  {
    entryDate: {
      type: Date,
      required: true,
    },
    serviceType: {
      type: String,
      enum: ["Sunday Service", "Special Service", "Anniversay Service"],
      required: true,
    },
    denominations: [
      {
        bill: Number,
        qty: Number,
        subtotal: Number,
      },
    ],
    total: {
      type: Number,
      required: true,
    },
    remarks: {
      type: String,
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: 'pending',
      required: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedAt: {
      type: Date,
    },
    rejectionNote: {
      type: String,
    },
  },
  { timestamps: true },
);

// getAllTithes filters by status + entryDate range and sorts by createdAt;
// its balance aggregation does $match { status: "approved" } (the status
// prefix of the compound index covers that). Reports filter entryDate.
tithesSchema.index({ status: 1, createdAt: -1 });
tithesSchema.index({ entryDate: 1 });

export const Tithes = mongoose.model("Tithes", tithesSchema);
