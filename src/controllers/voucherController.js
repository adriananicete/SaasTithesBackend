import mongoose from "mongoose";
import { RequestForm } from "../models/RequestForm.js";
import { Voucher } from "../models/Voucher.js";
import { Expense } from "../models/Expense.js";
import { autoRecordExpense } from "../utils/autoRecordExpense.js";
import { sendNotification, sendNotificationToRoles } from "../utils/sendNotification.js";
import { recordAudit } from "../utils/recordAudit.js";

const getAllVouchers = async (req, res, next) => {
  try {
    if (!["validator", "do", "auditor", "admin"].includes(req.user.role))
      return res.status(403).json({ error: "Access Denied" });

    const getAllVoucher = await Voucher.find()
      .sort({ createdAt: -1 })
      .populate({
        path: "rfId",
        select: "rfNo estimatedAmount status remarks requestedBy",
        populate: { path: "requestedBy", select: "name avatarUrl" },
      })
      .populate("category", "name type")
      .populate("createdBy", "name role avatarUrl");

    res.status(200).json({
      status: "Success",
      count: getAllVoucher.length,
      data: getAllVoucher,
    });
  } catch (error) {
    next(error);
  }
};

const createVoucher = async (req, res, next) => {
  try {
    if (!["validator", "admin"].includes(req.user.role))
      return res.status(403).json({ error: "Unauthorized" });

    const { rfId, category, amount, remarks } = req.body;

    if (!rfId || !category || !amount)
      return res.status(400).json({ error: "All fields required" });
    if (!mongoose.Types.ObjectId.isValid(category))
      return res.status(400).json({ error: "Category not match" });
    if (!mongoose.Types.ObjectId.isValid(rfId))
      return res.status(400).json({ error: "Request Form not match" });

    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0)
      return res.status(400).json({ error: "Amount must greater than zero" });

    const findRequestFormbyId = await RequestForm.findById(rfId);
    if (!findRequestFormbyId)
      return res.status(404).json({ error: "Request form not found" });

    if (findRequestFormbyId.status !== "approved")
      return res.status(400).json({ error: "Request form must be approved" });
    if (findRequestFormbyId.voucherId)
      return res.status(400).json({ error: "Voucher already created" });

    if (!req.files || req.files.length === 0)
      return res.status(400).json({ error: "At least one receipt is required" });

    const receiptUrls = req.files.map((file) => file.path);

    const rfUpdates = {};
    if (category !== findRequestFormbyId.category.toString())
      rfUpdates.category = category;
    if (remarks !== undefined && remarks !== findRequestFormbyId.remarks)
      rfUpdates.remarks = remarks;

    const generatePCFNo = async () => {
      const lastPCF = await Voucher.findOne().sort({ createdAt: -1 });
      let newNumber = 1;

      if (lastPCF && lastPCF.pcfNo) {
        const lastNum = parseInt(lastPCF.pcfNo.split("-")[1], 10);
        if (!isNaN(lastNum)) newNumber = lastNum + 1;
      }

      return `PCF-${String(newNumber).padStart(4, "0")}`;
    };

    const newVoucher = new Voucher({
      pcfNo: await generatePCFNo(),
      rfId: rfId,
      date: Date.now(),
      category: category,
      amount: amountNum,
      createdBy: req.user.id,
      receipts: receiptUrls,
    });
    await newVoucher.save();

    await autoRecordExpense(newVoucher);

    const vouch = await RequestForm.findByIdAndUpdate(
      rfId,
      {
        $set: {
          ...rfUpdates,
          voucherId: newVoucher._id,
          status: "voucher_created",
          voucherCreatedAt: Date.now(),
        },
      },
      { new: true, runValidators: true }
    );

    await recordAudit({
      req,
      action: "voucher.create",
      targetModel: "Voucher",
      targetId: newVoucher._id,
      targetRef: newVoucher.pcfNo,
      summary: `Created voucher ${newVoucher.pcfNo} for ${vouch.rfNo} (₱${amountNum})`,
      meta: { rfNo: vouch.rfNo, amount: amountNum },
    });

    await sendNotification({
      userId: vouch.requestedBy,
      message: `Voucher ${newVoucher.pcfNo} has been created for your request ${vouch.rfNo}`,
      type: "info",
      refId: vouch._id,
      refModel: "Voucher",
    });

    await sendNotificationToRoles({
      roles: ["do", "auditor", "admin"],
      message: `Voucher ${newVoucher.pcfNo} created for ${vouch.rfNo}`,
      type: "info",
      refId: newVoucher._id,
      refModel: "Voucher",
      excludeUserId: req.user.id,
    });

    res.status(200).json({
      status: "Success",
      message: `Voucher ${newVoucher.pcfNo} created`,
      data: newVoucher,
    });
  } catch (error) {
    next(error);
  }
};

