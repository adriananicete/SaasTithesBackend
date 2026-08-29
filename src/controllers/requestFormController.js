import mongoose from "mongoose";
import { RequestForm } from "../models/RequestForm.js";
import { sendNotification, sendNotificationToRoles } from "../utils/sendNotification.js";
import { parseDate } from "../utils/validate.js";
import { recordAudit } from "../utils/recordAudit.js";

const RF_POPULATE = [
  { path: "requestedBy", select: "name role avatarUrl" },
  { path: "category", select: "name type" },
  { path: "validatedBy", select: "name role avatarUrl" },
  { path: "approvedBy", select: "name role avatarUrl" },
  { path: "rejectedBy", select: "name role avatarUrl" },
  { path: "disbursedBy", select: "name role avatarUrl" },
  { path: "receivedBy", select: "name role avatarUrl" },
  { path: "voucherId", select: "pcfNo amount" },
];

// Per-role row scoping for the RF table (and reused by global search):
//   - oversight (admin/auditor/pastor): all rows
//   - validator: validation queue (submitted) + rows they validated + own
//   - do: disbursement queue (voucher_created) + rows they disbursed + own
//   - member (and any other role): their own requests only
export const buildRfScope = ({ role, id }) => {
  if (["admin", "auditor", "pastor"].includes(role)) return {};
  if (role === "validator")
    return { $or: [{ status: "submitted" }, { validatedBy: id }, { requestedBy: id }] };
  if (role === "do")
    return { $or: [{ status: "voucher_created" }, { disbursedBy: id }, { requestedBy: id }] };
  return { requestedBy: id };
};

const generateRFNo = async () => {
  const lastRF = await RequestForm.findOne().sort({ createdAt: -1 });
  let newNumber = 1;

  if (lastRF && lastRF.rfNo) {
    const lastNum = parseInt(lastRF.rfNo.split("-")[1], 10);
    if (!isNaN(lastNum)) newNumber = lastNum + 1;
  }

  return `RF-${String(newNumber).padStart(4, "0")}`;
};

const getAllRequestForms = async (req, res, next) => {
  try {
    const { startDate, endDate, status, rfNo } = req.query;
    const filter = {};

    if (startDate && endDate) {
      const start = parseDate(startDate);
      const end = parseDate(endDate);
      if (!start || !end)
        return res.status(400).json({ error: "Invalid startDate or endDate" });
      filter.entryDate = { $gte: start, $lte: end };
    }

    if(status) filter.status = status;
    if(rfNo) filter.rfNo = rfNo;

    // Apply per-role row scoping (shared with global search).
    Object.assign(filter, buildRfScope(req.user));

    const requestForms = await RequestForm.find(filter)
      .sort({ createdAt: -1 })
      .populate(RF_POPULATE);

    res.status(200).json({
      status: "Success",
      count: requestForms.length,
      data: requestForms,
    });
  } catch (error) {
    next(error);
  }
};

const createRequestForm = async (req, res, next) => {
  try {
    const { entryDate, category, estimatedAmount, attachments, remarks } = req.body;

    if (!entryDate)
      return res.status(400).json({ error: "Entry Date required!" });
    if (!category) return res.status(400).json({ error: "Category required!" });
    if (!estimatedAmount)
      return res.status(400).json({ error: "Estimated Amount required!" });
    // Remarks/particulars flow to the voucher and become the expense detail in
    // financial reports, so they are required from creation.
    if (!remarks || !String(remarks).trim())
      return res.status(400).json({ error: "Remarks / particulars required!" });

    const amount = Number(estimatedAmount);
    if (isNaN(amount))
      return res
        .status(400)
        .json({ error: "Estimated Amount must be a number" });
    if (amount <= 0)
      return res
        .status(400)
        .json({ error: "Estimated Amount must be greater than 0" });

    const newRequestForm = new RequestForm({
      rfNo: await generateRFNo(),
      entryDate,
      category,
      estimatedAmount: amount,
      requestedBy: req.user.id,
      attachments: attachments || [],
      remarks: String(remarks).trim(),
    });

    await newRequestForm.save();

    await recordAudit({
      req,
      action: "rf.create",
      targetModel: "RequestForm",
      targetId: newRequestForm._id,
      targetRef: newRequestForm.rfNo,
      summary: `Created ${newRequestForm.rfNo} (₱${newRequestForm.estimatedAmount})`,
    });

    res.status(201).json({
      status: "Success",
      message: "Request Form Created",
      data: newRequestForm,
    });
  } catch (error) {
    next(error);
  }
};

