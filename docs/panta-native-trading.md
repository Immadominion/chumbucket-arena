# Native Panta buys — 29 September 2026

The existing app can optionally fund **its own** Panta call through
`pantaTrading.status/prepare/submit/order/forCall` (POST). Calls and positions
remain separate. No new person, wallet custodian, copy-trade or public stake
field is introduced. The generic wallet-string order route remains closed.

## Contract and safety

- GoTrue verifies the bearer session; `public.users.id` identifies the caller.
  The selected wallet must sign the exact reviewed message. Client person ids
  are rejected. A wallet string or old DevAuth session cannot authorize a buy.
- `prepare` reserves a durable, person-scoped idempotency key, obtains a live
  quote/build, validates the observed primary-buy instruction profile and saves
  the immutable approval before returning its unsigned transaction.
- Panta's native Memo identifies the **key-bound partner account**, not the app
  person. `PANTA_PARTNER_USER_ID` pins that attribution; the canonical person
  stays private in the ledger. A different partner cannot replay the approval.
- Only one wallet signature, the pinned mainnet program, exact YES/NO side,
  exact USDC deposit, canonical owner ATA and bounded compute/Memo instructions
  are permitted. No arbitrary token transfer, recipient, extra signer or lookup
  table is accepted. The profile is based on live unsigned observations, not a
  published authoritative IDL.
- `SUBMITTED` plus exact signed bytes is committed before RPC broadcast. A
  lost reply/restart reconciles that order; retries reuse identical bytes.
  A partial unique index admits one active/filled funding per call and wallet.
- `FILLED` requires provider confirmed attribution, processed buy report and
  successful confirmed mainnet RPC evidence for the identical message, owner,
  market, program and **exact owner USDC debit**. A provider failure alone cannot
  release the duplicate-buy guard. Free calls are never rewritten as funded.
- Private recovery uses the session-scoped `forCall`; DTOs never dump signed
  approvals, internal bindings or reconciliation evidence. Emergency pause
  refuses prepare/submit but preserves existing order/recovery reads.
- Native execution independently verifies mainnet genesis. Do not globally
  switch the social namespace: existing devnet-era follows/history still belong
  to the same people. The mobile adapter requests mainnet authorization for this
  signing session only, leaving the old wallet grant/network intact.

## Configuration

Server-held live `PANTA_API_KEY`; `PREDICTION_VENUE=panta`;
`PANTA_PROGRAM_ID=6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp`;
verified key-bound `PANTA_PARTNER_USER_ID`; `PANTA_SCHEMA_READY=true` only after
the reviewed native-price and intent-ledger migrations; secure mainnet
`SOLANA_RPC_URL`; existing Supabase service credentials. `FUNDED_POSITIONS=true`
enables the native route; false is an emergency pause. Default per-approval
limit is `PANTA_MAX_AMOUNT_BASE_UNITS=100000000` (100 USDC). Keys stay out of
Flutter, git, container build inputs and logs.

The dedicated production calls BFF is the rollout target, **not** the original
Arena Railway service. Preserve `SOLANA_NETWORK` and disable unrelated keeper /
reconciler execution on this dedicated service. No exposed deploy key is used.

## Verification / limitations

Full local suite: 978 pass, 102 skip, 0 fail; 3230 assertions across 61 files;
typecheck exit 0. Separate fresh PostgreSQL 15 run: 62 pass, 0 fail, 437
assertions, including concurrent approvals and default-deny role checks.
The isolated cluster was stopped; the existing system PostgreSQL was untouched.
Default-suite skips are optional database tests; the 62 ledger checks ran in the
separate real-database invocation.

A live ETH September-30 crypto-market NO quote/build for 2 USDC produced a
validated **706-byte unsigned** transaction, with exact native partner Memo and
private canonical identity. No wallet signing, broadcast or real fill occurred.
An earlier BBNaija build returned `INVALID_MARKET_PARAMS`; that market was not
silently substituted, its rules corrected or its result invented. Venue
refusals remain refusals and never become wallet-signable approvals.

The mobile sheets disclose USDC risk, SOL fees/rent, and that in-app selling /
claims are not implemented in this increment. Real Google-to-existing-person
linkage, physical MWA approval and an explicitly chosen small trade still need
device verification. No app-store release, funded position, eligibility approval
or credential remediation is claimed from synthetic/local/unsigned tests.

## Deployment / rollback

Record the exact new deployment and production smoke results in the mobile
checkpoint. Prior dedicated BFF deployment:
`dc76cade-6395-43d9-ba1b-cc9d65079da7`.
Rollback schema by **retaining** the additive tables/evidence, not dropping them.
Pause new approvals with `FUNDED_POSITIONS=false`; order/recovery must keep
working. Before any Panta call/order exists, the previous image can be restored
with its original provider configuration. After one exists, use pause and a
corrected native image: the old image cannot reconcile these approvals.

Rollback/stop triggers: failing hydration, wrong provider, lost canonical
profile/history, unauthorized order access, false funded state, or mainnet
verification failure. Do not broadcast a second approval to repair a first one.
