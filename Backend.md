# JOSCM Tithes App — Backend Context (`Backend.md`)

> Extracted from `CLAUDE_CLIENT.md` (the React frontend context file). Everything here is backend-facing information that was scattered across the frontend doc: the API contract, auth model, data shapes, infrastructure, and the backend gaps the frontend had to work around.
>
> Domain rules (who can do what, and why) live in `businessRequirements.md`. UI/component decisions stay in `CLAUDE_CLIENT.md`.

---

## 1. Deployment & Infrastructure

| Piece | Value |
|---|---|
| Backend host | **Render** (free tier), region Singapore, branch `main` |
| Backend URL | `https://backend-tithes-management-system.onrender.com` |
| API base | `https://backend-tithes-management-system.onrender.com/api` |
| Smoke test | `GET /` → `Hello World!` (no auth, no DB query) |
| Database | **MongoDB Atlas** free M0 — cluster `cluster0.ckd3rkk.mongodb.net`, db `JOSCM-Tithes`, db user `aniceteian14_db_user` |
| File storage | **Cloudinary** (voucher receipts, user avatars) |
| Local port | `7001` — local API base `http://localhost:7001/api` |
| Frontend host | Vercel — `https://tithes-management-system.vercel.app` (separate repo `Frontend-Tithes`) |

**Render service config:** Build Command `npm install`, Start Command `node app.js` (manual override — `package.json` had no `start` script). `PORT` deliberately **not** set as an env var; Render injects its own and `app.js` reads `process.env.PORT`.

**Render env vars:** `CONNECTION_STRING` (Atlas URI including `/JOSCM-Tithes`), `JWT_SECRET_KEY`, `CLOUDINARY_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CORS_ORIGIN`.

**Atlas network access:** `0.0.0.0/0` — Render free tier has no static outbound IPs, so security relies on db user/password + TLS via `mongodb+srv://`. Three legacy personal IPs (`112.208.164.120/32`, `175.176.27.34/32`, `126.209.52.146/32`) are redundant and can be deleted.

### 1.1 Cold start (known, load-bearing)

Render free tier sleeps after ~15 min idle. The first request after a cold period takes **30–60s**: Node boot + Atlas mongoose handshake + `httpServer.listen()` only fires after `connectDB().then()`, so **the port is closed during the entire warm-up**. Any request within ~15 min after that is fast.

Frontend mitigation (already shipped): the Login page fires a fire-and-forget `GET /` at the backend root on mount, so the wake-up overlaps the user's typing time. Rejected alternatives: external keepalive ping (against Render TOS, eats ~720 of 750 free instance-hours/mo) and Render Starter upgrade ($7/mo).

### 1.2 CORS

`app.use(cors())` (wide open) was replaced with an env-driven allowlist:

- `CORS_ORIGIN` = comma-separated allowed origins.
- Empty/unset → preserves wide-open behavior so local dev works with no `.env` change.
- `*.vercel.app` preview URLs auto-allowed via regex, so PR preview deploys hit the same backend without per-branch env edits.
- `credentials: true` so cookies / `Authorization` can flow.
- Requests with no `Origin` header (server-to-server, curl) still pass.

Socket.IO is attached with the **same CORS allowlist + Vercel-preview pattern** as the REST endpoints.

### 1.3 Seeding

`node --env-file=.env src/utils/seed.js` — run once per database. Used to seed the initial admin against Atlas by temporarily pointing backend `.env` at the Atlas connection string.

---

## 2. Auth Model

