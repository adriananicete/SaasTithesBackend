// End-to-end check for the superadmin church surface (/api/superadmin/churches).
// Exercises the real HTTP API against a running server, then cleans up after
// itself. Re-run it after any branch that touches auth, roles or churches.
//
// Run:  npm run dev            (in one terminal)
//       npm run check:superadmin   (in another)
//
// Creates and purges throw-away churches, so it refuses to run against
// production.

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

let passed = 0;
let failed = 0;
const created = [];

const ok = (msg) => {
  console.log(`  ✓  ${msg}`);
  passed++;
};
const bad = (msg, detail) => {
  console.log(`  ✗  ${msg}${detail ? `\n       ${detail}` : ""}`);
  failed++;
};
const section = (name) => console.log(`\n${name}`);

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
  try {
    json = await res.json();
  } catch {
    /* some responses have no body */
  }
  return { status: res.status, json };
};

const purge = async (token, id, name) => {
  if (!id) return;
  await call("DELETE", `/superadmin/churches/${id}/purge`, {
    token,
    body: { confirmName: name },
  });
};

const main = async () => {
  if (process.env.NODE_ENV === "production") {
    console.error(
      "Refusing to run against production — this script creates and purges churches.",
    );
    process.exit(1);
  }

  const email = process.env.SEED_SUPERADMIN_EMAIL;
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  if (!email || !password) {
    console.error(
      "SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must be set. Run `npm run seed:superadmin` first.",
    );
    process.exit(1);
  }

  console.log(`Checking ${BASE}`);

  // ---------------------------------------------------------------- auth ---
  section("auth");
  const login = await call("POST", "/auth/login", { body: { email, password } });
  if (login.status !== 200) {
    bad("superadmin login", JSON.stringify(login.json));
    console.error(
      "\nCannot continue without a superadmin session. Is the server running, and has the superadmin been seeded?",
    );
    process.exit(1);
  }
  ok(`superadmin logs in (role=${login.json.data.role})`);
  const su = login.json.token;

  const anon = await call("GET", "/superadmin/churches");
  anon.status === 401
    ? ok("unauthenticated request rejected (401)")
    : bad(`expected 401 for anonymous access, got ${anon.status}`);

  // -------------------------------------------------------------- create ---
  section("create");
  const made = await call("POST", "/superadmin/churches", {
    token: su,
    body: {
      name: "Check Church Alpha",
      acronym: "chka",
      emailDomain: "chka.test",
      admin: { name: "Alpha Admin", email: "admin@chka.test" },
    },
  });
  if (made.status !== 201) {
    bad("create church", JSON.stringify(made.json));
    process.exit(1);
  }
  const alphaId = made.json.data.church._id;
  created.push([alphaId, "Check Church Alpha"]);
  const adminPassword = made.json.data.adminPassword;

  made.json.data.church.acronym === "CHKA"
    ? ok("acronym is uppercased on write (chka -> CHKA)")
    : bad(`acronym not uppercased: ${made.json.data.church.acronym}`);
  adminPassword
    ? ok("generated admin password is returned once")
    : bad("no admin password returned");

  const dupeAcronym = await call("POST", "/superadmin/churches", {
    token: su,
    body: {
      name: "Different Name",
      acronym: "CHKA",
      admin: { name: "x", email: "x@x.test" },
    },
  });
  dupeAcronym.status === 400
    ? ok("duplicate acronym rejected")
    : bad(`expected 400 for duplicate acronym, got ${dupeAcronym.status}`);

  const noAdmin = await call("POST", "/superadmin/churches", {
    token: su,
    body: { name: "No Admin Church", acronym: "NOAD" },
  });
  noAdmin.status === 400
    ? ok("church without a first admin rejected")
    : bad(`expected 400 without admin, got ${noAdmin.status}`);

  const orphan = await call("GET", "/superadmin/churches", { token: su });
  orphan.json.data.some((c) => c.acronym === "NOAD")
    ? bad("failed bootstrap left an orphan church behind")
    : ok("failed bootstrap left no orphan church");

  // Acronym is derived from the name when the request omits it.
  const derived = await call("POST", "/superadmin/churches", {
    token: su,
    body: { name: "Jesus is Lord", admin: { name: "JIL Admin", email: "admin@jil.test" } },
  });
  const jilId = derived.json?.data?.church?._id;
  if (jilId) created.push([jilId, "Jesus is Lord"]);
  derived.json?.data?.church?.acronym === "JIL"
    ? ok('acronym derived from the name ("Jesus is Lord" -> JIL)')
    : bad(`expected derived acronym JIL, got ${derived.json?.data?.church?.acronym}`);

  // Two different names can derive the same acronym; that is resolved, not
  // rejected, since the caller never asked for a specific value.
  const clash = await call("POST", "/superadmin/churches", {
    token: su,
    body: { name: "Jesus in Life", admin: { name: "JIL2 Admin", email: "admin@jil2.test" } },
  });
  const clashId = clash.json?.data?.church?._id;
  if (clashId) created.push([clashId, "Jesus in Life"]);
  clash.json?.data?.church?.acronym === "JIL2"
    ? ok("a derived acronym clash is resolved (JIL -> JIL2)")
    : bad(`expected JIL2 on clash, got ${clash.json?.data?.church?.acronym}`);

  const unnameable = await call("POST", "/superadmin/churches", {
    token: su,
    body: { name: "!!!", admin: { name: "x", email: "x@x.test" } },
  });
  unnameable.status === 400
    ? ok("a name with no derivable acronym is rejected")
    : bad(`expected 400 for underivable name, got ${unnameable.status}`);

  // Same admin email in a second church — allowed by the compound
  // { church, email } unique index.
  const beta = await call("POST", "/superadmin/churches", {
    token: su,
    body: {
      name: "Check Church Beta",
      acronym: "chkb",
      admin: { name: "Beta Admin", email: "admin@chka.test" },
    },
  });
  const betaId = beta.json?.data?.church?._id;
  if (betaId) created.push([betaId, "Check Church Beta"]);
  beta.status === 201
    ? ok("same admin email reused in a second church (per-church uniqueness)")
    : bad("second church with a shared email", JSON.stringify(beta.json));

  // -------------------------------------------------------------- update ---
  section("update");
  const upd = await call("PATCH", `/superadmin/churches/${alphaId}`, {
    token: su,
    body: { name: "Check Church Alpha Intl", contactPhone: "0917" },
  });
  upd.json?.data?.name === "Check Church Alpha Intl"
    ? ok("editable fields update")
    : bad("update failed", JSON.stringify(upd.json));
  if (upd.json?.data?.name) created[0][1] = upd.json.data.name;

  const sneaky = await call("PATCH", `/superadmin/churches/${alphaId}`, {
    token: su,
    body: { isActive: false, deletedAt: new Date() },
  });
  sneaky.status === 400
    ? ok("isActive/deletedAt cannot be set through update")
    : bad(`expected 400 for non-editable fields, got ${sneaky.status}`);

  // ----------------------------------------------------------- lifecycle ---
  section("lifecycle");
  const off = await call("PATCH", `/superadmin/churches/${alphaId}/deactivate`, { token: su });
  off.json?.data?.isActive === false ? ok("deactivate") : bad("deactivate failed");

  const on = await call("PATCH", `/superadmin/churches/${alphaId}/activate`, { token: su });
  on.json?.data?.isActive === true ? ok("activate") : bad("activate failed");

  const del = await call("DELETE", `/superadmin/churches/${alphaId}`, { token: su });
  del.json?.data?.deletedAt ? ok("soft delete sets deletedAt") : bad("soft delete failed");

  const delTwice = await call("DELETE", `/superadmin/churches/${alphaId}`, { token: su });
  delTwice.status === 400
    ? ok("soft-deleting twice rejected")
    : bad(`expected 400 on second delete, got ${delTwice.status}`);

  const restored = await call("PATCH", `/superadmin/churches/${alphaId}/restore`, { token: su });
  restored.json?.data?.deletedAt === null
    ? ok("restore clears deletedAt")
    : bad("restore failed");

  const restoreTwice = await call("PATCH", `/superadmin/churches/${alphaId}/restore`, { token: su });
  restoreTwice.status === 400
    ? ok("restoring a church that is not deleted rejected")
    : bad(`expected 400 on second restore, got ${restoreTwice.status}`);

  const list = await call("GET", "/superadmin/churches", { token: su });
  list.json?.count >= 2 && Array.isArray(list.json?.data)
    ? ok(`list returns the normalized { status, count, data } shape (count=${list.json.count})`)
    : bad("list shape wrong", JSON.stringify(list.json)?.slice(0, 120));

  // ------------------------------------------------------- role isolation ---
  section("role isolation — a church admin must not reach superadmin routes");
  const adminLogin = await call("POST", "/auth/login", {
    body: { email: "admin@chka.test", password: adminPassword },
  });
  adminLogin.status === 200
    ? ok("bootstrapped admin logs in with the generated password")
    : bad("bootstrapped admin cannot log in", JSON.stringify(adminLogin.json));
  const adminToken = adminLogin.json?.token;

  const guarded = [
    ["GET", "/superadmin/churches"],
    ["POST", "/superadmin/churches", { name: "x", acronym: "xy", admin: { name: "x", email: "x@x.test" } }],
    ["GET", `/superadmin/churches/${alphaId}`],
    ["PATCH", `/superadmin/churches/${alphaId}`, { name: "hacked" }],
    ["PATCH", `/superadmin/churches/${alphaId}/activate`],
    ["PATCH", `/superadmin/churches/${alphaId}/deactivate`],
    ["PATCH", `/superadmin/churches/${alphaId}/restore`],
    ["DELETE", `/superadmin/churches/${alphaId}`],
    ["DELETE", `/superadmin/churches/${alphaId}/purge`, { confirmName: "Check Church Alpha Intl" }],
  ];
  let blocked = 0;
  for (const [method, path, body] of guarded) {
    const r = await call(method, path, { token: adminToken, body });
    if (r.status === 403) blocked++;
    else bad(`${method} ${path.replace(alphaId, ":id")} returned ${r.status}, expected 403`);
  }
  blocked === guarded.length
    ? ok(`all ${guarded.length} superadmin routes return 403 for a church admin`)
    : bad(`${guarded.length - blocked} of ${guarded.length} superadmin routes were reachable by a church admin`);

  const intact = await call("GET", `/superadmin/churches/${alphaId}`, { token: su });
  intact.json?.data?.name === "Check Church Alpha Intl"
    ? ok("church unchanged after every blocked attempt")
    : bad("church was modified by a blocked request!");

  // --------------------------------------------------------------- purge ---
  section("purge");
  const wrongName = await call("DELETE", `/superadmin/churches/${alphaId}/purge`, {
    token: su,
    body: { confirmName: "not the right name" },
  });
  wrongName.status === 400
    ? ok("purge refuses a mismatched confirmName")
    : bad(`expected 400 for wrong confirmName, got ${wrongName.status}`);

  const purged = await call("DELETE", `/superadmin/churches/${alphaId}/purge`, {
    token: su,
    body: { confirmName: "Check Church Alpha Intl" },
  });
  if (purged.status === 200) {
    const d = purged.json.data.deleted;
    d.users === 1 && d.categories === 12 && d.counters === 2
      ? ok("purge cascades the bootstrap (1 admin, 12 categories, 2 counters)")
      : bad("unexpected cascade counts", JSON.stringify(d));
    created.shift();
  } else {
    bad("purge failed", JSON.stringify(purged.json));
  }

  const gone = await call("GET", `/superadmin/churches/${alphaId}`, { token: su });
  gone.status === 404 ? ok("purged church is gone (404)") : bad(`expected 404, got ${gone.status}`);

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
  // Always clean up, including after a failure part-way through.
  if (token) {
    for (const [id, name] of created) await purge(token, id, name);
    const left = await call("GET", "/superadmin/churches", { token });
    if (left.json?.count === 0) ok("test data cleaned up (0 churches remain)");
    else bad(`${left.json?.count ?? "?"} churches left behind — check manually`);
  }
}

console.log(
  `\n${failed === 0 ? "ALL PASSED" : "FAILED"} — ${passed} passed, ${failed} failed\n`,
);
process.exit(failed === 0 ? 0 : 1);
