# Changelog

## [1.0.0] - 2026-09-25

### Added
- Customer service workflow (request → matching → dispatch → tracking → completion)
- Heavy machinery support (excavators, loaders, graders, bulldozers, tractors)
- Passenger vehicle support (28 Iranian car companies with full catalog)
- Technician workflow (missions, inspection, findings, health reports)
- Admin panel (users, technicians, applications, verification, categories)
- MEKANIX CARE module (maintenance engine, service packages, bookings)
- Fleet management dashboard
- VIP subscription system
- Insurance & referral modules
- Unified Service facade (read + write)
- Offline mode with queue, sync, and idempotency
- Lite API responses (?lite=true for weak internet)
- Payment gateway abstraction (Zarinpal, IDPay, NextPay)
- SMS provider abstraction (Kavenegar, MeliPayamak, Farapayamak)
- ETA provider abstraction (Neshan, Google Maps, OSRM)
- Redis adapter for distributed rate limiting and idempotency
- PostgreSQL + SQLite dual migration support
- Docker production stack (multi-stage build, compose, migrate service)
- Health (/api/health) and Readiness (/api/ready) endpoints
- Caddy reverse proxy config with HTTPS, HSTS, CSP
- Production readiness checklist (31 phases)
- Backup/restore scripts
- Security audit script (12 automated checks)
- Rollback documentation

### Security
- OTP security: CSPRNG (crypto.randomInt) + SHA-256 hashed storage
- OTP rate limiting: 5/10min per phone, 20/hour per IP (Redis-backed)
- Session: DB-backed revocation (tokenHash + revokedAt)
- HttpOnly + Secure cookies (no X-Token header)
- BOLA protection on 23 API routes (requireBookingParticipant, requireAssignedTechnician, etc.)
- Service state machine (role-based transitions, optimistic concurrency)
- Mass assignment protection (FORBIDDEN_FIELDS, sanitizeInput)
- Zod input validation (6 schema files)
- Permission guard (can() function, 14 permissions, 5 roles)
- Demo endpoint hard-blocked in production (handler + rewrite)
- Admin auth: no default password in production (ADMIN_BOOTSTRAP_PASSWORD)
- JWT: no fallback secret in production (throws if missing)
- Security headers via Caddy (HSTS, CSP, X-Frame-Options, X-Content-Type-Options)
- Repository hygiene script (forbidden artifacts scanner)
- Production safety gates (SMS/Payment/PostgreSQL in /api/ready)

### Testing
- 333 tests across 13 files
- Unit tests (permissions, care-auth, pricing, dispatch, offline-queue, lite-response, session-lifecycle, service-unified)
- Integration tests (auth OTP flow, CARE BOLA protection)
- Business E2E tests (47 tests, 14 flow stages)
- Failure scenario tests (28 tests, 8 categories)
- Security tests (42 tests, BOLA/IDOR/mass-assignment/OTP-crypto)
- CI: SQLite (ci.yml)
- CI: PostgreSQL 16 (postgresql-ci.yml with service container)
- CI: Production Readiness (build + check:repo)
- CI: Docker E2E (full stack: build → compose → migrate → health → OTP test)

### Architecture
- Next.js 16 + TypeScript 5 + Tailwind CSS 4 + shadcn/ui
- Prisma ORM with 60 models
- 70 API routes
- 105 React components
- 2,968 i18n translation keys (fa/en)
- 102 Iranian vehicle brand entries (Persian names)
- Decimal.js for money-safe calculations (IRR currency)
- src/modules/ structure (9 module barrels)

### Deferred Integrations
- Real SMS provider (needs Kavenegar API key + real phone test)
- Real Zarinpal payment (needs merchant ID + real transaction test)
- Real routing provider (needs Neshan API key + real route test)
- Production VPS deployment
- Domain + DNS + HTTPS
- Production monitoring (Prometheus/Grafana)
- Load test execution (k6 script ready)
- Playwright browser E2E
- OWASP ZAP scan
