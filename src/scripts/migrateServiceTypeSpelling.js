// One-time migration: "Anniversay Service" → "Anniversary Service".
//
// The typo lived in the schema since the original single-church build, so it
// lived in the data too. `businessRequirements` §14 item 6 said correcting the
// enum needs a migration, and that leaving the typo is fine while fixing it
// half-way is not — half-way being a corrected enum with old rows still in the
// database, which then fail validation on their next save.
//
// This repo's own clusters were empty when the enum was corrected, so there was
// nothing to migrate. This script exists for the databases that are not:
//
//   • JOSCM's production data, whenever it is imported as a customer. The
//     import must map the spelling — either by calling this afterwards, or by
//     mapping it inline. Running this after an import that already mapped it is
//     harmless; it reports 0 rows.
//   • any development database that predates the correction.
//
// Idempotent: it matches only the old spelling, so a second run changes nothing.
//
// Run:  npm run migrate:service-type
//       NODE_ENV=production npm run migrate:service-type

import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import { connectDB } from "../config/db.js";
import { Tithes } from "../models/TithesEntry.js";

export const OLD_SERVICE_TYPE = "Anniversay Service";
export const NEW_SERVICE_TYPE = "Anniversary Service";

// The migration itself, separated from the command-line wrapper so a check can
// call it against rows it planted. A migration that only ever runs once, on
// real data, is the last place to accept untested code — and the empty-database
// path this repo actually has proves almost nothing on its own.
//
// The caller owns the connection.
export const migrateServiceTypeSpelling = async () => {
  const before = await Tithes.countDocuments({ serviceType: OLD_SERVICE_TYPE });
  if (before === 0) return { before: 0, modified: 0, remaining: 0 };

  // updateMany bypasses the enum validator, which is the point — the reason
  // these rows need moving is precisely that they no longer satisfy it.
  const res = await Tithes.updateMany(
    { serviceType: OLD_SERVICE_TYPE },
    { $set: { serviceType: NEW_SERVICE_TYPE } },
  );

  // Counted again rather than trusting modifiedCount, so the result says what
  // is in the database and not what the driver reported doing.
  const remaining = await Tithes.countDocuments({ serviceType: OLD_SERVICE_TYPE });
  return { before, modified: res.modifiedCount, remaining };
};

// Only when executed directly, so importing this file runs nothing.
const executedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (executedDirectly) {
  try {
    await connectDB();
    const { before, modified, remaining } = await migrateServiceTypeSpelling();

    console.log(`rows with "${OLD_SERVICE_TYPE}": ${before}`);
    if (before === 0) {
      console.log("nothing to migrate.");
    } else {
      console.log(`updated: ${modified}`);
      console.log(`remaining with the old spelling: ${remaining}`);
      console.log(
        `rows with "${NEW_SERVICE_TYPE}" now: ` +
          `${await Tithes.countDocuments({ serviceType: NEW_SERVICE_TYPE })}`,
      );
      if (remaining !== 0) {
        console.error(`FAILED — ${remaining} row(s) still carry the old spelling.`);
        process.exitCode = 1;
      }
    }
  } catch (error) {
    console.error("migration failed:", error?.message);
    process.exitCode = 1;
  } finally {
    if (mongoose.connection.readyState) await mongoose.disconnect();
  }
}
