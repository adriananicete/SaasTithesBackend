// End-to-end check for church-scoped reports and exports.
//
// This is the highest-consequence leak in the system: a report is the document
// a church prints, signs and files. A leak here is not a stray row on a screen
// — it is another church's collections and disbursements inside an audited
// financial record.
//
// So this check does not stop at the JSON endpoints. It downloads every Excel
// and PDF export as each church and reads what is actually inside the file,
// using `lib/exportScan.js`. The leak check used to record the exports as "not
// verifiable by scan" because an .xlsx is a ZIP and a PDF compresses its text
// — true of a raw-byte search, not of a parsed one.
//
// The two churches are given deliberately different amounts so a pooled figure
// shows up as a wrong number rather than only as a leaked name.
//
// Run:  npm run dev            (in one terminal)
//       npm run check:reports    (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Expense } from "../models/Expense.js";
import { Tithes } from "../models/TithesEntry.js";
import { xlsxText, pdfVisibleText } from "./lib/exportScan.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

let passed = 0;
let failed = 0;
const created = [];

const ok = (msg) => { console.log(`  ✓  ${msg}`); passed++; };
const bad = (msg, detail) => {
  console.log(`  ✗  ${msg}${detail ? `\n       ${detail}` : ""}`);
  failed++;
};
const is = (actual, expect, msg) =>
  actual === expect ? ok(msg) : bad(msg, `got ${actual}, expected ${expect}`);

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
};

// Exports come back as bytes, not JSON.
const download = async (path, token) => {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  return {
    status: res.status,
    type: res.headers.get("content-type") || "",
    buf: Buffer.from(await res.arrayBuffer()),
  };
};

const sumBy = (rows, key) => (rows ?? []).reduce((t, r) => t + (r[key] ?? 0), 0);

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);

