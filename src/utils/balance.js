import mongoose from "mongoose";
import { Tithes } from "../models/TithesEntry.js";
import { Expense } from "../models/Expense.js";

// The church's cash on hand: approved tithes minus everything spent.
//
// This is the number the UI shows under the amount field on a request form, and
// the number that gates how much a church may request. It lived only inside
// getAllTithes until a second caller needed it — the RF create handler, which
// until then took the frontend's word for it.
//
// Both aggregations are per church. Unscoped they summed every church's money
// into one figure, which is the single most consequential place a missing filter
// could hide (businessRequirements §4.3).
export const getAvailableBalance = async (churchId) => {
  // The aggregation pipeline gets no Mongoose casting, so the church has to be
  // a real ObjectId here — a string silently matches nothing, which would read
  // as "this church has no money" rather than as an error.
  const church = new mongoose.Types.ObjectId(churchId);

  const [approvedAgg, expenseAgg] = await Promise.all([
    Tithes.aggregate([
      { $match: { church, status: "approved" } },
      { $group: { _id: null, sum: { $sum: "$total" } } },
    ]),
    Expense.aggregate([
      { $match: { church } },
      { $group: { _id: null, sum: { $sum: "$amount" } } },
    ]),
  ]);

  return (approvedAgg[0]?.sum ?? 0) - (expenseAgg[0]?.sum ?? 0);
};

// Peso formatting that matches what the client already prints in its own
// version of these messages, so the two never disagree in front of a user.
export const peso = (n) =>
  `₱${Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
