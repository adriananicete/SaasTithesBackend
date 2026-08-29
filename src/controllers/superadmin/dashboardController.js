import { Church } from "../../models/Church.js";
import { User } from "../../models/User.js";
import { Tithes } from "../../models/TithesEntry.js";
import { RequestForm } from "../../models/RequestForm.js";
import { Voucher } from "../../models/Voucher.js";
import { CHURCH_ROLES } from "../../constants/roles.js";

// The owner's inventory of sold installations — "which churches do I have, and
// are they being used?" — not an operational queue like a church's own
// dashboard. Deliberately carries no financial figures and no per-record
// detail: the superadmin operates installations, it does not take part in any
// church's money workflow (businessRequirements section 10.1).

// Rolls every church's user list into one grouped query rather than one query
// per church, so adding churches does not add round trips.
const usersByChurchAndRole = async () => {
  const rows = await User.aggregate([
    // Superadmins have church: null and belong to no installation.
    { $match: { church: { $ne: null } } },
    {
      $group: {
        _id: { church: "$church", role: "$role" },
        count: { $sum: 1 },
        names: { $push: "$name" },
        activeCount: { $sum: { $cond: ["$isActive", 1, 0] } },
      },
    },
  ]);

  const byChurch = new Map();
  for (const row of rows) {
    const churchId = String(row._id.church);
    if (!byChurch.has(churchId)) byChurch.set(churchId, new Map());
    byChurch.get(churchId).set(row._id.role, {
      count: row.count,
      activeCount: row.activeCount,
      names: row.names.sort((a, b) => a.localeCompare(b)),
    });
  }
  return byChurch;
};

// Counts per church for one model, as a plain { churchId: count } lookup.
const countByChurch = async (Model) => {
  const rows = await Model.aggregate([
    { $group: { _id: "$church", count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.count]));
};

const getDashboard = async (req, res, next) => {
  try {
    const [churches, roleBreakdown, tithesCounts, rfCounts, voucherCounts] =
      await Promise.all([
        Church.find().sort({ createdAt: -1 }).lean(),
        usersByChurchAndRole(),
        countByChurch(Tithes),
        countByChurch(RequestForm),
        countByChurch(Voucher),
      ]);

    const data = churches.map((church) => {
      const id = String(church._id);
      const roleMap = roleBreakdown.get(id) ?? new Map();

      // Every church role appears even at zero, so the shape is stable and the
      // frontend never has to guess which keys exist.
      const roles = Object.fromEntries(
        CHURCH_ROLES.map((role) => [
          role,
          roleMap.get(role) ?? { count: 0, activeCount: 0, names: [] },
        ]),
      );

      const totalAccounts = CHURCH_ROLES.reduce(
        (sum, role) => sum + roles[role].count,
        0,
      );
      const activeAccounts = CHURCH_ROLES.reduce(
        (sum, role) => sum + roles[role].activeCount,
        0,
      );

      const activity = {
        tithes: tithesCounts.get(id) ?? 0,
        requestForms: rfCounts.get(id) ?? 0,
        vouchers: voucherCounts.get(id) ?? 0,
      };

      return {
        church: {
          _id: church._id,
          name: church.name,
          acronym: church.acronym,
          logoUrl: church.logoUrl,
          isActive: church.isActive,
          deletedAt: church.deletedAt,
          createdAt: church.createdAt,
        },
        totalAccounts,
        activeAccounts,
        roles,
        activity,
        // A church that bought the system and never touched it is the thing
        // worth spotting at a glance.
        isUnused:
          activity.tithes === 0 &&
          activity.requestForms === 0 &&
          activity.vouchers === 0,
      };
    });

    const totals = {
      churches: data.length,
      activeChurches: data.filter((d) => d.church.isActive && !d.church.deletedAt).length,
      deletedChurches: data.filter((d) => d.church.deletedAt).length,
      unusedChurches: data.filter((d) => d.isUnused).length,
      accounts: data.reduce((sum, d) => sum + d.totalAccounts, 0),
    };

    res.status(200).json({
      status: "Success",
      count: data.length,
      totals,
      data,
    });
  } catch (error) {
    next(error);
  }
};

export { getDashboard };