const main = async () => {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run against production — this script creates and purges churches.");
    process.exit(1);
  }
  const email = process.env.SEED_SUPERADMIN_EMAIL;
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  if (!email || !password) {
    console.error("SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must be set.");
    process.exit(1);
  }

  await connectDB();
  console.log(`Checking ${BASE}`);

  const suLogin = await call("POST", "/auth/login", { body: { email, password } });
  const su = suLogin.json?.token;
  if (!su) {
    console.error(`superadmin login failed (${suLogin.status}): ${JSON.stringify(suLogin.json)}`);
    console.error("If this says too many attempts, restart the server — the rate limiter is in memory.");
    process.exit(1);
  }

  // The marker lives in the user NAMES, because that is what the exports print
  // (mapTithesRows reads submittedBy.name, mapExpenseRows reads recordedBy.name).
  // A marker hidden only in a field no export renders would prove nothing.
  const build = async (name, marker, slugHint, { recent, old, expenses }) => {
    const r = await call("POST", "/superadmin/churches", {
      token: su,
      body: { name, admin: { name: `${marker} Admin`, email: `admin@${slugHint}.test` } },
    });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(r.json)}`);
    const churchId = r.json.data.church._id;
    created.push([churchId, name]);

    const adminLogin = await call("POST", "/auth/login", {
      body: { church: churchId, email: `admin@${slugHint}.test`, password: r.json.data.adminPassword },
    });

    const admin = await User.findOne({ church: churchId, role: "admin" });
    const hashed = await bcrypt.hash("SeedPass123!", 10);
    const [member, other] = await User.insertMany([
      { church: churchId, name: `${marker} Member`, email: `member@${slugHint}.test`,
        password: hashed, role: "member", isActive: true },
      { church: churchId, name: `${marker} Other`, email: `other@${slugHint}.test`,
        password: hashed, role: "member", isActive: true },
    ]);
    const memberLogin = await call("POST", "/auth/login", {
      body: { church: churchId, email: `member@${slugHint}.test`, password: "SeedPass123!" },
    });

    const expenseCategory = await Category.findOne({ church: churchId, type: "expense" });

    await Tithes.insertMany([
      { church: churchId, entryDate: new Date(), serviceType: "Sunday Service",
        total: recent, status: "approved", submittedBy: member._id, reviewedBy: admin._id,
        remarks: `${marker} recent` },
      { church: churchId, entryDate: daysAgo(120), serviceType: "Special Service",
        total: old, status: "approved", submittedBy: other._id, reviewedBy: admin._id,
        remarks: `${marker} old` },
      // Pending never reaches a report — reports are actual collections.
      { church: churchId, entryDate: new Date(), serviceType: "Sunday Service",
        total: 777, status: "pending", submittedBy: member._id, remarks: `${marker} pending` },
    ]);

    await Expense.insertMany(
      expenses.map((amount, i) => ({
        church: churchId, source: "manual", amount,
        category: expenseCategory._id, date: new Date(), recordedBy: admin._id,
        remarks: `${marker} expense ${i + 1}`,
      })),
    );

    return {
      churchId, marker,
      token: adminLogin.json?.token,
      memberToken: memberLogin.json?.token,
      expected: {
        tithes: recent + old,
        tithesCount: 2,
        expenses: expenses.reduce((a, b) => a + b, 0),
        expenseCount: expenses.length,
        recent,
        memberOwn: recent,
      },
    };
  };

  const a = await build("Report Alpha", "REPALPHA", "ralpha", { recent: 5000, old: 3000, expenses: [1200, 300] });
  const b = await build("Report Beta", "REPBETA", "rbeta", { recent: 9000, old: 400, expenses: [4000] });

  // ------------------------------------------------------- the JSON reports --
  console.log("\nreport rows and totals are per church");
  for (const [label, c] of [["A", a], ["B", b]]) {
    const t = await call("GET", "/reports/tithes", { token: c.token });
    is(t.json?.count, c.expected.tithesCount, `church ${label} tithes report has ${c.expected.tithesCount} rows`);
    is(sumBy(t.json?.data, "total"), c.expected.tithes, `church ${label} tithes report totals ${c.expected.tithes}`);

    const e = await call("GET", "/reports/expense", { token: c.token });
    is(e.json?.count, c.expected.expenseCount, `church ${label} expense report has ${c.expected.expenseCount} rows`);
    is(sumBy(e.json?.data, "amount"), c.expected.expenses, `church ${label} expense report totals ${c.expected.expenses}`);
  }

  const aTithes = await call("GET", "/reports/tithes", { token: a.token });
  JSON.stringify(aTithes.json?.data ?? []).includes(b.marker)
    ? bad("church B appeared in church A's tithes report")
    : ok("church A's tithes report holds no church B row");

  const aExpense = await call("GET", "/reports/expense", { token: a.token });
  JSON.stringify(aExpense.json?.data ?? []).includes(b.marker)
    ? bad("church B appeared in church A's expense report")
    : ok("church A's expense report holds no church B row");

  console.log("\nthe combined report's NET position is this church's own");
  for (const [label, c] of [["A", a], ["B", b]]) {
    const r = await call("GET", "/reports/combined", { token: c.token });
    const net = c.expected.tithes - c.expected.expenses;
    is(r.json?.summary?.totalTithes, c.expected.tithes, `church ${label} combined totalTithes = ${c.expected.tithes}`);
    is(r.json?.summary?.totalExpenses, c.expected.expenses, `church ${label} combined totalExpenses = ${c.expected.expenses}`);
    is(r.json?.summary?.net, net, `church ${label} combined net = ${net}`);
  }

  const pooledNet = (a.expected.tithes + b.expected.tithes) - (a.expected.expenses + b.expected.expenses);
  const aCombined = await call("GET", "/reports/combined", { token: a.token });
  aCombined.json?.summary?.net !== pooledNet
    ? ok(`church A is not showing the pooled net (${pooledNet})`)
    : bad("church A's NET position is both churches' money combined");

  // ------------------------------------------------------- the date filter ---
  // A range must narrow the rows without ever widening the church.
  console.log("\na date range narrows rows without dropping the church filter");
  const range = `?startDate=${ymd(daysAgo(30))}&endDate=${ymd(daysAgo(-1))}`;
  const ranged = await call("GET", `/reports/tithes${range}`, { token: a.token });
  is(ranged.json?.count, 1, "church A's last-30-days tithes report has 1 row");
  is(sumBy(ranged.json?.data, "total"), a.expected.recent, `that row totals ${a.expected.recent}`);
  JSON.stringify(ranged.json?.data ?? []).includes(b.marker)
    ? bad("church B leaked into the ranged report")
    : ok("the ranged report is still church A only");

  // ------------------------------------------------------------ the member ---
  console.log("\na member's report is their own rows, in their own church");
  const memberTithes = await call("GET", "/reports/tithes", { token: a.memberToken });
  is(memberTithes.json?.count, 1, "the member sees only their own submission");
  is(sumBy(memberTithes.json?.data, "total"), a.expected.memberOwn, `it totals ${a.expected.memberOwn}`);
  JSON.stringify(memberTithes.json?.data ?? []).includes(b.marker)
    ? bad("church B leaked into a member's report")
    : ok("no church B row in the member's report");

  const memberExpense = await call("GET", "/reports/expense", { token: a.memberToken });
  is(memberExpense.status, 403, "a member reading the expense report is 403");

  // ----------------------------------------------------- the printed files ---
  // Read the file, don't reason about it.
  console.log("\nthe exported files contain one church's data only");
  const exports = [
    ["tithes excel", "/reports/tithes/export/excel", "xlsx"],
    ["tithes pdf", "/reports/tithes/export/pdf", "pdf"],
    ["expense excel", "/reports/expense/export/excel", "xlsx"],
    ["expense pdf", "/reports/expense/export/pdf", "pdf"],
    ["combined excel", "/reports/combined/export/excel", "xlsx"],
    ["combined pdf", "/reports/combined/export/pdf", "pdf"],
  ];

  for (const [label, path, kind] of exports) {
    const file = await download(path, a.token);
    if (file.status !== 200) {
      bad(`${label} download failed`, `status ${file.status}`);
      continue;
    }
    const text = kind === "xlsx" ? await xlsxText(file.buf) : pdfVisibleText(file.buf);

    if (!text.length) {
      bad(`${label} — nothing could be read out of the file`,
        "the scan cannot tell clean from leaking here");
      continue;
    }
    if (text.includes(b.marker)) {
      bad(`${label} contains church B's data`, `found ${b.marker}`);
      continue;
    }
    text.includes(a.marker)
      ? ok(`${label} — church A's rows present, church B's absent (${file.buf.length} bytes read)`)
      : bad(`${label} — church A's own rows are missing`, "the export may be empty");
  }

  // The same file as church B must differ, or the scan is reading something
  // that is not really per-church.
  const aXlsx = await download("/reports/combined/export/excel", a.token);
  const bXlsx = await download("/reports/combined/export/excel", b.token);
  const aText = await xlsxText(aXlsx.buf);
  const bText = await xlsxText(bXlsx.buf);
  aText.includes(a.marker) && !aText.includes(b.marker) &&
  bText.includes(b.marker) && !bText.includes(a.marker)
    ? ok("each church's combined workbook carries only its own names")
    : bad("the two churches' combined workbooks are not cleanly separated");

  return su;
};

let token = null;
try {
  token = await main();
} catch (error) {
  bad("check crashed", error.message);
  if (error.cause?.code === "ECONNREFUSED") {
    console.error("\nNothing is listening. Start the server with `npm run dev` first.");
  }
} finally {
  if (token) {
    for (const [id, name] of created) {
      if (id) await call("DELETE", `/superadmin/churches/${id}/purge`, { token, body: { confirmName: name } });
    }
    const left = await call("GET", "/superadmin/churches", { token });
    left.json?.count === 0
      ? ok("test data cleaned up (0 churches remain)")
      : bad(`${left.json?.count ?? "?"} churches left behind — check manually`);
  }
  if (mongoose.connection.readyState) await mongoose.disconnect();
}

console.log(`\n${failed === 0 ? "ALL PASSED" : "FAILED"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
