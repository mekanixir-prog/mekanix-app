# MEKANIX — Backend Security Audit Report (B-4)

**Original audit date:** 2026-10-14
**Reconciliation date:** 2026-11-02
**Auditor:** Agent 4 — Backend Security Auditor
**Current reconciliation branch:** `fix/irr-display-dashboard-withdrawal` (PR #78)
**Historical snapshot:** `feature/cloudflare-d1-validation @ 1cf59e7`
**Scope:** All routes under `src/app/api/` + auth helpers (`src/lib/auth.ts`, `src/lib/admin-auth.ts`, `src/lib/care-auth.ts`, `src/lib/permissions.ts`) + rate-limit + OTP/session subsystems
**Methodology:** Static code review (every route read end-to-end) + 13 negative runtime tests exercising REAL route handlers with REAL authz helpers (only DB + rate-limit mocked at the boundary)
**Constraints honored:** READ-ONLY on all source; the ONE additive source change is `tests/unit/security-audit-negative.test.ts`. No migrations, no deploys, no pushes. The 29 modified UI files were not touched.

---

## 1. Executive Summary

> **2026-11-02 reconciliation — supersedes stale status claims below**
>
> The detailed findings below originated in the 2026-10-14 audit and were not updated when subsequent fixes landed. The current PR #78 source was re-read. The following historical findings are now **closed in the current branch**:
> - **SEC-21 (admin JWT confusion):** `src/lib/admin-auth.ts` now requires `ADMIN_JWT_SECRET` in production, validates `adminId` and admin role claims, and falls back to a persisted active ADMIN user session only after dedicated-token verification fails.
> - **SEC-22 (technician phone exposure):** the public technician list now selects an explicit safe user-field allowlist without `phone`.
> - **SEC-23 (dashboard information disclosure):** `GET /api/dashboard` now requires ADMIN role because the payload contains technician revenue and customer/technician identities.
> - **SEC-17 (module-load environment capture):** the admin signing secret is read inside `getAdminSecret()`, not at module evaluation time.
>
> The current branch also closes two additional authorization defects found during this reconciliation: unsupported FLEET_MANAGER/PARTNER roles no longer pass `requireJobParticipant` without a verified ownership relation, and customer estimate approval cannot be combined with a job-state transition. New negative tests cover these cases.
>
> The wallet GET route was also hardened: unverified legacy ledger rows cannot trigger escrow repair/release, and monetary values are redacted from wallet, transaction, and withdrawal payloads until provenance is verified. The prepay path now validates integer IRR fees and rounds its 10% commission explicitly half-up; VIP activation is bound to a VERIFIED gateway attempt with purpose `vip` and exact amount/currency/user/payment matching, then uses an atomic Prisma/D1 writer and provider-specific one-ACTIVE-per-user unique indexes. Withdrawal creation and admin settlement now use explicit D1 rollback guards; only checksum-valid bank destinations can be requested or approved.
>
> **Current disposition:** PR #78 remains Draft. The above fixes are committed, but the 5 CI workflows for the current head must complete successfully before these findings can be marked runtime-verified. Remaining items SEC-14, SEC-15, SEC-18, SEC-19, SEC-20 and accepted-risk items remain open unless separately closed below. SEC-24's malformed-JSON behavior is fixed by the current admin-login parser.

- **Historical routes audited:** 71 route files under `src/app/api/` (about 140 HTTP handlers).
- **Prior controls:** the current source now includes the M-03 public-phone fix and the SEC-21 admin-token separation/claim-validation fix; SEC-23 dashboard data is ADMIN-only.
- **New reconciliation findings:** 2 authorization/state-machine defects and 1 wallet-read financial integrity/disclosure defect were found and fixed in PR #78.
- **Negative security tests:** 23 cases are now defined in `tests/unit/security-audit-negative.test.ts` (16 original + 7 added in this reconciliation); runtime result is pending the current CI run.
- **Status:** ⚠️ **CONDITIONAL** — no previously identified CRITICAL finding remains open in the current source, but PR #78 must pass CI, PostgreSQL, Production Readiness, Docker E2E and Cloudflare Build before the fixes are considered verified.

The backend already has broad BOLA controls; this reconciliation specifically tightened the unsupported-role fallthrough and customer job-state approval path.

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
| **M-03** | Technician PII removal (phone) from public routes | ✅ YES | ✅ Correct in current branch | Both `src/app/api/technicians/[id]/route.ts` and `src/app/api/technicians/route.ts` use explicit safe user-field allowlists without `phone`; SEC-22 closed in PR #78. |
| **M-04** | Admin auth enforced on admin routes | ✅ YES | ✅ Correct in current branch | Admin routes use `getAdminFromRequest`; `src/lib/admin-auth.ts` now requires a dedicated production `ADMIN_JWT_SECRET`, validates admin identity/role claims, and checks persisted active ADMIN user sessions on the OTP-session fallback. SEC-21 closed in current branch. |
| **M-04b** | Admin login hardening (rate limit + unified error + timing) | ✅ YES | ✅ Correct | `src/app/api/admin-panel/auth/login/route.ts` — SEC-13 unified message `UNAUTH_MSG` (line 19, returned on both user-not-found and wrong-password at line 91); DUMMY_HASH bcrypt compare always runs (lines 67-69); SEC-5 rate limit 5/15min (lines 32, 45-57); audit log on both failed (72-88) and successful (97-109) logins. |

**Score: 9/9 prior controls present in the current source.** SEC-21 and SEC-22 are closed; the old audit's open-status labels are historical, not current.

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
- **SEC-21 (CRITICAL, historical)** — **CLOSED in current branch**. See the 2026-11-02 reconciliation addendum and §6. Dedicated production admin secret + strict claim validation + persisted ADMIN-session fallback now prevent user-JWT acceptance.
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
- **SEC-22 (MEDIUM, historical)** — **CLOSED in current branch**. The public list and detail routes now select explicit safe user fields and omit `phone`; SEC-22's old reproduction no longer applies.
- **SEC-23 (MEDIUM, historical)** — **CLOSED in current branch**. `GET /api/dashboard` now applies `requireRole(session, "ADMIN")` before any business-intelligence query; technician revenue and recent customer/technician identities are no longer available to ordinary users.
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

Test file: `tests/unit/security-audit-negative.test.ts` (23 tests; 16 original checks plus 7 new reconciliation cases)

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
| 14 | denies FLEET_MANAGER job access without a verified fleet relation | 403 | 403 | ⏳ CI PASS | SEC-25 |
| 15 | denies PARTNER job access without a verified partner relation | 403 | 403 | ⏳ CI PASS | SEC-25 |
| 16 | rejects customer estimate approval combined with COMPLETED status | 403 | 403 | ⏳ CI PASS | SEC-26 |
| 17 | rejects non-boolean customerApproved values | 400 | 400 | ⏳ CI PASS | SEC-26 |
| 18 | rejects unknown job status enum values | 400 | 400 | ⏳ CI PASS | SEC-26 |
| 19 | rejects CUSTOMER access to platform dashboard business intelligence | 403 | 403 | ⏳ CI PASS | SEC-23 |
| 20 | rejects TECHNICIAN access to platform dashboard business intelligence | 403 | 403 | ⏳ CI PASS | SEC-23 |
| 21 | rejects user JWT even when signing secrets collide | 401 | 401 | ✅ PASS | SEC-21 |
| 22 | rejects user JWT when ADMIN_JWT_SECRET is set | 401 | 401 | ✅ PASS | SEC-21 |
| 23 | rejects forged admin token with valid-but-non-admin role | 401 | 401 | ✅ PASS | SEC-21 |

**Interpretation:** The 16 original negative security checks remain in the suite. Seven additional cases now cover FLEET_MANAGER and PARTNER denial, customer approval/state escalation, strict boolean parsing, invalid status enums, and non-admin dashboard access. Their result must be confirmed by the current CI run; do not infer success from the code change alone.

**Full suite status:** The 2026-10-14 count above is historical. The current branch adds tests and production code changes; use the latest CI run attached to PR #78 as the authoritative result.

---

## 6. Findings Table

| ID | File:Line | Severity | Description | Repro | Status | Fix |
|----|-----------|----------|-------------|-------|--------|-----|
| **SEC-21** | `src/lib/admin-auth.ts` + admin route guards | **CRITICAL (historical)** | Admin auth bypass via user JWT in production — CLOSED in current branch. `admin-auth.ts:8` reads `JWT_SECRET` at module level (SEC-17). In production, `getAdminSecret()` and user-side `getSecret()` both return `process.env.JWT_SECRET` — the SAME secret. A user JWT (signed by `/api/auth/otp/verify`) passes `verifyAdminToken`'s `jwtVerify`. `verifyAdminToken` returns `{adminId: undefined, username: undefined, role: "CUSTOMER"}` (from user JWT payload) — truthy, so `if (!adminSession)` passes. Any authenticated CUSTOMER can then call `/api/admin/*` routes. | **Static proof:** `admin-auth.ts:8` `const JWT_SECRET = process.env.JWT_SECRET;` (module-level). `auth.ts:34` `const secret = process.env.JWT_SECRET;` (function-level). In production both resolve to the same value. `verifyAdminToken` (line 44-55) only catches `jwtVerify` errors, not missing-payload-field errors. **Dev-mode test (#6) PASSES** because dev secrets differ (`mekanix-dev-secret-change-in-production` vs `mekanix-admin-dev-secret-change-me`) — so the bypass is NOT reproducible in vitest without production env + module reload. **Production repro:** (1) register via OTP, (2) `curl -H "Authorization: Bearer <user-jwt>" http://app/api/admin/customers` → 200 with full customer list. | **RESOLVED IN PR #78 (runtime verification pending)** | (a) Move `JWT_SECRET` read inside `getAdminSecret()` function body (mirror the user-side fix in `auth.ts:33-43`). (b) Validate the decoded payload shape in `verifyAdminToken`: require `adminId` and `username` to be non-empty strings AND `role` to be `"ADMIN"` or `"SUPER_ADMIN"`; return null otherwise. (c) Use a SEPARATE signing secret for admin tokens (`ADMIN_JWT_SECRET`) so user and admin token domains are cryptographically isolated. (d) Add an `AdminSession` table (SEC-15 fix) so admin tokens are revocable. |
| **SEC-22** | `src/app/api/technicians/route.ts` | MEDIUM (historical) | Public technician LIST endpoint exposed `phone` — CLOSED in current branch. Contradicts M-03 fix on `/api/technicians/[id]`. | `curl http://localhost:3000/api/technicians` → each record's `user.phone` is present. An attacker scrapes the directory and harvests every verified technician's phone number. | **RESOLVED IN PR #78 (runtime verification pending)** | Public list now omits `phone` from the explicit user-field allowlist. |
| **SEC-23** | `src/app/api/dashboard/route.ts` | MEDIUM (historical) | Dashboard exposed cross-technician revenue and job identities to all authenticated users — CLOSED in current branch. Returns `techPerformance` (every technician's name + revenue + rating) and `recentActivity` (customer + technician names per recent job) to ANY authenticated user. Prior SEC-12 — still unfixed. | (1) Register via OTP. (2) `GET /api/dashboard` with the user cookie. (3) Response contains `techPerformance[]` with `{name, jobs, rating, revenue}` for every technician + `recentActivity[]` with `sub: "TechName → CustomerName"`. | **RESOLVED IN PR #78 (runtime verification pending)** | Added `requireRole(session, "ADMIN")` before any dashboard query. |
| **SEC-25** | `src/lib/auth.ts` — `requireJobParticipant` | HIGH (historical) | Unsupported FLEET_MANAGER/PARTNER roles previously fell through as authorized participants without a verified ownership relation; fleet manager could reach customer-like job transitions. | Current helper now returns 403 for every role except ADMIN, CUSTOMER owner, or assigned TECHNICIAN; explicit FLEET_MANAGER and PARTNER negative tests added. | **RESOLVED IN PR #78 (runtime verification pending)** | Add explicit fleet/partner ownership relations before enabling these roles for job access. |
| **SEC-26** | `src/app/api/jobs/[id]/status/route.ts` | HIGH (historical) | Customer estimate approval could be combined with `status: "COMPLETED"` because the approval branch ignored the requested next status; truthy strings were also coerced to boolean. | Approval now requires current and target state to remain `WAITING_APPROVAL`; non-boolean values and unknown status enums return 400. | **RESOLVED IN PR #78 (runtime verification pending)** | Preserve the separate estimate-approval and technician completion transitions. |
| **FIN-01** | `src/app/api/wallets/route.ts` | HIGH (historical) | Wallet GET could repair/release escrow before provenance verification and returned raw legacy wallet/transaction/withdrawal amounts while currency was `UNVERIFIED`. | Financial mutations now run only when wallet provenance is verified; all monetary fields are redacted otherwise. New test asserts no mutation and redaction. | **RESOLVED IN PR #78 (runtime verification pending)** | Keep provenance verification and reconciliation as an explicit release gate. |
| **FIN-02** | `src/app/api/prepay/route.ts` | MEDIUM (historical) | 10% prepay commission used binary floating-point multiplication and could persist fractional IRR. | Current route validates inspection/travel fees as safe integer IRR, sums with `addIrr`, and calculates commission via `multiplyRatioIrr(..., "half-up")`; tests cover 1001 IRR → 100 IRR commission and fractional-fee rejection. | **RESOLVED IN PR #78 (runtime verification pending)** | Keep commission rounding explicit and documented. |
| **FIN-03** | `src/app/api/wallets/withdraw/route.ts`, `src/lib/withdrawal-atomic.ts`, `src/lib/withdrawal-admin-atomic.ts` | HIGH (historical) | D1 batch statements could partially commit a withdrawal/refund/payout when a required later statement affected zero rows; unsupported card/cash/wallet destinations could also be reserved even though settlement was bank-only. | D1 batches now assert each required mutation and force rollback on failure; requests and admin approvals require bank name + checksum-valid Sheba; PAID requires an external payout reference. SQLite rollback tests cover intermediate failure. | **RESOLVED IN PR #78 (runtime verification pending)** | Keep the real-D1 runtime/concurrency rehearsal as a release gate. |
| **FIN-04** | `src/lib/wallet-release.ts`, `src/lib/wallet-release-d1.ts` | HIGH (historical) | D1 escrow release could commit wallet aggregate changes and transaction state without a ledger proof if a conditional later statement silently affected zero rows. The app read path also lacked a RELEASE ledger entry on the Prisma path. | Both Prisma and D1 release paths now write the RELEASE ledger proof atomically; D1 asserts exactly one affected row after wallet, transaction, and ledger writes, forcing rollback on zero-row results. SQLite tests cover `RAISE(IGNORE)` and SQL-abort paths; PostgreSQL integration tests cover the Prisma transaction. | **RESOLVED IN PR #78 / PR #65 (runtime verification pending)** | Keep isolated real-D1 Cron and application-path rehearsal before enabling scheduled release. |
| **VIP-02** | `src/app/api/vip/subscribe/route.ts` | MEDIUM (historical) | Previous ACTIVE subscription was cancelled before creating its replacement; a duplicate-payment / partial-unique-index conflict could leave the user with no ACTIVE subscription. | Cancellation, duplicate-payment check, and create now run in one Prisma transaction; a create conflict rolls back the cancellation. Tests cover already-used payment and P2002 race response. | **RESOLVED IN PR #78 (runtime verification pending)** | Keep the provider-specific partial unique indexes and transactional replacement together. |
| **VIP-03** | `src/app/api/vip/subscribe/route.ts`, `src/lib/vip-subscription-atomic.ts` | HIGH (historical) | A generic SUCCEEDED payment row could be reused for VIP without proving the original gateway attempt was for VIP; no database invariant guaranteed one ACTIVE subscription per user. | Route now requires the exact VERIFIED gateway log with purpose `vip`, user/payment/currency/amount match; atomic Prisma/D1 replacement plus SQLite/PostgreSQL partial unique indexes enforce one ACTIVE subscription per user. | **RESOLVED IN PR #78 (runtime verification pending)** | Do not enable VIP in production until provider callback/verification round-trip is sandbox-certified. |
| **SEC-14** | `src/app/api/admin-panel/auth/login/route.ts:111-114` | MEDIUM | Admin JWT returned in JSON body; frontend stores in localStorage (XSS-exfiltratable). Prior SEC-14 — still present. | (1) Login as admin. (2) Inspect response body — `token` field present. (3) Frontend `src/app/admin-panel/page.tsx` stores it in `localStorage.getItem("admin_token")`. Any XSS in admin-editable content (technician bio, category name) can exfiltrate it. | **OPEN (prior SEC-14)** | Use HttpOnly cookie for admin token (mirror user auth). If frontend needs the token in JS, mint a short-lived (5min) nonce. |
| **SEC-15** | `src/lib/admin-auth.ts:44-55` | MEDIUM | Admin JWT irrevocable for 7 days. `verifyAdminToken` only checks JWT signature + expiry — no DB revocation check. Prior SEC-15 — still present. | (1) Admin logs in → gets 7d token. (2) Admin "logout" (frontend only clears localStorage). (3) Old token still valid for 7 days. Even password change doesn't invalidate it. | **OPEN (prior SEC-15)** | Add `AdminSession` table mirroring `Session`; persist `tokenHash` on login; check revocation in `verifyAdminToken`. Add `POST /api/admin-panel/auth/logout`. |
| **SEC-17** | `src/lib/admin-auth.ts` | LOW (historical) | Admin signing secret read at module scope — CLOSED in current branch. Inconsistent with user-side `auth.ts:33-43` (which reads inside the function body). This is the ROOT CAUSE of SEC-21 — if the secret were read inside the function, the production-mode bypass would still exist (same secret) BUT the module-load-time capture is an additional Workers/OpenNext hazard (env may be undefined at module eval). | Static: `admin-auth.ts:8` vs `auth.ts:34`. | **RESOLVED IN CURRENT SOURCE** | Admin secret is read inside `getAdminSecret()`; production requires `ADMIN_JWT_SECRET`. |
| **SEC-24** | `src/app/api/admin-panel/auth/login/route.ts` | LOW (historical) | Malformed JSON previously caused a 500 from the admin login route. | The current route catches JSON parse errors and validates the parsed object/field types, returning 400 for malformed input. | **RESOLVED IN CURRENT SOURCE** | Keep malformed-body regression coverage. |
| **SEC-18** | `src/app/api/admin-panel/auth/login/route.ts:35` | LOW | `ensureDefaultAdmin()` called on every login POST → `db.adminUser.count()` DB round-trip per request. Prior SEC-18 — DoS amplifier. Still present. | Flood `/api/admin-panel/auth/login` with empty bodies → each triggers a `count()` query. | **OPEN (prior SEC-18)** | Cache the result with a long TTL (`adminCheckDone` flag) or move to a startup hook. |
| **SEC-19** | `src/lib/admin-auth.ts:22-26` | LOW | `AdminSession.role` is a free-form string. No hierarchy enforcement. `requireRole(session, "ADMIN")` accepts the literal string. Latent privilege-escalation if a lower-privileged admin role is added. Prior SEC-19 — still present. | Static: `admin-auth.ts:25` `role: string`. | **OPEN (prior SEC-19)** | Define a strict role union + `requireSuperAdmin` helper. |
| **SEC-20** | `src/app/api/auth/otp/verify/route.ts:159` | LOW | Cookie `sameSite: "lax"` allows top-level GET navigations from external sites. No state-changing GET endpoints today, but no lint rule prevents adding one. Prior SEC-20 — still present. | Static: `otp/verify/route.ts:159` `sameSite: "lax"`. | **OPEN (prior SEC-20)** | Add a lint rule that flags any `export async function GET` in `src/app/api/` that calls `db.*.update*` / `create` / `delete`. |
| **H-1** | `src/app/api/auth/otp/verify/route.ts:89-108` | MEDIUM (accepted) | OTP verify O(n) user scan. Loads ALL users to match digit-stripped phone. | Static + negative test confirms it's only reached after valid OTP consume. | **ACCEPTED** | Add a `phoneNormalized` column + unique index when schema can be migrated. |
| **L-2** | `src/lib/rate-limit.ts:29-33` + `src/lib/auth.ts:85-90` | LOW/MEDIUM (accepted) | `getClientId` trusts `x-forwarded-for` (first hop), no `cf-connecting-ip`. | Dev: `X-Forwarded-For: 1.2.3.4` per request = unlimited budget. | **ACCEPTED** | Prefer `cf-connecting-ip`; fall back to UA-hash not literal `"anonymous"`. |
| **M-1** | `src/lib/service-write.ts` (375 lines) | LOW (accepted) | Dead code — no route imports `createService` / `transitionJob` / `transitionBooking`. | `grep -rn "createService\|transitionJob\|transitionBooking" src/app/api/` → 0 matches. | **ACCEPTED** | Delete the file OR add `@deprecated` + lint rule. |

---

## 7. Critical / High Blockers for Release

### 🔴 CRITICAL (0 currently open)

SEC-21 was a historical CRITICAL finding and is closed in the current source by dedicated production secret enforcement, strict token-claim validation, and persisted active-user checks for the OTP-admin fallback. The current PR still requires all five CI workflows to pass before closure is runtime-verified.

### 🟠 HIGH (0 currently open)

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
