# MEKANIX — Production Configuration Audit (F-8)

**Task ID:** F-8
**Agent:** Production Configuration Auditor
**Scope:** Env var inventory, SMS/payment/JWT/db/Redis/CORS/observability, dev/preview/prod matrix, simulator/console/mock prod-safety verdicts.
**Working tree:** `feature/cloudflare-d1-validation @ 1cf59e7` (HEAD `23b71d2`), 29 modified tracked files (recovered UI) — UNTOUCHED.
**Read-only:** No source files modified. No migrations. No deploys. No remote pushes. Dev server on :3000 left running.
**Cross-refs:** SEC-21 (Agent B-4), D1-01 (Agent B-6), PAY-07 (Agent B-5), CF-01/CF-05 (Agent B-2).

---

## 1. Executive Summary

The repository ships with **three baked-in `[vars]` in `wrangler.toml`** (`SMS_PROVIDER="console"`, `PAYMENT_PROVIDER="simulator"`, `NODE_ENV="production"`) that, **taken literally as-is, will produce a deployable-but-non-functional production Worker**: it boots, it serves the UI, `/api/health` returns 200, `/api/ready` returns 200 — but **no customer can log in** (console SMS logs OTPs to stdout, never sends them) and **no customer can pay** (all 5 payment routes hard-404 when `NODE_ENV==="production"`). The app would launch in a "marketing-only / read-only" mode, silently broken for revenue and auth.

The codebase has a **well-designed provider abstraction** (`sms-provider.ts`, `payment-provider.ts`, `eta-provider.ts`) and **defense-in-depth `NODE_ENV==="production"` guards on every payment/demo route** — but the production activation checklist has not been executed, and two of the abstractions (`payment-provider.ts`) are **dead code** (not wired into any route). The **documented "production safety gates" in `.env.example` lines 50-53 do not exist in the actual `/api/ready` route** — this is a critical gap, because operators rely on `/api/ready` to gate traffic, and a console-SMS + simulator-payment deploy will report 200 OK.

**Headline findings:**

- **CFG-01 (CRITICAL):** `/api/ready` does NOT implement the production safety gates documented in `.env.example` (SMS=console, PAYMENT=simulator, DATABASE_URL=file:). It only checks DB connectivity. A broken production deploy will report ready.
- **CFG-02 / SEC-21 (CRITICAL):** `JWT_SECRET` is read by both `auth.ts:34` (user JWT) and `admin-auth.ts:8` (admin JWT). No `ADMIN_JWT_SECRET` exists. In production a user JWT verifies as an admin token → admin auth bypass. (Cross-ref Agent B-4 SEC-21.)
- **CFG-03 (HIGH):** `SMS_PROVIDER="console"` in `wrangler.toml [vars]` is the runtime default. Without an operator override, OTPs are `console.log`'d (never sent) and phone numbers + OTP codes leak to Workers logs (observability enabled).
- **CFG-04 (HIGH):** `PAYMENT_PROVIDER="simulator"` in `wrangler.toml [vars]` is a **no-op** — `payment-provider.ts` is dead code (zero route imports). Real payment separation is via per-route `NODE_ENV==="production"` → 404. All 5 payment routes hard-404 in prod → no revenue flow possible until real gateway is wired.
- **CFG-06/07 (MEDIUM):** PII logging — phone numbers + OTP codes written to `console.log` regardless of `NODE_ENV` when SMS_PROVIDER=console.
- **CFG-13 (LOW) / D1-01 (CRITICAL, cross-ref):** Redis is a per-isolate in-memory stub (`isRedisAvailable() → false`). Distributed state relies on D1 `RateLimit` + `IdempotencyKey` tables — which Agent B-6 found are MISSING from the D1 migration. So production rate-limiting silently degrades to per-isolate.

**Release verdict (as-shipped):** ❌ BLOCKER. Cannot release with current `wrangler.toml [vars]`. The 16-item Final Activation Checklist (§14) must be completed by the owner at launch time.

---

## 2. Complete Env Var Inventory

Every env var the app actually reads (verified by `rg` across `src/`, `scripts/`, `wrangler.toml`). Workers `env.DB` / `env.ASSETS` bindings included.

| # | Name | Read at (file:line) | Dev default | Preview | Prod required? | Mock-in-prod? |
|---|------|---------------------|-------------|---------|----------------|----------------|
| 1 | `NODE_ENV` | `wrangler.toml:19`, `next.config.ts:3`, `src/lib/db.ts:9`, `src/lib/auth.ts:36,123,174,420`, `src/lib/admin-auth.ts:13,78`, `src/app/api/auth/otp/send/route.ts:101`, `src/app/api/auth/otp/verify/route.ts:158`, `src/app/api/auth/demo/route.ts:24`, `src/app/api/payments/route.ts:29`, `src/app/api/prepay/route.ts:36`, `src/app/api/gateway/initiate/route.ts:11`, `src/app/api/gateway/verify/route.ts:22`, `src/app/api/vip/subscribe/route.ts:18`, `src/proxy.ts:22,35` | unset → "development" semantics | "production" | ✅ "production" | N/A (control var) |
| 2 | `DATABASE_URL` | (implicit — `PrismaClient()` reads it in dev via `src/lib/db.ts:8`) | `file:./db/custom.db` (or `file:/home/z/my-project/db/custom.db` in committed `.env`) | n/a (D1 binding `DB` used instead) | ❌ NOT used in Workers — D1 binding `env.DB` used (`src/lib/db-worker.ts:45,60`) | n/a |
| 3 | `JWT_SECRET` | `src/lib/auth.ts:34` (user JWT), `src/lib/admin-auth.ts:8` (admin JWT, module-level) | `"mekanix-dev-secret-change-in-production"` (auth.ts:40) / `"mekanix-admin-dev-secret-change-me"` (admin-auth.ts:17) | required | ✅ required (throws if missing in prod) | n/a |
| 4 | `SMS_PROVIDER` | `src/lib/sms-provider.ts:117,158`, `src/app/api/health/route.ts:32` | `"console"` | `"console"` (wrangler.toml) | ✅ must override to `kavenegar`/`melipayamak`/`farapayamak` | ⚠️ `console` IS the wrangler.toml value → mock active in prod unless overridden |
| 5 | `PAYMENT_PROVIDER` | `src/lib/payment-provider.ts:182,219` (**DEAD CODE — 0 route imports**) | `"simulator"` | `"simulator"` (wrangler.toml) | ❌ no effect (dead code) | n/a (no consumer) |
| 6 | `KAVENEGAR_API_KEY` | `src/lib/sms-provider.ts:119,122,163` | unset | unset | ✅ required iff SMS_PROVIDER=kavenegar | n/a |
| 7 | `KAVENEGAR_TEMPLATE` | `src/lib/sms-provider.ts:123` (optional, defaults to `"mekanix-otp"`) | unset | unset | optional | n/a |
| 8 | `MELIPAYAMAK_USERNAME` | `src/lib/sms-provider.ts:125,131,168` | unset | unset | ✅ required iff SMS_PROVIDER=melipayamak | n/a |
| 9 | `MELIPAYAMAK_PASSWORD` | `src/lib/sms-provider.ts:132,168` | unset | unset | ✅ required iff SMS_PROVIDER=melipayamak | n/a |
| 10 | `MELIPAYAMAK_SENDER` | `src/lib/sms-provider.ts:126,133,172` | unset | unset | ✅ required iff SMS_PROVIDER=melipayamak (warns if missing) | n/a |
| 11 | `FARAPAYAMAK_USERNAME` | `src/lib/sms-provider.ts:135,141,176` | unset | unset | ✅ required iff SMS_PROVIDER=farapayamak | n/a |
| 12 | `FARAPAYAMAK_PASSWORD` | `src/lib/sms-provider.ts:142,176` | unset | unset | ✅ required iff SMS_PROVIDER=farapayamak | n/a |
| 13 | `FARAPAYAMAK_SENDER` | `src/lib/sms-provider.ts:136,143,180` | unset | unset | ✅ required iff SMS_PROVIDER=farapayamak (warns if missing) | n/a |
| 14 | `ZARINPAL_MERCHANT_ID` | `src/lib/payment-provider.ts:184,186,221` (**DEAD CODE**) | unset | unset | ❌ no effect (dead code consumer) | n/a |
| 15 | `IDPAY_API_KEY` | `src/lib/payment-provider.ts:189,191,222` (**DEAD CODE**) | unset | unset | ❌ no effect (dead code consumer) | n/a |
| 16 | `NEXTPAY_API_KEY` | `src/lib/payment-provider.ts:194,223` (**DEAD CODE — stub, not implemented**) | unset | unset | ❌ no effect (dead code consumer) | n/a |
| 17 | `ADMIN_BOOTSTRAP_PASSWORD` | `src/lib/admin-auth.ts:79` | unset | unset | ✅ required for first admin (else no admin can log in — no default admin in prod) | n/a |
| 18 | `ADMIN_BOOTSTRAP_USERNAME` | `src/lib/admin-auth.ts:80` (optional, defaults to `"admin"`) | unset | unset | optional | n/a |
| 19 | `ADMIN_BOOTSTRAP_EMAIL` | `src/lib/admin-auth.ts:81` (optional, defaults to `"admin@mekanix.ir"`) | unset | unset | optional | n/a |
| 20 | `NESHAN_API_KEY` | `src/lib/eta-provider.ts:105` | unset | unset | optional (ETA falls back to 40 km/h haversine) | n/a |
| 21 | `GOOGLE_MAPS_API_KEY` | `src/lib/eta-provider.ts:106` | unset | unset | optional (ETA falls back) | n/a |
| 22 | `OSRM_API_URL` | `src/lib/eta-provider.ts:107` | unset | unset | optional (ETA falls back) | n/a |
| 23 | `DISPATCH_POOL_SIZE` | `src/lib/dispatch.ts:117` | `200` (default) | `200` | optional (tunable) | n/a |
| 24 | `DB` (Workers binding) | `src/lib/db-worker.ts:45,60` (`env.DB`) | n/a (dev uses SQLite via DATABASE_URL) | D1 binding `database_id=f8dbaaf3-...` | ✅ required (D1 binding) | n/a |
| 25 | `ASSETS` (Workers binding) | `wrangler.toml:9` (OpenNext static assets) | n/a | required by OpenNext | ✅ required | n/a |
| 26 | `REDIS_URL` | **NOT READ** — `src/lib/redis.ts` is a pure in-memory stub (no ioredis import) | n/a | n/a | ❌ NOT required (stub returns false) | n/a |
| 27 | `REDIS_PASSWORD` | **NOT READ** — same stub | n/a | n/a | ❌ NOT required | n/a |

