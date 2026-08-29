import { AuditLog } from "../models/AuditLog.js";
import { User } from "../models/User.js";

// Write one audit row. Fire-and-forget semantics: this NEVER throws — a failed
// audit write must not break the action that triggered it. Callers may await it
// (it resolves even on error).
//
// Actor resolves from req.user ({ id, role }); pass `actor` explicitly for
// public routes (forgot/reset password) where there is no req.user. actorName
// is looked up + snapshotted so the log survives later renames/deletes.
export const recordAudit = async ({
  req,
  actor,
  action,
  targetModel,
  targetId,
  targetRef,
  summary,
  meta,
}) => {
  try {
    let actorId = actor?.id ?? req?.user?.id ?? null;
    let actorRole = actor?.role ?? req?.user?.role ?? null;
    let actorName = actor?.name ?? null;

    if (!actorName && actorId) {
      const u = await User.findById(actorId).select("name role");
      actorName = u?.name ?? null;
      if (!actorRole) actorRole = u?.role ?? null;
    }

    await AuditLog.create({
      actorId,
      actorName,
      actorRole,
      action,
      targetModel,
      targetId,
      targetRef,
      summary,
      meta,
    });
  } catch (err) {
    // Swallow — auditing must never disrupt the primary operation.
    console.error("recordAudit failed:", err?.message);
  }
};
