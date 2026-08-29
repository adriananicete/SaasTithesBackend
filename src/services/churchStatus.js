import { Church } from "../models/Church.js";

// Caches whether a church may currently be used, so the per-request guard does
// not add a database round trip to every call.
//
// The problem it solves: verifyToken is deliberately stateless — it only
// verifies the JWT signature and never touches the database. That is the right
// call for a 15-minute access token, but it means a church deactivated by the
// superadmin would keep working for whoever already holds a valid token, for up
// to those 15 minutes. Login and refresh already refuse; this closes the
// in-session window.
//
// State lives in memory and is invalidated explicitly on every write, so the
// answer is never stale within a process. Like presence.js, it is per Node
// instance and resets on restart — which is safe, because a cold cache only
// means the next request pays for one lookup.

const status = new Map(); // churchId (string) -> { usable, cachedAt }

// A backstop only. Correctness comes from invalidateChurchStatus being called
// on every state change; this just bounds how long a missed invalidation, or a
// write from another process, could go unnoticed.
const TTL_MS = 60 * 1000;

export const invalidateChurchStatus = (churchId) => {
  if (!churchId) return;
  status.delete(String(churchId));
};

export const clearChurchStatusCache = () => status.clear();

// True when the church exists, is active, and has not been soft-deleted.
export const isChurchUsable = async (churchId) => {
  if (!churchId) return false;

  const key = String(churchId);
  const hit = status.get(key);
  if (hit && Date.now() - hit.cachedAt < TTL_MS) return hit.usable;

  const church = await Church.findById(key).select("isActive deletedAt").lean();
  const usable = Boolean(church && church.isActive && !church.deletedAt);

  status.set(key, { usable, cachedAt: Date.now() });
  return usable;
};
