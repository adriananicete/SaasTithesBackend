import { Tithes } from "../models/TithesEntry.js";
import { sendNotification, sendNotificationToRoles } from "../utils/sendNotification.js";
import { parseDate } from "../utils/validate.js";
import mongoose from "mongoose";
import { recordAudit } from "../utils/recordAudit.js";
import { withChurch, byIdInChurch } from "../utils/tenantScope.js";
import { getAvailableBalance } from "../utils/balance.js";
import { NOTIFY_TITHES_SUBMITTED, TITHES_REVIEWER_ROLES } from "../constants/roles.js";

// Read off the schema rather than restated, so the two can never drift.
const SERVICE_TYPES = Tithes.schema.path("serviceType").enumValues;

// Only DO and admin can approve/reject tithes (auditor is oversight/read-only).
// The route middleware enforces the same list, from the same constant.

// Oversight roles see every per-entry row in the table.
const TITHES_OVERSIGHT_ROLES = ["admin", "auditor", "pastor"];

// Per-role row scoping for the tithes TABLE (the `data` array). Charts/summary
// stay church-wide via the separate anonymized `chartData` payload, so limiting
// rows here never hides church totals from anyone.
//   - oversight (admin/auditor/pastor): all rows IN THEIR CHURCH
//   - do (the approver): pending queue + rows they reviewed + their own
//   - everyone else (member/validator): their own submissions only
//
// Every branch carries the church. The oversight case used to return {} — an
// empty filter meaning "everything", which across tenants meant every church's
// tithes. "All rows" has always meant all rows in your own church.
const buildTithesScope = ({ role, id, church }) => {
  if (TITHES_OVERSIGHT_ROLES.includes(role)) return { church };
  if (role === "do")
    return {
      church,
      $or: [{ status: "pending" }, { reviewedBy: id }, { submittedBy: id }],
    };
  return { church, submittedBy: id };
};

const getAllTithes = async (req, res, next) => {
  try {

    const { startDate, endDate } = req.query;
    const dateFilter = {};

    if (startDate && endDate) {
      const start = parseDate(startDate);
      const end = parseDate(endDate);
      if (!start || !end)
        return res.status(400).json({ error: "Invalid startDate or endDate" });
      dateFilter.entryDate = { $gte: start, $lte: end };
    }

    // Table rows — scoped to what this role may see per-entry.
    const scope = buildTithesScope(req.user);
    const data = await Tithes.find({ ...dateFilter, ...scope })
      .sort({ createdAt: -1 })
      .populate("submittedBy", "name role avatarUrl")
      .populate("reviewedBy", "name role avatarUrl");

    // Charts/summary — church-wide but anonymized (no submitter identity, no
    // denominations). Carries no PII, so it is safe to return to every role and
    // lets members still see the church's total collections/trend.
    const chartData = await Tithes.find(withChurch(dateFilter, req))
      .select("entryDate serviceType total status")
      .sort({ entryDate: 1 })
      .lean();

    const tithesTotalBalance = chartData.reduce((acc, item) => acc + (item.total || 0), 0);

    // availableBalance gates how much a church may request, and since the RF
    // create handler enforces that cap it has to be the SAME number here — so
    // both read one definition in utils/balance.js rather than each keeping
    // their own aggregation to drift apart.
    const availableBalance = await getAvailableBalance(req.user.church);

    res.status(200).json({
      status: "Success",
      totalBalance: tithesTotalBalance,
      availableBalance,
      count: data.length,
      data,
      chartData,
    });
  } catch (error) {
    next(error);
  }
};

const submitTithes = async (req, res, next) => {
  try {
    const {
      body: { entryDate, serviceType, denominations, total },
    } = req;

    if (!entryDate || !serviceType || !denominations || !total)
      return res.status(400).json({ error: "All fields are required!" });

    // Without this the value falls through to Mongoose, whose ValidationError
    // reaches the error handler as a 500 — a client mistake reported as a
    // server fault. It matters more since the "Anniversay" typo was corrected
    // (§14 item 6): a client still sending the old spelling is now wrong, and
    // deserves to be told which values are valid rather than a 500.
    if (!SERVICE_TYPES.includes(serviceType))
      return res.status(400).json({
        error: `serviceType must be one of: ${SERVICE_TYPES.join(", ")}`,
      });

    if (total <= 0)
      return res.status(400).json({ error: "Tithes must be greater than 0!" });

    const newTithes = new Tithes({
      church: req.user.church,
      entryDate,
      serviceType,
      denominations,
      total,
      submittedBy: req.user.id,
    });
    await newTithes.save();

    await recordAudit({
      req,
      action: "tithes.submit",
      targetModel: "Tithes",
      targetId: newTithes._id,
      targetRef: serviceType,
      summary: `Submitted tithes ₱${total} (${serviceType})`,
      meta: { total, serviceType },
    });

    await sendNotificationToRoles({
      church: req.user.church,
      roles: NOTIFY_TITHES_SUBMITTED,
      message: "A new tithes entry is awaiting approval",
      type: "info",
      refId: newTithes._id,
      refModel: "Tithes",
      excludeUserId: req.user.id,
    });

    // `data` is the document, like every other create in this codebase. It used
    // to be `data: { newTithes }` — one level deeper than anywhere else, which
    // nothing about a tithes entry justified (businessRequirements §14 item 10).
    res.status(201).json({
      status: "Success",
      message: "New Tithes Created, Pending for approval",
      data: newTithes,
    });
  } catch (error) {
    next(error);
  }
};

