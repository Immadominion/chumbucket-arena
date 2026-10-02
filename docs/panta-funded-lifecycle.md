# Funded Panta positions after the buy — 2 October 2026

This extends `docs/panta-native-trading.md` (the wallet-approved primary buy)
with the rest of a funded position's life: reconciliation, positions, claims,
the funded-call marker and the call cut-off. Nothing here changes the buy path's
contract: approval is still not a fill, and a fill still needs provider
attribution plus independent RPC proof of the exact USDC debit.

## What Panta's public API supports (read 2026-10-02)

Sources: `docs.panta.market/llms.txt`, `api-reference/positions.md`,
`claims/build.md`, `trades/report.md`, `orders/verify.md`, `guides/how-it-works.md`,
`guides/errors.md`.

| Need | Panta endpoint | Used here |
| - | - | - |
| Holdings by wallet | `GET /positions/?wallet=` (shares, side, phase, `claimable`, `claimed`, `outcome`) | claim eligibility, wallet share totals |
| Win claim | `POST /claim/build/ {wallet, marketId}` → unsigned `claim_win_usdc` instructions | `pantaTrading.claimPrepare` |
| Claim attribution | `POST /trades/` (kind `claim`), optional | best effort after proof |
| Order status | `POST /primaryorderverify/` | reconciler (unchanged buy proof) |
| **Sell / close** | **none** — the public API has primary buys only | link to `https://panta.market/market/<id>` |

Rate limits are per API key and shared by every Chumbucket user: `positions`
60/min, `build` 20/min, `register` (submit, verify, trade report) 40/min.

## Server pieces

- **Reconciler** (`src/prediction/PantaReconciler.ts`, started in `src/index.ts`).
  Every `PANTA_RECONCILE_TICK_MS` (default 20 s, min 5 s) it re-verifies up to 8
  SUBMITTED buys and 8 SUBMITTED claims through the same transition a person's
  own "check" uses, backing off 15 s → 10 min per pending row. It runs whenever
  the native Panta configuration is ready for reads; the emergency pause
  (`FUNDED_POSITIONS=false`) stops new approvals, never reconciliation.
  `PANTA_RECONCILER_ENABLED=false` turns it off.
- **Definitive failure** (`PantaTradingService.reconcile`). FAILED now needs one
  of two chain facts: a confirmed on-chain error, or (new) the signature unseen
  both before and after a finalized block height more than 150 blocks past the
  approval's `lastValidBlockHeight` (`PantaSettlementChain.neverLanded`). A
  FAILED buy stops blocking a fresh funding of that call. Provider statuses alone
  never decide FAILED or FILLED. "Never landed" is only trusted when Panta
  answered and did not report the order `confirmed`: if Panta confirmed it but
  this RPC cannot see the signature (pruned history, lag), the order stays
  SUBMITTED rather than hiding a buy that may have debited USDC. A confirmed
  on-chain error still fails the order even while Panta's verify is unreachable.
- **Positions** (`pantaTrading.positions`, POST, session only). One row per
  funded call: cost (the proven USDC debit), Panta's quoted shares for that buy,
  all-in entry price, current side price while open (latest captured Panta share
  price), 1/0 after a published result, value and PnL in USDC base units, the
  wallet's Panta-reported share total, claim state, and the Panta market link.
  Status: `pending`, `failed`, `open`, `awaiting_result`, `won_claimable`, `won`,
  `claiming`, `claimed`, `lost`, `void`. Missing sources give null figures, never
  zeros. Holdings are cached 30 s per wallet under a 40/min budget.
- **Claims** (`pantaTrading.claimPrepare/claimSubmit/claim`). Exactly the buy
  path's discipline: durable intent keyed by the person's idempotency key, Panta
  claim build, a doc-derived instruction profile (`src/prediction/PantaClaims.ts`),
  reviewed approval saved before any wallet sees it, exact message + owner
  signature check, signed bytes saved before broadcast, and CONFIRMED only after
  `PantaSettlementChain.verifyClaim` proves the exact message succeeded and
  credited the owner's native USDC. A claim must belong to one of the person's
  own FILLED buys (wallet + market + order), enforced in TypeScript and SQL.
- **Funded-call marker** (`src/prediction/PantaFunding.ts`). Feed, call detail
  and market detail entries carry `funding: {state:"FILLED", venue:"panta",
  fundedAt}` only for a call with a confirmed fill. No amount, wallet or order id.
  `calls.funding_state` remains the immutable free/funded provenance (§3), so
  free-call accuracy is unaffected and the column is never rewritten.
- **Call cut-off (M14)**. New calls and back/fade close
  `CALLS_CLOSE_CUTOFF_MINUTES` (default 30, 0–1440) before the market closes.
  `markets.open` hides markets inside the window; `markets.detail` returns
  `callsCloseAt` and `callCutoffMs`; a refused call names the window.

## Claim instruction profile — doc-derived, not yet observed live

No winning position existed to observe a live claim build, so the profile is
narrow and fails closed (the app then links to panta.market):
one `claim_win_usdc` instruction (Anchor discriminator) on the pinned program
naming the owner as signer, the market, `winClaim`, `positionPda`,
`vaultAuthority` and the owner's canonical USDC account (writable); optional
bounded ComputeBudget and owner-ATA create-idempotent before it; an optional
owner-signed Memo after it; no other program; owner is the only signer and fee
payer; no lookup tables. **Owner action:** the first real winning claim should
be watched end to end; if Panta's build differs, adjust the profile from that
observation rather than loosening it blindly.

## Schema

`supabase/migrations/20261002170000_panta_claim_sessions.sql` (mobile repo),
additive only: `panta_claim_sessions` with RLS on, no client rights,
service-role SELECT/INSERT and column-scoped UPDATE, a guard trigger (own FILLED
buy only, immutable intent, one approval, permanent history, valid transitions),
JSON CHECKs on the reviewed binding and the confirmation evidence, and a
partial unique index for one in-flight/settled claim per wallet and market.
Proven on a disposable PostgreSQL 15 with the existing trade-ledger suite:
`bun --no-env-file scripts/verify-panta-trading-local.ts --run` (68 pass).
The panta_trade_sessions table and legacy default grants are unchanged; an
owner TRUNCATE of the trade ledger is now refused by the claim ledger's foreign
key before its own guard (either refusal keeps the history).

## Configuration (new, all optional)

`PANTA_RECONCILE_TICK_MS`, `PANTA_RECONCILER_ENABLED`, `CALLS_CLOSE_CUTOFF_MINUTES`,
and `PANTA_CLAIM_SCHEMA_READY=true` — set only after the claim-ledger migration
is applied. Until then claims answer "not configured" (the app links to
panta.market to claim) while positions and buy reconciliation keep working.
Claims otherwise reuse the existing Panta key, program, partner and RPC config.
