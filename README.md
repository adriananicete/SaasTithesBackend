# JOSCM Tithes — Backend

Express + MongoDB API for the **JOSCM Tithes Management System**, a financial management app for Jesus Our Savior Christian Ministries (tithes collection, request form approval workflow, expense tracking, role-based access).

Frontend repo: [Frontend-Tithes](https://github.com/adriananicete/Frontend-Tithes)

## Live

- **API:** https://backend-tithes-management-system.onrender.com
- **API base:** https://backend-tithes-management-system.onrender.com/api
- **Smoke test:** `GET /` returns `Hello World!`

> Hosted on Render free tier. Service sleeps after ~15 min idle; first request after a cold period takes 30–60s.

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 22 (uses built-in `--watch` and `--env-file`, no nodemon/dotenv) |
| Framework | Express 4 |
| Database | MongoDB (Atlas in prod, local Mongo in dev) |
| ODM | Mongoose 9 |
| Auth | JWT (`jsonwebtoken` v9) + `bcrypt` v6 |
| File uploads | `multer` + `multer-storage-cloudinary` (voucher receipts) |
| Reports | `exceljs` v4 (Excel) + `pdfkit` v0.18 (PDF) |

## Local development

```bash
npm install

# Required: create .env (see "Environment variables" below)

# Seed the initial admin user (Adrian) — only needed once per database
node --env-file=.env src/utils/seed.js

# Run dev server with auto-reload
npm run dev
# → Server is running on port: 7001
# → Database Connected: localhost
```

`npm start` (used by Render) runs `node app.js` without `--watch` or `--env-file`. In production, env vars come from the host (Render dashboard), not a local file.

## Environment variables

| Key | Required | Meaning |
|---|---|---|
| `PORT` | No | Server port. Render auto-injects; locally defaults to `7001`. |
| `CONNECTION_STRING` | Yes | MongoDB connection URI. Local: `mongodb://localhost:27017/JOSCM-Tithes`. Atlas: `mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/JOSCM-Tithes?appName=Cluster0`. **Database name `/JOSCM-Tithes` matters** — without it, data goes to the default `test` database. |
| `JWT_SECRET_KEY` | Yes | Signing secret for auth tokens. Use a strong random 32+ char string in production. Rotating it invalidates every existing JWT (forces all users to re-login). |
| `CORS_ORIGIN` | No | Comma-separated allowlist of origins permitted to call the API. Empty = allow any (preserves local dev DX). `*.vercel.app` URLs are auto-allowed via regex regardless of this value. |
| `CLOUDINARY_NAME` | Yes (for voucher uploads) | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Yes (for voucher uploads) | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Yes (for voucher uploads) | Cloudinary API secret |

## Production deployment (Render)

- **Auto-deploys** on every push to `main`.
- **Service config:** Build Command `npm install`, Start Command `npm start`, Branch `main`, Region Singapore, Free instance type.
- **Env vars** set in Render dashboard → Environment tab (see table above).
- **MongoDB Atlas:** allow `0.0.0.0/0` in Network Access (Render free tier has no static outbound IPs; security relies on user/password + TLS via `mongodb+srv://`).

To redeploy manually: Render dashboard → service → Manual Deploy → Deploy latest commit.

## Seeding admin user against Atlas

The `seed.js` script reads `CONNECTION_STRING` and `SEED_ADMIN_PASSWORD` from the env. To seed against the production Atlas database:

1. Temporarily edit local `.env` so `CONNECTION_STRING` points at the Atlas URI (with `/JOSCM-Tithes` database name).
2. Set `SEED_ADMIN_PASSWORD` in `.env` to a strong password. Optionally override `SEED_ADMIN_NAME` (default `Adrian`) and `SEED_ADMIN_EMAIL` (default `adrian@joscm.com`).
3. Run `node --env-file=.env src/utils/seed.js`.
4. Revert `.env` back to local Mongo so dev work doesn't touch production data.

The script fails fast if `SEED_ADMIN_PASSWORD` is unset. It creates an `admin` user (password hashed with bcrypt). Email is unique, so re-running fails with E11000. Change the password via the in-app Change Password feature after first login.

## API documentation

Full route map, request/response shapes, and role-based access rules are in [`../CLAUDE.md`](../CLAUDE.md). Routes are mounted under `/api/<resource>` (e.g., `/api/auth/login`, `/api/tithes`, `/api/request-form`).

## Project layout

```
backend/
├── app.js                 Entry — Express setup, middleware, routes
├── package.json
├── .env                   Gitignored — local env vars
└── src/
    ├── config/db.js       mongoose.connect()
    ├── models/            Mongoose schemas (User, TithesEntry, RequestForm, Voucher, Expense, Notification, Category)
    ├── controllers/       Route handlers (auth, admin, tithes, requestForm, voucher, expense, notification, report)
    ├── routes/            Express routers
    ├── middlewares/       authMiddleware (JWT verify), roleMiddleware (RBAC)
    └── utils/             seed.js, sendNotification.js
```
