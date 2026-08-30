import { Expense } from "../models/Expense.js";

// Records the expense that a voucher represents. This is the ONLY automatic
// path from a request to the expense ledger.
//
// It used to swallow its own errors with a console.error, which meant a voucher
// could exist with no matching expense row while the request still returned 200
// (businessRequirements §14 item 5). The consequence is not a missing row: the
// expense ledger is half of availableBalance, so a swallowed failure OVERSTATES
// what the church has left, and the next request form is approved against money
// that is already spent.
//
// So it throws now. createVoucher rolls the voucher back rather than leaving a
// half-recorded disbursement behind.
export const autoRecordExpense = async (newVoucher) => {
  const newExpense = new Expense({
      // Off the voucher, not off a request — this util is handed a document,
      // never a `req`, so the voucher is the only thing that knows the church.
      church: newVoucher.church,
      source: "voucher",
      linkedId: newVoucher._id,
      amount: newVoucher.amount,
      category: newVoucher.category,
      date: newVoucher.date,
    recordedBy: newVoucher.createdBy,
  });

  await newExpense.save();
  return newExpense;
};
