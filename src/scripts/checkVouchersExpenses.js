// End-to-end check for church-scoped vouchers and expenses.
//
// Two things are being proved here. The first is isolation: one church's
// vouchers and expense ledger must never appear in another's. The second is
// arithmetic — the expense ledger is one half of `availableBalance`, so a
// pooled ledger does not merely leak rows, it tells every church it has less
// money than it does. The two churches are therefore given deliberately
// DIFFERENT amounts, so a pooled figure shows up as a wrong number rather than
// as a marker that a sloppy assertion might miss.
//
// It also covers the authorisation hole folded into this branch
// (businessRequirements §14 item 1): GET /api/expenses had no role check at
// all, so any member could pull the full per-transaction ledger.
//
// Run:  npm run dev             (in one terminal)
//       npm run check:vouchers    (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Expense } from "../models/Expense.js";
import { Voucher } from "../models/Voucher.js";
import { RequestForm } from "../models/RequestForm.js";
import { autoRecordExpense } from "../utils/autoRecordExpense.js";

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

const sum = (rows) => (rows ?? []).reduce((t, r) => t + (r.amount ?? 0), 0);

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

  // Seeded through the models, not the API: creating a voucher through
  // POST /api/vouchers requires a real receipt upload to Cloudinary, which a
  // check script has no business doing. The API paths that do not need a file
  // — list, cancel, and the cross-church rejections — are exercised below.
  const build = async (name, marker, slugHint, { voucherAmount, manualAmount }) => {
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
    const [member, auditor] = await User.insertMany([
      { church: churchId, name: `${marker} Member`, email: `member@${slugHint}.test`,
        password: hashed, role: "member", isActive: true },
      { church: churchId, name: `${marker} Auditor`, email: `auditor@${slugHint}.test`,
        password: hashed, role: "auditor", isActive: true },
    ]);

    const logIn = async (who) => {
      const res = await call("POST", "/auth/login", {
        body: { church: churchId, email: who.email, password: "SeedPass123!" },
      });
      return res.json?.token;
    };

    const rfCategory = await Category.findOne({ church: churchId, type: "rf" });
    const expenseCategory = await Category.findOne({ church: churchId, type: "expense" });

    const rf = await RequestForm.create({
      church: churchId, rfNo: "RF-0001", entryDate: new Date(),
      category: rfCategory._id, requestedBy: member._id, estimatedAmount: voucherAmount,
      remarks: `${marker} rf`, status: "approved",
    });
    const voucher = await Voucher.create({
      church: churchId, pcfNo: "PCF-0001", rfId: rf._id, date: new Date(),
      category: expenseCategory._id, amount: voucherAmount, createdBy: admin._id,
      receipts: [`https://example.test/${marker}-receipt.jpg`],
    });
    await RequestForm.findByIdAndUpdate(rf._id, {
      $set: { voucherId: voucher._id, status: "voucher_created", voucherCreatedAt: new Date() },
    });

    await Expense.insertMany([
      { church: churchId, source: "voucher", linkedId: voucher._id, amount: voucherAmount,
        category: expenseCategory._id, date: new Date(), recordedBy: admin._id,
        remarks: `${marker} expense from voucher` },
      { church: churchId, source: "manual", amount: manualAmount,
        category: expenseCategory._id, date: new Date(), recordedBy: admin._id,
        remarks: `${marker} expense manual` },
    ]);

    return {
      churchId, marker, voucher, rf, admin, expenseCategory, rfCategory,
      token: adminLogin.json?.token,
      memberToken: await logIn(member),
      auditorToken: await logIn(auditor),
      expected: { ledger: voucherAmount + manualAmount, rows: 2 },
    };
  };

  const a = await build("Vouch Alpha", "VOUCHALPHA", "valpha", { voucherAmount: 900, manualAmount: 400 });
  const b = await build("Vouch Beta", "VOUCHBETA", "vbeta", { voucherAmount: 2500, manualAmount: 700 });

  // ---------------------------------------------------------- the ledger ----
  console.log("\nthe expense ledger is per church, not pooled");
  for (const [label, c] of [["A", a], ["B", b]]) {
    const r = await call("GET", "/expenses", { token: c.token });
    is(r.json?.count, c.expected.rows, `church ${label} sees ${c.expected.rows} expense rows — its own only`);
    is(sum(r.json?.data), c.expected.ledger, `church ${label} ledger totals ${c.expected.ledger}`);
  }

  const aLedger = await call("GET", "/expenses", { token: a.token });
  JSON.stringify(aLedger.json?.data ?? []).includes(b.marker)
    ? bad("church B's expenses appeared in church A's ledger")
    : ok("church A's ledger holds no church B row");

  const pooled = a.expected.ledger + b.expected.ledger;
  sum(aLedger.json?.data) !== pooled
    ? ok(`church A is not showing the pooled ledger (${pooled})`)
    : bad("church A's ledger is both churches' expenses summed together");

  console.log("\nthe by-category chart is per church too");
  for (const [label, c] of [["A", a], ["B", b]]) {
    const r = await call("GET", "/expenses/by-category", { token: c.token });
    is(sum(r.json?.data), c.expected.ledger,
      `church ${label} by-category totals ${c.expected.ledger} (aggregate $match is scoped)`);
  }

  // --------------------------------------------------------- the vouchers ---
  console.log("\nvouchers are church-scoped");
  const aVouchers = await call("GET", "/vouchers", { token: a.token });
  is(aVouchers.json?.count, 1, "church A sees exactly its own one voucher");
  JSON.stringify(aVouchers.json?.data ?? []).includes(b.marker)
    ? bad("church B's voucher appeared in church A's list")
    : ok("church A's voucher list holds no church B row");

  const bVouchers = await call("GET", "/vouchers", { token: b.token });
  (bVouchers.json?.data ?? []).every((v) => v.pcfNo === "PCF-0001")
    ? ok("both churches hold their own PCF-0001 — numbering is per church")
    : bad(`church B's PCF numbers were ${(bVouchers.json?.data ?? []).map((v) => v.pcfNo).join(",")}`);

  // ----------------------------------------------------- cross-church ops ---
  console.log("\ncross-church actions are refused");
  const cancelB = await call("PATCH", `/vouchers/${b.voucher._id}/cancel`, {
    token: a.token, body: { cancellationNote: "hijacked" },
  });
  is(cancelB.status, 404, "church A cancelling church B's voucher is 404");

  const bVoucherAfter = await Voucher.findById(b.voucher._id);
  is(bVoucherAfter.status, "approved", "church B's voucher is still approved after the attempt");

  // The reversal in cancelVoucher deletes the voucher's auto-recorded expense.
  // Unscoped, a cross-church cancel would have deleted church B's expense row
  // even though the cancel itself failed — so this is the assertion that the
  // deleteOne filter carries the church.
  const bLinked = await Expense.findOne({ source: "voucher", linkedId: b.voucher._id });
  bLinked
    ? ok("church B's auto-recorded expense survived the attempt")
    : bad("church B's expense row was deleted by church A's failed cancel");

  const createFromBrf = await call("POST", "/vouchers", {
    token: a.token, body: { rfId: String(b.rf._id), category: String(a.expenseCategory._id), amount: 100 },
  });
  is(createFromBrf.status, 404, "church A creating a voucher against church B's RF is 404");

  const createWithBcategory = await call("POST", "/vouchers", {
    token: a.token, body: { rfId: String(a.rf._id), category: String(b.expenseCategory._id), amount: 100 },
  });
  is(createWithBcategory.status, 404, "church A borrowing church B's category on a voucher is 404");

  const manualWithBcategory = await call("POST", "/expenses", {
    token: a.token,
    body: { amount: 100, category: String(b.expenseCategory._id), date: new Date(), remarks: "borrowed" },
  });
  is(manualWithBcategory.status, 404, "church A borrowing church B's category on a manual expense is 404");

  // ------------------------------------------------------- the write path ---
  console.log("\na manual expense is stamped with the caller's church");
  const manual = await call("POST", "/expenses", {
    token: a.token,
    body: { amount: 250, category: String(a.expenseCategory._id), date: new Date(), remarks: `${a.marker} new manual` },
  });
  is(manual.status, 201, "church A's admin records a manual expense");
  is(String(manual.json?.data?.church), String(a.churchId), "the new expense carries church A");

  const bLedgerAfter = await call("GET", "/expenses", { token: b.token });
  JSON.stringify(bLedgerAfter.json?.data ?? []).includes("new manual")
    ? bad("church A's new expense appeared in church B's ledger")
    : ok("church B's ledger is unchanged by church A's write");

  // autoRecordExpense has no `req` — it takes the church off the voucher it is
  // recording. Called directly because the API path that reaches it requires a
  // real Cloudinary receipt upload.
  const auto = await Voucher.create({
    church: a.churchId, pcfNo: "PCF-0002", rfId: a.rf._id, date: new Date(),
    category: a.expenseCategory._id, amount: 50, createdBy: a.admin._id,
    receipts: ["https://example.test/auto-receipt.jpg"],
  });
  await autoRecordExpense(auto);
  const autoExpense = await Expense.findOne({ source: "voucher", linkedId: auto._id });
  autoExpense && String(autoExpense.church) === String(a.churchId)
    ? ok("autoRecordExpense stamps the church off the voucher")
    : bad(`the auto-recorded expense carried church ${autoExpense?.church ?? "none"}`);

  // -------------------------------------------------- the ledger role gate --
  // businessRequirements §14 item 1 — the full ledger was readable by anyone.
  console.log("\nthe full ledger is admin/auditor only (§14 item 1)");
  const memberLedger = await call("GET", "/expenses", { token: a.memberToken });
  is(memberLedger.status, 403, "a member reading the full expense ledger is 403");

  const auditorLedger = await call("GET", "/expenses", { token: a.auditorToken });
  is(auditorLedger.status, 200, "an auditor still reads the full ledger");

  const memberChart = await call("GET", "/expenses/by-category", { token: a.memberToken });
  is(memberChart.status, 200, "a member still reads the aggregated by-category chart");

  const memberWrite = await call("POST", "/expenses", {
    token: a.memberToken,
    body: { amount: 10, category: String(a.expenseCategory._id), date: new Date(), remarks: "nope" },
  });
  is(memberWrite.status, 403, "a member recording a manual expense is 403");

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