const approveTithes = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const finderTithes = await Tithes.findOne(byIdInChurch(id, req));
    if (!finderTithes)
      return res.status(404).json({ error: "Tithes Entry not found!" });

    if (!TITHES_REVIEWER_ROLES.includes(req.user.role))
      return res
        .status(403)
        .json({ error: "You do not have permission to review tithes" });

    if (finderTithes.submittedBy.toString() === req.user.id)
      return res
        .status(400)
        .json({ error: "Cannot approve your own tithes entry!" });

    if (finderTithes.status === "approved")
      return res.status(400).json({ error: "Already Approved" });

    if (finderTithes.status === "rejected")
      return res.status(400).json({ error: "Already Rejected" });

    await Tithes.updateOne(byIdInChurch(id, req), {
      $set: {
        status: "approved",
        reviewedBy: req.user.id,
        reviewedAt: Date.now(),
      },
    });

    await recordAudit({
      req,
      action: "tithes.approve",
      targetModel: "Tithes",
      targetId: finderTithes._id,
      targetRef: finderTithes.serviceType,
      summary: `Approved tithes ₱${finderTithes.total} (${finderTithes.serviceType})`,
    });

    await sendNotification({
      userId: finderTithes.submittedBy,
      message: "Your tithes entry has been approved",
      type: "approval",
      refId: finderTithes._id,
      refModel: "Tithes",
    });

    res.status(200).json({
      status: "Success",
      message: "Tithes Entry Approved!",
    });
  } catch (error) {
    next(error);
  }
};

const rejectTithes = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });
    const { rejectionNote } = req.body;

    const findTithes = await Tithes.findOne(byIdInChurch(id, req));
    if (!findTithes)
      return res.status(404).json({ error: "Tithes Entry not Found" });

    if (!TITHES_REVIEWER_ROLES.includes(req.user.role))
      return res
        .status(403)
        .json({ error: "You do not have permission to review tithes" });

    if (findTithes.status === "approved")
      return res.status(400).json({ error: "Already approved" });

    if (findTithes.status === "rejected")
      return res.status(400).json({ error: "Already rejected" });

    if (!rejectionNote)
      return res.status(404).json({ error: "Need reason for Rejection" });

    // updateOne returns a write result, not the document — there is nothing to
    // read back and no `new`/`returnDocument` option that would apply.
    await Tithes.updateOne(byIdInChurch(id, req), {
      $set: {
        status: "rejected",
        reviewedBy: req.user.id,
        reviewedAt: Date.now(),
        rejectionNote: rejectionNote,
      },
    });

    await recordAudit({
      req,
      action: "tithes.reject",
      targetModel: "Tithes",
      targetId: findTithes._id,
      targetRef: findTithes.serviceType,
      summary: `Rejected tithes ₱${findTithes.total} (${findTithes.serviceType})`,
      meta: { rejectionNote },
    });

    await sendNotification({
      userId: findTithes.submittedBy,
      message: "Your tithes entry has been rejected",
      type: "rejection",
      refId: findTithes._id,
      refModel: "Tithes",
    });

    res.status(200).json({
      status: "Success",
      message: "Tithes Entry Rejected",
    });
  } catch (error) {
    next(error);
  }
};

const updateTithes = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });
    const { body } = req;

    // Same reason as submitTithes: an edit carrying a bad serviceType would
    // otherwise 500 out of runValidators below.
    if (body?.serviceType !== undefined && !SERVICE_TYPES.includes(body.serviceType))
      return res.status(400).json({
        error: `serviceType must be one of: ${SERVICE_TYPES.join(", ")}`,
      });

    const findyById = await Tithes.findOne(byIdInChurch(id, req));
    if (!findyById)
      return res.status(404).json({ error: "Tithes entry not found" });

    if (findyById.submittedBy.toString() !== req.user.id)
      return res
        .status(404)
        .json({ error: "The one who submit this can only update this entry" });

    if (findyById.status !== "pending")
      return res
        .status(400)
        .json({ error: "Cannot edit approved/rejected entry" });

    const findTithes = await Tithes.findOneAndUpdate(byIdInChurch(id, req), body, {
      returnDocument: "after",
      runValidators: true,
    });

    await recordAudit({
      req,
      action: "tithes.update",
      targetModel: "Tithes",
      targetId: findyById._id,
      targetRef: findyById.serviceType,
      summary: `Updated tithes entry (${findyById.serviceType})`,
    });

    res.status(200).json({
      status: "Success",
      message: "Tithes Entry Updated",
    });
  } catch (error) {
    next(error);
  }
};

export {
  submitTithes,
  getAllTithes,
  approveTithes,
  rejectTithes,
  updateTithes,
};
