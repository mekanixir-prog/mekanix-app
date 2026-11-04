# OTP verifier secret and rate-limit policy

## Production secret

Set `OTP_HASH_SECRET` as a secret in the production runtime (for example, a Cloudflare Worker secret). It must contain at least 32 bytes and must be generated independently of `JWT_SECRET` and `ADMIN_JWT_SECRET`.

The application uses HMAC-SHA-256 with domain separation for OTP-code verifiers and phone-based rate-limit identifiers. The secret is never stored in the database. Production OTP send and verify fail closed with HTTP 503 if the secret is missing or shorter than 32 bytes.

Do not put a real secret in `.env.example`, source control, build arguments, or client-side variables. Keep it in the platform's encrypted secret store and rotate it through a controlled rollout.

## Rotation and pending codes

Changing `OTP_HASH_SECRET` invalidates outstanding OTPs and changes the keyed phone rate-limit keys. Users must request a new OTP after rotation. This is intentional; do not add a fallback to the former unkeyed SHA-256 OTP digest.

## Guessing limits

OTP verification is limited by both client IP (5 attempts per minute) and a keyed phone identifier (5 attempts per 10 minutes). Both checks use the shared rate-limit store and fail closed when that store is unavailable in production.

## Historical rows

Previously stored unkeyed SHA-256 OTP rows are not migrated. Their short validity period means they should expire naturally; after deployment, verification accepts only the new HMAC representation.
