# Panta catalog recovery — 1 October 2026

User approved all Panta categories with optional UI filters and explicitly approved
deployment of this narrowly scoped fix to the existing calls BFF.

## Confirmed failure

Public `predictions.listEvents` returned HTTP 500 / VENUE_SCHEMA, “catalog envelope”.
A read-only upstream shape probe (key held only in process memory, never logged)
returned HTTP 200, `items` array, and a **134-character, non-base58 nextCursor**.
The adapter incorrectly required a 32-byte Solana public key for pagination.
Two pages passed through the corrected adapter locally; both contained no
complete displayable events, but the continuation survived. This alone does not
prove that the complete upstream catalog has no markets.

Separately, `markets.open` deliberately excludes stale/missing prices. The old
mobile screen then imposed crypto-only and 4-hour–7-day restrictions. That endpoint
is a call-ready list, not a complete discovery catalog.

## Changes

- Validate pagination as bounded opaque text, URL-encoded on the request. Keep
  market public-key validation, schema checks and resolution evidence unchanged.
- Add public paginated `predictions.catalog` from the normalized durable mirror,
  independent of prices. Only the configured Panta/explicit fixture venue appears.
- Sync all Panta categories using a new `:panta:all` cursor; preserve previous
  crypto and other-provider cursors for rollback. Existing worker budgets remain.
- Keep `markets.open`, free-call price freshness, trade controls, wallet proofs,
  credentials and all database schemas unchanged. Normal catalog-worker writes
  continue through the existing evidence-checked durable path.

## Pre-deploy verification and rollback

- `bun --no-env-file run typecheck`: exit 0, no diagnostics.
- `bun --no-env-file test`: **1005 pass, 103 skip, 0 fail**, 3387 assertions,
  1108 tests / 66 files. Skips include opt-in database tests; no migration changed.
- Live read-only probe: corrected adapter accepts the upstream continuation and
  requests a second page. No call, trade, signature or transaction was made.
- Export only committed allowlisted runtime files using `prepare-calls-deploy.ts`;
  require its import-graph check (including the existing vendor IDLs).
- No CI/staging run claimed; this is a local tested change with explicit founder
  production approval. Deployment result and handset checks are recorded in the
  mobile checkpoint, not inferred from an upload succeeding.
- Roll back if health fails, native trading configuration changes, the catalog
  route fails, or the worker persistently errors. Prior successful deployment:
  `3eac1d25-ebfc-464e-9e5f-f8707952d73b`. Restore its source/image; no database
  rollback or credential change is needed. Existing clients retain `markets.open`.

Provider contract: [list markets](https://docs.panta.market/api-reference/markets/list)
documents opaque pagination and null list prices;
[market detail](https://docs.panta.market/api-reference/markets/get) supplies
RPC-dependent prices. Missing prices must not erase a valid prediction from browsing.
