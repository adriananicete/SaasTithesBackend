import { Church } from "../models/Church.js";
import cloudinary from "../config/cloudinary.js";
import { recordAudit } from "../utils/recordAudit.js";

// The tenant-facing view of a church. Everything here acts on
// `req.user.church` and NEVER on an id from the body or the path — there is no
// way to address another church through this controller at all, which is a
// stronger guarantee than filtering one out.

// What a church admin may edit about their own church.
//
// Deliberately narrow. `name`, `acronym`, `type`, `cityMunicipality` and
// `province` are the church's identity: they feed the acronym derivation, the
// login dropdown and the record the system was sold under, so they stay with
// the superadmin's PATCH /api/superadmin/churches/:id. `slug`, `isActive` and
// `deletedAt` are never editable from here by anyone — the slug names the
// Cloudinary folder and the other two are the vendor's switches.
const EDITABLE_FIELDS = ["address", "contactEmail", "contactPhone", "emailDomain"];

// What every authenticated user in the church may read, so the header, the
// sidebar and the exports can render the church's own branding.
const PROFILE_FIELDS =
  "name acronym slug type cityMunicipality province emailDomain logoUrl address contactEmail contactPhone isActive createdAt";

// GET /api/church/me — any authenticated user in the church.
const getMyChurch = async (req, res, next) => {
  try {
    const church = await Church.findById(req.user.church).select(PROFILE_FIELDS);
    if (!church) return res.status(404).json({ error: "Church not found" });

    res.status(200).json({ status: "Success", data: church });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/church/me — that church's admin only (enforced by route).
const updateMyChurchProfile = async (req, res, next) => {
  try {
    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (!Object.keys(updates).length)
      return res.status(400).json({
        error: `No editable fields provided. Editable here: ${EDITABLE_FIELDS.join(", ")}`,
      });

    const church = await Church.findByIdAndUpdate(req.user.church, updates, {
      new: true,
      runValidators: true,
    }).select(PROFILE_FIELDS);
    if (!church) return res.status(404).json({ error: "Church not found" });

    await recordAudit({
      req,
      action: "church.update_profile",
      targetModel: "Church",
      targetId: church._id,
      targetRef: church.name,
      summary: `Updated church profile (${Object.keys(updates).join(", ")})`,
      meta: { fields: Object.keys(updates) },
    });

    res.status(200).json({
      status: "Success",
      message: "Church profile updated",
      data: church,
    });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/church/me/logo — that church's admin only.
const setMyChurchLogo = async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const church = await Church.findById(req.user.church);
    if (!church) return res.status(404).json({ error: "Church not found" });

    // Replace, don't accumulate — same pattern as the user avatar.
    if (church.logoPublicId) {
      try { await cloudinary.uploader.destroy(church.logoPublicId); } catch (e) { /* non-fatal */ }
    }

    church.logoUrl = req.file.path;
    church.logoPublicId = req.file.filename;
    await church.save();

    await recordAudit({
      req,
      action: "church.update_logo",
      targetModel: "Church",
      targetId: church._id,
      targetRef: church.name,
      summary: `Updated the church logo`,
    });

    res.status(200).json({
      status: "Success",
      message: "Church logo updated",
      data: { logoUrl: church.logoUrl },
    });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/church/me/logo — that church's admin only.
const removeMyChurchLogo = async (req, res, next) => {
  try {
    const church = await Church.findById(req.user.church);
    if (!church) return res.status(404).json({ error: "Church not found" });

    if (!church.logoUrl)
      return res.status(400).json({ error: "This church has no logo to remove" });

    if (church.logoPublicId) {
      try { await cloudinary.uploader.destroy(church.logoPublicId); } catch (e) { /* non-fatal */ }
    }

    church.logoUrl = null;
    church.logoPublicId = null;
    await church.save();

    await recordAudit({
      req,
      action: "church.remove_logo",
      targetModel: "Church",
      targetId: church._id,
      targetRef: church.name,
      summary: `Removed the church logo`,
    });

    res.status(200).json({ status: "Success", message: "Church logo removed" });
  } catch (error) {
    next(error);
  }
};

export { getMyChurch, updateMyChurchProfile, setMyChurchLogo, removeMyChurchLogo };
