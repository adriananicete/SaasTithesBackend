// THE GATE. No real paying church may be onboarded until this is fully green.
//
// Builds two churches with deliberately parallel data, then asks one question
// of every read endpoint — "does church A see anything belonging to church B?"
// — and one question of every id-addressed mutation — "can church A act on a
// church B record by guessing its id?"
//
// Detection is by marker string rather than by response shape: every record in
// church B carries BETAMARK, and every one of church B's ObjectIds is known,
// so a leak is caught wherever it appears in a payload, however that payload
// happens to be structured.
//
// Run:  npm run dev          (in one terminal)
//       npm run check:tenant     (in another)
//
// Expect a mostly-red table until the scoping branches land. That is the point:
// this is the checklist those branches work through.

import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { seedTwoChurches, MARKERS } from "./lib/seedChurches.js";
import { xlsxText, pdfVisibleText } from "./lib/exportScan.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

const results = [];
const record = (area, name, leaked, detail) =>
  results.push({ area, name, leaked, detail });

// Exports used to be recorded as unverifiable — an .xlsx is a ZIP and a PDF
// compresses its text, so a marker search over the raw bytes reports "clean"
// whether or not a row leaked, and a false green in a security gate is worse
// than an absent row. `lib/exportScan.js` parses both formats instead, so the
// printed documents are now measured like everything else.
const recordUnverifiable = (area, name, why) =>
  results.push({ area, name, leaked: null, unverifiable: why });

