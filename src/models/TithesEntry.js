import mongoose from "mongoose";

const tithesSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Church",
      required: true,
    },
    entryDate: {
      type: Date,
      required: true,
    },
    serviceType: {
      type: String,
      // "Anniversay" was a typo carried in the schema, and therefore in the
      // data, since the original single-church build. Corrected here because
      // this database has no rows to strand — both clusters are empty and no
      // church is onboarded. Any database that DOES hold the old spelling must
      // be run through scripts/migrateServiceTypeSpelling.js first, or those
      // rows fail validation on their next save.
      enum: ["Sunday Service", "Special Service", "Anniversary Service"],
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
// its balance aggregation does $match { church, status: "approved" } (the
// church+status prefix covers that). Reports filter entryDate. Every one of
// these is scoped to a single church, so church leads.
tithesSchema.index({ church: 1, status: 1, createdAt: -1 });
tithesSchema.index({ church: 1, entryDate: 1 });

export const Tithes = mongoose.model("Tithes", tithesSchema);
