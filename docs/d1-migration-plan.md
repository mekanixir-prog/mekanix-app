# فهرست مهاجرت D1 — مصرف‌کنندگان db (اصلاح‌شده)

**تاریخ:** ۲۰۲۶-۱۰-۱۱  
**شاخه:** feature/cloudflare-d1-validation  
**وضعیت:** PR #3 باز، main دست‌نخورده

## خلاصه‌ی اصلاح‌شده

| | فهرست قبلی | فهرست اصلاح‌شده |
|---|---|---|
| **کل فایل‌ها** | 66 | **77** (۶۵ route + ۱۲ lib) |
| **کل فراخوانی‌ها** | 282 | **342** (۲۸۲ route + ۶۰ lib) |
| **مدل‌های Prisma** | 44 | 44 |
| **فایل‌های با raw SQL** | 2 | 2 |
| **فایل‌های با $transaction** | — | 11 |
| **غیر مصرف‌کننده** | — | 1 (db-sequential.ts) |

## ایرادات اصلاح‌شده

۱. **۱۲ فایل `src/lib/` جا افتاده بود** — حالا اضافه شدن (۶۰ فراخوانی)
۲. **`db.worker.ts` به‌عنوان مصرف‌کننده شمرده شده بود** — حذف شد
۳. **`$transaction` استفاده‌ها ثبت نشده بود** — حالا ثبت شده (۱۱ فایل)
۴. **`uses_transaction` فیلد اضافه شد** — برای بررسی تراکنش‌ها
۵. **`type` فیلد اضافه شد** — تفکیک route از lib
۶. **`auth_deps` گسترش یافت** — شامل createSession, verifySession, rateLimitAsync, etc.

## فهرست کامل

فایل JSON: `docs/d1-migration-inventory.json`

## بسته‌ی ۱: مهاجرت احراز هویت

### فایل‌های مورد نیاز (۶ فایل، ۳۸ فراخوانی)

| نوع | فایل | db calls | مدل‌ها | auth_deps |
|---|---|---|---|---|
| route | `src/app/api/auth/otp/send/route.ts` | 2 | otpCode | rateLimitAsync |
| route | `src/app/api/auth/otp/verify/route.ts` | 12 | customer, otpCode, user | requireAuth, createSession, rateLimitAsync |
| route | `src/app/api/auth/session/route.ts` | 4 | customer, user | getSessionFromRequest |
| route | `src/app/api/auth/demo/route.ts` | 3 | user | (هیچ) |
| **lib** | **`src/lib/auth.ts`** | **14** | customer, idempotencyKey, session, technician, vehicle, wallet, ... | createSession, verifySession, getSessionFromRequest, getCustomerFromSession, getTechnicianFromSession |
| **lib** | **`src/lib/rate-limit.ts`** | **3** | rateLimit | rateLimitAsync |

### نکات مهم

۱. **`src/lib/auth.ts`** — ۱۴ فراخوانی دیتابیس (session.create, session.findUnique, customer.findUnique, etc.) — این فایل توسط همه‌ی route‌های محافظت‌شده استفاده می‌شه
۲. **`src/lib/rate-limit.ts`** — ۳ فراخوانی (rateLimit model) — توسط auth/otp/send و auth/otp/verify استفاده می‌شه
۳. **`src/lib/api-helpers.ts`** — ✅ از db استفاده نمی‌کنه (نیازی به مهاجرت نیست)
۴. **`src/lib/otp-crypto.ts`** — بررسی نشده (احتمالاً db ندارد)
۵. **`src/lib/sms-provider.ts`** — بررسی نشده (احتمالاً db ندارد)

### ترتیب مهاجرت پیشنهادی

۱. `src/lib/rate-limit.ts` — ساده‌ترین (۳ فراخوانی، ۱ مدل)
۲. `src/lib/auth.ts` — پیچیده‌ترین lib (۱۴ فراخوانی، ۱۰ مدل)
۳. `src/app/api/auth/otp/send/route.ts` — ساده‌ترین route (۲ فراخوانی)
۴. `src/app/api/auth/otp/verify/route.ts` — پیچیده‌ترین route (۱۲ فراخوانی)
۵. `src/app/api/auth/session/route.ts` — متوسط (۴ فراخوانی)
۶. `src/app/api/auth/demo/route.ts` — دمو (۳ فراخوانی)

## محدودیت‌ها

- main دست‌نخورده می‌مونه
- PR #3 فعلاً merge نشود
- هیچ migration روی D1 remote
- هیچ deploy
- هر بسته باید قبل از merge تست بشه
