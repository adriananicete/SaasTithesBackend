import crypto from "crypto";
import bcrypt from "bcrypt";
import { Church } from "../../models/Church.js";
import { Counter } from "../../models/Counter.js";
import { User } from "../../models/User.js";
import { Category } from "../../models/Category.js";
import { Expense } from "../../models/Expense.js";
import { RequestForm } from "../../models/RequestForm.js";
import { Tithes } from "../../models/TithesEntry.js";
import { Voucher } from "../../models/Voucher.js";
import { AuditLog } from "../../models/AuditLog.js";
import { Comment } from "../../models/Comment.js";
import { Notification } from "../../models/Notification.js";
import { PushSubscription } from "../../models/PushSubscription.js";
import cloudinary from "../../config/cloudinary.js";
import { invalidateChurchStatus } from "../../services/churchStatus.js";
import { invalidateChurchBranding } from "../../services/churchBranding.js";
import { isValidObjectId } from "../../utils/validate.js";
import {
  deriveAcronym,
  deriveEmailDomain,
  buildAcronym,
  buildSlug,
  normalizeAcronym,
  uniqueValue,
} from "../../utils/acronym.js";
import { ROLES } from "../../constants/roles.js";
import {
  STARTER_CATEGORIES,
  CATEGORY_TYPES,
} from "../../constants/starterCategories.js";

// Superadmin-only tenant management. These are the only routes that read or
// write across churches; every other endpoint in the API is scoped to one.
// Superadmin actions are deliberately NOT audit-logged — the audit trail
// belongs to each church's admin (businessRequirements section 2).

// Text fields a superadmin may change. Anything else in the body is ignored,
// so isActive/deletedAt can only move through their own explicit endpoints.
const EDITABLE_FIELDS = [
  "name",
  "acronym",
  "emailDomain",
  "address",
  "contactEmail",
  "contactPhone",
  "type",
  "cityMunicipality",
  "province",
  // slug is deliberately absent — it names the Cloudinary folder and is fixed
  // for the life of the church.
];

const getAllChurches = async (req, res, next) => {
  try {
    // Soft-deleted churches are included on purpose: the superadmin needs to
    // see them in order to restore or purge them.
    const churches = await Church.find().sort({ createdAt: -1 });

    res.status(200).json({
      status: "Success",
      count: churches.length,
      data: churches,
    });
  } catch (error) {
    next(error);
  }
};

const getChurch = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ error: "Invalid church id" });

    const church = await Church.findById(id);
    if (!church) return res.status(404).json({ error: "Church not found!" });

    res.status(200).json({ status: "Success", data: church });
  } catch (error) {
    next(error);
  }
};