**JWT in an httpOnly cookie the browser manages.** JS never reads or stores the token (XSS can't steal it). The cookie is the source of auth truth; a `401` from the server is what actually ends a session.

- Access token **15 minutes**, refresh token **7 days**.
- `POST /auth/refresh` — single-flight refresh from the client; the original request is replayed once on success.
- `POST /auth/logout` — clears the httpOnly cookies.
- `credentials: 'include'` on every client call; Socket.IO connects with `withCredentials: true` so the same cookie authenticates the websocket handshake.
- A legacy `Authorization: Bearer` header may still arrive (dev-login only); production relies purely on the cookie.
- The hardened `verifyToken` middleware **rejects** the `mock-<role>-token` strings the frontend's dev role picker mints, so dev-login was never a data risk.
- `JWT_SECRET_KEY` was deployed as `my-secret-key` and is flagged for rotation to a strong 32+ char random string. Rotating invalidates every existing JWT → all users get auto-logged-out by the client's 401 interceptor.
- **Password change does not invalidate the JWT** — the existing token stays valid until expiry; only the bcrypt hash rotates.

### 2.1 Login response shape

`POST /api/auth/login` originally returned only `{ id, role }` in `data`; it was extended to include `name` + `email` (needed for the dashboard greeting) and later `avatarUrl`. **The current user's id is exposed as `id`, not `_id`** — everywhere else on the wire, user ids are Mongo `_id` strings. Client code that needs self-identity uses `user._id ?? user.id`.

---

## 3. API Response Conventions

**Normalized list shape** (established by `feat/normalize-empty-list-responses` and its follow-ups): every list endpoint returns

```json
{ "status": "Success", "count": 0, "data": [] }
```

…including when the collection is empty. Before normalization, six endpoints each returned a *different* `200 { message: "..." }` or `404 { error: "..." }` on empty (`"Empty"`, `"Users Not Found!"`, `"Tithes is Empty"`, `"Request form empty"`, `"Voucher empty"`, `"Expense Data empty"`, plus six more variants across the report endpoints). All of those short-circuits have been removed; the frontend's per-hook workarounds were stripped in `feat/strip-empty-case-workarounds`.

**Report/export endpoints** were normalized in the same pass:
- `getTithesReport` / `getExpenseReport` return the normalized empty shape.
- Excel exports (ExcelJS) generate the workbook with title + styled header row and no data rows; the bottom `SUM` formula is wrapped in `if (length > 0)` because `SUM(C3:C2)` is invalid Excel and renders `#NAME?`.
- PDF exports (PDFKit) render title + table header with no rows; the `reduce(..., 0)` total still prints `Total Balance: Php 0`.

**Errors:** controllers return `{ error: "..." }` (some return `{ message: "..." }`). The client unwraps `data.message || data.error`.

**Sorting:** `getNotifications` sorts `{ createdAt: -1 }` server-side so clients get newest-first without client sorting.

**Known inconsistencies (documented, tolerated because the client always refetches):**
- `POST /tithes` returns `data: { newTithes }` — nested, unlike other endpoints.
- `PATCH /tithes/:id/approve` and `/reject` return only `{ status, message }` — no updated record.
- `validateRf` / `approveRf` / `rejectRf` return reduced bodies (`rfNo`, `status`, `*By`, `*At`) instead of the full RF.
- `POST /expenses` returns the unpopulated raw doc.
- `POST /admin/users` originally echoed only `{ name, email, isActive, role }` with no `_id` (fixed later in `feat/users-create-return-full-user`), which blocked optimistic insert.

---

## 4. Endpoint Inventory

Everything is mounted under `/api/*`.

### Auth
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | returns user profile + sets httpOnly cookies |
| POST | `/auth/refresh` | single-flight silent refresh |
| POST | `/auth/logout` | clears cookies |

### Tithes
| Method | Path | Notes |
|---|---|---|
| GET | `/tithes` | `{ status, totalBalance, count, data }`; also exposes `availableBalance` |
| POST | `/tithes` | body carries `denominations: [{ bill, qty, subtotal }]` |
| PATCH | `/tithes/:id` | update |
| PATCH | `/tithes/:id/approve` | forbids self-approval |
| PATCH | `/tithes/:id/reject` | `rejectionNote` **required** |

`getAllTithes` populates `submittedBy` with `name` + `role` (+ `avatarUrl` after the avatar branch).

### Request Form (RF)
| Method | Path | Notes |
|---|---|---|
| GET | `/request-form` | supports `?status=approved`; backend filters to own records when caller is a `member` |
| POST | `/request-form` | |
| PATCH | `/request-form/:id` | edit (draft) |
| DELETE | `/request-form/:id` | delete (draft) |
| PATCH | `/request-form/:id/submit` | |
| PATCH | `/request-form/:id/validate` | |
| PATCH | `/request-form/:id/approve` | |
| PATCH | `/request-form/:id/reject` | requires a note |
| PATCH | `/request-form/:id/disburse` | admin/DO — money left the church |
| PATCH | `/request-form/:id/received` | requester confirms; requires status `disbursed` |

`getAllRequestForms` populates `requestedBy`, `category`, `approvedBy`, `validatedBy`, `voucherId`. **Gap:** `rejectedBy` is populated only by the reject endpoint, not by the list endpoint — rejected RFs in the list surface a raw ObjectId where the UI expects a name.

### Voucher
| Method | Path | Notes |
|---|---|---|
| GET | `/vouchers` | roles: validator/do/auditor/admin |
| POST | `/vouchers` | **multipart** — `rfId`, `category`, `amount`, `remarks`, `receipts[]`; 400s with `"At least one receipt is required"` when `req.files` is empty |
| PATCH | `/vouchers/:id/cancel` | reverses the auto-recorded expense, soft-cancels the voucher (`status: 'cancelled'`, kept for audit), reopens the RF to `approved` |

`getAllVouchers` populates `rfId` (originally only `rfNo estimatedAmount status remarks`; later deep-populated to include `requestedBy._id/.name` so ownership checks are possible client-side).

### Expense
| Method | Path | Notes |
|---|---|---|
| GET | `/expenses` | admin/auditor |
| POST | `/expenses` | manual entry; accepts `remarks` |
| GET | `/expenses/by-category` | **all roles** — aggregated `{ category, amount }` for the last 6 months, no per-transaction detail (so members don't get over-shared expense records) |

`getAllExpenses` deep-populates `linkedId → Voucher → rfId → RequestForm → requestedBy/approvedBy` in one trip.

### Reports
| Method | Path | Notes |
|---|---|---|
| GET | `/reports/tithes?startDate=&endDate=` | date filter via `$gte/$lte` on `entryDate` |
| GET | `/reports/expense?startDate=&endDate=` | member hits are 403'd |
| GET | `/reports/combined*` | `{ summary, tithes, expenses }`; `authorizeRoles(['admin','auditor'])` |
| GET | export endpoints | Excel (ExcelJS) + PDF (PDFKit) for tithes / expense / combined |

Exports require the `Authorization`/cookie context, so they can't be triggered by a plain `<a href>` — the client fetches them as a blob.

### Users
| Method | Path | Notes |
|---|---|---|
| GET | `/users/me` | hydration endpoint |
| PATCH | `/users/change-password` | `{ currentPassword, newPassword }`; bcrypt-compares current, hashes new |
| PATCH / DELETE | `/users/me/avatar` | multipart field name `avatar`, ≤5MB images |
| GET | `/admin/users` | admin |
| POST | `/admin/users` | admin |
| PATCH | `/admin/users/:id` | generic update — also used to re-activate via `{ isActive: true }` |
| PATCH | `/admin/users/:id/deactivate` | dedicated endpoint; **there is no matching `/activate`** |
| DELETE | `/admin/users/:id` | |
| PATCH / DELETE | `/admin/users/:id/avatar` | admin managing another user's avatar |

### Categories
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/categories` | returns **all** types regardless of context — no `type` query param, so the client filters by `type === 'rf'` / `'expense'` and `isActive !== false` |
| POST | `/admin/categories` | |
| PATCH | `/admin/categories/:id` | same mutation used for edit, archive (`isActive:false`), and restore (`isActive:true`) |

### Notifications & Presence
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | auto-filtered by `req.user.id`, sorted newest-first |
| PATCH | mark-as-read / mark-all-read | optimistic on the client, reconciled on failure |
| POST | `/presence/heartbeat` | returns the `online` list; called every 20s by each client |

---

## 5. Data Model Notes

*(Fields as referenced by the frontend — not a full schema dump.)*

**User** — `name`, `email`, `password` (bcrypt), `role`, `isActive`, `avatarUrl`, `avatarPublicId`, Mongoose `timestamps` (`createdAt` / `updatedAt`). **No `lastLogin` field.**

**TithesEntry** — `entryDate`, `serviceType` (enum, full string values), `denominations: [{ bill, qty, subtotal }]`, `total`, `status` (`pending` / `approved` / `rejected`), `submittedBy`, `reviewedBy`, `reviewedAt`, `rejectionNote`.

**RequestForm** — `rfNo` (e.g. `RF-0008`), `status`, `requestedBy`, `category`, `estimatedAmount`, `remarks` (now required), `attachments: [String]` (empty array is valid; Cloudinary upload for RF attachments was never built), `voucherId`, plus per-stage timestamps: `createdAt`, `submittedAt`, `validatedAt`/`validatedBy`, `approvedAt`/`approvedBy`, `rejectedAt`/`rejectedBy`/`rejectionNote`, `voucherCreatedAt`, `disbursedAt`/`disbursedBy`, `receivedAt`/`receivedBy`.

> The `submittedAt` / `voucherCreatedAt` / `receivedAt` timestamps were a documented gap for several branches (the UI timeline fell back to `updatedAt`) and were added in `feat/rf-timestamps-and-full-response`. `disbursedAt`/`disbursedBy` vs `receivedAt`/`receivedBy` are the join keys for true disbursement accountability in future audit reports.

**Voucher** — `pcfNo` (e.g. `PCF-0042`), `rfId`, `category`, `amount`, `remarks`, `receipts` (Cloudinary secure URLs), `createdBy`, `status` (incl. `cancelled`). A cancelled voucher is kept for audit; the *effective* display status is `status === 'cancelled' ? 'cancelled' : rfId.status`.

**Expense** — `date`, `amount`, `category`, `recordedBy`, `remarks` (feeds the "Details / Particulars" column in reports), `linkedId` (→ Voucher; present for auto-recorded expenses, absent for manual ones).

**Category** — `name`, `type` (`'rf'` | `'expense'`), `color`, `isActive`.

**Notification** — `message`, `type` (`approval` / `rejection` / `info` / `reminder`), `refModel` (enum: `Tithes` | `RequestForm` | `Voucher`), `refId` (populated), `isRead`, `createdAt`.

**AuditLog** — its `actorName` is a **string snapshot**, not a live user ref (so avatars can't be joined onto audit rows). Its absence was flagged early as the reason Dashboard "Recent Activity" can only show record transitions, not admin actions like creating a category or deactivating a user.

**Derived value:** `availableBalance` = `sum(approved tithes) − sum(all expenses)`. Returned on the tithes endpoint and used to gate RF amounts.

> Present in the repo but **not described anywhere in `CLAUDE_CLIENT.md`**: `Comment.js` / `commentController.js` (the RF inline-comments feature — see §8), `PushSubscription.js` / `pushController.js`, `searchController.js`, `auditController.js`. Treat these as undocumented from the frontend's perspective.

---

## 6. Realtime — Socket.IO

Shipped as `Backend-Tithes#feat/socket-io-notifications`, replacing a 60s client polling loop.

- Express is wrapped in `http.createServer`; `socket.io` attaches with the same CORS allowlist as REST.
- **JWT handshake middleware** reads `socket.handshake.auth.token`, verifies with `JWT_SECRET_KEY`, sets `socket.userId = decoded.id`, and on connection joins the socket to a room named after that user id (`socket.join(String(userId))`).
- `src/services/realtime.js` holds a module-scoped `io` reference and exports `emitToUser(userId, event, payload)` so callers never plumb `io` themselves.
- `src/utils/sendNotification.js` is the funnel for **all six** notification triggers — tithes approve/reject, RF validate/approve/reject/received, voucher create — and emits `notification:new` with the saved doc to the recipient's room after the DB insert. No controller-level changes were needed because every emit point already went through this helper.

**Deploy order:** backend first, then frontend. The frontend dropped polling entirely, so a frontend deploy without the backend means notifications stop appearing.

**Production caveat:** the socket is effectively **disabled behind the Vercel proxy** in production (`services/socket.js` returns null when proxied). That's why presence had to be built as a plain HTTP heartbeat (`POST /presence/heartbeat` every 20s) rather than a socket channel.

---

## 7. File Uploads (Cloudinary)

- **Voucher receipts** — multipart `POST /vouchers`, up to 5 files, 10MB each, `image/jpeg,image/jpg,image/png,image/webp`. Backend stores Cloudinary secure URLs. At least one receipt is enforced server-side (400).
- **Avatars** — `avatarUrl` + `avatarPublicId` on the User model; `PATCH`/`DELETE` on `/users/me/avatar` (self) and `/admin/users/:id/avatar` (admin). Field name `avatar`, ≤5MB, images only.
- `avatarUrl` was added to **every user-ref `.populate()`** that feeds a table or modal (`feat/avatar-in-records`), plus the login response and the RF-comment populate.
- **RF attachments are not implemented** — the schema accepts `attachments: [String]` but no upload path exists.

---

## 8. Known Backend Gaps & Follow-Ups

Carried forward from the frontend doc. Items marked ✅ were closed by a later branch.

| # | Gap | Status |
|---|---|---|
| 1 | Inconsistent empty-list shapes across 6+ endpoints | ✅ normalized |
| 2 | RF missing `submittedAt` / `voucherCreatedAt` / `receivedAt` | ✅ added |
| 3 | `POST /admin/users` response missing `_id` | ✅ added |
| 4 | Login response missing `name` / `email` | ✅ added |
| 5 | `getAllRequestForms` doesn't populate `rejectedBy` | ⚠️ open — rejected RFs show a raw ObjectId in the list endpoint |
| 6 | **RF self-decision guard is frontend-only** | ⚠️ **open and security-relevant** — the UI hides validate/approve/reject on your own RF, but the endpoints don't check `requestedBy === req.user.id`, so a direct API call bypasses the guard |
| 7 | No audit trail for admin actions (create category, deactivate user, export report) | ⚠️ partially addressed — an `AuditLog` model exists but its actor is a string snapshot |
| 8 | Reduced/unpopulated mutation responses (§3) | tolerated — clients always refetch |
| 9 | `package.json` has no `start` script or `engines.node` | ⚠️ open — Render needs a manual Start Command override. Suggested: `"scripts": { "start": "node app.js", "dev": "node --watch --env-file=.env app.js" }, "engines": { "node": "22.x" }` |
| 10 | `JWT_SECRET_KEY` is `my-secret-key` in production | ⚠️ open — rotate to 32+ random chars |
| 11 | Seeded admin password is weak (`adrian`) | ⚠️ open — rotate via the in-app Change Password flow |
| 12 | Atlas network access has 3 redundant personal IPs | ⚠️ cosmetic cleanup |
| 13 | Backend `README.md` lacks deployment notes | ⚠️ open |

---

## 9. Frontend↔Backend Coupling Rules

Things the backend must not break without a paired frontend change:

1. **`refModel` enum drives client refetching.** `NotificationsContext` rebroadcasts every `notification:new` as a window `CustomEvent`; the tithes / RF / voucher hooks refetch when `detail.refModel` matches theirs. Adding a new `refModel` value without a client listener means silent staleness.
2. **Populated refs are load-bearing.** The UI reads `rf.requestedBy.name`, `v.rfId.requestedBy._id`, `e.linkedId.rfId.rfNo`, `expense.category.name`, etc. Removing a `.populate()` degrades the UI to raw ObjectIds. Ownership checks compare **ids**, not names.
3. **`VITE_API_URL` must end in `/api`.** The client does `${BASE_URL}${path}` with paths like `/auth/login`. The first production deploy 404'd because the suffix was missing.
4. **Backend-first for enforcement, frontend-first for required fields.** Required-field changes ship on the frontend *before* the backend 400 (so valid submissions never break in the merge gap); permission/enforcement changes ship on the backend *first*.
5. **Paired branches must deploy together** — presence, Socket.IO notifications, avatar populate, voucher cancel/reopen, and the disburse/received split all had a backend companion branch that merges first.

---

## 10. Backend Branches Referenced in the Frontend Log

`feat/socket-io-notifications` · `feat/normalize-notifications-empty` · `feat/normalize-report-endpoints` · `feat/normalize-empty-list-responses` · `feat/rf-timestamps-and-full-response` · `feat/users-create-return-full-user` · `feat/expense-remarks-and-deep-populate` · `feat/voucher-cloudinary-receipts` · `feat/voucher-populate-requested-by` · `feat/voucher-require-receipt` · `feat/voucher-cancel-reopen` · `feat/disburse-status-flow` · `feat/expenses-by-category` · `feat/avatar-upload` · `feat/avatar-in-records` · `feat/require-expense-particulars` · `feat/combined-report-and-export-redesign` · `feat/online-presence` · `chore/cors-allowlist`

**Repo history note (2026-05-02):** `git filter-branch` rewrote 93 commits on `main` to strip `Co-Authored-By: Claude` trailers (146 commits on the frontend repo). No file contents changed — only commit hashes. Standing rule: **commits and PR bodies must never include `Co-Authored-By: Claude` or "Generated with Claude Code" footers.**
