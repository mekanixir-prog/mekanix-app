# فهرست مهاجرت D1 — مصرف‌کنندگان db (بروزرسانی نهایی)

**تاریخ:** ۲۰۲۶-۱۰-۱۱  
**شاخه:** feature/cloudflare-d1-validation  
**Commit:** `06f161e`  
**وضعیت:** PR #3 باز، main دست‌نخورده (`e4c2faf`)

## خلاصه

| | تعداد | db calls |
|---|---|---|
| **کل فایل‌ها** | 74 | 322 |
| **مهاجرت‌شده** | 40 | 186 |
| **باقی‌مانده** | 34 | 136 |
| **فایل‌های با $transaction (فقط کامنت)** | 10 | — |
| **فایل‌های با raw SQL** | 2 | — |

## فایل‌های مهاجرت‌شده (40 فایل، 186 db calls)

### lib infrastructure (4 فایل)
- `src/lib/db-access.ts` — getDbForLib() helper
- `src/lib/db-worker.ts` — per-request PrismaClient caching
- `src/lib/rate-limit.ts` — 3 calls
- `src/lib/auth.ts` — 14 calls + security fixes

### auth (4 routes، 21 calls)
- `auth/otp/send` — 2 calls
- `auth/otp/verify` — 12 calls
- `auth/session` — 4 calls
- `auth/demo` — 3 calls (production guard)

### vehicles (2 routes، 5 calls)
### technicians (2 routes، 2 calls)
### service-requests (2 routes، 14 calls)
### jobs (5 routes، 19 calls)
### dashboard (1 route، 16 calls)
### gateway (2 routes، 5 calls)
### prepay (1 route، 10 calls)
### invoices (2 routes، 13 calls)
### payments (1 route، 12 calls)
### wallets (2 routes، 11 calls)
### care (16 routes، 58 calls)

## فایل‌های باقی‌مانده (34 فایل، 136 db calls)

### lib (9 فایل، 43 calls) — اولویت ۱
- `src/lib/service-write.ts` — 15 calls
- `src/lib/service-unified.ts` — 11 calls
- `src/lib/admin-auth.ts` — 3 calls
- `src/lib/care-auth.ts` — 3 calls
- `src/lib/vip.ts` — 4 calls
- `src/lib/pricing.ts` — 2 calls
- `src/lib/notifications.ts` — 2 calls
- `src/lib/dispatch.ts` — 2 calls
- `src/lib/admin-api.ts` — 1 call

### route — priority 3 (15 files، 71 calls)
- `insurance/claim` + `insurance/route` — 12 calls
- `mechanic-applications/*` — 13 calls
- `maintenance/route` — 7 calls
- `referral/route` — 7 calls
- `reviews/route` — 5 calls
- `support/tickets` — 5 calls
- `vip/*` — 7 calls
- `messages/route` — 4 calls
- `notifications/*` — 3 calls
- `exchange-rate/route` — 3 calls
- `onboarding/route` — 1 call

### route — priority 4 (8 files، 22 calls)
- `admin-panel/*` — 11 calls (پروژه‌ی جداگانه)
- `admin/[resource]/*` — 15 calls (generic admin)
- `health/route` — 0 calls ($queryRaw only)
- `ready/route` — 0 calls ($queryRaw only)

## ناسازگاری‌های شناسایی‌شده

### $transaction فقط در کامنت‌هاست
10 فایل `uses_transaction: true` دارند، ولی بررسی دقیق نشان داد:
**هیچ‌کدام $transaction واقعی در کد اجرا نمی‌کنند** — همه فقط در کامنت‌ها
اشاره می‌کنند به "D1 has no $transaction". عملیات واقعی sequential `await` هستند.

## محدودیت‌ها
- main دست‌نخورده
- PR #3 فعلاً merge نشود
- هیچ migration روی D1 remote
- هیچ deploy
