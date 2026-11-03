# MEKANIX — Standalone Admin Session Security

**Scope:** SEC-89  
**Implementation branch:** `security/admin-httponly-revocable-session`  
**Status:** Implementation prepared for review; release remains blocked until CI and deployment migration checks pass.

## Authentication model

The standalone `/admin-panel` now uses a server-set `mekanix_admin_session` cookie rather than a browser-readable bearer token.

Cookie attributes:
- `HttpOnly`
- `Secure` on HTTPS and in production
- `SameSite=Strict`
- `Path=/api/admin-panel`
- Seven-day maximum age

The login JSON response contains admin profile data only; it does not return the signed JWT. The browser no longer reads, stores, or adds a dedicated admin JWT to Authorization headers. Production must have a dedicated `ADMIN_JWT_SECRET` of at least 32 bytes; there is no production fallback to `JWT_SECRET`.

## Revocation

Dedicated admin JWTs carry a `sessionVersion`. The value is persisted on `AdminUser` and compared on every cookie-authenticated request. Logout increments the stored version with a compare-and-set update and clears the cookie. A version mismatch immediately invalidates all dedicated sessions for that admin account.

This is account-wide revocation: logging out one standalone admin session invalidates other standalone sessions for the same admin account. This trade-off avoids storing raw session tokens and keeps the revocation state small. A future per-device session table can replace it if independent device revocation becomes a product requirement.

## CSRF

Login requires a same-origin Origin or Fetch Metadata signal. Mutating routes protected by the standalone admin cookie reject requests that do not prove same-origin. The cookie is also SameSite=Strict.

The OTP-authenticated in-app AdminApp bearer flow remains separate and continues to use the persisted user role/status check. Dedicated admin JWTs are no longer accepted as bearer credentials.

## Data migration

Both migration tracks add `AdminUser.sessionVersion INTEGER NOT NULL DEFAULT 0`:
- SQLite / Cloudflare D1: `prisma/migrations/20261103020000_admin_session_version`
- PostgreSQL: `prisma/migrations-postgresql/20261103020000_admin_session_version`

Apply the matching migration before deploying the new application code. The default preserves existing AdminUser rows. Existing browser-stored dedicated JWTs are intentionally invalidated by the new token shape and must be replaced by a fresh login.

## Verification required before release

- All five required CI workflows pass on the exact merged commit.
- SQLite/D1 and PostgreSQL migrations/builds pass.
- Login sets the expected cookie attributes and does not return a token in JSON.
- Valid cookie requests work; stale/revoked versions fail.
- Logout increments the persisted version and clears the cookie.
- Cross-origin login/logout mutations are rejected.
- Onboarding create/update/delete still work from the standalone admin panel.
- The OTP-based in-app AdminApp remains functional.
- No production credentials, live payments, or production deployment are part of this change.
