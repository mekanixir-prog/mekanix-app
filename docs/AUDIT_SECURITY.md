# MEKANIX — Backend Security Audit Report (B-4)

**Date:** 2026-10-14
**Auditor:** Agent 4 — Backend Security Auditor
**Branch audited:** `feature/cloudflare-d1-validation @ 1cf59e7` (working tree = main `@ 23b71d2`, code-identical)
**Scope:** All routes under `src/app/api/` + auth helpers (`src/lib/auth.ts`, `src/lib/admin-auth.ts`, `src/lib/care-auth.ts`, `src/lib/permissions.ts`) + rate-limit + OTP/session subsystems
**Methodology:** Static code review (every route read end-to-end) + 13 negative runtime tests exercising REAL route handlers with REAL authz helpers (only DB + rate-limit mocked at the boundary)
**Constraints honored:** READ-ONLY on all source; the ONE additive source change is `tests/unit/security-audit-negative.test.ts`. No migrations, no deploys, no pushes. The 29 modified UI files were not touched.

---

## 1. Executive Summary

- **Routes audited:** 71 route files under `src/app/api/` (covering ~140 HTTP handler functions across GET/POST/PATCH/DELETE)
- **Prior fixes verified present:** 8 / 9 (PAY-01, VIP-01, GW-02, GW-01, RL-01, M-04, M-04b confirmed; M-03 confirmed on `/technicians/[id]` but a **regression/miss** found on `/technicians` public LIST — phone still exposed)
- **New findings:** 1 CRITICAL, 2 MEDIUM, 3 LOW (6 new findings)
- **Negative tests added:** 13 tests, **13 PASS / 0 FAIL** — i.e. every BOLA / authz / authn / enumeration gate tested actually REJECTS the cross-tenant / unauthenticated / non-admin attempt as expected
- **Status:** ⚠️ **CONDITIONAL** — the 1 CRITICAL (SEC-21: admin auth bypass via user JWT in production) is a release blocker; it is not exploitable in dev mode (secrets differ) but IS exploitable in production (same `JWT_SECRET`). All other findings are Medium/Low and consistent with the prior audit's accepted-risk posture.

The MEKANIX backend's BOLA / IDOR posture is **strong** — every `[id]` route tested correctly enforces ownership via `requireJobParticipant` / `requireVehicleOwner` / `requireBookingParticipant` / `requireAssignedTechnician`. The CRITICAL is an admin-auth design gap, not a per-route BOLA.

---

## 2. Verified Prior Fixes Table

Each prior fix was verified by reading the current source on the working tree (not by trusting the prior audit docs).