**Total env vars read by code: 23** (excluding 2 legacy REDIS_* documented-but-not-read, and 2 Workers bindings DB/ASSETS which are not env vars in the `process.env` sense).

**Vars set in `wrangler.toml [vars]`:** `SMS_PROVIDER`, `PAYMENT_PROVIDER`, `NODE_ENV`.
**Vars that MUST be set via `wrangler secret put` for production:** `JWT_SECRET`, `ADMIN_BOOTSTRAP_PASSWORD`, plus SMS-provider credentials (`KAVENEGAR_API_KEY` or `MELIPAYAMAK_*` or `FARAPAYAMAK_*`).

---

## 3. Environment Matrix

| Var | Development (Node :3000) | Preview (wrangler dev / Pages preview) | Production (wrangler deploy) |
|-----|-------------------------|----------------------------------------|------------------------------|
| `NODE_ENV` | unset / `"development"` | `"production"` (wrangler.toml:19) | `"production"` |
| `DATABASE_URL` | `file:./db/custom.db` (SQLite) | n/a — D1 binding `DB` | n/a — D1 binding `DB` |
| `DB` (binding) | n/a | `database_id=f8dbaaf3-4c6b-40d5-9dce-ecaa839780e2` | same (ownership NOT VERIFIED — see §7) |
| `JWT_SECRET` | dev fallback (hardcoded) | **must set** via `wrangler secret put JWT_SECRET` | **must set** via `wrangler secret put JWT_SECRET` |
| `SMS_PROVIDER` | `"console"` (default) | `"console"` (wrangler.toml:17) | ⚠️ still `"console"` unless overridden — **must override** to `kavenegar`/`melipayamak`/`farapayamak` |
| `PAYMENT_PROVIDER` | `"simulator"` (default) | `"simulator"` (wrangler.toml:18) | `"simulator"` (no effect — dead code; real separation via per-route NODE_ENV guard) |
| `KAVENEGAR_*` / `MELIPAYAMAK_*` / `FARAPAYAMAK_*` | unset | unset | **must set** alongside SMS_PROVIDER override |
| `ADMIN_BOOTSTRAP_PASSWORD` | unset (default `admin/admin12345` created) | unset → no admin (warns) | **must set** via `wrangler secret put ADMIN_BOOTSTRAP_PASSWORD` for first admin |
| `ADMIN_BOOTSTRAP_USERNAME` | unset → `"admin"` | unset → `"admin"` | optional, defaults to `"admin"` |
| `ADMIN_BOOTSTRAP_EMAIL` | unset → `"admin@mekanix.ir"` | unset → `"admin@mekanix.ir"` | optional, defaults to `"admin@mekanix.ir"` |
| `ZARINPAL_MERCHANT_ID` / `IDPAY_API_KEY` / `NEXTPAY_API_KEY` | unset | unset | ❌ no effect (dead code — see §5) |
| `NESHAN_API_KEY` / `GOOGLE_MAPS_API_KEY` / `OSRM_API_URL` | unset → 40 km/h haversine ETA | unset → fallback | optional — set for accurate ETA |
| `DISPATCH_POOL_SIZE` | `200` (default) | `200` | optional, tune for density |
| `REDIS_URL` / `REDIS_PASSWORD` | NOT READ (stub) | NOT READ (stub) | NOT READ (stub) — distributed state via D1 tables (RateLimit, IdempotencyKey) |
| `ASSETS` (binding) | n/a | `.open-next/assets` | `.open-next/assets` |

---

## 4. SMS Provider Analysis

**File:** `src/lib/sms-provider.ts` (187 lines).

### Behavior of `SMS_PROVIDER="console"`

`consoleProvider` (`sms-provider.ts:20-23`):
```ts
const consoleProvider: SendOtpFn = async (phone, code) => {
  console.log(`📱 [DEV SMS] To: ${phone}, Code: ${code}`);
  return { success: true, messageId: `console_${Date.now()}` };
};
```

- **No real SMS is sent.** The OTP code is written to `console.log` (stdout).
- In Cloudflare Workers with `[observability] enabled=true` (wrangler.toml:21-22), `console.log` output is captured and retained in Workers logs.
- The function returns `success: true` — so `/api/auth/otp/send` believes delivery succeeded and persists the OTP hash in D1.
- The `/api/auth/otp/send` route (`route.ts:108-116`) returns the plaintext `code` in the response body **only if `NODE_ENV !== "production"`**. In production, the response body omits the code — so the operator must read Workers logs to retrieve codes.
- **Customer never receives the OTP → cannot complete `POST /api/auth/otp/verify` → cannot log in.**

### Real provider paths

Three real providers are implemented in `sms-provider.ts`:

1. **Kavenegar** (`createKavenegarProvider`, line 28) — `GET https://api.kavenegar.com/v1/${apiKey}/verify/lookup.json?receptor=${phone}&token=${code}&template=${tpl}`. Activation prerequisites:
   - `SMS_PROVIDER=kavenegar`
   - `KAVENEGAR_API_KEY` (required)
   - `KAVENEGAR_TEMPLATE` (optional, defaults to `"mekanix-otp"`)
2. **MeliPayamak** (`createMeliPayamakProvider`, line 50) — `POST https://rest.payamak-panel.com/api/SendSMS/SendSMS`. Activation prerequisites:
   - `SMS_PROVIDER=melipayamak`
   - `MELIPAYAMAK_USERNAME`, `MELIPAYAMAK_PASSWORD` (required)
   - `MELIPAYAMAK_SENDER` (required — code warns if missing; SMS will fail to send)
3. **Farapayamak** (`createFarapayamakProvider`, line 81) — `POST https://rest.farapayamak.com/api/SendSMS/SendSMS`. Activation prerequisites:
   - `SMS_PROVIDER=farapayamak`
   - `FARAPAYAMAK_USERNAME`, `FARAPAYAMAK_PASSWORD` (required)
   - `FARAPAYAMAK_SENDER` (required — code warns if missing)

### Initialization path (Workers vs Node)

- `src/lib/init.ts:4-21` — `init.ts` runs only on Node.js (dev). On Workers, `initSmsProvider()` is NOT called at module load.
- `sendOtp()` (`sms-provider.ts:150-153`) calls `initSmsProvider()` lazily on first OTP send — so the provider initializes correctly on first request in Workers.
- `initialized` flag (`sms-provider.ts:111`) prevents re-initialization within the same isolate.
- ⚠️ Caveat: the lazy-init means a misconfigured SMS provider (e.g. `SMS_PROVIDER=kavenegar` but `KAVENEGAR_API_KEY` unset) silently falls through to `consoleProvider` (line 145-147 `else` branch). The fall-through is logged via `console.log("📱 SMS provider: console (dev mode)")`, but no warning is emitted that the requested real provider fell back. **Operator must verify Workers logs at deploy time** to confirm `📱 SMS provider: Kavenegar` (or melipayamak/farapayamak) appears.

### Prod-safety verdict

- **Gated?** NO. The `console` provider is selected whenever `SMS_PROVIDER` is unset, `"console"`, or any value whose required credentials are missing. There is **no `NODE_ENV==="production"` guard** preventing `console` from being selected in production.
- **Could it be accidentally active in production?** YES. `wrangler.toml:17 SMS_PROVIDER = "console"` is the default value shipped. Unless the operator overrides it (via `wrangler secret put SMS_PROVIDER=kavenegar` — secrets override vars — or by editing `wrangler.toml [vars]`), production will use `console`.
- **Release blocker?** YES. With `console` in production:
  1. No customer can receive an OTP → no login.
  2. OTP codes + phone numbers are written to Workers logs (PII leak — CFG-06).
  3. `/api/health` reports `sms: "console"` but `/api/ready` returns 200 (CFG-01) — the broken state is invisible to uptime checks.

### Activation prerequisites (operator — names only)

