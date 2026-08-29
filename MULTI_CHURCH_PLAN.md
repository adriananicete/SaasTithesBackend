# Multi-Church Conversion — Build Order

> The branch-by-branch plan for turning this single-church backend into a multi-tenant product.
> Domain spec lives in `context/businessRequirements.md`; working rules in `PREFERENCES.md`. This file is the **build order and progress tracker** — update the status column as branches merge.

---

## The one rule

**No real paying church gets onboarded until Branch 11 is merged and `npm run check:tenant` is fully green.**

While only one church exists, an unscoped query returns exactly that church's data and looks perfectly correct. The moment a second church exists, the same query is a cross-church financial data leak. In development the opposite applies — two test churches exist from Branch 6 onward *precisely so* every later branch can be verified against a real cross-tenant attempt.

---

## Settled decisions

| Topic | Decision |
|---|---|
| Cloudinary | One account, per-church folders (`churches/<acronym>/receipts`, `/avatars`, `/logo`). No credentials in the DB. |
| Database | Fresh start on the new cluster. JOSCM's live DB is untouched — it can be imported later as a normal customer. |
| Email uniqueness | Per church — compound unique `{ church, email }`. One person can hold accounts in two churches. |
| Church delete | Soft delete (`deletedAt`) + separate purge requiring the church name typed back. |
| Scoping style | Manual `church` in every filter, with a plain helper. **No** Mongoose global hooks or AsyncLocalStorage — a missed filter must be visible in the diff. |
| Superadmin | Same `User` collection, `role: 'superadmin'`, `church: null`. Confined to `/api/superadmin/*`. |
| Deactivation | In-memory church-status cache + middleware, so it bites immediately rather than after the 15-min token TTL. |
| Numbering | `Counter` model + atomic `$inc`, per church. Also fixes the pre-existing race (`businessRequirements.md` §14 item 4). |

---

## Progress

| # | Branch | Status |
|---|---|---|
| — | Docs: `businessRequirements.md` reframed + this file | ✅ done |
| 0 | `chore/dev-prod-db-config` | ✅ done |
| 1 | `feat/church-model-and-tenant-fields` | ⬜ |
| 2 | `feat/superadmin-and-church-crud` | ⬜ |
| 3 | `feat/superadmin-dashboard` | ⬜ |
| 4 | `feat/church-dropdown-login` | ⬜ |
| 5 | `feat/church-active-guard` | ⬜ |
| 6 | `chore/two-church-dev-seed-and-leak-check` | ⬜ |
| 7 | `feat/scope-users-and-categories` | ⬜ |
| 8 | `feat/scope-tithes-and-request-forms` | ⬜ |
| 9 | `feat/scope-vouchers-and-expenses` | ⬜ |
| 10 | `feat/scope-reports-and-exports` | ⬜ |
| 11 | `feat/scope-audit-search-notifications-presence` | ⬜ |
| 12 | `feat/per-church-numbering` | ⬜ |
| 13 | `feat/church-profile-and-branding` | ⬜ |
| 14 | `feat/church-branding-in-exports` | ⬜ |

---

## Branch 0 — `chore/dev-prod-db-config`

Split the database by environment. Independent of everything else; ships first.

- `src/config/db.js` — pick `PRODUCTION_CONNECTION_STRING` when `NODE_ENV === 'production'`, else `DEVELOPMENT_CONNECTION_STRING`, falling back to `CONNECTION_STRING`. Log which environment and database it connected to.
- `.env` — add `NODE_ENV=development`; delete the dead `CONNECTION_STRING2` and `RESET_CONNECTION_STRING` (read by no code); remove the duplicated `MONGODB_USERNAME`/`MONGODB_PASSWORD` pair (declared twice, unused either way); keep `CONNECTION_STRING` only as an explicit local-Mongo escape hatch.
- Rotate `JWT_SECRET_KEY` and `JWT_REFRESH_SECRET` to 32+ random bytes (`businessRequirements.md` §14 item 8). Cheapest moment — no live sessions yet.
- Fix the prod database name typo `MultiChruchBackend` → `MultiChurchBackend`. Free only while the DB is empty.

