// End-to-end check for the superadmin dashboard (/api/superadmin/dashboard).
// Builds two churches with deliberately different role mixes, asserts the
// per-role counts and names come back correctly attributed, then cleans up.
//
// Run:  npm run dev            (in one terminal)
//       npm run check:dashboard    (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

let passed = 0;
let failed = 0;
const created = [];

const ok = (msg) => { console.log(`  ✓  ${msg}`); passed++; };
const bad = (msg, detail) => {
  console.log(`  ✗  ${msg}${detail ? `\n       ${detail}` : ""}`);
  failed++;
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

  const login = await call("POST", "/auth/login", { body: { email, password } });
  if (login.status !== 200) {
    bad("superadmin login", JSON.stringify(login.json));
    process.exit(1);
  }
  const su = login.json.token;

  // ---------------------------------------------------------------- setup ---
  console.log("\nsetup");
  const alpha = await call("POST", "/superadmin/churches", {
    token: su,
    body: { name: "Dashboard Alpha", admin: { name: "Ana Alpha", email: "ana@dsha.test" } },
  });
  const alphaId = alpha.json?.data?.church?._id;
  if (!alphaId) { bad("could not create church A", JSON.stringify(alpha.json)); process.exit(1); }
  created.push([alphaId, "Dashboard Alpha"]);
  const alphaAdminToken = (await call("POST", "/auth/login", {
    body: { email: "ana@dsha.test", password: alpha.json.data.adminPassword },
  })).json.token;

  const beta = await call("POST", "/superadmin/churches", {
    token: su,
    body: { name: "Dashboard Beta", admin: { name: "Ben Beta", email: "ben@dshb.test" } },
  });
  const betaId = beta.json?.data?.church?._id;
  created.push([betaId, "Dashboard Beta"]);

  // Church A gets a deliberately lopsided roster; B keeps only its admin.
  //
  // Seeded straight through the model rather than POST /api/admin/users,
  // because that endpoint cannot create anyone right now: `church` became
  // required in the tenant-fields branch, and createUser does not stamp it
  // until the users-and-categories scoping branch. Swap this back to the API
  // once that lands — it is the more honest path.
  const roster = [
    ["Pedro Pastor", "pastor@dsha.test", "pastor"],
    ["Vina Validator", "vina@dsha.test", "validator"],
    ["Aldo Auditor", "aldo@dsha.test", "auditor"],
    ["Bea Member", "bea@dsha.test", "member"],
    ["Caloy Member", "caloy@dsha.test", "member"],
    ["Dina Member", "dina@dsha.test", "member"],
  ];
  const hashed = await bcrypt.hash("TempPass123!", 10);
  await User.insertMany(
    roster.map(([name, mail, role]) => ({
      church: alphaId,
      name,
      email: mail,
      password: hashed,
      role,
      isActive: true,
    })),
  );
  ok("church A seeded with 1 admin + 6 more users; church B left with its admin only");

  // ------------------------------------------------------------ dashboard ---
  console.log("\ndashboard");
  const dash = await call("GET", "/superadmin/dashboard", { token: su });
  if (dash.status !== 200) { bad("dashboard request", JSON.stringify(dash.json)); process.exit(1); }
  ok("dashboard responds 200");

  const rowA = dash.json.data.find((d) => String(d.church._id) === String(alphaId));
  const rowB = dash.json.data.find((d) => String(d.church._id) === String(betaId));
  if (!rowA || !rowB) { bad("both churches present in the response"); process.exit(1); }

  rowA.totalAccounts === 7
    ? ok("church A total accounts = 7")
    : bad(`church A totalAccounts was ${rowA.totalAccounts}, expected 7`);
  rowB.totalAccounts === 1
    ? ok("church B total accounts = 1")
    : bad(`church B totalAccounts was ${rowB.totalAccounts}, expected 1`);

  rowA.roles.member.count === 3
    ? ok("church A member count = 3")
    : bad(`church A member count was ${rowA.roles.member.count}`);

  const memberNames = rowA.roles.member.names;
  const expectedMembers = ["Bea Member", "Caloy Member", "Dina Member"];
  JSON.stringify(memberNames) === JSON.stringify(expectedMembers)
    ? ok(`member names returned and sorted: ${memberNames.join(", ")}`)
    : bad(`member names wrong: ${JSON.stringify(memberNames)}`);

  rowA.roles.pastor.names[0] === "Pedro Pastor" && rowA.roles.auditor.names[0] === "Aldo Auditor"
    ? ok("pastor and auditor names attributed to the right roles")
    : bad("role/name attribution wrong", JSON.stringify(rowA.roles));

  // The isolation claim: church B's roster must not bleed into church A's row.
  const allANames = Object.values(rowA.roles).flatMap((r) => r.names);
  allANames.includes("Ben Beta")
    ? bad("church B's admin appeared under church A")
    : ok("no cross-church name bleed between the two rows");

  rowB.roles.admin.names[0] === "Ben Beta" && rowB.roles.member.count === 0
    ? ok("church B shows only its own admin, zero members")
    : bad("church B row wrong", JSON.stringify(rowB.roles));

  // Every role key present even at zero, so the frontend never guesses.
  const roleKeys = Object.keys(rowB.roles).sort();
  roleKeys.length === 6 && roleKeys.every((k) => "count" in rowB.roles[k] && "names" in rowB.roles[k])
    ? ok(`all 6 church roles present even at zero (${roleKeys.join(", ")})`)
    : bad(`role keys wrong: ${JSON.stringify(roleKeys)}`);

  rowA.isUnused === true && rowB.isUnused === true
    ? ok("both churches flagged unused (no tithes, RFs or vouchers yet)")
    : bad(`isUnused wrong: A=${rowA.isUnused} B=${rowB.isUnused}`);

  rowA.activity.tithes === 0 && rowA.activity.requestForms === 0 && rowA.activity.vouchers === 0
    ? ok("activity counts are zero for a fresh church")
    : bad("activity counts wrong", JSON.stringify(rowA.activity));

  // ------------------------------------------------------------- totals ----
  console.log("\ntotals");
  const t = dash.json.totals;
  t.accounts === 8
    ? ok("totals.accounts = 8 across both churches")
    : bad(`totals.accounts was ${t.accounts}, expected 8`);
  t.churches === dash.json.data.length
    ? ok(`totals.churches matches the row count (${t.churches})`)
    : bad("totals.churches mismatch");
  t.unusedChurches === 2
    ? ok("totals.unusedChurches = 2")
    : bad(`totals.unusedChurches was ${t.unusedChurches}`);

  // Superadmins must never be counted as anyone's church member.
  const anySuperadmin = dash.json.data.some((d) =>
    Object.values(d.roles).some((r) => r.names.includes("Adrian Anicete")),
  );
  anySuperadmin ? bad("the superadmin was counted inside a church") : ok("superadmin excluded from every church roster");

  // ------------------------------------------------- deactivated churches ---
  console.log("\nlifecycle reflected in the dashboard");
  await call("PATCH", `/superadmin/churches/${betaId}/deactivate`, { token: su });
  const afterDeactivate = await call("GET", "/superadmin/dashboard", { token: su });
  const rowBOff = afterDeactivate.json.data.find((d) => String(d.church._id) === String(betaId));
  rowBOff?.church.isActive === false
    ? ok("a deactivated church still appears, marked inactive")
    : bad("deactivated church not reflected");
  afterDeactivate.json.totals.activeChurches === afterDeactivate.json.totals.churches - 1
    ? ok("totals.activeChurches drops when a church is deactivated")
    : bad("activeChurches total wrong");

  // ------------------------------------------------------------- gating ----
  console.log("\naccess control");
  const anon = await call("GET", "/superadmin/dashboard");
  anon.status === 401 ? ok("unauthenticated request rejected (401)") : bad(`expected 401, got ${anon.status}`);

  const asAdmin = await call("GET", "/superadmin/dashboard", { token: alphaAdminToken });
  asAdmin.status === 403
    ? ok("a church admin cannot read the dashboard (403)")
    : bad(`expected 403 for a church admin, got ${asAdmin.status}`);

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
      if (id) {
        await call("DELETE", `/superadmin/churches/${id}/purge`, {
          token,
          body: { confirmName: name },
        });
      }
    }
    const left = await call("GET", "/superadmin/churches", { token });
    left.json?.count === 0
      ? ok("test data cleaned up (0 churches remain)")
      : bad(`${left.json?.count ?? "?"} churches left behind — check manually`);
  }
  await mongoose.disconnect();
}

console.log(`\n${failed === 0 ? "ALL PASSED" : "FAILED"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
