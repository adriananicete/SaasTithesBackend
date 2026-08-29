import { RequestForm } from "../models/RequestForm.js";
import { Voucher } from "../models/Voucher.js";
import { buildRfScope } from "./requestFormController.js";

// Roles allowed to see vouchers at all (mirrors getAllVouchers + the NAV gate).
const VOUCHER_ROLES = ["validator", "do", "auditor", "admin"];

// Escape regex special chars so user input can't break the query or inject a
// pathological pattern.
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /api/search?q=<term>&limit=<n>
// Global search across Request Forms + Vouchers, matched by reference number
// (RF-/PCF-) and remarks/particulars. Results are role-scoped server-side:
//   - RF rows use the same buildRfScope as the table (no leak).
//   - Vouchers only for roles that may view vouchers; voucher particulars live
//     on the linked RF's remarks, so we match those too.
const globalSearch = async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit) || 8, 50);

    if (q.length < 2) {
      return res
        .status(200)
        .json({ q, results: [], counts: { rf: 0, voucher: 0 } });
    }

    const rx = new RegExp(escapeRegex(q), "i");

    // --- Request Forms (role-scoped, same visibility as the table) ---
    const rfDocs = await RequestForm.find({
      $and: [buildRfScope(req.user), { $or: [{ rfNo: rx }, { remarks: rx }] }],
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("requestedBy", "name")
      .populate("category", "name");

    const rfResults = rfDocs.map((rf) => ({
      type: "rf",
      id: rf._id,
      ref: rf.rfNo,
      sub: rf.remarks || rf.category?.name || "",
      amount: rf.estimatedAmount ?? 0,
      route: "/request-form",
      focusId: rf._id,
    }));

    // --- Vouchers (only for roles allowed to view vouchers) ---
    let voucherResults = [];
    if (VOUCHER_ROLES.includes(req.user.role)) {
      // Voucher particulars come from the linked RF's remarks, so resolve the
      // matching RF ids first, then match vouchers by pcfNo OR linked RF.
      const matchedRfs = await RequestForm.find({ remarks: rx }).select("_id");
      const rfIdList = matchedRfs.map((d) => d._id);

      const voucherDocs = await Voucher.find({
        $or: [{ pcfNo: rx }, { rfId: { $in: rfIdList } }],
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate({ path: "rfId", select: "rfNo remarks" })
        .populate("category", "name");

      voucherResults = voucherDocs.map((v) => ({
        type: "voucher",
        id: v._id,
        ref: v.pcfNo,
        sub: v.rfId?.remarks || v.rfId?.rfNo || v.category?.name || "",
        amount: v.amount ?? 0,
        route: "/voucher",
        focusId: v._id,
      }));
    }

    res.status(200).json({
      q,
      results: [...rfResults, ...voucherResults],
      counts: { rf: rfResults.length, voucher: voucherResults.length },
    });
  } catch (error) {
    next(error);
  }
};

export { globalSearch };
