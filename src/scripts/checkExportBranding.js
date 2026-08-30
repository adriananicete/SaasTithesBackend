// End-to-end check that each church's exports carry that church's own name and
// logo — and nobody else's.
//
// Until this branch, `reportExport.js` opened with
// `export const CHURCH = "Jesus Our Saviour Christian Ministry"` and read a
// logo off disk from `src/assets/joscm-logo.png`. Correct for exactly one
// customer. For every other church it printed a different organisation's name
// and crest at the top of a signed financial record — which is worse than a
// data leak, because the document looks authoritative and is simply wrong.
//
// Branch 10 made the export files readable (`lib/exportScan.js`), so this is
// measured rather than asserted: every file is downloaded and opened, and the
// church's own name has to be inside it while the other church's is not.
//
// Run:  npm run dev             (in one terminal)
//       npm run check:branding    (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Tithes } from "../models/TithesEntry.js";
import { Expense } from "../models/Expense.js";
import { xlsxText, pdfVisibleText } from "./lib/exportScan.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

// The name that used to be compiled into every export.
const OLD_HARDCODED = "Jesus Our Saviour Christian Ministry";

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

const download = async (path, token) => {
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
};

const uploadLogo = async (token) => {
  const form = new FormData();
  form.append("logo", new Blob([ONE_PIXEL_PNG], { type: "image/png" }), "logo.png");
  const res = await fetch(BASE + "/church/me/logo", {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
};

const EXPORTS = [
  ["tithes excel", "/reports/tithes/export/excel", "xlsx"],
  ["tithes pdf", "/reports/tithes/export/pdf", "pdf"],
  ["expense excel", "/reports/expense/export/excel", "xlsx"],
  ["expense pdf", "/reports/expense/export/pdf", "pdf"],
  ["combined excel", "/reports/combined/export/excel", "xlsx"],
  ["combined pdf", "/reports/combined/export/pdf", "pdf"],
];

const readExport = async (path, kind, token) => {
  const file = await download(path, token);
  if (file.status !== 200) return { error: `status ${file.status}` };
  const text = kind === "xlsx" ? await xlsxText(file.buf) : pdfVisibleText(file.buf);
  if (!text.length) return { error: "no text could be read out of the file" };
  return { text, bytes: file.buf.length };
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

  // Users are named after the slug, never after the church. The church name has
  // to appear in a document ONLY as its header — if it is also sitting in a
  // "Submitted By" cell, an assertion about the header is really an assertion
  // about the rows, and a rename looks like a failure because the old name is
  // still in the data.
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
    const member = await User.create({
      church: church._id, name: `${slugHint} member`, email: `member@${slugHint}.test`,
      password: hashed, role: "member", isActive: true,
    });
    const expenseCategory = await Category.findOne({ church: church._id, type: "expense" });

    // Reports only render rows that exist, so each church needs some.
    await Tithes.create({
      church: church._id, entryDate: new Date(), serviceType: "Sunday Service",
      total: 5000, status: "approved", submittedBy: member._id, reviewedBy: admin._id,
    });
    await Expense.create({
      church: church._id, source: "manual", amount: 1200,
      category: expenseCategory._id, date: new Date(), recordedBy: admin._id,
      remarks: `${slugHint} expense`,
    });

    return { church, churchId: church._id, name, token: adminLogin.json?.token };
  };

  // Two names with no words in common, so one appearing in the other's document
  // cannot be a coincidence of shared vocabulary.
  const a = await build("Harvest Chapel", "harvest");
  const b = await build("Living Rock Fellowship", "livingrock");

  // ------------------------------------------------- the name on the paper --
  console.log("\nevery export carries its own church's name");
  for (const [label, path, kind] of EXPORTS) {
    const read = await readExport(path, kind, a.token);
    if (read.error) { bad(`${label} could not be read`, read.error); continue; }

    if (!read.text.includes(a.name)) {
      bad(`${label} does not carry "${a.name}"`, read.text.slice(0, 120));
      continue;
    }
    if (read.text.includes(b.name)) {
      bad(`${label} carries the other church's name`, `found "${b.name}"`);
      continue;
    }
    ok(`${label} — "${a.name}", not "${b.name}" (${read.bytes} bytes read)`);
  }

  console.log("\nand church B's say church B");
  for (const [label, path, kind] of EXPORTS) {
    const read = await readExport(path, kind, b.token);
    if (read.error) { bad(`${label} could not be read`, read.error); continue; }
    read.text.includes(b.name) && !read.text.includes(a.name)
      ? ok(`${label} — "${b.name}"`)
      : bad(`${label} is not branded as ${b.name}`, read.text.slice(0, 120));
  }

  // ------------------------------------------------ the last hardcoded name --
  console.log("\nthe hardcoded JOSCM name is gone from every document");
  let anyHardcoded = false;
  for (const [label, path, kind] of EXPORTS) {
    const read = await readExport(path, kind, a.token);
    if (read.error) { bad(`${label} could not be read`, read.error); continue; }
    if (read.text.includes(OLD_HARDCODED)) {
      bad(`${label} still prints "${OLD_HARDCODED}"`);
      anyHardcoded = true;
    }
  }
  anyHardcoded
    ? bad("the compiled-in church name survives somewhere")
    : ok(`no export mentions "${OLD_HARDCODED}"`);

  // ------------------------------------------------------------- the logo ---
  // A church with no logo must still produce a valid document — that is the
  // common case, since a new church has none until someone uploads one.
  console.log("\na church with no logo still exports cleanly");
  const noLogo = await readExport("/reports/combined/export/excel", "xlsx", a.token);
  noLogo.error
    ? bad("the combined workbook failed for a church with no logo", noLogo.error)
    : ok(`the combined workbook builds without a logo (${noLogo.bytes} bytes)`);

  const noLogoPdf = await readExport("/reports/combined/export/pdf", "pdf", a.token);
  noLogoPdf.error
    ? bad("the combined PDF failed for a church with no logo", noLogoPdf.error)
    : ok(`the combined PDF builds without a logo (${noLogoPdf.bytes} bytes)`);

  console.log("\nuploading a logo shows up in the next export, not stale");
  const beforeBytes = noLogo.bytes;
  const up = await uploadLogo(a.token);
  if (up.status !== 200) {
    bad("the logo upload failed", `${up.status} ${JSON.stringify(up.json)}`);
    console.log("       (branding-in-exports is then UNVERIFIED for the logo half)");
  } else {
    ok("church A uploads a logo");
    const withLogo = await readExport("/reports/combined/export/excel", "xlsx", a.token);
    withLogo.error
      ? bad("the combined workbook failed after the logo upload", withLogo.error)
      : withLogo.bytes > beforeBytes
        ? ok(`the next workbook is larger — the image is embedded (${beforeBytes} → ${withLogo.bytes} bytes)`)
        : bad("the workbook did not grow, so the logo was not embedded",
            `${beforeBytes} → ${withLogo.bytes}`);

    // The cache must not serve the pre-upload branding.
    const stillNamed = withLogo.text?.includes(a.name);
    stillNamed
      ? ok("and it still carries the church's name")
      : bad("the church name vanished from the workbook after the logo upload");

    // Church B has no logo, so its export must not have picked up A's.
    const bAfter = await readExport("/reports/combined/export/excel", "xlsx", b.token);
    bAfter.error
      ? bad("church B's workbook failed", bAfter.error)
      : bAfter.bytes < withLogo.bytes
        ? ok("church B's workbook is still logo-free — branding is not shared")
        : bad("church B's workbook grew too, so a logo leaked across churches",
            `A ${withLogo.bytes} vs B ${bAfter.bytes}`);
  }

  // ------------------------------------------------------ the rename path ---
  // Branding is cached, so a rename has to invalidate it or the old name keeps
  // printing until the TTL lapses.
  console.log("\na rename shows up in the next export, not after a TTL");
  const renamed = await call("PATCH", `/superadmin/churches/${b.churchId}`, {
    token: su, body: { name: "Cornerstone Assembly" },
  });
  is(renamed.status, 200, "the superadmin renames church B");

  const afterRename = await readExport("/reports/tithes/export/pdf", "pdf", b.token);
  if (afterRename.error) {
    bad("church B's PDF could not be read after the rename", afterRename.error);
  } else {
    // The header is the first text in the document, so this pins the assertion
    // to the title rather than to "the name appears somewhere".
    afterRename.text.startsWith("Cornerstone Assembly")
      ? ok("the very next export is headed with the new name")
      : bad("the export header is not the new name — the branding cache was not invalidated",
          afterRename.text.slice(0, 120));
    afterRename.text.includes(b.name)
      ? bad(`the old name "${b.name}" is still in the document`)
      : ok("and the old name is gone from it entirely");
  }

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
    // The rename means the purge confirmation has to match the CURRENT name.
    for (const [id] of created) {
      if (!id) continue;
      const current = await call("GET", `/superadmin/churches/${id}`, { token });
      const name = current.json?.data?.name;
      if (name) {
        await call("DELETE", `/superadmin/churches/${id}/purge`, { token, body: { confirmName: name } });
      }
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
