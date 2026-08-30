// Purge atomicity — the open risk carried in MULTI_CHURCH_PLAN.md since
// 2026-08-29.
//
// The old handler ran eleven deleteMany calls as one Promise.all and removed
// the Church document LAST. A burst that failed part-way left some collections
// emptied and others not, while the church itself survived — still listed,
// still usable, quietly missing data. That is the outcome worth designing
// against: not lost rows, but a WORKING church with holes in it.
//
// The fix inverts the order, so this check does the only thing that can prove
// it: it creates the half-purged state on purpose, by deleting the Church
// document and leaving every row behind, then asks two questions.
//
//   1. Is anything reachable in that state?   (it must not be)
//   2. Does running the purge again finish it? (it must)
//
// Run:  npm run dev          (in one terminal)
//       npm run check:purge    (in another)

import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { seedChurch } from "./lib/seedChurches.js";
import { Church } from "../models/Church.js";
import { User } from "../models/User.js";
import { Tithes } from "../models/TithesEntry.js";
import { RequestForm } from "../models/RequestForm.js";
import { Voucher } from "../models/Voucher.js";
import { Expense } from "../models/Expense.js";
import { Category } from "../models/Category.js";
import { Counter } from "../models/Counter.js";
import { AuditLog } from "../models/AuditLog.js";

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
  let text = "";
  try { text = await res.text(); } catch { /* empty */ }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
};

// Every collection a purge has to reach, counted for one church.
const countRows = async (churchId) => {
  const userIds = await User.find({ church: churchId }).distinct("_id");
  const rfIds = await RequestForm.find({ church: churchId }).distinct("_id");
  const [tithes, rfs, vouchers, expenses, categories, counters, auditLogs, users] =
    await Promise.all([
      Tithes.countDocuments({ church: churchId }),
      RequestForm.countDocuments({ church: churchId }),
      Voucher.countDocuments({ church: churchId }),
      Expense.countDocuments({ church: churchId }),
      Category.countDocuments({ church: churchId }),
      Counter.countDocuments({ church: churchId }),
      AuditLog.countDocuments({ church: churchId }),
      User.countDocuments({ church: churchId }),
    ]);
  return {
    total: tithes + rfs + vouchers + expenses + categories + counters + auditLogs + users,
    detail: { tithes, rfs, vouchers, expenses, categories, counters, auditLogs, users },
    userIds,
    rfIds,
  };
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

  const beforeRun = await call("GET", "/superadmin/churches", { token: su });
  baselineChurches = beforeRun.json?.count ?? 0;

  // ------------------------------------------------- the ordinary purge ----
  console.log("\na complete purge still removes everything");
  const whole = await seedChurch({
    call, token: su, name: "Purge Whole", marker: "PURGEWHOLE", slugHint: "pwhole",
  });
  created.push([whole.churchId, "Purge Whole"]);

  const beforeWhole = await countRows(whole.churchId);
  beforeWhole.total > 0
    ? ok(`the church holds ${beforeWhole.total} rows across its collections`)
    : bad("the seed produced nothing to purge");

  const wrongName = await call("DELETE", `/superadmin/churches/${whole.churchId}/purge`, {
    token: su, body: { confirmName: "Not The Name" },
  });
  is(wrongName.status, 400, "a wrong confirmName is still refused");

  const purged = await call("DELETE", `/superadmin/churches/${whole.churchId}/purge`, {
    token: su, body: { confirmName: "Purge Whole" },
  });
  is(purged.status, 200, "the purge succeeds with the right name");
  is(purged.json?.data?.resumed, false, "and reports itself as a first pass, not a resume");

  const afterWhole = await countRows(whole.churchId);
  is(afterWhole.total, 0, "every row is gone");
  is(await Church.countDocuments({ _id: whole.churchId }), 0, "and so is the church");

  // ------------------------------------------- the half-purged state ------
  // Recreating what a mid-burst failure used to leave behind — except the old
  // code left the CHURCH alive and the rows half gone, which is the dangerous
  // way round. The new order can only ever leave the opposite.
  console.log("\na purge that stops part-way leaves nothing reachable");
  const half = await seedChurch({
    call, token: su, name: "Purge Half", marker: "PURGEHALF", slugHint: "phalf",
  });
  created.push([half.churchId, "Purge Half"]);

  const beforeHalf = await countRows(half.churchId);
  beforeHalf.total > 0
    ? ok(`the church holds ${beforeHalf.total} rows before the simulated failure`)
    : bad("nothing was seeded");

  // The Church document goes, every row stays — exactly the state the new
  // handler leaves if the sweep throws on its first collection.
  await Church.findByIdAndDelete(half.churchId);

  const stillThere = await countRows(half.churchId);
  is(stillThere.total, beforeHalf.total, "the rows are all still in the database");

  const listed = await call("GET", "/superadmin/churches", { token: su });
  JSON.stringify(listed.json?.data ?? []).includes(String(half.churchId))
    ? bad("the half-purged church is still listed")
    : ok("it is gone from the church list");

  const loginAttempt = await call("POST", "/auth/login", {
    body: { church: half.churchId, email: half.adminEmail, password: half.adminPassword },
  });
  loginAttempt.status === 200
    ? bad("its admin can still log in", `status ${loginAttempt.status}`)
    : ok(`its admin can no longer log in (${loginAttempt.status})`);

  const dropdown = await call("GET", "/auth/churches");
  JSON.stringify(dropdown.json ?? {}).includes(String(half.churchId))
    ? bad("it still appears in the public login dropdown")
    : ok("and it is not in the public login dropdown");

  // ----------------------------------------------------- resuming ---------
  console.log("\nrunning the purge again finishes the job");
  const resumed = await call("DELETE", `/superadmin/churches/${half.churchId}/purge`, {
    token: su, body: {},
  });
  is(resumed.status, 200, "the purge runs again with no confirmName — there is no name left to type");
  is(resumed.json?.data?.resumed, true, "and reports itself as a resume");

  const afterHalf = await countRows(half.churchId);
  is(afterHalf.total, 0, `all ${beforeHalf.total} leftover rows are swept`);

  const comments = await mongoose.connection
    .collection("comments")
    .countDocuments({ refId: { $in: beforeHalf.rfIds } });
  is(comments, 0, "including the comments hanging off its request forms");

  const notifs = await mongoose.connection
    .collection("notifications")
    .countDocuments({ userId: { $in: beforeHalf.userIds } });
  is(notifs, 0, "and the notifications hanging off its users");

  // ------------------------------------------------- idempotence ----------
  console.log("\nand it is safe to keep running");
  const again = await call("DELETE", `/superadmin/churches/${half.churchId}/purge`, {
    token: su, body: {},
  });
  is(again.status, 404, "a third run finds nothing and says so, rather than reporting success");

  const nonsense = new mongoose.Types.ObjectId();
  const unknown = await call("DELETE", `/superadmin/churches/${nonsense}/purge`, {
    token: su, body: {},
  });
  is(unknown.status, 404, "an id that was never a church is a 404, not an empty success");

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
