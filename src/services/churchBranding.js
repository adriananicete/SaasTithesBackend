import { Church } from "../models/Church.js";

// Caches what an export needs to print a church's identity on it: its name and
// its logo as raw bytes.
//
// The name is one cheap lookup; the LOGO is why this cache exists. It lives in
// Cloudinary, so putting it on a document means an HTTP round trip to fetch and
// buffer an image before rendering can start — on every export, and the
// combined report embeds it on two sheets and a PDF. A church's branding
// changes a few times a year at most, so fetching it per export would be paying
// a network hop over and over for a value that essentially never moves.
//
// Same shape as services/churchStatus.js: per Node instance, invalidated
// explicitly on every branding write, with a TTL as a backstop only. A cold
// cache costs one lookup; a stale one shows a logo that was replaced minutes
// ago, which the explicit invalidation is there to prevent.

const branding = new Map(); // churchId (string) -> { name, logoBuffer, cachedAt }

const TTL_MS = 10 * 60 * 1000;

export const invalidateChurchBranding = (churchId) => {
  if (!churchId) return;
  branding.delete(String(churchId));
};

export const clearChurchBrandingCache = () => branding.clear();

// Downloads the logo. A church without one, or one whose image cannot be
// fetched, gets `null` — an export must still produce a valid document. A
// missing logo is a cosmetic gap; a failed export is a broken feature.
const fetchLogo = async (logoUrl) => {
  if (!logoUrl) return null;
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
};

// { name, logoBuffer } for one church. Never throws: callers are export
// handlers, and a branding lookup must not be the thing that fails a report.
export const getChurchBranding = async (churchId) => {
  const empty = { name: "", logoBuffer: null };
  if (!churchId) return empty;

  const key = String(churchId);
  const hit = branding.get(key);
  if (hit && Date.now() - hit.cachedAt < TTL_MS) {
    return { name: hit.name, logoBuffer: hit.logoBuffer };
  }

  try {
    const church = await Church.findById(key).select("name logoUrl").lean();
    if (!church) return empty;

    const entry = {
      name: church.name ?? "",
      logoBuffer: await fetchLogo(church.logoUrl),
      cachedAt: Date.now(),
    };
    branding.set(key, entry);
    return { name: entry.name, logoBuffer: entry.logoBuffer };
  } catch (error) {
    console.error(`getChurchBranding failed for ${key}:`, error?.message);
    return empty;
  }
};
