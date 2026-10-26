# Bundle 3 — بررسی فقط‌خواندنی و برنامهٔ اجرایی پنل ادمین

**تاریخ:** 2026-10-14
**بررسی‌کننده:** Agent (read-only، هیچ تغییری اعمال نشده)
**شاخه:** feature/cloudflare-d1-validation @ ccd7aa2
**Baseline:** B2.2 HEAD

---

## ۱. وضعیت اولیه (ثبت‌شده قبل از بررسی)

| شاخه | SHA |
|------|------|
| feature/cloudflare-d1-validation (محلی) | ccd7aa254348ed01d6b363586b235bf8908cef6e |
| main (محلی) | 625b23f66d5f459cd0b1824496468b7e2c194272 |
| main (remote) | e4c2faf1447622da02bdd12a9535e367e8d46e36 (دست‌نخورده ✓) |
| feature (remote) | 917b2b2d2683a4360171e4b4602258586d1559e8 (دست‌نخورده ✓ — push نشده) |
| working tree | ۲ فایل تغییرکرده (worklog.md, docs/BUNDLE_2_2_VERIFY.md — هر دو از B2.2) |
| شاخهٔ فعال | feature/cloudflare-d1-validation |

---

## ۲. بررسی admin-panel.tar.gz — نتیجهٔ غافلگیرکننده

### ۲.۱ گزارش Bundle 1 گفت:
> «کد منبع UI پنل ادمین از تمام شاخه‌ها غایب است — تنها نسخهٔ حفظ‌شده در `public/admin-panel.tar.gz` است»

### ۲.۲ واقعیت پیدا‌شده:
این گزارش **نادرست** بود. بررسی مستقیم نشان می‌دهد:

| مورد | وضعیت |
|------|------|
| فایل `admin-panel.tar.gz` | **موجود نیست** در هیچ شاخه‌ای |
| فایل `public/mekanix-source.tar.gz` | موجود است (۲۳۰ کیلوبایت) — ولی نسخهٔ قدیمی کل source |
| کد UI پنل ادمین (`src/components/mek/admin/`) | **موجود است** — ۱۲ فایل روی feature branch |
| کد API پنل ادمین (`src/app/api/admin-panel/`) | **موجود است** — ۴ فایل |
| کد API ادمین عمومی (`src/app/api/admin/`) | **موجود است** — ۲ فایل |
| صفحهٔ پنل (`src/app/admin-panel/page.tsx`) | **موجود است** |

### ۲.۳ نتیجه:
**نیازی به استخراج از tarball نیست.** تمام کد پنل ادمین از قبل روی feature branch موجود است. این یک خبر خوب است — Bundle 3 نیازی به بازیابی کد ندارد.

---

## ۳. فایل‌های موجود پنل ادمین (۱۹ فایل)

### ۳.۱ UI Components (۱۲ فایل در `src/components/mek/admin/`)
| فایل | کاربرد |
|------|------|
| `admin-app.tsx` | اپلیکیشن اصلی پنل |
| `overview.tsx` | داشبورد اصلی |
| `customers.tsx` | مدیریت مشتریان |
| `technicians.tsx` | مدیریت تکنسین‌ها |
| `jobs.tsx` | مدیریت سفارشات |
| `payments.tsx` | مدیریت پرداخت‌ها |
| `applications.tsx` | درخواست‌های مکانیک |
| `categories.tsx` | دسته‌بندی سرویس‌ها |
| `reviews.tsx` | مدیریت نظرات |
| `disputes.tsx` | اختلافات |
| `verification.tsx` | تأیید حساب‌ها |
| `settings.tsx` | تنظیمات |

### ۳.۲ API Routes (۶ فایل)
| مسیر | کاربرد |
|------|------|
| `src/app/admin-panel/page.tsx` | صفحهٔ ورودی پنل |
| `src/app/api/admin-panel/auth/login/route.ts` | ورود ادمین |
| `src/app/api/admin-panel/auth/me/route.ts` | دریافت پروفایل ادمین |
| `src/app/api/admin-panel/onboarding/route.ts` | مدیریت اسلایدهای onboarding |
| `src/app/api/admin-panel/onboarding/[id]/route.ts` | ویرایش/حذف اسلاید |
| `src/app/api/admin/[resource]/route.ts` | لیست منابع ادمین (GET) |
| `src/app/api/admin/[resource]/[id]/route.ts` | ویرایش منبع ادمین (PATCH) |

