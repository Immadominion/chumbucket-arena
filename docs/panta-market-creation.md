# Creating markets on Panta — research and design (2 October 2026)

Chumbucket people can now propose a prediction market, a Chumbucket reviewer
approves it, and it is published on Panta by a wallet-signed, wallet-paid create.
Once live it is pulled into our catalog, where anyone can make a call on it.
This note records what Panta requires (with sources), what we built, and what
the owner must do before any of it is switched on.

No market was created while building this. Every test uses synthetic keys and a
scripted Panta. Publishing costs a real fee, and that has not been exercised.

## 1. What Panta requires

Sources, all read on 2026-10-02:

- Overview: https://docs.panta.market/api-reference/markets/overview.md
- Quote: https://docs.panta.market/api-reference/markets/quote.md
- Build: https://docs.panta.market/api-reference/markets/build.md
- Register: https://docs.panta.market/api-reference/markets/register.md
- Image upload: https://docs.panta.market/api-reference/markets/image-upload.md
- Categories: https://docs.panta.market/api-reference/markets/categories.md
- How it works: https://docs.panta.market/guides/how-it-works.md
- Authentication: https://docs.panta.market/guides/authentication.md
- Errors and rate limits: https://docs.panta.market/guides/errors.md
- Create sessions: https://docs.panta.market/api-reference/account/creates.md
- Creator fees: https://docs.panta.market/api-reference/claims/creator-fees.md
- Terms of Use: https://docs.panta.market/guides/terms-of-use.md

### The flow

1. `POST /markets/create/image-upload/` (optional helper). Returns a signed
   Cloudinary form. You upload the image yourself and use its `secure_url`.
2. `POST /markets/create/quote/`. Validates the fields, reserves a create
   session (`createId`, about 5 minutes) and returns the fee and
   `expectedEventPda`.
3. `POST /markets/create/build/`. Returns an unsigned base64
   `VersionedTransaction`. Its blockhash is valid for about 60 seconds.
4. The `wallet` from the quote signs, and **you** broadcast on your own RPC.
   Panta never broadcasts and never holds keys.
5. `POST /markets/register/` with `{createId, signature}`. Panta checks fail
   closed that the transaction exists, succeeded and matches the program,
   accounts and fee. It then writes the catalog and oracle metadata and returns
   `marketId` (the event address). Calling it again with the same pair is
   idempotent.

### Required fields (quote)

| Field | Rule |
| --- | --- |
| `wallet` | Pays the fee and signs. With `question`, it determines the event address. |
| `question` | Required, max 512 characters |
| `resolutionRule` | Required, max 2048 characters |
| `sourcesOfTruth` | Required string array, 1 to 20 items |
| `category` | `sports`, `crypto`, `politics`, `entertainment`, `finance`, `science`, `world` or `other` |
| `startTime`, `endTime`, `resolutionTime` | Unix seconds, with `startTime < endTime <= resolutionTime` |
| `startTime` | At least the on-chain `minimumStartDelay` ahead of now, typically 3600 s (exempt only for `breaking` markets with `eventInProgress`) |
| `imageUrl` | Required. One public http(s) URL, at most 2048 characters, not localhost or a private host (SSRF guard). 1024×1024 is recommended. |
| Optional | `marketType` (`standard` or `breaking`), `title` (defaults to the question), `description`, `region` (defaults to `Global`), `oracle` (defaults to the sources joined) |

Outcomes are binary YES/NO. The create API has no multi-outcome option.

The live catalog also uses categories outside the create allowlist, for example
`pop-culture` and `gaming` (seen in our production `markets.open` on
2026-10-02). The create API documents only the eight above, so those are the
only ones we offer.

### Fees, liquidity and who pays

- The fee comes from on-chain config. Any `paymentUsdc` in the request is
  ignored. The response splits it into `liquidityInjectionUsdc` (seeds the
  market) and `platformRevenueUsdc`.
- A live quote on 19 Sep 2026 returned **50 USDC = 10 USDC liquidity + 40 USDC
  platform fee** (`docs/contracts/panta-venue-findings.md` in the mobile repo).
  The docs example shows the same numbers. The fee can change, so we always
  show the fee from the live quote.
