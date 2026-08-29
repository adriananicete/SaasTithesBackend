// Derives a church's identifiers from its name and location, so the superadmin
// only has to type those.
//
// Three separate things come out of this, and they are deliberately NOT the
// same value:
//
//   acronym      "JIL-San Pedro"   display identity, freely editable
//   slug         "jil-san-pedro"   names the Cloudinary folder, never changes
//   emailDomain  "jil.com"         seeds name@<domain>, editable
//
// They used to be one field. That broke as soon as the acronym became
// editable: renaming a church would have stranded every file already uploaded
// under the old folder. The slug is generated once at creation and is the only
// one used for storage paths.

const MAX_BASE_LENGTH = 10;

// The bare acronym from the name alone. "Jesus is Lord" -> JIL.
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
  // read — take the opening letters instead.
  const raw =
    words.length === 1
      ? words[0].slice(0, 3)
      : words.map((word) => word[0]).join("");

  return raw.toUpperCase().slice(0, MAX_BASE_LENGTH);
};

// Title-cases a locality for display: "SAN PEDRO" and "san pedro" both become
// "San Pedro", so the acronym reads the same however it was typed.
const titleCase = (value) =>
  String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

// The display acronym. A standalone church is just its base; an organisation
// appends its locality, because the same name recurs across municipalities —
// JIL has branches in many, and "JIL2" tells a reader nothing while
// "JIL-San Pedro" tells them everything.
export const buildAcronym = ({ base, type, cityMunicipality }) => {
  if (!base) return "";
  if (type !== "organization") return base;

  const locality = titleCase(cityMunicipality);
  return locality ? `${base}-${locality}` : base;
};

// The storage identifier: lowercase, hyphenated, no punctuation, safe in a URL
// or a folder path. Derived from the same inputs as the acronym but sanitised,
// since the acronym may legitimately contain spaces and periods.
export const buildSlug = ({ base, type, cityMunicipality }) => {
  const parts = [base];
  if (type === "organization" && cityMunicipality) parts.push(cityMunicipality);

  return parts
    .join("-")
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
};

// Normalises an acronym supplied by hand. Only the part before the first
// hyphen is uppercased — that half is a true acronym, while anything after it
// is a place name and should read as one. So "chka" becomes "CHKA" and
// "cgf-Main" becomes "CGF-Main", but "JIL-San Pedro" is left alone rather than
// shouted as "JIL-SAN PEDRO".
export const normalizeAcronym = (value) => {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";

  const hyphen = trimmed.indexOf("-");
  if (hyphen === -1) return trimmed.toUpperCase();

  return trimmed.slice(0, hyphen).toUpperCase() + trimmed.slice(hyphen);
};

// The email domain uses the BASE acronym only, never the locality. Branches of
// one organisation plausibly share a domain, per-church email uniqueness
// already keeps their accounts distinct, and appending a locality would
// produce "jil-san pedro.com", which is not a valid domain.
export const deriveEmailDomain = (base) =>
  base ? `${base.toLowerCase()}.com` : "";

// Two churches can still land on the same value — two JIL organisations in the
// same municipality, or two standalone churches with the same initials. Only
// used for derived values; an explicitly requested acronym that clashes is
// rejected instead, since the caller asked for that exact one.
export const uniqueValue = async (base, exists) => {
  if (!base) return base;

  let candidate = base;
  let suffix = 2;

  // The unique index is still the real guard; this only avoids the common case.
  while (await exists(candidate)) {
    candidate = `${base}${suffix}`;
    suffix++;
  }

  return candidate;
};