const submitRequestForm = async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const requestForm = await RequestForm.findById(id);
    if (!requestForm)
      return res.status(404).json({ error: "Request form not found" });

    if (requestForm.requestedBy.toString() !== req.user.id)
      return res.status(403).json({ error: "You cannot submit this request" });

    if (requestForm.status !== "draft")
      return res
        .status(400)
        .json({ error: "Only draft requests can be submitted" });

    // Safety net: never let an RF without particulars enter the voucher
    // pipeline (the expense detail in reports depends on this remark).
    if (!requestForm.remarks || !requestForm.remarks.trim())
      return res
        .status(400)
        .json({ error: "Add remarks / particulars before submitting" });

    requestForm.status = "submitted";
    requestForm.submittedAt = Date.now();
    await requestForm.save();

    await recordAudit({
      req,
      action: "rf.submit",
      targetModel: "RequestForm",
      targetId: requestForm._id,
      targetRef: requestForm.rfNo,
      summary: `Submitted ${requestForm.rfNo} for validation`,
    });

    await sendNotificationToRoles({
      roles: ["validator", "auditor", "admin"],
      message: `Request Form ${requestForm.rfNo} is awaiting validation`,
      type: "info",
      refId: requestForm._id,
      refModel: "RequestForm",
      excludeUserId: req.user.id,
    });

    res.status(200).json({
      status: "Success",
      message: "Request Form Submitted",
      data: requestForm,
    });
  } catch (error) {
    next(error);
  }
};

const updateRequestForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });
    const { body } = req;

    const findRequestFormById = await RequestForm.findById(id);
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request Form not found!" });

    if (findRequestFormById.requestedBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Invalid User!" });

    if (findRequestFormById.status !== "draft")
      return res.status(400).json({ error: "Status must be draft" });

    const allowedUpdates = [
      "entryDate",
      "category",
      "estimatedAmount",
      "attachments",
      "remarks",
    ];
    const updates = {};
    allowedUpdates.forEach((field) => {
      if (body[field] !== undefined) updates[field] = body[field];
    });

    if (updates.estimatedAmount !== undefined) {
      const amount = Number(updates.estimatedAmount);
      if (isNaN(amount) || amount <= 0)
        return res
          .status(400)
          .json({ error: "Estimated Amount must be a positive number" });
      updates.estimatedAmount = amount;
    }

    // Don't let an edit blank out the required particulars.
    if (updates.remarks !== undefined) {
      if (!String(updates.remarks).trim())
        return res
          .status(400)
          .json({ error: "Remarks / particulars cannot be empty" });
      updates.remarks = String(updates.remarks).trim();
    }

    const updatedRequestForm = await RequestForm.findByIdAndUpdate(
      id,
      updates,
      {
        new: true,
        runValidators: true,
      },
    );

    await recordAudit({
      req,
      action: "rf.update",
      targetModel: "RequestForm",
      targetId: updatedRequestForm._id,
      targetRef: updatedRequestForm.rfNo,
      summary: `Updated ${updatedRequestForm.rfNo} (draft)`,
    });

    res.status(200).json({
      status: "Success",
      message: "Updated Successfully",
      data: updatedRequestForm,
    });
  } catch (error) {
    next(error);
  }
};

const deleteRequestForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const findRequestFormById = await RequestForm.findById(id);
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request form not found!" });

    if (findRequestFormById.requestedBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    if (findRequestFormById.status !== "draft")
      return res.status(400).json({ error: "Status must be draft" });

    await RequestForm.findByIdAndDelete(id);

    await recordAudit({
      req,
      action: "rf.delete",
      targetModel: "RequestForm",
      targetId: findRequestFormById._id,
      targetRef: findRequestFormById.rfNo,
      summary: `Deleted ${findRequestFormById.rfNo} (draft)`,
    });

    res.status(200).json({
      status: "Success",
      message: "Request Form deleted successfully",
    });
  } catch (error) {
    next(error);
  }
};

const validateRequestForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const findRequestFormById = await RequestForm.findById(id);
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request Form not found" });

    if (findRequestFormById.status !== "submitted")
      return res.status(400).json({ error: "Request Form must be submitted" });

    if (!["validator", "auditor", "admin"].includes(req.user.role))
      return res
        .status(403)
        .json({ error: "No permission to validate this request form" });

    // The requester cannot validate their own request — conflict of interest.
    if (findRequestFormById.requestedBy.toString() === req.user.id)
      return res
        .status(403)
        .json({ error: "You cannot validate your own request form" });

    const updatedRequestForm = await RequestForm.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "for_approval",
          validatedBy: req.user.id,
          validatedAt: Date.now(),
        },
      },
      { new: true, runValidators: true },
    ).populate(RF_POPULATE);

    await recordAudit({
      req,
      action: "rf.validate",
      targetModel: "RequestForm",
      targetId: updatedRequestForm._id,
      targetRef: updatedRequestForm.rfNo,
      summary: `Validated ${updatedRequestForm.rfNo}`,
    });

    await sendNotification({
      userId: updatedRequestForm.requestedBy._id,
      message: "Your request entry has been validated",
      type: "info",
      refId: updatedRequestForm._id,
      refModel: "RequestForm",
    });

    await sendNotificationToRoles({
      roles: ["pastor", "auditor", "admin"],
      message: `Request Form ${updatedRequestForm.rfNo} is awaiting approval`,
      type: "info",
      refId: updatedRequestForm._id,
      refModel: "RequestForm",
      excludeUserId: req.user.id,
    });

    res.status(200).json({
      status: "Success",
      message: "Request Form validated",
      data: updatedRequestForm,
    });
  } catch (error) {
    next(error);
  }
};

const approveRequestForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const findRequestFormById = await RequestForm.findById(id);
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request Form not found" });

    if (!["admin", "auditor", "pastor"].includes(req.user.role))
      return res.status(403).json({ error: "You cannot approve this request" });

    // The requester cannot approve their own request — conflict of interest.
    if (findRequestFormById.requestedBy.toString() === req.user.id)
      return res
        .status(403)
        .json({ error: "You cannot approve your own request form" });

    if (findRequestFormById.status !== "for_approval")
      return res
        .status(400)
        .json({ error: "This request form is not yet validated" });

    const approvedRequestForm = await RequestForm.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "approved",
          approvedBy: req.user.id,
          approvedAt: Date.now(),
        },
      },
      { new: true, runValidators: true },
    ).populate(RF_POPULATE);

    await recordAudit({
      req,
      action: "rf.approve",
      targetModel: "RequestForm",
      targetId: approvedRequestForm._id,
      targetRef: approvedRequestForm.rfNo,
      summary: `Approved ${approvedRequestForm.rfNo}`,
    });

    await sendNotification({
      userId: approvedRequestForm.requestedBy._id,
      message: "Your request entry has been approved",
      type: "approval",
      refId: approvedRequestForm._id,
      refModel: "RequestForm",
    });

    if (approvedRequestForm.validatedBy) {
      await sendNotification({
        userId: approvedRequestForm.validatedBy._id,
        message: `Request Form ${approvedRequestForm.rfNo} has been approved`,
        type: "info",
        refId: approvedRequestForm._id,
        refModel: "RequestForm",
      });
    }

    res.status(200).json({
      status: "Success",
      message: "Request Form approved",
      data: approvedRequestForm,
    });
  } catch (error) {
    next(error);
  }
};

const rejectRequestForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const findRequestFormById = await RequestForm.findById(id);
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request form not found" });

    if (!["admin", "validator", "auditor", "pastor"].includes(req.user.role))
      return res.status(403).json({ error: "Forbidden" });

    // The requester cannot reject their own request — conflict of interest.
    if (findRequestFormById.requestedBy.toString() === req.user.id)
      return res
        .status(403)
        .json({ error: "You cannot reject your own request form" });

    if (!["submitted", "for_approval"].includes(findRequestFormById.status))
      return res.status(400).json({ error: "Cannot reject this status" });

    const { rejectionNote } = req.body;
    if (!rejectionNote)
      return res.status(400).json({ error: "Reason for Rejection" });

    const rejectedRequestForm = await RequestForm.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "rejected",
          rejectionNote: rejectionNote,
          rejectedBy: req.user.id,
          rejectedAt: Date.now(),
        },
      },
      { new: true, runValidators: true },
    ).populate(RF_POPULATE);

    await recordAudit({
      req,
      action: "rf.reject",
      targetModel: "RequestForm",
      targetId: rejectedRequestForm._id,
      targetRef: rejectedRequestForm.rfNo,
      summary: `Rejected ${rejectedRequestForm.rfNo}`,
      meta: { rejectionNote },
    });

    await sendNotification({
      userId: rejectedRequestForm.requestedBy._id,
      message: "Your request entry has been rejected",
      type: "rejection",
      refId: rejectedRequestForm._id,
      refModel: "RequestForm",
    });

    res.status(200).json({
      status: "Success",
      message: `Request Form rejected`,
      data: rejectedRequestForm,
    });
  } catch (error) {
    next(error);
  }
};

const disburseRequestForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Bad Request" });

    if (!["admin", "do"].includes(req.user.role))
      return res
        .status(403)
        .json({ error: "Only admin or DO can mark as disbursed" });

    const findRequestFormById = await RequestForm.findById(id);
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request form not found" });

    if (findRequestFormById.status !== "voucher_created")
      return res
        .status(400)
        .json({
          error: "Voucher must be created before marking as disbursed",
        });

    const disbursedRequestForm = await RequestForm.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "disbursed",
          disbursedBy: req.user.id,
          disbursedAt: Date.now(),
        },
      },
      { new: true, runValidators: true },
    ).populate(RF_POPULATE);

    await recordAudit({
      req,
      action: "rf.disburse",
      targetModel: "RequestForm",
      targetId: disbursedRequestForm._id,
      targetRef: disbursedRequestForm.rfNo,
      summary: `Marked ${disbursedRequestForm.rfNo} as disbursed`,
    });

    await sendNotification({
      userId: disbursedRequestForm.requestedBy._id,
      message: `Your request ${disbursedRequestForm.rfNo} has been disbursed. Please confirm receipt.`,
      type: "info",
      refId: disbursedRequestForm._id,
      refModel: "RequestForm",
    });

    res.status(200).json({
      status: "Success",
      message: `${disbursedRequestForm.rfNo} marked as disbursed`,
      data: disbursedRequestForm,
    });
  } catch (error) {
    next(error);
  }
};

const receivedRequestForm = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Bad Request" });

    const findRequestFormById = await RequestForm.findById(id);
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request form not found" });

    if (findRequestFormById.requestedBy.toString() !== req.user.id)
      return res
        .status(403)
        .json({ error: "Only the requestor can confirm receipt" });

    if (findRequestFormById.status !== "disbursed")
      return res
        .status(400)
        .json({
          error: "Request form must be disbursed before confirming receipt",
        });

    const receivedForm = await RequestForm.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "received",
          receivedBy: req.user.id,
          receivedAt: Date.now(),
        },
      },
      { new: true, runValidators: true },
    ).populate(RF_POPULATE);

    await recordAudit({
      req,
      action: "rf.receive",
      targetModel: "RequestForm",
      targetId: receivedForm._id,
      targetRef: receivedForm.rfNo,
      summary: `Confirmed receipt of ${receivedForm.rfNo}`,
    });

    await sendNotificationToRoles({
      roles: ["admin", "auditor"],
      message: `Request ${receivedForm.rfNo} received by ${receivedForm.requestedBy.name}. Closed.`,
      type: "info",
      refId: receivedForm._id,
      refModel: "RequestForm",
      excludeUserId: req.user.id,
    });

    res.status(200).json({
      status: "Success",
      message: `${receivedForm.rfNo} received successfully`,
      data: receivedForm,
    });
  } catch (error) {
    next(error);
  }
};

export {
  getAllRequestForms,
  createRequestForm,
  submitRequestForm,
  updateRequestForm,
  deleteRequestForm,
  validateRequestForm,
  approveRequestForm,
  rejectRequestForm,
  disburseRequestForm,
  receivedRequestForm,
};
