# JOSCM Tithes Management System — Business Requirements (`businessRequirements.md`)

> Extracted from `CLAUDE_CLIENT.md`. This is the **domain layer**: who the users are, what the money workflow is, and the rules that govern it — independent of React or Express.
>
> API contract and infrastructure live in `Backend.md`. UI/component decisions live in `CLAUDE_CLIENT.md`.

---

## 1. Product Overview

A financial management system for **Jesus Our Savior Christian Ministries (JOSCM)** — an internal church app, not a public product. It covers four money flows:

1. **Tithes collection** — money coming in, counted by denomination per service.
2. **Request Form (RF) approval workflow** — a member requests funds; the request walks a multi-stage approval chain.
3. **Voucher / disbursement** — an approved request becomes a Petty Cash Fund voucher with receipt photos; money goes out.
4. **Expense tracking + reporting** — every disbursement auto-records an expense; admin/auditor export Excel and PDF reports.

Scale is small and internal: roughly **7 named users** on one church. Currency is **PHP (₱)**, locale `en-PH`.

---

## 2. Roles

Six roles, defined by the `ROLES` constant and mirrored in the backend ACLs.

| Role | Key | Real user(s) | Purpose |
|---|---|---|---|
| Admin | `admin` | Adrian | Full access; user + category management; can act at any stage |
| Disbursing Officer | `do` | Jaymar | Releases the money (disbursement step) |
| Validator | `validator` | Dani | First-line review of request forms; issues vouchers |
| Pastor | `pastor` | Bernie | Final approval authority on request forms |
| Auditor | `auditor` | Roselyn | Read-heavy oversight across the whole pipeline; financial reports |
| Member | `member` | Berna, Lourdes, Kiya | Submits tithes, files request forms, confirms receipt of funds |

**Device expectation:** officers (admin, DO, validator, pastor, auditor) work desktop-first on data-dense tables and exports. Members are mobile-first — tithes submission and RF creation mostly happen on phones after Sunday service.

---

## 3. Modules

| Module | Route | Who can reach it |
|---|---|---|
| Dashboard | `/dashboard` | all roles |
| Tithes | `/tithes` | all roles |
| Request Form | `/request-form` | all roles |
| Voucher | `/voucher` | admin, do, validator, auditor |
| Expense | `/expense` | admin, auditor |
| Reports | `/reports` | admin, do, validator, pastor, auditor — **not member** |
| Notifications | `/notifications` | all roles |
| Profile | `/profile` | all roles |
| User Management | `/admin/users` | admin |
| Categories | `/admin/categories` | admin |

Route access is enforced in two places: the sidebar hides links the role can't use, **and** the route itself is gated so typing the URL directly still redirects. Backend ACLs are the real enforcement layer.

---

## 4. Tithes Workflow

**Purpose:** record money collected at each service, counted by physical denomination.

A tithes entry captures:
- `entryDate` — the date of the service
- `serviceType` — which service (enum)
- **Denomination breakdown** — 9 rows, ₱1000 down to ₱1, each with a quantity; subtotals and grand total are computed automatically
- optional remarks

**Status flow:** `pending` → `approved` **or** `rejected`.

**Rules:**
- Any authenticated role can submit tithes.
- Approval/rejection is open to **any role except the submitter** — a **conflict-of-interest rule**: you cannot approve your own entry. This is enforced on the backend and mirrored in the UI (your own pending entries show only Reject, never Approve).
- **Rejection requires a written note.** The backend rejects a reject without `rejectionNote`. The note is surfaced back to the submitter.
- Only **approved** tithes count as actual receipts. Pending and rejected entries are excluded from balances, breakdowns, and trend charts.

**Reporting view:** a tithes trend chart scoped to a **calendar year**, spanning January through the latest month that has approved tithes in that year — gaps zero-filled, but **never extended forward into months with no approved data**. Year-over-year comparison is apples-to-apples (YTD vs the same month range of the prior year, not full prior year). The church's first year on the system is **2026**, so until 2027 the comparison reads "First year with approved tithes."

---

## 5. Request Form (RF) Workflow

The core approval chain. An RF is a request to spend church money.

**Fields:** `rfNo` (e.g. `RF-0008`), category (RF-typed), `estimatedAmount`, **remarks/particulars (required)**, attachments, requester.

### 5.1 Status flow

```
draft ──submit──▶ submitted ──validate──▶ for_approval ──approve──▶ approved
                                                                       │
                                                             create voucher
                                                                       ▼
                                                              voucher_created
                                                                       │
                                                                  disburse
                                                                       ▼
                                                                  disbursed
                                                                       │
                                                         requester confirms
                                                                       ▼
                                                                  received  (terminal)

  submitted / for_approval ──reject──▶ rejected  (terminal)
```

| Transition | Who | Notes |
|---|---|---|
| Create / edit / delete draft | requester (owner) | drafts are freely editable |
| Submit | requester (owner) | |
| Validate | validator, auditor, admin | |
| Approve | pastor, auditor, admin | |
| Reject | same roles as validate/approve, at their stage | **requires a written reason** |
| Create voucher | validator, admin | happens on the Voucher page (needs receipt upload) |
| Mark as Disbursed | admin, DO | explicit operational action: money left the church |
| Mark as Received | the **requester**, regardless of role | separate confirmation that the money arrived |