- The **signing wallet pays**: the USDC fee, plus SOL for the network fee and
  account rent. No separate "seed liquidity" step exists; the liquidity portion
  is part of the fee.
- That wallet is the on-chain creator. After the market *graduates* it can
  claim creator fees (`POST /claim/creator-fees/build/`).

### Review, permission, environments, limits

- Panta documents **no manual review** of creates. Register writes the catalog
  as soon as the on-chain create verifies.
- The account needs `canCreateMarkets: true`. It defaults to true, and our
  account reports true. Otherwise every create route returns
  `CREATE_NOT_PERMITTED`.
- No KYC is required by the API flow. The Terms (section 1) allow Panta to
  require identity or business verification at any time.
- Environments: one base URL, `https://live-api.panta.market/api/v1`. A
  `pk_test_` key returns sandbox fixtures (observed on 19 Sep) and does not
  touch mainnet. A `pk_live_` key creates real mainnet markets. Our server
  accepts only live keys and refuses responses flagged as test mode.
- Rate limits per account: quote 30/min, build 20/min, register 40/min, image
  upload 10/min, reads 120/min. A `429` comes with `Retry-After`.
- Error envelope: `{code, message, field?, fields?}`. Create codes:
  `INVALID_MARKET_PARAMS`, `DUPLICATE_MARKET` (same creator and question),
  `CREATE_NOT_PERMITTED`, `CREATE_EXPIRED`, `TX_NOT_FOUND`, `TX_FAILED`,
  `TX_MISMATCH`, `TX_FEE_MISMATCH`, `UPLOAD_NOT_CONFIGURED`, `RATE_LIMITED`.
- Terms, sections 5 and 6: a product offering market creation must describe
  the action accurately, get the user's consent, and show "Powered by Panta"
  next to the feature.

## 2. What we built

### Product flow

1. **Propose.** Anyone signed in fills in the question, category, close time,
   result time, rules and source links, plus an optional description. The
   outcomes are YES/NO. The app and the server apply the same rules. No Panta
   call and no money are involved.
2. **Review.** A Chumbucket reviewer approves, or rejects with a reason
   (`unclear`, `unverifiable`, `duplicate`, `not_allowed` or `other`) and an
   optional note. Panta has no review step. This one is ours, for two reasons:
   every market goes into Panta's public catalog under our API key (Terms §5
   and §7), and the person is about to pay about 50 USDC that cannot be
   refunded.
3. **Publish.** Either the proposer or a reviewer (a Chumbucket-sponsored
   market) presses Publish:
   - The server uploads a generated 1024×1024 category cover through Panta's
     signed Cloudinary form, once per proposal.
   - It quotes and builds, then validates the transaction (section 3) and the
     fee against `MARKET_CREATION_MAX_FEE_BASE_UNITS`.
   - The app shows the fee and its split, the SOL costs, that the fee cannot be
     refunded, and "Powered by Panta". The wallet signs.
   - The server stores the signed bytes **before** broadcasting, broadcasts on
     its own mainnet RPC, then registers with Panta.
4. **Live.** The proposal goes live only when Panta's register succeeds **and**
   our RPC independently confirms four things: the exact reviewed message
   landed, it succeeded, it invoked the pinned Panta program for the expected
   event, and it debited exactly the quoted fee from the signer
   (`PantaChain.verifyTransaction`). The market is then pulled into
   `venue_markets` with a share price, and anyone can call it.
5. **Confirming.** Panta lists a create only once `register` is called, and
   only a status check (`refreshPublish`, or the check inside
   `submitPublish`) calls it. So three things check a sent create: the server
   itself, in the background, 6 times 5 s apart after the broadcast; the open
   publish sheet, 8 times 3 s apart; and "Your markets", whenever it loads.
   The server's checks are in-process, so after a restart the app's checks
   (or opening the proposal) finish the job.
6. **Failure.** A lost broadcast reply or a Panta refusal leaves the proposal
   in `publishing`. It returns to `approved` (and can be published again) only
   when the chain shows the transaction failed, or that it expired without
   landing: our RPC's confirmed block height is past the build's
   `lastValidBlockHeight`, our RPC no longer accepts its blockhash, and only
   then is the signature unknown (`PantaChain.neverLanded`).