const cancelVoucher = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    if (!["validator", "admin"].includes(req.user.role))
      return res.status(403).json({ error: "Unauthorized" });

    const voucher = await Voucher.findById(id);
    if (!voucher)
      return res.status(404).json({ error: "Voucher not found" });

    // Validators may only cancel vouchers they created; admin can cancel any.
    if (
      req.user.role === "validator" &&
      voucher.createdBy?.toString() !== req.user.id
    )
      return res
        .status(403)
        .json({ error: "You can only cancel vouchers you created" });

    if (voucher.status === "cancelled")
      return res.status(400).json({ error: "Voucher is already cancelled" });

    const requestForm = await RequestForm.findById(voucher.rfId);
    if (!requestForm)
      return res.status(404).json({ error: "Linked request form not found" });

    // Only cancellable before disbursement — once disbursed/received the
    // money is out, so the voucher is locked.
    if (requestForm.status !== "voucher_created")
      return res
        .status(400)
        .json({ error: "Only vouchers that are not yet disbursed can be cancelled" });

    const { cancellationNote } = req.body;

    // Reverse the auto-recorded expense so reports don't count a cancelled
    // voucher. Matches the record created by autoRecordExpense on creation.
    await Expense.deleteOne({ source: "voucher", linkedId: voucher._id });

    voucher.status = "cancelled";
    voucher.cancelledBy = req.user.id;
    voucher.cancelledAt = Date.now();
    if (cancellationNote) voucher.cancellationNote = cancellationNote;
    await voucher.save();

    // Reopen the RF back to approved so a new voucher can be created for it.
    const reopenedRf = await RequestForm.findByIdAndUpdate(
      voucher.rfId,
      {
        $set: { status: "approved" },
        $unset: { voucherId: "", voucherCreatedAt: "" },
      },
      { new: true, runValidators: true }
    );

    await recordAudit({
      req,
      action: "voucher.cancel",
      targetModel: "Voucher",
      targetId: voucher._id,
      targetRef: voucher.pcfNo,
      summary: `Cancelled voucher ${voucher.pcfNo}; reopened ${reopenedRf.rfNo}`,
      meta: { rfNo: reopenedRf.rfNo, cancellationNote: cancellationNote || null },
    });

    await sendNotification({
      userId: reopenedRf.requestedBy,
      message: `Voucher ${voucher.pcfNo} for your request ${reopenedRf.rfNo} was cancelled. The request is open again.`,
      type: "info",
      refId: reopenedRf._id,
      refModel: "RequestForm",
    });

    await sendNotificationToRoles({
      roles: ["do", "auditor", "admin"],
      message: `Voucher ${voucher.pcfNo} was cancelled and ${reopenedRf.rfNo} reopened`,
      type: "info",
      refId: reopenedRf._id,
      refModel: "RequestForm",
      excludeUserId: req.user.id,
    });

    res.status(200).json({
      status: "Success",
      message: `Voucher ${voucher.pcfNo} cancelled and ${reopenedRf.rfNo} reopened`,
      data: voucher,
    });
  } catch (error) {
    next(error);
  }
};

export { getAllVouchers, createVoucher, cancelVoucher };
