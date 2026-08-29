import { isChurchUsable } from "../services/churchStatus.js";
import { ROLES } from "../constants/roles.js";

// Refuses every tenant request whose church has been deactivated or
// soft-deleted, on the request itself rather than whenever the access token
// happens to expire. Runs immediately after verifyToken, so req.user is the
// decoded JWT and req.user.church is the claim it carries.
//
// Login and refresh already refuse such a church; this is what closes the
// window for someone who is already signed in.
export const blockInactiveChurch = async (req, res, next) => {
  try {
    // The superadmin is confined to /api/superadmin/*, which this never guards,
    // so reaching a tenant route means it is somewhere it should not be. It is
    // refused rather than waved through: most tenant routes accept any
    // authenticated user, so skipping the guard here would hand the owner read
    // access to every church's data — the exact thing the confinement exists to
    // prevent. Supporting a church is a separate, audited impersonation
    // feature, not a side effect of having no church.
    if (req.user?.role === ROLES.SUPERADMIN)
      return res.status(403).json({
        error: "Superadmin cannot access church data. Use the superadmin endpoints.",
      });

    // A tenant token with no church claim predates the claim being issued, or
    // has been tampered with. Either way it cannot be scoped, so it is refused
    // rather than waved through.
    if (!req.user?.church)
      return res.status(403).json({ error: "No church on this session. Sign in again." });

    if (!(await isChurchUsable(req.user.church)))
      return res.status(403).json({
        error: "This church is no longer active. Contact your system administrator.",
      });

    next();
  } catch (error) {
    next(error);
  }
};