### ۳.۳ Helper Library
| فایل | کاربرد |
|------|------|
| `src/lib/admin-auth.ts` | احراز هویت ادمین (JWT، bcrypt، ensureDefaultAdmin) |
| `src/lib/admin-api.ts` | helper شامل `writeAuditLog()` |

---

## ۴. بررسی امنیتی — وضعیت SEC-4، SEC-5، SEC-13

### ۴.۱ SEC-4 (MEDIUM) — عدم audit logging در admin/[resource]/[id]

**وضعیت: تأیید شد — هنوز آسیب‌پذیر**

| مورد | نتیجه |
|------|------|
| مدل AuditLog در schema | ✅ موجود (با فیلدهای adminId, action, entity, entityId, before, after, ipAddress, userAgent) |
| helper `writeAuditLog` | ✅ موجود در `src/lib/admin-api.ts` |
| استفاده در `admin-panel/onboarding/*` | ✅ ۵ بار استفاده شده (CREATE, UPDATE, DELETE) |
| استفاده در `admin/[resource]/[id]` (PATCH) | ❌ **صفر بار** — این مشکل SEC-4 است |
| استفاده در `admin/[resource]` (GET) | N/A (GET، نوشتنی نیست) |

**سناریوی خطر:**
- ادمین status یک customer را به SUSPENDED تغییر می‌دهد → هیچ رکوردی در AuditLog نمی‌شود
- ادمین status یک payment را به REFUNDED تغییر می‌دهد → هیچ رکوردی نمی‌شود
- ادمین verified یک technician را تغییر می‌دهد → هیچ رکوردی نمی‌شود

### ۴.۲ SEC-5 (LOW→MEDIUM) — عدم rate limit و لاگ‌کردن ورود ناموفق ادمین

**وضعیت: تأیید شد — هنوز آسیب‌پذیر**

| مورد | نتیجه |
|------|------|
| Rate limit مخصوص `/api/admin-panel/auth/login` | ❌ **هیچ** — فقط rate limit عمومی API (۶۰/min) |
| لاگ‌کردن تلاش‌های ورود ناموفق | ❌ **هیچ** |
| Account lockout بعد از N تلاش ناموفق | ❌ **هیچ** |
| تأیید هویت با JWT (HS256) | ✅ صحیح |
| bcrypt با ۱۲ rounds | ✅ صحیح |
| تولید توکن ۷ روزه | ⚠️ طولانی — ولی به علت عدم Session table قابل revoke نیست (SEC-15) |

**سناریوی خطر:**
- مهاجم می‌تواند با ۶۰ درخواست در دقیقه، ۳۶۰۰ پسورد در ساعت امتحان کند
- هیچ هشداری برای ادمین نمی‌شود
- هیچ قفلی روی حساب نمی‌آید

### ۴.۳ SEC-13 (MEDIUM) — user enumeration از طریق کدهای status متفاوت

**وضعیت: تأیید شد — هنوز آسیب‌پذیر**

بررسی `login/route.ts`:
```
- کاربر یافت نشد → 404 با پیام "کاربر یافت نشد"
- پسورد اشتباه → 401 با پیام "پسورد اشتباه است"
```

**سناریوی خطر:**
- مهاجم می‌تواند با ارسال ایمیل‌های مختلف، تشخیص دهد کدام ایمیل در سیستم ثبت شده (۴۰۴ یعنی وجود ندارد، ۴۰۱ یعنی وجود دارد ولی پسورد غلط است)
- این اطلاعات برای حملات targeted استفاده می‌شود

### ۴.۴ SEC-15 (MEDIUM) — admin JWT غیرقابل revoke برای ۷ روز

**وضعیت: تأیید شد — هنوز آسیب‌پذیر** (همانند گزارش B2.1)

- توکن ادمین ۷ روز اعتبار دارد
- هیچ جدول Session برای ادمین وجود ندارد (برخلاف کاربر که Session table دارد)
- اگر توکن به‌سرقت برود، تا ۷ روز قابل استفاده است
- ادمین نمی‌تواند session خود را revoke کند (مثلاً بعد از تغییر پسورد)

### ۴.۵ SEC-14 (MEDIUM) — admin JWT در localStorage

**وضعیت: تأیید شد — هنوز آسیب‌پذیر** (همانند گزارش B2.1)

- frontend توکن ادمین را در `localStorage` ذخیره می‌کند
- در صورت XSS، مهاجم می‌تواند توکن را بدزدد
- برخلاف کاربر که توکن در HttpOnly cookie است

---

## ۵. برنامهٔ اجرایی Bundle 3

### ۵.۱ محدودهٔ پیشنهادی

