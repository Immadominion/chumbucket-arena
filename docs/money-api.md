# Money API (Chumbucket Money v1)

The server contract the web and mobile apps build against for calls with an
amount, the wallet sheet, winnings, deposit options and gas. Spec:
`fleet/money-v1.md` (the "money" section, product rules, UI laws, hard rules).

Everything new is behind **`MONEY_CALLS_ENABLED`** (exact lowercase `true`, or
`admins` for the `TRUST_ADMIN_USER_IDS` accounts only; default off; see
"Staged rollout" below). Off, every existing procedure answers exactly as
before, and every `money.*` procedure except `money.status` refuses with
`PRECONDITION_FAILED` ("Calls with money aren't available yet.").

## Rules this contract keeps

1. **Nothing is funded before a confirmed fill.** A call with money intent is
   `PENDING` until its Panta order is `FILLED`, and `FILLED` still means what it
   meant before: Panta's confirmation plus an RPC-proven USDC debit
   (`PantaTradingService.reconcile`). No client ever says a trade is done.
2. **The venue and the chain are authoritative.** Balances, fills, payouts,
   cash outs and deposits are read from Panta and mainnet. Nothing is
   estimated or simulated in a product path; when a source is down the answer
   says so (an error, or a missing optional item), never a made-up number.
3. **One account resolver.** Every procedure resolves the session through
   `src/auth/accountResolver.ts`. No input names a person. A `wallet` input
   only SELECTS among the account's own proven wallets (an active SIWS link, or
   the wallet this session signed in with); anything else is refused.
4. **No ghosts.** A pending call is visible to its owner only, never counts
   toward a record, a crowd split, top calls, suggestions or notifications,
   and either becomes public (funded), is replaced by a fresh free call
   (keep free), or expires.
5. **Money is dollars on screen, integers on the wire.** Every amount is USDC
   base units (6 decimals) as a decimal integer string. `"5000000"` is `$5`.
   Probabilities stay `[0,1]` numbers; clients render percent.

Transport: every private `money.*` procedure is a POST **mutation** (the
Supabase session rides in `Authorization`; nothing private lands in a URL),
like `wallet.*` and `deposits.*`. Inputs are `.strict()`: an unknown key is a
loud `BAD_REQUEST`.

Shared zod pieces used below:

```ts
const baseUnits = z.string().regex(/^[1-9][0-9]{0,15}$/);          // > 0
const wallet = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);  // base58
const uuid = z.string().uuid();
const side = z.enum(["YES", "NO"]);
// 16–96 chars; the server derives the per-attempt Panta key from it.
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{15,95}$/);
```

## Error codes (all `money.*`)

