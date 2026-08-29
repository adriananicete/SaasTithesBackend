import { Expense } from "../models/Expense.js";

export const autoRecordExpense = async (newVoucher) => {
  try {
    const newExpense = new Expense({
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
