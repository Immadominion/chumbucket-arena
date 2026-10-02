# Gasless SOL top-up — 2 October 2026

A card buys USDC only (Crossmint), and every Panta buy is paid for by the
buyer's own wallet in SOL: the network fee and, the first time in a market, the
rent for a position account. A wallet funded only by card therefore holds USDC
and **0 SOL**, and cannot trade.

The owner's decision: swap about **$1 of the person's own USDC into SOL**
through a swap whose network fee **someone else pays**, so a wallet with 0 SOL
can do it. The person signs the swap with their own wallet (wallet app or the
wallet on their phone) after a clear review. Chumbucket holds no key and pays
nothing.

This page records what was researched (with sources), what the app does, and
what the owner must do.

## 1. Jupiter: what the docs say today

All read on 2 October 2026.

- **The Ultra Swap API is superseded.** Every Ultra page now says: "Ultra Swap
  API is no longer actively maintained and has been superseded by Swap V2"
  ([Ultra overview](https://developers.jup.ag/docs/ultra),
  [Ultra gasless](https://developers.jup.ag/docs/ultra/gasless)). The
  replacement is the **Swap API v2 Meta-Aggregator** path:
  `GET https://api.jup.ag/swap/v2/order` and `POST https://api.jup.ag/swap/v2/execute`
  ([Swap API overview](https://developers.jup.ag/docs/swap),
  [Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute.md),
  [OpenAPI spec](https://developers.jup.ag/docs/openapi-spec/swap/v2/swap.yaml)).
  The [migration guide](https://developers.jup.ag/docs/swap/migration/ultra-to-order.md)
  says the request parameters and response format are the same as Ultra; only
  the base URL changes. No sunset date for Ultra is published. **We build on
  Swap v2.**
- **Flow:** `/order` (with `taker` = the person's wallet) returns a quote and an
  assembled, unsigned base64 transaction plus a `requestId`. The person signs.
  `/execute` takes `{ signedTransaction, requestId }`, lands the transaction
  ("managed landing") and returns `status`, `signature`, and the input/output
  amounts. `/execute` is only for `/order` transactions.
- **Three gasless paths** ([Gasless swaps](https://developers.jup.ag/docs/swap/advanced/gasless.md)),
  identified by `signatureFeePayer` in the `/order` response:
  1. **Jupiter sponsorship** — `signatureFeePayer` is Jupiter's gas wallet
     `gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB`. Applies when the taker holds
     **less than 0.01 SOL**, the trade is **"approximately $10+ (dynamic based
     on the priority fee market)"**, no JupiterZ market maker won the quote, and
     no integrator `payer` is set. Covers all four gas costs (signature fee,
     priority fee, ATA rent, other rent); Jupiter "increases swap fees" to
     recover them, so the taker receives slightly less. **Incompatible with
     `payer` and with `referralAccount` + `referralFee`.**
  2. **JupiterZ (RFQ) market maker** — "Market maker quotes the pair; no
     `payer` set". **No minimum trade size.** The market maker pays signature
     and priority fees; Jupiter's wallet covers the output token account rent
     when no referral fee is set. Depends on a market maker quoting.
  3. **Integrator payer** — pass `payer` (a different wallet) and that wallet
     pays everything; it must sign too, and routing is restricted to Metis.
     This needs a Chumbucket hot wallet that signs server-side and holds SOL. It
     is **not** used (see §6).
- **Determinism:** the spec says "For a deterministic opt-out, check
  `signatureFeePayer == taker` on every response". `gasless: true` means
  "signature and priority fees are paid by a wallet other than the taker".
- **Errors when the transaction cannot be built** (`transaction` is `""`):
  aggregator routers 1 = insufficient funds, 2 = insufficient SOL for gas,
  **3 = swap below minimum for gasless**; JupiterZ 1 = insufficient balance,
  2 = missing token account, 3 = quote could not be built. `/execute` codes:
  -1/-2/-3 (order/tx), -1000…-1004 (aggregator landing), -2000…-2004 (RFQ:
  failed to land, unknown, invalid payload, **quote expired**, swap rejected).
- **Which tokens:** any pair Jupiter routes. USDC → SOL (`So111…112`) is the
  most liquid pair on Solana. For SOL output the transaction unwraps to native
  SOL in the taker's own account.
- **API key:** the spec says "All endpoints require an API key via the
  `x-api-key` header. Get one at [Portal](https://developers.jup.ag/portal)."
  Plans ([Plans](https://developers.jup.ag/docs/portal/plans.md),
  [Rate limits](https://developers.jup.ag/docs/portal/rate-limits.md)): Free
  $0 (1 request/s), Developer $25/mo (10/s), Launch $100/mo (50/s), Pro
  $500/mo (150/s); limits are **per organisation**, 60-second sliding window.
  `/swap/v2/execute` has its own bucket (Free 50 rps) and costs 0 credits.
  Keys are created once and shown once
  ([API keys](https://developers.jup.ag/docs/portal/api-keys.md)). The plans
  page also lists "keyless" access at 0.5 request/s; a keyless `/order` quote
  did answer during this research, but the spec says a key is required, so the
  app treats the key as required.
- **Fees:** the Meta-Aggregator charges a Jupiter platform fee (the overview
  says 5–10 bps; live USDC → SOL quotes today showed `feeBps: 2`). `feeBps` in
  the response "includes the Jupiter platform fee plus any additional charges,
  such as gasless support cost recoup". We set **no referral fee**: it would
  disable Jupiter sponsorship, and Chumbucket takes nothing from this swap.
- **Terms:** use of the API is under Jupiter's
  [API & SDK License Agreement](https://developers.jup.ag/docs/legal/sdk-api-license-agreement)
  and [Terms of Use](https://dev.jup.ag/docs/misc/terms-of-use). Jupiter makes
  no uptime guarantee and may stop the service without notice. The owner should
  read both before switching this on.

## 2. Live checks made for this research (read-only)

No key, no signature, no broadcast. Public endpoints only.

- `GET https://api.jup.ag/swap/v2/order` USDC → SOL without `taker`
  (quote only): $1 → 8,470,153 lamports (SOL ≈ $118), `feeBps: 2`, router
  `metis` or `dflow`.
- The same with `taker` = a freshly generated, empty address (so nothing could
  be built): at $1 the winning router varied between `dflow` (`gasless:
  false`), and `jupiterz` (`gasless: true`, error 2 "Missing associated token
  account" — the empty address has no USDC account); from $1.20 up, `metis`
  reported `gasless: true` (error 1, insufficient funds). With
  `excludeRouters=dflow,okx`, $1 reported `gasless: true` on `metis` in
  `mode: "manual"`. Whether a real $1 swap is sponsored can only be known with
  a funded taker: **error 3 (below the gasless minimum) is possible at $1.**
  The app handles that (see §5).
- `getMinimumBalanceForRentExemption` on mainnet: 0 bytes = **650,240**,
  165 bytes = **1,488,440**, 202 bytes = **1,676,400** lamports. (The 165-byte
  figure was 2,039,280 for years: rent is read live, never hard-coded.)

## 3. How much SOL a Panta buy needs

Read from the eight most recent successful Panta primary buys on mainnet
(program `6gM5afTQBq5VZCfgpGqcsqzfWd5maLSCKWtGjbEobZMp`):

| Item | Lamports | Source |
| --- | --- | --- |
| Signature fee | 5,000 | `meta.fee` of every buy |
| Priority fee | 0 | no ComputeBudget price in Panta's builds (the BFF still caps it) |
| Position account (first buy in a market) | 1,676,400 | inner `createAccount`, 202 bytes, owner Panta |
| USDC account (only if missing) | 1,488,440 | 165 bytes; Crossmint already created it for a card user |
| The wallet's own rent floor | 650,240 | a 0-byte system account must stay rent-exempt |

The app counts **1,686,400 lamports per new position** (rent + a 10,000
lamport fee allowance) on top of the 650,240 floor. Three new positions need
5,709,440 lamports ≈ 0.0057 SOL ≈ $0.67 today. **$1 of USDC buys ≈ 0.0085 SOL,
enough for four new positions.** The server computes this live
(`src/solTopUp/need.ts`) and suggests $1 unless SOL's price means $1 would not
cover three trades, in which case it rounds up in $0.25 steps to at most
`SOL_TOPUP_MAX_USDC` (default $5).

## 4. What the transaction may do (and the real shapes it was built from)

Two real gasless USDC → SOL transactions were read from mainnet (public data)
and kept as test fixtures with the swapper's identity replaced by a synthetic
test key (`tests/fixtures/jupiterGasless.ts`, and the same bytes in the app's
`test/fixtures/jupiter_gasless_fixtures.dart`):

- **Metis, Jupiter-sponsored** —
  `42AfmdyYPyVzo6fW2e4q4GpemmJyBmau5CTCpkZBwB7WCySSj2bHegjXc5eewVdWaFhUuY6NVGExyr9LnHhYTBvd`:
  fee payer `gasTzr…`; ComputeBudget ×2; ATA create-idempotent of the
  swapper's WSOL account **paid by the sponsor**; Jupiter v6 `route_v2`
  (in 12,540,807 USDC, quoted out 106,138,175, slippage 34 bps, fee 11 bps);
  Token `CloseAccount` of the WSOL account **to the swapper**; System transfer
  of 1,488,440 lamports **from the swapper to the sponsor** (the WSOL
  account's rent, which the close had just refunded). Two lookup tables. The
  swapper started with 0 SOL and ended with 106,119,149 lamports.
- **JupiterZ, market-maker-paid** —
  `ZdufciaFaD4d92EC1PGPf5c3TzkzRLBEcZLqGiNcYZweWNQgaTnuZ3gZRGj1dvxxeSNrMUhvbvsRYHE1zgtCfAT`:
  fee payer = the maker; ComputeBudget ×2; JupiterZ `fill` (in 543,057 USDC,
  out 4,597,565 lamports as native SOL); System transfer of 4,597 lamports
  (10 bps) from the swapper to Jupiter's fee account, then `SyncNative` on it.
  No lookup tables. A **$0.54** swap: RFQ has no minimum.

Jupiter v6's instruction layouts come from its on-chain Anchor IDL (account
`C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa`): `route_v2` / 
`shared_accounts_route_v2` start with `in_amount u64, quoted_out_amount u64,
slippage_bps u16, platform_fee_bps u16, positive_slippage_bps u16`; v1
`route` / `shared_accounts_route` end with `in_amount, quoted_out_amount,
slippage_bps u16, platform_fee_bps u8`. JupiterZ's IDL (`order_engine` 0.1.0)
gives `fill(input_amount u64, output_amount u64, expire_at i64)`; live fills
carry up to 5 more bytes the published IDL does not describe — tolerated and
bounded, because the server's simulation proves the exact debit anyway.

**The rules** (server `src/solTopUp/verify.ts`; phone
`lib/features/sol_topup/domain/gasless_swap_check.dart` — the same rules,
independently):

1. v0; 2–3 signers; **fee payer ≠ the person** (Jupiter's gas wallet for Metis,
   the maker for JupiterZ, and equal to the quote's `signatureFeePayer`); the
   person is a writable signer whose signature slot is still empty.
2. Top-level programs only: ComputeBudget, ATA, Token, System, Jupiter v6
   (`JUP6Lk…`), JupiterZ (`61DFfe…`). Exactly **one** swap.
3. The swap spends **exactly the reviewed USDC** from the person's
   **canonical USDC account**, into the person's canonical WSOL account
   (closed back to the person) or as native SOL to the person. A route's
   optional destination override must be empty or the person's own. Mints
   are checked where static and, on the server, after resolving lookup
   tables. ExactOut, token-ledger and every other Jupiter instruction are
   refused.
4. ATA creates are only for the person's own USDC/WSOL accounts and are paid
   by the fee payer, never the person.
5. Token: only `CloseAccount` (person's WSOL → person, by the person) and
   `SyncNative`. Any transfer, approve, set-authority or burn is refused.
6. System: transfers by anyone but the person are the payer's own money
   (tips). From the person, only (a) one rent repayment to the fee payer of at
   most 2,039,280 lamports, and only alongside a sponsor-paid WSOL create and
   its close to the person, and (b) for JupiterZ, one fee payment no larger
   than the quoted `feeBps` of the fill's output, into an account the
   transaction syncs.
7. Fee ≤ 300 bps and ≤ the quote; slippage ≤ 300 bps; a JupiterZ fill expires
   within 10 minutes; the transaction must deliver at least 99% of the quoted
   SOL.
8. Server only: lookup tables resolved and mints checked; then a mainnet
   **simulation** (unsigned, `sigVerify: false`, blockhash not replaced) must
   debit **exactly** the reviewed USDC and credit **at least** the reviewed
   minimum SOL. If the RPC can't answer, nothing is offered.
9. Execute: the signed bytes must carry the **same message** (sha-256), a
   valid ed25519 signature from the person in their slot, and every other slot
   unchanged. One execute per order; a lost reply allows resending only the
   identical bytes.

## 5. What the app does

- **Where it shows up:** (a) Add funds, after a card delivery, when the wallet
  has too little SOL to trade; (b) the Panta trade review, when SOL is
  insufficient; (c) both wallet sheets (wallet app, and the wallet on this
  phone).
- **Review before signing:** "Swap $1.00 USDC → about 0.0085 SOL", "at least
  …", "Network fee: paid by Jupiter" (or "by the market maker quoting this
  swap"), "Jupiter's fee: 0.02% (included)", "covers about N new trades", and
  the wallet it lands in. The wallet app path says "Approve in your wallet";
  the on-phone path says there is no second screen.
- **Below Jupiter's minimum (error 3):** the sheet says Jupiter only pays the
  fee on bigger swaps right now and offers the next amount ($2, then the
  cap), or sending SOL from another wallet. It never quietly swaps more.
- **Unconfigured:** `solTopUp.status` answers `available: false` with a
  reason; the app shows "Swapping USDC for SOL isn't set up yet" and the
  existing "send a little SOL from another wallet" path.

## 6. Alternatives considered

- **Integrator payer (Jupiter `payer`)**: Chumbucket pays gas from its own
  wallet and recovers it with a referral fee. Works at any size, but needs a
  server hot wallet that signs every swap and holds SOL — custody, key
  management and abuse controls this package does not add. Gas recoup would
  also mean charging users a fee.
- **Kora (Solana Foundation fee relayer) / Octane**: a self-hosted fee payer;
  same hot-wallet trade-off, plus running the relayer.
- **Crossmint delivering SOL**: a second card order for SOL. Card minimums
  and fees make a $1 SOL purchase uneconomic, and it is a second checkout.
- **Sending SOL from elsewhere**: still offered everywhere as the fallback.

## 7. Owner actions

1. Read Jupiter's API licence and terms (links in §1) and accept them for
   Chumbucket.
2. Create a Jupiter Developer Platform account and an API key with only the
   **Swap** permission (<https://developers.jup.ag/portal>). Free (1 rps) is
   enough to start; Developer ($25/mo, 10 rps) if swaps queue.
3. On the calls BFF (`chumbucket-calls-bff`): set `JUPITER_API_KEY`, then
   `SOL_TOPUP_ENABLED=true`. Optional: `SOL_TOPUP_TARGET_USDC` (default `1`),
   `SOL_TOPUP_MAX_USDC` (default `5`), `JUPITER_MIN_INTERVAL_MS` (default
   `1100`; lower it on a paid plan). `SOLANA_RPC_URL` must be a mainnet RPC
   that allows `simulateTransaction` and `getAddressLookupTable` (a paid RPC is
   recommended; the public one rate-limits).
4. Deploy the API branch, then the app.
5. On a device, with a wallet holding ~$2 USDC and 0 SOL: Profile → My wallet →
   "Get SOL for fees" → review → sign. Confirm the SOL arrives and a small
   Panta trade then goes through. Do this once with a wallet app and once with
   the wallet on the phone.
6. Emergency stop: `SOL_TOPUP_ENABLED=false` (swaps stop being offered; nothing
   else changes).
