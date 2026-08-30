// End-to-end check for per-church document numbering.
//
// RF-#### and PCF-#### are ledger identifiers, and both used to be produced by
// reading the newest document and adding one. Two creates in the same moment
// read the same "last" row, both claim the next number, and the compound unique
// index rejects one — a member's submission fails for no reason they can see.
// The same read-and-add-one also handed a deleted draft's number to the next
// create, quietly reusing an identifier that had already appeared in an audit
// row (businessRequirements §14 item 4).
//
// This is the one check in the suite where firing requests SEQUENTIALLY would
// prove nothing at all. The concurrency here is the test.
//
// Run:  npm run dev              (in one terminal)
//       npm run check:numbering    (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import { User } from "../models/User.js";
import { Category } from "../models/Category.js";
import { Counter } from "../models/Counter.js";
import { nextNumber } from "../utils/sequence.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";
const BURST = 10;

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

const seq = (no) => Number(String(no).split("-")[1]);

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

  // Everything here goes through the API. Seeding rows straight into the models
  // with a hand-written "RF-0001" would leave the counter at zero and the next
  // API create would collide — the numbers have to come from the same place the
  // real ones do.
  const build = async (name, slugHint) => {
    const r = await call("POST", "/superadmin/churches", {
      token: su,
      body: { name, admin: { name: `${name} Admin`, email: `admin@${slugHint}.test` } },
    });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(r.json)}`);
    const churchId = r.json.data.church._id;
    created.push([churchId, name]);

    const hashed = await bcrypt.hash("SeedPass123!", 10);
    await User.create({
      church: churchId, name: `${name} Member`, email: `member@${slugHint}.test`,
      password: hashed, role: "member", isActive: true,
    });
    const memberLogin = await call("POST", "/auth/login", {
      body: { church: churchId, email: `member@${slugHint}.test`, password: "SeedPass123!" },
    });

    const rfCategory = await Category.findOne({ church: churchId, type: "rf" });

    return { churchId, name, rfCategory, memberToken: memberLogin.json?.token };
  };

  const makeRf = (c, label) =>
    call("POST", "/request-form", {
      token: c.memberToken,
      body: {
        entryDate: new Date(),
        category: String(c.rfCategory._id),
        estimatedAmount: 100,
        remarks: `${c.name} ${label}`,
      },
    });

  const a = await build("Count Alpha", "calpha");
  const b = await build("Count Beta", "cbeta");

  // ------------------------------------------------------- the actual race --
  console.log(`\n${BURST} concurrent creates in one church`);
  const burst = await Promise.all(
    Array.from({ length: BURST }, (_, i) => makeRf(a, `burst ${i + 1}`)),
  );

  const failures = burst.filter((r) => r.status !== 201);
  failures.length === 0
    ? ok(`all ${BURST} creates succeeded`)
    : bad(`${failures.length} of ${BURST} creates failed`,
        failures.map((f) => `${f.status} ${JSON.stringify(f.json)}`).join(" | "));

  const numbers = burst.filter((r) => r.status === 201).map((r) => r.json?.data?.rfNo);
  const unique = new Set(numbers);
  is(unique.size, numbers.length, `every number is distinct (${unique.size} unique)`);

  const ordered = [...unique].map(seq).sort((x, y) => x - y);
  const contiguous = ordered.every((n, i) => n === ordered[0] + i);
  contiguous
    ? ok(`they run without gaps: RF-${String(ordered[0]).padStart(4, "0")} … RF-${String(ordered.at(-1)).padStart(4, "0")}`)
    : bad("the numbers have gaps", ordered.join(", "));
  is(ordered[0], 1, "and they start at 1 — a new church's first RF is RF-0001");

  const counterA = await Counter.findOne({ church: a.churchId, key: "rfNo" });
  is(counterA?.seq, BURST, `the counter reads ${BURST}, matching the documents`);

  // ------------------------------------------------------ per church again --
  console.log("\neach church numbers independently");
  const firstB = await makeRf(b, "first");
  is(firstB.json?.data?.rfNo, "RF-0001",
    `church B's first RF is RF-0001 while church A is at RF-${String(BURST).padStart(4, "0")}`);

  const counterB = await Counter.findOne({ church: b.churchId, key: "rfNo" });
  is(counterB?.seq, 1, "church B's counter is its own");

  // ---------------------------------------------------- deleting a draft ----
  // The other half of §14 item 4: read-and-add-one reissued a deleted draft's
  // number, so an identifier already written into an audit row came back on a
  // different document. The counter never looks at the documents.
  console.log("\na deleted draft does not give its number back");
  const doomed = await makeRf(a, "doomed");
  const doomedNo = doomed.json?.data?.rfNo;
  const del = await call("DELETE", `/request-form/${doomed.json?.data?._id}`, { token: a.memberToken });
  is(del.status, 200, `deleted the newest draft (${doomedNo})`);

  const afterDelete = await makeRf(a, "after delete");
  afterDelete.json?.data?.rfNo !== doomedNo
    ? ok(`the next RF is ${afterDelete.json?.data?.rfNo}, not the deleted ${doomedNo}`)
    : bad(`${doomedNo} was reissued after being deleted`);

  // -------------------------------------------------------- the pcfNo key ---
  // Creating a voucher through the API needs a real Cloudinary receipt upload,
  // so the counter is exercised directly for that key. Same helper, same race.
  console.log("\nthe voucher counter behaves the same under concurrency");
  const pcfs = await Promise.all(
    Array.from({ length: BURST }, () => nextNumber(a.churchId, "pcfNo", "PCF")),
  );
  is(new Set(pcfs).size, BURST, `${BURST} concurrent PCF numbers, all distinct`);
  is(pcfs.map(seq).sort((x, y) => x - y)[0], 1, "starting at PCF-0001");

  // A church created before the bootstrap seeded counters — or one whose row
  // was removed — must still number correctly rather than throw.
  console.log("\nthe counter is created on demand if it is missing");
  await Counter.deleteOne({ church: b.churchId, key: "pcfNo" });
  const revived = await nextNumber(b.churchId, "pcfNo", "PCF");
  is(revived, "PCF-0001", "a missing counter is upserted and starts at 1");

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
