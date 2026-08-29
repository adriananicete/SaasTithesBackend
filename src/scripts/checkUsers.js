// End-to-end check for church-scoped user and category management.
//
// Covers two things: that a church admin can only ever see and touch their own
// church's users and categories, and that POST /api/admin/users works again —
// it had been broken since `church` became required, leaving every church stuck
// with the single admin its bootstrap created.
//
// Run:  npm run dev        (in one terminal)
//       npm run check:users    (in another)

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

  console.log(`Checking ${BASE}`);
  const suLogin = await call("POST", "/auth/login", { body: { email, password } });
  const su = suLogin.json?.token;
  if (!su) {
    console.error(`superadmin login failed (${suLogin.status}): ${JSON.stringify(suLogin.json)}`);
    console.error("If this says too many attempts, restart the server — the rate limiter is in memory.");
    process.exit(1);
  }

  const mk = async (name, slugHint) => {
    const r = await call("POST", "/superadmin/churches", {
      token: su,
      body: { name, admin: { name: `${name} Admin`, email: `admin@${slugHint}.test` } },
    });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(r.json)}`);
    created.push([r.json.data.church._id, name]);
    const login = await call("POST", "/auth/login", {
      body: { church: r.json.data.church._id, email: `admin@${slugHint}.test`, password: r.json.data.adminPassword },
    });
    return { id: r.json.data.church._id, token: login.json?.token };
  };

  const a = await mk("Users Alpha", "ualpha");
  const b = await mk("Users Beta", "ubeta");

  // ------------------------------------------------------ createUser works ---
  console.log("\nPOST /admin/users works again");
  const madePastor = await call("POST", "/admin/users", {
    token: a.token,
    body: { name: "Alpha Pastor", email: "pastor@ualpha.test", password: "TempPass123!", role: "pastor" },
  });
  madePastor.status === 201
    ? ok("a church admin can add a pastor (this was broken since church became required)")
    : bad(`createUser returned ${madePastor.status}`, JSON.stringify(madePastor.json));
  const pastorId = madePastor.json?.data?._id;

  String(madePastor.json?.data?.church) === String(a.id)
    ? ok("the new user is stamped with the admin's own church")
    : bad(`new user church was ${madePastor.json?.data?.church}, expected ${a.id}`);

  // Church B adds a user with the SAME email — allowed, different church.
  const betaSame = await call("POST", "/admin/users", {
    token: b.token,
    body: { name: "Beta Pastor", email: "pastor@ualpha.test", password: "TempPass123!", role: "pastor" },
  });
  betaSame.status === 201
    ? ok("the same email is accepted in a different church")
    : bad(`expected 201 for a same-email user in church B, got ${betaSame.status}`, JSON.stringify(betaSame.json));

  const dupe = await call("POST", "/admin/users", {
    token: a.token,
    body: { name: "Dupe", email: "pastor@ualpha.test", password: "TempPass123!", role: "member" },
  });
  dupe.status === 400
    ? ok("but rejected as a duplicate within the same church")
    : bad(`expected 400 for a duplicate in the same church, got ${dupe.status}`);

  const superattempt = await call("POST", "/admin/users", {
    token: a.token,
    body: { name: "Sneaky", email: "sneaky@ualpha.test", password: "TempPass123!", role: "superadmin" },
  });
  superattempt.status === 400
    ? ok("a church admin cannot mint a superadmin")
    : bad(`expected 400 for role=superadmin, got ${superattempt.status}`);

  // ----------------------------------------------------------- user reads ---
  console.log("\nusers are church-scoped");
  const listA = await call("GET", "/admin/users", { token: a.token });
  const namesA = (listA.json ?? []).map((u) => u.name);
  namesA.some((n) => n.includes("Beta"))
    ? bad("church B users appeared in church A's list", namesA.join(", "))
    : ok(`church A lists only its own (${namesA.join(", ")})`);

  const betaUsers = await call("GET", "/admin/users", { token: b.token });
  const betaPastorId = betaUsers.json?.find((u) => u.name === "Beta Pastor")?._id;

  const peek = await call("GET", `/admin/users/${betaPastorId}`, { token: a.token });
  peek.status === 404
    ? ok("reading a church B user by id returns 404")
    : bad(`expected 404, got ${peek.status}`);

  // ---------------------------------------------------------- user writes ---
  console.log("\ncross-church user writes are refused");
  for (const [method, path, body] of [
    ["PATCH", `/admin/users/${betaPastorId}`, { name: "hijacked" }],
    ["PATCH", `/admin/users/${betaPastorId}/deactivate`, {}],
    ["DELETE", `/admin/users/${betaPastorId}`, null],
  ]) {
    const r = await call(method, path, { token: a.token, ...(body ? { body } : {}) });
    r.status === 404
      ? ok(`404 ${method} /admin/users/:churchB_id${path.endsWith("deactivate") ? "/deactivate" : ""}`)
      : bad(`${method} ${path} returned ${r.status}, expected 404`);
  }

  const stillThere = await call("GET", `/admin/users/${betaPastorId}`, { token: b.token });
  stillThere.json?.data?.findUserById?.name === "Beta Pastor"
    ? ok("church B's user is untouched after every attempt")
    : bad("church B's user was modified");

  // --------------------------------------------------- update whitelisting ---
  console.log("\nupdate accepts only its whitelist");
  const moveChurch = await call("PATCH", `/admin/users/${pastorId}`, {
    token: a.token, body: { church: b.id },
  });
  moveChurch.status === 400
    ? ok("`church` is not an editable field — a user cannot be moved between tenants")
    : bad(`expected 400, got ${moveChurch.status}`);

  const setPassword = await call("PATCH", `/admin/users/${pastorId}`, {
    token: a.token, body: { password: "plaintext" },
  });
  setPassword.status === 400
    ? ok("`password` is not editable here — it would have been stored unhashed")
    : bad(`expected 400 for a password edit, got ${setPassword.status}`);

  const badRole = await call("PATCH", `/admin/users/${pastorId}`, {
    token: a.token, body: { role: "superadmin" },
  });
  badRole.status === 400
    ? ok("a user cannot be promoted to superadmin")
    : bad(`expected 400, got ${badRole.status}`);

  const rename = await call("PATCH", `/admin/users/${pastorId}`, {
    token: a.token, body: { name: "Alpha Pastor Renamed" },
  });
  rename.json?.data?.updatedUser?.name === "Alpha Pastor Renamed"
    ? ok("a whitelisted field still updates normally")
    : bad("rename failed", JSON.stringify(rename.json));

  // ----------------------------------------------------------- categories ---
  console.log("\ncategories are church-scoped");
  const catsA = await call("GET", "/admin/categories", { token: a.token });
  const catsB = await call("GET", "/admin/categories", { token: b.token });
  const idsA = new Set((catsA.json ?? []).map((c) => String(c._id)));
  const overlap = (catsB.json ?? []).filter((c) => idsA.has(String(c._id)));
  overlap.length === 0
    ? ok(`each church sees only its own ${catsA.json?.length} categories, no shared ids`)
    : bad(`${overlap.length} categories appear in both churches`);

  (catsA.json ?? []).every((c) => String(c.church) === String(a.id))
    ? ok("every category returned belongs to the caller's church")
    : bad("a category from another church was returned");

  const newCat = await call("POST", "/admin/categories", {
    token: a.token, body: { name: "Alpha Only", type: "rf", color: "blue" },
  });
  String(newCat.json?.data?.newCategory?.church) === String(a.id)
    ? ok("a created category is stamped with the caller's church")
    : bad(`new category church was ${newCat.json?.data?.newCategory?.church}`);

  const bCatId = catsB.json?.[0]?._id;
  for (const [method, path, body] of [
    ["PATCH", `/admin/categories/${bCatId}`, { name: "hijacked" }],
    ["DELETE", `/admin/categories/${bCatId}`, null],
  ]) {
    const r = await call(method, path, { token: a.token, ...(body ? { body } : {}) });
    r.status === 404
      ? ok(`404 ${method} /admin/categories/:churchB_id`)
      : bad(`${method} returned ${r.status}, expected 404`);
  }

  const bCatsAfter = await call("GET", "/admin/categories", { token: b.token });
  bCatsAfter.json?.length === catsB.json?.length
    ? ok("church B still has all its categories")
    : bad(`church B went from ${catsB.json?.length} to ${bCatsAfter.json?.length} categories`);

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