1. Choose one of: `kavenegar` | `melipayamak` | `farapayamak`.
2. `wrangler secret put SMS_PROVIDER` → value = chosen provider name.
3. `wrangler secret put KAVENEGAR_API_KEY` (if kavenegar) OR `wrangler secret put MELIPAYAMAK_USERNAME` + `MELIPAYAMAK_PASSWORD` + `MELIPAYAMAK_SENDER` (if melipayamak) OR `FARAPAYAMAK_USERNAME` + `FARAPAYAMAK_PASSWORD` + `FARAPAYAMAK_SENDER` (if farapayamak).
4. Redeploy.
5. Verify in Workers logs that the line `📱 SMS provider: Kavenegar` (or MeliPayamak/Farapayamak) appears on first OTP request. If you see `📱 SMS provider: console (dev mode)`, the override did not take effect.
6. **Strongly recommended code fix (not in scope of this read-only audit):** add `if (process.env.NODE_ENV === "production" && (!process.env.SMS_PROVIDER || process.env.SMS_PROVIDER === "console")) throw new Error("SMS_PROVIDER=console forbidden in production")` at the top of `initSmsProvider()`. Also implement the documented `/api/ready` safety gate (CFG-01).

---

## 5. Payment Provider Analysis

**File:** `src/lib/payment-provider.ts` (226 lines).

### Dead-code confirmation (Agent B-5 cross-ref)

**Confirmed DEAD CODE.** Grep across `src/` for `from "@/lib/payment-provider"`:
```
$ rg 'from ["'"'"'@/lib/payment-provider["'"'"']' src/
(no matches)
```
Only `tests/e2e/{business-flow,failure-scenarios}.test.ts` and docs reference it. No route handler imports `createPayment`, `verifyPayment`, or `getPaymentProviderStatus`. The `PAYMENT_PROVIDER` env var is read ONLY inside `payment-provider.ts` (lines 182, 219) — which is never invoked from any route.

**Implication:** `PAYMENT_PROVIDER = "simulator"` in `wrangler.toml:18` is a **no-op** at runtime. The variable has zero effect on the running application.

### Real simulator/real separation (per-route NODE_ENV guards)

Instead of the abstraction, every payment route implements its own inline simulator and a hardcoded production 404 guard:

| Route | File:line | Guard |
|-------|-----------|-------|
| `POST /api/payments` | `src/app/api/payments/route.ts:29-31` | `if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });` |
| `POST /api/prepay` | `src/app/api/prepay/route.ts:36-38` | same |
| `POST /api/gateway/initiate` | `src/app/api/gateway/initiate/route.ts:11-13` | same |
| `POST /api/gateway/verify` | `src/app/api/gateway/verify/route.ts:22-24` | same |
| `POST /api/vip/subscribe` | `src/app/api/vip/subscribe/route.ts:18-20` | same |
| `GET /api/auth/demo` | `src/app/api/auth/demo/route.ts:24-26` | same (defense-in-depth — also stripped via next.config rewrites in prod) |

In production (`NODE_ENV="production"`, which is the wrangler.toml value), ALL 5 payment routes return bare 404 (no body, no headers — anti-fingerprinting). **No revenue-generating flow is reachable.** Customers cannot pay invoices, cannot prepay inspection fees, cannot subscribe to VIP.

This is intentional: the routes are simulator scaffolding awaiting real gateway integration. But it means **the app cannot transact in production as-shipped**.

### Real payment gateway activation prerequisites (by name only)

There is currently NO real payment path wired in. To activate real payments, an engineer must:

1. **Wire `payment-provider.ts` into the 5 payment routes** — replace each route's inline `Math.random()` simulator logic with calls to `createPayment()` / `verifyPayment()`. (This is engineering work, not just config.)
2. **Remove or invert the `NODE_ENV==="production"` → 404 guard** on each route (currently the guard prevents ANY payment processing in prod).
3. **Choose a provider** (`zarinpal` | `idpay` | `nextpay`).
   - `zarinpal`: set `ZARINPAL_MERCHANT_ID` (Shaparak-compliant merchant ID from Zarinpal dashboard).
   - `idpay`: set `IDPAY_API_KEY` (API key from IDPay dashboard).
   - `nextpay`: NOT YET IMPLEMENTED in `payment-provider.ts:194-197` (stub logs "falling back to simulator"). Do not select `nextpay` until implemented.
4. **Set the callback URL** — `createPayment({ callbackUrl: "https://<prod-domain>/api/gateway/callback" })`. The current code has no `/api/gateway/callback` route; verify/redirect handling must be added.
5. **Set the production domain** — Zarinpal/IDPay require the callback URL domain to be registered in their dashboard.
6. **Signature key** — Zarinpal uses `merchant_id` as the authenticator; IDPay uses `X-API-KEY` header. No separate signature key required by these providers (HMAC-style signing is not part of their v4 / v1.3 APIs).
7. **`wrangler secret put` for each credential** (NOT `[vars]` — these are secrets).
8. **Test with sandbox** — Zarinpal/IDPay offer sandbox mode (IDPay: set `X-SANDBOX: "1"` — currently hardcoded to `"0"` in `payment-provider.ts:128`).
9. **Add a `/api/ready` gate** that 503s if `PAYMENT_PROVIDER==="simulator"` AND any payment route is reachable in prod (currently impossible — CFG-01).

### Prod-safety verdict

- **Gated?** YES, but by per-route `NODE_ENV` checks — NOT by `PAYMENT_PROVIDER`. The `PAYMENT_PROVIDER=simulator` value is inert.
- **Could it be accidentally active in production?** The simulator IS active in dev/preview; in production all payment routes 404. There is no scenario where simulator processes a real payment in prod (provided `NODE_ENV="production"` — which is correctly set in wrangler.toml:19).
- **Release blocker?** YES, for revenue. The app can launch in "marketing / read-only" mode but cannot accept payments. This is a known limitation per the architecture: real gateway integration is a future task.

### Defense-in-depth recommendation (cross-ref PAY-07, Agent B-5)

The entire payment-system security depends on a single `NODE_ENV === "production"` string match per route. If `NODE_ENV` is unset or set to anything else in `wrangler.toml`, ALL payment routes become reachable in production → simulator paths run with real customers. Recommend: also check `PAYMENT_PROVIDER !== "simulator"` as a second 404 trigger (treat real-mode as opt-in), and add a CI check that fails if `wrangler.toml` has `NODE_ENV != "production"`.

---

## 6. JWT / Session / Cookie Analysis

### JWT secret collision (SEC-21 Critical — cross-ref Agent B-4)

| File:line | Read pattern | Secret source |
|-----------|-------------|---------------|
| `src/lib/auth.ts:34` | `const secret = process.env.JWT_SECRET;` (inside `getSecret()`, called at sign/verify time) | `process.env.JWT_SECRET` |
| `src/lib/admin-auth.ts:8` | `const JWT_SECRET = process.env.JWT_SECRET;` (**module top-level**, captured once at import) | `process.env.JWT_SECRET` (SAME) |

- **There is NO separate `ADMIN_JWT_SECRET` env var.** Both user JWTs (signed in `auth.ts:93-98` via `createSession`) and admin JWTs (signed in `admin-auth.ts:36-42` via `createAdminToken`) use the same secret.
- **Both verification paths use the same secret:** `verifySession()` (`auth.ts:139` `jwtVerify(token, getSecret())`) and `verifyAdminToken()` (`admin-auth.ts:46` `jwtVerify(token, getAdminSecret())`).
- **Exploit:** A user JWT (which contains `{ userId, role: "CUSTOMER", phone, isGuest }`) verifies successfully via `verifyAdminToken()` — it returns `{ adminId: undefined, username: undefined, role: "CUSTOMER" }`. Any admin route that only checks `if (!adminSession) { return 401 }` will accept the user JWT.
- **In dev:** `JWT_SECRET` is unset → `auth.ts:40` falls back to `"mekanix-dev-secret-change-in-production"` and `admin-auth.ts:17` falls back to `"mekanix-admin-dev-secret-change-me"` — DIFFERENT values → admin verification of a user JWT fails. The collision is masked.
- **In production:** `JWT_SECRET` is set (required, throws if missing) → both fallbacks are bypassed → both paths use the same secret → **admin auth bypass via user JWT**.
- **Status:** Cross-ref SEC-21 (Agent B-4). Confirmed by code reading. **CRITICAL.**
- **Fix (not in scope of this read-only audit):** Add `ADMIN_JWT_SECRET` env var; change `admin-auth.ts:8` to `process.env.ADMIN_JWT_SECRET ?? process.env.JWT_SECRET` (with `throw` in prod if neither set); OR add a `kind: "admin"` claim to admin JWTs and reject user JWTs in `verifyAdminToken` that lack the claim.

### Cookie configuration

**`mekanix-token` cookie** (set at `src/app/api/auth/otp/verify/route.ts:156-162`):

| Flag | Value | Verdict |
|------|-------|---------|
| `httpOnly` | `true` | ✅ JavaScript cannot access — XSS-resistant |
| `secure` | `process.env.NODE_ENV === "production"` | ✅ Enforced in prod (HTTPS-only) |
| `sameSite` | `"lax"` | ✅ Prevents CSRF on top-level navigations |
| `maxAge` | `30 * 24 * 60 * 60` (30 days) | Matches JWT exp (`auth.ts:97` "30d") |
| `path` | `"/"` | ✅ Available on all routes |
| `domain` | NOT set | ✅ Defaults to host-only (e.g. `mekanix.ir`) — not shared with subdomains. Safe. |