7. **Committed but unclaimed.** The signed bytes are stored before the
   proposal is claimed (`approved` -> `publishing`), and broadcast only after
   the claim. If the claim's reply is lost, a retry claims it first, or retires
   the bytes (`FAILED`, never sent) when the proposal changed or the quote
   expired.

States: `pending_review`, `approved`, `rejected`, `withdrawn`, `publishing`,
`live`, plus a derived `expired`. A proposal is expired once trading closes
within 2 hours: Panta's start delay plus our margin would leave no valid
`startTime < endTime`.

Product limits: at most 5 proposals waiting for review per person and 10 per
day. Trading must close at least 3 hours after proposing, so there is time for
review, and within 2 years. The result time must be within 90 days of the
close. Sources must be public http(s) links.

`startTime`: Panta treats it as the event start, and it must be at least
1 hour away. Primary buys work before it (observed on live quotes; see
`src/prediction/PantaVenue.ts`). We set it to the earliest permitted value
(now + 3600 s + 600 s) at publish time, so trading opens as soon as the create
lands. People pick only "trading closes" (`endTime`) and "result known by"
(`resolutionTime`).

### Code

| Piece | Path |
| --- | --- |
| Rules, mirrored in the app | `src/marketCreation/rules.ts` |
| Panta create client, transport, transaction policy | `src/marketCreation/PantaMarketCreator.ts` |
| Generated category covers (dependency-free PNG) | `src/marketCreation/cover.ts` |
| Lifecycle | `src/marketCreation/MarketCreationService.ts` |
| Store (PostgREST and in-memory) | `src/marketCreation/store.ts` |
| Switches and readiness | `src/marketCreation/config.ts` |
| Composition | `src/marketCreation/runtime.ts` |
| tRPC `marketCreation.*` | `src/api/marketCreation.ts`, mounted in `src/api/router.ts` |
| Migration (mobile repo) | `supabase/migrations/20261002140000_market_proposals.sql` |
| Signature-expiry helper | `PantaChain.neverLanded` in `src/prediction/PantaChain.ts` |

Procedures: `status` (public), `propose`, `mine`, `get`, `withdraw`,
`reviewQueue`, `review`, `preparePublish`, `submitPublish`, `refreshPublish`,
and `byMarket` (public, returns "proposed by" for a live market). Each one
takes its identity from the verified Supabase session. None accepts a person id
or a wallet as identity, and none returns the Panta key.

### In the app (mobile branch `fleet/create-market`)

| Piece | Path (mobile repo) |
| --- | --- |
| Entry: "Create a market" card on the Markets tab (sign-in first; shown only while `marketCreation.status` says proposals are open) | `lib/features/calls/presentation/screens/call_markets_screen.dart` |
| "Proposed by @handle on Chumbucket" on a live market | `lib/features/calls/presentation/screens/market_detail_screen.dart` |
| Your markets, plus the reviewer queue | `lib/features/market_creation/presentation/my_markets_screen.dart` |
| Propose form (question, YES/NO, category, close, result time, rules, sources) | `lib/features/market_creation/presentation/create_market_screen.dart` |
| One proposal's state and next step (withdraw, approve/reject, publish, open) | `lib/features/market_creation/presentation/proposal_detail_screen.dart` |
| Fee review and wallet approval (ChumbucketWavySheet, no close button) | `lib/features/market_creation/presentation/publish_market_sheet.dart` |
| Rules mirrored from `rules.ts` | `lib/features/market_creation/domain/market_draft_rules.dart` |
| Local checks around the wallet (one signer, the reviewed payer, same message back) | `lib/features/market_creation/domain/create_transaction_check.dart` |

The app reads the rules from `marketCreation.status`, so the form and the server
validate against the same numbers. Publishing uses the connected Mobile Wallet
Adapter wallet (`PantaMwaWallet`). A person signed in with Google or X and no
connected wallet sees "Connect a Solana wallet with USDC to publish"; a reviewer
can still sponsor their approved proposal. When embedded wallets land, pass
their signer as the screen's `PublishWalletResolver`.

"Powered by Panta" appears on the form, on every proposal and in the fee sheet
(Terms, sections 5 and 6).

## 3. Transaction policy `panta-create/docs-v1`, and why it is narrow

