# MEKANIX Editable IRR Rate Card

Owner-approved initial proposal: 2026-11-04. Canonical storage is integer IRR; admin input/display is integer Toman (10 IRR = 1 Toman). Each save creates a new version and retains the previous 20 versions.

## Dispatch and inspection (Toman)
| Item | Foreign passenger | Heavy machinery |
|---|---:|---:|
| Base dispatch | 500,000 | 2,000,000 |
| Inspection / diagnosis | 600,000 | 2,000,000 |
| Included distance | 10 km | 10 km |
| Additional distance | 10,000/km | 30,000/km |

## Fixed labor fees (Toman; parts excluded)
| Service | Passenger | Heavy |
|---|---:|---:|
| Diagnostics | 800,000 | 3,500,000 |
| Electrical / wiring | 1,200,000 | 3,000,000 |
| Cooling | 1,200,000 | 4,000,000 |
| Brakes / suspension | 1,500,000 | 5,000,000 |
| Periodic service | 1,800,000 | 5,000,000 |
| Minor engine repair | 2,500,000 | 6,000,000 |
| Major engine repair | 8,000,000 | 18,000,000 |
| Transmission | 6,000,000 | 12,000,000 |
| Hydraulic system | Not applicable | 8,000,000 |
| Undercarriage / chassis | Not applicable | 9,000,000 |

Emergency surcharge is 30% of fixed labor only. Parts are separately quoted and require customer approval. Unlisted/uncertain repairs require a separate technician proposal and customer approval.

## Commercial guardrails
- Passenger rates apply only to supported foreign vehicles; Iran Khodro and Saipa remain excluded.
- Heavy equipment has a separate rate card.
- Tax is disabled at 0% until tax treatment and taxable base are confirmed.
- Platform commission is disabled at 0%; it is separate from technician wages and must not be deducted before settlement policy approval.
- Proposed annual VIP: 1,800,000 Toman passenger / 6,000,000 Toman heavy, four periodic visits per year. It covers dispatch and inspection only; repairs, parts, and extra-distance travel are excluded. VIP remains disabled until the payment/subscription lifecycle is ready.
- Manual discount cap: 10%, subject to admin authorization and audit.
- No ambiguous legacy seed values are reused or re-labelled. Existing historical financial records remain unverified.
- A new rate version applies only to new price calculations; existing orders retain their frozen PricingSnapshot.
- Admin editor: /admin-panel/pricing. API: GET/PUT /api/admin-panel/pricing. Storage: PlatformSetting key mekanix.pricing.rate-card.v1. Every update is audited.
- Production calculation remains fail-closed until MEKANIX_PRICING_IRR_APPROVED=true; live payment, commission settlement, tax, and VIP activation remain separate release gates.

Passenger-market calibration reference: Sanjagh mobile-mechanic price listing (September 1405) reports roughly 391k–517k Toman dispatch and 450k–800k Toman inspection/diagnostics. Heavy-equipment values are internal initial estimates pending regional technician and supplier sampling.