- Cookie is set ONLY by `/api/auth/otp/verify` (line 156). Logout clears it (`/api/auth/logout/route.ts:48`).
- The JWT is ALSO accepted via `Authorization: Bearer <token>` header (`auth.ts:226-230`) — so the same token works for both browser (cookie) and mobile/API (header) clients.
- The JWT is NEVER returned in the response body of `/api/auth/otp/verify` (only `user` and `created` are returned — `route.ts:155`). Good — defense-in-depth against XSS.

**Admin token** (set at `src/app/api/admin-panel/auth/login/route.ts:111-114`):
- Returned in JSON body: `{ token, admin: {...} }`.
- NOT set as a cookie. The admin panel (a client-side SPA at `/admin-panel`) stores it (likely `localStorage`) and sends it via `Authorization: Bearer` header.
- No `httpOnly` / `secure` / `sameSite` flags apply (different auth model — header-based, not cookie-based).
- HTTPS enforced by deployment (Cloudflare Workers terminates TLS). No code-level enforcement.

### Secure cookies in prod?

**YES.** The `secure: process.env.NODE_ENV === "production"` flag (otp/verify/route.ts:158) means cookies are marked Secure when `NODE_ENV="production"` (the wrangler.toml value). Browsers will only send the cookie over HTTPS. ✅

---

## 7. Database Binding

### D1 binding name match

| wrangler.toml | Code reader | Match? |
|---------------|-------------|--------|
| Line 12: `binding = "DB"` | `src/lib/db-worker.ts:45` `if (!env.DB) throw...` | ✅ |
| Line 12: `binding = "DB"` | `src/lib/db-worker.ts:60` `new PrismaD1(env.DB)` | ✅ |
| Line 13: `database_name = "mekanix"` | (informational — not read by code) | n/a |
| Line 14: `database_id = "f8dbaaf3-4c6b-40d5-9dce-ecaa839780e2"` | (informational — not read by code) | n/a |

The `CloudflareEnv.DB` type augmentation is declared at `db-worker.ts:20-24`. The binding name is consistent end-to-end. ✅

### `database_id` ownership — NOT VERIFIED

The `database_id = "f8dbaaf3-4c6b-40d5-9dce-ecaa839780e2"` in wrangler.toml:14 is the production D1 instance ID. **This audit cannot verify Cloudflare account ownership** of this D1 instance (no Cloudflare credentials available in the sandbox). The owner must confirm via `wrangler d1 info mekanix` (or `wrangler d1 list`) that this ID belongs to the production Cloudflare account before deploying.

If the ID belongs to a different account, `wrangler deploy` will fail with a permission error (fail-closed). If the ID was copied from a tutorial/another project, it must be replaced with the actual production D1 ID via `wrangler d1 create mekanix`.

### Dev SQLite path

- **`.dev.vars.example:8`** — `DATABASE_URL=file:./db/custom.db` (relative path, correct for dev).
- **`.env.example:7`** — `DATABASE_URL=file:/home/z/my-project/db/custom.db` (absolute path, hardcoded to sandbox dev machine — CFG-08).
- **`.env` (untracked, local only)** — `DATABASE_URL=file:/home/z/my-project/db/custom.db` (absolute, sandbox-only — works for the current dev server on :3000).
- The dev server uses `.env` (Next.js auto-loads it). PrismaClient (`src/lib/db.ts:8`) reads `DATABASE_URL` from `process.env` at instantiation. The SQLite file lives at `/home/z/my-project/db/custom.db`.
- The D1 migration (`prisma/migrations/20260925000000_init/migration.sql`) is applied to D1 via `wrangler d1 migrations apply mekanix` (operator action — out of scope of this audit). For local dev, `bun run db:push` or `prisma migrate dev` applies it to the SQLite file. (Per Agent B-6 finding D1-01, the migration is MISSING `RateLimit` and `IdempotencyKey` tables — cross-ref.)

---

## 8. Redis / Cache Alternative

**File:** `src/lib/redis.ts` (78 lines).

### Required or optional?

**OPTIONAL.** Redis is NOT required. The module is a **pure in-memory stub**:

- `kvGet/kvSet/kvDel/kvIncr` operate on a process-local `Map<string, {value, expiresAt}>` (line 19).
- `isRedisAvailable()` (line 67-69) **always returns `false`**.
- The module header (lines 1-16) explicitly states: "Previously this module bridged to a real Redis via `ioredis` when REDIS_URL was set... As of the Cloudflare migration, the app uses D1 tables (`RateLimit`, `IdempotencyKey`) for distributed state... This module is retained as an in-memory-only stub so existing imports keep resolving."
- `REDIS_URL` and `REDIS_PASSWORD` are **NOT READ** anywhere in `src/` (grep confirmed zero matches). They are documented in `.env.example:20-21` as legacy, but the code does not consume them.
- The `ioredis` package is no longer imported. The comment at line 12 notes the dependency "could be dropped from package.json" (cleanup TODO).

### Workers compatibility

- The current stub IS Workers-compatible (no `node:net`, no TCP sockets, no `ioredis`). It uses a `Map` which is per-isolate.
- **BUT** per-isolate means each Workers isolate has its OWN `Map` — there is NO shared state across isolates. The only live caller is `/api/health` (which calls `isRedisAvailable()` → always returns `false`).
- Distributed state that previously lived in Redis (rate-limit counters, idempotency keys) now lives in D1 tables `RateLimit` and `IdempotencyKey` (per `auth.ts:428-503` and `rate-limit.ts`). These ARE shared across isolates via D1.
- **Cross-ref D1-01 (Agent B-6, CRITICAL):** The D1 migration `prisma/migrations/20260925000000_init/migration.sql` is MISSING `CREATE TABLE RateLimit` and `CREATE TABLE IdempotencyKey`. In production, Prisma queries against these tables will throw → rate-limiting falls back to per-isolate in-memory (bypassable across isolates). **Redis was the old answer; D1 tables are the new answer; but the new tables are not deployed.**

### If real Redis were needed in the future

Workers CANNOT use `node-redis` / `ioredis` (no TCP). Options:
1. **Upstash Redis REST** — `@upstash/redis` (HTTP-based, Workers-compatible). Drop-in for `kvGet/kvSet/kvIncr` if the stub is ever upgraded.
2. **Cloudflare KV** — Eventually-consistent key-value. Worse for rate-limit counters (consistency lag), but fine for idempotency keys.
3. **D1 tables (current approach)** — Strongly consistent within a single D1 database. Recommended for this app's scale.

**Verdict:** Redis is NOT required. The stub is Workers-safe. The real distributed-state provider is D1 (with the caveat of D1-01).

---

## 9. CORS / Domain / HTTPS

### CORS configuration

**There is NO CORS configuration in the codebase.** Grep for `Access-Control-Allow` in `src/` returned zero matches (only a comment in `src/components/mek/shared/leaflet-map.tsx:6` referencing third-party tile CORS).

- The app serves same-origin only. Browser `fetch()` from `https://mekanix.ir` to `https://mekanix.ir/api/*` is same-origin → no CORS preflight needed.
- Cross-origin API access (e.g. a third-party site calling `/api/health`) is NOT blocked by code, but browsers will refuse to read the response without `Access-Control-Allow-Origin`. This is the desired secure default.
- The admin panel at `/admin-panel` is same-origin (served by the same Next.js app).

### `allowedDevOrigins` (next.config.ts:8)

```ts
allowedDevOrigins: ["*.space-z.ai"],
```

- **Dev-only** Next.js feature. Surpresses Next.js dev-mode warnings when the dev server is accessed from a cross-origin preview domain (e.g. a Codespaces / preview deployment).
- **NOT a production CORS config.** Has zero effect in production builds.
- The `*.space-z.ai` pattern suggests preview deployments live at `<branch>.space-z.ai` — a deployment-platform convention. No production domain is configured here.
- Also present in `next.config.worker.ts:17` (the Workers-specific config used by the build script).

### Production domain requirements

The codebase does NOT hardcode a production domain anywhere in source. The only domain references are:

- `.env.example:17` `ADMIN_BOOTSTRAP_EMAIL=admin@mekanix.ir` (default admin email).
- `src/lib/admin-auth.ts:81` same default.
- `payment-provider.ts:12` comment example: `callbackUrl: "https://mekanix.ir/api/gateway/callback"`.
- `next.config.ts:8` `allowedDevOrigins: ["*.space-z.ai"]`.

**Operator must configure at launch:**
1. **Production domain** — e.g. `mekanix.ir` (apex) and/or `www.mekanix.ir`. Set in Cloudflare DNS (A/AAAA record or CNAME to the Workers route). The Workers custom domain is configured via `wrangler` / Cloudflare dashboard, NOT in `wrangler.toml` (no `routes` or `custom_domain` section).
2. **HTTPS** — Cloudflare Workers terminate TLS automatically. No code action. The `Strict-Transport-Security` header is set in prod by `src/proxy.ts:23` (`max-age=31536000; includeSubDomains; preload`).
3. **Apex vs www** — pick one canonical (recommend apex `mekanix.ir`). If both are served, configure a redirect from the non-canonical to the canonical. Cloudflare's "Always Use HTTPS" + "Redirect www to apex" rules handle this at the edge.
4. **Cookie domain** — NOT set (defaults to host-only). If the app needs to share cookies across `mekanix.ir` and `www.mekanix.ir`, the operator must add `domain: ".mekanix.ir"` to the `cookies.set()` call in `otp/verify/route.ts:156`. **Recommendation: do NOT share — pick one canonical domain.**
5. **Payment callback URL** — when real payments are wired (§5), the callback URL must be `https://<prod-domain>/api/gateway/callback` and the domain must be registered in the Zarinpal/IDPay dashboard.

