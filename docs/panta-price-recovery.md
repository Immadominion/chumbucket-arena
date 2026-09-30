# Panta missing-price recovery — 30 September 2026

## Reproduction and cause

The dedicated production calls BFF answered `markets.open(category: crypto)`
with HTTP 200 and an empty list. Its native funding status was still enabled;
neither the provider selection nor the funding switch caused this symptom.

Read-only database checks at 15:59–16:00 UTC found three OPEN Panta crypto
markets with future close times, no existing resolutions, and recently saved
share-price evidence. All three latest observations had **both side prices
null**. Bounded, allowlisted worker log samples showed successful catalog
passes, not a quarantined writer. No account rows or credentials were printed.

A subsequent public `predictions.indicativePrices` read for the near-term ETH
market returned actual non-null side prices. The eight-check production smoke
then passed with one call-ready market. That query warmed/persisted venue price
evidence through the existing public read path; it did not create a call/order,
sign or broadcast anything. This proves recovery of that read at that instant,
not that the provider never returns null again.

Panta's [market detail documentation](https://docs.panta.market/api-reference/markets/get)
says its spot-price fields depend on RPC availability. We did not independently
establish the cause of the provider's null responses. The **confirmed local
defect** was that `MarketSync` treated a null-price observation as fresh for the
same ten-minute interval as a complete observation. That can keep discovery
empty after the provider has recovered. Complete prices were also scheduled
for refresh only at the exact ten-minute call-validity boundary.

## Scoped correction

- Missing either Panta side: retry after one minute on a subsequent catalog
  pass, within the existing per-pass budget and adapter pacing/cache limits.
- Complete Panta prices: refresh after five minutes, leaving headroom before
  the unchanged ten-minute validity deadline. An explicit shorter refresh
  override still wins. Legacy probability snapshots retain their old interval.
- Keep every captured observation/evidence immutable. A newer null observation
  still makes a market uncallable; never substitute the previous price, invent
  a complementary price, increase permitted age, or substitute another venue.
- These intervals are retry thresholds, not guaranteed availability SLAs:
  pagination, RPC outages, provider refusal and queue failure can delay recovery.

Five new regression cases cover both-null / missing-YES / missing-NO recovery,
continued absence, and early complete-price refresh followed by a newer null.
They exercise the real Panta adapter with synthetic transport, the sync, the
store and call discovery/locking. Existing schema/evidence/closed-market tests
remain in place. Production rollout and final suite evidence are recorded in
the mobile checkpoint and root handoff; this document alone is not deploy proof.

## Deployment preparation incident and prevention

The first source export for this change omitted `vendor/`. The shared server
statically imports `vendor/txline/idl/txoracle.json` and
`vendor/chumbucket_arena/chumbucket_arena.json` even with old trading disabled.
Deployment `ef7fc3d1-cb6f-4ed3-9903-a7e023d54110` consequently crashed before
startup. This was an implementation-agent packaging error, not a Panta outage.

The corrected export included the committed vendor IDLs and TypeScript config;
a local external-package Bun build resolved all 113 local modules before the
replacement upload. Deployment `3eac1d25-ebfc-464e-9e5f-f8707952d73b` then reached
SUCCESS. Neither runtime variables nor database schema were changed. The
original Arena service stayed HTTP 200.

Use `bun --no-env-file scripts/prepare-calls-deploy.ts --prepare` for future
uploads. It exports only reviewed committed runtime paths, refuses uncommitted
runtime files and credential-like filenames, checks required vendor files, and
validates the exported import graph **before** returning a directory to upload.
Its validation output lives outside the artifact. It does not deploy or start
the application. The incomplete original export fails that same local Bun
import check; the complete one passes. Filename checks are not a substitute
for credential scanning/review of source contents.
