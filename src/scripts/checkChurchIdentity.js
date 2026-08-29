// End-to-end check for church location, type, and the three derived
// identifiers.
//
// The claim: the same church name recurs across municipalities — JIL has
// branches in many — so an organisation's acronym carries its locality, while
// the slug that names its storage folder never changes whatever else does.
//
// Run:  npm run dev              (in one terminal)
//       npm run check:identity   (in another)

import { deriveAcronym, buildAcronym, buildSlug } from "../utils/acronym.js";

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
  const suEmail = process.env.SEED_SUPERADMIN_EMAIL;
  const suPassword = process.env.SEED_SUPERADMIN_PASSWORD;
  if (!suEmail || !suPassword) {
    console.error("SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must be set.");
    process.exit(1);
  }

  console.log(`Checking ${BASE}`);
  const su = (await call("POST", "/auth/login", { body: { email: suEmail, password: suPassword } })).json.token;

  let n = 0;
  const mk = async (body) => {
    n += 1;
    const r = await call("POST", "/superadmin/churches", {
      token: su,
      body: { ...body, admin: { name: `Admin ${n}`, email: `admin${n}@identity.test` } },
    });
    if (r.status === 201) created.push([r.json.data.church._id, body.name]);
    return r;
  };

  // ------------------------------------------------------- pure functions ---
  console.log("\nderivation (unit)");
  const cases = [
    ["Jesus is Lord", "standalone", "San Pedro", "JIL", "jil"],
    ["Jesus is Lord", "organization", "San Pedro", "JIL-San Pedro", "jil-san-pedro"],
    ["Jesus is Lord", "organization", "MALAMIG", "JIL-Malamig", "jil-malamig"],
    ["Jesus Our Savior Christian Ministries", "organization", "poblacion", "JOSCM-Poblacion", "joscm-poblacion"],
    ["Jesus is Lord", "organization", "Gen. Trias", "JIL-Gen. Trias", "jil-gen-trias"],
  ];
  for (const [name, type, locality, wantAcronym, wantSlug] of cases) {
    const base = deriveAcronym(name);
    const a = buildAcronym({ base, type, cityMunicipality: locality });
    const s = buildSlug({ base, type, cityMunicipality: locality });
    a === wantAcronym && s === wantSlug
      ? ok(`"${name}" / ${type} / ${locality} -> ${a}  ·  ${s}`)
      : bad(`"${name}" gave ${a} · ${s}, expected ${wantAcronym} · ${wantSlug}`);
  }

  // -------------------------------------------------------- the real case ---
  console.log("\ntwo branches of the same organisation");
  const sanPedro = await mk({
    name: "Jesus is Lord", type: "organization",
    cityMunicipality: "San Pedro", province: "Laguna",
  });
  const malamig = await mk({
    name: "Jesus is Lord", type: "organization",
    cityMunicipality: "Malamig", province: "Rizal",
  });

  const a = sanPedro.json?.data?.church;
  const b = malamig.json?.data?.church;
  if (!a || !b) { bad("could not create both branches", JSON.stringify([sanPedro.json, malamig.json])); process.exit(1); }

  a.acronym === "JIL-San Pedro" && b.acronym === "JIL-Malamig"
    ? ok(`same name, different places, meaningful acronyms: ${a.acronym} · ${b.acronym}`)
    : bad(`acronyms wrong: ${a.acronym} · ${b.acronym}`);
  !/2$/.test(a.acronym) && !/2$/.test(b.acronym)
    ? ok("no numeric fallback — the locality did the disambiguating")
    : bad("a numeric suffix leaked in");
  a.slug === "jil-san-pedro" && b.slug === "jil-malamig"
    ? ok(`slugs are path-safe: ${a.slug} · ${b.slug}`)
    : bad(`slugs wrong: ${a.slug} · ${b.slug}`);
  a.emailDomain === "jil.com" && b.emailDomain === "jil.com"
    ? ok("both branches share jil.com — the locality never reaches the domain")
    : bad(`email domains wrong: ${a.emailDomain} · ${b.emailDomain}`);
  a.province === "Laguna" && b.province === "Rizal"
    ? ok("province stored per branch")
    : bad("province not stored");

  // ---------------------------------------------------------- standalone ----
  console.log("\nstandalone");
  const solo = await mk({
    name: "Christ Gospel Fellowship", type: "standalone",
    cityMunicipality: "Binan", province: "Laguna",
  });
  const s = solo.json?.data?.church;
  s?.acronym === "CGF"
    ? ok("a standalone church keeps the bare acronym, no locality appended")
    : bad(`standalone acronym was ${s?.acronym}`);
  s?.cityMunicipality === "Binan"
    ? ok("its locality is still stored, just not used in the acronym")
    : bad("locality not stored for a standalone church");

  const defaulted = await mk({ name: "Bethel Chapel" });
  defaulted.json?.data?.church?.type === "standalone"
    ? ok("type defaults to standalone when omitted")
    : bad(`type defaulted to ${defaulted.json?.data?.church?.type}`);

  // ---------------------------------------------------------- validation ----
  console.log("\nvalidation");
  const noLocality = await mk({ name: "Rock Church", type: "organization" });
  noLocality.status === 400
    ? ok("an organization without a locality is rejected")
    : bad(`expected 400, got ${noLocality.status}`);

  const badType = await mk({ name: "Odd Church", type: "franchise" });
  badType.status === 400
    ? ok("an unknown type is rejected")
    : bad(`expected 400 for a bad type, got ${badType.status}`);

  // Two JIL organisations in the SAME place is a genuine clash.
  const twin = await mk({
    name: "Jesus is Lord", type: "organization", cityMunicipality: "San Pedro",
  });
  twin.json?.data?.church?.acronym === "JIL-San Pedro2"
    ? ok(`a genuine clash still falls back to a suffix: ${twin.json.data.church.acronym}`)
    : bad(`clash gave ${twin.json?.data?.church?.acronym}`);
  twin.json?.data?.church?.slug === "jil-san-pedro2"
    ? ok("the slug is disambiguated independently")
    : bad(`clash slug was ${twin.json?.data?.church?.slug}`);

  // ----------------------------------------------------------- switching ----
  console.log("\nswitching type keeps the slug");
  const originalSlug = s.slug;
  const upgraded = await call("PATCH", `/superadmin/churches/${s._id}`, {
    token: su, body: { type: "organization" },
  });
  upgraded.json?.data?.acronym === "CGF-Binan"
    ? ok("standalone -> organization re-derives the acronym (CGF -> CGF-Binan)")
    : bad(`acronym after upgrade was ${upgraded.json?.data?.acronym}`);
  upgraded.json?.data?.slug === originalSlug
    ? ok(`the slug is untouched (${originalSlug}) — uploaded files stay reachable`)
    : bad(`slug changed to ${upgraded.json?.data?.slug}`);

  const moved = await call("PATCH", `/superadmin/churches/${s._id}`, {
    token: su, body: { cityMunicipality: "Santa Rosa" },
  });
  moved.json?.data?.acronym === "CGF-Santa Rosa" && moved.json?.data?.slug === originalSlug
    ? ok("changing the locality re-derives the acronym, still not the slug")
    : bad(`after move: ${moved.json?.data?.acronym} · ${moved.json?.data?.slug}`);

  const downgraded = await call("PATCH", `/superadmin/churches/${s._id}`, {
    token: su, body: { type: "standalone" },
  });
  downgraded.json?.data?.acronym === "CGF"
    ? ok("organization -> standalone drops the locality from the acronym")
    : bad(`acronym after downgrade was ${downgraded.json?.data?.acronym}`);

  const explicit = await call("PATCH", `/superadmin/churches/${s._id}`, {
    token: su, body: { type: "organization", acronym: "CGF-Main" },
  });
  explicit.json?.data?.acronym === "CGF-Main"
    ? ok("an explicit acronym wins over the derived one")
    : bad(`explicit acronym was overwritten with ${explicit.json?.data?.acronym}`);

  const slugAttempt = await call("PATCH", `/superadmin/churches/${s._id}`, {
    token: su, body: { slug: "hacked" },
  });
  slugAttempt.status === 400
    ? ok("slug cannot be changed through update")
    : bad(`slug edit returned ${slugAttempt.status}, expected 400`);

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
