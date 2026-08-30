import { Counter } from "../models/Counter.js";

// Atomic per-church document numbering: RF-0001, PCF-0042.
//
// Both numbers used to be produced by reading the newest document and adding
// one. That is racy with a single church and always was — two creates landing
// in the same moment read the same "last" row and both claim the next number,
// which the compound unique index on { church, rfNo } then rejects, so one
// user's submission fails for no reason they can see. It also meant deleting
// the newest draft handed its number to the next create, quietly reusing a
// ledger identifier (businessRequirements §14 item 4).
//
// $inc inside findOneAndUpdate is resolved by the database, so concurrent
// callers are serialised and each receives a distinct seq. The counter is the
// source of truth, not the documents — a deleted RF's number is never reissued.
//
// Trade-off worth stating: the number is claimed before the document is saved,
// so a create that fails afterwards leaves a gap. Gaps are harmless in a ledger;
// duplicates are not.
export const nextNumber = async (church, key, prefix) => {
  const bump = () =>
    Counter.findOneAndUpdate(
      { church, key },
      { $inc: { seq: 1 } },
      // returnDocument rather than `new: true`: Mongoose 9 deprecates the
      // latter and warns on every call. The repo's other 18 findOneAndUpdate
      // sites still use it and warn today — a separate sweep, not this branch.
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    );

  let counter;
  try {
    counter = await bump();
  } catch (error) {
    // The upsert has its own narrow race: if the counter does not exist yet,
    // two callers can both try to insert it and the unique { church, key }
    // index rejects one. By then the document does exist, so a single retry
    // takes the plain $inc path and succeeds.
    if (error?.code !== 11000) throw error;
    counter = await bump();
  }

  return `${prefix}-${String(counter.seq).padStart(4, "0")}`;
};
