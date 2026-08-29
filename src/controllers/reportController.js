import { Expense } from "../models/Expense.js";
import { Tithes } from "../models/TithesEntry.js";
import { parseDate } from "../utils/validate.js";
import PDFDocument from "pdfkit";
import excel from "exceljs";
import {
  TITHES_COLUMNS,
  EXPENSE_COLUMNS,
  mapTithesRows,
  mapExpenseRows,
  computeCombinedSummary,
  buildExcelSheet,
  buildCombinedSummarySheet,
  buildMonthlyBreakdownSheet,
  getLogoBuffer,
  renderPdfDoc,
  renderCombinedMonthlyPdf,
} from "../utils/reportExport.js";

const XLSX_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Parse the optional ?startDate&endDate range. Returns { start, end } (nulls
// when absent), or null after sending a 400 for an invalid range.
const parseDateRange = (req, res) => {
  const { startDate, endDate } = req.query;
  if (startDate && endDate) {
    const start = parseDate(startDate);
    const end = parseDate(endDate);
    if (!start || !end) {
      res.status(400).json({ error: "Invalid startDate or endDate" });
      return null;
    }
    return { start, end };
  }
  return { start: null, end: null };
};

const fetchTithes = (start, end) => {
  // Reports reflect actual collections, so only approved tithes count.
  const filter = { status: "approved" };
  if (start && end) filter.entryDate = { $gte: start, $lte: end };
  return Tithes.find(filter)
    .populate("submittedBy", "name role")
    .populate("reviewedBy", "name role");
};

const fetchExpenses = (start, end) => {
  const filter = {};
  if (start && end) filter.date = { $gte: start, $lte: end };
  return Expense.find(filter)
    .populate("category", "name type")
    .populate("recordedBy", "name role")
    .populate({
      path: "linkedId",
      select: "pcfNo amount rfId",
      // RF remark is the "what it was spent on" detail for voucher expenses.
      populate: { path: "rfId", select: "remarks rfNo" },
    });
};

const newPdf = () =>
  new PDFDocument({ size: "letter", margin: 36, bufferPages: true });

const getTithesReport = async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    // Reports reflect actual collections, so only approved tithes count.
    const filter = { status: "approved" };

    if (startDate && endDate) {
      const start = parseDate(startDate);
      const end = parseDate(endDate);
      if (!start || !end)
        return res.status(400).json({ error: "Invalid startDate or endDate" });
      filter.entryDate = { $gte: start, $lte: end };
    }

    if (req.user.role === "member") {
      filter.submittedBy = req.user.id;
    }

    const getAllTithes = await Tithes.find(filter)
      .populate("submittedBy", "name role")
      .populate("reviewedBy", "name role");

    res.status(200).json({
      status: "Success",
      count: getAllTithes.length,
      data: getAllTithes,
    });
  } catch (error) {
    next(error);
  }
};

const getExpenseReport = async (req, res, next) => {
  try {
    if (req.user.role === "member")
      return res.status(403).json({ error: "Forbidden" });

    const { startDate, endDate } = req.query;
    const filter = {};

    if (startDate && endDate) {
      const start = parseDate(startDate);
      const end = parseDate(endDate);
      if (!start || !end)
        return res.status(400).json({ error: "Invalid startDate or endDate" });
      filter.date = { $gte: start, $lte: end };
    }

    const getAllExpense = await Expense.find(filter)
      .populate("recordedBy", "name role")
      .populate("category", "name type")
      .populate("linkedId", "pcfNo amount");

    res.status(200).json({
      status: "Success",
      count: getAllExpense.length,
      data: getAllExpense,
    });
  } catch (error) {
    next(error);
  }
};

