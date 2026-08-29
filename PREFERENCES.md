# My Preferences & Project Rules — Backend

> Personal working preferences and hard rules for the JOSCM Tithes **backend**.
> Extracted from `context/CLAUDE_CLIENT.md` (the transferable, non-UI rules) plus the standing rules in `context/Backend.md`.
>
> This file is about **how I want to work**. It is not domain knowledge (`context/businessRequirements.md`) and not the API/schema reference (`context/Backend.md`) — don't duplicate those here.

---

## 1. About How I Work

- I'm an **intermediate dev**. Prefer the simpler tool over the "correct" enterprise one, and explain the *why* behind a pattern — each feature should teach the next.
- **JavaScript, not TypeScript.** Faster iteration, matches my comfort level.
- **Don't over-engineer.** No new layer, abstraction, or dependency until the plain approach genuinely stops working. We can migrate later.
- **Don't skip ahead.** Build in the agreed order; each endpoint builds on patterns from the previous one.
- **Extract the shared helper before the third copy.** Every time I resist this and "just inline it for now," I regret it within two weeks — push back on me when I do it.
- **Stop me when I break a rule.** If I write an anti-pattern (§5), call it out instead of implementing it.

---

## 2. Workflow Rules

- **One branch per change**, named `feat/…`, `fix/…`, or `chore/…` in kebab-case (`feat/normalize-empty-list-responses`, `chore/cors-allowlist`).
- **Keep changesets small.** Most merged work touches 1–8 files. If a change balloons past that, it's probably two branches.
- **Never push without a clean run.** Lint clean and the server actually boots + the touched endpoints hit-tested. "It works on my machine" is not verification.
- **Backend and frontend companion branches deploy together.** Presence, Socket.IO notifications, avatar populate, voucher cancel/reopen, and the disburse/received split all needed a paired branch — merge them as a pair, backend first.
- **Backend-first for enforcement, frontend-first for required fields.** Permission/enforcement changes ship on the backend first; required-field changes ship on the frontend *before* the backend starts returning 400, so valid submissions never break in the merge gap.
- **Log every shipped branch in `context/Backend.md`**: add it to §10's branch list, and when it changes a documented behaviour, update the section it affects (§3 conventions, §8 gaps table, §9 coupling rules) instead of letting the doc go stale. Note any `**Pattern:**` / `**Lesson:**` worth reusing.
- **Scope a fix to the reported scope.** If one endpoint is broken, fix that endpoint — don't restructure shared middleware or a shared util that already works everywhere else. I've been burned by this.
- **`console.log` never gets committed.** Remove it before commit.
- **TODO comments must point at the real thing** (endpoint, model, or ticket) so stub code is traceable.
- **Standing rule: commits and PR bodies must never include `Co-Authored-By: Claude` or "Generated with Claude Code" footers.** A `git filter-branch` already had to rewrite 93 commits on `main` to strip these — don't recreate the problem.

---

## 3. Architecture Rules

- **Controllers stay thin.** Validate → call the model/util → shape the response. If a controller crosses ~100 lines or holds real business logic, extract it to `src/utils/` or `src/services/`.
- **Respect the existing folders:** `controllers/` (request handling), `models/` (Mongoose schemas + hooks), `middlewares/` (auth, roles, upload, error handling), `services/` (realtime, presence), `utils/` (cross-cutting helpers), `routes/` (wiring only), `config/` (db, cloudinary).
- **Routes files wire, they don't decide.** No inline handler logic in `routes/`.
- **Extract to `utils/` on the second usage**, not preemptively. One caller = it stays where it is.
- **One source of truth per concern** — audit writes go through `recordAudit`, notifications through `sendNotification`, exports through `reportExport`, validation through `validate`. Never hand-roll a second copy.
- **No hardcoded role strings scattered through controllers.** Roles and status values come from one place; `roleMiddleware` does the gatekeeping.
- **Every list endpoint returns the normalized shape** — `{ status: "Success", count, data: [] }` — including when empty. No `404 { error: "Empty" }` short-circuits; those were all removed on purpose and the frontend's workarounds were stripped.
- **Populated refs are load-bearing.** The UI reads `rf.requestedBy.name`, `expense.category.name`, etc. Never remove a `.populate()` without a paired frontend change.
- **Ownership checks compare ids, not names.**

---

## 4. Error, Response & Data Rules

- **Every handler handles its failure path.** Loading the happy path only is not done.
- **Errors return a consistent body** and go through `errorHandler` — don't invent a new error shape per controller.
- **Never leak internals** (stack traces, Mongo errors, secrets) in a response body.
- **Exports include the date in the filename** (audit trail), and guard the edge cases — the Excel `SUM` formula is wrapped in `if (length > 0)` because `SUM(C3:C2)` renders `#NAME?` on an empty sheet.
- **Sort server-side** where the client shouldn't have to (e.g. notifications are `{ createdAt: -1 }`).
- **Keep schema shapes stable.** A field rename is a breaking change for the client — treat it as a paired branch.

---

## 5. Absolute Rules (never break these)

- **Never** leave a blank catch (`catch (err) {}`). Handle it or re-throw.
- **Never** commit `console.log`, commented-out code, or a `Co-Authored-By: Claude` trailer.
- **Never** return a different response shape for the empty case than for the populated case.
- **Never** remove a `.populate()`, rename a field, or add a new `refModel` value without the paired frontend change.
- **Never** put a secret, key, or connection string in code — it lives in `.env`.
- **Never** put business logic in a route file or a middleware that isn't about the request lifecycle.
- **Destructive or irreversible operations** (delete, disburse, reopen) must be permission-checked *and* audit-logged.

---

## 6. Definition of Done

An endpoint isn't done until:

1. Success, error, and empty cases all return the right shape.
2. Auth + role permissions are enforced on it.
3. It's been hit for real (not just read) — happy path and at least one failure path.
4. Audit log / notification side effects fire where they should.
5. Lint is clean and the server boots.
6. No `console.log`, no hardcoded roles or secrets.
7. `context/Backend.md` is updated — branch logged in §10, and any section it made stale corrected.

---

## 7. Who I'm Building For

- **Officers** (DO, Validator, Pastor, Auditor, Admin) — data-heavy reads, exports, reports. Response size and query efficiency matter here.
- **Members** — submit tithes and RFs from phones after Sunday service, often on weak connections. Keep those endpoints small and forgiving.

**Cold start is handled** — UptimeRobot pings the Render service to keep it warm, so the 30–60s wake-up is no longer a live problem. Still, don't add startup work to the boot path without a reason: the port stays closed until `connectDB()` resolves.
