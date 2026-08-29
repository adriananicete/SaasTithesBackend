import bcrypt from "bcrypt";
import { User } from "../../models/User.js";
import { Category } from "../../models/Category.js";
import { Tithes } from "../../models/TithesEntry.js";
import { RequestForm } from "../../models/RequestForm.js";
import { Voucher } from "../../models/Voucher.js";
import { Expense } from "../../models/Expense.js";
import { AuditLog } from "../../models/AuditLog.js";
import { Comment } from "../../models/Comment.js";
import { Notification } from "../../models/Notification.js";

// Builds two churches whose data is deliberately PARALLEL — same category
// names, same role mix, overlapping emails — so nothing distinguishes them
// except which church they belong to. A leak therefore shows up as the other
// church's marker appearing where it should not, rather than as a shape
// difference that a sloppy assertion might excuse.
//
// Every record carries a marker string unique to its church. The leak check
// looks for that marker anywhere in a response, which works regardless of the
// endpoint's response shape.
//
// Seeded through the models rather than the API because no tenant controller
// stamps `church` yet — that is exactly what the scoping branches add, and
// what the leak check exists to verify.

export const MARKERS = { A: "ALPHAMARK", B: "BETAMARK" };

const ROSTER = [
  ["admin", "admin"],
  ["pastor", "pastor"],
  ["validator", "validator"],
  ["do", "do"],
  ["auditor", "auditor"],
  ["member", "member1"],
  ["member", "member2"],
];

// Creates a church through the superadmin API, then fills it via the models.
export const seedChurch = async ({ call, token, name, marker, slugHint }) => {
  const res = await call("POST", "/superadmin/churches", {
    token,
    body: {
      name,
      admin: { name: `${marker} Admin`, email: `admin@${slugHint}.test` },
    },
  });
  if (res.status !== 201) {
    throw new Error(`could not create ${name}: ${JSON.stringify(res.json)}`);
  }

  const church = res.json.data.church;
  const adminPassword = res.json.data.adminPassword;
  const churchId = church._id;

  // The bootstrap already made an admin; add the rest of the roster.
  const hashed = await bcrypt.hash("SeedPass123!", 10);
  const extraUsers = await User.insertMany(
    ROSTER.slice(1).map(([role, handle]) => ({
      church: churchId,
      name: `${marker} ${role}`,
      email: `${handle}@${slugHint}.test`,
      password: hashed,
      role,
      isActive: true,
    })),
  );

  const admin = await User.findOne({ church: churchId, role: "admin" });
  const member = extraUsers.find((u) => u.role === "member");
  const users = [admin, ...extraUsers];

  // The bootstrap seeded categories with identical names in both churches,
  // which is the point — only `church` tells them apart.
  const rfCategory = await Category.findOne({ church: churchId, type: "rf" });
  const expenseCategory = await Category.findOne({ church: churchId, type: "expense" });

  const tithes = await Tithes.insertMany([
    {
      church: churchId, entryDate: new Date(), serviceType: "Sunday Service",
      denominations: [{ bill: 1000, qty: 5, subtotal: 5000 }],
      total: 5000, remarks: `${marker} tithes approved`,
      submittedBy: member._id, status: "approved", reviewedBy: admin._id,
    },
    {
      church: churchId, entryDate: new Date(), serviceType: "Special Service",
      denominations: [{ bill: 500, qty: 4, subtotal: 2000 }],
      total: 2000, remarks: `${marker} tithes pending`,
      submittedBy: member._id, status: "pending",
    },
  ]);

  const rfs = await RequestForm.insertMany([
    {
      church: churchId, rfNo: "RF-0001", entryDate: new Date(),
      category: rfCategory._id, requestedBy: member._id,
      estimatedAmount: 1500, remarks: `${marker} rf submitted`, status: "submitted",
    },
    {
      church: churchId, rfNo: "RF-0002", entryDate: new Date(),
      category: rfCategory._id, requestedBy: member._id,
      estimatedAmount: 900, remarks: `${marker} rf approved`, status: "approved",
    },
  ]);

  const voucher = await Voucher.create({
    church: churchId, pcfNo: "PCF-0001", rfId: rfs[1]._id,
    date: new Date(), category: expenseCategory._id, amount: 900,
    receipts: [`https://example.test/${marker}-receipt.jpg`], createdBy: admin._id,
  });

  await Expense.insertMany([
    {
      church: churchId, source: "voucher", linkedId: voucher._id, amount: 900,
      category: expenseCategory._id, date: new Date(), recordedBy: admin._id,
      remarks: `${marker} expense from voucher`,
    },
    {
      church: churchId, source: "manual", amount: 400,
      category: expenseCategory._id, date: new Date(), recordedBy: admin._id,
      remarks: `${marker} expense manual`,
    },
  ]);

  await AuditLog.create({
    church: churchId, actorId: admin._id, actorName: `${marker} Admin`,
    actorRole: "admin", action: "rf.approve", targetModel: "RequestForm",
    targetId: rfs[1]._id, targetRef: "RF-0002", summary: `${marker} approved RF-0002`,
  });

  await Comment.create({
    refModel: "RequestForm", refId: rfs[0]._id,
    authorId: admin._id, text: `${marker} comment on the RF`,
  });

  await Notification.create({
    userId: member._id, message: `${marker} notification`,
    type: "approval", refId: rfs[1]._id, refModel: "RequestForm",
  });

  return {
    church, churchId, marker, adminPassword,
    adminEmail: `admin@${slugHint}.test`,
    users, tithes, rfs, voucher,
    rfCategory, expenseCategory,
  };
};

export const seedTwoChurches = async ({ call, token }) => {
  const a = await seedChurch({
    call, token, name: "Leak Alpha", marker: MARKERS.A, slugHint: "alpha",
  });
  const b = await seedChurch({
    call, token, name: "Leak Beta", marker: MARKERS.B, slugHint: "beta",
  });
  return { a, b };
};
