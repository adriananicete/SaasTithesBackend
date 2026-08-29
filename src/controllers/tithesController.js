import { Tithes } from "../models/TithesEntry.js";
import { Expense } from "../models/Expense.js";
import { sendNotification, sendNotificationToRoles } from "../utils/sendNotification.js";
import { parseDate } from "../utils/validate.js";
import { recordAudit } from "../utils/recordAudit.js";

// Only DO and admin can approve/reject tithes (auditor is oversight/read-only).
const REVIEWER_ROLES = ["do", "admin"];

// Oversight roles see every per-entry row in the table.
const TITHES_OVERSIGHT_ROLES = ["admin", "auditor", "pastor"];

// Per-role row scoping for the tithes TABLE (the `data` array). Charts/summary
// stay church-wide via the separate anonymized `chartData` payload, so limiting
// rows here never hides church totals from anyone.
//   - oversight (admin/auditor/pastor): all rows
//   - do (the approver): pending queue + rows they reviewed + their own
//   - everyone else (member/validator): their own submissions only
const buildTithesScope = ({ role, id }) => {
  if (TITHES_OVERSIGHT_ROLES.includes(role)) return {};
  if (role === "do")
    return { $or: [{ status: "pending" }, { reviewedBy: id }, { submittedBy: id }] };
  return { submittedBy: id };
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
    const chartData = await Tithes.find(dateFilter)
      .select("entryDate serviceType total status")
      .sort({ entryDate: 1 })
      .lean();

    const tithesTotalBalance = chartData.reduce((acc, item) => acc + (item.total || 0), 0);

    const [approvedAgg, expenseAgg] = await Promise.all([
      Tithes.aggregate([
        { $match: { status: "approved" } },
        { $group: { _id: null, sum: { $sum: "$total" } } },
      ]),
      Expense.aggregate([
        { $group: { _id: null, sum: { $sum: "$amount" } } },
      ]),
    ]);

    const totalApproved = approvedAgg[0]?.sum ?? 0;
    const totalExpenses = expenseAgg[0]?.sum ?? 0;
    const availableBalance = totalApproved - totalExpenses;

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

    if (total <= 0)
      return res.status(400).json({ error: "Tithes must be greater than 0!" });

    const newTithes = new Tithes({
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
      roles: ["do", "admin"],
      message: "A new tithes entry is awaiting approval",
      type: "info",
      refId: newTithes._id,
      refModel: "Tithes",
      excludeUserId: req.user.id,
    });

    res.status(201).json({
      status: "Success",
      message: "New Tithes Created, Pending for approval",
      data: {
        newTithes,
      },
    });
  } catch (error) {
    next(error);
  }
};

const approveTithes = async (req, res, next) => {
  try {
    const { id } = req.params;

    const finderTithes = await Tithes.findById(id);
    if (!finderTithes)
      return res.status(404).json({ error: "Tithes Entry not found!" });

    if (!REVIEWER_ROLES.includes(req.user.role))
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

    const approvedTithes = await Tithes.updateOne(
      { _id: id },
      {
        $set: {
          status: "approved",
          reviewedBy: req.user.id,
          reviewedAt: Date.now(),
        },
      },
    );

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
    const { rejectionNote } = req.body;

    const findTithes = await Tithes.findById(id);
    if (!findTithes)
      return res.status(404).json({ error: "Tithes Entry not Found" });

    if (!REVIEWER_ROLES.includes(req.user.role))
      return res
        .status(403)
        .json({ error: "You do not have permission to review tithes" });

    if (findTithes.status === "approved")
      return res.status(400).json({ error: "Already approved" });

    if (findTithes.status === "rejected")
      return res.status(400).json({ error: "Already rejected" });

    if (!rejectionNote)
      return res.status(404).json({ error: "Need reason for Rejection" });

    const rejectedTithes = await Tithes.updateOne(
      { _id: id },
      {
        $set: {
          status: "rejected",
          reviewedBy: req.user.id,
          reviewedAt: Date.now(),
          rejectionNote: rejectionNote,
        },
      },
      { new: true },
    );

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
    const { body } = req;

    const findyById = await Tithes.findById(id);
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

    const findTithes = await Tithes.findByIdAndUpdate(id, body, {
      new: true,
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