const exportTithesExcel = async (req, res, next) => {
  try {
    const range = parseDateRange(req, res);
    if (!range) return;
    const { startDate, endDate } = req.query;

    // Reports reflect actual collections, so only approved tithes count.
    const filter = { status: "approved" };
    if (range.start && range.end)
      filter.entryDate = { $gte: range.start, $lte: range.end };
    if (req.user.role === "member") filter.submittedBy = req.user.id;
    const tithes = await Tithes.find(filter)
      .populate("submittedBy", "name role")
      .populate("reviewedBy", "name role");

    const wb = new excel.Workbook();
    buildExcelSheet(wb.addWorksheet("Tithes"), {
      reportName: "Tithes Report",
      startDate,
      endDate,
      columns: TITHES_COLUMNS,
      rows: mapTithesRows(tithes),
      totals: [{ key: "total", label: "Total Balance:" }],
      statusColorKey: "status",
    });

    res.setHeader("Content-Type", XLSX_TYPE);
    res.setHeader("Content-Disposition", "attachment; filename=tithes-report.xlsx");
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

const exportTithesPDF = async (req, res, next) => {
  try {
    const range = parseDateRange(req, res);
    if (!range) return;
    const { startDate, endDate } = req.query;

    // Reports reflect actual collections, so only approved tithes count.
    const filter = { status: "approved" };
    if (range.start && range.end)
      filter.entryDate = { $gte: range.start, $lte: range.end };
    if (req.user.role === "member") filter.submittedBy = req.user.id;
    const tithes = await Tithes.find(filter)
      .populate("submittedBy", "name role")
      .populate("reviewedBy", "name role");

    const doc = newPdf();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=tithes-report.pdf");
    doc.pipe(res);

    renderPdfDoc(doc, {
      reportName: "Tithes Report",
      startDate,
      endDate,
      sections: [
        {
          columns: TITHES_COLUMNS,
          rows: mapTithesRows(tithes),
          totals: [{ key: "total", label: "Total Balance" }],
        },
      ],
    });

    doc.end();
  } catch (error) {
    next(error);
  }
};

const exportExpenseExcel = async (req, res, next) => {
  try {
    const range = parseDateRange(req, res);
    if (!range) return;
    const { startDate, endDate } = req.query;

    const expenses = await fetchExpenses(range.start, range.end);

    const wb = new excel.Workbook();
    buildExcelSheet(wb.addWorksheet("Expense"), {
      reportName: "Expense Report",
      startDate,
      endDate,
      columns: EXPENSE_COLUMNS,
      rows: mapExpenseRows(expenses),
      totals: [{ key: "amount", label: "Total Expenses:" }],
    });

    res.setHeader("Content-Type", XLSX_TYPE);
    res.setHeader("Content-Disposition", "attachment; filename=expense-report.xlsx");
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

const exportExpensePDF = async (req, res, next) => {
  try {
    const range = parseDateRange(req, res);
    if (!range) return;
    const { startDate, endDate } = req.query;

    const expenses = await fetchExpenses(range.start, range.end);

    const doc = newPdf();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=expense-report.pdf");
    doc.pipe(res);

    renderPdfDoc(doc, {
      reportName: "Expense Report",
      startDate,
      endDate,
      sections: [
        {
          columns: EXPENSE_COLUMNS,
          rows: mapExpenseRows(expenses),
          totals: [{ key: "amount", label: "Total Expenses" }],
        },
      ],
    });

    doc.end();
  } catch (error) {
    next(error);
  }
};

// ---- Combined (Tithes + Expense) — admin/auditor only ----
const getCombinedReport = async (req, res, next) => {
  try {
    const range = parseDateRange(req, res);
    if (!range) return;

    const [tithes, expenses] = await Promise.all([
      fetchTithes(range.start, range.end),
      fetchExpenses(range.start, range.end),
    ]);

    res.status(200).json({
      status: "Success",
      summary: computeCombinedSummary(tithes, expenses),
      tithes,
      expenses,
    });
  } catch (error) {
    next(error);
  }
};

const exportCombinedExcel = async (req, res, next) => {
  try {
    const range = parseDateRange(req, res);
    if (!range) return;
    const { startDate, endDate } = req.query;

    const [tithes, expenses] = await Promise.all([
      fetchTithes(range.start, range.end),
      fetchExpenses(range.start, range.end),
    ]);
    const summary = computeCombinedSummary(tithes, expenses);

    const wb = new excel.Workbook();

    // Embed the JOSCM logo once at workbook level; the id is reusable per sheet.
    const logoBuffer = getLogoBuffer();
    const logoImageId =
      logoBuffer != null
        ? wb.addImage({ buffer: logoBuffer, extension: "png" })
        : null;

    // Primary sheet: month-by-month breakdown for transparency.
    buildMonthlyBreakdownSheet(wb.addWorksheet("Monthly Breakdown"), {
      startDate,
      endDate,
      tithes,
      expenses,
      summary,
      logoImageId,
    });
    buildCombinedSummarySheet(wb.addWorksheet("Summary"), {
      startDate,
      endDate,
      summary,
    });
    buildExcelSheet(wb.addWorksheet("Tithes"), {
      reportName: "Tithes Report",
      startDate,
      endDate,
      columns: TITHES_COLUMNS,
      rows: mapTithesRows(tithes),
      totals: [{ key: "total", label: "Total Balance:" }],
      statusColorKey: "status",
    });
    buildExcelSheet(wb.addWorksheet("Expense"), {
      reportName: "Expense Report",
      startDate,
      endDate,
      columns: EXPENSE_COLUMNS,
      rows: mapExpenseRows(expenses),
      totals: [{ key: "amount", label: "Total Expenses:" }],
    });

    res.setHeader("Content-Type", XLSX_TYPE);
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=financial-summary-report.xlsx",
    );
    await wb.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
};

const exportCombinedPDF = async (req, res, next) => {
  try {
    const range = parseDateRange(req, res);
    if (!range) return;
    const { startDate, endDate } = req.query;

    const [tithes, expenses] = await Promise.all([
      fetchTithes(range.start, range.end),
      fetchExpenses(range.start, range.end),
    ]);
    const summary = computeCombinedSummary(tithes, expenses);

    const doc = newPdf();
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=financial-summary-report.pdf",
    );
    doc.pipe(res);

    renderCombinedMonthlyPdf(doc, {
      startDate,
      endDate,
      tithes,
      expenses,
      summary,
      logo: getLogoBuffer(),
    });

    doc.end();
  } catch (error) {
    next(error);
  }
};

export {
  getTithesReport,
  getExpenseReport,
  exportTithesExcel,
  exportTithesPDF,
  exportExpenseExcel,
  exportExpensePDF,
  getCombinedReport,
  exportCombinedExcel,
  exportCombinedPDF,
};