### 5.2 Why disburse and received are two separate steps

Originally `disbursed` was terminal and was set by whoever clicked "Mark Received" — that conflated two distinct actions and left no audit trail of the disbursement itself. Splitting them means: **the DO/admin logs that money left**, and **the requester acknowledges they got it**. Future audit reports can join on `disbursedAt`/`disbursedBy` vs `receivedAt`/`receivedBy` for real accountability.

### 5.3 Business rules

- **Self-decision guard.** A user may **not** validate, approve, or reject an RF they created themselves — a conflict of interest. Create-voucher and disburse are deliberately out of scope for this guard (disburse is admin/DO-only anyway). *Currently enforced in the UI only; the backend endpoints still need the check — see `Backend.md` §8 item 6.*
- **Amount cannot exceed the church's available cash.** `availableBalance = sum(approved tithes) − sum(all expenses)`. On RF creation, an amount over the balance is blocked with "Amount exceeds available tithes balance (₱X,XXX)"; when the balance is zero, the message reads "The church has no available tithes balance — no requests can be made right now." **Edit mode skips the check** — drafts can be edited freely and validators catch over-balance edits at review time.
- **Remarks/particulars are required.** This field becomes the "Details / Particulars" column in the Monthly Breakdown financial exports; without it, reports fall back to "—". Required on both RF creation and manual expense entry.
- **Rejection always requires a reason** (free text), at every stage that can reject.
- Rejection is deliberately kept "heavy": it is **not** surfaced as a one-tap dashboard quick action. Users must go to the source page to reject, so the decision stays deliberate.
- Every state-changing action goes through a **confirmation dialog** — a single accidental tap on mobile must not approve or disburse anything.

---

## 6. Voucher Workflow

A voucher (`pcfNo`, e.g. `PCF-0042`) is the Petty Cash Fund document issued against an approved RF.

**Rules:**
- Created by a **validator or admin** from an RF in `approved` status that doesn't already have a voucher.
- **At least one receipt image is required** — this is where the actual *resibo* photo lives. Enforced server-side (400) as well as in the UI. Up to 5 files, 10MB each, JPG/PNG/WebP.
- The **category is chosen at voucher creation**, defaulting to the RF's approved category but editable, so a wrong category can be corrected before the PCF is issued.
- Creating a voucher **auto-records an expense** — this is the only automatic path from request to expense ledger.
- **Cancel / reopen:** a voucher can be cancelled by **the validator who created it, or an admin**, but only while the linked RF is still `voucher_created` (i.e. **not yet disbursed**). Cancelling reverses the auto-recorded expense, soft-cancels the voucher (`status: 'cancelled'` — kept for audit, never deleted), and reopens the RF to `approved` so a new voucher can be issued. A reason/note is optional.
- Vouchers are a **ledger of record**: cancelled vouchers stay visible in the table with a "Cancelled" badge.

