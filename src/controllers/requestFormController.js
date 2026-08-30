import mongoose from "mongoose";
import { RequestForm } from "../models/RequestForm.js";
import { sendNotification, sendNotificationToRoles } from "../utils/sendNotification.js";
import { parseDate } from "../utils/validate.js";
import { recordAudit } from "../utils/recordAudit.js";
import { byIdInChurch } from "../utils/tenantScope.js";
import { nextNumber } from "../utils/sequence.js";
import { getAvailableBalance, peso } from "../utils/balance.js";
import { destroyCloudinaryAsset } from "../utils/cloudinaryCleanup.js";

// Cloudinary stores the public id in the URL path: everything after
// /upload/<version>/ minus the file extension. Deleting an attachment needs it,
// and the RF only stores the URL.
const rfAttachmentPublicId = (url) => {
  const after = String(url).split("/upload/")[1];
  if (!after) return null;
  return after.replace(/^v\d+\//, "").replace(/\.[^./]+$/, "");
};
import {
  NOTIFY_RF_SUBMITTED,
  NOTIFY_RF_VALIDATED,
  NOTIFY_RF_RECEIVED,
} from "../constants/roles.js";

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

// Per-role row scoping for the RF table, and reused by global search and by
// the RF comment endpoints — so church-scoping it here closes all three.
//   - oversight (admin/auditor/pastor): all rows IN THEIR CHURCH
//   - validator: validation queue (submitted) + rows they validated + own
//   - do: disbursement queue (voucher_created) + rows they disbursed + own
//   - member (and any other role): their own requests only
//
// Every branch carries the church. The oversight case used to return {} — an
// empty filter meaning "everything", which across tenants meant every church's
// request forms. "All rows" has always meant all rows in your own church.
export const buildRfScope = ({ role, id, church }) => {
  if (["admin", "auditor", "pastor"].includes(role)) return { church };
  if (role === "validator")
    return {
      church,
      $or: [{ status: "submitted" }, { validatedBy: id }, { requestedBy: id }],
    };
  if (role === "do")
    return {
      church,
      $or: [{ status: "voucher_created" }, { disbursedBy: id }, { requestedBy: id }],
    };
  return { church, requestedBy: id };
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
    const { entryDate, category, estimatedAmount, remarks } = req.body;

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

    // A request may not exceed the church's cash on hand. This existed only in
    // the UI, so a direct API call could ask for more than the church holds —
    // and the request would travel the whole pipeline before anyone noticed
    // (businessRequirements §14 item 2). Wording matches the client's exactly,
    // so the two never disagree in front of a user.
    //
    // Deliberately NOT applied to updateRequestForm: editing a draft is free by
    // design, and validators catch an over-balance edit at review time (§5.4).
    const available = await getAvailableBalance(req.user.church);
    if (available <= 0)
      return res.status(400).json({
        error:
          "The church has no available tithes balance — no requests can be made right now",
      });
    if (amount > available)
      return res.status(400).json({
        error: `Amount exceeds available tithes balance (${peso(available)})`,
      });

    const newRequestForm = new RequestForm({
      church: req.user.church,
      rfNo: await nextNumber(req.user.church, "rfNo", "RF"),
      entryDate,
      category,
      estimatedAmount: amount,
      requestedBy: req.user.id,
      // Attachments arrive through POST /:id/attachments, never in the body —
      // otherwise any string could be stored and served as an attachment URL.
      attachments: [],
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

// POST /api/request-form/:id/attachments — the requester, while still a draft.
// Same rules as editing the form itself: once it is submitted the supporting
// documents are part of what the validator reviewed.
const addRfAttachments = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "No files uploaded" });

    const requestForm = await RequestForm.findOne(byIdInChurch(id, req));
    if (!requestForm)
      return res.status(404).json({ error: "Request form not found" });

    if (requestForm.requestedBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Invalid User!" });

    if (requestForm.status !== "draft")
      return res.status(400).json({ error: "Status must be draft" });

    const added = req.files.map((file) => file.path);
    if (requestForm.attachments.length + added.length > 5)
      return res.status(400).json({ error: "A request form may hold up to 5 attachments" });

    requestForm.attachments.push(...added);
    await requestForm.save();

    await recordAudit({
      req,
      action: "rf.attach",
      targetModel: "RequestForm",
      targetId: requestForm._id,
      targetRef: requestForm.rfNo,
      summary: `Added ${added.length} attachment(s) to ${requestForm.rfNo}`,
      meta: { count: added.length },
    });

    res.status(200).json({
      status: "Success",
      message: `${added.length} attachment(s) added`,
      data: requestForm,
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/request-form/:id/attachments — body { url }.
const removeRfAttachment = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url required" });

    const requestForm = await RequestForm.findOne(byIdInChurch(id, req));
    if (!requestForm)
      return res.status(404).json({ error: "Request form not found" });

    if (requestForm.requestedBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Invalid User!" });

    if (requestForm.status !== "draft")
      return res.status(400).json({ error: "Status must be draft" });

    if (!requestForm.attachments.includes(url))
      return res.status(404).json({ error: "Attachment not found on this request form" });

    // The stored value is the Cloudinary URL; the public id is the path after
    // /upload/<version>/ without the extension.
    const publicId = rfAttachmentPublicId(url);
    await destroyCloudinaryAsset(publicId, `attachment on ${requestForm.rfNo}`);

    requestForm.attachments = requestForm.attachments.filter((a) => a !== url);
    await requestForm.save();

    await recordAudit({
      req,
      action: "rf.detach",
      targetModel: "RequestForm",
      targetId: requestForm._id,
      targetRef: requestForm.rfNo,
      summary: `Removed an attachment from ${requestForm.rfNo}`,
    });

    res.status(200).json({
      status: "Success",
      message: "Attachment removed",
      data: requestForm,
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

    const requestForm = await RequestForm.findOne(byIdInChurch(id, req));
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
      church: req.user.church,
      roles: NOTIFY_RF_SUBMITTED,
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

    const findRequestFormById = await RequestForm.findOne(byIdInChurch(id, req));
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request Form not found!" });

    if (findRequestFormById.requestedBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Invalid User!" });

    if (findRequestFormById.status !== "draft")
      return res.status(400).json({ error: "Status must be draft" });

    // "attachments" is deliberately absent: they are added and removed through
    // their own endpoints, which upload real files rather than trusting a URL.
    const allowedUpdates = [
      "entryDate",
      "category",
      "estimatedAmount",
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

    const updatedRequestForm = await RequestForm.findOneAndUpdate(
      byIdInChurch(id, req),
      updates,
      {
        returnDocument: "after",
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

    const findRequestFormById = await RequestForm.findOne(byIdInChurch(id, req));
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request form not found!" });

    if (findRequestFormById.requestedBy.toString() !== req.user.id)
      return res.status(403).json({ error: "Forbidden" });

    if (findRequestFormById.status !== "draft")
      return res.status(400).json({ error: "Status must be draft" });

    await RequestForm.findOneAndDelete(byIdInChurch(id, req));

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

    const findRequestFormById = await RequestForm.findOne(byIdInChurch(id, req));
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

    const updatedRequestForm = await RequestForm.findOneAndUpdate(
      byIdInChurch(id, req),
      {
        $set: {
          status: "for_approval",
          validatedBy: req.user.id,
          validatedAt: Date.now(),
        },
      },
      { returnDocument: "after", runValidators: true },
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
      church: req.user.church,
      roles: NOTIFY_RF_VALIDATED,
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

    const findRequestFormById = await RequestForm.findOne(byIdInChurch(id, req));
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

    const approvedRequestForm = await RequestForm.findOneAndUpdate(
      byIdInChurch(id, req),
      {
        $set: {
          status: "approved",
          approvedBy: req.user.id,
          approvedAt: Date.now(),
        },
      },
      { returnDocument: "after", runValidators: true },
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

    const findRequestFormById = await RequestForm.findOne(byIdInChurch(id, req));
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

    const rejectedRequestForm = await RequestForm.findOneAndUpdate(
      byIdInChurch(id, req),
      {
        $set: {
          status: "rejected",
          rejectionNote: rejectionNote,
          rejectedBy: req.user.id,
          rejectedAt: Date.now(),
        },
      },
      { returnDocument: "after", runValidators: true },
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

    const findRequestFormById = await RequestForm.findOne(byIdInChurch(id, req));
    if (!findRequestFormById)
      return res.status(404).json({ error: "Request form not found" });

    if (findRequestFormById.status !== "voucher_created")
      return res
        .status(400)
        .json({
          error: "Voucher must be created before marking as disbursed",
        });

    const disbursedRequestForm = await RequestForm.findOneAndUpdate(
      byIdInChurch(id, req),
      {
        $set: {
          status: "disbursed",
          disbursedBy: req.user.id,
          disbursedAt: Date.now(),
        },
      },
      { returnDocument: "after", runValidators: true },
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

    const findRequestFormById = await RequestForm.findOne(byIdInChurch(id, req));
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

    const receivedForm = await RequestForm.findOneAndUpdate(
      byIdInChurch(id, req),
      {
        $set: {
          status: "received",
          receivedBy: req.user.id,
          receivedAt: Date.now(),
        },
      },
      { returnDocument: "after", runValidators: true },
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
      church: req.user.church,
      roles: NOTIFY_RF_RECEIVED,
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
  addRfAttachments,
  removeRfAttachment,
  submitRequestForm,
  updateRequestForm,
  deleteRequestForm,
  validateRequestForm,
  approveRequestForm,
  rejectRequestForm,
  disburseRequestForm,
  receivedRequestForm,
};