tRPC code + a readable `message` (render it verbatim; it is our copy, never a
provider's). Expected, actionable outcomes are NOT errors: they come back as a
`status` the app branches on (`NEEDS_FUNDS`, `NEEDS_GAS`, `INVALID`, …).

| code | when |
|---|---|
| `UNAUTHORIZED` | signed out, or the session is invalid |
| `FORBIDDEN` | the session is not linked to an account yet |
| `PRECONDITION_FAILED` | `MONEY_CALLS_ENABLED` off; Panta trading paused/unconfigured; market not taking calls; a market our trade path cannot buy on (SOL-quoted: "This market takes free calls only."); the money call is not in a state that allows this action; a call or transfer review that timed out |
| `NOT_FOUND` | no such money call / transfer / market / call **on your account** (someone else's reads as not found) |
| `CONFLICT` | an idempotency key reused with different details; an order is still going through; another transfer from the same wallet is in flight (`TRANSFER_IN_FLIGHT`, see below) |
| `BAD_REQUEST` | malformed input; amount outside the limits; your own call on Back/Fade; a wallet approval that does not match the reviewed transfer |
| `UNPROCESSABLE_CONTENT` | the chosen wallet is not linked to the account (`WALLET_NOT_LINKED`: lead with "link this wallet") |
| `TOO_MANY_REQUESTS` | per-account rate limit |
| `SERVICE_UNAVAILABLE` / `BAD_GATEWAY` | the database, Panta or the RPC could not answer; nothing was signed or charged |

## Refusal reasons (`error.data.details.reason`)

Every `money.*` error carries `data.details = { reason, … }` with a stable
code, so an app branches on `reason` and shows `message`. Expected outcomes
are not errors at all: `NEEDS_FUNDS`, `NEEDS_GAS`, `INVALID` (with its own
`reason`), `READY`, `SETTLED` and `SENT` come back as `status` in a normal
answer.

| reason | tRPC code | when |
|---|---|---|
| `DISABLED` | `PRECONDITION_FAILED` | money calls are off (for this account) |
| `SIGNED_OUT` | `UNAUTHORIZED` | no session |
| `NOT_LINKED` | `FORBIDDEN` | the session has no account yet |
| `NO_WALLET` | `PRECONDITION_FAILED` | the account has no wallet yet |
| `WALLET_NOT_LINKED` | `UNPROCESSABLE_CONTENT` | the chosen wallet is not the account's |
| `AMOUNT` | `BAD_REQUEST` | amount outside $1 … the server limit, or not whole cents |
| `NOT_TRADABLE` | `PRECONDITION_FAILED` | a SOL-quoted market: free calls only |
| `MARKET_CLOSED` | `PRECONDITION_FAILED` | the market stopped taking calls |
| `PRICE_MOVED` | `PRECONDITION_FAILED` | a re-quote outside the call's slippage of its locked price: make a new call |
| `PRICE_UNAVAILABLE` | `SERVICE_UNAVAILABLE` | no readable price right now: try again in a minute |
| `CALL_EXPIRED` | `PRECONDITION_FAILED` | the pending call's window passed |
| `REVIEW_EXPIRED` | `PRECONDITION_FAILED` | a transfer review expired (prepare again with a new key) |
| `STATE` | `PRECONDITION_FAILED` | the money call is no longer pending (funded, free or expired) |
| `IN_FLIGHT` | `CONFLICT` | a buy for this call is still going through |
| `TRANSFER_IN_FLIGHT` | `CONFLICT` | another transfer from this wallet is in flight; `transferId` names it |
| `IDEMPOTENCY_CONFLICT` | `CONFLICT` | a key reused with different details |
| `BAD_SIGNATURE` | `BAD_REQUEST` | the approval doesn't match the reviewed transaction |
| `NOT_FOUND` | `NOT_FOUND` | not your money call / transfer |
| `RATE_LIMITED` | `TOO_MANY_REQUESTS` | too many tries in a minute |
| `UNAVAILABLE` | `SERVICE_UNAVAILABLE` | the database, Panta or the RPC could not answer |
| `CALL_ALREADY_MADE`, `RESPONSE_SELF`, `RESPONSE_DUPLICATE` | `CONFLICT` / `BAD_REQUEST` | the call refusals of `calls.create` / `calls.respond` |
| `TRADING_PAUSED` | `PRECONDITION_FAILED` | Panta trading is paused or not configured |

Other refusals (content policy, blocks, generic failures) carry no `details`.

## Shapes

```ts
type MoneyCallState = "PENDING" | "FUNDED" | "FREE" | "EXPIRED";
// The latest Panta order for the call: NONE before the first quote.
type TradeState = "NONE" | "QUOTED" | "SUBMITTED" | "FILLED" | "FAILED";

interface MoneyCallView {
  callId: string;                 // the call this money intent funds
  kind: "own" | "back" | "fade";  // UI: Call / Tail / Fade
  targetCallId: string | null;    // back/fade: the call tailed or faded
  marketId: string;
  side: "YES" | "NO";
  amountBaseUnits: string;        // the intent, e.g. "5000000"
  wallet: string;                 // the account's own wallet that pays
  state: MoneyCallState;
  trade: TradeState;
  orderId: string | null;         // the latest Panta order (pantaTrading.* handle)
  filledBaseUnits: string | null; // set only when state is FUNDED
  createdAt: number;              // unix ms
  updatedAt: number;
  expiresAt: number;              // PENDING only means something before this
  canRetry: boolean;              // PENDING, no order going through
  canKeepFree: boolean;           // PENDING, no order going through, market still taking calls
  canDiscard: boolean;            // PENDING, no order going through
}

// Added to CallFeedEntry (calls.feed/get, people.get, markets.detail.viewerCall, …):
interface CallFeedEntry {
  // …existing fields unchanged…
  /** FILLED calls only (public). With MONEY_CALLS_ENABLED it also carries the
   *  filled amount and side, for "$5 on YES" receipts and cards. */
  funding?: { state: "FILLED"; venue: "panta"; fundedAt: number;
              amountBaseUnits?: string; side?: "YES" | "NO" } | null;
  /** The OWNER's view of their own pending or expired money call. Never sent
   *  to anyone else (they never see the call at all). */
  money?: { state: "PENDING" | "EXPIRED" | "FREE"; amountBaseUnits: string; side: "YES" | "NO"; expiresAt: number };
}
```

A receipt or card shows `$5 on YES` from `funding.amountBaseUnits` +
`funding.side` (sum of the confirmed fills on that call), and `Free` when there
is no `funding`. A `money.state: "PENDING"` entry is never stamped funded.

## (a) A call with an amount

One flow for your own call and for Tail/Fade on someone else's call.

```
prepareCall ─┬─ NEEDS_FUNDS → deposit sheet → (funds land) → prepareCall again (same key)
             ├─ NEEDS_GAS   → solTopUp.order/execute → prepareCall again (same key)
             └─ READY: call created PENDING (owner-only) + Panta quote
                   → sign (signer checks the buy) → pantaTrading.submit
                   → money.callStatus (poll) → FUNDED (public, "$5 on YES")
                                             → trade FAILED / quote expired:
                                                 money.retry   → READY again
                                                 money.keepFree → a NEW free call at today's price (pending one withdrawn)
                                                 money.discard  → EXPIRED
                   (no choice made by expiresAt → EXPIRED, never shown)
```

### `money.prepareCall` (mutation)

```ts
input: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("own"), marketId: z.string().min(1).max(256), side, ...common }).strict(),
  z.object({ kind: z.literal("back"), targetCallId: z.string().min(1).max(256), ...common }).strict(),
  z.object({ kind: z.literal("fade"), targetCallId: z.string().min(1).max(256), ...common }).strict(),
])
common = {
  amountBaseUnits: baseUnits,          // whole cents (multiple of 10000), ≥ $1, ≤ server max
  idempotencyKey,                      // one per tap; reuse it on every retry of the same tap
  wallet: wallet.optional(),           // select one of your own wallets; default: the trading wallet
  confidence: z.number().min(0).max(1).nullish(),
  thesis: z.string().max(280).nullish(),
  visibility: z.enum(["public", "followers"]).default("public"),
  maxSlippageBps: z.number().int().min(0).max(500).default(100),
}

output:
  | { status: "NEEDS_FUNDS"; wallet: { address: string; walletType: string };
      balanceBaseUnits: string; neededBaseUnits: string; shortfallBaseUnits: string }
  | { status: "NEEDS_GAS"; wallet: { address: string; walletType: string };
      topUp: { amountBaseUnits: string } | null }
  | { status: "READY"; moneyCall: MoneyCallView; call: CallFeedEntry;
      trade: { order: UnsignedOrder; review: PantaOrderReview } }   // = pantaTrading.prepare's answer
  | { status: "SETTLED"; moneyCall: MoneyCallView; call: CallFeedEntry } // key replayed after FUNDED/FREE/EXPIRED
```

- The trading wallet is the Chumbucket wallet when `CHUMBUCKET_WALLET_ENABLED`
  is on and linked, else the session's wallet, else the primary link
  (`chooseTradingWallet`). No wallet at all: `PRECONDITION_FAILED` "Set up
  your wallet first."
- `kind: "back"` takes the target's side, `"fade"` the opposite side (Tail /
  Fade in the UI). Your own call, an already-answered call, a call you cannot
  see, or a market that is closed/at its cut-off are refused exactly like
  `calls.respond` / `calls.create` refuse them. A market Panta's USDC buy
  cannot trade (SOL-quoted) is refused before anything is created.
- **Checks before anything is created, in order:** gas, then funds. Nothing is
  written for `NEEDS_FUNDS` or `NEEDS_GAS`.
  - `NEEDS_GAS`: the wallet's SOL cannot pay one Panta buy (fee + the
    position account's rent, from `src/solTopUp/need.ts`). `topUp` is the
    gasless USDC→SOL swap to run first (`solTopUp.order` with that
    `amountBaseUnits` and the same `wallet`, sign, `solTopUp.execute`), or
    `null` when the top-up is unavailable on this server (show the generic
    error state; never ask the person for SOL).
  - `NEEDS_FUNDS`: `balance < amount (+ the top-up's USDC when gas is
    needed)`. `shortfallBaseUnits` feeds the deposit sheet
    (`money.depositOptions({ amountBaseUnits: shortfall })`). Watch
    `money.wallet` and, when the balance covers it, call `prepareCall` again
    with the SAME input and key: the call then continues by itself.
- `READY`: the call is locked now (server-stamped price, exactly like
  `calls.create`), recorded with money intent `PENDING`, and quoted on Panta for
  `wallet`. Sign `trade.order.transaction.payload` with a signer that runs the
  Panta buy check (web: `checkedSigner` in `web/lib/webapp/trade.ts`), then
  submit with the existing **`pantaTrading.submit({ orderId, signedTransaction })`**.
- Replaying the same key with the same input is safe: a live quote comes back
  unchanged; an expired quote is re-quoted (a new attempt) while the call is
  still `PENDING` and nothing is going through; after `FUNDED`/`FREE`/`EXPIRED`
  the answer is `SETTLED`. The same key with different input: `CONFLICT`.

### `money.callStatus` (mutation, polled; does not spend the write budget)

```ts
input:  z.object({ callId: uuid }).strict()
output: { moneyCall: MoneyCallView; order: VenueOrder | null }
```
Re-checks a `SUBMITTED` order against Panta and the chain (the same transition
`pantaTrading.order` and the server reconciler use), then answers. `FUNDED`
only after that transition wrote `FILLED`. Owner only.

### `money.retry` (mutation)

```ts
input:  z.object({ callId: uuid, wallet: wallet.optional() }).strict()
output: same union as prepareCall minus SETTLED
```
A fresh Panta quote for a `PENDING` call whose last order `FAILED`, whose
quote expired, or that has none, inside the call's window (it never extends
it). Re-runs the gas and funds checks. A live, unsigned quote is returned as is
(a dropped reply never builds a second one). A re-quote is made only while the
call's side still trades within its `maxSlippageBps` of the price the call was
locked at; otherwise `PRECONDITION_FAILED` "The price moved since you made this
call. Make a new call." (`PRICE_MOVED`), and the person starts a new call. No
readable price: `SERVICE_UNAVAILABLE`. Refused with `CONFLICT` while an order is
`SUBMITTED` ("Your $5 is still going through."), `PRECONDITION_FAILED` after
`PENDING` or past `expiresAt`.

