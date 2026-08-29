import excel from "exceljs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Shared report-export builders. No DB access and no `res` handling here —
// controllers fetch + populate the data, call these to build the document,
// then stream it. Used by the tithes/expense exports and the combined report.
// ---------------------------------------------------------------------------

export const CHURCH = "Jesus Our Saviour Christian Ministry";
const CURRENCY_FMT = "#,##0.00";
// Church palette: teal #326b7e (primary), white #ffffff, gold #ccac55 (accent).
const TEAL = "FF326B7E";
const GOLD = "FFCCAC55";
const HEADER_FILL = TEAL;
const BAND_FILL = "FFEAF1F3"; // very light teal tint for zebra striping
const TEAL_TINT = "FFDCE7EA"; // subtotal / total bands
const GOLD_TINT = "FFF6EFD6"; // Month NET accent
const BORDER = { style: "thin", color: { argb: "FFDDDDDD" } };
const STATUS_COLORS = {
  approved: "FF15803D",
  pending: "FFB45309",
  rejected: "FFB91C1C",
};

export const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("en-PH") : "");

// PDFKit's built-in Helvetica has no peso glyph, so PDFs use a "PHP " prefix.
export const peso = (n) =>
  "PHP " +
  Number(n || 0).toLocaleString("en-PH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const rangeLine = (startDate, endDate) =>
  startDate && endDate
    ? `Period: ${fmtDate(startDate)} to ${fmtDate(endDate)}`
    : "Period: All dates";

const colLetter = (n) => {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

// ---- JOSCM logo (bundled asset, embedded into the workbook header) ----
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, "../assets/joscm-logo.png");
let _logoBuffer; // undefined = not loaded; null = unavailable
export const getLogoBuffer = () => {
  if (_logoBuffer === undefined) {
    try {
      _logoBuffer = fs.readFileSync(LOGO_PATH);
    } catch {
      _logoBuffer = null; // missing asset shouldn't break the export
    }
  }
  return _logoBuffer;
};

// ---- Month / week helpers (used by the monthly-breakdown sheet) ----
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
// Week-of-month: 1..5, where Week 1 = days 1-7, Week 2 = 8-14, etc.
const weekOfMonth = (d) => Math.floor((new Date(d).getDate() - 1) / 7) + 1;
const monthIndex = (d) => {
  const dt = new Date(d);
  return dt.getFullYear() * 12 + dt.getMonth();
};
const monthLabel = (idx) => `${MONTH_NAMES[idx % 12]} ${Math.floor(idx / 12)}`;

// Months to render, in order. With a date range we list every month it spans
// (so empty months still show as zero); otherwise we use the months present
// in the data.
const monthsInScope = (startDate, endDate, tithes, expenses) => {
  if (startDate && endDate) {
    const out = [];
    for (let i = monthIndex(startDate); i <= monthIndex(endDate); i++) out.push(i);
    return out;
  }
  const set = new Set();
  tithes.forEach((t) => set.add(monthIndex(t.entryDate)));
  expenses.forEach((e) => set.add(monthIndex(e.date)));
  return [...set].sort((a, b) => a - b);
};

// "Where the money went" detail: the recorded expense remark, falling back to
// the linked request-form remark for voucher-sourced expenses.
const expenseDetail = (e) =>
  e.remarks || e.linkedId?.rfId?.remarks || "—";

// ---- Column definitions (shared by Excel + PDF + JSON mappers) ----
export const TITHES_COLUMNS = [
  { header: "Entry Date", key: "entryDate", width: 18, pdfWidth: 80 },
  { header: "Service Type", key: "serviceType", width: 22, pdfWidth: 110 },
  { header: "Total", key: "total", width: 16, pdfWidth: 80, money: true },
  { header: "Submitted By", key: "submittedBy", width: 20, pdfWidth: 110 },
  { header: "Status", key: "status", width: 14, pdfWidth: 70 },
  { header: "Reviewed By", key: "reviewedBy", width: 20, pdfWidth: 90 },
];

export const EXPENSE_COLUMNS = [
  { header: "Date", key: "date", width: 18, pdfWidth: 75 },
  { header: "PCF No.", key: "pcfNo", width: 16, pdfWidth: 75 },
  { header: "Category", key: "category", width: 20, pdfWidth: 120 },
  { header: "Amount", key: "amount", width: 16, pdfWidth: 85, money: true },
  { header: "Source", key: "source", width: 14, pdfWidth: 70 },
  { header: "Recorded By", key: "recordedBy", width: 20, pdfWidth: 115 },
];

export const mapTithesRows = (docs) =>
  docs.map((t) => ({
    entryDate: fmtDate(t.entryDate),
    serviceType: t.serviceType || "",
    total: t.total || 0,
    submittedBy: t.submittedBy?.name || "",
    status: t.status || "",
    reviewedBy: t.reviewedBy?.name || "",
  }));

export const mapExpenseRows = (docs) =>
  docs.map((e) => ({
    date: fmtDate(e.date),
    pcfNo: e.linkedId?.pcfNo || "N/A",
    category: e.category?.name || "",
    amount: e.amount || 0,
    source: e.source || "",
    recordedBy: e.recordedBy?.name || "",
  }));

export const computeCombinedSummary = (tithes, expenses) => {
  const totalTithes = tithes.reduce((s, t) => s + (t.total || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const byCatMap = {};
  expenses.forEach((e) => {
    const name = e.category?.name || "Uncategorized";
    byCatMap[name] = (byCatMap[name] || 0) + (e.amount || 0);
  });
  const byCategory = Object.entries(byCatMap)
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
  return {
    totalTithes,
    totalExpenses,
    net: totalTithes - totalExpenses,
    tithesCount: tithes.length,
    expenseCount: expenses.length,
    byCategory,
  };
};

// ---------------------------------------------------------------------------
// EXCEL
// ---------------------------------------------------------------------------
export function buildExcelSheet(
  ws,
  { reportName, startDate, endDate, columns, rows, totals = [], statusColorKey },
) {
  const colCount = columns.length;
  const lastCol = colLetter(colCount);
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width || 16 }));

  const addTitle = (text, font) => {
    const row = ws.addRow([text]);
    ws.mergeCells(`A${row.number}:${lastCol}${row.number}`);
    const cell = row.getCell(1);
    cell.font = font;
    cell.alignment = { horizontal: "center" };
  };
  addTitle(CHURCH, { bold: true, size: 16 });
  addTitle(reportName, { bold: true, size: 13 });
  addTitle(rangeLine(startDate, endDate), {
    italic: true,
    size: 10,
    color: { argb: "FF666666" },
  });
  addTitle(`Generated: ${fmtDate(new Date())}`, {
    size: 9,
    color: { argb: "FF888888" },
  });

  const headerRow = ws.addRow(columns.map((c) => c.header));
  headerRow.height = 18;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  const headerRowNum = headerRow.number;
  const firstDataRow = headerRowNum + 1;

  rows.forEach((r, i) => {
    const row = ws.addRow(r);
    const banded = i % 2 === 1;
    columns.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      if (c.money) {
        cell.numFmt = CURRENCY_FMT;
        cell.alignment = { horizontal: "right" };
      } else {
        cell.alignment = { horizontal: "center" };
      }
      if (banded)
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND_FILL } };
      if (statusColorKey && c.key === statusColorKey) {
        const argb = STATUS_COLORS[String(r[c.key]).toLowerCase()];
        if (argb) cell.font = { color: { argb }, bold: true };
      }
    });
  });

  const lastDataRow = headerRowNum + rows.length;

  if (rows.length > 0 && totals.length > 0) {
    const totalsRow = ws.addRow([]);
    totals.forEach(({ key, label }) => {
      const ci = columns.findIndex((c) => c.key === key);
      if (ci < 0) return;
      const letter = colLetter(ci + 1);
      const sumCell = totalsRow.getCell(ci + 1);
      sumCell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})` };
      sumCell.font = { bold: true };
      sumCell.numFmt = CURRENCY_FMT;
      sumCell.alignment = { horizontal: "right" };
      if (ci > 0) {
        const labelCell = totalsRow.getCell(ci);
        labelCell.value = label;
        labelCell.font = { bold: true };
        labelCell.alignment = { horizontal: "right" };
      }
    });
  }

  const lastRow = ws.lastRow.number;
  for (let r = headerRowNum; r <= lastRow; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= colCount; c++) {
      row.getCell(c).border = {
        top: BORDER,
        left: BORDER,
        bottom: BORDER,
        right: BORDER,
      };
    }
  }

  ws.views = [{ state: "frozen", ySplit: headerRowNum }];
  ws.autoFilter = {
    from: { row: headerRowNum, column: 1 },
    to: { row: Math.max(lastDataRow, headerRowNum), column: colCount },
  };
}

// Combined-report "Summary" sheet (key/value totals + by-category table).
export function buildCombinedSummarySheet(ws, { startDate, endDate, summary }) {
  ws.columns = [{ key: "a", width: 28 }, { key: "b", width: 22 }];

  const addTitle = (text, font) => {
    const row = ws.addRow([text]);
    ws.mergeCells(`A${row.number}:B${row.number}`);
    row.getCell(1).font = font;
    row.getCell(1).alignment = { horizontal: "center" };
  };
  addTitle(CHURCH, { bold: true, size: 16 });
  addTitle("Financial Summary", { bold: true, size: 13 });
  addTitle(rangeLine(startDate, endDate), {
    italic: true,
    size: 10,
    color: { argb: "FF666666" },
  });
  addTitle(`Generated: ${fmtDate(new Date())}`, {
    size: 9,
    color: { argb: "FF888888" },
  });
  ws.addRow([]);

  const kv = (label, value, opts = {}) => {
    const row = ws.addRow([label, value]);
    row.getCell(1).font = { bold: !!opts.bold };
    const v = row.getCell(2);
    if (opts.money !== false) {
      v.numFmt = CURRENCY_FMT;
      v.alignment = { horizontal: "right" };
    }
    v.font = {
      bold: !!opts.bold,
      ...(opts.argb ? { color: { argb: opts.argb } } : {}),
    };
  };
  kv("Total Tithes", summary.totalTithes);
  kv("Total Expenses", summary.totalExpenses);
  kv("NET Position", summary.net, {
    bold: true,
    argb: summary.net >= 0 ? "FF15803D" : "FFB91C1C",
  });
  ws.addRow([]);
  kv("Tithes Entries", summary.tithesCount, { money: false });
  kv("Expense Entries", summary.expenseCount, { money: false });
  ws.addRow([]);

  if (summary.byCategory.length) {
    const h = ws.addRow(["Expenses by Category", "Amount"]);
    h.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    });
    summary.byCategory.forEach((c) => {
      const row = ws.addRow([c.category, c.total]);
      row.getCell(2).numFmt = CURRENCY_FMT;
      row.getCell(2).alignment = { horizontal: "right" };
    });
  }
}

// Combined-report "Monthly Breakdown" sheet. Reads top-to-bottom like a
// treasurer's report: logo header -> period summary -> one section per month,
// each with a weekly tithes table (Week 1..5 + subtotals), an expense table
// (date / particulars / category), monthly totals, and the month NET.
export function buildMonthlyBreakdownSheet(
  ws,
  { startDate, endDate, tithes, expenses, summary, logoImageId },
) {
  ws.columns = [
    { key: "a", width: 20 },
    { key: "b", width: 34 },
    { key: "c", width: 22 },
    { key: "d", width: 16 },
  ];

  const allBorder = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
  const money = (cell, v) => {
    cell.value = v;
    cell.numFmt = CURRENCY_FMT;
    cell.alignment = { horizontal: "right" };
  };
  const borderRow = (row) => {
    for (let c = 1; c <= 4; c++) row.getCell(c).border = allBorder;
  };
  // Draw a thick outline around a A..D row range so each month reads as its
  // own boxed section. Merges with the existing thin inner grid.
  const outline = (top, bottom, argb = TEAL, style = "medium") => {
    for (let r = top; r <= bottom; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= 4; c++) {
        const cell = row.getCell(c);
        const b = { ...(cell.border || {}) };
        if (r === top) b.top = { style, color: { argb } };
        if (r === bottom) b.bottom = { style, color: { argb } };
        if (c === 1) b.left = { style, color: { argb } };
        if (c === 4) b.right = { style, color: { argb } };
        cell.border = b;
      }
    }
  };

  const titleRow = (text, font) => {
    const row = ws.addRow([text]);
    ws.mergeCells(`A${row.number}:D${row.number}`);
    const c = row.getCell(1);
    c.font = font;
    c.alignment = { horizontal: "center", vertical: "middle" };
    return row;
  };
  const mergedBand = (label, fontColor, fillArgb, size = 12) => {
    const row = ws.addRow([label]);
    ws.mergeCells(`A${row.number}:D${row.number}`);
    const c = row.getCell(1);
    c.font = { bold: true, size, color: { argb: fontColor } };
    c.alignment = { horizontal: "left", vertical: "middle" };
    if (fillArgb)
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillArgb } };
    row.height = 20;
    return row;
  };
  const tableHeader = (labels) => {
    const row = ws.addRow(labels);
    row.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = allBorder;
    });
  };
  const dataStyle = (row, i) => {
    for (let c = 1; c <= 4; c++) {
      const cell = row.getCell(c);
      cell.border = allBorder;
      if (c !== 4) cell.alignment = { horizontal: "center" };
      if (i % 2 === 1)
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BAND_FILL } };
    }
  };
  const totalRow = (label, value, opts = {}) => {
    const row = ws.addRow(["", "", label, null]);
    row.getCell(3).font = { bold: true };
    row.getCell(3).alignment = { horizontal: "right" };
    money(row.getCell(4), value);
    row.getCell(4).font = {
      bold: true,
      ...(opts.argb ? { color: { argb: opts.argb } } : {}),
    };
    for (let c = 1; c <= 4; c++) {
      row.getCell(c).border = allBorder;
      row.getCell(c).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: opts.fill || TEAL_TINT },
      };
    }
    return row;
  };

  // --- Header block (logo floats at the left over the title rows) ---
  if (logoImageId != null) {
    ws.addImage(logoImageId, {
      tl: { col: 0, row: 0 },
      ext: { width: 56, height: 56 },
      editAs: "oneCell",
    });
  }
  titleRow(CHURCH, { bold: true, size: 15, color: { argb: TEAL } }).height = 26;
  titleRow("Financial Report", { bold: true, size: 13, color: { argb: GOLD } });
  titleRow(rangeLine(startDate, endDate), {
    italic: true,
    size: 10,
    color: { argb: "FF666666" },
  });
  titleRow(`Generated: ${fmtDate(new Date())}`, {
    size: 9,
    color: { argb: "FF888888" },
  });
  ws.addRow([]);

  // --- Period summary ---
  mergedBand("Period Summary", "FFFFFFFF", HEADER_FILL);
  totalRow("Total Tithes", summary.totalTithes, { fill: "FFFFFFFF" });
  totalRow("Total Expenses", summary.totalExpenses, { fill: "FFFFFFFF" });
  totalRow("NET Position", summary.net, {
    fill: "FFFFFFFF",
    argb: summary.net >= 0 ? "FF15803D" : "FFB91C1C",
  });

  // --- Per-month sections ---
  const months = monthsInScope(startDate, endDate, tithes, expenses);
  const tByMonth = {};
  tithes.forEach((t) => (tByMonth[monthIndex(t.entryDate)] ??= []).push(t));
  const eByMonth = {};
  expenses.forEach((e) => (eByMonth[monthIndex(e.date)] ??= []).push(e));

  months.forEach((mi) => {
    const mt = (tByMonth[mi] || [])
      .slice()
      .sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
    const me = (eByMonth[mi] || [])
      .slice()
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const titheTotal = mt.reduce((s, t) => s + (t.total || 0), 0);
    const expTotal = me.reduce((s, e) => s + (e.amount || 0), 0);

    ws.addRow([]);
    const sectionStart = mergedBand(monthLabel(mi), "FFFFFFFF", TEAL, 12).number;

    // Weekly tithes
    mergedBand("Weekly Tithes", TEAL, null, 10);
    tableHeader(["Week", "Date", "Service Type", "Amount"]);
    if (mt.length === 0) {
      dataStyle(ws.addRow(["—", "", "No tithes recorded", null]), 0);
    } else {
      const weeks = {};
      mt.forEach((t) => (weeks[weekOfMonth(t.entryDate)] ??= []).push(t));
      let band = 0;
      Object.keys(weeks)
        .map(Number)
        .sort((a, b) => a - b)
        .forEach((wk) => {
          weeks[wk].forEach((t) => {
            const row = ws.addRow([
              `Week ${wk}`,
              fmtDate(t.entryDate),
              t.serviceType || "",
              null,
            ]);
            dataStyle(row, band++);
            money(row.getCell(4), t.total || 0);
          });
          const sub = ws.addRow(["", "", `Week ${wk} Subtotal`, null]);
          sub.getCell(3).font = { italic: true, bold: true };
          sub.getCell(3).alignment = { horizontal: "right" };
          money(sub.getCell(4), weeks[wk].reduce((s, t) => s + (t.total || 0), 0));
          sub.getCell(4).font = { italic: true, bold: true };
          borderRow(sub);
        });
    }
    totalRow("Total Tithes", titheTotal);

    // Expenses
    ws.addRow([]);
    mergedBand("Expenses", TEAL, null, 10);
    tableHeader(["Date", "Details / Particulars", "Category", "Amount"]);
    if (me.length === 0) {
      dataStyle(ws.addRow(["—", "No expenses recorded", "", null]), 0);
    } else {
      me.forEach((e, i) => {
        const row = ws.addRow([
          fmtDate(e.date),
          expenseDetail(e),
          e.category?.name || "",
          null,
        ]);
        dataStyle(row, i);
        row.getCell(2).alignment = { horizontal: "left", wrapText: true };
        money(row.getCell(4), e.amount || 0);
      });
    }
    totalRow("Total Expenses", expTotal);

    // Month NET
    const net = titheTotal - expTotal;
    const sectionEnd = totalRow("Month NET", net, {
      fill: GOLD_TINT,
      argb: net >= 0 ? "FF15803D" : "FFB91C1C",
    }).number;

    // Box the whole month so it reads as one section at a glance.
    outline(sectionStart, sectionEnd, TEAL, "medium");
  });
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------
const ROW_H = 20;
const FOOTER_H = 30;
// Church palette (PDF hex mirrors the Excel ARGB consts above).
const PDF_TEAL = "#326b7e";
const PDF_GOLD = "#ccac55";
const PDF_HEADER_FILL = PDF_TEAL;
const PDF_BAND_FILL = "#eaf1f3"; // light-teal zebra striping
const PDF_TEAL_TINT = "#dce7ea"; // subtotal / total bands
const PDF_GOLD_TINT = "#f6efd6"; // Month NET accent

const cellText = (doc, text, x, width, y, align = "center") => {
  const s = String(text ?? "");
  if (align === "right") {
    const tw = doc.widthOfString(s);
    doc.text(s, x + width - tw - 4, y, { lineBreak: false });
  } else if (align === "left") {
    doc.text(s, x + 4, y, { lineBreak: false });
  } else {
    const tw = doc.widthOfString(s);
    doc.text(s, x + Math.max(0, (width - tw) / 2), y, { lineBreak: false });
  }
};

const drawDocHeader = (doc, { reportName, startDate, endDate, left, contentW, y }) => {
  doc.fillColor(PDF_TEAL).font("Helvetica-Bold").fontSize(17);
  doc.text(CHURCH, left, y, { width: contentW, align: "center" });
  y += 22;
  doc.fillColor(PDF_GOLD).fontSize(13).text(reportName, left, y, { width: contentW, align: "center" });
  y += 18;
  doc.font("Helvetica").fontSize(9).fillColor("#666666");
  doc.text(rangeLine(startDate, endDate), left, y, { width: contentW, align: "center" });
  y += 12;
  doc.fillColor("#888888");
  doc.text(`Generated: ${fmtDate(new Date())}`, left, y, { width: contentW, align: "center" });
  return y + 20;
};

const drawSummaryBlock = (doc, { summaryBlock, left, y, pageBottom }) => {
  doc.font("Helvetica-Bold").fontSize(12).fillColor(PDF_TEAL);
  doc.text(summaryBlock.title || "Financial Summary", left, y, { lineBreak: false });
  y += 18;
  doc.fontSize(10);
  summaryBlock.rows.forEach((kv) => {
    doc.font("Helvetica").fillColor("#444444").text(kv.label, left + 4, y, {
      lineBreak: false,
      width: 200,
    });
    doc.font("Helvetica-Bold").fillColor(kv.color || "#111111").text(kv.value, left + 220, y, {
      lineBreak: false,
    });
    y += 16;
  });
  y += 6;
  if (summaryBlock.byCategory && summaryBlock.byCategory.length) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#111111");
    doc.text("Expenses by Category", left, y, { lineBreak: false });
    y += 15;
    doc.font("Helvetica").fontSize(9);
    summaryBlock.byCategory.forEach((c) => {
      if (y + 14 > pageBottom) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      doc.fillColor("#444444").text(c.category, left + 4, y, { lineBreak: false, width: 200 });
      doc.fillColor("#111111").text(peso(c.total), left + 220, y, { lineBreak: false });
      y += 14;
    });
  }
  return y + 12;
};

const drawSection = (doc, { section, left, y, pageBottom }) => {
  const { title, columns, rows, totals = [] } = section;
  const widths = columns.map((c) => c.pdfWidth || 80);
  const totalW = widths.reduce((a, b) => a + b, 0);
  const xs = [];
  let cx = left;
  widths.forEach((w) => {
    xs.push(cx);
    cx += w;
  });

  const drawHeaderBand = () => {
    doc.rect(left, y, totalW, ROW_H).fill(PDF_HEADER_FILL);
    doc.fillColor("white").font("Helvetica-Bold").fontSize(9);
    columns.forEach((c, i) =>
      cellText(doc, c.header, xs[i], widths[i], y + 6, c.money ? "right" : "center"),
    );
    y += ROW_H;
  };

  if (y + ROW_H * 2 > pageBottom) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  if (title) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111111").text(title, left, y, {
      lineBreak: false,
    });
    y += 16;
  }
  drawHeaderBand();

  rows.forEach((r, idx) => {
    if (y + ROW_H > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderBand(); // repeat header on each new page
    }
    if (idx % 2 === 1) doc.rect(left, y, totalW, ROW_H).fill(PDF_BAND_FILL);
    doc.fillColor("#111111").font("Helvetica").fontSize(8);
    columns.forEach((c, i) => {
      const raw = r[c.key];
      const val = c.money ? peso(raw) : raw;
      cellText(doc, val, xs[i], widths[i], y + 6, c.money ? "right" : "center");
    });
    y += ROW_H;
  });

  totals.forEach((t) => {
    const ci = columns.findIndex((c) => c.key === t.key);
    if (ci < 0) return;
    const sum = rows.reduce((s, r) => s + (Number(r[t.key]) || 0), 0);
    if (y + ROW_H > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#111111");
    if (ci > 0) cellText(doc, t.label, xs[ci - 1], widths[ci - 1], y + 6, "right");
    cellText(doc, peso(sum), xs[ci], widths[ci], y + 6, "right");
    y += ROW_H;
  });

  return y;
};

export function renderPdfDoc(doc, { reportName, startDate, endDate, sections = [], summaryBlock }) {
  const left = doc.page.margins.left;
  const contentW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const pageBottom = doc.page.height - doc.page.margins.bottom - FOOTER_H;

  let y = drawDocHeader(doc, { reportName, startDate, endDate, left, contentW, y: doc.page.margins.top });

  if (summaryBlock) y = drawSummaryBlock(doc, { summaryBlock, left, y, pageBottom });

  sections.forEach((section, i) => {
    if (i > 0) y += 14;
    y = drawSection(doc, { section, left, y, pageBottom });
  });

  drawPageFooters(doc, left, contentW);
}

// Footer with "Generated" + page numbers — two-pass over the buffered pages.
const drawPageFooters = (doc, left, contentW) => {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const fy = doc.page.height - doc.page.margins.bottom - 14;
    doc.font("Helvetica").fontSize(8).fillColor("#888888");
    doc.text(`Generated: ${fmtDate(new Date())}`, left, fy, { lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, left, fy, {
      width: contentW,
      align: "right",
      lineBreak: false,
    });
  }
};

// Combined-report PDF that mirrors the Excel "Monthly Breakdown" sheet: logo
// header -> period summary -> one section per month (weekly tithes w/ subtotals
// + expenses w/ particulars + month NET) -> a detailed-records appendix.
export function renderCombinedMonthlyPdf(
  doc,
  { startDate, endDate, tithes, expenses, summary, logo },
) {
  const left = doc.page.margins.left;
  const contentW = doc.page.width - left - doc.page.margins.right;
  const pageBottom = doc.page.height - doc.page.margins.bottom - FOOTER_H;
  let y = doc.page.margins.top;

  if (logo) {
    try {
      doc.image(logo, left, y, { width: 46, height: 46 });
    } catch {
      /* missing/invalid logo shouldn't break the export */
    }
  }
  y = drawDocHeader(doc, {
    reportName: "Financial Report",
    startDate,
    endDate,
    left,
    contentW,
    y,
  });

  y = drawSummaryBlock(doc, {
    summaryBlock: {
      title: "Period Summary",
      rows: [
        { label: "Total Tithes", value: peso(summary.totalTithes) },
        { label: "Total Expenses", value: peso(summary.totalExpenses) },
        {
          label: "NET Position",
          value: peso(summary.net),
          color: summary.net >= 0 ? "#15803d" : "#b91c1c",
        },
      ],
      byCategory: summary.byCategory,
    },
    left,
    y,
    pageBottom,
  });

  // Generic month table: rows carry a style ('data' | 'subtotal' | 'total' |
  // 'empty') so subtotal/total rows render bold on a tinted band.
  const drawMonthTable = ({ heading, columns, body }) => {
    const widths = columns.map((c) => c.width);
    const totalW = widths.reduce((a, b) => a + b, 0);
    const xs = [];
    let cx = left;
    widths.forEach((w) => {
      xs.push(cx);
      cx += w;
    });
    const headerBand = () => {
      doc.rect(left, y, totalW, ROW_H).fill(PDF_HEADER_FILL);
      doc.fillColor("white").font("Helvetica-Bold").fontSize(9);
      columns.forEach((c, i) =>
        cellText(doc, c.header, xs[i], widths[i], y + 6, c.money ? "right" : c.align || "center"),
      );
      y += ROW_H;
    };

    if (y + ROW_H * 2 > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    if (heading) {
      doc.font("Helvetica-Bold").fontSize(10).fillColor(PDF_TEAL).text(heading, left, y, {
        lineBreak: false,
      });
      y += 15;
    }
    headerBand();

    body.forEach((r) => {
      if (y + ROW_H > pageBottom) {
        doc.addPage();
        y = doc.page.margins.top;
        headerBand();
      }
      if (r.style === "data" && r.band) doc.rect(left, y, totalW, ROW_H).fill(PDF_BAND_FILL);
      if (r.style === "subtotal" || r.style === "total")
        doc.rect(left, y, totalW, ROW_H).fill(PDF_TEAL_TINT);
      const bold = r.style === "subtotal" || r.style === "total";
      doc.fillColor("#111111").font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
      columns.forEach((c, i) => {
        const raw = r.cells[i];
        const val = c.money && raw !== "" && raw != null ? peso(raw) : raw ?? "";
        cellText(doc, val, xs[i], widths[i], y + 6, c.money ? "right" : c.align || "center");
      });
      y += ROW_H;
    });
  };

  // We always render on the newest buffered page, so its index is count-1.
  const pageIdx = () => doc.bufferedPageRange().count - 1;
  // Box a month section with a teal outline; handles sections that span pages
  // by drawing a segment per page (open where it continues).
  const drawMonthBox = (startPage, startY, endPage, endY) => {
    const pad = 1;
    for (let p = startPage; p <= endPage; p++) {
      doc.switchToPage(p);
      const top = (p === startPage ? startY : doc.page.margins.top) - pad;
      const bottom = (p === endPage ? endY : pageBottom) + pad;
      doc.lineWidth(1.2).strokeColor(PDF_TEAL).rect(left - pad, top, contentW + pad * 2, bottom - top).stroke();
    }
    doc.switchToPage(endPage); // resume on the page we left off
  };

  const months = monthsInScope(startDate, endDate, tithes, expenses);
  months.forEach((mi) => {
    if (y + ROW_H * 2 > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    y += 10;
    const boxStartPage = pageIdx();
    const boxStartY = y;
    // Filled teal month-header band with white text (mirrors the Excel sheet).
    doc.rect(left, y, contentW, ROW_H).fill(PDF_TEAL);
    doc.fillColor("white").font("Helvetica-Bold").fontSize(12);
    doc.text(monthLabel(mi), left + 6, y + 5, { lineBreak: false });
    y += ROW_H + 4;

    // --- Weekly tithes ---
    const mt = tithes
      .filter((t) => monthIndex(t.entryDate) === mi)
      .sort((a, b) => new Date(a.entryDate) - new Date(b.entryDate));
    const titheTotal = mt.reduce((s, t) => s + (t.total || 0), 0);
    const titheCols = [
      { header: "Week", width: 70 },
      { header: "Date", width: 90 },
      { header: "Service Type", width: contentW - 70 - 90 - 95, align: "left" },
      { header: "Amount", width: 95, money: true },
    ];
    const tBody = [];
    if (mt.length === 0) {
      tBody.push({ style: "empty", cells: ["—", "", "No tithes recorded", ""] });
    } else {
      const weeks = {};
      mt.forEach((t) => (weeks[weekOfMonth(t.entryDate)] ??= []).push(t));
      let band = false;
      Object.keys(weeks)
        .map(Number)
        .sort((a, b) => a - b)
        .forEach((wk) => {
          weeks[wk].forEach((t) => {
            tBody.push({
              style: "data",
              band,
              cells: [`Week ${wk}`, fmtDate(t.entryDate), t.serviceType || "", t.total || 0],
            });
            band = !band;
          });
          tBody.push({
            style: "subtotal",
            cells: ["", "", `Week ${wk} Subtotal`, weeks[wk].reduce((s, t) => s + (t.total || 0), 0)],
          });
        });
    }
    tBody.push({ style: "total", cells: ["", "", "Total Tithes", titheTotal] });
    drawMonthTable({ heading: "Weekly Tithes", columns: titheCols, body: tBody });

    y += 6;

    // --- Expenses ---
    const me = expenses
      .filter((e) => monthIndex(e.date) === mi)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    const expTotal = me.reduce((s, e) => s + (e.amount || 0), 0);
    const expCols = [
      { header: "Date", width: 80 },
      { header: "Details / Particulars", width: contentW - 80 - 110 - 95, align: "left" },
      { header: "Category", width: 110, align: "left" },
      { header: "Amount", width: 95, money: true },
    ];
    const eBody = [];
    if (me.length === 0) {
      eBody.push({ style: "empty", cells: ["—", "No expenses recorded", "", ""] });
    } else {
      me.forEach((e, i) =>
        eBody.push({
          style: "data",
          band: i % 2 === 1,
          cells: [fmtDate(e.date), expenseDetail(e), e.category?.name || "", e.amount || 0],
        }),
      );
    }
    eBody.push({ style: "total", cells: ["", "", "Total Expenses", expTotal] });
    drawMonthTable({ heading: "Expenses", columns: expCols, body: eBody });

    // --- Month NET ---
    const net = titheTotal - expTotal;
    if (y + ROW_H > pageBottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.rect(left, y, contentW, ROW_H).fill(PDF_GOLD_TINT);
    doc.fillColor(net >= 0 ? "#15803d" : "#b91c1c").font("Helvetica-Bold").fontSize(9);
    cellText(doc, "Month NET", left, contentW - 95, y + 6, "right");
    cellText(doc, peso(net), left + contentW - 95, 95, y + 6, "right");
    y += ROW_H;

    // Box the whole month so it reads as one section at a glance.
    drawMonthBox(boxStartPage, boxStartY, pageIdx(), y);
    y += 8;
  });

  // --- Detailed-records appendix (full flat tables) ---
  doc.addPage();
  y = doc.page.margins.top;
  doc.font("Helvetica-Bold").fontSize(13).fillColor(PDF_TEAL).text("Detailed Records", left, y, {
    lineBreak: false,
  });
  y += 22;
  y = drawSection(doc, {
    section: {
      title: "All Tithes",
      columns: TITHES_COLUMNS,
      rows: mapTithesRows(tithes),
      totals: [{ key: "total", label: "Total Balance" }],
    },
    left,
    y,
    pageBottom,
  });
  y += 14;
  drawSection(doc, {
    section: {
      title: "All Expenses",
      columns: EXPENSE_COLUMNS,
      rows: mapExpenseRows(expenses),
      totals: [{ key: "amount", label: "Total Expenses" }],
    },
    left,
    y,
    pageBottom,
  });

  drawPageFooters(doc, left, contentW);
}
