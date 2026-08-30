import mongoose from "mongoose";

// Append-only audit trail. There is intentionally no update/delete API — rows
// are written once by recordAudit and only ever read. Actor name + target ref
// are SNAPSHOTS taken at write time so the log stays meaningful even if the
// user is renamed or the target document is later deleted.
const auditLogSchema = new mongoose.Schema(
  {
    church: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Church",
      required: true,
    },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorName: { type: String },
    actorRole: { type: String },
    action: { type: String, required: true }, // e.g. "rf.approve", "voucher.cancel"
    targetModel: {
      type: String,
      // "Church" added in Branch 13 for the tenant-facing profile and logo
      // endpoints. The frontend's audit table needs a label for it — a paired
      // change, additive so an unhandled value renders as the raw string
      // rather than breaking.
      enum: ["Tithes", "RequestForm", "Voucher", "Expense", "User", "Category", "Church"],
      required: true,
    },
    targetId: { type: mongoose.Schema.Types.ObjectId },
    targetRef: { type: String }, // human label: rfNo / pcfNo / email / category name
    summary: { type: String }, // one-line human description
    meta: { type: mongoose.Schema.Types.Mixed }, // optional small extras
  },
  { timestamps: true },
);

// The log is only ever read for one church, filtered by actor or target and
// paginated newest-first, so church leads every index.
auditLogSchema.index({ church: 1, createdAt: -1 });
auditLogSchema.index({ church: 1, actorId: 1 });
auditLogSchema.index({ church: 1, targetModel: 1, targetId: 1 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
