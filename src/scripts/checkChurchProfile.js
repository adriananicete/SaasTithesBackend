// End-to-end check for the tenant-facing church profile and branding.
//
// Two things are being proved. The first is the obvious one: a church reads and
// edits its own record and cannot address another's — these endpoints take no
// church id at all, which is a stronger guarantee than filtering one out, so
// the check tries to retarget them through the body instead.
//
// The second needs a real Cloudinary upload, and is worth it. Uploads used to
// land in a module-load constant folder, `joscm/receipts` and `joscm/avatars`
// — every church's files in one folder named after the first customer. Worse,
// `purgeChurch` has been deleting `churches/<slug>` since Branch 5b, so it was
// deleting nothing: purging a church left its receipts and avatars sitting in
// Cloudinary forever. Proving that is fixed means uploading a real file and
// then watching a purge remove it.
//
// Run:  npm run dev            (in one terminal)
//       npm run check:profile    (in another)

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { connectDB } from "../config/db.js";
import cloudinary from "../config/cloudinary.js";
import { User } from "../models/User.js";
import { Church } from "../models/Church.js";
import { AuditLog } from "../models/AuditLog.js";
import { cloudinaryErrorText, destroyCloudinaryAsset } from "../utils/cloudinaryCleanup.js";

const BASE = process.env.CHECK_BASE_URL || "http://localhost:7001/api";

// The smallest valid PNG, so the upload proves the path without moving bytes.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

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

const upload = async (path, token, field, buffer, filename) => {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type: "image/png" }), filename);
  const res = await fetch(BASE + path, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  let json = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, json };
};