| اولویت | یافته | کار پیشنهادی | فایل درگیر | زمان تخمینی |
|--------|------|--------------|-----------|-------------|
| ۱ (CRITICAL) | SEC-4 | افزودن `writeAuditLog()` به `admin/[resource]/[id]` PATCH | `src/app/api/admin/[resource]/[id]/route.ts` | ۱-۲ ساعت |
| ۲ (HIGH) | SEC-5 | افزودن rate limit مخصوص + لاگ‌کردن ورود ناموفق | `src/app/api/admin-panel/auth/login/route.ts` | ۱ ساعت |
| ۳ (MEDIUM) | SEC-13 | یکسان‌کردن کدهای status (۴۰۱ برای هر دو حالت) | `src/app/api/admin-panel/auth/login/route.ts` | ۱۵ دقیقه |

### ۵.۲ خارج از محدوده (موکول به آینده)

| یافته | علت |
|------|------|
| SEC-15 (admin JWT ۷ روزه) | نیاز به تغییر schema (افزودن AdminSession table) — ریسک بالا، به آینده موکول |
| SEC-14 (admin JWT در localStorage) | نیاز به بازنویسی frontend پنل ادمین — خارج از محدودهٔ بک‌اند |

### ۵.۳ جزئیات فنی هر اصلاح

#### اصلاح ۱: SEC-4 — Audit logging در admin/[resource]/[id]

**فایل:** `src/app/api/admin/[resource]/[id]/route.ts`

**روش:**
- import `writeAuditLog` از `@/lib/admin-api`
- در هر branch از PATCH (technicians, customers, categories, reviews, payments)، قبل از `db.*.update`، snapshot قبل را ذخیره کن
- بعد از update، `writeAuditLog` را با پارامترهای مناسب صدا بزن:
  ```ts
  await writeAuditLog({
    session, // AdminSession از requireAuth
    action: "UPDATE_TECHNICIAN", // یا UPDATE_CUSTOMER و غیره
    entity: "Technician",
    entityId: id,
    before: existingRecord,
    after: result,
    req,
  });
  ```
- برای `customers` با `status` change (ban/activate)، action جداگانه: `CHANGE_USER_STATUS`

**ریسک:** کم — فقط افزودن لاگ، تغییر منطق نیست
**تست‌ها:** افزودن تست برای تأیید AuditLog ایجاد می‌شود

#### اصلاح ۲: SEC-5 — Rate limit + لاگ‌کردن ورود ناموفق

**فایل:** `src/app/api/admin-panel/auth/login/route.ts`

**روش:**
- import `rateLimitAsync` از `@/lib/rate-limit`
- افزودن rate limit مخصوص: ۵ تلاش در ۱۵ دقیقه per IP
- در صورت ورود ناموفق، `writeAuditLog` با action `FAILED_ADMIN_LOGIN` صدا بزن
- در صورت ورود موفق، `writeAuditLog` با action `ADMIN_LOGIN_SUCCESS` صدا بزن
- قبل از rate limit، `ensureDefaultAdmin` را صدا بزن (الان در ابتدای POST صدا زده می‌شود)

**ریسک:** متوسط — باید مطمئن شد rate limit ادمین‌های واقعی را قفل نمی‌کند
**تست‌ها:** افزودن تست برای تأیید ۴۲۹ بعد از ۵ تلاش ناموفق

#### اصلاح ۳: SEC-13 — یکسان‌کردن کدهای status

**فایل:** `src/app/api/admin-panel/auth/login/route.ts`

**روش:**
- تغییر پیام "کاربر یافت نشد" (۴۰۴) به همان پیام "پسورد اشتباه است" (۴۰۱)
- یعنی هر دو حالت ۴۰۱ برمی‌گردانند با پیام یکسان
- مهاجم نمی‌تواند تشخیص دهد ایمیل موجود است یا نه

**ریسک:** کم — فقط تغییر status code و پیام
**تست‌ها:** به‌روزرسانی تست‌های موجود (اگر هستند) برای انتظار ۴۰۱ به‌جای ۴۰۴

### ۵.۴ ترتیب commitها (پیشنهادی)

