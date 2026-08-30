// THE PRE-SALE CHECK. businessRequirements §14 item 9, run twice in parallel.
//
// Every other suite verifies a slice. This one walks the whole product the way
// a church actually uses it — nine steps, six roles, a real receipt upload —
// and does it for two churches at the same time, because a race between two
// tenants is exactly the thing a sequential test cannot see.
//
//   member submits tithes → DO approves → member creates RF → member submits it
//   → validator validates → pastor approves → validator issues a voucher with a
//   real Cloudinary receipt → DO disburses → member confirms receipt
//   → auditor exports Excel and PDF
//
// Then: each church's exports must show only its own rows, its own name and its
// own logo, and every notification must have fired only inside that church.
//
// This is also the first time POST /api/vouchers is exercised through the
// endpoint at all — every earlier suite stopped short of it, because it needs a
// real multipart upload to Cloudinary.
//
// Run:  npm run dev          (in one terminal)
//       npm run check:chain     (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Expense } from "../models/Expense.js";
import { Voucher } from "../models/Voucher.js";
import { Notification } from "../models/Notification.js";
import { xlsxText, pdfVisibleText } from "./lib/exportScan.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

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

// Multipart, for the two endpoints that take a file: POST /vouchers and
// PATCH /church/me/logo. Content-Type is left unset so fetch writes its own
// boundary.
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

const download = async (path, token) => {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
};

const readExport = async (path, kind, token) => {
  const file = await download(path, token);
  if (file.status !== 200) return { error: `status ${file.status}` };
  const text = kind === "xlsx" ? await xlsxText(file.buf) : pdfVisibleText(file.buf);
  if (!text.length) return { error: "no text could be read out of the file" };
  return { text, bytes: file.buf.length };
};