| ID | Fix | Present? | Correct? | File:Line evidence |
|----|-----|----------|----------|---------------------|
| **PAY-01** | Payments route production guard (404 in prod) | ✅ YES | ✅ Correct | `src/app/api/payments/route.ts:29-31` — `if (NODE_ENV==="production") return new NextResponse(null,{status:404});` at the TOP of POST, before `requireAuth`. Bare 404, no JSON body. |
| **VIP-01** | VIP subscription payment-reuse prevention | ✅ YES | ✅ Correct | `src/app/api/vip/subscribe/route.ts:62-68` — `db.userVipSubscription.findFirst({ where: { paymentId, status: { in: ["ACTIVE","CANCELLED","EXPIRED"] } } })` → 409 if found. Plus `paymentId` validated against `payment.userId === session.userId` (line 53-60). Production guard also present (line 18-20). |
| **GW-02** | Atomic gateway verify (double-verify prevention) | ✅ YES | ✅ Correct | `src/app/api/gateway/verify/route.ts:48-55` — `updateMany({ where: { id, status: { not: "VERIFIED" } }, data: { status: "VERIFIED", verifiedAt: now } })` → `if (verifyResult.count === 0) return 400 "Already verified"`. Also checks `log.userId === session.userId` (line 44). Production guard (line 22-24). |
| **GW-01** | Gateway initiate amount validation | ✅ YES | ✅ Correct | `src/app/api/gateway/initiate/route.ts:22-29` — `if (!amount || amount <= 0) return 400` and `if (amount > 100_000_000) return 400 "مبلغ غیرمجاز"`. Production guard (line 11-13). userId from session (line 38). |
| **RL-01** | Atomic rate-limit increment | ✅ YES | ✅ Correct | `src/lib/rate-limit.ts:81-105` — `updateMany({ where: { key, count: { lt: max }, expiresAt: { gt: now } }, data: { count: { increment: 1 } } })` → if `count===1` allow; else check expiry and `upsert` fresh window (lines 96-101) or deny (line 105). True atomic SQL: `UPDATE ... SET count=count+1 WHERE key=? AND count<max AND expiresAt>now`. |
| **M-03** | Technician PII removal (phone) from public detail route | ✅ PARTIAL | ⚠️ See SEC-22 | `src/app/api/technicians/[id]/route.ts:7-17` — `PUBLIC_USER_FIELDS` omits `phone` ✅. BUT `src/app/api/technicians/route.ts:13-24` (public LIST, NO auth) still has `phone: true` (line 16). New finding SEC-22. |
| **M-04** | Admin auth enforced on admin routes | ✅ YES | ✅ Correct | `src/app/api/admin/[resource]/route.ts:68-69`, `src/app/api/admin/[resource]/[id]/route.ts:50-53`, `src/app/api/admin-panel/onboarding/route.ts:8,16`, `src/app/api/admin-panel/onboarding/[id]/route.ts:39,70`, `src/app/api/admin-panel/auth/me/route.ts:7` — all check `getAdminFromRequest(req)` and return 401 if null. **BUT see SEC-21** — `getAdminFromRequest` itself is bypassable in production via a user JWT. |
| **M-04b** | Admin login hardening (rate limit + unified error + timing) | ✅ YES | ✅ Correct | `src/app/api/admin-panel/auth/login/route.ts` — SEC-13 unified message `UNAUTH_MSG` (line 19, returned on both user-not-found and wrong-password at line 91); DUMMY_HASH bcrypt compare always runs (lines 67-69); SEC-5 rate limit 5/15min (lines 32, 45-57); audit log on both failed (72-88) and successful (97-109) logins. |

**Score: 8/9 fully present and correct. 1/9 (M-03) partially present — the `[id]` route is clean but the public LIST route still leaks phone.**

---

## 3. Accepted-Risk Reassessment

| ID | Item | Still valid? | Severity now | Notes |
|----|------|--------------|--------------|-------|
| **H-1** | OTP verify O(n) user scan | ✅ Still present | **Medium** (unchanged) | `src/app/api/auth/otp/verify/route.ts:89-108` — `db.user.findMany({ select: { id, phone } })` then `.find(u => u.phone.replace(/\D/g,"") === phoneDigits)` loads ALL users into memory. **Mitigating factor verified:** the scan is reached ONLY after `consumed.count === 1` (line 77) — i.e. only after a valid OTP code is consumed. An attacker cannot trigger the scan without first guessing a 6-digit code (1 in 1M per attempt). The 400 early-return for invalid codes (line 77-79) closes the enumeration vector — confirmed by negative test #4. **Acceptable as-is; recommend a normalized `phoneNormalized` column + unique index when the schema can be migrated.** |
| **H-2** | SQL timing oracle (OTP verify / admin login) | ⚠️ Partially mitigated | **Low** (down from Medium) | OTP verify: the `consumed.count === 0` early-return (line 77) makes response timing uniform for all invalid-code attempts regardless of phone existence — confirmed identical 400 response for known vs unknown phone in negative test #4. Admin login: M-04b fix (DUMMY_HASH bcrypt compare at `admin-panel/auth/login/route.ts:67-69`) makes user-not-found and wrong-password take identical time. **No residual timing oracle found.** The prior H-2 concern is closed by M-04b + the OTP early-return. |
| **M-1** | service-write facade dead code | ✅ Still dead | **Low** (unchanged) | `grep -rn "createService|transitionJob|transitionBooking" src/app/api/` → **0 matches**. `src/lib/service-write.ts` (375 lines) is imported by NO route. Accepted-risk still valid — dead code, no runtime impact. Recommend deletion or an explicit `@deprecated` JSDoc + lint rule. |
| **M-2** | service-unified facade | ⚠️ NOT dead | N/A | `src/lib/service-unified.ts` IS used by `/api/services/route.ts:22,47,51` and `/api/services/[id]/route.ts:26,37`. It is a READ-SIDE facade (getServicesForUser / getServiceById / getServiceStats) with proper BOLA checks in `/api/services/[id]/route.ts:51-67`. **Not a finding.** The prior "dead code" label may have been about service-write.ts (M-1); service-unified is alive and safe. |
| **L-2** | X-Forwarded-For trust in rate-limit / IP extraction | ✅ Still present | **Low** in prod / **Medium** in dev | `src/lib/rate-limit.ts:29-33` getClientId prefers `x-forwarded-for` (first hop), falls back to `x-real-ip`, then literal `"anonymous"`. `src/lib/auth.ts:85-90` getIpFromRequest same pattern. Does NOT read `cf-connecting-ip`. In production on Cloudflare: `x-forwarded-for` IS set by Cloudflare, but a direct-origin request (bypassing CF) could spoof it. In dev (no proxy): trivially spoofable — `X-Forwarded-For: 1.2.3.4` per request = unlimited rate-limit budget. **Recommend:** prefer `cf-connecting-ip` header; fall back to UA-hash instead of literal `"anonymous"`. |

