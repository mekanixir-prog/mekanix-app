# MEKANIX SEO Implementation Notes

**Branch:** `feature/cloudflare-d1-validation`  
**Purpose:** improve crawlability and Persian-language search relevance without claiming unverified service availability.

## Changes in this branch

- Added server-rendered Persian public pages:
  - `/about`
  - `/services/heavy-machinery`
  - `/services/mobile-repair`
- Added page-specific titles, descriptions, canonical paths, and Open Graph metadata.
- Added site-wide metadata base, Persian locale, Open Graph and Twitter preview metadata.
- Expanded `src/app/sitemap.ts` to include the public pages.
- Updated `src/app/robots.ts` to disallow crawling API and private admin paths. This is crawler guidance only; it is not an access-control mechanism.
- Removed unsupported claims of a six-month warranty and secure payment from the global metadata. Those claims must not be published until the actual service terms and gateway are verified.

## SEO scope and limits

The root route `/` currently renders a client-side application/splash flow. Global metadata can be crawled, but a client-only application screen is not a substitute for a substantive server-rendered public landing page. The new service pages create crawlable informational content without replacing the existing app entry flow.

The public pages intentionally avoid guarantees about:
- nationwide service coverage or immediate dispatch;
- fixed prices or arrival times;
- warranty duration;
- live SMS or payment availability.

The domain `https://mekanix.ir` is configured as the canonical origin in code, based on the project’s intended domain. Before public launch, verify that DNS and HTTPS point to this application and that the canonical origin is correct.

## Follow-up SEO work before launch

- Verify rendered HTML and response headers on the live domain; confirm canonical URLs and Open Graph image responses.
- Run Google Search Console and Bing Webmaster Tools URL inspection after DNS/TLS activation.
- Add a branded social share image sized for common Open Graph previews; current metadata uses the existing logo asset.
- Add structured data only when the organization/contact/service facts are verified. Do not fabricate phone numbers, street addresses, aggregate ratings, reviews, or service-area claims.
- Build additional location/service pages only for areas actually served, with unique useful content—not duplicated city-name landing pages.
- Measure Core Web Vitals on representative mobile devices and reduce client JavaScript on public informational routes where practical.
- Review indexability and search queries after launch; sitemap inclusion alone does not guarantee indexing or rankings.

## Validation evidence

Automated GitHub checks are triggered by commits on the PR branch. This document does not claim a live crawl, Google indexing, ranking improvement, or production-domain verification.
