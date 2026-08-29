// Seeds two churches with deliberately parallel data and LEAVES them in place,
// so the isolation problem can be poked at by hand in Postman rather than only
// through the automated gate.
//
// Same seeder the leak check uses; the difference is that this one does not
// clean up. Prints the credentials for both churches' admins at the end.
//
// Run:  npm run dev            (in one terminal)
//       npm run seed:churches  (in another)
//
// To remove them again: npm run check:tenant purges everything first, or purge
// each church by hand from the superadmin endpoints.

import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import { seedTwoChurches } from "./lib/seedChurches.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

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
    console.error("Refusing to run against production — this seeds throw-away churches.");
    process.exit(1);
  }
  const email = process.env.SEED_SUPERADMIN_EMAIL;
  const password = process.env.SEED_SUPERADMIN_PASSWORD;
  if (!email || !password) {
    console.error("SEED_SUPERADMIN_EMAIL and SEED_SUPERADMIN_PASSWORD must be set.");
    process.exit(1);
  }

  await connectDB();

  const login = await call("POST", "/auth/login", { body: { email, password } });
  if (!login.json?.token) {
    console.error(`superadmin login failed (${login.status}): ${JSON.stringify(login.json)}`);
    console.error("If this says too many attempts, restart the server — the rate limiter is in memory.");
    process.exit(1);
  }

  const existing = await call("GET", "/superadmin/churches", { token: login.json.token });
  if (existing.json?.count) {
    console.log(`${existing.json.count} church(es) already present — purging first`);
    for (const c of existing.json.data) {
      await call("DELETE", `/superadmin/churches/${c._id}/purge`, {
        token: login.json.token, body: { confirmName: c.name },
      });
    }
  }

  const { a, b } = await seedTwoChurches({ call, token: login.json.token });

  console.log("\nSeeded two churches with parallel data.\n");
  for (const c of [a, b]) {
    console.log(`  ${c.church.name}  [${c.church.acronym}]`);
    console.log(`    churchId  ${c.churchId}`);
    console.log(`    admin     ${c.adminEmail}`);
    console.log(`    password  ${c.adminPassword}`);
    console.log(`    marker    ${c.marker}  (on every record it owns)`);
    console.log("");
  }
  console.log("Log in with { church, email, password } and check whether the other");
  console.log("church's marker shows up anywhere it should not.\n");

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error("seed failed:", error.message);
  if (mongoose.connection.readyState) await mongoose.disconnect();
  process.exit(1);
});
