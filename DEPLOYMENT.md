# Deploying r2k-enterprises-services

## 1. Database — MySQL
Auth, cart and orders are stored in the same MySQL database as the product catalog (see `sql/schema.sql`). Run that script against `MYSQL_DATABASE` before deploying this version of the service — it creates `UserTbl`, `CartTbl` and `OrderTbl`.

## 2. Backend — Render (or Railway)
This repo includes a `Dockerfile` and a `render.yaml` blueprint.

**Render:**
1. New → Blueprint → connect this repo → Render reads `render.yaml`
2. Fill in the env vars it prompts for (`JWT_KEY`, `CLIENT_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, plus the MySQL vars below)
3. Deploy — Render builds the Dockerfile and exposes the service on a `*.onrender.com` URL

**Railway (alternative):** New Project → Deploy from GitHub repo → Railway auto-detects the Dockerfile → add the same env vars in the Variables tab.

## 3. Environment variables needed in production
| Variable | Value |
|---|---|
| `JWT_KEY` | A long random string (not the dev placeholder) |
| `JWT_EXPIRES_IN` | `7d` |
| `CLIENT_URL` | Your deployed frontend URL (for CORS) — e.g. `https://r2kenterprises.vercel.app` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | From your Razorpay dashboard — use live keys (`rzp_live_...`) only once you've completed Razorpay's KYC/activation; test keys (`rzp_test_...`) work fine for a staging deploy |
| `READ_DB_HOSTNAME` / `WRITE_DB_HOSTNAME` | MySQL hostnames for the product catalog (ERP database) |
| `DB_PORT` / `DB_USERNAME` / `DB_PASSWORD` | MySQL credentials |
| `MYSQL_DATABASE` | `Products` |
| `DEFAULT_ORG_UID` | OrgUID assigned to new users at registration |
| `ASSET_BASE_URL` | Base URL that serves product image files (prefixed onto stored relative paths) |

## 4. After deploying
- Update `CLIENT_URL` once the frontend's real URL is known (CORS will reject requests otherwise).
- Update the frontend's `NEXT_PUBLIC_API_URL` to this backend's deployed URL.
