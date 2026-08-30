// The two money-correctness gaps: businessRequirements §14 items 2 and 5.
//
// They are checked together because they are the same failure from two ends.
// `availableBalance = approved tithes − expenses` decides how much a church may
// request. Item 2 was that nothing on the BACKEND enforced that cap, so a
// direct API call could ask for more than the church holds. Item 5 was that a
// failed expense write was swallowed, so the ledger could be missing a
// disbursement — which OVERSTATES the balance, and the next request is then
// approved against money that is already gone.
//
// One of them lets you overspend a correct number; the other quietly makes the
// number wrong. Fixed apart, they still meet in the same place.
//
// Run:  npm run dev           (in one terminal)
//       npm run check:money     (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Tithes } from "../models/TithesEntry.js";
import { Expense } from "../models/Expense.js";
import { Voucher } from "../models/Voucher.js";
import { autoRecordExpense } from "../utils/autoRecordExpense.js";
import { getAvailableBalance, peso } from "../utils/balance.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

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

const sendForm = async (method, path, token, fields, files = []) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  for (const f of files) {
    form.append(f.field, new Blob([f.buffer], { type: "image/png" }), f.name);
  }
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    body: form,
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

  // `approved` decides the balance; `pending` must not count toward it.
  const build = async (name, slugHint, { approved, pending = 0 }) => {
    const r = await call("POST", "/superadmin/churches", {
      token: su,
      body: { name, admin: { name: `${slugHint} admin`, email: `admin@${slugHint}.test` } },
    });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(r.json)}`);
    const churchId = r.json.data.church._id;
    created.push([churchId, name]);

    const adminLogin = await call("POST", "/auth/login", {
      body: { church: churchId, email: `admin@${slugHint}.test`, password: r.json.data.adminPassword },
    });

    const admin = await User.findOne({ church: churchId, role: "admin" });
    const hashed = await bcrypt.hash("SeedPass123!", 10);
    const [member, validator, pastor] = await User.insertMany([
      { church: churchId, name: `${slugHint} member`, email: `member@${slugHint}.test`,
        password: hashed, role: "member", isActive: true },
      { church: churchId, name: `${slugHint} validator`, email: `validator@${slugHint}.test`,
        password: hashed, role: "validator", isActive: true },
      { church: churchId, name: `${slugHint} pastor`, email: `pastor@${slugHint}.test`,
        password: hashed, role: "pastor", isActive: true },
    ]);
    const logIn = async (handle) => {
      const res = await call("POST", "/auth/login", {
        body: { church: churchId, email: `${handle}@${slugHint}.test`, password: "SeedPass123!" },
      });
      return res.json?.token;
    };

    const rows = [];
    if (approved > 0) {
      rows.push({ church: churchId, entryDate: new Date(), serviceType: "Sunday Service",
        total: approved, status: "approved", submittedBy: member._id, reviewedBy: admin._id });
    }
    if (pending > 0) {
      rows.push({ church: churchId, entryDate: new Date(), serviceType: "Special Service",
        total: pending, status: "pending", submittedBy: member._id });
    }
    if (rows.length) await Tithes.insertMany(rows);

    return {
      churchId, name, slugHint, admin, member,
      rfCategory: await Category.findOne({ church: churchId, type: "rf" }),
      expenseCategory: await Category.findOne({ church: churchId, type: "expense" }),
      token: adminLogin.json?.token,
      memberToken: await logIn("member"),
      validatorToken: await logIn("validator"),
      pastorToken: await logIn("pastor"),
      approved,
    };
  };

  const makeRf = (c, amount, label) =>
    call("POST", "/request-form", {
      token: c.memberToken,
      body: {
        entryDate: new Date(), category: String(c.rfCategory._id),
        estimatedAmount: amount, remarks: `${c.slugHint} ${label}`,
      },
    });

  // Church A holds 5000 approved plus 9000 pending — the pending must not
  // raise the cap. Church B is deliberately rich, to prove A's cap is A's own.
  const a = await build("Ledger Alpha", "ledgera", { approved: 5000, pending: 9000 });
  const b = await build("Ledger Beta", "ledgerb", { approved: 90000 });
  const broke = await build("Ledger Zero", "ledgerz", { approved: 0, pending: 4000 });

  // -------------------------------------------------------------- item 2 ----
  console.log("\nthe backend caps a request at the church's own balance (§14 item 2)");
  const tithesA = await call("GET", "/tithes", { token: a.token });
  is(tithesA.json?.availableBalance, 5000, "church A's availableBalance is 5000 (pending does not count)");

  const under = await makeRf(a, 4000, "under the balance");
  is(under.status, 201, "a request under the balance is created");

  const over = await makeRf(a, 6000, "over the balance");
  is(over.status, 400, "a request over the balance is refused");
  is(over.json?.error, `Amount exceeds available tithes balance (${peso(5000)})`,
    "with the same wording the client already shows");

  // The boundary itself: exactly the balance is allowed, one peso more is not.
  const exact = await makeRf(a, 5000, "exactly the balance");
  is(exact.status, 201, "a request for exactly the balance is allowed");

  const overByOne = await makeRf(a, 5001, "one peso over");
  is(overByOne.status, 400, "one peso over is refused");

  console.log("\na church with nothing gets the zero-balance message");
  const zero = await makeRf(broke, 100, "anything");
  is(zero.status, 400, "any request is refused");
  is(zero.json?.error,
    "The church has no available tithes balance — no requests can be made right now",
    "with the client's zero-balance wording");

  console.log("\nthe cap is this church's money, not the neighbour's");
  const richNeighbour = await call("GET", "/tithes", { token: b.token });
  is(richNeighbour.json?.availableBalance, 90000, "church B holds 90000");
  const stillCapped = await makeRf(a, 6000, "still over");
  is(stillCapped.status, 400, "church A is still capped at its own 5000");

  console.log("\nediting a draft still skips the check, by design (§5.4)");
  const draft = await makeRf(a, 100, "small draft");
  const edited = await call("PATCH", `/request-form/${draft.json?.data?._id}`, {
    token: a.memberToken, body: { estimatedAmount: 999999 },
  });
  is(edited.status, 200, "a draft can be edited over the balance — validators catch it at review");

  // -------------------------------------------------------------- item 5 ----
  console.log("\nthe expense write no longer fails silently (§14 item 5)");
  let threw = false;
  try {
    // No church — Expense.church is required, so the save must reject. This
    // used to be swallowed and resolve as if it had worked.
    await autoRecordExpense({
      _id: new mongoose.Types.ObjectId(),
      amount: 100,
      category: a.expenseCategory._id,
      date: new Date(),
      createdBy: a.admin._id,
    });
  } catch {
    threw = true;
  }
  threw
    ? ok("autoRecordExpense throws when the expense cannot be written")
    : bad("autoRecordExpense still swallows its error — a voucher could exist with no expense");

  console.log("\nthe happy path still records both, and the balance moves");
  // Walk church B up to a voucher, since it can afford one.
  const rfB = await makeRf(b, 900, "sound system");
  const rfId = rfB.json?.data?._id;
  await call("PATCH", `/request-form/${rfId}/submit`, { token: b.memberToken });
  await call("PATCH", `/request-form/${rfId}/validate`, { token: b.validatorToken });
  await call("PATCH", `/request-form/${rfId}/approve`, { token: b.pastorToken });

  const voucher = await sendForm("POST", "/vouchers", b.validatorToken, {
    rfId, category: String(b.expenseCategory._id), amount: 900, remarks: "sound system",
  }, [{ field: "receipts", buffer: ONE_PIXEL_PNG, name: "receipt.png" }]);
  is(voucher.status, 200, "the voucher is created");

  const voucherDoc = await Voucher.findOne({ church: b.churchId });
  const expenseDoc = await Expense.findOne({ church: b.churchId, source: "voucher" });
  voucherDoc && expenseDoc
    ? ok("the voucher and its expense both exist — neither without the other")
    : bad(`voucher: ${Boolean(voucherDoc)}, expense: ${Boolean(expenseDoc)}`);
  is(String(expenseDoc?.linkedId), String(voucherDoc?._id), "the expense points at the voucher");

  const afterSpend = await getAvailableBalance(b.churchId);
  is(afterSpend, 90000 - 900, "and the balance dropped by the amount spent");

  const cappedNow = await call("GET", "/tithes", { token: b.token });
  is(cappedNow.json?.availableBalance, 89100,
    "GET /tithes agrees with the number the cap uses — one definition, not two");

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
