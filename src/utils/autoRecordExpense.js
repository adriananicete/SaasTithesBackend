import { Expense } from "../models/Expense.js";

export const autoRecordExpense = async (newVoucher) => {
  try {
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
  } catch (error) {
    console.error(error);
  }
};
