// End-to-end check for church-aware login (/api/auth/churches, /api/auth/login,
// /api/auth/refresh). The claim: which church you belong to is part of your
// identity, the same email can exist in two churches, and the JWT carries the
// church claim every later scoping branch depends on.
//
// Run:  npm run dev        (in one terminal)
//       npm run check:login    (in another)

import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { Church } from "../models/Church.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

let passed = 0;
let failed = 0;
const created = [];

const ok = (msg) => { console.log(`  ✓  ${msg}`); passed++; };
const bad = (msg, detail) => {
  console.log(`  ✗  ${msg}${detail ? `\n       ${detail}` : ""}`);
  failed++;
};

const call = async (method, path, { token, body, cookie } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json, setCookie: res.headers.getSetCookie?.() ?? [] };
};

const decodeJwt = (token) =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());

const main = async () => {
  if (process.env.NODE_ENV === "production") {
    console.error("Refusing to run against production — this script creates and purges churches.");
    process.exit(1);
  }
  const suEmail = process.env.SEED_SUPERADMIN_EMAIL;
  const suPassword = process.env.SEED_SUPERADMIN_PASSWORD;
  if (!suEmail || !suPassword) {
    console.error("SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must be set.");
    process.exit(1);
  }

  await connectDB();
  console.log(`Checking ${BASE}`);

  const su = (await call("POST", "/auth/login", { body: { email: suEmail, password: suPassword } })).json.token;

  // Two churches, and deliberately the SAME admin email in both.
  const SHARED = "pastor@shared.test";
  const mk = async (name) => {
    const r = await call("POST", "/superadmin/churches", {
      token: su, body: { name, admin: { name: `${name} Admin`, email: SHARED } },
    });
    created.push([r.json.data.church._id, name]);
    return { id: r.json.data.church._id, password: r.json.data.adminPassword, acronym: r.json.data.church.acronym };
  };
  const alpha = await mk("Login Alpha");
  const beta = await mk("Login Beta");

  // ------------------------------------------------------------- dropdown ---
  console.log("\npublic church dropdown");
  const list = await call("GET", "/auth/churches");
  list.status === 200
    ? ok("GET /auth/churches works with no authentication")
    : bad(`expected 200 unauthenticated, got ${list.status}`);

  const sample = list.json?.data?.find((c) => String(c._id) === String(alpha.id));
  const keys = sample ? Object.keys(sample).sort() : [];
  JSON.stringify(keys) === JSON.stringify(["_id", "acronym", "logoUrl", "name"])
    ? ok(`only dropdown fields exposed: ${keys.join(", ")}`)
    : bad(`unexpected fields on a public church: ${keys.join(", ")}`);

  const names = list.json.data.map((c) => c.name);
  JSON.stringify(names) === JSON.stringify([...names].sort())
    ? ok("dropdown sorted by name")
    : bad("dropdown not sorted");

  // ---------------------------------------------------------------- login ---
  console.log("\nlogin identity is (church, email)");
  const inAlpha = await call("POST", "/auth/login", {
    body: { church: alpha.id, email: SHARED, password: alpha.password },
  });
  inAlpha.status === 200 && String(inAlpha.json.data.church) === String(alpha.id)
    ? ok("the shared email logs into church A with A's password")
    : bad("login to church A failed", JSON.stringify(inAlpha.json));

  const inBeta = await call("POST", "/auth/login", {
    body: { church: beta.id, email: SHARED, password: beta.password },
  });
  inBeta.status === 200 && String(inBeta.json.data.church) === String(beta.id)
    ? ok("the same email logs into church B with B's password — two distinct accounts")
    : bad("login to church B failed", JSON.stringify(inBeta.json));

  const crossed = await call("POST", "/auth/login", {
    body: { church: beta.id, email: SHARED, password: alpha.password },
  });
  crossed.status === 400
    ? ok("church A's password is rejected against church B")
    : bad(`expected 400 for a cross-church password, got ${crossed.status}`);

  const noChurch = await call("POST", "/auth/login", {
    body: { email: SHARED, password: alpha.password },
  });
  noChurch.status === 400 && /select your church/i.test(noChurch.json?.error ?? "")
    ? ok(`a church member who omits the church is told so: "${noChurch.json.error}"`)
    : bad(`expected a "select your church" 400, got ${noChurch.status} ${JSON.stringify(noChurch.json)}`);

  const badId = await call("POST", "/auth/login", {
    body: { church: "not-an-id", email: SHARED, password: alpha.password },
  });
  badId.status === 400 ? ok("a malformed church id is rejected") : bad(`expected 400, got ${badId.status}`);

  const superLogin = await call("POST", "/auth/login", { body: { email: suEmail, password: suPassword } });
  superLogin.status === 200 && superLogin.json.data.church === null
    ? ok("superadmin logs in with no church selected, church is null")
    : bad("superadmin login wrong", JSON.stringify(superLogin.json?.data));

  // ------------------------------------------------------------ jwt claim ---
  console.log("\njwt");
  const claims = decodeJwt(inAlpha.json.token);
  String(claims.church) === String(alpha.id)
    ? ok("access token carries the church claim")
    : bad(`church claim wrong: ${JSON.stringify(claims)}`);
  claims.id && claims.role
    ? ok(`claim shape is { id, role, church }: role=${claims.role}`)
    : bad("claim missing id or role");
  decodeJwt(superLogin.json.token).church === null
    ? ok("superadmin's token carries church: null")
    : bad("superadmin token church claim wrong");

  // -------------------------------------------------- deactivated church ----
  console.log("\ndeactivated and deleted churches");
  await call("PATCH", `/superadmin/churches/${beta.id}/deactivate`, { token: su });

  const gone = await call("GET", "/auth/churches");
  gone.json.data.some((c) => String(c._id) === String(beta.id))
    ? bad("a deactivated church still shows in the dropdown")
    : ok("a deactivated church disappears from the dropdown");

  const blocked = await call("POST", "/auth/login", {
    body: { church: beta.id, email: SHARED, password: beta.password },
  });
  blocked.status === 403
    ? ok(`login to a deactivated church is refused: "${blocked.json.error}"`)
    : bad(`expected 403 for a deactivated church, got ${blocked.status}`);

  // Refresh must end the session of someone already signed in.
  const betaCookie = inBeta.setCookie.map((c) => c.split(";")[0]).join("; ");
  const refreshed = await call("POST", "/auth/refresh", { cookie: betaCookie });
  refreshed.status === 403
    ? ok("an existing session cannot refresh once its church is deactivated")
    : bad(`expected 403 on refresh, got ${refreshed.status} ${JSON.stringify(refreshed.json)}`);

  await call("PATCH", `/superadmin/churches/${beta.id}/activate`, { token: su });
  const backAgain = await call("POST", "/auth/login", {
    body: { church: beta.id, email: SHARED, password: beta.password },
  });
  backAgain.status === 200 ? ok("reactivating restores login") : bad("login not restored after activate");

  await call("DELETE", `/superadmin/churches/${beta.id}`, { token: su });
  const afterDelete = await call("POST", "/auth/login", {
    body: { church: beta.id, email: SHARED, password: beta.password },
  });
  afterDelete.status === 400
    ? ok("login to a soft-deleted church is refused")
    : bad(`expected 400 for a soft-deleted church, got ${afterDelete.status}`);
  await call("PATCH", `/superadmin/churches/${beta.id}/restore`, { token: su });

  // Refresh still works for a healthy session.
  const alphaCookie = inAlpha.setCookie.map((c) => c.split(";")[0]).join("; ");
  const goodRefresh = await call("POST", "/auth/refresh", { cookie: alphaCookie });
  goodRefresh.status === 200 && String(decodeJwt(goodRefresh.json.token).church) === String(alpha.id)
    ? ok("a healthy session refreshes and keeps its church claim")
    : bad(`refresh failed: ${goodRefresh.status} ${JSON.stringify(goodRefresh.json)}`);

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
