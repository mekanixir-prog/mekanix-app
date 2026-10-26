# MEKANIX — UI Entry Release Checklist

**Date:** 2026-10-26
**Branch:** `feature/cloudflare-d1-validation`
**SHA:** `f7d5deb346a8e76f0d4dac645bb3abad2b105d19`

## Completed Items

- [x] Splash uses real brand asset (splash-logo.webp — 3D mascot)
- [x] Splash buttons always brand orange #F58220 (mk-splash-amber classes)
- [x] Mode-select cards use real images from public/cards/
- [x] Mode-select cards stacked vertically (heavy on top)
- [x] Both mode-select cards amber (green only in-app after selection)
- [x] Card aspect ratio matches image dimensions exactly
- [x] Warm cream light theme (oklch(0.965 0.012 80))
- [x] Matte cards with 3-layer shadow + warm tint
- [x] Service Worker disabled in dev (no reload loop)
- [x] CSP allows cross-origin iframe (frame-ancestors *)
- [x] Guest customer profile (auto-seed + fallback DemoUser)
- [x] TypeScript 0 errors
- [x] ESLint 0 errors
- [x] Tests 422 PASS + 2 expected-fail
- [x] Standard build exit 0
- [x] Cloudflare build exit 0
- [x] Browser test: splash renders correctly
- [x] Browser test: mode-select renders correctly
- [x] Browser test: customer home renders correctly
- [x] No console errors

## Remaining Items

- [ ] CI status on GitHub (push completed, CI pending)
- [ ] PR merge (requires owner approval)
- [ ] Deploy (requires owner approval + Cloudflare credentials)

## Actions Requiring Human Access

1. **Review CI on GitHub** — after push, check GitHub Actions tab for CI results
2. **Merge PR #3** — only after owner approves
3. **Deploy to Cloudflare** — requires `wrangler login` + secrets setup
4. **Activate SMS provider** — set SMS_PROVIDER + credentials via `wrangler secret put`
5. **Activate payment gateway** — wire payment-provider.ts into routes + set credentials
6. **Run on Windows** — `git pull` + `bun run dev` (auto-seed handles database)
