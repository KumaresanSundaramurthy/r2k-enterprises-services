# Deploying r2k-enterprises-services

## 1. Database — MySQL
The connection selects no default database: every query names its schema (`Products.ProductTbl`, `Users.UserTbl`, ...). The shop tables (`Products.UserTbl`, `Products.CartTbl`, `Products.OrderTbl`) are created by `sql/schema.sql` — run it before using the shop endpoints.

## 2. Backend — Render (or Railway)
This repo includes a `Dockerfile` and a `render.yaml` blueprint.

**Render:**
1. New → Blueprint → connect this repo → Render reads `render.yaml`
2. Fill in the env vars it prompts for (`JWT_KEY`, `CLIENT_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, plus the MySQL vars below)
3. Deploy — Render builds the Dockerfile and exposes the service on a `*.onrender.com` URL

**Vercel:**
1. Add New → Project → import this repo. Leave Framework Preset as **Other**; `vercel.json` takes care of the build (`npm run vercel-build`) and routes every request to `api/index.js`, which serves the compiled Nest app.
2. Add the env vars below (Settings → Environment Variables), then deploy.
3. Set Settings → Functions → **Function Region** to the region closest to your MySQL and Redis servers — every request talks to both.
4. Keep `DB_POOL_MAX` low (e.g. `2`): each running function instance opens its own database connections.

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
| `ASSET_BASE_URL` | Base URL that serves product image files (prefixed onto stored relative paths) |

### ERP login (`/api/auth/*`)
ERP users log in against the CI3 app's `Users.UserTbl`, and sessions are shared with CI3: the same `JWT_KEY`-signed token, the same cookie and the same Redis session data. These must be **identical to the CI3 app's `.env`**, otherwise a session created by one app is rejected by the other:

| Variable | Value |
|---|---|
| `JWT_KEY` | Same secret as CI3 |
| `JWT_COOKIE_NAME` | Same cookie name as CI3 |
| `LOGIN_EXPIRE_SECS` | Session lifetime in seconds (same as CI3) |
| `CI_ENV` | `production` in production — selects the `P-`/`S-` Redis key prefix CI3 uses |
| `REDIS_PROTOCOL` / `REDIS_HOST` / `REDIS_PORT` / `REDIS_DATABASE` / `REDIS_USERNAME` / `REDIS_PASSWORD` | Same Redis instance as CI3 (`REDIS_PROTOCOL=tls` for TLS) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Same Upstash store as CI3 |
| `HTTP_HOST` | Value for the token's `iss` claim (same as CI3) |

Also needed:

| Variable | Value |
|---|---|
| `APP_BASE_URL` | The web app's base URL — links in reset/verification emails and redirects after social sign-in point here |
| `API_BASE_URL` | This API's public URL — OAuth callbacks are `${API_BASE_URL}/api/auth/google/callback` and `/api/auth/facebook/callback`; register both with Google and Facebook |
| `COOKIE_DOMAIN` | Parent domain shared by both apps (e.g. `.rishika2kenterprises.com`) so the browser sends the session cookie to both. API clients can use the `token` from the login response as a Bearer token instead |
| `BREVO_API_KEY` / `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` | Email for password reset, password changed and verification messages |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Social sign-in |
| `GSTIN_API_KEY` | GSTIN verification during onboarding |
| `FILE_UPLOAD` / `CDN_URL` / `CFLARE_R2_CDN` | Resolve user image and signature URLs (same as CI3) |

Shop customers (the e-commerce cart and orders) use separate accounts and log in at `/api/shop/auth/*`.

## 4. After deploying
- Update `CLIENT_URL` once the frontend's real URL is known (CORS will reject requests otherwise).
- Update the frontend's `NEXT_PUBLIC_API_URL` to this backend's deployed URL.
