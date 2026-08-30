// End-to-end check for the last four cross-cutting paths: the audit log,
// global search, the online facepile, and role fan-out notifications.
//
// Notifications are the reason this script exists rather than leaning on the
// leak check. Nothing in the API lets you read someone else's notifications, so
// a cross-church fan-out is invisible to any endpoint-scanning gate — one
// church approving a request would notify every other church's validators and
// the table would still be green. The only way to see it is to count the rows
// in the database after a real action, which is what this does.
//
// Run:  npm run dev                    (in one terminal)
//       npm run check:audit-search       (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { RequestForm } from "../models/RequestForm.js";
import { Voucher } from "../models/Voucher.js";
import { Notification } from "../models/Notification.js";
import { AuditLog } from "../models/AuditLog.js";

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

  // Both churches share the search term "supplies" on purpose — the question is
  // never "can it find nothing", it is "does it find only mine".
  const build = async (name, marker, slugHint) => {
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
    const [member, validator, doUser] = await User.insertMany([
      { church: churchId, name: `${marker} Member`, email: `member@${slugHint}.test`,
        password: hashed, role: "member", isActive: true },
      { church: churchId, name: `${marker} Validator`, email: `validator@${slugHint}.test`,
        password: hashed, role: "validator", isActive: true },
      { church: churchId, name: `${marker} DO`, email: `do@${slugHint}.test`,
        password: hashed, role: "do", isActive: true },
    ]);

    const logIn = async (handle) => {
      const res = await call("POST", "/auth/login", {
        body: { church: churchId, email: `${handle}@${slugHint}.test`, password: "SeedPass123!" },
      });
      return res.json?.token;
    };

    const rfCategory = await Category.findOne({ church: churchId, type: "rf" });
    const expenseCategory = await Category.findOne({ church: churchId, type: "expense" });

    // Two RFs with the same search term but different visibility to a
    // validator: `submitted` is in their queue, `voucher_created` is not.
    const [rfOpen, rfPrivate] = await RequestForm.insertMany([
      { church: churchId, rfNo: "RF-0001", entryDate: new Date(), category: rfCategory._id,
        requestedBy: member._id, estimatedAmount: 500,
        remarks: `supplies ${marker} open`, status: "submitted" },
      { church: churchId, rfNo: "RF-0002", entryDate: new Date(), category: rfCategory._id,
        requestedBy: member._id, estimatedAmount: 900,
        remarks: `supplies ${marker} private`, status: "voucher_created" },
    ]);

    const voucher = await Voucher.create({
      church: churchId, pcfNo: "PCF-0001", rfId: rfPrivate._id, date: new Date(),
      category: expenseCategory._id, amount: 900, createdBy: admin._id,
      receipts: [`https://example.test/${marker}-receipt.jpg`],
    });
    await RequestForm.findByIdAndUpdate(rfPrivate._id, { $set: { voucherId: voucher._id } });

    return {
      churchId, marker, admin, member, validator, doUser, rfOpen, rfPrivate, voucher,
      token: adminLogin.json?.token,
      memberToken: await logIn("member"),
      validatorToken: await logIn("validator"),
    };
  };

  const a = await build("Trail Alpha", "TRAILALPHA", "talpha");
  const b = await build("Trail Beta", "TRAILBETA", "tbeta");

  // ------------------------------------------------------------ audit log ---
  // The regression first: AuditLog.church has been required since Branch 1, but
  // recordAudit never stamped it, and recordAudit swallows its own errors by
  // design. So every audit write in the app has been failing silently — the log
  // has been empty since tenancy landed. Proving a row appears at all matters
  // more here than proving it doesn't leak.
  console.log("\nthe audit log records actions again");
  const madeCategory = await call("POST", "/admin/categories", {
    token: a.token, body: { name: `${a.marker} Fuel`, type: "expense" },
  });
  is(madeCategory.status, 201, "church A's admin creates a category");

  const aLog = await call("GET", "/audit-log", { token: a.token });
  const aRows = aLog.json?.data ?? [];
  aRows.some((r) => r.action === "category.create" && r.targetRef === `${a.marker} Fuel`)
    ? ok("the category.create row is in church A's audit log")
    : bad("nothing was written to the audit log", `${aRows.length} rows returned`);

  const dbRow = await AuditLog.findOne({ church: a.churchId, action: "category.create" });
  dbRow && String(dbRow.church) === String(a.churchId)
    ? ok("the stored row carries church A")
    : bad("the audit row was written without a church");

  console.log("\nthe audit log is church-scoped");
  await call("POST", "/admin/categories", {
    token: b.token, body: { name: `${b.marker} Fuel`, type: "expense" },
  });
  const aLog2 = await call("GET", "/audit-log", { token: a.token });
  JSON.stringify(aLog2.json?.data ?? []).includes(b.marker)
    ? bad("church B's audit rows appeared in church A's log")
    : ok("church A's log holds no church B row");

  const bLog = await call("GET", "/audit-log", { token: b.token });
  JSON.stringify(bLog.json?.data ?? []).includes(a.marker)
    ? bad("church A's audit rows appeared in church B's log")
    : ok("church B's log holds no church A row");

  is(aLog2.json?.total, 1, "church A's log counts only its own row");
  is(bLog.json?.total, 1, "church B's log counts only its own row");

  // --------------------------------------------------------------- search ---
  console.log("\nsearch returns this church's rows only");
  const adminSearch = await call("GET", "/search?q=supplies", { token: a.token });
  const adminBody = JSON.stringify(adminSearch.json ?? {});
  adminBody.includes(b.marker)
    ? bad("church B surfaced in church A's search")
    : ok("church A's admin search holds no church B result");
  is(adminSearch.json?.counts?.rf, 2, "church A's admin sees both of its own RFs");
  is(adminSearch.json?.counts?.voucher, 1, "church A's admin sees its own voucher");

  const markerSearch = await call("GET", `/search?q=${b.marker}`, { token: a.token });
  is(markerSearch.json?.results?.length, 0, `searching for "${b.marker}" as church A returns nothing`);

  // The pre-existing ROLE bug, not only the tenancy one: the voucher lookup ran
  // a bare RequestForm.find({ remarks }), bypassing buildRfScope, so a
  // validator could surface a voucher whose RF is outside their queue.
  console.log("\nsearch respects role scoping on the voucher path too");
  const valSearch = await call("GET", "/search?q=supplies", { token: a.validatorToken });
  const valBody = JSON.stringify(valSearch.json ?? {});
  is(valSearch.json?.counts?.rf, 1, "the validator sees only the submitted RF, not the voucher_created one");
  valBody.includes("private")
    ? bad("the validator surfaced an RF outside their queue, through the voucher path")
    : ok("the voucher_created RF stays out of the validator's results");
  is(valSearch.json?.counts?.voucher, 0, "and so does the voucher hanging off it");
  valBody.includes(b.marker)
    ? bad("church B surfaced in the validator's search")
    : ok("no church B result for the validator either");

  // A member is not a voucher role at all, so only the RF path applies.
  const memberSearch = await call("GET", "/search?q=supplies", { token: a.memberToken });
  is(memberSearch.json?.counts?.voucher, 0, "a member gets no voucher results");

  // ------------------------------------------------------------- presence ---
  console.log("\nthe online facepile shows this church only");
  const bAdminBeat = await call("POST", "/presence/heartbeat", { token: b.token });
  is(bAdminBeat.status, 200, "church B's admin is online");

  const aBeat = await call("POST", "/presence/heartbeat", { token: a.token });
  const onlineNames = (aBeat.json?.online ?? []).map((u) => u.name).join(", ");
  onlineNames.includes(b.marker)
    ? bad("church B's user appeared in church A's facepile", onlineNames)
    : ok(`church A's facepile holds only its own users (${onlineNames || "none"})`);
  (aBeat.json?.online ?? []).some((u) => u.name.includes(a.marker))
    ? ok("and church A's own user is in it — the filter is not just returning nothing")
    : bad("church A's facepile is empty, so the check proves nothing");

  // -------------------------------------------------------- notifications ---
  // No endpoint can show this, so count the rows.
  console.log("\na role fan-out stops at the church boundary");
  const before = await Notification.countDocuments({});
  const submitted = await call("POST", "/tithes", {
    token: a.memberToken,
    body: {
      entryDate: new Date(), serviceType: "Sunday Service",
      denominations: [{ bill: 1000, qty: 5, subtotal: 5000 }], total: 5000,
    },
  });
  is(submitted.status, 201, "church A's member submits tithes");

  const after = await Notification.countDocuments({});
  // limit(0) means "no limit" in Mongoose, so an unchanged count has to be
  // handled explicitly rather than silently pulling every notification.
  const newOnes = after > before
    ? await Notification.find({}).sort({ createdAt: -1 }).limit(after - before)
    : [];
  const recipients = await User.find({ _id: { $in: newOnes.map((n) => n.userId) } })
    .select("name church role");

  recipients.length > 0
    ? ok(`the fan-out reached ${recipients.length} recipient(s): ${recipients.map((u) => u.role).join(", ")}`)
    : bad("nobody was notified — the fan-out did not fire, so nothing is proven");

  const strays = recipients.filter((u) => String(u.church) !== String(a.churchId));
  strays.length === 0
    ? ok("every recipient belongs to church A")
    : bad(`${strays.length} recipient(s) outside church A`, strays.map((u) => u.name).join(", "));

  // Church B has a `do` and an `admin` too — the roles this fan-out targets —
  // so an unscoped query would have picked them up. Naming that here keeps the
  // assertion above from passing for the wrong reason.
  const bTargets = await User.countDocuments({ church: b.churchId, role: { $in: ["do", "admin"] } });
  bTargets > 0
    ? ok(`church B holds ${bTargets} user(s) in the notified roles and got none of them`)
    : bad("church B has no user in the notified roles, so the check proves nothing");

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
