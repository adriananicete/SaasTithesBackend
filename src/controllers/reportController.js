import { Expense } from "../models/Expense.js";
import { Tithes } from "../models/TithesEntry.js";
import { parseDate } from "../utils/validate.js";
import { withChurch } from "../utils/tenantScope.js";
import { ROLES } from "../constants/roles.js";
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

// These two are the ONLY place a report query is built, so there is exactly one
// line per model carrying the church. They used to take a bare (start, end) and
// three of the tithes handlers rebuilt the filter inline rather than calling
// through — four copies of one query, four chances to miss the church filter.
// Printed financial documents are the highest-consequence leak in the system;
// they are worth having a single door.
const fetchTithes = (req, { start, end }) => {
  // Reports reflect actual collections, so only approved tithes count.
  const filter = withChurch({ status: "approved" }, req);
  if (start && end) filter.entryDate = { $gte: start, $lte: end };
  // A member's report is their own submissions only (businessRequirements §8).
  // Never fires on the combined report, which is admin/auditor only.
  if (req.user.role === ROLES.MEMBER) filter.submittedBy = req.user.id;
  return Tithes.find(filter)
    .populate("submittedBy", "name role")
    .populate("reviewedBy", "name role");
};

const fetchExpenses = (req, { start, end }) => {
  const filter = withChurch({}, req);
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
    const range = parseDateRange(req, res);
    if (!range) return;

    const getAllTithes = await fetchTithes(req, range);

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
    if (req.user.role === ROLES.MEMBER)
      return res.status(403).json({ error: "Forbidden" });

    const range = parseDateRange(req, res);
    if (!range) return;

    // Now shares fetchExpenses with the exports, which populate one level
    // deeper (linkedId.rfId's remarks and rfNo). Purely additive for the
    // client, and it makes the on-screen report and its export agree.
    const getAllExpense = await fetchExpenses(req, range);

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

    const tithes = await fetchTithes(req, range);

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

    const tithes = await fetchTithes(req, range);

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

    const expenses = await fetchExpenses(req, range);

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

    const expenses = await fetchExpenses(req, range);

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
      fetchTithes(req, range),
      fetchExpenses(req, range),
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
      fetchTithes(req, range),
      fetchExpenses(req, range),
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
      fetchTithes(req, range),
      fetchExpenses(req, range),
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