| # | نوع | پیام commit | فایل‌ها |
|---|------|-------------|---------|
| ۱ | fix | `fix(sec-4): audit logging on admin/[resource]/[id] PATCH` | `src/app/api/admin/[resource]/[id]/route.ts` |
| ۲ | test | `test(sec-4): verify audit log created on admin mutations` | `tests/unit/admin-audit.test.ts` (جدید) |
| ۳ | fix | `fix(sec-5): rate limit + failed login logging on admin login` | `src/app/api/admin-panel/auth/login/route.ts` |
| ۴ | fix | `fix(sec-13): unified error response to prevent user enumeration` | `src/app/api/admin-panel/auth/login/route.ts` |
| ۵ | test | `test(sec-5/13): admin login rate limit + enumeration prevention` | `tests/unit/admin-login.test.ts` (جدید) |
| ۶ | docs | `docs(b3): Bundle 3 report + worklog entry` | `docs/BUNDLE_3_REPORT.md`, `worklog.md` |

### ۵.۵ معیارهای قبولی Bundle 3

- [ ] SEC-4: هر mutation ادمین یک AuditLog رکورد ایجاد کند
- [ ] SEC-5: بعد از ۵ تلاش ناموفق، ۴۲۹ برگردد
- [ ] SEC-5: هر ورود ناموفق در AuditLog ثبت شود
- [ ] SEC-13: ۴۰۴ و ۴۰۱ هر دو به ۴۰۱ با پیام یکسان تبدیل شوند
- [ ] `tsc --noEmit`: ۰ خطای جدید
- [ ] `bun run lint`: clean روی فایل‌های تغییریافته
- [ ] `bun run test`: همه سبز (۳۴۸ + تست‌های جدید)
- [ ] هیچ فایل دیگری تغییر نکند (غیر از فایل‌های فوق + tests + docs)
- [ ] main دست‌نخورده
- [ ] remote feature (push نشده)

### ۵.۶ ریسک‌ها و ملاحظات

| ریسک | شدت | راه‌حل |
|------|------|--------|
| Rate limit ممکن است ادمین واقعی را قفل کند | متوسط | استفاده از sliding window به‌جای fixed window؛ reset بعد از ورود موفق |
| AuditLog ممکن است حجم زیادی از DB بگیرد | کم | افزودن index روی `createdAt` (موجود است)؛ retention policy در آینده |
| `writeAuditLog` ممکن است fail کند و کل mutation را شکست دهد | متوسط | wrap در try/catch — audit log failure نباید mutation را block کند |
| تست‌ها ممکن است به داده‌های seed وابسته باشند | کم | استفاده از mock مانند B2.1/2.2 |

### ۵.۷ وابستگی‌ها

| بسته | وابسته به |
|------|-----------|
| Bundle 3 | Bundle 2.1 + 2.2 (تکمیل‌شده ✓) |
| Bundle 4 (Business flows) | Bundle 3 (برای admin-related flows) |
| Bundle 5 (Quality) | Bundle 3 (برای test coverage) |

---

## ۶. خلاصهٔ تصمیم‌گیری برای تو

### ۶.۱ آنچه پیدا شد:
1. **کد پنل ادمین موجود است** — نیازی به استخراج از tarball نیست (گزارش Bundle 1 نادرست بود)
2. **۳ یافتهٔ امنیتی (SEC-4, SEC-5, SEC-13)** تأیید شدند و قابل رفع هستند
3. **۲ یافتهٔ دیگر (SEC-14, SEC-15)** به‌دلیل نیاز به تغییر schema یا بازنویسی frontend، به آینده موکول می‌شوند

### ۶.۲ آنچه نیاز به تأیید تو دارد:

**سؤال ۱:** آیا با محدودهٔ Bundle 3 موافقی؟ (۳ اصلاح: SEC-4, SEC-5, SEC-13)

**سؤال ۲:** آیا اصلاح SEC-15 (admin JWT ۷ روزه) را به Bundle 3 اضافه کنیم یا به آینده موکول کنیم؟ (نیاز به افزودن AdminSession table به schema)

**سؤال ۳:** آیا اصلاح SEC-14 (admin JWT در localStorage) را به Bundle 3 اضافه کنیم یا به آینده موکول کنیم؟ (نیاز به بازنویسی frontend)

**سؤال ۴:** آیا روش کار (subagent مجزا + بررسی مستقل در پایان) همانند B2.1/B2.2 مناسب است؟

---

## ۷. محدودیت‌های رعایت‌شده

| محدودیت | وضعیت |
|---------|------|
| main دست‌نخورده | ✅ |
| هیچ push ای انجام نشده | ✅ |
| هیچ merge ای نشده | ✅ |
| هیچ deploy یا migration ای انجام نشده | ✅ |
| هیچ کدی تغییر نکرده | ✅ |
| استخراج tarball انجام نشده | ✅ |
| فقط بررسی فقط‌خواندنی | ✅ |

