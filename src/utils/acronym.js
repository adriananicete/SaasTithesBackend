// Derives a church acronym from its name, so the superadmin only has to type
// the name. "Jesus is Lord" -> JIL, "Christ Gospel Fellowship" -> CGF.
//
// The acronym is not cosmetic: it namespaces the church's Cloudinary folder
// and seeds the name@<acronym>.com email convention, so it is restricted to
// letters and digits.

const MAX_LENGTH = 10;

export const deriveAcronym = (name) => {
  const words = String(name ?? "")
    // Apostrophes are dropped, not treated as separators — otherwise "Peter's"
    // splits into "Peter" and "s" and contributes a spurious second letter.
    .replace(/['’]/g, "")
    // Everything else non-alphanumeric separates words, so periods and hyphens
    // behave like spaces.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return "";

  // A single-word name would give a one-letter acronym, which is too thin to
  // read or to namespace a folder — take the opening letters instead.
  const raw =
    words.length === 1
      ? words[0].slice(0, 3)
      : words.map((word) => word[0]).join("");

  return raw.toUpperCase().slice(0, MAX_LENGTH);
};

// The email convention is name@<acronym>.com, so the domain falls out of the
// acronym: "Jesus is Lord" -> JIL -> jil.com. Derived once at creation and
// editable afterwards, since a church may actually use .org, .ph, or a domain
// unrelated to its acronym.
export const deriveEmailDomain = (acronym) =>
  acronym ? `${acronym.toLowerCase()}.com` : "";

// Acronyms are unique, and two different names can easily derive the same one
// ("Grace Baptist" and "Good Book" both give GB). Only used for derived
// acronyms — an explicitly requested one that clashes is rejected instead, on
// the grounds that the caller asked for that exact value.
export const uniqueAcronym = async (base, Church) => {
  if (!base) return base;

  let candidate = base;
  let suffix = 2;

  // The unique index is still the real guard; this only avoids the common case.
  while (await Church.exists({ acronym: candidate })) {
    const trimmed = base.slice(0, MAX_LENGTH - String(suffix).length);
    candidate = `${trimmed}${suffix}`;
    suffix++;
  }

  return candidate;
};