const cloudinaryCount = async (prefix) => {
  const res = await cloudinary.api.resources({ type: "upload", prefix, max_results: 100 });
  return res.resources.length;
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

  const build = async (name, slugHint) => {
    const r = await call("POST", "/superadmin/churches", {
      token: su,
      body: { name, admin: { name: `${name} Admin`, email: `admin@${slugHint}.test` } },
    });
    if (r.status !== 201) throw new Error(`could not create ${name}: ${JSON.stringify(r.json)}`);
    const church = r.json.data.church;
    created.push([church._id, name]);

    const adminLogin = await call("POST", "/auth/login", {
      body: { church: church._id, email: `admin@${slugHint}.test`, password: r.json.data.adminPassword },
    });

    const hashed = await bcrypt.hash("SeedPass123!", 10);
    await User.create({
      church: church._id, name: `${name} Member`, email: `member@${slugHint}.test`,
      password: hashed, role: "member", isActive: true,
    });
    const memberLogin = await call("POST", "/auth/login", {
      body: { church: church._id, email: `member@${slugHint}.test`, password: "SeedPass123!" },
    });

    return {
      church, churchId: church._id, name,
      token: adminLogin.json?.token,
      memberToken: memberLogin.json?.token,
    };
  };

  const a = await build("Brand Alpha", "balpha");
  const b = await build("Brand Beta", "bbeta");

  // ------------------------------------------------------------- reading ----
  console.log("\nevery role reads its own church");
  const asAdmin = await call("GET", "/church/me", { token: a.token });
  is(asAdmin.json?.data?.name, "Brand Alpha", "the admin gets their own church");

  const asMember = await call("GET", "/church/me", { token: a.memberToken });
  is(asMember.status, 200, "a member may read it too — the header renders the branding");
  is(asMember.json?.data?.name, "Brand Alpha", "and gets the same church");

  const asB = await call("GET", "/church/me", { token: b.token });
  is(asB.json?.data?.name, "Brand Beta", "church B's admin gets church B");
  is(String(asB.json?.data?._id) === String(a.churchId), false, "which is not church A's record");

  // ------------------------------------------------------------- writing ----
  console.log("\nonly the church's own admin may edit it");
  const edit = await call("PATCH", "/church/me", {
    token: a.token,
    body: { address: "12 Alpha Street", contactPhone: "0917-000-0001" },
  });
  is(edit.status, 200, "the admin updates the profile");
  is(edit.json?.data?.address, "12 Alpha Street", "the address is saved");

  const memberEdit = await call("PATCH", "/church/me", {
    token: a.memberToken, body: { address: "hijacked" },
  });
  is(memberEdit.status, 403, "a member editing the profile is 403");

  console.log("\nidentity and vendor fields are not editable from here");
  const forbidden = await call("PATCH", "/church/me", {
    token: a.token,
    body: { slug: "hijacked-slug", isActive: false, name: "Renamed", acronym: "HAX" },
  });
  is(forbidden.status, 400, "a payload of only non-editable fields is refused");

  const mixed = await call("PATCH", "/church/me", {
    token: a.token,
    body: { contactEmail: "office@alpha.test", slug: "hijacked-slug", isActive: false },
  });
  is(mixed.status, 200, "a valid field alongside forbidden ones still succeeds");
  is(mixed.json?.data?.contactEmail, "office@alpha.test", "the valid field is applied");

  const stillA = await Church.findById(a.churchId);
  is(stillA.slug, a.church.slug, "the slug is untouched — it names the storage folder");
  is(stillA.isActive, true, "isActive is untouched — that is the vendor's switch");
  is(stillA.name, "Brand Alpha", "the name is untouched — identity stays with the superadmin");

  // The endpoints take no church id, so the only way to try is through the body.
  console.log("\nthe body cannot retarget another church");
  const retarget = await call("PATCH", "/church/me", {
    token: a.token,
    body: { church: b.churchId, _id: b.churchId, address: "reached church B" },
  });
  is(retarget.status, 200, "the request succeeds — against the caller's own church");

  const bAfter = await Church.findById(b.churchId);
  is(bAfter.address, undefined, "church B's address is untouched");
  const aAfter = await Church.findById(a.churchId);
  is(aAfter.address, "reached church B", "church A's is what changed");

  // --------------------------------------------------------- the audit row --
  console.log("\nprofile edits are audited, in the right church");
  const aLog = await call("GET", "/audit-log", { token: a.token });
  const profileRows = (aLog.json?.data ?? []).filter((r) => r.action === "church.update_profile");
  profileRows.length > 0
    ? ok(`${profileRows.length} church.update_profile row(s) in church A's log`)
    : bad("the profile edit was not audited");
  is(profileRows[0]?.targetModel, "Church", "the row targets a Church");

  const bLog = await call("GET", "/audit-log", { token: b.token });
  is((bLog.json?.data ?? []).length, 0, "church B's log is empty — nothing bled across");

  // ------------------------------------------------------- the real upload --
  // The part that needs Cloudinary. A failure here is reported as unverified
  // rather than passed: the folder change is the whole point of the branch.
  console.log("\nuploads land under churches/<slug>/, and a purge removes them");
  const prefixA = `churches/${a.church.slug}`;
  let uploaded;
  try {
    uploaded = await upload("/church/me/logo", a.token, "logo", ONE_PIXEL_PNG, "logo.png");
  } catch (error) {
    bad("the logo upload could not be attempted", error.message);
    return su;
  }

  if (uploaded.status !== 200) {
    bad("the logo upload failed", `${uploaded.status} ${JSON.stringify(uploaded.json)}`);
    console.log("       (Cloudinary credentials missing or unreachable? the folder change is UNVERIFIED)");
    return su;
  }
  ok("the admin uploads a church logo");

  const logoUrl = uploaded.json?.data?.logoUrl ?? "";
  logoUrl.includes(`churches/${a.church.slug}/logo`)
    ? ok(`it landed in churches/${a.church.slug}/logo`)
    : bad("the logo did not land in the church's own folder", logoUrl);
  logoUrl.includes("joscm/")
    ? bad("it went to the old hardcoded joscm/ folder", logoUrl)
    : ok("and not in the old hardcoded joscm/ folder");

  is(await cloudinaryCount(prefixA), 1, `Cloudinary holds 1 file under ${prefixA}`);

  const removed = await call("DELETE", "/church/me/logo", { token: a.token });
  is(removed.status, 200, "the admin removes the logo");
  const clearedChurch = await Church.findById(a.churchId);
  is(clearedChurch.logoUrl, null, "logoUrl is cleared");
  is(await cloudinaryCount(prefixA), 0, "and the file is gone from Cloudinary");

  // Put one back, then purge the church and confirm the cascade reaches it.
  const again = await upload("/church/me/logo", a.token, "logo", ONE_PIXEL_PNG, "logo.png");
  is(again.status, 200, "a second logo is uploaded");
  is(await cloudinaryCount(prefixA), 1, "Cloudinary holds it again");

  const purge = await call("DELETE", `/superadmin/churches/${a.churchId}/purge`, {
    token: su, body: { confirmName: a.name },
  });
  is(purge.status, 200, "the superadmin purges church A");
  is(await cloudinaryCount(prefixA), 0,
    "the purge cascade removed the church's files — it deleted nothing before this branch");

  // A church's audit rows go with it.
  is(await AuditLog.countDocuments({ church: a.churchId }), 0, "and its audit rows are gone");

  // ------------------------------------------- the shape purge relies on ----
  // purgeChurch treats a 404 from delete_folder as success — a church that
  // uploaded nothing has no folder, and deleting nothing is not a failure. That
  // decision rests on a specific error shape from a third party, so it is
  // pinned here: if Cloudinary ever changes it, this goes red instead of the
  // purge quietly reporting failures again (or, worse, swallowing real ones).
  console.log("\nthe Cloudinary error shape the purge depends on");
  const missingPrefix = `churches/not-a-real-church-${Date.now()}`;

  const emptyPrefix = await cloudinary.api
    .delete_resources_by_prefix(missingPrefix)
    .then(() => "resolved")
    .catch((e) => `threw: ${e?.error?.message ?? e?.message}`);
  is(emptyPrefix, "resolved",
    "delete_resources_by_prefix succeeds on a prefix with nothing under it");

  let folderError = null;
  try {
    await cloudinary.api.delete_folder(missingPrefix);
    bad("delete_folder resolved for a folder that does not exist",
      "the purge's 404 branch would never run — re-check the assumption");
  } catch (error) {
    folderError = error;
    ok("delete_folder rejects for a folder that does not exist");
  }

  if (folderError) {
    is(folderError.error?.http_code, 404, "the status is on error.http_code, and it is 404");
    typeof folderError.error?.message === "string" && folderError.error.message.length > 0
      ? ok("the human-readable reason is on error.message")
      : bad("error.message is not where the purge reads it from");
    // This is the bug that made every one of those log lines say "undefined".
    is(folderError.message, undefined,
      "and the TOP-level .message is undefined — reading it is what printed 'undefined'");
  }

  // ------------------------------------ the OTHER shape, and the helper -----
  // uploader.* fails flat where api.* fails nested, so a reader that handles
  // only one prints "undefined" for the other — the item 11 bug in reverse.
  // Both shapes go through cloudinaryErrorText, so both are pinned here.
  console.log("\ndeleting an asset: the second error shape, and the shared reader");

  const gone = await cloudinary.uploader
    .destroy(`not-a-real-asset-${Date.now()}`)
    .then((r) => r?.result)
    .catch(() => "threw");
  is(gone, "not found",
    "uploader.destroy RESOLVES with 'not found' for a missing id — it does not throw");

  let flatError = null;
  try {
    await cloudinary.uploader.destroy("");
    bad("uploader.destroy resolved for an empty public_id", "expected it to reject");
  } catch (error) {
    flatError = error;
    ok("uploader.destroy rejects for an empty public_id");
  }

  if (flatError) {
    typeof flatError.message === "string" && flatError.message.length > 0
      ? ok("this one puts the reason on the TOP-level .message — the opposite of api.*")
      : bad("the uploader error does not carry a top-level message");
    is(flatError.error, undefined, "and has no nested .error at all");
  }

  // The reader has to survive both without ever printing "undefined".
  const nestedText = cloudinaryErrorText(folderError);
  const flatText = cloudinaryErrorText(flatError);
  !nestedText.includes("undefined")
    ? ok(`cloudinaryErrorText reads the nested shape — "${nestedText.slice(0, 48)}…"`)
    : bad("cloudinaryErrorText printed undefined for the nested shape", nestedText);
  !flatText.includes("undefined")
    ? ok(`and the flat shape — "${flatText.slice(0, 48)}…"`)
    : bad("cloudinaryErrorText printed undefined for the flat shape", flatText);

  // A missing id is the outcome the caller wanted, so the helper reports success.
  is(await destroyCloudinaryAsset(`not-a-real-asset-${Date.now()}`, "a check"), true,
    "destroyCloudinaryAsset treats an already-absent asset as done");
  is(await destroyCloudinaryAsset(null, "a check"), true,
    "and does nothing at all when there is no public id");

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