// Creating a church also bootstraps everything it needs to be usable: its
// first admin account, a starter category set, and its numbering counters.
// A church created without these could not be logged into or file an RF.
const createChurch = async (req, res, next) => {
  let church = null;

  try {
    const {
      name, acronym, emailDomain, address, contactEmail, contactPhone,
      type, cityMunicipality, province, admin,
    } = req.body;

    if (!name) return res.status(400).json({ error: "Church name is required" });
    if (!admin?.name || !admin?.email)
      return res
        .status(400)
        .json({ error: "First admin name and email are required" });

    const churchType = type ?? "standalone";
    if (!["standalone", "organization"].includes(churchType))
      return res
        .status(400)
        .json({ error: "type must be 'standalone' or 'organization'" });

    // An organisation's acronym is what tells its branches apart, so without a
    // locality there is nothing to append and JIL-Malamig would collide with
    // plain JIL.
    if (churchType === "organization" && !cityMunicipality?.trim())
      return res.status(400).json({
        error: "cityMunicipality is required for an organization",
      });

    const base = deriveAcronym(name);
    if (!base)
      return res.status(400).json({
        error: "Could not derive an acronym from that name — pass one explicitly.",
      });

    // Acronym is optional — built from the name and locality when omitted, so
    // the superadmin only types those. An explicit one is honoured as-is.
    let finalAcronym;
    if (acronym) {
      const requested = normalizeAcronym(acronym);
      if (await Church.exists({ acronym: requested }))
        return res
          .status(400)
          .json({ error: "A church with that acronym already exists" });
      finalAcronym = requested;
    } else {
      // A derived clash is not the caller's fault, so it is resolved rather
      // than rejected. The result is in the response and can be changed later.
      finalAcronym = await uniqueValue(
        buildAcronym({ base, type: churchType, cityMunicipality }),
        (candidate) => Church.exists({ acronym: candidate }),
      );
    }

    // Independent of the acronym, and fixed for the life of the church.
    const slug = await uniqueValue(
      buildSlug({ base, type: churchType, cityMunicipality }),
      (candidate) => Church.exists({ slug: candidate }),
    );

    church = await Church.create({
      name,
      acronym: finalAcronym,
      slug,
      type: churchType,
      cityMunicipality,
      province,
      // Uses the BASE acronym, never the locality — branches of one
      // organisation share a domain, and "jil-san pedro.com" is not valid.
      emailDomain: emailDomain || deriveEmailDomain(base),
      address,
      contactEmail,
      contactPhone,
    });

    // Generated when not supplied, and returned in this response only — it is
    // hashed on the way in and can never be read back afterwards.
    const plainPassword =
      admin.password || crypto.randomBytes(9).toString("base64url");
    const hashedPassword = await bcrypt.hash(plainPassword, 10);

    const adminUser = await User.create({
      church: church._id,
      name: admin.name,
      email: admin.email,
      password: hashedPassword,
      role: ROLES.ADMIN,
      isActive: true,
    });

    await Category.insertMany(
      CATEGORY_TYPES.flatMap((type) =>
        STARTER_CATEGORIES.map((c) => ({
          ...c,
          type,
          church: church._id,
          createdBy: adminUser._id,
        })),
      ),
    );

    await Counter.insertMany([
      { church: church._id, key: "rfNo", seq: 0 },
      { church: church._id, key: "pcfNo", seq: 0 },
    ]);

    res.status(201).json({
      status: "Success",
      message:
        "Church created. Hand these credentials to the church admin — the password is shown once.",
      data: {
        church,
        admin: {
          id: adminUser._id,
          name: adminUser.name,
          email: adminUser.email,
          role: adminUser.role,
        },
        adminPassword: plainPassword,
      },
    });
  } catch (error) {
    // Roll back the church so a failed bootstrap does not leave a tenant that
    // nobody can log into. Best effort: the original error is what matters.
    if (church?._id) {
      try {
        await Promise.all([
          User.deleteMany({ church: church._id }),
          Category.deleteMany({ church: church._id }),
          Counter.deleteMany({ church: church._id }),
          Church.findByIdAndDelete(church._id),
        ]);
      } catch (cleanupError) {
        console.error("Church bootstrap rollback failed:", cleanupError);
      }
    }
    next(error);
  }
};

const updateChurch = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ error: "Invalid church id" });

    const existing = await Church.findById(id);
    if (!existing) return res.status(404).json({ error: "Church not found!" });

    // Whitelisted rather than passing req.body straight through, so a stray
    // isActive/deletedAt/slug in the payload cannot silently change state.
    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (!Object.keys(updates).length)
      return res.status(400).json({ error: "No editable fields provided" });

    const nextType = updates.type ?? existing.type;
    const nextLocality =
      updates.cityMunicipality ?? existing.cityMunicipality;

    if (updates.type && !["standalone", "organization"].includes(updates.type))
      return res
        .status(400)
        .json({ error: "type must be 'standalone' or 'organization'" });

    if (nextType === "organization" && !nextLocality?.trim())
      return res.status(400).json({
        error: "cityMunicipality is required for an organization",
      });

    if (updates.acronym) {
      const clash = await Church.findOne({
        acronym: normalizeAcronym(updates.acronym),
        _id: { $ne: id },
      });
      if (clash)
        return res
          .status(400)
          .json({ error: "A church with that acronym already exists" });
      updates.acronym = normalizeAcronym(updates.acronym);
    } else if (
      updates.type !== undefined ||
      updates.cityMunicipality !== undefined ||
      updates.name !== undefined
    ) {
      // Whatever the acronym is built from has changed and the caller did not
      // dictate one, so rebuild it. The slug is deliberately left alone: it
      // names the Cloudinary folder, and moving that would strand every file
      // already uploaded under it.
      const base = deriveAcronym(updates.name ?? existing.name);
      const rebuilt = buildAcronym({
        base,
        type: nextType,
        cityMunicipality: nextLocality,
      });
      if (rebuilt && rebuilt !== existing.acronym) {
        updates.acronym = await uniqueValue(rebuilt, (candidate) =>
          Church.exists({ acronym: candidate, _id: { $ne: id } }),
        );
      }
    }

    const church = await Church.findByIdAndUpdate(id, updates, {
      returnDocument: "after",
      runValidators: true,
    });

    // The name is printed on every export, and branding is cached — so a rename
    // has to take effect on the next report, not whenever the TTL happens to
    // lapse.
    invalidateChurchBranding(id);

    res
      .status(200)
      .json({ status: "Success", message: "Church updated", data: church });
  } catch (error) {
    next(error);
  }
};

