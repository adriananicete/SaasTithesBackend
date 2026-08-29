import mongoose from "mongoose";

// Append-only audit trail. There is intentionally no update/delete API — rows
// are written once by recordAudit and only ever read. Actor name + target ref
// are SNAPSHOTS taken at write time so the log stays meaningful even if the
// user is renamed or the target document is later deleted.
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorName: { type: String },
    actorRole: { type: String },
    action: { type: String, required: true }, // e.g. "rf.approve", "voucher.cancel"
    targetModel: {
      type: String,
      enum: ["Tithes", "RequestForm", "Voucher", "Expense", "User", "Category"],
      required: true,
    },
    targetId: { type: mongoose.Schema.Types.ObjectId },
    targetRef: { type: String }, // human label: rfNo / pcfNo / email / category name
    summary: { type: String }, // one-line human description
    meta: { type: mongoose.Schema.Types.Mixed }, // optional small extras
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1 });
auditLogSchema.index({ targetModel: 1, targetId: 1 });

export const AuditLog = mongoose.model("AuditLog", auditLogSchema);