**Verify:** `npm run dev` connects to the development cluster and says so; `NODE_ENV=production` connects to the production cluster.

**Verified 2026-08-29.** Both clusters needed `0.0.0.0/0` added in Atlas → Network Access first (Render's free tier has no static outbound IP, so this matches how the original `ckd3rkk` cluster is configured). After that:

- `NODE_ENV=development` → `…1ocde26…/DevelopmentMultiChurchBackend`, **0 collections**
- `NODE_ENV=production` → `…xkdcnz4…/MultiChurchBackend`, **0 collections**
- `node --env-file=.env app.js` → connects, listens on 7001, `GET /` returns `Hello World!`

Both databases being empty confirms the fresh-start decision and made the `MultiChruchBackend` → `MultiChurchBackend` rename free.

**Unrelated repair:** `node_modules/lodash` was a partial install (418 helper files, no `lodash.js` entry point), which crashed startup via `cloudinary`'s require. Fixed with `npm install` — `package-lock.json` unchanged, 10 packages repaired. Pre-existing from the clone, not caused by this branch.

---

## Branch 1 — `feat/church-model-and-tenant-fields`

The schema foundation. Nothing is scoped yet — this only makes tenancy representable.

- `src/models/Church.js` (new) — `name`, `acronym` (unique, uppercase), `emailDomain`, `logoUrl`, `logoPublicId`, `address`, `contactEmail`, `contactPhone`, `isActive`, `deletedAt`, timestamps.
- `src/models/Counter.js` (new) — `{ church, key, seq }`, compound unique `{ church, key }`.
- Add `church` (`ObjectId`, `ref: 'Church'`, required, indexed) to `User`, `Category`, `Expense`, `RequestForm`, `TithesEntry`, `Voucher`, `AuditLog`. On `User` it is conditionally required: `required: function () { return this.role !== 'superadmin' }`.
- **Deliberately skipped:** `Comment`, `Notification`, `PushSubscription` — each is only reachable through an already-scoped parent (`Comment` via `buildRfScope`; the others always queried as `{ userId }`). Adding the field there is redundant.
- Index changes: `User.email` single-field unique → `{ church, email }` unique; `RequestForm.rfNo` → `{ church, rfNo }` unique; `Voucher.pcfNo` → `{ church, pcfNo }` unique.
- Add `'superadmin'` to the `User.role` enum.
- `src/constants/roles.js` (new) — consolidate the role arrays currently hardcoded inline in `requestFormController`, `tithesController`, `voucherController`, `searchController`. Defined now, wired in as later branches touch each controller.

**Verify:** server boots, `db.users.getIndexes()` shows the compound index and not the old single-field unique.

---

## Branch 2 — `feat/superadmin-and-church-crud`

- `src/scripts/seedSuperadmin.js` (new) — idempotent, from `SEED_SUPERADMIN_EMAIL` / `SEED_SUPERADMIN_PASSWORD`, `church: null`.
- `src/controllers/superadmin/churchController.js` (new) — `getAllChurches`, `getChurch`, `createChurch`, `updateChurch`, `activateChurch`, `deactivateChurch`, `softDeleteChurch`, `purgeChurch`.
- `createChurch` bootstraps the whole tenant in one call: first `admin` user, starter `rf` + `expense` categories, and the `rfNo`/`pcfNo` counters — so a newly sold church is usable immediately.
- `purgeChurch` requires `confirmName` matching `church.name` exactly, then cascades across every tenant collection plus the church's Cloudinary folder.
- `src/routes/superadmin/churchRoutes.js` (new), gated `verifyToken, authorizeRoles('superadmin')`, mounted at `/api/superadmin/churches`.

**Verify:** superadmin creates a church and gets the generated admin credentials back; a non-superadmin gets 403 everywhere under `/api/superadmin/*`; purge refuses a wrong `confirmName`.

---

## Branch 3 — `feat/superadmin-dashboard`

- `src/controllers/superadmin/dashboardController.js` (new) — per church: total accounts, plus a `User.aggregate` grouping by role returning both `count` and the `names` array, so the frontend can render "3 admins — Adrian, Maria, Jose."
- Include per-church activity counts (tithes, RFs, vouchers) so a church that bought but never used the system is visible.
- `src/routes/superadmin/dashboardRoutes.js` (new) at `/api/superadmin/dashboard`.

**Verify:** with two churches seeded, per-role counts and names are correct for each and nothing bleeds between them.

---

## Branch 4 — `feat/church-dropdown-login`

The dropdown, and the JWT claim everything downstream depends on.

- `GET /api/auth/churches` — **public, no auth.** `Church.find({ isActive: true, deletedAt: null }).select('name acronym logoUrl')`.
- `src/controllers/auth/authController.js` — `userLogin` takes `church` in the body and looks up `User.findOne({ church, email })`. Without `church`, only `{ church: null, email, role: 'superadmin' }` matches. Clear 400 when a normal login omits or sends an invalid/inactive church.
- `src/utils/authTokens.js` — add `church` to both token payloads.
- `refreshAccessToken` — extend the existing `isActive` check to also reject an inactive or soft-deleted church. It already does a DB lookup, so this is free.
- `app.js` — the Socket.IO `io.use` handler sets `socket.church = decoded.church`.

**Verify:** dropdown endpoint works logged-out; login succeeds with the right church and fails with a mismatched one; superadmin logs in with no church; a decoded JWT carries `church`.

---

## Branch 5 — `feat/church-active-guard`

Deactivation takes effect on the next request, not up to 15 minutes later.

- `src/services/churchStatus.js` (new) — `isChurchActive(churchId)` with a lazily-filled in-memory `Map`, and `invalidateChurchStatus(churchId)`. Same shape as the existing `services/presence.js`.
- `src/middlewares/tenantMiddleware.js` (new) — `blockInactiveChurch`, applied right after `verifyToken`; 403s on an inactive or soft-deleted church; skips superadmin.
- `churchController` activate/deactivate/soft-delete call `invalidateChurchStatus` after writing.
- Wire into every tenant router: `tithesRoutes`, `requestFormRoutes`, `voucherRoutes`, `expenseRoutes`, `notificationRoutes`, `reportRoutes`, `searchRoutes`, `auditRoutes`, `pushRoutes`, `presenceRoutes`, `userRoutes`, `admin/userRoutes`, `admin/categoryRoutes`.

**Verify:** holding a valid unexpired token, deactivate that church as superadmin — the very next request 403s. Reactivating restores access immediately.

---

## Branch 6 — `chore/two-church-dev-seed-and-leak-check`

The safety net. Lands **before** the scoping work on purpose.

- `src/scripts/seedTwoChurches.js` (new) — two churches with deliberately parallel data: same category names, same role mix, overlapping member emails (which the compound index now permits), tithes/RFs/vouchers/expenses in each.
- `src/scripts/tenantLeakCheck.js` (new) — logs in as church A, then for every list endpoint asserts no church-B document appears, and for every id-based mutation asserts a church-B ObjectId returns 404. Prints a PASS/FAIL table. Wired as `npm run check:tenant`.
- Plain Node script — the repo has no test framework and adding one is not part of this work.

**Expected on the first run: mostly FAIL.** That is the point. Branches 7–11 turn rows green, and the table is the completion criterion.

---

## Branch 7 — `feat/scope-users-and-categories`

Introduces the helper and closes the two simplest leaks.

- `src/utils/tenantScope.js` (new) — `churchFilter(req)` and `withChurch(filter, req)`. Pure functions; they only save retyping `church: req.user.church`, they hide nothing.
- `src/controllers/admin/categoryController.js` — `getAllCategories` gains the filter (today it is a bare `Category.find()`); `createCategory` stamps `church`; `updateCategory`/`deleteCategory` move from `findByIdAndUpdate`/`findByIdAndDelete` to `findOneAndUpdate({_id, church})` / `findOneAndDelete({_id, church})`.
- `src/controllers/admin/userController.js` — same across `getAllUsers`, `getUser`, `createUser`, `updateUser`, `isActiveUser`, `deleteUser`, `setUserAvatar`, `removeUserAvatar`. Also stop passing `req.body` straight into `findByIdAndUpdate` — it currently lets an admin set any field, including `role`.

---

## Branch 8 — `feat/scope-tithes-and-request-forms`

The two highest-leverage functions in the codebase.

- `src/controllers/requestFormController.js` — `buildRfScope` merges `church` into every branch, so the oversight case returns `{ church }` instead of `{}`. This one change also fixes `searchController.globalSearch` and `commentController.findVisibleRf`, which both compose it. Every `RequestForm.findById(id)` across submit/update/delete/validate/approve/reject/disburse/received becomes `findOne({ _id, church })`; `createRequestForm` stamps `church`.
- `src/controllers/tithesController.js` — same for `buildTithesScope`. The `chartData` query gains `church`. **Both dashboard aggregations** get a `church` `$match` — the `Tithes.aggregate` for approved totals and the `Expense.aggregate`, which currently has no `$match` stage at all. These feed `totalBalance`/`availableBalance`, so today they would sum every church's money into one figure. `approveTithes`/`rejectTithes`/`updateTithes` become church-scoped; `submitTithes` stamps `church`.

**Verify:** also confirm `commentController` — an untouched file — now 404s cross-tenant, since it inherits the fix.

---

## Branch 9 — `feat/scope-vouchers-and-expenses`

- `src/controllers/voucherController.js` — `getAllVouchers` filtered; `createVoucher`'s RF lookup scoped and the new voucher stamped; `cancelVoucher`'s voucher and RF lookups scoped.
- `src/controllers/expenseController.js` — `getAllExpenses` filtered; `getExpensesByCategory`'s aggregate `$match` gains `church`; `createManualExpense` stamps `church`.
- `src/utils/autoRecordExpense.js` — stamp `church: voucher.church` on the auto-created expense.
- **Fold in `businessRequirements.md` §14 item 1** while in this file: `GET /api/expenses` has no role check, so any member can pull the full expense ledger. One-line route fix, and it matters more once this is a sold product.

---

## Branch 10 — `feat/scope-reports-and-exports`

The printed financial documents — highest-consequence leak.

- `src/controllers/reportController.js` — `fetchTithes` and `fetchExpenses` take and apply `church`, and all nine handlers pass it: `getTithesReport`, `getExpenseReport`, `exportTithesExcel/PDF`, `exportExpenseExcel/PDF`, `getCombinedReport`, `exportCombinedExcel/PDF`.
- `src/utils/reportExport.js` needs no change here — it has no DB access. Branding comes in Branch 14.

**Verify:** export Excel and PDF as each church; row counts and totals must match only that church's data.

---

## Branch 11 — `feat/scope-audit-search-notifications-presence`

The remaining cross-cutting paths.

- `src/controllers/auditController.js` — `getAuditLog`'s filter gains `church`.
- `src/utils/recordAudit.js` — stamp `church` on every `AuditLog.create`, from `req.user.church`, or via the existing `User.findById` lookup for the two public call sites (`forgotPassword`/`resetPassword`) that pass `actor` without `req`.
- `src/utils/sendNotification.js` — `sendNotificationToRoles` takes a required `church` and applies it to its `User.find`. Without this, an approval in one church notifies every validator in every church. Update all call sites in `requestFormController`, `tithesController`, `voucherController`.
- `src/controllers/searchController.js` — the intermediate `RequestForm.find({ remarks: rx }).select("_id")` bypasses `buildRfScope` entirely (a **pre-existing** role-scoping bug, not only a tenancy one) and the `Voucher.find` has no scoping beyond its role gate. Fix both.
- `src/controllers/presenceController.js` — `heartbeat`'s `User.find` gains `church`, so the online facepile stops showing other churches' users. The in-memory map in `services/presence.js` stays global; the filter on the follow-up lookup is what excludes them.

**This is the branch that must turn the leak check fully green.**

---

## Branch 12 — `feat/per-church-numbering`

- `src/utils/sequence.js` (new) — `nextNumber(church, key, prefix)` doing an atomic `Counter.findOneAndUpdate({church, key}, {$inc:{seq:1}}, {upsert:true, new:true})`, formatted `RF-0001` style.
- Replace `requestFormController.generateRFNo` and the inline `generatePCFNo` in `voucherController.createVoucher` — both currently read the newest document and increment, which is already racy today and duplicated across two files.

**Verify:** fire ~10 concurrent `POST /api/request-form` for one church and confirm ten unique numbers with no gaps; a second church numbers independently from `RF-0001`.

---

## Branch 13 — `feat/church-profile-and-branding`

Gives the frontend the name and logo it needs to rebrand itself.

- `src/controllers/churchProfileController.js` (new) — `getMyChurch` (any authenticated user in the church, so the header and sidebar can render branding) and `updateMyChurchProfile` (that church's `admin` only). Always acts on `req.user.church`; never accepts a church id from the body.
- `src/routes/churchProfileRoutes.js` (new) — `GET /api/church/me`, `PATCH /api/church/me`.
- `src/middlewares/uploadMiddleware.js` — convert the module-load `folder` strings into per-request functions so uploads land in `churches/<acronym>/receipts`, `/avatars`, `/logo`. Add a `uploadChurchLogo` storage config. The folder is **namespacing, not a security boundary** — the DB filter is the enforcement layer.

---

## Branch 14 — `feat/church-branding-in-exports`

The last hardcoded piece of JOSCM in the codebase.

- `src/utils/reportExport.js` — delete the module-level `export const CHURCH = "Jesus Our Saviour Christian Ministry"` and the static `getLogoBuffer()` that reads `src/assets/joscm-logo.png`. Thread `churchName` and `logoBuffer` parameters through `buildExcelSheet`, `buildCombinedSummarySheet`, `buildMonthlyBreakdownSheet`, `drawDocHeader`, `renderPdfDoc`, `renderCombinedMonthlyPdf`.
- `src/services/churchBranding.js` (new) — small in-memory `{ name, logoBuffer }` cache per church, filled from `Church.logoUrl`, invalidated when branding changes in Branch 13 or Branch 2.
- `src/controllers/reportController.js` — each export handler resolves branding once and passes it in.

**Verify:** two churches' exports carry their own name and logo; updating a logo shows up in the next export, not stale.

---

## Verification

**Per branch** — lint clean, server boots, and that branch's own check passes. No push without it (`PREFERENCES.md` §2).

**The gate** — `npm run check:tenant`. Branch 6 lands it red; Branches 7–11 turn it green. All rows green is the definition of done for the isolation work.

**Before selling to anyone** — run the full chain from `businessRequirements.md` §14 item 9 twice, against two churches in parallel: member submits tithes → DO approves → member creates RF → validator validates → pastor approves → validator issues a voucher with a Cloudinary receipt → DO disburses → member confirms received → auditor exports Excel and PDF. Then confirm each church's exports show only their own rows, their own name, and their own logo, and that every notification fired only inside that church.

---

## Out of scope

Named here so it does not creep in:

- Superadmin impersonation of a church.
- Importing JOSCM's live data — a future one-time script, once the multi-church system is proven. JOSCM's running installation stays untouched in the meantime.
- A test framework.
- Any frontend work.
- `businessRequirements.md` §14 items 2, 5, 6, 7 (RF balance cap, `autoRecordExpense` swallowing errors, the `Anniversay` typo, RF attachments) — all pre-existing and unrelated to tenancy.
