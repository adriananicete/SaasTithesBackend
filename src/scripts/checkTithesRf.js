// End-to-end check for church-scoped tithes and request forms.
//
// The part that matters most is not leakage but arithmetic: totalBalance and
// availableBalance gate how much a church may request, and unscoped they summed
// every church's money into one figure — so each church saw a balance that was
// not its own. Two churches are given deliberately DIFFERENT amounts here, so a
// pooled total would show up as a wrong number rather than as a leaked marker.
//
// Run:  npm run dev            (in one terminal)
//       npm run check:tithes-rf   (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";
import { Tithes } from "../models/TithesEntry.js";
import { Expense } from "../models/Expense.js";
import { Category } from "../models/Category.js";
import { RequestForm } from "../models/RequestForm.js";
import {
  migrateServiceTypeSpelling,
  OLD_SERVICE_TYPE,
  NEW_SERVICE_TYPE,
} from "./migrateServiceTypeSpelling.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

let passed = 0;
let failed = 0;
let baselineChurches = null;
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

  const before = await call("GET", "/superadmin/churches", { token: su });
  baselineChurches = before.json?.count ?? 0;

  // Deliberately different amounts, so a pooled figure is a wrong number.
  const build = async (name, slugHint, { approved, pending, expense }) => {
    const r = await call("POST", "/superadmin/churches", {
      token: su,
      body: { name, admin: { name: `${name} Admin`, email: `admin@${slugHint}.test` } },
    });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(r.json)}`);
    const churchId = r.json.data.church._id;
    created.push([churchId, name]);

    const login = await call("POST", "/auth/login", {
      body: { church: churchId, email: `admin@${slugHint}.test`, password: r.json.data.adminPassword },
    });

    const admin = await User.findOne({ church: churchId, role: "admin" });
    const hashed = await bcrypt.hash("SeedPass123!", 10);
    const member = await User.create({
      church: churchId, name: `${name} Member`, email: `member@${slugHint}.test`,
      password: hashed, role: "member", isActive: true,
    });
    const rfCategory = await Category.findOne({ church: churchId, type: "rf" });
    const expenseCategory = await Category.findOne({ church: churchId, type: "expense" });

    await Tithes.insertMany([
      { church: churchId, entryDate: new Date(), serviceType: "Sunday Service",
        total: approved, status: "approved", submittedBy: member._id, reviewedBy: admin._id },
      { church: churchId, entryDate: new Date(), serviceType: "Special Service",
        total: pending, status: "pending", submittedBy: member._id },
    ]);
    await Expense.create({
      church: churchId, source: "manual", amount: expense,
      category: expenseCategory._id, date: new Date(), recordedBy: admin._id,
      remarks: `${name} expense`,
    });
    const rf = await RequestForm.create({
      church: churchId, rfNo: "RF-0001", entryDate: new Date(),
      category: rfCategory._id, requestedBy: member._id,
      estimatedAmount: 500, remarks: `${name} rf`, status: "submitted",
    });

    return { churchId, token: login.json?.token, rf, member, admin, expected: { approved, pending, expense } };
  };

  const a = await build("Money Alpha", "malpha", { approved: 5000, pending: 2000, expense: 1200 });
  const b = await build("Money Beta", "mbeta", { approved: 9000, pending: 300, expense: 4000 });

  // ------------------------------------------------------------ the money ---
  console.log("\nbalances are per church, not pooled");
  for (const [label, c] of [["A", a], ["B", b]]) {
    const r = await call("GET", "/tithes", { token: c.token });
    const wantTotal = c.expected.approved + c.expected.pending;
    const wantAvailable = c.expected.approved - c.expected.expense;

    r.json?.totalBalance === wantTotal
      ? ok(`church ${label} totalBalance = ${wantTotal} (its own tithes only)`)
      : bad(`church ${label} totalBalance was ${r.json?.totalBalance}, expected ${wantTotal}`);

    r.json?.availableBalance === wantAvailable
      ? ok(`church ${label} availableBalance = ${wantAvailable} (approved − its own expenses)`)
      : bad(`church ${label} availableBalance was ${r.json?.availableBalance}, expected ${wantAvailable}`);
  }

  const pooledTotal = a.expected.approved + a.expected.pending + b.expected.approved + b.expected.pending;
  const aRes = await call("GET", "/tithes", { token: a.token });
  aRes.json?.totalBalance !== pooledTotal
    ? ok(`church A is not showing the pooled figure (${pooledTotal})`)
    : bad("church A is showing both churches' money summed together");

  // ------------------------------------------------------------- the rows ---
  console.log("\nrows and charts are church-scoped");
  const remarksA = JSON.stringify(aRes.json?.data ?? []);
  remarksA.includes("Money Beta")
    ? bad("church B's tithes appeared in church A's table")
    : ok(`church A's table holds only its own rows (count=${aRes.json?.count})`);

  aRes.json?.chartData?.length === 2
    ? ok("chartData covers this church's entries only (2)")
    : bad(`chartData had ${aRes.json?.chartData?.length} entries, expected 2`);

  const rfList = await call("GET", "/request-form", { token: a.token });
  JSON.stringify(rfList.json?.data ?? []).includes("Money Beta")
    ? bad("church B's request forms appeared in church A's list")
    : ok(`church A's RF list holds only its own (count=${rfList.json?.count})`);

  // --------------------------------------------------------- cross writes ---
  console.log("\ncross-church actions are refused");
  const bTithes = await Tithes.findOne({ church: b.churchId, status: "pending" });
  for (const [method, path, body] of [
    ["PATCH", `/tithes/${bTithes._id}`, { remarks: "hijacked" }],
    ["PATCH", `/tithes/${bTithes._id}/approve`, {}],
    ["PATCH", `/tithes/${bTithes._id}/reject`, { rejectionNote: "no" }],
    ["PATCH", `/request-form/${b.rf._id}`, { remarks: "hijacked" }],
    ["PATCH", `/request-form/${b.rf._id}/validate`, {}],
    ["PATCH", `/request-form/${b.rf._id}/reject`, { rejectionNote: "no" }],
    ["PATCH", `/request-form/${b.rf._id}/submit`, {}],
    ["DELETE", `/request-form/${b.rf._id}`, null],
    ["GET", `/request-form/${b.rf._id}/comments`, null],
    ["POST", `/request-form/${b.rf._id}/comments`, { text: "hijacked" }],
  ]) {
    const r = await call(method, path, { token: a.token, ...(body ? { body } : {}) });
    const label = `${method} ${path.replace(/[0-9a-f]{24}/g, ":churchB_id")}`;
    r.status === 404
      ? ok(`404 ${label}`)
      : bad(`${label} returned ${r.status}, expected 404`);
  }

  const untouched = await Tithes.findById(bTithes._id);
  untouched.status === "pending" && !untouched.reviewedBy
    ? ok("church B's tithes entry is untouched after every attempt")
    : bad(`church B's entry became status=${untouched.status}`);

  const rfUntouched = await RequestForm.findById(b.rf._id);
  rfUntouched.status === "submitted"
    ? ok("church B's request form is untouched")
    : bad(`church B's RF became status=${rfUntouched.status}`);

  // ---------------------------------------------------------- numbering ----
  console.log("\nRF numbering restarts per church");
  const bRfList = await call("GET", "/request-form", { token: b.token });
  const aRfNos = (rfList.json?.data ?? []).map((r) => r.rfNo);
  const bRfNos = (bRfList.json?.data ?? []).map((r) => r.rfNo);
  aRfNos.includes("RF-0001") && bRfNos.includes("RF-0001")
    ? ok("both churches have their own RF-0001 — numbering is per church")
    : bad(`A: ${aRfNos.join(",")} · B: ${bRfNos.join(",")}`);

  // ------------------------------------------------ the serviceType typo ----
  // §14 item 6. Runs last because it adds rows, and the balance assertions
  // above are exact.
  console.log("\nthe Anniversary spelling is corrected (§14 item 6)");
  const submit = (serviceType) =>
    call("POST", "/tithes", {
      token: a.token,
      body: {
        entryDate: new Date(), serviceType,
        denominations: [{ bill: 100, qty: 1, subtotal: 100 }], total: 100,
      },
    });

  const correct = await submit(NEW_SERVICE_TYPE);
  is(correct.status, 201, `"${NEW_SERVICE_TYPE}" is accepted`);

  const typo = await submit(OLD_SERVICE_TYPE);
  is(typo.status, 400, `"${OLD_SERVICE_TYPE}" is refused — the typo is out of the enum`);

  // The migration only ever runs once, against real data, so the empty-database
  // path this repo has proves nothing. Plant a row carrying the old spelling —
  // through the driver, since the model would now reject it — and migrate it.
  console.log("\nthe migration moves a row that carries the old spelling");
  const planted = await Tithes.collection.insertOne({
    church: new mongoose.Types.ObjectId(a.churchId),
    entryDate: new Date(),
    serviceType: OLD_SERVICE_TYPE,
    total: 250,
    status: "pending",
    submittedBy: new mongoose.Types.ObjectId(a.member._id),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  is(await Tithes.countDocuments({ serviceType: OLD_SERVICE_TYPE }), 1,
    "a row with the old spelling exists");

  const result = await migrateServiceTypeSpelling();
  is(result.before, 1, "the migration found it");
  is(result.modified, 1, "and updated it");
  is(result.remaining, 0, "leaving none behind");

  const moved = await Tithes.findById(planted.insertedId);
  is(moved?.serviceType, NEW_SERVICE_TYPE, "the row now carries the correct spelling");

  // Idempotent: a second run must be a no-op, not an error.
  const second = await migrateServiceTypeSpelling();
  is(second.before, 0, "a second run finds nothing to do");

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
    const expected = baselineChurches ?? 0;
    left.json?.count === expected
      ? ok(`test data cleaned up (${expected} church(es) remain, as before the run)`)
      : bad(`${left.json?.count ?? "?"} churches remain, expected ${expected} — check manually`);
  }
  if (mongoose.connection.readyState) await mongoose.disconnect();
}

console.log(`\n${failed === 0 ? "ALL PASSED" : "FAILED"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
