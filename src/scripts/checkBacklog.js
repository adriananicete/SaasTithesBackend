// The backlog items shipped together in feat/rf-attachments-and-backlog.
//
// They are unrelated to each other, so they are checked in one place rather
// than smeared across four existing suites — the branch bundled them, and this
// is the honest shape of that.
//
//   §14 item 7   RF attachments now have an upload path
//   §14 item 6b  the emailed reset is gone, replaced by an admin reset
//   §14 item 3   the tithes route and controller agree about auditor
//   —            GET /api/push/public-key
//
// Run:  npm run dev            (in one terminal)
//       npm run check:backlog    (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import cloudinary from "../config/cloudinary.js";
import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Tithes } from "../models/TithesEntry.js";
import { AuditLog } from "../models/AuditLog.js";

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

const upload = async (path, token, count) => {
  const form = new FormData();
  for (let i = 0; i < count; i++) {
    form.append("attachments", new Blob([ONE_PIXEL_PNG], { type: "image/png" }), `doc${i}.png`);
  }
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
};

const cloudinaryCount = async (prefix) => {
  const res = await cloudinary.api.resources({ type: "upload", prefix, max_results: 100 });
  return res.resources.length;
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

  const build = async (name, slugHint) => {
    const r = await call("POST", "/superadmin/churches", {
      token: su,
      body: { name, admin: { name: `${slugHint} admin`, email: `admin@${slugHint}.test` } },
    });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(r.json)}`);
    const church = r.json.data.church;
    created.push([church._id, name]);

    const adminLogin = await call("POST", "/auth/login", {
      body: { church: church._id, email: `admin@${slugHint}.test`, password: r.json.data.adminPassword },
    });

    const admin = await User.findOne({ church: church._id, role: "admin" });
    const hashed = await bcrypt.hash("SeedPass123!", 10);
    const [member, other, auditor, doUser] = await User.insertMany([
      { church: church._id, name: `${slugHint} member`, email: `member@${slugHint}.test`,
        password: hashed, role: "member", isActive: true },
      { church: church._id, name: `${slugHint} other`, email: `other@${slugHint}.test`,
        password: hashed, role: "member", isActive: true },
      { church: church._id, name: `${slugHint} auditor`, email: `auditor@${slugHint}.test`,
        password: hashed, role: "auditor", isActive: true },
      { church: church._id, name: `${slugHint} do`, email: `do@${slugHint}.test`,
        password: hashed, role: "do", isActive: true },
    ]);
    const logIn = async (handle, pass = "SeedPass123!") => {
      const res = await call("POST", "/auth/login", {
        body: { church: church._id, email: `${handle}@${slugHint}.test`, password: pass },
      });
      return res.json?.token;
    };

    // Fund the church so request forms can be created at all (§14 item 2).
    await Tithes.create({
      church: church._id, entryDate: new Date(), serviceType: "Sunday Service",
      total: 50000, status: "approved", submittedBy: member._id, reviewedBy: admin._id,
    });

    return {
      church, churchId: church._id, slugHint, admin, member, other, auditor, doUser,
      rfCategory: await Category.findOne({ church: church._id, type: "rf" }),
      token: adminLogin.json?.token,
      memberToken: await logIn("member"),
      otherToken: await logIn("other"),
      auditorToken: await logIn("auditor"),
      doToken: await logIn("do"),
      logIn,
    };
  };

  const a = await build("Backlog Alpha", "bklga");
  const b = await build("Backlog Beta", "bklgb");

  const makeDraft = async (c, label) => {
    const r = await call("POST", "/request-form", {
      token: c.memberToken,
      body: {
        entryDate: new Date(), category: String(c.rfCategory._id),
        estimatedAmount: 500, remarks: `${c.slugHint} ${label}`,
        // Deliberately supplied: the create handler must ignore it now.
        attachments: ["https://evil.test/not-a-real-upload.png"],
      },
    });
    return r.json?.data;
  };

  // ------------------------------------------------------ §14 item 7 -------
  console.log("\nrequest form attachments have an upload path (§14 item 7)");
  const rf = await makeDraft(a, "needs a quotation");
  is(rf?.attachments?.length, 0,
    "attachments supplied in the create body are ignored — they only come from the upload");

  const added = await upload(`/request-form/${rf._id}/attachments`, a.memberToken, 2);
  is(added.status, 200, "the requester uploads two attachments");
  is(added.json?.data?.attachments?.length, 2, "the form now holds two");

  const firstUrl = added.json?.data?.attachments?.[0] ?? "";
  firstUrl.includes(`churches/${a.church.slug}/attachments`)
    ? ok(`they land in churches/${a.church.slug}/attachments`)
    : bad("the attachment is not in the church's own folder", firstUrl);

  const tooMany = await upload(`/request-form/${rf._id}/attachments`, a.memberToken, 4);
  is(tooMany.status, 400, "a sixth attachment is refused — the cap is five");

  const notMine = await upload(`/request-form/${rf._id}/attachments`, a.otherToken, 1);
  is(notMine.status, 403, "another member cannot attach to someone else's form");

  const crossChurch = await upload(`/request-form/${rf._id}/attachments`, b.memberToken, 1);
  is(crossChurch.status, 404, "church B cannot attach to church A's form");

  console.log("\nremoving an attachment deletes the file too");
  const beforeRemove = await cloudinaryCount(`churches/${a.church.slug}/attachments`);
  const removed = await call("DELETE", `/request-form/${rf._id}/attachments`, {
    token: a.memberToken, body: { url: firstUrl },
  });
  is(removed.status, 200, "the requester removes one");
  is(removed.json?.data?.attachments?.length, 1, "one is left on the form");
  is(await cloudinaryCount(`churches/${a.church.slug}/attachments`), beforeRemove - 1,
    "and the file is gone from Cloudinary, not just unlinked");

  const gone = await call("DELETE", `/request-form/${rf._id}/attachments`, {
    token: a.memberToken, body: { url: firstUrl },
  });
  is(gone.status, 404, "removing it again is a 404");

  console.log("\nattachments are frozen once the form is submitted");
  await call("PATCH", `/request-form/${rf._id}/submit`, { token: a.memberToken });
  const afterSubmit = await upload(`/request-form/${rf._id}/attachments`, a.memberToken, 1);
  is(afterSubmit.status, 400, "attaching to a submitted form is refused");

  // ------------------------------------------------ the admin reset --------
  console.log("\nan admin can reset a password — the only way back in");
  const reset = await call("PATCH", `/admin/users/${a.member._id}/reset-password`, { token: a.token });
  is(reset.status, 200, "the admin resets the member's password");
  const fresh = reset.json?.data?.password;
  typeof fresh === "string" && fresh.length >= 12
    ? ok(`a password is generated and shown once (${fresh.length} chars)`)
    : bad("no usable password came back", JSON.stringify(reset.json?.data));

  const withNew = await a.logIn("member", fresh);
  withNew ? ok("the new password logs in") : bad("the generated password does not work");

  const withOld = await a.logIn("member", "SeedPass123!");
  withOld ? bad("the old password still works") : ok("and the old one no longer does");

  const byMember = await call("PATCH", `/admin/users/${a.other._id}/reset-password`, {
    token: a.memberToken,
  });
  is(byMember.status, 403, "a member cannot reset anyone's password");

  const acrossChurch = await call("PATCH", `/admin/users/${b.member._id}/reset-password`, {
    token: a.token,
  });
  is(acrossChurch.status, 404, "church A's admin cannot reset a church B user");

  const auditRow = await AuditLog.findOne({
    church: a.churchId, action: "user.reset_password",
  });
  auditRow ? ok("the reset is audited") : bad("no audit row for the password reset");

  // -------------------------------------- the emailed reset is gone --------
  console.log("\nthe public emailed reset is gone (§14 item 6b)");
  const forgot = await call("POST", "/auth/forgot-password", { body: { email: "member@bklga.test" } });
  is(forgot.status, 404, "POST /auth/forgot-password is no longer a route");
  const resetPublic = await call("POST", "/auth/reset-password", { body: { token: "x", password: "y" } });
  is(resetPublic.status, 404, "POST /auth/reset-password is no longer a route");

  // ------------------------------------------------------ §14 item 3 -------
  console.log("\nthe tithes route and controller agree about auditor (§14 item 3)");
  const entry = await call("POST", "/tithes", {
    token: a.memberToken === undefined ? a.token : a.memberToken,
    body: {
      entryDate: new Date(), serviceType: "Sunday Service",
      denominations: [{ bill: 100, qty: 1, subtotal: 100 }], total: 100,
    },
  });
  const entryId = entry.json?.data?._id;

  const byAuditor = await call("PATCH", `/tithes/${entryId}/approve`, { token: a.auditorToken });
  is(byAuditor.status, 403, "an auditor is refused — by the route, not after passing it");

  const byDo = await call("PATCH", `/tithes/${entryId}/approve`, { token: a.doToken });
  is(byDo.status, 200, "a DO still approves");

  // ------------------------------------------------- the VAPID key ---------
  console.log("\nthe VAPID public key is served, not copied into the frontend");
  const key = await call("GET", "/push/public-key", { token: a.memberToken });
  is(key.status, 200, "GET /api/push/public-key answers");
  typeof key.json?.data?.publicKey === "string" && key.json.data.publicKey.length > 20
    ? ok(`it returns the key (${key.json.data.publicKey.length} chars)`)
    : bad("no usable public key came back", JSON.stringify(key.json));

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