### Frame-ancestors / CSP (proxy.ts)

- `src/proxy.ts:35` — `frame-ancestors 'self'` in production, `frame-ancestors *` in dev (for preview panel iframe).
- HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=(self)` — all set in prod. ✅

---

## 10. Observability / Logging

### `wrangler.toml [observability]`

```toml
[observability]
enabled = true
```

- Observability is enabled. Cloudflare Workers Logs capture `console.log` / `console.warn` / `console.error` output, retained for ~3-7 days (free tier) or longer (paid).
- **No `head_sampling_rate` is set** → defaults to `1.0` (sample 100% of invocations). Combined with verbose `console.log` calls in `sms-provider.ts`, this means full-volume logging.

### App-level logging — PII scrubbing?

**NO systematic PII scrubbing.** Findings:

| File:line | Log statement | PII content | Risk |
|-----------|---------------|-------------|------|
| `src/lib/sms-provider.ts:21` | `console.log(\`📱 [DEV SMS] To: ${phone}, Code: ${code}\`)` | Phone number + OTP code | ⚠️ HIGH — when SMS_PROVIDER=console (current wrangler.toml default), this logs on every OTP send. Phone + OTP code are both PII / security-sensitive (OTP can be used to log in as the phone's owner). |
| `src/app/api/auth/otp/send/route.ts:98` | `console.warn(\`⚠️ SMS delivery failed for ${phone}: ${smsResult.error}\`)` | Phone number | MEDIUM — runs on every SMS delivery failure (regardless of NODE_ENV or provider). |
| `src/lib/admin-auth.ts:85,100` | `console.warn` / `console.log` for admin bootstrap | No PII (just username, which may be `"admin"`) | LOW |
| `src/app/api/admin-panel/auth/login/route.ts:87,108` | `console.error("[audit log error] FAILED_ADMIN_LOGIN", e)` | No PII (error object only) | LOW |
| `src/lib/auth.ts:122,171` | `console.error("[auth] Failed to create/query Session DB:", e)` | Error object (may include stack) | LOW — stack traces in prod logs |
| `src/app/api/*` (10+ sites) | `console.error("[...] Failed to create notification ...:", e)` | Error objects | LOW — best-effort notification failures |
| `src/lib/payment-provider.ts:120,129,139,146,185,190,197,202` | `console.log("💳 Payment provider: ...")` | No PII (provider name only) | INFO |

### Error leakage

- **`src/lib/auth.ts:417-425` `apiError()`** — scrubs error messages in production: `error: process.env.NODE_ENV === "production" ? "خطایی در پردازش درخواست رخ داد" : message`. ✅ Client-facing responses use a generic Persian message in prod; the real `message` is only returned in dev.
- **Stack traces** — `console.error(..., e)` logs the full Error object including `.stack` to Workers logs. Stack traces may include file paths, function names, and line numbers — useful for debugging but potentially revealing of internal structure. Not a PII leak per se, but an info-leak risk if logs are accessible to a wide audience.
- **No PII redaction middleware** — there is no log scrubber that strips phone numbers, emails, or tokens from `console.error` output before it hits Workers logs. Operators with access to Workers logs can read all PII.

### Verdict

- Observability is correctly enabled.
- **PII scrubbing is INSUFFICIENT** for production. Two specific calls (`sms-provider.ts:21` and `otp/send/route.ts:98`) log phone numbers — and the first also logs OTP codes.
- **Recommended fixes (out of scope for this read-only audit):**
  1. Gate `sms-provider.ts:21` behind `if (process.env.NODE_ENV !== "production")` — never log OTP codes in prod, even for console provider.
  2. Redact phone numbers in `otp/send/route.ts:98` — log only the last 4 digits.
  3. Set `head_sampling_rate = 0.1` in `wrangler.toml [observability]` to reduce log volume (and PII exposure) by 90%.

---

## 11. Simulator / Console / Mock Guards Audit

For every mock/simulator/console behavior in the codebase: is it gated to non-prod? Could it be active in production? Verdict.

| # | Behavior | File:line | Gated to non-prod? | Could be active in prod? | Verdict |
|---|----------|-----------|---------------------|--------------------------|---------|
| 1 | SMS `console` provider — logs OTP to stdout, no real SMS | `src/lib/sms-provider.ts:20-23` | ❌ NO — selected whenever `SMS_PROVIDER` is unset/`"console"`/has missing creds, regardless of `NODE_ENV` | ⚠️ YES — `wrangler.toml:17 SMS_PROVIDER="console"` is the default; will be active in prod unless overridden | ❌ **PROD-BLOCKER (CFG-03)** — customers can't log in; OTP codes leak to logs (CFG-06) |
| 2 | `/api/auth/otp/send` returns plaintext `code` in response body | `src/app/api/auth/otp/send/route.ts:108-116` | ✅ YES — gated by `isProduction = process.env.NODE_ENV === "production"` (line 101) | NO (in prod) | ✅ Safe — dev-only behavior, gated correctly |
| 3 | `/api/payments` simulator (95% random success) | `src/app/api/payments/route.ts:29-31` | ✅ YES — `if (process.env.NODE_ENV === "production") return 404` | NO (in prod) | ✅ Safe — 404 in prod |
| 4 | `/api/prepay` simulator (any non-empty cardNumber succeeds) | `src/app/api/prepay/route.ts:36-38` | ✅ YES — same guard | NO | ✅ Safe |
| 5 | `/api/gateway/initiate` simulator (random code/referenceId) | `src/app/api/gateway/initiate/route.ts:11-13` | ✅ YES — same guard | NO | ✅ Safe |
| 6 | `/api/gateway/verify` simulator (hardcoded OTP acceptance) | `src/app/api/gateway/verify/route.ts:22-24` | ✅ YES — same guard | NO | ✅ Safe |
| 7 | `/api/vip/subscribe` simulator | `src/app/api/vip/subscribe/route.ts:18-20` | ✅ YES — same guard | NO | ✅ Safe |
| 8 | `/api/auth/demo` — returns demo users for one-click sign-in | `src/app/api/auth/demo/route.ts:24-26` + `next.config.ts:14-17` rewrite to /404 in prod | ✅ YES — both route handler AND next.config rewrite | NO | ✅ Safe — defense-in-depth |
| 9 | `payment-provider.ts` simulator (`simulatorCreate`/`simulatorVerify`) | `src/lib/payment-provider.ts:43-58` | n/a — DEAD CODE (no route imports) | n/a — never invoked | ℹ️ Inert (CFG-14) |
| 10 | `payment-provider.ts` NextPay stub | `src/lib/payment-provider.ts:194-197` | n/a — DEAD CODE | n/a | ℹ️ Inert |
| 11 | `/api/health` reports `sms: "console"` and `eta: "simulator"` | `src/app/api/health/route.ts:32-34` | n/a — informational only | n/a — always runs (intentional) | ✅ Safe — observability surface |
| 12 | ETA default 40 km/h haversine (no real routing) | `src/lib/dispatch.ts:71-74`, `src/lib/eta-provider.ts:31-34` | ❌ NO — used when no ETA provider key is set | ⚠️ YES — default if `NESHAN_API_KEY`/`GOOGLE_MAPS_API_KEY`/`OSRM_API_URL` unset (which is the wrangler.toml default) | ⚠️ Acceptable — ETA is approximate but not security-critical. Customer experience degrades (less accurate ETAs) but app functions. |
| 13 | `redis.ts` in-memory stub (per-isolate Map) | `src/lib/redis.ts:19-69` | n/a — always runs | n/a — always runs | ⚠️ Cross-ref D1-01 — distributed state relies on D1 tables that are missing from migration. Rate-limiting degrades to per-isolate. |
| 14 | `auth.ts` dev fallback JWT secret `"mekanix-dev-secret-change-in-production"` | `src/lib/auth.ts:40` | ✅ YES — only when `NODE_ENV !== "production"`; throws in prod if `JWT_SECRET` unset | NO (in prod) | ✅ Safe — fail-closed in prod |
| 15 | `admin-auth.ts` dev fallback `"mekanix-admin-dev-secret-change-me"` | `src/lib/admin-auth.ts:17` | ✅ YES — same gate | NO (in prod) | ✅ Safe — BUT masks the JWT_SECRET collision (CFG-02) in dev |
| 16 | `admin-auth.ts` default admin `admin/admin12345` | `src/lib/admin-auth.ts:104-115` | ✅ YES — `if (process.env.NODE_ENV === "production")` guard at line 78 | NO (in prod) | ✅ Safe — prod requires `ADMIN_BOOTSTRAP_PASSWORD` |
| 17 | `auth.ts` in-memory idempotency fallback (`idemMemStore`) | `src/lib/auth.ts:448,487-501` | ⚠️ PARTIAL — runs whenever D1 `IdempotencyKey` query throws (regardless of NODE_ENV) | ⚠️ YES — if D1 table missing (D1-01), prod falls back to per-isolate Map | ⚠️ Cross-ref D1-01 — idempotency guarantees weaken to per-isolate in prod |
| 18 | `rate-limit.ts` in-memory fallback | (per Agent B-4/B-6) | ⚠️ PARTIAL — same pattern | ⚠️ YES — if D1 `RateLimit` table missing (D1-01) | ⚠️ Cross-ref D1-01 — rate-limiting bypassable across isolates |
| 19 | `auth.ts` `apiError()` returns generic Persian message | `src/lib/auth.ts:420` | ✅ YES — `process.env.NODE_ENV === "production"` | n/a | ✅ Safe — error details hidden in prod |
| 20 | `proxy.ts` `frame-ancestors *` in dev | `src/proxy.ts:35` | ✅ YES — gated to `NODE_ENV !== "production"` | NO (in prod uses `'self'`) | ✅ Safe |

### Summary of prod-unsafe behaviors

- **Hard blockers (must fix before any prod traffic):** #1 (SMS console — CFG-03/CFG-06).
- **Soft blockers (degrade but app functions):** #12 (ETA default — acceptable), #13/#17/#18 (Redis/D1 fallbacks — cross-ref D1-01).
- **Inert (dead code, no effect):** #9, #10 (CFG-14).
- **Correctly gated:** all others (✅).

---

## 12. `.env.example` / `.dev.vars.example` Audit

### `.env.example` (tracked, 54 lines)

**Contents:**
- `DATABASE_URL=file:/home/z/my-project/db/custom.db` (line 7) — ⚠️ CFG-08: hardcoded absolute path; should be relative `file:./db/custom.db`.
- `JWT_SECRET=change-this-to-a-secure-secret` (line 12) — placeholder, OK.
- `ADMIN_BOOTSTRAP_*` (lines 14-17) — commented, OK.
- `REDIS_URL` / `REDIS_PASSWORD` (lines 19-21) — commented. ⚠️ Misleading: the code does NOT read these. Should be removed or marked "DEPRECATED — not read by code; distributed state uses D1 tables".
- `SMS_PROVIDER` + per-provider keys (lines 23-35) — documented, OK.
- `PAYMENT_PROVIDER` + `ZARINPAL_MERCHANT_ID` / `IDPAY_API_KEY` (lines 37-42) — documented but ⚠️ misleading: `payment-provider.ts` is DEAD CODE. Setting these has no effect until routes are wired. Should be marked "NOT YET WIRED — see AUDIT_PROD_CONFIG.md §5".
- `NESHAN_API_KEY` / `GOOGLE_MAPS_API_KEY` / `OSRM_API_URL` (lines 44-47) — documented, OK.
- "Production safety gates" comment (lines 49-54) — ⚠️ CFG-01: claims `/api/ready` returns 503 for console/simulator/file: combos. **The code does NOT implement this.** Misleading documentation.

**MISSING from `.env.example`:**
- `DISPATCH_POOL_SIZE` (read in `dispatch.ts:117`, default 200).
- `NODE_ENV` documentation (set in `wrangler.toml [vars]` — should be noted).
- Note that `wrangler.toml [vars]` sets `SMS_PROVIDER`/`PAYMENT_PROVIDER`/`NODE_ENV` for the Workers deployment (different from `.env` for Node dev).
- `KAVENEGAR_TEMPLATE` (optional, documented in code but not in `.env.example`).
- `ADMIN_JWT_SECRET` — should be added once CFG-02 fix lands (currently admin uses same `JWT_SECRET`).

**Secrets that should NOT be there (committed real values):**
- None found. ✅ All values are placeholders, commented examples, or dev defaults. No real secret values committed.

### `.dev.vars.example` (tracked, 8 lines)

**Contents:**
- `JWT_SECRET=dev-jwt-secret-not-for-production` (line 7) — dev placeholder, OK.
- `DATABASE_URL=file:./db/custom.db` (line 8) — relative path, OK. ✅ (Contrast with `.env.example:7` which uses the broken absolute path — inconsistency.)

**MISSING from `.dev.vars.example`:**
- No mention of `SMS_PROVIDER`, `PAYMENT_PROVIDER`, `NODE_ENV` — these are set in `wrangler.toml [vars]` for `wrangler dev`, but the operator should know that `.dev.vars` overrides `[vars]`. Could add commented examples.
- No mention of `ADMIN_BOOTSTRAP_*` — for local admin login testing, operator needs to set these OR rely on dev default (`admin/admin12345`).

**Secrets that should NOT be there:** None. ✅

### Committed-real-secret scan

Grep across `src/`, `scripts/`, `wrangler.toml`, `.env.example`, `.dev.vars.example` for values that look like real secrets (long hex / base64 strings, API keys):

- `wrangler.toml:14 database_id = "f8dbaaf3-4c6b-40d5-9dce-ecaa839780e2"` — this is a D1 database ID (UUID), not a secret per se, but it IS a real Cloudflare resource identifier. It IS committed (tracked). If this is a production D1 instance ID, exposing it in the repo is low-risk (the ID alone doesn't grant access — Cloudflare account auth required), but it does leak the existence and name of the D1 instance. Acceptable but noted.
- `src/app/api/admin-panel/auth/login/route.ts:17-18` `DUMMY_HASH = "$2b$12$tpLZmwp/I64rrSkfS/Pjc.YRC4Gl7ZJs9.O5eret1H/OpfxNlSkFO"` — a bcrypt hash of an unknown string. Used for timing-attack mitigation (constant-time comparison when admin not found). This is NOT a real password hash — it's a hardcoded dummy. Safe to commit (it's a public constant for a non-existent account). ✅
- `.env` (untracked, local only) — `DATABASE_URL=file:/home/z/my-project/db/custom.db` only. No secrets. ✅

**No committed real secret VALUES found.** ✅

---

## 13. Code Readiness Checklist (what's correct now)

These are the configuration-readiness items the codebase ALREADY handles correctly. No action needed.

- ✅ **`NODE_ENV="production"` is correctly set** in `wrangler.toml:19 [vars]` — all `NODE_ENV==="production"` guards activate.
- ✅ **JWT secret fail-closed in prod** — `auth.ts:36-37` and `admin-auth.ts:13-14` both `throw` if `JWT_SECRET` is unset in production. No silent fallback to dev secret.
- ✅ **Session DB persistence is fail-closed in prod** — `auth.ts:123-129` throws if Session record cannot be created in prod; `auth.ts:174-176` rejects session on DB error in prod.
- ✅ **OTP code is HASHED (SHA-256) before DB storage** — `otp/send/route.ts:73` + `otp-crypto.ts:12-14`. DB read alone cannot reveal usable codes.
- ✅ **OTP code NOT returned in response body in prod** — `otp/send/route.ts:108` gates `response.code` behind `!isProduction`.
- ✅ **Cookie `secure` flag tied to NODE_ENV** — `otp/verify/route.ts:158` `secure: process.env.NODE_ENV === "production"`.
- ✅ **Cookie `httpOnly: true`** — `otp/verify/route.ts:157`. JS cannot read the token.
- ✅ **Cookie `sameSite: "lax"`** — `otp/verify/route.ts:159`. CSRF-resistant.
- ✅ **Cookie `path: "/"`** and no `domain` (host-only) — `otp/verify/route.ts:161`. Safe default.
- ✅ **All 5 payment routes hard-404 in prod** — verified at `payments/route.ts:29`, `prepay/route.ts:36`, `gateway/initiate/route.ts:11`, `gateway/verify/route.ts:22`, `vip/subscribe/route.ts:18`. No simulator reaches real customers.
- ✅ **`/api/auth/demo` hard-404 in prod** — `auth/demo/route.ts:24` + `next.config.ts:14-17` rewrite. Defense-in-depth.
- ✅ **HSTS + CSP + X-Frame-Options in prod** — `proxy.ts:22-37`. TLS enforced at edge.
- ✅ **Error message scrubbing in prod** — `auth.ts:420` returns generic Persian message in prod.
- ✅ **Admin login rate limit** — `admin-panel/auth/login/route.ts:32,48` (5 per 15 min per IP).
- ✅ **Admin login timing-attack mitigation** — `admin-panel/auth/login/route.ts:67-69` DUMMY_HASH constant-time comparison.
- ✅ **Default admin (`admin/admin12345`) NOT created in prod** — `admin-auth.ts:78` gate; requires `ADMIN_BOOTSTRAP_PASSWORD`.
- ✅ **D1 binding name `DB` matches `env.DB` consumer** — `wrangler.toml:12` ↔ `db-worker.ts:45,60`.
- ✅ **D1 binding throw if missing** — `db-worker.ts:45-49` throws `"D1 binding 'DB' not found"` if `env.DB` is undefined. Fail-closed.
- ✅ **SMS provider abstraction is pluggable** — 3 real providers (kavenegar, melipayamak, farapayamak) implemented, env-driven.
- ✅ **Payment provider abstraction is pluggable** (but DEAD CODE — CFG-14) — 2 real providers (zarinpal, idpay) implemented, awaiting route wiring.
- ✅ **ETA provider abstraction is pluggable** — 3 real providers (neshan, google, osrm) + default fallback.
- ✅ **SMS provider lazy-init** — `sms-provider.ts:151` initializes on first `sendOtp()` call. Works in Workers (no module-load-time `process.env` access).
- ✅ **SMS health-check helper** — `getSmsProviderStatus()` (`sms-provider.ts:157-186`) reports `configured`, `provider`, `warnings`.
- ✅ **`/api/health` exposes `sms` provider** for monitoring (`health/route.ts:32`).
- ✅ **Observability enabled** — `wrangler.toml:21-22 [observability] enabled=true`.
- ✅ **`.env` and `.dev.vars` are gitignored** — `.gitignore` lines `.env*` + `!.env.example` confirmed; `git ls-files` shows only `.env.example` and `.dev.vars.example` tracked.
- ✅ **No committed real secret values** — all values are placeholders/dev defaults.
- ✅ **`apiError()` does not leak stack traces to clients** in prod.
- ✅ **Idempotency infrastructure exists** — `auth.ts:450-503` `withIdempotency()` reads `Idempotency-Key` header, persists to D1 `IdempotencyKey` table (when table exists — cross-ref D1-01).
- ✅ **Per-route `NODE_ENV==="production"` guards are anti-fingerprinting** — bare 404 (no body, no JSON) so attackers can't enumerate route existence.
- ✅ **Cookie cleared on logout** — `logout/route.ts:48` `response.cookies.delete("mekanix-token")` + Session DB row revoked.

---

## 14. Final Activation Checklist (owner actions at launch — names only)

The owner MUST complete these before pointing production DNS at the Worker. Items are grouped; names only (no values).

### A. Cloudflare account / D1 (prerequisite)

1. ☐ Verify ownership of D1 instance `database_id=f8dbaaf3-4c6b-40d5-9dce-ecaa839780e2` — run `wrangler d1 info mekanix` and confirm it belongs to the production Cloudflare account. If not, `wrangler d1 create mekanix` and update `wrangler.toml:14`.
2. ☐ Apply D1 migrations: `wrangler d1 migrations apply mekanix` (production). **Blocker: must include `RateLimit` and `IdempotencyKey` tables — currently MISSING (D1-01).** Coordinate with Agent B-6's fix before this step.
3. ☐ Configure Workers custom domain (e.g. `mekanix.ir`) in Cloudflare dashboard or via `wrangler` (NOT in `wrangler.toml` — no `routes` section currently).
4. ☐ Enable "Always Use HTTPS" + "Redirect www → apex" (or pick canonical) in Cloudflare dashboard.

### B. Required secrets (via `wrangler secret put`)

5. ☐ `wrangler secret put JWT_SECRET` — generate a strong random value (≥32 bytes). **CRITICAL: do NOT reuse for admin until CFG-02 fix lands.** (See item 16 below.)
6. ☐ `wrangler secret put ADMIN_BOOTSTRAP_PASSWORD` — strong password for the initial super-admin. Without this, NO admin can log in to the panel in prod.
7. ☐ `wrangler secret put SMS_PROVIDER` — value = `kavenegar` | `melipayamak` | `farapayamak` (overrides `wrangler.toml [vars] SMS_PROVIDER="console"`). **PROD BLOCKER without this.**
8. ☐ Set the SMS provider credentials for the chosen provider:
   - If `kavenegar`: `wrangler secret put KAVENEGAR_API_KEY`. (Optional: `wrangler secret put KAVENEGAR_TEMPLATE`.)
   - If `melipayamak`: `wrangler secret put MELIPAYAMAK_USERNAME` + `MELIPAYAMAK_PASSWORD` + `MELIPAYAMAK_SENDER`.
   - If `farapayamak`: `wrangler secret put FARAPAYAMAK_USERNAME` + `FARAPAYAMAK_PASSWORD` + `FARAPAYAMAK_SENDER`.

### C. Optional secrets / vars (tuning)

9. ☐ `wrangler secret put NESHAN_API_KEY` (or `GOOGLE_MAPS_API_KEY` or `OSRM_API_URL`) — for accurate ETA. Without these, ETA defaults to 40 km/h haversine (acceptable but coarse).
10. ☐ `wrangler secret put DISPATCH_POOL_SIZE` — tune for deployment density (default 200). Usually leave default.
11. ☐ (Optional) `wrangler secret put ADMIN_BOOTSTRAP_USERNAME` and `ADMIN_BOOTSTRAP_EMAIL` — override defaults (`admin` / `admin@mekanix.ir`).
12. ☐ (Optional) Override `PAYMENT_PROVIDER` — note: this has NO EFFECT until `payment-provider.ts` is wired into routes (§5). Skip unless real payments are being activated.

### D. Domain / HTTPS / CORS

13. ☐ Point production DNS A/AAAA (or CNAME) record at the Workers custom domain.
14. ☐ Verify HTTPS works: `curl -I https://<prod-domain>/api/health` → 200, `strict-transport-security` header present.
15. ☐ Decide apex vs www — pick ONE canonical; configure redirect from the other. Do NOT set a `domain` on the `mekanix-token` cookie (leave host-only).

### E. Code fixes REQUIRED before prod traffic (engineering — out of scope of this read-only audit)

16. ☐ **CFG-02 / SEC-21 fix:** Introduce `ADMIN_JWT_SECRET` (or a `kind: "admin"` claim) so user JWTs cannot verify as admin tokens. This is a CRITICAL security fix; do not deploy without it. Coordinate with Agent B-4.
17. ☐ **CFG-01 fix:** Implement the documented `/api/ready` production safety gates (503 if `SMS_PROVIDER=console` or `PAYMENT_PROVIDER=simulator` or `DATABASE_URL` starts with `file:` in prod). Currently the route only checks DB connectivity — the docs lie.
18. ☐ **CFG-06/07 fix:** Gate `sms-provider.ts:21` console.log behind `NODE_ENV !== "production"`; redact phone numbers in `otp/send/route.ts:98`.
19. ☐ **CFG-08 fix:** Change `.env.example:7` from absolute `file:/home/z/my-project/db/custom.db` to relative `file:./db/custom.db` (consistency with `.dev.vars.example:8`).
20. ☐ **CFG-09 fix:** Add `DISPATCH_POOL_SIZE` and `NODE_ENV` to `.env.example`; mark `REDIS_URL`/`REDIS_PASSWORD` as deprecated; mark `PAYMENT_PROVIDER`/`ZARINPAL_MERCHANT_ID`/`IDPAY_API_KEY` as "NOT YET WIRED".
21. ☐ **D1-01 fix (Agent B-6):** Add `CREATE TABLE RateLimit` and `CREATE TABLE IdempotencyKey` to `prisma/migrations/20260925000000_init/migration.sql`. Without this, rate-limiting and idempotency degrade to per-isolate in prod.
22. ☐ **CF-01 fix (Agent B-2):** `git rm public/mekanix-source.tar.gz` — the source-tarball is a tracked public static asset that ships `src/` + `.env` to anyone hitting `https://<worker>/mekanix-source.tar.gz`. Deploy-blocker.
23. ☐ **CF-05 fix (Agent B-2):** Gate `setInterval` in `redis.ts:72` — `setInterval` is not Workers-safe (long-lived timer outside request scope). Currently benign (the function it calls is a no-op cleanup of an empty Map), but should be removed or wrapped.

### F. Post-deploy verification (operator)

24. ☐ Hit `https://<prod-domain>/api/health` → confirm `services.sms` = chosen provider (NOT `"console"`), `services.database` = `"healthy"`, `services.redis` = `"not-configured"` (expected).
25. ☐ Hit `https://<prod-domain>/api/ready` → confirm `200` and `checks.database = true`. (Once CFG-01 fix lands, also confirm 503 if SMS_PROVIDER were console — but you should NOT be deploying with console.)
26. ☐ Check Workers logs (`wrangler tail` or Cloudflare dashboard → Logs) for the line `📱 SMS provider: Kavenegar` (or MeliPayamak/Farapayamak) on first OTP request. If you see `📱 SMS provider: console (dev mode)`, the SMS_PROVIDER override did not take effect — fix and redeploy.
27. ☐ Test a real OTP send to a test phone number — confirm the SMS arrives.
28. ☐ Test admin login at `/admin-panel` with the `ADMIN_BOOTSTRAP_*` credentials.
29. ☐ Confirm all 5 payment routes return 404 in prod: `curl -o /dev/null -s -w "%{http_code}\n" -X POST https://<prod-domain>/api/payments` → `404`. (This is the expected simulator-disabled state until real payments are wired.)
30. ☐ Confirm `/api/auth/demo` returns 404: `curl -o /dev/null -s -w "%{http_code}\n" https://<prod-domain>/api/auth/demo` → `404`.

---

## 15. Findings Table

| ID | File:line | Severity | Description | Status | Fix |
|----|-----------|----------|-------------|--------|-----|
| **CFG-01** | `src/app/api/ready/route.ts:6-25` | **CRITICAL** | `/api/ready` does NOT implement the production safety gates documented in `.env.example:50-53` (SMS=console, PAYMENT=simulator, DATABASE_URL=file:). Only checks DB connectivity. A broken production deploy (console SMS, simulator payments, SQLite path) will report 200 OK → traffic routes to a broken app. | Open | Implement the three documented gates in `/api/ready`. Each should add a check + push to `errors[]` + set `ok=false` when `NODE_ENV==="production"` AND the bad combo is detected. |
| **CFG-02** | `src/lib/admin-auth.ts:8` ↔ `src/lib/auth.ts:34` | **CRITICAL** | JWT secret collision — both user and admin JWT paths read `process.env.JWT_SECRET`. No `ADMIN_JWT_SECRET` exists. In production (where `JWT_SECRET` is set), a user JWT verifies as an admin token → admin auth bypass. Cross-ref SEC-21 (Agent B-4). | Open | Add `ADMIN_JWT_SECRET` env var; change `admin-auth.ts:8` to read it (with `JWT_SECRET` as fallback for backward compat, or fail-closed in prod if unset). OR add a `kind: "admin"` claim to admin JWTs and reject user JWTs in `verifyAdminToken`. |
| **CFG-03** | `wrangler.toml:17` (`SMS_PROVIDER = "console"`) | **HIGH** | SMS provider set to `console` in wrangler.toml `[vars]` — this is the runtime default. Without an operator override (`wrangler secret put SMS_PROVIDER=kavenegar`), production will log OTPs to stdout and never send real SMS → customers cannot log in. | Open (operator action) | Override via `wrangler secret put SMS_PROVIDER` with the chosen real provider. Code-side defense-in-depth: add `NODE_ENV==="production"` guard in `initSmsProvider()` that throws if `SMS_PROVIDER==="console"`. |
| **CFG-04** | `wrangler.toml:18` (`PAYMENT_PROVIDER = "simulator"`) + `src/lib/payment-provider.ts` (DEAD CODE) | **HIGH** | `PAYMENT_PROVIDER=simulator` is a no-op — `payment-provider.ts` is dead code (zero route imports, confirmed by grep). Real payment separation is via per-route `NODE_ENV==="production"` → 404. All 5 payment routes hard-404 in prod → no revenue flow possible until real gateway is wired. | Open (engineering work) | Wire `payment-provider.ts` into the 5 payment routes; remove the per-route `NODE_ENV` → 404 guard; set real `ZARINPAL_MERCHANT_ID` or `IDPAY_API_KEY` via `wrangler secret put`. Until then, app is "marketing-only". |
| **CFG-05** | `src/lib/init.ts:4-21` | **LOW** | `init.ts` only runs `initSmsProvider()` on Node.js (dev). On Workers, lazy-init happens on first `sendOtp()` call. A misconfigured SMS provider (e.g. `SMS_PROVIDER=kavenegar` but `KAVENEGAR_API_KEY` unset) silently falls through to `consoleProvider` (line 145-147 `else` branch) with only a generic log line — no warning that the requested real provider fell back. | Open | Add explicit warning in `initSmsProvider()` when `provider === "kavenegar"` but `KAVENEGAR_API_KEY` is unset (and similar for melipayamak/farapayamak). Currently `getSmsProviderStatus()` does this — but it's not called at init time. |
| **CFG-06** | `src/lib/sms-provider.ts:21` | **MEDIUM** | `console.log(\`📱 [DEV SMS] To: ${phone}, Code: ${code}\`)` runs whenever `SMS_PROVIDER=console` (regardless of `NODE_ENV`). In production with console provider (the wrangler.toml default), phone numbers AND OTP codes are written to Workers logs (observability enabled). PII + security-sensitive (OTP can be used to log in as the phone's owner). | Open | Gate the log behind `if (process.env.NODE_ENV !== "production")`. Never log OTP codes in prod, even for console provider. |
| **CFG-07** | `src/app/api/auth/otp/send/route.ts:98` | **MEDIUM** | `console.warn(\`⚠️ SMS delivery failed for ${phone}: ${smsResult.error}\`)` always logs the phone number, regardless of `NODE_ENV` or provider. PII leak. | Open | Redact phone number — log only last 4 digits: `...for ***${phone.slice(-4)}: ...`. |
| **CFG-08** | `.env.example:7` | **MEDIUM** | `DATABASE_URL=file:/home/z/my-project/db/custom.db` — hardcoded absolute path that only works on the sandbox dev machine. Anyone using `.env.example` as a template on a different machine gets a broken path. Inconsistent with `.dev.vars.example:8` which correctly uses relative `file:./db/custom.db`. | Open | Change to `DATABASE_URL=file:./db/custom.db` (relative). |
| **CFG-09** | `.env.example` (whole file) | **MEDIUM** | Documentation gaps: (a) `DISPATCH_POOL_SIZE` (read in `dispatch.ts:117`) is undocumented; (b) `NODE_ENV` is set in `wrangler.toml [vars]` but not documented in `.env.example`; (c) `REDIS_URL`/`REDIS_PASSWORD` are documented but NOT READ by code (deprecated); (d) `PAYMENT_PROVIDER`/`ZARINPAL_MERCHANT_ID`/`IDPAY_API_KEY` are documented but `payment-provider.ts` is DEAD CODE — setting them has no effect; (e) production safety gates comment (lines 50-53) describes behavior that does NOT exist (CFG-01). | Open | Add missing vars; mark deprecated/unused; correct the safety-gate documentation to match reality (or implement the gates per CFG-01). |
| **CFG-10** | `src/lib/admin-auth.ts:8` | **LOW** | `const JWT_SECRET = process.env.JWT_SECRET;` is read at MODULE TOP-LEVEL (not inside a function). Comments in `auth.ts:29-31` explicitly warn against this pattern because "in Workers/OpenNext, process.env may not be fully populated at module evaluation time." If `JWT_SECRET` is set via `wrangler secret put` (recommended), it IS available at module eval — but the pattern is inconsistent with `auth.ts` and fragile. Currently fail-closed (throws on first admin login if unset) but could fail in confusing ways if `process.env` is not yet populated. | Open | Refactor `admin-auth.ts:8` to read `JWT_SECRET` inside `getAdminSecret()` (matching the `auth.ts:33-43` pattern). |
| **CFG-11** | `wrangler.toml:21-22` | **LOW** | `[observability] enabled=true` with no `head_sampling_rate` → defaults to 1.0 (sample 100% of invocations). Combined with CFG-06/07 PII logging, full-volume PII is captured and retained. | Open | Set `head_sampling_rate = 0.1` (10% sampling) in `wrangler.toml [observability]` to reduce log volume and PII exposure. Fix CFG-06/07 first (sampling is not a substitute for not-logging-PII). |
| **CFG-12** | `next.config.ts:8`, `next.config.worker.ts:17` | **LOW** | `allowedDevOrigins: ["*.space-z.ai"]` — dev-only Next.js feature (suppresses cross-origin dev warnings). NOT a production CORS config. Has zero effect in production. Should be documented as dev-only to avoid confusion. | Open | Add a comment: `// dev-only: suppresses Next.js dev warnings for *.space-z.ai preview deployments; no production effect`. |
| **CFG-13** | `src/lib/redis.ts:1-78` | **LOW** | Redis stub: `isRedisAvailable()` always returns `false`. Per-isolate `Map` (not shared across Workers isolates). Distributed state relies on D1 `RateLimit` + `IdempotencyKey` tables — which are MISSING from the D1 migration (D1-01, Agent B-6 CRITICAL). In prod, rate-limiting and idempotency silently degrade to per-isolate in-memory (bypassable across isolates). | Open (cross-ref D1-01) | Coordinate with Agent B-6's D1-01 fix (add missing tables to migration). The redis.ts stub itself is Workers-safe and needs no change. |
| **CFG-14** | `src/lib/payment-provider.ts` (whole file, 226 lines) | **INFO** | Dead code: `payment-provider.ts` is not imported by any route handler (confirmed by grep — only e2e tests + docs reference it). `PAYMENT_PROVIDER` env var (read only inside this file) has zero runtime effect. The `simulatorCreate`/`simulatorVerify` paths never execute in any deployment. | Open (engineering cleanup) | Either (a) wire `payment-provider.ts` into the 5 payment routes (activates real payment path) OR (b) delete the file and remove `PAYMENT_PROVIDER` from `wrangler.toml [vars]` and `.env.example` until the real integration is built. Option (a) is preferred. |
| **CFG-15** | `wrangler.toml:11-14` | **INFO** | D1 binding name `DB` matches `env.DB` consumer in `db-worker.ts:45,60`. Type augmentation declared at `db-worker.ts:20-24`. End-to-end consistent. `database_id` ownership NOT VERIFIABLE without Cloudflare creds. | Verified (binding name) / Not verified (ownership) | Operator: run `wrangler d1 info mekanix` to verify ownership before deploy. |
| **CFG-16** | `src/app/api/admin-panel/auth/login/route.ts:111-114` | **INFO** | Admin token returned in JSON body (not cookie). Stored client-side by admin panel SPA. Different auth model from user cookie auth. No `secure`/`httpOnly` flag applies. HTTPS enforced by deployment (Workers TLS). Acceptable but worth noting. | Accepted | No action required. If the admin panel is ever moved to a cookie-based model, add `httpOnly: true, secure: NODE_ENV==="production", sameSite: "strict"` flags. |
| **CFG-17** | `src/lib/db-worker.ts:45-49` | **INFO** | D1 binding throws `"D1 binding 'DB' not found"` if `env.DB` is undefined. Fail-closed — a misconfigured Worker (missing `[[d1_databases]]` in wrangler.toml) will reject every DB-touching request with 500, not silently use a stub. ✅ Correct behavior. | Verified | No action. |

**Totals:** 1 CRITICAL (CFG-01) + 1 CRITICAL (CFG-02, cross-ref SEC-21) + 2 HIGH (CFG-03, CFG-04) + 4 MEDIUM (CFG-06, CFG-07, CFG-08, CFG-09) + 4 LOW (CFG-05, CFG-10, CFG-11, CFG-12, CFG-13) + 4 INFO (CFG-14, CFG-15, CFG-16, CFG-17).

**Cross-agent references:** SEC-21 (Agent B-4) = CFG-02; D1-01 (Agent B-6) = CFG-13 + §8; PAY-07 (Agent B-5) = §5; CF-01 (Agent B-2) = item 22; CF-05 (Agent B-2) = item 23.

---

*End of audit. Report path: `/home/z/my-project/docs/AUDIT_PROD_CONFIG.md`.*