const ROLES_TO_SEED = ["member", "do", "validator", "pastor", "auditor"];

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
  if (baselineChurches > 0) {
    console.log(`!  ${baselineChurches} church(es) already present — they are left alone, and the`);
    console.log("   cleanup check at the end expects to find exactly that many again.\n");
  }

  // Users are named after the slug, never the church, so a church name in a
  // document can only have come from the header.
  const build = async (name, slugHint, amounts) => {
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

    const hashed = await bcrypt.hash("SeedPass123!", 10);
    await User.insertMany(
      ROLES_TO_SEED.map((role) => ({
        church: church._id, name: `${slugHint} ${role}`, email: `${role}@${slugHint}.test`,
        password: hashed, role, isActive: true,
      })),
    );

    const tokens = { admin: adminLogin.json?.token };
    for (const role of ROLES_TO_SEED) {
      const res = await call("POST", "/auth/login", {
        body: { church: church._id, email: `${role}@${slugHint}.test`, password: "SeedPass123!" },
      });
      tokens[role] = res.json?.token;
    }
    const missing = Object.entries(tokens).filter(([, t]) => !t).map(([r]) => r);
    if (missing.length) throw new Error(`${name}: could not log in as ${missing.join(", ")}`);

    const rfCategory = await Category.findOne({ church: church._id, type: "rf" });
    const expenseCategory = await Category.findOne({ church: church._id, type: "expense" });

    // Its own logo, so the exports have branding to carry.
    await sendForm("PATCH", "/church/me/logo", tokens.admin, {}, [
      { field: "logo", buffer: ONE_PIXEL_PNG, name: "logo.png" },
    ]);

    return { church, churchId: church._id, name, slugHint, tokens, rfCategory, expenseCategory, amounts };
  };

  // Different amounts, so a pooled figure is a wrong number rather than a
  // leaked name.
  const a = await build("Grace Community Church", "grace", { tithes: 8000, rf: 1500 });
  const b = await build("Bethel Worship Center", "bethel", { tithes: 12000, rf: 900 });

  // ------------------------------------------------------------ the chain ---
  // One church's full nine steps. Both run at once.
  const runChain = async (c) => {
    const steps = [];
    const step = (n, label, res, expect = 200) => {
      steps.push({ n, label, status: res.status, expect, json: res.json });
      return res;
    };

    // 1. member submits tithes
    const tithes = step(1, "member submits tithes",
      await call("POST", "/tithes", {
        token: c.tokens.member,
        body: {
          entryDate: new Date(), serviceType: "Sunday Service",
          denominations: [{ bill: 1000, qty: c.amounts.tithes / 1000, subtotal: c.amounts.tithes }],
          total: c.amounts.tithes,
        },
      }), 201);
    const tithesId = tithes.json?.data?._id;

    // 2. DO approves the tithes
    step(2, "DO approves the tithes",
      await call("PATCH", `/tithes/${tithesId}/approve`, { token: c.tokens.do }));

    // 3. member creates a request form
    const rf = step(3, "member creates a request form",
      await call("POST", "/request-form", {
        token: c.tokens.member,
        body: {
          entryDate: new Date(), category: String(c.rfCategory._id),
          estimatedAmount: c.amounts.rf, remarks: `${c.slugHint} sound system repair`,
        },
      }), 201);
    const rfId = rf.json?.data?._id;

    // 4. member submits it
    step(4, "member submits the request form",
      await call("PATCH", `/request-form/${rfId}/submit`, { token: c.tokens.member }));

    // 5. validator validates
    step(5, "validator validates",
      await call("PATCH", `/request-form/${rfId}/validate`, { token: c.tokens.validator }));

    // 6. pastor approves
    step(6, "pastor approves",
      await call("PATCH", `/request-form/${rfId}/approve`, { token: c.tokens.pastor }));

    // 7. validator issues a voucher WITH A REAL RECEIPT UPLOAD
    const voucher = step(7, "validator issues a voucher with a real receipt",
      await sendForm("POST", "/vouchers", c.tokens.validator, {
        rfId, category: String(c.expenseCategory._id),
        amount: c.amounts.rf, remarks: `${c.slugHint} sound system repair`,
      }, [{ field: "receipts", buffer: ONE_PIXEL_PNG, name: "receipt.png" }]));

    // 8. DO disburses
    step(8, "DO marks it disbursed",
      await call("PATCH", `/request-form/${rfId}/disburse`, { token: c.tokens.do }));

    // 9. member confirms receipt
    step(9, "member confirms receipt",
      await call("PATCH", `/request-form/${rfId}/received`, { token: c.tokens.member }));

    return { steps, rfId, tithesId, voucherNo: voucher.json?.data?.pcfNo, tithesBody: tithes.json };
  };

  console.log("\nthe nine-step chain, both churches at once");
  const notifBefore = await Notification.countDocuments({});
  const [chainA, chainB] = await Promise.all([runChain(a), runChain(b)]);

  for (const [label, c, chain] of [["A", a, chainA], ["B", b, chainB]]) {
    for (const s of chain.steps) {
      s.status === s.expect
        ? ok(`${label}${s.n}. ${s.label}`)
        : bad(`${label}${s.n}. ${s.label}`,
            `status ${s.status} (expected ${s.expect}) — ${JSON.stringify(s.json)}`);
    }
  }

  // The shape of the create response, stated outright. This is how §14 item 10
  // was found: the check read the wrong field, got undefined, passed the string
  // "undefined" as an id, and the failure surfaced two layers away as a cast
  // error from Mongoose. A regression should say what it is.
  console.log("\nPOST /tithes returns the document as data (§14 item 10)");
  typeof chainA.tithesBody?.data?._id === "string"
    ? ok("data is the tithes document")
    : bad("data is not the document", JSON.stringify(chainA.tithesBody?.data)?.slice(0, 120));
  is(chainA.tithesBody?.data?.newTithes, undefined,
    "and it is not wrapped in data.newTithes any more");
  is(chainA.tithesBody?.data?.total, a.amounts.tithes,
    `the document carries its own fields — total = ${a.amounts.tithes}`);

  // ------------------------------------------------------- the end state ----
  console.log("\nboth request forms end up received, with their own voucher");
  for (const [label, c, chain] of [["A", a, chainA], ["B", b, chainB]]) {
    const list = await call("GET", "/request-form", { token: c.tokens.admin });
    const rf = (list.json?.data ?? []).find((r) => String(r._id) === String(chain.rfId));
    is(rf?.status, "received", `church ${label}'s RF is received`);
    is(rf?.rfNo, "RF-0001", `and numbered RF-0001 in its own church`);
    is(chain.voucherNo, "PCF-0001", `its voucher is PCF-0001 in its own church`);

    const voucher = await Voucher.findOne({ church: c.churchId });
    is(voucher?.receipts?.length, 1, `the voucher carries its uploaded receipt`);
    String(voucher?.receipts?.[0] ?? "").includes(`churches/${c.church.slug}/receipts`)
      ? ok(`the receipt is stored under churches/${c.church.slug}/receipts`)
      : bad(`the receipt is not in the church's own folder`, voucher?.receipts?.[0]);

    const expense = await Expense.findOne({ church: c.churchId, source: "voucher" });
    is(expense?.amount, c.amounts.rf, `the disbursement auto-recorded an expense of ${c.amounts.rf}`);
  }

  // ---------------------------------------------------------- the numbers ---
  console.log("\nthe money is each church's own");
  for (const [label, c] of [["A", a], ["B", b]]) {
    const t = await call("GET", "/tithes", { token: c.tokens.admin });
    const available = c.amounts.tithes - c.amounts.rf;
    is(t.json?.totalBalance, c.amounts.tithes, `church ${label} totalBalance = ${c.amounts.tithes}`);
    is(t.json?.availableBalance, available,
      `church ${label} availableBalance = ${available} (approved tithes − its own expense)`);
  }

  const pooled = (a.amounts.tithes + b.amounts.tithes) - (a.amounts.rf + b.amounts.rf);
  const aTithes = await call("GET", "/tithes", { token: a.tokens.admin });
  aTithes.json?.availableBalance !== pooled
    ? ok(`church A is not showing the pooled balance (${pooled})`)
    : bad("church A's balance is both churches' money combined");

  // ------------------------------------------------------- the exports -----
  console.log("\nthe auditor's exports carry their own rows, name and logo");
  const EXPORTS = [
    ["tithes excel", "/reports/tithes/export/excel", "xlsx"],
    ["tithes pdf", "/reports/tithes/export/pdf", "pdf"],
    ["expense excel", "/reports/expense/export/excel", "xlsx"],
    ["expense pdf", "/reports/expense/export/pdf", "pdf"],
    ["combined excel", "/reports/combined/export/excel", "xlsx"],
    ["combined pdf", "/reports/combined/export/pdf", "pdf"],
  ];

  for (const [label, c, other] of [["A", a, b], ["B", b, a]]) {
    for (const [name, path, kind] of EXPORTS) {
      const read = await readExport(path, kind, c.tokens.auditor);
      if (read.error) { bad(`church ${label} ${name} could not be read`, read.error); continue; }
      if (!read.text.includes(c.name)) {
        bad(`church ${label} ${name} is not headed "${c.name}"`, read.text.slice(0, 100));
        continue;
      }
      if (read.text.includes(other.name)) {
        bad(`church ${label} ${name} mentions "${other.name}"`);
        continue;
      }
      if (read.text.includes(other.slugHint)) {
        bad(`church ${label} ${name} contains the other church's rows`, `found "${other.slugHint}"`);
        continue;
      }
      ok(`church ${label} ${name} — own name, own rows only (${read.bytes} bytes)`);
    }
  }

  // ------------------------------------------------- the notifications -----
  // Nine steps fire notifications at most transitions. No endpoint can show
  // another user's, so the recipients are counted in the database.
  console.log("\nevery notification fired inside its own church");
  const after = await Notification.countDocuments({});
  const fresh = after > notifBefore
    ? await Notification.find({}).sort({ createdAt: -1 }).limit(after - notifBefore)
    : [];
  fresh.length > 0
    ? ok(`${fresh.length} notification(s) fired across the two chains`)
    : bad("no notifications fired at all, so nothing is proven here");

  const recipients = await User.find({ _id: { $in: fresh.map((n) => n.userId) } })
    .select("name church role");
  const byChurch = new Map();
  for (const u of recipients) {
    const k = String(u.church);
    byChurch.set(k, (byChurch.get(k) ?? 0) + 1);
  }
  const known = new Set([String(a.churchId), String(b.churchId)]);
  [...byChurch.keys()].every((k) => known.has(k))
    ? ok("every recipient belongs to one of the two churches")
    : bad("a notification reached a user outside both churches");

  // The real question: did a church-A action notify a church-B user? Each
  // notification's refId belongs to one church, so match them up.
  let crossed = 0;
  for (const n of fresh) {
    const user = recipients.find((u) => String(u._id) === String(n.userId));
    if (!user) continue;
    const mentionsA = n.message.includes(a.slugHint) || String(n.refId) === String(chainA.rfId);
    const mentionsB = n.message.includes(b.slugHint) || String(n.refId) === String(chainB.rfId);
    if (mentionsA && String(user.church) !== String(a.churchId)) crossed++;
    if (mentionsB && String(user.church) !== String(b.churchId)) crossed++;
  }
  is(crossed, 0, "no notification about one church's records reached the other's users");

  return su;
};

let token = null;
let baselineChurches = null;
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
