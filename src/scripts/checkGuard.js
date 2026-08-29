// End-to-end check for the church-active guard.
//
// The claim: deactivating a church takes hold on its next request, not whenever
// its users' access tokens happen to expire. Everything here uses ONE token,
// obtained before the deactivation and never refreshed, because a token that
// was still valid at the moment of deactivation is exactly the case the guard
// exists for.
//
// Run:  npm run dev      (in one terminal)
//       npm run check:guard   (in another)

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

// A spread of tenant routes across different routers, so the check proves the
// guard is wired everywhere rather than on one lucky path.
const TENANT_ROUTES = [
  ["GET", "/tithes"],
  ["GET", "/request-form"],
  ["GET", "/vouchers"],
  ["GET", "/expenses"],
  ["GET", "/expenses/by-category"],
  ["GET", "/notifications"],
  ["GET", "/reports/tithes"],
  ["GET", "/search?q=test"],
  ["GET", "/audit-log"],
  ["GET", "/users/me"],
  ["GET", "/admin/users"],
  ["GET", "/admin/categories"],
  ["POST", "/presence/heartbeat"],
];

const sweep = async (token) => {
  const results = [];
  for (const [method, path] of TENANT_ROUTES) {
    const r = await call(method, path, { token });
    results.push([`${method} ${path}`, r.status]);
  }
  return results;
};

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

  console.log(`Checking ${BASE}`);

  const su = (await call("POST", "/auth/login", { body: { email: suEmail, password: suPassword } })).json.token;

  const made = await call("POST", "/superadmin/churches", {
    token: su,
    body: { name: "Guard Church", admin: { name: "Guard Admin", email: "admin@guard.test" } },
  });
  const churchId = made.json?.data?.church?._id;
  if (!churchId) { bad("could not create the test church", JSON.stringify(made.json)); process.exit(1); }
  created.push([churchId, "Guard Church"]);

  // The one token used for the whole run. Never refreshed.
  const login = await call("POST", "/auth/login", {
    body: { church: churchId, email: "admin@guard.test", password: made.json.data.adminPassword },
  });
  const adminToken = login.json?.token;
  adminToken ? ok("church admin holds a valid access token") : bad("could not log the admin in");

  // ------------------------------------------------------------- baseline ---
  console.log("\nbefore deactivation");
  const before = await sweep(adminToken);
  const blockedBefore = before.filter(([, s]) => s === 403);
  blockedBefore.length === 0
    ? ok(`all ${before.length} tenant routes reachable while the church is active`)
    : bad(`${blockedBefore.length} route(s) already blocked`, JSON.stringify(blockedBefore));

  // --------------------------------------------------------------- guard ----
  console.log("\nafter deactivation — same token, never refreshed");
  await call("PATCH", `/superadmin/churches/${churchId}/deactivate`, { token: su });

  const after = await sweep(adminToken);
  const stillOpen = after.filter(([, s]) => s !== 403);
  stillOpen.length === 0
    ? ok(`all ${after.length} tenant routes now return 403 on the very next request`)
    : bad(`${stillOpen.length} route(s) still reachable after deactivation`, JSON.stringify(stillOpen));

  const sample = await call("GET", "/tithes", { token: adminToken });
  /no longer active/i.test(sample.json?.error ?? "")
    ? ok(`the refusal explains itself: "${sample.json.error}"`)
    : bad(`unhelpful error: ${JSON.stringify(sample.json)}`);

  // Logging out must keep working, or a blocked user is stuck with a live cookie.
  const logout = await call("POST", "/auth/logout", { token: adminToken });
  logout.status === 200
    ? ok("logout still works while the church is blocked")
    : bad(`logout returned ${logout.status}`);

  // ------------------------------------------------------ superadmin unaffected ---
  console.log("\nsuperadmin is unaffected");
  const suDash = await call("GET", "/superadmin/dashboard", { token: su });
  suDash.status === 200
    ? ok("superadmin still reads the dashboard (it has no church)")
    : bad(`superadmin blocked with ${suDash.status}`);
  const suList = await call("GET", "/superadmin/churches", { token: su });
  suList.status === 200 ? ok("superadmin still manages churches") : bad("superadmin church list blocked");

  // ----------------------------------------------------------- reactivate ---
  console.log("\nafter reactivation");
  await call("PATCH", `/superadmin/churches/${churchId}/activate`, { token: su });

  const restored = await sweep(adminToken);
  const stillBlocked = restored.filter(([, s]) => s === 403);
  stillBlocked.length === 0
    ? ok("the same token works again immediately — the cache is invalidated, not waited out")
    : bad(`${stillBlocked.length} route(s) still blocked after reactivation`, JSON.stringify(stillBlocked));

  // --------------------------------------------------------- soft delete ----
  console.log("\nsoft delete blocks too");
  await call("DELETE", `/superadmin/churches/${churchId}`, { token: su });
  const afterDelete = await call("GET", "/tithes", { token: adminToken });
  afterDelete.status === 403
    ? ok("a soft-deleted church blocks its users as well")
    : bad(`expected 403 after soft delete, got ${afterDelete.status}`);

  await call("PATCH", `/superadmin/churches/${churchId}/restore`, { token: su });
  const afterRestore = await call("GET", "/tithes", { token: adminToken });
  afterRestore.status === 200
    ? ok("restore reopens access on the next request")
    : bad(`expected 200 after restore, got ${afterRestore.status}`);

  // ------------------------------------------------- token without a church ---
  console.log("\nmalformed session");
  const noChurchToken = (await call("POST", "/auth/login", {
    body: { email: suEmail, password: suPassword },
  })).json.token;
  // A superadmin token is the only one carrying church: null, and it must be
  // refused on tenant routes by role, not waved through as "no church".
  const suOnTenant = await call("GET", "/tithes", { token: noChurchToken });
  suOnTenant.status === 403
    ? ok("a superadmin token is refused on tenant routes")
    : bad(`expected 403 for superadmin on a tenant route, got ${suOnTenant.status}`);

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
}

console.log(`\n${failed === 0 ? "ALL PASSED" : "FAILED"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