---

## 4. Per-Area Findings

### 4.1 Authentication (authn)

**Strengths:**
- Session JWT is HttpOnly + Secure (prod) + SameSite=Lax cookie (`src/app/api/auth/otp/verify/route.ts:156-162`). JWT is NEVER returned in the JSON body.
- Session DB table with `tokenHash` (SHA-256) enables real revocation. `verifySession` is fail-closed in production (`src/lib/auth.ts:174-176`).
- OTP codes are CSPRNG-generated (`crypto.randomInt(100000, 1000000)`) and SHA-256 hashed before storage (`src/lib/otp-crypto.ts`).
- Logout endpoint (`src/app/api/auth/logout/route.ts`) marks session revoked + clears cookie.

**Findings:** none new. (SEC-21 below is an authz gap, not authn.)

### 4.2 Authorization / BOLA / IDOR

**Strengths (verified by negative tests #1-#2):**
- 7 BOLA helpers in `src/lib/auth.ts`: `requireVehicleOwner`, `requireJobParticipant`, `requireNotificationOwner`, `requireWalletOwner`, `requireTicketOwner`, `requirePolicyOwner`, `requireAuth` — each checks `resource.userId === session.userId` (or equivalent) and returns 403 on mismatch.
- 3 CARE-specific helpers in `src/lib/care-auth.ts`: `requireBookingParticipant`, `requireAssignedTechnician`, `requireBookingOwner` — correctly distinguish `ServiceBooking.userId` (User.id) from `ServiceBooking.technicianId` (Technician.id).
- All `[id]` routes tested (`/api/jobs/[id]`, `/api/invoices`, `/api/vehicles/[id]`, `/api/jobs/[id]/status`) correctly call the BOLA helper BEFORE the DB read/write — confirmed by `mockInvoiceFindUnique not called` assertions in tests.

**Findings:** none new in BOLA — the prior SEC-11 fix (timeline BOLA) is present and correct. The negative tests prove Customer A → Customer B and Technician A → Technician B are rejected with 403.

### 4.3 Role control / function-level authz

**Strengths:**
- `requireRole(session, "ADMIN")` applied to: `/api/care/admin/packages` (line 10-11, 20-21), `/api/care/admin/rules` (line 10-11, 20-21), `/api/mechanic-applications` GET (line 10-11), `/api/mechanic-applications/[id]/approve` (line 31-32), `/api/mechanic-applications/[id]/reject` (line 15-16), `/api/technicians` POST (line 75-76).
- `getAdminFromRequest` applied to all `/api/admin/*` and `/api/admin-panel/*` routes.

**Findings:**
- **SEC-21 (CRITICAL)** — see §6 findings table. Admin auth bypassable via user JWT in production.
- **SEC-19 (LOW, prior)** — no admin role hierarchy; `requireRole(session, "ADMIN")` accepts the literal string "ADMIN" or "SUPER_ADMIN" but doesn't enforce a hierarchy. Latent risk if a lower-privileged admin role is added. Still present.

### 4.4 Mass assignment

**Strengths:**
- `sanitizeInput()` + `ALLOWED_FIELDS` whitelists + `FORBIDDEN_FIELDS` denylist (`src/lib/auth.ts:376-405`) applied consistently.
- Per-resource whitelists in `/api/admin/[resource]/[id]/route.ts:8-19` (technicians, customers, categories, reviews, payments).
- Zod schemas validate vehicle create (`src/lib/schemas/vehicle.ts`), care booking (`src/lib/schemas/care.ts`), OTP send/verify (`src/lib/schemas/auth.ts`).
- `BLOCKED_FOR_SELF` in `/api/technicians/[id]/route.ts:80-90` strips `verified`, `rating`, `reviewCount`, `completedJobs`, `level`, `status` even for admins editing via the non-admin route.

**Findings:** none new. Mass-assignment posture is solid.

### 4.5 Input validation

**Strengths:**
- `validateBody(req, schema)` used by OTP send/verify, vehicle create, care booking.
- All string fields from client bodies are `.slice(0, N)` capped (vehicles, tickets, insurance, maintenance, mechanic applications, onboarding slides).
- Numeric inputs type-checked (`typeof body.amount === "number"`, `typeof body.quantity === "number"`).
- No `$queryRaw` with user input — only `SELECT 1` in health/ready routes (`src/app/api/health/route.ts:18`, `src/app/api/ready/route.ts:13`).

**Findings:**
- **SEC-24 (LOW)** — `src/app/api/admin-panel/auth/login/route.ts:36` does `const { emailOrUsername, password } = await req.json();` with no try/catch and no Zod schema. A non-JSON body throws → 500 (not 400). The `adminLoginSchema` exists in `src/lib/schemas/auth.ts:70-73` but is NOT imported by the route. Minor inconsistency, not a security vulnerability.

### 4.6 Information disclosure

**Findings:**
- **SEC-22 (MEDIUM)** — `src/app/api/technicians/route.ts:13-24` (public LIST, NO auth) includes `phone: true` in `PUBLIC_USER_FIELDS` (line 16). Anyone can `GET /api/technicians` and harvest every verified technician's phone number. This contradicts the M-03 fix on `/api/technicians/[id]` (which correctly omits phone). **Repro:** `curl http://localhost:3000/api/technicians` → response includes `user.phone` for every technician. **Fix:** remove `phone: true` from the LIST route's `PUBLIC_USER_FIELDS` (match the `[id]` route).
- **SEC-23 (MEDIUM, prior SEC-12)** — `src/app/api/dashboard/route.ts:77-109` still returns `techPerformance` (every technician's name + revenue + rating) and `recentActivity` (customer + technician names per recent job) to ANY authenticated user. No `requireRole(session, "ADMIN")`. The route comment (line 7) claims "Customer/Technician see aggregate stats (no PII)" but the response DOES contain PII. **Still unfixed.** Severity Medium — business intelligence + cross-tenant name disclosure.
- **SEC-14 (MEDIUM, prior)** — admin JWT in localStorage, XSS-exfiltratable. Still present (`src/app/api/admin-panel/auth/login/route.ts:111-114` returns token in body; frontend stores in localStorage). Not a backend fix — frontend concern.
- **SEC-15 (MEDIUM, prior)** — admin JWT irrevocable for 7 days, no AdminSession table. Still present (`src/lib/admin-auth.ts:44-55` `verifyAdminToken` only checks JWT signature + expiry). Latent risk — a compromised admin token cannot be revoked server-side.
- **SEC-17 (LOW, prior)** — `src/lib/admin-auth.ts:8` reads `JWT_SECRET` at module level (`const JWT_SECRET = process.env.JWT_SECRET;`). The user-side `auth.ts:33-43` was fixed to read inside the function body, but admin-auth.ts was NOT. This is the ROOT CAUSE of SEC-21 (the module-level const captures the value at import time, and in production both user + admin secrets resolve to the same `process.env.JWT_SECRET`).

### 4.7 OTP & session

**Strengths:**
- OTP rate limit: 5/10min per phone + 20/hour per IP (send), 5/min per IP (verify) — all via `rateLimitAsync` (atomic, RL-01 fix).
- OTP code hashed (SHA-256) before storage; plaintext never persisted.
- OTP code invalidated on send (line 77 of otp/send/route.ts: `updateMany({ where: { phone, consumed: false }, data: { consumed: true } })`).
- OTP verify uses atomic `updateMany` with `consumed: false` + `expiresAt: { gt: now }` (SEC-10 fix) — closes the replay race.
- Session token is HttpOnly cookie; never in JSON body.
- `verifySession` fail-closed in production (DB error → null).
- `createSession` fail-closed in production (DB error → throws).

**Findings:**
- **H-1 (Medium, accepted-risk)** — O(n) user scan in OTP verify (line 89-108). Mitigated by early-return on invalid code. Acceptable.
- **SEC-20 (LOW, prior)** — `sameSite: "lax"` cookie. No state-changing GET endpoints exist today, but no lint rule prevents adding one. Latent CSRF risk.

### 4.8 Rate limiting

**Strengths:**
- `rateLimitAsync` (RL-01 fix) uses atomic `updateMany` with `count: { lt: max }` + `expiresAt: { gt: now }` — true atomic SQL increment.
- Applied to: OTP send (phone + IP), OTP verify (IP), payments (client), withdraw (client), admin login (IP), and the default 60/min API limit (via `requireAuth`).
- Fail-open on admin login (line 49-51) — better to risk brute-force than lock admin out.

**Findings:**
- **L-2 (Low/Medium, accepted-risk)** — `getClientId` trusts `x-forwarded-for` (first hop) without preferring `cf-connecting-ip`. Spoofable in dev; edge-case in prod.

---

## 5. Negative Test Results

Test file: `tests/unit/security-audit-negative.test.ts` (13 tests, all PASS)

| # | Test name | Expected | Actual | Result | Finding ID |
|---|-----------|----------|--------|--------|------------|
| 1 | rejects Customer A reading Customer B's job (GET /api/jobs/[id]) | 403 | 403 | ✅ PASS | — |
| 2 | rejects Customer A reading Customer B's invoice (GET /api/invoices?jobId=) | 403 | 403 | ✅ PASS | — |
| 3 | rejects Customer A editing Customer B's vehicle (PATCH /api/vehicles/[id]) | 403 | 403 | ✅ PASS | — |
| 4 | rejects Technician A from PATCHing Technician B's job (PATCH /api/jobs/[id]/status) | 403 | 403 | ✅ PASS | — |
| 5 | rejects unauthenticated GET /api/admin/[resource] | 401 | 401 | ✅ PASS | — |
| 6 | rejects user-JWT GET /api/admin/[resource] (dev mode) | 401 | 401 | ✅ PASS | (SEC-21 latent in prod — see §6) |
| 7 | rejects CUSTOMER GET /api/care/admin/packages | 403 | 403 | ✅ PASS | — |
| 8 | rejects CUSTOMER POST /api/mechanic-applications/[id]/approve | 403 | 403 | ✅ PASS | — |
| 9 | OTP verify returns 400 for KNOWN phone + wrong code | 400 "Invalid or expired code" | 400 "Invalid or expired code" | ✅ PASS | — |
| 10 | OTP verify returns 400 for UNKNOWN phone + wrong code | 400 "Invalid or expired code" | 400 "Invalid or expired code" | ✅ PASS | — |
| 11 | OTP verify known-vs-unknown responses are byte-identical | same status + same `error` key + same message | identical | ✅ PASS | — |
| 12 | rejects POST /api/wallets/withdraw with no Authorization header | 401 | 401 | ✅ PASS | — |
| 13 | rejects POST /api/wallets/withdraw with malformed (Basic) Authorization | 401 | 401 | ✅ PASS | — |

**Interpretation:** All 13 negative tests PASS — meaning every BOLA / authz / authn / enumeration gate tested actually REJECTS the attack as designed. No real BOLA was uncovered by the negative tests. The one CRITICAL (SEC-21) was found by static analysis (not by a runtime test) because it only manifests in production-mode secrets, which vitest's dev-mode environment cannot reproduce without complex `vi.resetModules()` + `vi.stubEnv` choreography around the module-level `const JWT_SECRET` in `admin-auth.ts:8`.

**Full suite status:** `bun run test` → **415 passed | 1 expected fail (pre-existing) | 0 unexpected failures.** The new test file adds 13 tests; no existing tests were modified or broken.

---

## 6. Findings Table

| ID | File:Line | Severity | Description | Repro | Status | Fix |
|----|-----------|----------|-------------|-------|--------|-----|
| **SEC-21** | `src/lib/admin-auth.ts:8,44-55` + `src/app/api/admin/[resource]/route.ts:68-69` | **CRITICAL** | Admin auth bypass via user JWT in production. `admin-auth.ts:8` reads `JWT_SECRET` at module level (SEC-17). In production, `getAdminSecret()` and user-side `getSecret()` both return `process.env.JWT_SECRET` — the SAME secret. A user JWT (signed by `/api/auth/otp/verify`) passes `verifyAdminToken`'s `jwtVerify`. `verifyAdminToken` returns `{adminId: undefined, username: undefined, role: "CUSTOMER"}` (from user JWT payload) — truthy, so `if (!adminSession)` passes. Any authenticated CUSTOMER can then call `/api/admin/*` routes. | **Static proof:** `admin-auth.ts:8` `const JWT_SECRET = process.env.JWT_SECRET;` (module-level). `auth.ts:34` `const secret = process.env.JWT_SECRET;` (function-level). In production both resolve to the same value. `verifyAdminToken` (line 44-55) only catches `jwtVerify` errors, not missing-payload-field errors. **Dev-mode test (#6) PASSES** because dev secrets differ (`mekanix-dev-secret-change-in-production` vs `mekanix-admin-dev-secret-change-me`) — so the bypass is NOT reproducible in vitest without production env + module reload. **Production repro:** (1) register via OTP, (2) `curl -H "Authorization: Bearer <user-jwt>" http://app/api/admin/customers` → 200 with full customer list. | **OPEN — release blocker** | (a) Move `JWT_SECRET` read inside `getAdminSecret()` function body (mirror the user-side fix in `auth.ts:33-43`). (b) Validate the decoded payload shape in `verifyAdminToken`: require `adminId` and `username` to be non-empty strings AND `role` to be `"ADMIN"` or `"SUPER_ADMIN"`; return null otherwise. (c) Use a SEPARATE signing secret for admin tokens (`ADMIN_JWT_SECRET`) so user and admin token domains are cryptographically isolated. (d) Add an `AdminSession` table (SEC-15 fix) so admin tokens are revocable. |
| **SEC-22** | `src/app/api/technicians/route.ts:16` | MEDIUM | Public technician LIST endpoint (no auth) exposes `phone` in `PUBLIC_USER_FIELDS`. Contradicts M-03 fix on `/api/technicians/[id]`. | `curl http://localhost:3000/api/technicians` → each record's `user.phone` is present. An attacker scrapes the directory and harvests every verified technician's phone number. | **OPEN** | Remove `phone: true` from the `PUBLIC_USER_FIELDS` const at `src/app/api/technicians/route.ts:16` (match the `[id]` route's `PUBLIC_USER_FIELDS` at `src/app/api/technicians/[id]/route.ts:7-17` which correctly omits phone). |
| **SEC-23** | `src/app/api/dashboard/route.ts:8-129` | MEDIUM | Dashboard route requires auth but NO role check. Returns `techPerformance` (every technician's name + revenue + rating) and `recentActivity` (customer + technician names per recent job) to ANY authenticated user. Prior SEC-12 — still unfixed. | (1) Register via OTP. (2) `GET /api/dashboard` with the user cookie. (3) Response contains `techPerformance[]` with `{name, jobs, rating, revenue}` for every technician + `recentActivity[]` with `sub: "TechName → CustomerName"`. | **OPEN (prior SEC-12)** | Add `requireRole(session, "ADMIN")` after `requireAuth` (line 10). OR scope the response by role: ADMIN sees full dashboard; CUSTOMER/TECHNICIAN see only their own KPIs. |
| **SEC-14** | `src/app/api/admin-panel/auth/login/route.ts:111-114` | MEDIUM | Admin JWT returned in JSON body; frontend stores in localStorage (XSS-exfiltratable). Prior SEC-14 — still present. | (1) Login as admin. (2) Inspect response body — `token` field present. (3) Frontend `src/app/admin-panel/page.tsx` stores it in `localStorage.getItem("admin_token")`. Any XSS in admin-editable content (technician bio, category name) can exfiltrate it. | **OPEN (prior SEC-14)** | Use HttpOnly cookie for admin token (mirror user auth). If frontend needs the token in JS, mint a short-lived (5min) nonce. |
| **SEC-15** | `src/lib/admin-auth.ts:44-55` | MEDIUM | Admin JWT irrevocable for 7 days. `verifyAdminToken` only checks JWT signature + expiry — no DB revocation check. Prior SEC-15 — still present. | (1) Admin logs in → gets 7d token. (2) Admin "logout" (frontend only clears localStorage). (3) Old token still valid for 7 days. Even password change doesn't invalidate it. | **OPEN (prior SEC-15)** | Add `AdminSession` table mirroring `Session`; persist `tokenHash` on login; check revocation in `verifyAdminToken`. Add `POST /api/admin-panel/auth/logout`. |
| **SEC-17** | `src/lib/admin-auth.ts:8` | LOW | `const JWT_SECRET = process.env.JWT_SECRET;` read at module level. Inconsistent with user-side `auth.ts:33-43` (which reads inside the function body). This is the ROOT CAUSE of SEC-21 — if the secret were read inside the function, the production-mode bypass would still exist (same secret) BUT the module-load-time capture is an additional Workers/OpenNext hazard (env may be undefined at module eval). | Static: `admin-auth.ts:8` vs `auth.ts:34`. | **OPEN (prior SEC-17)** | Move read inside `getAdminSecret()` function body (mirror `auth.ts:33-43`). |
| **SEC-24** | `src/app/api/admin-panel/auth/login/route.ts:36` | LOW | Admin login route doesn't use `validateBody` / `adminLoginSchema`. `const { emailOrUsername, password } = await req.json();` — throws on non-JSON body (500 instead of 400). The `adminLoginSchema` exists in `src/lib/schemas/auth.ts:70-73` but is unused. | `curl -X POST http://localhost:3000/api/admin-panel/auth/login -H "Content-Type: application/json" -d "not json"` → 500 (not 400). | **OPEN** | Replace inline `await req.json()` with `validateBody(req, adminLoginSchema)`. |
| **SEC-18** | `src/app/api/admin-panel/auth/login/route.ts:35` | LOW | `ensureDefaultAdmin()` called on every login POST → `db.adminUser.count()` DB round-trip per request. Prior SEC-18 — DoS amplifier. Still present. | Flood `/api/admin-panel/auth/login` with empty bodies → each triggers a `count()` query. | **OPEN (prior SEC-18)** | Cache the result with a long TTL (`adminCheckDone` flag) or move to a startup hook. |
| **SEC-19** | `src/lib/admin-auth.ts:22-26` | LOW | `AdminSession.role` is a free-form string. No hierarchy enforcement. `requireRole(session, "ADMIN")` accepts the literal string. Latent privilege-escalation if a lower-privileged admin role is added. Prior SEC-19 — still present. | Static: `admin-auth.ts:25` `role: string`. | **OPEN (prior SEC-19)** | Define a strict role union + `requireSuperAdmin` helper. |
| **SEC-20** | `src/app/api/auth/otp/verify/route.ts:159` | LOW | Cookie `sameSite: "lax"` allows top-level GET navigations from external sites. No state-changing GET endpoints today, but no lint rule prevents adding one. Prior SEC-20 — still present. | Static: `otp/verify/route.ts:159` `sameSite: "lax"`. | **OPEN (prior SEC-20)** | Add a lint rule that flags any `export async function GET` in `src/app/api/` that calls `db.*.update*` / `create` / `delete`. |
| **H-1** | `src/app/api/auth/otp/verify/route.ts:89-108` | MEDIUM (accepted) | OTP verify O(n) user scan. Loads ALL users to match digit-stripped phone. | Static + negative test confirms it's only reached after valid OTP consume. | **ACCEPTED** | Add a `phoneNormalized` column + unique index when schema can be migrated. |
| **L-2** | `src/lib/rate-limit.ts:29-33` + `src/lib/auth.ts:85-90` | LOW/MEDIUM (accepted) | `getClientId` trusts `x-forwarded-for` (first hop), no `cf-connecting-ip`. | Dev: `X-Forwarded-For: 1.2.3.4` per request = unlimited budget. | **ACCEPTED** | Prefer `cf-connecting-ip`; fall back to UA-hash not literal `"anonymous"`. |
| **M-1** | `src/lib/service-write.ts` (375 lines) | LOW (accepted) | Dead code — no route imports `createService` / `transitionJob` / `transitionBooking`. | `grep -rn "createService\|transitionJob\|transitionBooking" src/app/api/` → 0 matches. | **ACCEPTED** | Delete the file OR add `@deprecated` + lint rule. |

---

## 7. Critical / High Blockers for Release

### 🔴 CRITICAL (1 — release blocker)

1. **SEC-21** — Admin auth bypass via user JWT in production.
   - **Exploit:** Any authenticated user (CUSTOMER / TECHNICIAN / PARTNER) can call `/api/admin/*` and `/api/admin-panel/*` routes by sending their user JWT as a Bearer token. In production, `verifyAdminToken` accepts it because (a) the signing secret is the same `process.env.JWT_SECRET` as user JWTs, and (b) the returned `AdminSession` object has `adminId: undefined` / `username: undefined` / `role: "CUSTOMER"` but is truthy, so the `if (!adminSession)` gate passes.
   - **Impact:** Full admin API access — read all customers, technicians, payments, jobs; mutate any resource via `/api/admin/[resource]/[id]`; approve mechanic applications (privilege escalation to TECHNICIAN); ban users; refund payments.
   - **NOT exploitable in dev** (secrets differ) — which is why prior dev-mode testing didn't catch it.
   - **Required fix before merge:** (a) validate payload shape in `verifyAdminToken` (require `adminId`, `username` non-empty + `role ∈ {ADMIN, SUPER_ADMIN}`); (b) use a separate `ADMIN_JWT_SECRET`; (c) move `JWT_SECRET` read inside `getAdminSecret()` (fixes SEC-17 too); (d) add `AdminSession` table for revocation (fixes SEC-15 too).

### 🟠 HIGH (0)

No High findings. The prior HIGH findings (SEC-8 wallet doubling, SEC-9 withdraw race, SEC-10 OTP replay, SEC-11 timeline BOLA) are all VERIFIED FIXED in the current code:
- SEC-8 → `src/app/api/wallets/route.ts:65-77` conditional `updateMany` + count check ✅
- SEC-9 → `src/app/api/wallets/withdraw/route.ts:82-90` atomic `decrement` + count check; B2.2 moves decrement before WithdrawalRequest.create (no orphans) ✅
- SEC-10 → `src/app/api/auth/otp/verify/route.ts:67-79` atomic `updateMany` with `consumed: false` + `expiresAt: { gt: now }` ✅
- SEC-11 → `src/app/api/care/bookings/[id]/timeline/route.ts:15-16` `requireBookingParticipant` call ✅

---

## 8. Methodology Notes

1. Read `docs/PHASE3_SECURITY_AUDIT_V2.md` (1012 lines) + `docs/SECURITY_REVIEW.md` for prior findings baseline.
2. Verified each prior fix by reading the CURRENT source on the working tree (not the prior audit's code excerpts).
3. Audited every route file under `src/app/api/` (71 files, ~140 handler functions) end-to-end.
4. Read every auth helper: `src/lib/auth.ts` (504 lines), `src/lib/admin-auth.ts` (117 lines), `src/lib/care-auth.ts` (276 lines), `src/lib/permissions.ts` (191 lines), `src/lib/api-helpers.ts` (61 lines), `src/lib/rate-limit.ts` (119 lines), `src/lib/otp-crypto.ts` (20 lines).
5. Wrote 13 negative tests in `tests/unit/security-audit-negative.test.ts` mirroring the `tests/unit/wallets-withdraw.test.ts` pattern: real JWTs minted via `createSession`, real authz helpers running unmocked, only DB + rate-limit mocked at the boundary.
6. Ran `bun run test` — full suite (22 test files, 416 tests) passes including the 13 new tests.
7. NO source files modified except the single additive test file. NO migrations, NO deploys, NO pushes. The 29 modified UI files were not touched.

---

## 9. Constraints Status

| Constraint | Status |
|-----------|--------|
| READ-ONLY on all source EXCEPT the new test file | ✅ Only `tests/unit/security-audit-negative.test.ts` created |
| Do not touch the 29 modified files | ✅ Verified — no edits to docs/*.md, public/*, src/components/mek/accent-theme-provider.tsx, or tests/unit/*.ts (existing) |
| Do not push, deploy, or run remote migrations | ✅ None performed |
| Do not print secrets | ✅ No secrets printed; dev-mode fallback secrets referenced in code comments only |
| Do not create real users or real OTPs against live SMS | ✅ All tests use mocked DB + console SMS provider; no real SMS sent |
| Dev server on :3000 untouched | ✅ Not killed; tests run via vitest, not against :3000 |