const download = async (path, token) => {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
};

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
  try { text = await res.text(); } catch { /* binary or empty */ }
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
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
  console.log(`Checking ${BASE}\n`);

  const suLogin = await call("POST", "/auth/login", { body: { email, password } });
  const su = suLogin.json?.token;
  if (!su) {
    console.error(`superadmin login failed (${suLogin.status}): ${JSON.stringify(suLogin.json)}`);
    console.error("If this says too many attempts, restart the server — the rate limiter is in memory.");
    process.exit(1);
  }

  const existing = await call("GET", "/superadmin/churches", { token: su });
  if (existing.json?.count) {
    console.log(`!  ${existing.json.count} church(es) already present — purging first\n`);
    for (const c of existing.json.data) {
      await call("DELETE", `/superadmin/churches/${c._id}/purge`, {
        token: su, body: { confirmName: c.name },
      });
    }
  }

  const { a, b } = await seedTwoChurches({ call, token: su });

  // Everything that identifies church B: its marker, its id, and the id of
  // every record seeded into it.
  const bIds = [
    String(b.churchId),
    ...b.users.map((u) => String(u._id)),
    ...b.tithes.map((t) => String(t._id)),
    ...b.rfs.map((r) => String(r._id)),
    String(b.voucher._id),
    String(b.rfCategory._id),
    String(b.expenseCategory._id),
  ];

  const findLeak = (text) => {
    if (!text) return null;
    if (text.includes(MARKERS.B)) return `contains ${MARKERS.B}`;
    const id = bIds.find((x) => text.includes(x));
    return id ? `contains church B id ${id}` : null;
  };

  // Log in as church A's admin — the role with the widest visibility, so if
  // anything leaks, it leaks here.
  const login = await call("POST", "/auth/login", {
    body: { church: a.churchId, email: a.adminEmail, password: a.adminPassword },
  });
  const tokenA = login.json?.token;
  if (!tokenA) { console.error("could not log in as church A's admin"); process.exit(1); }

  // ------------------------------------------------------------- reads -----
  const reads = [
    ["tithes", "GET /tithes"],
    ["request forms", "GET /request-form"],
    ["vouchers", "GET /vouchers"],
    ["expenses", "GET /expenses"],
    ["expenses", "GET /expenses/by-category"],
    ["categories", "GET /admin/categories"],
    ["users", "GET /admin/users"],
    ["audit log", "GET /audit-log"],
    ["search", "GET /search?q=" + MARKERS.B],
    ["search", "GET /search?q=RF"],
    ["reports", "GET /reports/tithes"],
    ["reports", "GET /reports/expense"],
    ["reports", "GET /reports/combined"],
  ];

  for (const [area, spec] of reads) {
    const [method, path] = spec.split(" ");
    const r = await call(method, path, { token: tokenA });
    record(area, spec, findLeak(r.text), `status ${r.status}`);
  }

  // Presence only reports users who have beaten recently, so church B's users
  // have to actually be online before the endpoint could leak them. Without
  // this the row passes for the wrong reason.
  const bLogin = await call("POST", "/auth/login", {
    body: { church: b.churchId, email: b.adminEmail, password: b.adminPassword },
  });
  if (bLogin.json?.token) {
    await call("POST", "/presence/heartbeat", { token: bLogin.json.token });
    const beat = await call("POST", "/presence/heartbeat", { token: tokenA });
    record("presence", "POST /presence/heartbeat (church B online)",
      findLeak(beat.text), `status ${beat.status}`);
  } else {
    record("presence", "POST /presence/heartbeat (church B online)",
      "could not log in as church B to make it online", "setup failed");
  }

  // ------------------------------------------------- id-addressed writes ----
  // Church A acting on a church B record by id. Anything other than 403/404
  // means the guess worked.
  const writes = [
    ["tithes", "PATCH", `/tithes/${b.tithes[1]._id}`, { remarks: "hijacked" }],
    ["tithes", "PATCH", `/tithes/${b.tithes[1]._id}/approve`, {}],
    ["tithes", "PATCH", `/tithes/${b.tithes[1]._id}/reject`, { rejectionNote: "no" }],
    ["request forms", "PATCH", `/request-form/${b.rfs[0]._id}`, { remarks: "hijacked" }],
    ["request forms", "PATCH", `/request-form/${b.rfs[0]._id}/validate`, {}],
    ["request forms", "PATCH", `/request-form/${b.rfs[0]._id}/reject`, { rejectionNote: "no" }],
    ["request forms", "DELETE", `/request-form/${b.rfs[0]._id}`, null],
    ["request forms", "GET", `/request-form/${b.rfs[0]._id}/comments`, null],
    ["request forms", "POST", `/request-form/${b.rfs[0]._id}/comments`, { text: "hijacked" }],
    ["vouchers", "PATCH", `/vouchers/${b.voucher._id}/cancel`, {}],
    ["categories", "PATCH", `/admin/categories/${b.rfCategory._id}`, { name: "hijacked" }],
    ["categories", "DELETE", `/admin/categories/${b.rfCategory._id}`, null],
    ["users", "GET", `/admin/users/${b.users[1]._id}`, null],
    ["users", "PATCH", `/admin/users/${b.users[1]._id}`, { name: "hijacked" }],
    ["users", "PATCH", `/admin/users/${b.users[1]._id}/deactivate`, {}],
    ["users", "DELETE", `/admin/users/${b.users[1]._id}`, null],
  ];

  // ---------------------------------------------------------- exports -----
  // The printed documents, read rather than reasoned about. A marker reaching
  // a signed financial record is the worst version of this whole class of bug.
  for (const [path, kind] of [
    ["/reports/tithes/export/excel", "xlsx"],
    ["/reports/tithes/export/pdf", "pdf"],
    ["/reports/expense/export/excel", "xlsx"],
    ["/reports/expense/export/pdf", "pdf"],
    ["/reports/combined/export/excel", "xlsx"],
    ["/reports/combined/export/pdf", "pdf"],
  ]) {
    const spec = `GET ${path}`;
    const file = await download(path, tokenA);
    if (file.status !== 200) {
      record("exports", spec, `could not download — status ${file.status}`, `status ${file.status}`);
      continue;
    }
    let text = "";
    try {
      text = kind === "xlsx" ? await xlsxText(file.buf) : pdfVisibleText(file.buf);
    } catch (error) {
      recordUnverifiable("exports", spec, `could not parse the file: ${error.message}`);
      continue;
    }
    // An unreadable file cannot be called clean — that is the false green the
    // old "unverifiable" row existed to avoid.
    if (!text.length) {
      recordUnverifiable("exports", spec, "no text could be read out of the file");
      continue;
    }
    record("exports", spec, findLeak(text), `${file.buf.length} bytes, ${text.length} chars read`);
  }

  for (const [area, method, path, body] of writes) {
    const r = await call(method, path, { token: tokenA, ...(body ? { body } : {}) });
    const reached = ![403, 404].includes(r.status);
    record(area, `${method} ${path.replace(/[0-9a-f]{24}/g, ":churchB_id")}`,
      reached ? `reached it — status ${r.status}` : null, `status ${r.status}`);
  }

  // ------------------------------------------------------------ report -----
  const byArea = new Map();
  for (const r of results) {
    if (!byArea.has(r.area)) byArea.set(r.area, []);
    byArea.get(r.area).push(r);
  }

  console.log("TENANT ISOLATION\n");
  for (const [area, rows] of byArea) {
    const bad = rows.filter((r) => r.leaked).length;
    const scanned = rows.filter((r) => !r.unverifiable).length;
    const heading =
      bad > 0
        ? `— ${bad}/${rows.length} LEAKING`
        : scanned === 0
          ? "— not verifiable by scan"
          : "— clean";
    console.log(`${area}  ${heading}`);
    for (const r of rows) {
      const mark = r.unverifiable ? " ?? " : r.leaked ? "LEAK" : " ok ";
      console.log(`  ${mark}  ${r.name.padEnd(52)} ${r.unverifiable ?? r.leaked ?? r.detail}`);
    }
    console.log("");
  }

  const leaks = results.filter((r) => r.leaked);
  const unknown = results.filter((r) => r.unverifiable);
  const checked = results.length - unknown.length;
  console.log(
    `${leaks.length === 0 ? "NO LEAKS" : `${leaks.length} LEAK(S)`} — ` +
      `${checked - leaks.length}/${checked} checked clean` +
      (unknown.length ? `, ${unknown.length} not verifiable by scan` : "") +
      "\n",
  );

  // Cleanup
  for (const c of [a, b]) {
    await call("DELETE", `/superadmin/churches/${c.churchId}/purge`, {
      token: su, body: { confirmName: c.church.name },
    });
  }
  const left = await call("GET", "/superadmin/churches", { token: su });
  console.log(`cleanup: ${left.json?.count ?? "?"} churches remain`);

  await mongoose.disconnect();
  process.exit(leaks.length === 0 ? 0 : 1);
};

main().catch(async (error) => {
  console.error("check crashed:", error.message);
  if (error.cause?.code === "ECONNREFUSED") {
    console.error("\nNothing is listening. Start the server with `npm run dev` first.");
  }
  if (mongoose.connection.readyState) await mongoose.disconnect();
  process.exit(1);
});