### `money.keepFree` (mutation)

```ts
input:  z.object({ callId: uuid }).strict()
output: { moneyCall: MoneyCallView; call: CallFeedEntry } // call = the NEW free call
```
Go free instead. The pending call's locked price is never kept (that would let
someone watch the price, then keep the old one). Instead:
- the pending money call becomes `FREE`: withdrawn (hidden with reason
  `money_call_kept_free`), owner-only, on no record;
- its live unsigned quote is retired, so it can no longer be signed;
- a **new** free call is made at the current price and time through the
  ordinary free path (`calls.create`, or `calls.respond` for a Tail/Fade, with
  all of their checks and the same side, thesis, confidence and visibility).
  `call` is that new call: a new `call.id`, `lockedAt` now, the `Free` marker.
  A Tail/Fade counts on its target once, through the new call.

Refusals leave the pending call exactly as it was (to retry, discard or
expire): an order `SUBMITTED` → `CONFLICT`; the market stopped taking calls →
`PRECONDITION_FAILED` (`MARKET_CLOSED`, "…there's no free call to make.");
no readable price right now → `SERVICE_UNAVAILABLE` ("This market's price
isn't available right now. Try again in a minute."); past `expiresAt` →
`PRECONDITION_FAILED` (the call is expired). Replaying `keepFree` after it
succeeded answers with the same new free call. If the buy filled after all,
the answer is the `FUNDED` call instead.

### `money.discard` (mutation)

```ts
input:  z.object({ callId: uuid }).strict()
output: { moneyCall: MoneyCallView }
```
`PENDING → EXPIRED` now (the person closed the sheet for good); its live
unsigned quote is retired. Refused while an order is `SUBMITTED`.

### `money.pending` (mutation)

```ts
input:  z.object({}).strict().optional()
output: { calls: Array<{ moneyCall: MoneyCallView; call: CallFeedEntry }> }
```
The account's `PENDING` money calls, newest first, so an app that restarts can
offer "finish, keep free or discard" instead of leaving a ghost.

### States and transitions

| from | to | who | condition |
|---|---|---|---|
| — | `PENDING` | `prepareCall` (`READY`) | intent row written durably BEFORE the call exists |
| `PENDING` | `FUNDED` | the fill transition only | a `FILLED` `panta_trade_sessions` row for this call (SQL-checked) |
| `EXPIRED` / `FREE` | `FUNDED` | the fill transition or the sweeper | the call's OWN LAST quote (current attempt key) filled and that quote expired no later than the call did; never after `discard` (SQL-checked) |
| `PENDING` | `FREE` | owner (`keepFree`) | no `SUBMITTED` order; market taking calls; price readable; the new free call made first |
| `PENDING` | `EXPIRED` | owner (`discard`) or the sweeper | no `SUBMITTED`/`FILLED` order (SQL-checked) |

- `expiresAt` = the FIRST quote's expiry + 60 s (about two minutes; two
  minutes from creation until a first quote exists). It is never extended, by
  a retry or anything else: a call held open longer could wait to see where
  the price goes and fund only the winners.
