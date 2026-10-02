# Crossmint deposits: research and integration notes

Read from Crossmint's official docs on 2 October 2026. Every claim below links to
the page it came from. Crossmint serves each docs page as Markdown when you add
`.md` to the URL. The full index is at <https://docs.crossmint.com/llms.txt>.

## TL;DR

- **Product:** use **Crossmint Onramp**. It sells stablecoins for card, Apple Pay
  or Google Pay and delivers them to a wallet address, so it is a top-up rather
  than the purchase of an item
  ([checkout vs onramp FAQ](https://docs.crossmint.com/payments/introduction.md)).
  Onramp is card-rail only (`payment.method: "card"`). Apple Pay and Google Pay
  ride that rail
  ([create order](https://docs.crossmint.com/onramp/api-reference/create-order.md),
  [payment methods](https://docs.crossmint.com/onramp/concepts/payment-methods.md)).
- **Asset:** USDC on Solana. In production the token locator is
  `solana:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, which is the same
  mainnet mint Panta trades in. In staging it is
  `solana:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, devnet test USDC
  ([create order, tokenLocator table](https://docs.crossmint.com/onramp/api-reference/create-order.md)).
- **Our wallets are "external" to Crossmint.** Before an order can name a wallet
  as the recipient, the server must link that wallet to a Crossmint user. If it
  does not, order creation fails with `ExternalWalletNotLinkedToUserError`
  ([recipient schema](https://docs.crossmint.com/onramp/api-reference/create-order.md),
  [external wallets guide](https://docs.crossmint.com/onramp/guides/onramp-to-external-wallets.md)).
- **Mobile:** load the documented embedded-checkout URL in a WebView or in an
  in-app browser
  ([Mobile WebView Integration](https://docs.crossmint.com/payments/embedded/guides/webview-integration.md)).
  Crossmint publishes a Flutter SDK (`crossmint_flutter`), but this repo resolves
  packages `--offline` and that package is not in the cache. The app therefore
  uses `webview_flutter`, which is already a dependency, with the settings
  Crossmint lists for each platform.
- **Status:** poll `GET /api/2022-06-09/orders/{orderId}` with the server key.
  Crossmint documents polling (about every 2.5 s, never below 500 ms) as a
  supported way to track delivery, and recommends it, or webhooks, for native
  apps ([delivery phase](https://docs.crossmint.com/payments/headless/guides/order-lifecycle/delivery-phase.md)).
  **Webhooks are optional**, so this integration ships no webhook route.
- **Production is not self-serve.** It requires a signed Order Form and a
  completed KYB check of the business
  ([account verification](https://docs.crossmint.com/introduction/platform/account-verification.md),
  [onramp FAQ](https://docs.crossmint.com/onramp/overview.md)).

## 1. Products that put USDC on Solana into a given wallet

| Product | What it does | Fits "deposit with anything"? |
| --- | --- | --- |
| **Onramp** ([overview](https://docs.crossmint.com/onramp/overview.md)) | The user buys a stablecoin with a debit or credit card (Visa, Mastercard), Apple Pay or Google Pay. Crossmint delivers it to the `recipient.walletAddress`. Bank transfer is "coming soon". | **Yes. This is the product to use.** |
| Token checkout ([intro](https://docs.crossmint.com/payments/introduction.md)) | Buy a *specific* token (memecoins and the like) with fiat or cross-chain crypto. | No. Crossmint positions it for selling items, not for topping up a balance. It is unavailable to EEA buyers from 1 July 2026. Self-serve fungible-token checkout covers Solana only ([supported chains notes](https://docs.crossmint.com/introduction/supported-chains.md)). |
| Pay-ins / treasury onramps ([stablecoin orchestration](https://docs.crossmint.com/stablecoin-orchestration/overview.md)) | Bank funding of company treasury wallets. | No. These are company wallets, not user deposits. |

**"Other tokens".** Onramp accepts only the card rail. Onramp does not let a user
pay with ETH, SOL or another token. For someone who already holds crypto, the
honest path is a direct transfer: send USDC (or SOL for fees) on Solana to their
own address. The app's Add funds sheet offers this as **"Send from another
wallet or exchange"**, using the address and QR code that are already there.

## 2. Server API

### Hosts, auth and versions

| | Staging | Production |
| --- | --- | --- |
| API base | `https://staging.crossmint.com/api` | `https://www.crossmint.com/api` |
| Chains | Testnets (Solana devnet) | Mainnets (Solana) |
| Server key prefix | `sk_staging_` | `sk_production_` |
| Client key prefix | `ck_staging_` | `ck_production_` |
| Console | `https://staging.crossmint.com/console` | `https://www.crossmint.com/console` |

- The server key goes in the `X-API-KEY` header
  ([create order security scheme](https://docs.crossmint.com/onramp/api-reference/create-order.md)).
  Keys are scoped per environment and per project
  ([llms.txt key facts](https://docs.crossmint.com/llms.txt)).
- A staging key only works against the staging host, and a production key only
  against the production host. The same rule applies to token locators
  ([WebView guide troubleshooting](https://docs.crossmint.com/payments/embedded/guides/webview-integration.md),
  [create order](https://docs.crossmint.com/onramp/api-reference/create-order.md)).
- Path versions: orders use `2022-06-09` and users/linked wallets use
  `2025-06-09`. The embedded checkout page lives at
  `/sdk/2024-03-05/embedded-checkout`.

### Scopes

| Call | Scope | Key |
| --- | --- | --- |
| `POST /2022-06-09/orders` | `orders.create` | server |
| `GET /2022-06-09/orders/{orderId}` | `orders.read` | server (or the order's `clientSecret` as `Authorization`) |
| `PUT /2025-06-09/users/{userLocator}/linked-wallets/{address}` | `users.create` | server |

Sources: [create order](https://docs.crossmint.com/onramp/api-reference/create-order.md),
[get order](https://docs.crossmint.com/onramp/api-reference/get-order.md),
[link wallet](https://docs.crossmint.com/api-reference/users/link-wallet.md),
[scopes](https://docs.crossmint.com/introduction/platform/api-keys/scopes.md).

Two inconsistencies in Crossmint's docs:
- The scopes table lists `users.create` under client keys only. However, the
  external-wallet guide calls link-wallet from the server with the server key.
  Enable `users.create` on the **server** key.
- The WebView guide says the client key in the checkout URL "requires
  `orders.read`". The scopes table says client keys only get `orders.create`.
  Our app never reads orders with the client key (the server polls), but the
  embedded checkout page itself does, so **enable `orders.read` (and
  `orders.create` if offered) on the client key**. Crossmint notes that staging
  keys include all scopes
  ([Swift quickstart](https://docs.crossmint.com/onramp/quickstarts/swift.md),
  [WebView guide](https://docs.crossmint.com/payments/embedded/guides/webview-integration.md)).
- **Client keys must be restricted to an app type** when created: *Web*
  (whitelisted origins such as `https://www.yourdomain.com`), *Mobile*
  (iOS bundle identifiers / Android package names, format
  `com.company.appname`) or *Desktop/CLI* (no origin restriction, "should only
  be used when necessary"). JWT auth is optional for non-wallet client APIs
  ([client-side keys](https://docs.crossmint.com/introduction/platform/api-keys/client-side.md)).
  Neither the WebView guide nor the Flutter/Swift quickstarts say which type
  the embedded-checkout URL needs. Our checkout page is served from
  `crossmint.com`, not from a Chumbucket origin, so choose **Mobile** with
  `dev.cleva.chumbucket` (the app's Android `applicationId` and iOS
  `PRODUCT_BUNDLE_IDENTIFIER`) and verify on a staging device before
  production. If the staging checkout rejects the key, the app type is the first
  thing to check with Crossmint support.

### Linking the user's wallet (required for external wallets)

```
PUT {base}/2025-06-09/users/userId:chumbucket-<public.users.id>/linked-wallets/<address>
X-API-KEY: <server key>
{ "chain": "solana" }
```

- A `userLocator` can be `email:`, `userId:`, `phoneNumber:`, `twitter:` or
  `x:`. `userId:` takes "your app's internal user ID"
  ([link wallet](https://docs.crossmint.com/api-reference/users/link-wallet.md),
  [wallet locators](https://docs.crossmint.com/wallets/concepts/wallet-locators.md)).
  Crossmint creates the user if the locator does not exist yet
  ([external wallets guide](https://docs.crossmint.com/onramp/guides/onramp-to-external-wallets.md)).
- The call is idempotent, and `proof` is optional. Without a proof, the response
  includes `ownership.verified: false` and a CAIP-122 `verificationChallenge`.
- **Ownership proof:** Crossmint asks for it only when a transaction is above
  US$1,000, **or** the user's 30-day onramp volume is above US$1,000. The
  threshold applies to users verified outside the US. Above the threshold, the
  order's `payment.status` is `requires-recipient-verification` and
  `payment.preparation.message` holds the message to sign. The wallet signs that
  exact message. The signature goes back through the same PUT as `proof`. For
  Solana the docs' example sends a base64 ed25519 detached signature
  ([external wallets guide, steps 2-4](https://docs.crossmint.com/onramp/guides/onramp-to-external-wallets.md)).

### Creating an order

```
POST {base}/2022-06-09/orders
X-API-KEY: <server key>
{
  "recipient": { "walletAddress": "<server-resolved address>" },
  "payment":   { "method": "card", "currency": "usd", "receiptEmail": "<email>" },
  "lineItems": [{ "tokenLocator": "solana:<USDC mint>",
                  "executionParameters": { "mode": "exact-in", "amount": "25" } }]
}
```

- `receiptEmail` is **required**. Crossmint uses it to decide whether KYC is
  needed and to send the receipt
  ([create order Payment schema](https://docs.crossmint.com/onramp/api-reference/create-order.md)).
- In `exact-in` mode, `amount` is the fiat amount the user spends. In
  `exact-out` mode, it is the token amount they receive.
- `currency` is `usd` or `eur` self-serve. GBP, AUD and COP are available on
  request. EUR, GBP, AUD and COP are not available to US residents
  ([local currencies](https://docs.crossmint.com/onramp/guides/local-currencies.md)).
- A `201` response returns `{ clientSecret, order }`. `clientSecret` is scoped to
  that one order.
- `"state": "draft"` returns a **quote preview** and persists nothing. A draft
  cannot be paid or polled. The preview shows `quote.totalPrice` (fiat, all fees
  included), `lineItems[0].quote.quantityRange` (lowest and highest USDC) and
  `quote.expiresAt`. Fees depend partly on the card, so a draft returns a range.
  The range collapses, and `charges.crossmintFees` appears, once the user enters
  card details ([get a quote](https://docs.crossmint.com/onramp/guides/get-a-quote.md)).
- Limit errors return `400` with `code: single_purchase_exceeded |
  daily_transaction_exceeded` and `parameters { limit, remainingAmount,
  hoursUntilReset }` ([get order 400Response](https://docs.crossmint.com/api-reference/headless/get-order.md)).

### Order lifecycle (what `GET /orders/{id}` returns)

`order.phase` moves through `quote` → `payment` → `delivery` → `completed`.

`payment.status` takes these values: `draft`, `requires-quote`,
`requires-email`, `requires-crypto-payer-address`,
`requires-recipient-verification`, `requires-kyc`, `manual-kyc`,
`pending-kyc-review`, `failed-kyc`, `crypto-payer-insufficient-funds`,
`crypto-payer-insufficient-funds-for-gas`, `awaiting-payment`, `in-progress`
and `completed`
([onramp get order](https://docs.crossmint.com/onramp/api-reference/get-order.md),
[status codes](https://docs.crossmint.com/payments/headless/guides/status-codes.md)).

**`failed` is not a payment status** (corrected 2 Oct 2026 against the status
codes page). A declined card leaves the status where it was and adds
`payment.failureReason`, "a normalized error code, category, and retry
policy" ([status codes](https://docs.crossmint.com/payments/headless/guides/status-codes.md),
[error codes](https://docs.crossmint.com/onramp/api-reference/error-codes.md)).
`deriveDepositState` therefore keys `payment_failed` on the presence of
`failureReason` (it also tolerates a literal `failed`). The onramp get-order
schema does not list `failureReason`, `preparation.message` or `refunded`;
the external-wallets guide and status-codes page do, so every one of those
fields is read as optional.

`lineItems[0].delivery.status` takes these values: `draft`,
`awaiting-payment`, `in-progress`, `completed` (with `txId`) and `failed`. A
failed delivery is **refunded automatically**.

`phase === "completed"` does **not** mean success. Always read the line item's
`delivery.status`
([completed phase](https://docs.crossmint.com/payments/headless/guides/order-lifecycle/completed-phase.md)).

Crossmint places an authorization hold on the card and captures it only on
success. If the transaction fails, the hold is released
([checkout FAQ](https://docs.crossmint.com/payments/introduction.md)).

### Webhooks (optional, not used)

Checkout V3 events are `orders.quote.created`, `orders.quote.updated`,
`orders.payment.succeeded`, `orders.payment.failed`,
`orders.delivery.initiated`, `orders.delivery.completed` and
`orders.delivery.failed`. Each one carries `{ actionId, type, data }`, where
`data` is the full order. Crossmint signs them with Svix, using a per-endpoint
signing secret from the console
([webhooks](https://docs.crossmint.com/payments/advanced/webhooks.md),
[verify](https://docs.crossmint.com/introduction/platform/webhooks/verify-webhooks.md)).

We do not need them. The app is open while the user pays, and the server polls
the order on demand, which the docs support. If we later want server-side
receipts, add a `/webhooks/crossmint` route that checks the Svix signature
before trusting anything. Never trust a webhook body alone.

### KYC, handled by Crossmint

- Every onramp user completes KYC before buying. In the Crossmint-hosted mode
  (ours), the embedded checkout collects KYC itself, and we never touch KYC data
  ([user onboarding](https://docs.crossmint.com/onramp/introduction/user-onboarding.md)).
- **Progressive (light) KYC** covers up to US$1,000 of volume in 12 months. It
  needs name, date of birth, nationality, country, address, email and phone
  (phone is required for US residents). An ID or SSN number is required for US
  and EU/EEA residents. No documents are required.
- **Full KYC** applies above the light tier. It adds due diligence, verification
  history, an identity document and a selfie
  ([data requirements](https://docs.crossmint.com/identity/data-requirements.md)).
- The embedded checkout moves users between tiers automatically in Crossmint-hosted mode.

### Limits, fees, minimums, regions

- **Limits:** the standard limit is US$2,000 per user per day. It resets at
  midnight US Eastern time. Sales can raise it
  ([onramp FAQ](https://docs.crossmint.com/onramp/overview.md)).
- **Minimum:** a card charge must be at least US$0.50. **In staging, USDC orders
  are capped at US$10**
  ([testing tips](https://docs.crossmint.com/payments/advanced/testing-tips.md)).
- **Fees:** Crossmint publishes no fixed fee schedule. Every quote includes its
  fees. A draft shows the fiat total and a USDC range, and the final
  `crossmintFees` appear once card details are entered
  ([get a quote](https://docs.crossmint.com/onramp/guides/get-a-quote.md)).
  Commercial terms are set in the Order Form. The app shows Crossmint's own
  quote and never computes a fee itself.
- **Regions:** onramp works in 160+ countries. Sales has the current country
  list. Onramp to **Solana, Polygon and Base is supported in all regions (EU, US,
  rest of world)**
  ([onramp FAQ](https://docs.crossmint.com/onramp/overview.md),
  [supported chains notes](https://docs.crossmint.com/introduction/supported-chains.md)).
- **Rate limits** (self-serve): 120 POST/PUT per minute per project and 360 GET
  per minute per project. Exceeding them returns HTTP 429
  ([rate limits](https://docs.crossmint.com/introduction/platform/api-keys/rate-limits.md)).
  The BFF therefore rate-limits each person and caches order reads briefly.
- **Liability:** Crossmint takes on chargeback liability, AML screening and
  sanctions checks
  ([payment methods concept](https://docs.crossmint.com/onramp/concepts/payment-methods.md)).

## 3. Mobile integration options

| Option | Notes |
| --- | --- |
| Crossmint Flutter SDK `crossmint_flutter` ([Flutter onramp quickstart](https://docs.crossmint.com/onramp/quickstarts/flutter.md)) | It renders and configures the WebView for you. It is not in this machine's pub cache, so `flutter pub get --offline` cannot add it. It is the cleanest upgrade later. |
| **Own WebView with the embedded-checkout URL** ([WebView guide](https://docs.crossmint.com/payments/embedded/guides/webview-integration.md)) | **Used.** URL: `{host}/sdk/2024-03-05/embedded-checkout?orderId&clientSecret&apiKey=<ck_>&payment=<json>&appearance=<json>`. Requires JavaScript, DOM storage, a **standard mobile browser user agent** (otherwise the checkout hides the wallet buttons), Android `setPaymentRequestEnabled(true)` plus the `org.chromium.intent.action.PAY` / `IS_READY_TO_PAY` / `UPDATE_PAYMENT_DETAILS` `<queries>` for Google Pay, and iOS inline media playback. Navigation must stay unrestricted: the checkout moves through `crossmint.com`, `stripe.com`, `checkout.com`, `pay.google.com`, `applepay.cdn-apple.com`, `withpersona.com` and `sardine.ai`. No Apple Pay domain registration is needed, because the page is served from `crossmint.com`. |
| Hosted URL in a browser (`SFSafariViewController` or Chrome Custom Tabs) | The docs say the same URL "renders in SFSafariViewController, Chrome Custom Tabs, or a regular browser tab" and needs less configuration. **Used as the fallback**, through "Open in browser", for any device where the WebView cannot complete a step, such as a full-KYC selfie that needs camera access. |

Google Pay in production requires Google's own approval of the Android app in
the Google Pay & Wallet Console. The approval needs a release-signed APK and
screenshots, and takes about one business day
([Google Pay mobile](https://docs.crossmint.com/payments/embedded/guides/google-pay.md)).
Apple Pay on iOS needs a physical iPhone running iOS 17 or later. It never shows
on Android, and Google Pay never shows on iOS
([WebView guide](https://docs.crossmint.com/payments/embedded/guides/webview-integration.md),
[payment methods concept](https://docs.crossmint.com/onramp/concepts/payment-methods.md)).

Staging test cards: `4242 4242 4242 4242`, any future expiry, any CVC
([testing tips](https://docs.crossmint.com/payments/advanced/testing-tips.md)).

## 4. How Chumbucket uses it

```
App (Add funds sheet)                    BFF (deposits.*)                       Crossmint
───────────────────────                  ─────────────────────────────          ─────────────
deposits.status ───────────────────────► session → person → verified wallets
deposits.balance ──────────────────────► mainnet RPC (genesis-pinned) SOL + USDC
deposits.quote {amountUsd} ────────────► link wallet (PUT, idempotent) ───────► users/linked-wallets
                                         POST orders state:"draft" ───────────► orders (draft)
deposits.create {amountUsd, key} ──────► POST orders ─────────────────────────► orders
          ◄── { orderId, checkoutUrl }   checkoutUrl = embedded-checkout(ck_, clientSecret)
WebView(checkoutUrl)  ─────────────────────────────────────────────────────────► KYC + payment
deposits.order {orderId} every 3 s ────► GET orders/{id} (server key) ────────► orders
                                         ownership: recipient ∈ person's wallets
deposits.verifyWallet {orderId, sig} ──► ed25519 check vs preparation.message
                                         PUT linked-wallets {proof} ──────────► ownership proof
```

- **The recipient is never a client-supplied address.** The server resolves the
  person from the GoTrue-verified Supabase session. It collects the
  **server-verified** wallets: the session's Sign-in-with-Solana address, plus
  `linked_wallets` rows that are active (`revoked_at IS NULL`) and proven
  (`verified_at IS NOT NULL`). The app may name *which* of those wallets it is
  using, for example an MWA wallet or a device wallet. An address outside that
  set is refused.
- **Order reads are owner-checked.** `deposits.order` returns an order only if
  it has a single Solana line item whose delivery recipient is one of the
  caller's verified wallets. The get-order object does not name the token, so
  the token is not re-checked. The server key already limits reads to our
  Crossmint project, which only ever creates orders for the configured USDC
  locator.
- **SOL for network fees is not covered.** Onramp sells USDC only, and a Panta
  buy is paid for by its owner (`payerKey` is the owner's wallet), so a wallet
  funded only by card still needs a little SOL before it can trade. The app
  says so wherever it shows a balance with 0 SOL (Add funds sheet before and
  after paying, trade review), opens the receive address, and never says
  "you're ready to trade" while SOL is 0.
- **Receipt email:** the server prefers the account's confirmed email from
  Supabase Auth, read through the admin API with the service role. If the
  account has none (wallet or X sign-ins), the app asks for one. We do not store
  it. It goes only to Crossmint, which requires it.
- **When anything is missing,** `deposits.status` returns `available: false` with
  a plain reason, and the app says so. Missing items include a key, the env, a
  key/env mismatch, the switch, or the account database. Nothing is simulated.
- **Staging is labelled.** In staging, Crossmint delivers *devnet test USDC*.
  The balance shown is always **mainnet**, which is what Panta spends, so the
  sheet shows a "Test mode" note and never claims the test USDC arrived in the
  trading balance.

## 5. Configuration (BFF env)

| Variable | Value |
| --- | --- |
| `CROSSMINT_ENV` | `staging` or `production` |
| `CROSSMINT_SERVER_API_KEY` | `sk_staging_…` / `sk_production_…`, matching `CROSSMINT_ENV`. Scopes: `orders.create`, `orders.read`, `users.create` |
| `CROSSMINT_CLIENT_API_KEY` | `ck_staging_…` / `ck_production_…`, matching `CROSSMINT_ENV` |
| `DEPOSITS_ENABLED` | Exact `true` turns deposits on. Anything else is the emergency stop |
| `CROSSMINT_MAX_ORDER_USD` | Optional per-order ceiling. Default 500 in production, 10 in staging. Clamped to stay below the US$1,000 single-transaction proof threshold |
| `CROSSMINT_MIN_ORDER_USD` | Optional per-order floor. Default 5 in production, 1 in staging. Never below Crossmint's US$0.50 card minimum |

Supabase (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) must already be
configured. The deposit procedures resolve the person through the same identity
runtime as Panta trading. `SOLANA_RPC_URL` must be a mainnet HTTPS RPC for the
balance read; the read pins the mainnet genesis hash.

## 6. What the app does on the device (fleet/deposits, mobile)

- **Entry points.** Profile → My wallet → **Add funds** (primary action; the QR
  "Receive from another wallet" modal stays). Panta trade review: under the
  amount, the trading wallet's real USDC and SOL (server read, mainnet) and,
  when the buy is larger than the USDC there or the wallet has no SOL, an
  **Add funds** button that funds *that* wallet when the account has proven it.
- **Sheet.** `ChumbucketWavySheet`: balance card (USDC + SOL, read time),
  presets from `deposits.status`, "Other amount", Crossmint's draft quote
  (you pay / you get / goes to / receipt), payment-method pills, "Already have
  crypto?" (address + QR + Solana-only warning). Live states: pay → send →
  in your wallet, identity check / review, wallet signature, declined card
  (retry in the same order), delivery failed (automatic refund), expired.
- **Checkout.** `webview_flutter` with JavaScript, a browser user agent,
  Android Payment Request on plus the `org.chromium.intent.action.PAY`,
  `IS_READY_TO_PAY` and `UPDATE_PAYMENT_DETAILS` `<queries>` in
  `AndroidManifest.xml`, and iOS inline media. Navigation is open to any
  `https` page and closed to every other scheme. The WebView never grants the
  camera or microphone (the app holds no camera permission): if Crossmint's
  full identity check asks for a photo, a banner offers **Continue in your
  browser**, which loads the same order's checkout in an in-app browser tab.
  Light KYC (up to US$1,000) needs no photo.
- **Resume.** Only the order id is remembered on the phone (no amount,
  address, email or client secret). A later visit resumes an order that is
  paying, delivering or under identity review. An unpaid checkout, including
  one waiting for a wallet signature, is dropped: nothing was charged, and its
  link can't be rebuilt without the secret. If a resumed order becomes payable
  again (an identity review passed), the sheet offers **Start a new payment**.
- **Wallet signature first.** When Crossmint creates an order that needs the
  receiving wallet's signature, the sheet asks for it before opening the
  checkout, then opens the checkout for the same order once it's accepted.
- **Wallets.** `DepositWalletSource` is the seam: `MwaDepositWalletSource`
  today; `DeviceDepositWalletSource` takes fleet/identity's
  `EmbeddedWalletController.signer` once both branches are merged (see the
  mobile repo's `docs/contracts/integration-requests/packet-deposits.md`).

## 7. Owner checklist

Nothing below has been done by this package: no keys were created, no env was
set, nothing was deployed.

1. **Crossmint staging project** (self-serve): sign up at
   <https://staging.crossmint.com/console>, create a project (name it
   "Chumbucket"). Enable the Onramp product if the console asks.
2. **Staging server key** (Console → API Keys → Server-side keys → Create):
   scopes `orders.create`, `orders.read`, `users.create` (staging keys include
   all scopes anyway). It starts `sk_staging_`.
3. **Staging client key** (Client-side keys → Create): app type **Mobile**,
   iOS bundle ID and Android package name **`dev.cleva.chumbucket`**; scopes
   `orders.read` and `orders.create`. Leave "Require JWT" off. It starts
   `ck_staging_`. No allowed web origins or redirect URLs are needed: the app
   never redirects back from Crossmint; it polls the order through the BFF.
4. **Railway (chumbucket-calls-bff), staging first:** set
   `CROSSMINT_ENV=staging`, `CROSSMINT_SERVER_API_KEY=sk_staging_…`,
   `CROSSMINT_CLIENT_API_KEY=ck_staging_…`, `DEPOSITS_ENABLED=true`. Optional:
   `CROSSMINT_MIN_ORDER_USD`, `CROSSMINT_MAX_ORDER_USD` (staging is capped at
   $10 by Crossmint). `SOLANA_RPC_URL` must already be a mainnet HTTPS RPC;
   Supabase service-role config must already be present.
5. **Test on a device** (staging): Profile → My wallet → Add funds → $5 →
   card `4242 4242 4242 4242`, any future date, any CVC. Expect devnet test
   USDC; the sheet says it will not show in the mainnet trading balance. Try
   Google Pay on Android (staging shows it if the device has a card).
6. **Production** (not self-serve): contact Crossmint sales, sign the **Order
   Form**, complete **KYB** for the business
   ([account verification](https://docs.crossmint.com/introduction/platform/account-verification.md)).
   Ask them to confirm: Onramp enabled for Solana USDC, the per-user limits,
   the fee schedule in the Order Form, and the client-key app type for a
   WebView embedded checkout.
7. **Production keys**: repeat 2–3 at <https://www.crossmint.com/console>
   (`sk_production_…`, `ck_production_…`, same scopes, same app identifiers).
   Then set `CROSSMINT_ENV=production` and both keys together; a key/env
   mismatch is refused locally and the app says deposits aren't set up.
8. **Google Pay in production** needs Google's approval of the Android app in
   the Google Pay & Wallet Console (release-signed APK + screenshots, about a
   business day) ([Google Pay mobile](https://docs.crossmint.com/payments/embedded/guides/google-pay.md)).
   Apple Pay needs nothing from us (served from crossmint.com) but only shows
   on a physical iPhone with iOS 17+.
9. **Emergency stop**: set `DEPOSITS_ENABLED` to anything but `true`. The app
   then says "Adding funds is paused right now" and still shows balances and
   the receive address.
