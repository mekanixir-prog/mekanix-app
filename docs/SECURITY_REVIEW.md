# MEKANIX — Security Review

**Last Updated:** 2026-10-11  
**Commit:** `7109d65`  
**Reviewer:** AI-assisted (requires independent verification)  
**Status:** In Progress

## Methodology

Each finding is classified by severity and status:
- **Severity:** Critical / High / Medium / Low
- **Status:** Fixed / Verified / Pending / Not Applicable

Findings marked "Fixed" have code changes applied on this branch.
Findings marked "Pending" require independent verification or further work.

---

## 1. Authentication & Session Management

### 1.1 `verifySession()` fail-closed in production
- **Severity:** Critical
- **Status:** Fixed (commit `600e5bc`)
- **Before:** DB error → fallback to JWT-only (revoked sessions could pass)
- **After:** DB error in production → return null (reject). Dev → fallback.
- **Test:** `session-lifecycle.test.ts` — "rejects session (fail-closed) when the DB throws in production"

### 1.2 `createSession()` fail-closed in production
- **Severity:** Critical
- **Status:** Fixed (commit `fe0eb93`)
- **Before:** DB error → JWT returned (session untracked, unrevokeable)
- **After:** DB error in production → throw (login fails). Dev → fallback.
- **Test:** `session-lifecycle.test.ts` — "THROWS in production if the DB create throws"

### 1.3 `revokeSession()` / `revokeAllUserSessions()` error propagation
- **Severity:** High
- **Status:** Fixed (commit `600e5bc`)
- **Before:** DB error → caught, logged, function returns (appears successful)
- **After:** DB error → throws to caller
- **Test:** `session-lifecycle.test.ts` — "THROWS if the DB throws (fail-closed for security)"

### 1.4 `JWT_SECRET` storage
- **Severity:** High
- **Status:** Fixed (commit `661141d`)
- **Before:** In `wrangler.toml [vars]` (visible in plaintext)
- **After:** In `.dev.vars` (local, gitignored) / `wrangler secret put` (production)
- **Note:** `getSecret()` reads `process.env.JWT_SECRET` inside function body

---

## 2. Payment & Wallet Security

### 2.1 Gateway: no production guard
- **Severity:** Critical
- **Status:** Fixed (commit `a8337e5`)
- **Before:** Simulator endpoints accessible in production
- **After:** Returns 404 in production (like `auth/demo`)

### 2.2 Gateway: no authentication
- **Severity:** Critical
- **Status:** Fixed (commit `a8337e5`)
- **Before:** Anyone could initiate/verify payments
- **After:** `requireAuth()` required on both endpoints

### 2.3 Gateway: userId from client
- **Severity:** Critical
- **Status:** Fixed (commit `a8337e5`)
- **Before:** `userId` accepted from request body
- **After:** `userId` from `session.userId` only; verify checks `log.userId === session.userId`

### 2.4 Prepay: no auth, no ownership
- **Severity:** Critical
- **Status:** Fixed (commit `f954b87`)
- **Before:** No auth check; any user could trigger prepay for any job
- **After:** `requireAuth()` + `requireJobParticipant()` + optimistic concurrency on `prepayPaid`

### 2.5 Payments: race condition (double payment)
- **Severity:** Critical
- **Status:** Fixed (commit `ad31630`)
- **Before:** Simple `invoice.update` — concurrent requests could both succeed
- **After:** `updateMany({ where: { status: { not: "PAID" } } })` — only one succeeds
- **Also:** Early 409 check if `invoice.status === "PAID"`

### 2.6 Wallets/withdraw: race condition (double withdrawal)
- **Severity:** Critical
- **Status:** Fixed (commit `878ab04`)
- **Before:** Non-atomic read-then-write: read balance → check → write new balance
- **After:** `updateMany({ where: { balance: { gte: amount } } })` — atomic conditional update

### 2.7 Multi-step writes without atomicity
- **Severity:** Medium
- **Status:** Documented (not fixable without D1 transactions)
- **Affected:** payments, prepay, wallets/withdraw, care bookings, invoices
- **Risk:** If step N fails after step N-1 succeeds, data is partially updated
- **Mitigation:** `.catch()` on non-critical steps (e.g., warranty, notification)

---

## 3. Access Control (BOLA)

### 3.1 Vehicle ownership
- **Status:** Verified — `requireVehicleOwner` checks `vehicle.customerId === customer.id`

### 3.2 Job participation
- **Status:** Verified — `requireJobParticipant` checks customer ownership or technician assignment

### 3.3 Technician self-edit
- **Status:** Verified — `tech.userId === session.userId` check in PATCH

### 3.4 Invoice ownership
- **Status:** Verified — `requireJobParticipant` on invoice's jobId

### 3.5 Wallet ownership
- **Status:** Verified — `getTechnicianFromSession` derives technicianId from session

### 3.6 Care booking participant
- **Status:** Verified — `requireBookingParticipant` / `requireAssignedTechnician`

---

## 4. Input Validation & Mass Assignment

### 4.1 Mass assignment protection
- **Status:** Verified — `sanitizeInput()` + `ALLOWED_FIELDS` whitelist on:
  - vehicles (create + update)
  - technicians (update)
  - `FORBIDDEN_FIELDS` set blocks: role, status, password, rating, etc.

### 4.2 Server-authoritative amounts
- **Status:** Verified — amounts from server records, not client:
  - Invoice: laborRate from technician, partsTotal from job.parts, taxRate from platformSetting
  - Payment: amount from invoice.total
  - Prepay: fees from technician profile
  - Wallet: balance from wallet record

---

## 5. Rate Limiting

### 5.1 OTP send: 5 per 10 min (per phone) + 20 per hour (per IP)
- **Status:** Verified

### 5.2 OTP verify: 5 per minute (per IP)
- **Status:** Verified

### 5.3 Payments: 5 per minute
- **Status:** Verified

### 5.4 Withdrawals: 3 per hour
- **Status:** Verified

---

## 6. Information Disclosure

### 6.1 OTP code in response
- **Severity:** High
- **Status:** Verified safe — code NOT in response when `NODE_ENV=production`

### 6.2 JWT in response body
- **Severity:** High
- **Status:** Verified safe — JWT only in HttpOnly cookie, never in JSON body

### 6.3 Password field in responses
- **Status:** Verified safe — `PUBLIC_USER_FIELDS` / `SAFE_USER_SELECT` exclude password

### 6.4 `auth/demo` in production
- **Status:** Verified safe — returns 404 in production

### 6.5 `gateway` in production
- **Status:** Verified safe — returns 404 in production (commit `a8337e5`)

---

## 7. Pending Items (Not Yet Verified)

| # | Item | Status | Notes |
|---|---|---|---|
| 7.1 | Concurrency test on Workers (actual wrangler dev) | Pending | Race condition fixes need runtime verification |
| 7.2 | `care-auth.ts` migration | Pending | Still uses sync `db` — 3 calls |
| 7.3 | `service-write.ts` migration | Pending | Still uses sync `db` — 15 calls |
| 7.4 | `service-unified.ts` migration | Pending | Still uses sync `db` — 11 calls |
| 7.5 | Admin-panel routes | Pending | Separate project, migration scope unclear |
| 7.6 | D1 migration compatibility | Pending | Schema not yet applied to remote D1 |
| 7.7 | Real payment gateway integration | Pending | Simulator only, production guard active |
| 7.8 | Real SMS provider | Pending | Console provider only |