- A money call is traded only through `money.*`, only while `PENDING`, only
  with its current attempt's quote, and only inside its window:
  `pantaTrading.prepare` refuses every money call ("This call was made with an
  amount. Fund it from the call itself."); `pantaTrading.submit` re-checks the
  money call before anything is stored or broadcast ("This call's money
  window has closed. Make a new call."); a later quote that would outlive the
  window is refused (`CALL_EXPIRED`); and the database refuses a trade with
  any other key, or one signed after `expiresAt`. A discard and a submit of
  the same call serialize on the money call's row, so only one wins.
- The sweeper (every reconciler pass) marks `FUNDED` any pending call whose
  order filled (and any expired one, in the last day, whose own last quote
  filled in time), and `EXPIRED` any past `expiresAt` (or whose market stopped
  taking calls) with nothing going through. An expired call is withdrawn
  (hidden with reason `money_call_expired`): the owner still sees it as
  `money.state: "EXPIRED"`; nobody else ever did.
- Visibility: `PENDING`, `EXPIRED` and `FREE` (replaced) money calls are
  owner-only on every read (feed, call, profile, market detail, top calls,
  suggestions, notifications), also through the Supabase anon and
  authenticated keys (a restrictive RLS policy on `calls`), and never count toward a public record,
  leaderboard or crowd split; a pending call never unlocks the crowd split
  either. A `FUNDED` call is an ordinary public call (with the visibility the
  person chose); after keep free, the new free call is the public one.
- Expiry, discard and keep free retire the current attempt's unsigned quote
  (QUOTED → FAILED in the trade ledger), so an old approval can't be signed
  later.

## (b) Filled amounts and funded-first ordering

- `funding.amountBaseUnits` + `funding.side` on every `CallFeedEntry` of a
  `FILLED` call whose confirmed fills sum to at least $1 (above). Present only
  with `MONEY_CALLS_ENABLED`. Below $1 the entry keeps the plain marker (no
  amount, no `$` stamp) and does not count as funded anywhere below: a dust
  trade buys no ranking.
- `people.get` → `calls`: funded calls first (newest first), then free calls
  (newest first).
- `calls.top`: funded calls first, then the existing order.
- `people.leaderboard`: people are still ranked by the public free-call record
  (`LEADERBOARD_RULE`; nobody is ranked by money). Each row gains
  `fundedCalls: number` (the person's public calls with a confirmed fill), and
  an exact tie is broken by `fundedCalls`.

## (c) The wallet sheet

### `money.wallet` (mutation, read-only budget)

```ts
input:  z.object({}).strict().optional()
output: {
  wallet: { address: string; walletType: string } | null;   // the trading wallet; null: no wallet yet
  balance: { usdcBaseUnits: string; lamports: string; slot: number } | null; // null only with no wallet
  gas: { needsTopUp: boolean; topUp: { amountBaseUnits: string } | null } | null; // null: no wallet, or fees could not be checked just now
}
```
The header pill shows `balance.usdcBaseUnits` as dollars (`$12.19`). Real
mainnet reads, genesis-pinned (`src/deposits/balance.ts`).

### `money.activity` (mutation, read-only budget)

```ts
input:  z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict().optional()
output: { items: ActivityItem[] }

interface ActivityItem {
  id: string;                       // stable per item
  kind: "trade" | "claim" | "deposit" | "cash_out";
  direction: "in" | "out";
  amountBaseUnits: string;
  state: "pending" | "done" | "failed";
  at: number;                       // unix ms
  signature: string | null;         // public chain data, for an explorer link
  callId: string | null;            // trades and claims
  marketId: string | null;
  side: "YES" | "NO" | null;
  question: string | null;
  counterparty: string | null;      // cash out: destination; deposit: source wallet when known
}
```
Newest first. Sources: trades (`panta_trade_sessions` that reached a signature:
`SUBMITTED` pending, `FILLED` done, `FAILED` failed), win claims
(`panta_claim_sessions`: done shows the payout proven on chain; pending or
failed shows the winning shares at $1 from Panta's reviewed claim), cash outs and wallet top-ups
(`wallet_transfers`), and USDC that arrived in the trading wallet from anywhere
else (card via Crossmint, "Send USDC") read from mainnet. When the RPC cannot
answer, chain-only deposits are left out; ledger items always show.

### Cash out: `money.cashOutPrepare` → sign → `money.transferSubmit` → `money.transferStatus`

```ts
// money.cashOutPrepare
input: z.object({
  destination: z.string().min(1).max(64),  // any Solana wallet address (validated below)
  amountBaseUnits: baseUnits,              // ≤ balance; full precision allowed ("Max")
  idempotencyKey,
}).strict()
output:
  | { status: "INVALID"; reason: "ADDRESS" | "SAME_WALLET" | "TOKEN_ACCOUNT" | "OVER_BALANCE" | "AMOUNT"; message: string }
  | { status: "NEEDS_GAS"; wallet: { address: string; walletType: string }; topUp: { amountBaseUnits: string } | null }
  | { status: "SENT"; transfer: TransferView }   // the same key again after it was signed: its actual state, never a new review
  | { status: "READY"; transfer: TransferView;
      transaction: { encoding: "solana-tx-base64"; payload: string; expiresAt: number };
      review: TransferReview }

interface TransferReview {
  from: string; to: string; amountBaseUnits: string;
  createsAccount: boolean;         // the destination's USDC account is created (paid by `from`)
  networkFeeLamports: string; rentLamports: string; // SOL `from` pays; never shown as money
}
interface TransferView {
  transferId: string; kind: "cash_out" | "deposit";
  from: string; to: string; amountBaseUnits: string;
  state: "BUILT" | "SUBMITTED" | "CONFIRMED" | "FAILED";
  signature: string | null; createdAt: number; updatedAt: number; expiresAt: number;
}

// money.transferSubmit
input:  z.object({ transferId: uuid, signedTransaction: z.string().min(1).max(1644) }).strict()
output: TransferView                       // SUBMITTED, never "done"

// money.transferStatus (polled; read-only budget)
input:  z.object({ transferId: uuid }).strict()
output: TransferView
```

Validations (each an `INVALID` reason, nothing built):
- `ADDRESS`: not base58, not 32 bytes, off-curve (a program-derived address),
  the USDC mint, or an executable account.
- `TOKEN_ACCOUNT`: the address is a token account (someone pasted their USDC
  account instead of their wallet).
- `SAME_WALLET`: the trading wallet itself.
- `OVER_BALANCE`: more than the trading wallet's USDC right now.
- `AMOUNT`: zero or not an integer.
- `NEEDS_GAS`: the trading wallet's SOL cannot pay the fee (+ the destination
  account's rent when it must be created). Run the top-up, then prepare again.

Lifecycle, the buy path's discipline: the reviewed transaction is stored before
any wallet sees it; the exact signed bytes are stored before broadcast (a
retried submit re-sends the identical bytes only); `CONFIRMED` only when the
chain shows the exact reviewed message landed with exactly `amountBaseUnits`
USDC leaving `from` and arriving at `to`'s USDC account; `FAILED` only when the
chain says it failed, or when the RPC answered that it has no such
transaction AND its blockhash expired (an RPC that cannot answer, or pruned
history, is never proof of failure). Replaying a key whose transfer was
signed answers `SENT` with the transfer's actual state. The quote
lives 60 s; replaying the same `idempotencyKey` after that answers
`PRECONDITION_FAILED` ("This review expired. Nothing was sent. Start again."),
so start again with a new key. Errors on submit: `BAD_REQUEST` (the approval
is not the owner's signature over exactly the reviewed message, or a different
approval than one already stored), `PRECONDITION_FAILED` (the review expired,
or the transfer already failed), `NOT_FOUND` (not your transfer).

**One transfer in flight per source wallet.** While a transfer from a wallet
is `BUILT` (its review not yet expired) or `SUBMITTED`, a new
`cashOutPrepare` / `depositFromWalletPrepare` from that wallet is refused with
`CONFLICT` "Another transfer from this wallet is still going through. Try
again when it's done.", and the error's `data.details` is
`{ reason: "TRANSFER_IN_FLIGHT", transferId }` (poll that transfer with
`money.transferStatus`). An expired review is retired automatically. The
database enforces it too (a partial unique index).

**The transaction (what every signer must check before signing).** One v0
transaction, no address lookup tables, signatures empty, exactly one signer:
`from`, which is also the fee payer. Instructions, in this order and nothing
else (no System transfer, no other program):

1. 0–2 Compute Budget: `SetComputeUnitLimit` (≤ 200 000) and/or
   `SetComputeUnitPrice` (≤ 1 000 000 micro-lamports), each at most once.
2. Only when `review.createsAccount`: one Associated Token Account
   `CreateIdempotent` (data `[1]`), accounts exactly
   `[from, ata(to), to, USDC mint, System, Token]`.
3. Exactly one SPL Token `TransferChecked` (data `[12, amount u64 LE, 6]`),
   accounts exactly `[ata(from), USDC mint, ata(to), from]`, amount =
   `review.amountBaseUnits`.

`ata(x)` is x's canonical USDC account (Token program, mainnet USDC
`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`). The web check is
`checkUsdcTransfer` (`web/lib/webapp/transferCheck.ts`); `checkedSigner(...)`
now also returns `signTransfer(unsigned, transfer)` which runs it on its own
copy of the bytes before the wallet sees them. The phone's embedded signer must
apply the same rules.

## (d) Collectable winnings

### `money.winnings` (mutation, read-only budget)

```ts
input:  z.object({}).strict().optional()
output: {
  items: Array<{
    orderId: string;               // the position's handle for pantaTrading.claimPrepare
    callId: string; marketId: string; question: string | null;
    side: "YES" | "NO"; wallet: string;
    amountBaseUnits: string;       // what collecting pays: the winning shares at $1
    costBaseUnits: string;
    state: "COLLECTABLE" | "COLLECTING";
    claimId: string | null;        // COLLECTING: poll pantaTrading.claim
  }>;
  totalBaseUnits: string;          // COLLECTABLE items only
}
```
Every won position of the account (all its wallets) that Panta reports
claimable and nobody has collected yet, from `pantaTrading.positions`'s own
sources (the venue result plus Panta's `claimable`). `Collect $9.20` runs the
existing claim path: `pantaTrading.claimPrepare({ orderId, idempotencyKey })` →
sign (the claim transaction) → `pantaTrading.claimSubmit` → poll
`pantaTrading.claim` until `CONFIRMED` (payout proven on chain). Never
auto-signed. Needs `PANTA_CLAIM_SCHEMA_READY=true`; without it `items` is
empty.

## (e) Deposit options

### `money.depositOptions` (mutation, read-only budget)

```ts
input:  z.object({ amountBaseUnits: baseUnits.optional() }).strict().optional()
output: {
  tradingWallet: { address: string; walletType: string } | null;
  sendUsdc: {                      // "Send USDC": address + QR
    address: string; mint: string; network: "solana-mainnet";
    uri: string;                   // solana:<address>?spl-token=<mint>[&amount=<decimal>]
  } | null;
  card: {                          // Crossmint: card / Apple Pay / Google Pay
    available: boolean; testMode: boolean;   // testMode: admins on staging only; say "test" every time
    reason: string | null;
    presetsUsd: string[]; limits: { minUsd: string; maxUsd: string } | null;
  };
  fromWallet: {                    // "From Solflare/Phantom": one approval
    wallets: Array<{ address: string; walletType: string }>;  // own proven wallets except the trading wallet
  };
}
```
The card path is the existing `deposits.quote` / `deposits.create` /
`deposits.order` (production only; staging only for `TRUST_ADMIN_USER_IDS`,
always labeled test). The QR encodes `sendUsdc.uri` (Solana Pay transfer
request; `amount` included when the input names one).

### `money.depositFromWalletPrepare` (mutation)

```ts
input: z.object({ fromWallet: wallet, amountBaseUnits: baseUnits, idempotencyKey }).strict()
output: same union as money.cashOutPrepare, with reasons
  "NOT_YOUR_WALLET" | "SAME_WALLET" | "OVER_BALANCE" | "AMOUNT" for INVALID
```
A USDC transfer from one of the account's own linked external wallets to the
trading wallet, built exactly like a cash out (same transaction rules, `from` =
the external wallet, which pays the fee and any rent; `to` = the trading
wallet). The external wallet app signs it; then `money.transferSubmit` /
`money.transferStatus`. Shows in activity as a `deposit`.

## (f) Gas

The app never asks for SOL. Before a trade (`prepareCall` / `retry`) or a
transfer (`cashOutPrepare` / `depositFromWalletPrepare`), the server answers
`NEEDS_GAS` with `topUp.amountBaseUnits` when the paying wallet cannot cover
the network fee and rent. The app then runs the existing gasless swap
(`solTopUp.order({ wallet, amountBaseUnits })` → sign → `solTopUp.execute`),
silently, and repeats the original request. `money.wallet.gas` says the same
ahead of time. `SOL_TOPUP_ENABLED` off: `topUp` is `null`.

## (g) Market publishing

Always (whenever publishing is enabled, whatever `MONEY_CALLS_ENABLED` says),
`marketCreation.preparePublish` and `submitPublish` accept only the
**proposer**, paying from one of the proposer's **own** proven wallets. A
reviewer paying for and owning a user's market was a bug:
- a reviewer who is not the proposer: `FORBIDDEN` "Only the person who
  proposed this market can publish it." Reviewers still approve or reject.
- a wallet that is not the proposer's: `FORBIDDEN` "Link this wallet to your
  account first" (checked on `preparePublish` and again before the signed
  create is committed); links that cannot be read: `BAD_GATEWAY`, never
  assumed.
- `ProposalView.canPublish` is true only for the proposer.

## Unchanged procedures the flows reuse

`pantaTrading.submit`, `pantaTrading.order`, `pantaTrading.claimPrepare`,
`pantaTrading.claimSubmit`, `pantaTrading.claim`, `pantaTrading.positions`,
`solTopUp.order`, `solTopUp.execute`, `deposits.quote`, `deposits.create`,
`deposits.order`, `wallet.balance`, `wallet.privyToken`. `calls.create` and
`calls.respond` stay the free path (the `Free` amount).

## `money.status` (mutation, read-only budget)

```ts
input:  z.object({}).strict().optional()
output: {
  enabled: boolean;
  reason: string | null;            // why not, in words
  presetsBaseUnits: string[];       // ["5000000", "10000000", "25000000"]
  minBaseUnits: string;             // "1000000"
  maxBaseUnits: string | null;      // the server's per-trade limit
  defaultAmountBaseUnits: string | null; // signed in: the last amount used, else "5000000"
  pendingTtlMs: number;             // 120000: a new call's window before its first quote
}
```

## Staged rollout: `admins`

`MONEY_CALLS_ENABLED`, `CHUMBUCKET_WALLET_ENABLED`, `ACCOUNT_LINKING_ENABLED`
and `ACCOUNT_FOLD_ENABLED` each take:

| value | meaning |
|---|---|
| `true` | on for every account |
| `admins` | on only for the accounts in `TRUST_ADMIN_USER_IDS` (canonical `public.users` ids), to QA real money in production first |
| anything else (unset, `1`, `TRUE`, a typo) | off |

With `admins` every decision is per account, made from the account the one
resolver (`src/auth/accountResolver.ts`) gives for the session. An account
that is not an admin, or a request with no resolvable account, gets exactly
the flag-off behaviour, in what it is told and in what it may do:
- what reports a flag answers per session: `money.status`, `wallet.status`,
  `auth.signInMethods`, and `auth.identityStatus` (which reads the session
  from the `Authorization` header when one is sent; without one it answers as
  flag-off);
- every route refuses exactly as when off (same tRPC code, same message),
  checked per account on the server, never by a global switch;
- calls show filled amounts, funded-first ordering and `fundedCalls` only to
  viewers the rollout includes; other viewers read exactly the flag-off shapes.

Client builds (`NEXT_PUBLIC_*`, `--dart-define`) keep their own switches on
during an `admins` rollout and follow the per-account answers above, so the
server alone decides who sees what.

Server machinery that keeps admins' data correct for everyone runs whenever a
switch is not off: pending money calls stay private to their owner for every
viewer, and the fill hook and the money sweeper run.

## Server configuration

| env | default | meaning |
|---|---|---|
| `MONEY_CALLS_ENABLED` | off | everything in this document: `true` for everyone, `admins` for `TRUST_ADMIN_USER_IDS` only |
| `TRUST_ADMIN_USER_IDS` (existing) | none | the accounts an `admins` rollout includes |
| `FUNDED_POSITIONS`, Panta keys, `PANTA_SCHEMA_READY` (existing) | — | `prepareCall` / `retry` need Panta trading ready |
| `PANTA_CLAIM_SCHEMA_READY` (existing) | off | winnings |
| `SOL_TOPUP_ENABLED` (existing) | off | `topUp` suggestions |
| `DEPOSITS_ENABLED`, `CROSSMINT_*` (existing) | off | the card option |
| `CHUMBUCKET_WALLET_ENABLED` (existing) | off | the Chumbucket wallet as trading wallet (`true` or `admins`) |

Migrations (mobile repo, `supabase/migrations`, additive, re-runnable), to
apply before setting `MONEY_CALLS_ENABLED=true`:
- `20261004140000_money_calls.sql`: `public.money_calls` (one row per call with
  money intent; service-role only; SQL-guarded transitions; history permanent).
- `20261004140500_wallet_transfers.sql`: `public.wallet_transfers` (cash outs
  and wallet top-ups; the trade ledger's discipline).
With the flag on and `money_calls` unreadable, the calls feed fails closed
rather than show a pending call publicly.

Deployment: one BFF instance. Like the calls mirror it builds on, which calls
are private is held in that process's memory (hydrated from `money_calls`
before any read, updated in the same tick as every transition). Running more
than one replica needs a shared read path first.

Background work: the money sweeper (expiry, FUNDED repair, settling
`SUBMITTED` transfers) runs inside the Panta reconciler's pass
(`PANTA_RECONCILER_ENABLED`, on whenever Panta is configured for reads). Each
person's own `callStatus` / `transferStatus` poll runs the same transitions.
