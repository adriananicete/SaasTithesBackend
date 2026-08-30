// Reads the *contents* of a generated export so a check can assert on them.
//
// The leak check originally recorded the export endpoints as "not verifiable by
// scan" — an .xlsx is a ZIP and a .pdf compresses its text, so searching the
// raw bytes for a marker reports "clean" whether or not a row leaked, and a
// false green in a security gate is worse than an absent row. Both formats are
// readable with what the repo already has: exceljs parses the workbook, and
// PDFKit uses the built-in Helvetica (no font subsetting), so the text inside a
// PDF's Flate streams is ordinary ASCII once inflated.
//
// Printed financial documents are the highest-consequence leak in the system.
// They are the last place worth trusting an argument over a measurement.

import zlib from "node:zlib";
import excel from "exceljs";

// Every string in every cell of every sheet.
export const xlsxText = async (buffer) => {
  const wb = new excel.Workbook();
  await wb.xlsx.load(buffer);

  const out = [];
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        if (v == null) return;
        // Formula cells carry { formula, result }; rich text carries a runs array.
        if (typeof v === "object") {
          if (Array.isArray(v.richText)) out.push(v.richText.map((r) => r.text).join(""));
          else out.push(String(v.result ?? v.formula ?? ""));
        } else {
          out.push(String(v));
        }
      });
    });
  });
  return out.join("\n");
};

// Row count of one sheet, used to assert an export holds exactly one church's
// rows. Counts every written row including the title/header band, so compare
// two churches' numbers rather than reading a single one as a data count.
export const xlsxSheetRowCount = async (buffer, sheetName) => {
  const wb = new excel.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return null;
  let count = 0;
  ws.eachRow(() => count++);
  return count;
};

// Inflates every Flate stream in a PDF and returns what is inside them.
export const pdfText = (buffer) => {
  const out = [];
  let at = 0;

  while (true) {
    const start = buffer.indexOf("stream", at);
    if (start === -1) break;
    // "endstream" contains "stream" — don't mistake a closer for an opener.
    if (buffer.subarray(start - 3, start).toString("latin1") === "end") {
      at = start + "stream".length;
      continue;
    }
    const end = buffer.indexOf("endstream", start);
    if (end === -1) break;

    // Skip the EOL that must follow the `stream` keyword (\r\n or \n).
    let from = start + "stream".length;
    if (buffer[from] === 0x0d) from++;
    if (buffer[from] === 0x0a) from++;

    const chunk = buffer.subarray(from, end);
    try {
      out.push(zlib.inflateSync(chunk).toString("latin1"));
    } catch {
      // Not a Flate stream — an embedded image, or already plain. Take it raw;
      // a marker sitting in an uncompressed stream still needs to be caught.
      out.push(chunk.toString("latin1"));
    }
    at = end + "endstream".length;
  }

  return out.join("\n");
};

// Text operators split a line into pieces and TJ arrays interleave kerning
// numbers, so a marker is routinely broken across several tokens. Pulling the
// string tokens out in document order and joining them puts it back together.
//
// PDFKit writes most runs as HEX strings (`<4a6573...> TJ`) rather than as
// `(literal)` strings — scanning for parenthesised text alone finds nothing at
// all, so both forms have to be decoded.
export const pdfVisibleText = (buffer) => {
  const raw = pdfText(buffer);
  const out = [];

  for (const m of raw.matchAll(/\((?:\\.|[^\\()])*\)|<([0-9a-fA-F\s]+)>/g)) {
    if (m[1] !== undefined) {
      const hex = m[1].replace(/\s+/g, "");
      if (hex.length % 2) continue;
      out.push(Buffer.from(hex, "hex").toString("latin1"));
    } else {
      out.push(m[0].slice(1, -1).replace(/\\([()\\])/g, "$1"));
    }
  }

  return out.join("");
};

// One question, both formats: does this file contain the other church's marker?
export const findMarkerInExport = async (buffer, marker, kind) => {
  const text = kind === "xlsx" ? await xlsxText(buffer) : pdfVisibleText(buffer);
  return text.includes(marker) ? `contains ${marker}` : null;
};
