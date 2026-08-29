import mongoose from "mongoose";
import { Expense } from "../models/Expense.js";
import { recordAudit } from "../utils/recordAudit.js";

const getAllExpenses = async (req, res, next) => {
  try {
    const getAllData = await Expense.find()
      .populate({
        path: "linkedId",
        select: "pcfNo amount rfId",
        populate: {
          path: "rfId",
          select: "rfNo requestedBy approvedBy",
          populate: [
            { path: "requestedBy", select: "name avatarUrl" },
            { path: "approvedBy", select: "name avatarUrl" },
          ],
        },
      })
      .populate("category", "name type")
      .populate("recordedBy", "name role avatarUrl");

    res.status(200).json({
      status: "Success",
      count: getAllData.length,
      data: getAllData,
    });
  } catch (error) {
    next(error);
  }
};

// Category totals for the last 6 months. Aggregated only (no per-expense
// detail) so it is safe to expose to every authenticated role for the
// Dashboard's "Expenses by Category" chart — unlike getAllExpenses, which
// returns full records (amounts, dates, recordedBy, linked voucher/RF).
const getExpensesByCategory = async (req, res, next) => {
  try {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

    const data = await Expense.aggregate([
      { $match: { date: { $gte: sixMonthsAgo } } },
      { $group: { _id: "$category", amount: { $sum: "$amount" } } },
      {
        $lookup: {
          from: "categories",
          localField: "_id",
          foreignField: "_id",
          as: "category",
        },
      },
      { $unwind: { path: "$category", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          category: { $ifNull: ["$category.name", "Uncategorized"] },
          amount: 1,
        },
      },
      { $sort: { amount: -1 } },
    ]);

    res.status(200).json({
      status: "Success",
      count: data.length,
      data,
    });
  } catch (error) {
    next(error);
  }
};

const createManualExpense = async (req, res, next) => {
  try {

    if(!['admin'].includes(req.user.role)) return res.status(403).json({ error: 'Only admin can create manual expense' });
    const { amount, category, date, remarks } = req.body;

    if(!mongoose.Types.ObjectId.isValid(category)) return res.status(400).json({error: `Invalid Category`});

    if(!amount || !category || !date) return res.status(400).json({ error: 'All fields required' });

    if(amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero' });

    // Remarks/particulars are the expense detail shown in financial reports.
    if(!remarks || !String(remarks).trim()) return res.status(400).json({ error: 'Remarks / particulars required' });

    const newManualExpense = new Expense({
        source: 'manual',
        amount: amount,
        category: category,
        date: date,
        recordedBy: req.user.id,
        remarks: String(remarks).trim()
    });

    await newManualExpense.save()

    await recordAudit({
        req,
        action: 'expense.create',
        targetModel: 'Expense',
        targetId: newManualExpense._id,
        targetRef: String(remarks).trim(),
        summary: `Recorded manual expense ₱${amount}`,
        meta: { amount },
    });

    res.status(201).json({
        status: 'Success',
        message: 'Manual Expense Created',
        data: newManualExpense
    });


  } catch (error) {
    next(error);
  }
};

export { getAllExpenses, getExpensesByCategory, createManualExpense };
