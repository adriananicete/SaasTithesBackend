import { AuditLog } from "../models/AuditLog.js";
import { User } from "../models/User.js";

// Write one audit row. Fire-and-forget semantics: this NEVER throws — a failed
// audit write must not break the action that triggered it. Callers may await it
// (it resolves even on error).
//
// Actor resolves from req.user ({ id, role, church }); pass `actor` and
// `church` explicitly for public routes (forgot/reset password) where there is
// no req.user. actorName is looked up + snapshotted so the log survives later
// renames/deletes.
export const recordAudit = async ({
  req,
  actor,
  church,
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
    let churchId = church ?? req?.user?.church ?? null;

    if ((!actorName || !churchId) && actorId) {
      const u = await User.findById(actorId).select("name role church");
      actorName = actorName ?? u?.name ?? null;
      if (!actorRole) actorRole = u?.role ?? null;
      churchId = churchId ?? u?.church ?? null;
    }

    // AuditLog.church is required, so a row without one simply cannot be
    // written. Say which action was dropped and why, rather than letting a
    // validation error below read like a database problem. A superadmin acting
    // outside any church is the expected case.
    if (!churchId) {
      console.error(`recordAudit skipped (${action}): no church on the actor`);
      return;
    }

    await AuditLog.create({
      church: churchId,
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