// Deactivating hides the church from the login dropdown and blocks every one
// of its users. The immediate-effect guard lands in a later branch; for now
// the block takes hold on the next token refresh.
const setChurchActive = (isActive) => async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ error: "Invalid church id" });

    const church = await Church.findByIdAndUpdate(
      id,
      { $set: { isActive } },
      { returnDocument: "after" },
    );
    if (!church) return res.status(404).json({ error: "Church not found!" });

    // Takes hold on the church's very next request rather than whenever its
    // users' access tokens happen to expire.
    invalidateChurchStatus(id);

    res.status(200).json({
      status: "Success",
      message: isActive ? "Church activated" : "Church deactivated",
      data: church,
    });
  } catch (error) {
    next(error);
  }
};

const activateChurch = setChurchActive(true);
const deactivateChurch = setChurchActive(false);

// Soft delete — hidden and blocked, but every record is retained. This is the
// default "delete" so a misclick is always recoverable; purge is the one that
// actually destroys data.
const softDeleteChurch = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ error: "Invalid church id" });

    const church = await Church.findById(id);
    if (!church) return res.status(404).json({ error: "Church not found!" });
    if (church.deletedAt)
      return res.status(400).json({ error: "Church is already deleted" });

    church.deletedAt = new Date();
    await church.save();
    invalidateChurchStatus(id);

    res.status(200).json({
      status: "Success",
      message:
        "Church deleted. Data is retained — restore it, or purge to remove it permanently.",
      data: church,
    });
  } catch (error) {
    next(error);
  }
};

const restoreChurch = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id))
      return res.status(400).json({ error: "Invalid church id" });

    const church = await Church.findById(id);
    if (!church) return res.status(404).json({ error: "Church not found!" });
    if (!church.deletedAt)
      return res.status(400).json({ error: "Church is not deleted" });

    church.deletedAt = null;
    await church.save();
    invalidateChurchStatus(id);

    res
      .status(200)
      .json({ status: "Success", message: "Church restored", data: church });
  } catch (error) {
    next(error);
  }
};

// Permanent cascade delete. Requires the church's exact name typed back,
// because nothing here is recoverable.
const purgeChurch = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { confirmName } = req.body;
    if (!isValidObjectId(id))
      return res.status(400).json({ error: "Invalid church id" });

    const church = await Church.findById(id);
    if (!church) return res.status(404).json({ error: "Church not found!" });

    if (confirmName !== church.name)
      return res.status(400).json({
        error: `Type the church name exactly to confirm. Expected "${church.name}".`,
      });

    // Comment, Notification and PushSubscription carry no church field — they
    // hang off a user or an RF, so their ids have to be gathered first.
    const [userIds, rfIds] = await Promise.all([
      User.find({ church: id }).distinct("_id"),
      RequestForm.find({ church: id }).distinct("_id"),
    ]);

    const labels = [
      "tithes",
      "requestForms",
      "vouchers",
      "expenses",
      "categories",
      "auditLogs",
      "counters",
      "comments",
      "notifications",
      "pushSubscriptions",
      "users",
    ];

    const results = await Promise.all([
      Tithes.deleteMany({ church: id }),
      RequestForm.deleteMany({ church: id }),
      Voucher.deleteMany({ church: id }),
      Expense.deleteMany({ church: id }),
      Category.deleteMany({ church: id }),
      AuditLog.deleteMany({ church: id }),
      Counter.deleteMany({ church: id }),
      Comment.deleteMany({ refId: { $in: rfIds } }),
      Notification.deleteMany({ userId: { $in: userIds } }),
      PushSubscription.deleteMany({ userId: { $in: userIds } }),
      User.deleteMany({ church: id }),
    ]);

    const deleted = Object.fromEntries(
      labels.map((key, i) => [key, results[i].deletedCount]),
    );

    // Uploaded files are namespaced by acronym. Non-fatal: an orphaned folder
    // is untidy, a half-purged database is not acceptable.
    try {
      // Keyed on slug, not acronym: the acronym may have been edited since
      // upload, the slug never changes.
      const prefix = `churches/${church.slug}`;
      await cloudinary.api.delete_resources_by_prefix(prefix);
      await cloudinary.api.delete_folder(prefix);
    } catch (cloudinaryError) {
      console.error(
        `Cloudinary cleanup failed for ${church.slug}:`,
        cloudinaryError.message,
      );
    }

    await Church.findByIdAndDelete(id);
    invalidateChurchStatus(id);
    invalidateChurchBranding(id);

    res.status(200).json({
      status: "Success",
      message: `Church "${church.name}" purged permanently`,
      data: { deleted },
    });
  } catch (error) {
    next(error);
  }
};

export {
  getAllChurches,
  getChurch,
  createChurch,
  updateChurch,
  activateChurch,
  deactivateChurch,
  softDeleteChurch,
  restoreChurch,
  purgeChurch,
};