**Voucher status labels** (derived from the linked RF's status): `voucher_created` → "Awaiting Disbursement", `disbursed` → "Pending Receipt", `received` → "Received", plus "Cancelled".

---

## 7. Expense Tracking

Two sources of expenses:

1. **Auto** — created when a voucher is issued; linked back to the voucher (`linkedId` → Voucher → RF → requester/approver).
2. **Manual** — recorded directly by an **admin** for spending that didn't go through the RF pipeline. Requires remarks/particulars.

Expenses carry a category (expense-typed), amount, date, recorder, and remarks.

**Visibility rule:** the full expense list (per-transaction detail) is **admin/auditor only**. But an **aggregated "expenses by category" view for the last 6 months is open to every role** — the church wanted all staff to see *where* money goes, without over-sharing individual expense records with members.

---

## 8. Reporting

Three report types, each filtered by a date range:

| Report | Who |
|---|---|
| Tithes | admin, do, validator, pastor, auditor |
| Expense | admin, auditor (member is 403'd server-side and the tab is hidden client-side) |
| **Financial Summary** (combined) | admin, auditor only |

The combined report returns `{ summary, tithes, expenses }` and surfaces **Total Tithes / Total Expenses / NET Position** (green when ≥0, red when <0) plus an expenses-by-category breakdown.

**Exports:** every report exports to both **Excel** and **PDF**. Requirements for any export:
1. The **date must appear in the filename** — this is an audit-trail requirement, not a nicety.
2. Empty ranges must still produce a valid file (headers, zero total) rather than an error.
3. The "Details / Particulars" column comes from the RF/expense remarks — which is why that field is mandatory.

---

## 9. Notifications

Six events generate a notification to the relevant user:

- Tithes **approved** / **rejected**
- RF **validated** / **approved** / **rejected** / **received**
- Voucher **created**

Notification types map to a color language: `approval` (green), `rejection` (red), `info` (blue), `reminder` (amber). Each notification links to a record (`Tithes` / `RequestForm` / `Voucher`).

**Requirements:**
- Delivery must feel **realtime** — the original 60-second polling was explicitly rejected as "far from realtime" after a user submitted an RF and waited through manual refreshes.
- Clicking a notification must let the user **act on the record inline** (validate / approve / reject / disburse / mark received), not just deep-link them to a page where they have to hunt for the row.
- Every surface must stay in sync: acting from a notification, a dashboard quick action, a table row, or a details dialog must all produce identical results and identical wording.

---

## 10. Dashboard Requirement

The dashboard's first impression must be **"what should I do right now?"** — not all-time totals or generic charts.

The first block on every dashboard is **"Your Pending Work"**, bucketed per role:

| Role | Sees |
|---|---|
| Admin | pending tithes + RFs at every actionable stage |
| DO | pending tithes + RFs awaiting disbursement |
| Validator | RFs to validate + approved RFs awaiting a voucher |
| Pastor | RFs to approve |
| Member | own RFs awaiting receipt confirmation + own drafts to submit |
| Auditor | read-only oversight strip — pipeline counts, vouchers this month, and this-month Tithes / Expenses / Net |

Empty state: *"All caught up — wala nang pending sa'yo!"*

Rows exclude dead-end clicks — e.g. a user's own pending tithes are filtered out of their queue, because self-approval is forbidden anyway.

---

## 11. Permission Matrix (`can.*`)

| Capability | Allowed roles | Extra condition |
|---|---|---|
| `approveTithes` | any role | **except the submitter** |
| `validateRf` | validator, auditor, admin | not the RF's own requester |
| `approveRf` | pastor, auditor, admin | not the RF's own requester |
| `rejectRf` | same as the stage's decider | not the RF's own requester |
| `createVoucherFromRf` | validator, admin | RF must be `approved` and have no voucher |
| `cancelVoucher` | validator, admin | validator must be the voucher's **creator**; RF must still be `voucher_created` |
| `disburseRf` | admin, do | RF must be `voucher_created` |
| `markRfReceived` | any role | must be the RF's **owner**; RF must be `disbursed` |
| `submitRf` / `editRf` / `deleteRf` | any role | must be the **owner**, RF must be `draft` |
| `recordManualExpense` | admin | |
| `viewExpense` | admin, auditor | |
| `viewExpenseReport` | admin, auditor | |
| `viewCombinedReport` | admin, auditor | |
| view expenses-by-category | all roles | aggregate only |
| user management | admin | |
| category management | admin | |
| change own password | all roles | |

**Ownership is always checked by id, never by name** — a name collision must not grant edit/delete rights.

---

## 12. Reference Data

**Categories** are admin-managed and **typed**: `rf` (selectable on request forms) or `expense` (selectable on manual expenses). A category has a name, a color, and an `isActive` flag — categories are **archived, not deleted**, so historical records keep their reference.

**Denominations** for tithes counting: ₱1000, ₱500, ₱200, ₱100, ₱50, ₱20, ₱10, ₱5, ₱1.

**Service types** are a fixed enum on the tithes entry (which service the collection came from).

**Status vocabulary** used across the app: `draft`, `submitted`, `for_approval`, `approved`, `rejected`, `voucher_created`, `disbursed`, `received`, plus `pending` (tithes) and `cancelled` (voucher).

---

## 13. Non-Functional Requirements

- **Money must always be legible.** Amounts render as `₱` via `Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' })`, and numeric columns use tabular figures so digits align vertically. Non-negotiable for financial displays.
- **Trustworthy over flashy.** Target look is a corporate finance dashboard (Stripe / Linear / Mercury / Wise): boring on purpose, data-dense but not cluttered. No gradients, no heavy shadows, no solid-color status badges.
- **Every irreversible action is confirmed** before it fires.
- **No blank screens.** Every data view must handle loading, error, and empty states explicitly, and an empty list must explain *why* it's empty and what to do next.
- **Mobile must work on a real phone**, not just a resized desktop browser — members submit tithes and file RFs from phones.
- **Cold-start tolerance.** The backend sleeps on a free tier; the first request of the day can take 30–60s. This is accepted for an internal church app and is hidden behind UI time rather than paid away.
- **Credentials are never committed.** Default/seeded logins must not appear in any README or doc.

---

## 14. Open Items

1. **Backend self-decision enforcement** — the "can't approve your own RF" rule is currently UI-only; a direct API call bypasses it. Highest-value remaining gap.
2. **Rotate the production JWT secret and the seeded admin password** before wider rollout.
3. **RF attachments** — the schema accepts an attachment array but there is no upload path; only voucher receipts and avatars are wired to Cloudinary.
4. **Full audit log** — admin actions (creating a category, deactivating a user, exporting a report) don't surface in Recent Activity because the audit actor is a name snapshot rather than a live user reference.
5. **RF inline comments / chat** — a deferred feature; Socket.IO is already in place to host it rather than introducing a second realtime mechanism.
6. **End-to-end production test** across the full chain: member submits tithes → creates RF → validator validates → pastor approves → validator issues voucher with a Cloudinary receipt → DO disburses → member confirms received → auditor exports Excel + PDF, verifying a notification fires at every transition.