We have **not** observed a real unsigned create build: taking one requires a
quote, which reserves a session against our key, and doing it during
development was ruled out. So the policy follows the docs and fails closed.
Before a wallet sees the transaction, all of these must hold:

- It is v0 (or legacy) with no address lookup tables, and serialises
  canonically.
- It has exactly one required signature, the quoted wallet is the fee payer,
  and the signature slot is still empty.
- It uses the build's `recentBlockhash`, has no duplicate or unused account
  keys, and invokes no program that is writable or a signer.
- Top-level programs are limited to the pinned Panta program (one or two
  instructions; the creator signs; the expected event account is writable),
  ComputeBudget (at most one limit of 1.4M CU or less and one price of
  1,000,000 µlamports or less, both before Panta), ATA create-idempotent (up to
  3; the creator pays; USDC mint; owned by the creator or an account Panta
  listed in `derived`), and at most one Memo.
- **No top-level System or Token instructions.** USDC can move only inside the
  Panta program, and we prove the exact debit after landing.

If Panta's real create needs anything else, `preparePublish` refuses with "Panta's
create response failed a safety check" and no wallet is opened. See owner action
5.

## 4. What the owner must do

1. **Apply the migration** `supabase/migrations/20261002140000_market_proposals.sql`
   (mobile repo) to production Supabase. It adds two tables. They are
   service-role only, RLS is on, and anon and authenticated have no grants.
   Verified on a fresh PostgreSQL 15 with
   `bun --no-env-file scripts/verify-market-proposals-local.ts --run`.
2. **Choose reviewers.** Set `MARKET_REVIEWER_USER_IDS` on the
   `chumbucket-calls-bff` Railway service to a comma-separated list of
   `public.users.id` values (your own profile id, at least).
3. **Turn on proposals.** Set `MARKET_PROPOSALS_ENABLED=true`. People can then
   propose, and reviewers can approve and reject in the app. Nothing costs
   money yet.
4. **Decide the fee cap.** Optionally set `MARKET_CREATION_MAX_FEE_BASE_UNITS`
   (default `100000000` = 100 USDC). Any quote above it is refused before
   signing.
5. **Verify the create transaction once.** Before turning on publishing, get
   one real unsigned build so we can confirm it fits `panta-create/docs-v1`.
   Quote and build cost nothing, and nothing is signed. A quote does reserve a
   create session (5 minutes) and counts against the 30 quotes/minute limit.
   With publishing on, pressing Publish and then cancelling in the wallet does
   exactly this. A refusal before the wallet opens means the policy needs
   widening to match the real transaction.
6. **Turn on publishing** with `MARKET_PUBLISHING_ENABLED=true`. This also
   needs the existing `PANTA_API_KEY` (live), `PANTA_PROGRAM_ID` (pinned
   mainnet program), `PANTA_SCHEMA_READY=true` and an https `SOLANA_RPC_URL`.
   Setting the flag back to false pauses new publishes.
7. **Decide who pays.** As built, whoever presses Publish pays about 50 USDC
   from their own wallet: the proposer, or you when sponsoring an approved
   proposal from the review queue. A server-held treasury signer was
   deliberately **not** built.
8. **First real create.** It spends a real fee from your wallet, and only you
   can choose to do it. After it, check the market in the Panta catalog, that
   `marketCreation.byMarket` returns the proposer, and that a call can be made
   on it.

### Operator notes

- A proposal that stays `publishing` after the chain confirms the transaction,
  while register keeps returning `TX_MISMATCH` or `TX_FEE_MISMATCH`, means
  money was spent and Panta could not match it. Look at the session row in
  `market_creation_sessions` (it holds the signature and the reviewed binding)
  and contact Panta. Never publish a second time to "fix" it.
- A proposal that stays `publishing` with no checks happening (nobody opened
  it after a server restart) is finished by calling `marketCreation.refreshPublish`
  as its proposer or a reviewer, or by opening it in the app. Panta documents
  `register` as idempotent per `{createId, signature}`; it does not say whether
  a late register is accepted after the create session's ~5 minutes, which is
  why the server and the app both check right after the broadcast.
- History is permanent. The guard triggers refuse deletes, edits to a
  proposal's content, and changes to a signed or final create.
