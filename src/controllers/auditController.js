import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.js";
import { parseDate } from "../utils/validate.js";

// GET /api/audit-log — admin/auditor only (enforced by route). Read-only,
// newest first, with optional filters + pagination.
const getAuditLog = async (req, res, next) => {
  try {
    const { targetModel, action, actorId, startDate, endDate } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const filter = {};
    if (targetModel) filter.targetModel = targetModel;
    if (action) filter.action = action;
    if (actorId && mongoose.Types.ObjectId.isValid(actorId)) filter.actorId = actorId;
    if (startDate && endDate) {
      const start = parseDate(startDate);
      const end = parseDate(endDate);
      if (!start || !end)
        return res.status(400).json({ error: "Invalid startDate or endDate" });
      filter.createdAt = { $gte: start, $lte: end };
    }

    const [data, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      AuditLog.countDocuments(filter),
    ]);

    res.status(200).json({ status: "Success", data, total, page, limit });
  } catch (error) {
    next(error);
  }
};

export { getAuditLog };
