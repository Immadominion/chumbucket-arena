# The Chumbucket wallet: setup

One wallet per account (a Privy embedded Solana wallet), the default for
trades on iPhone, Android and the web. Everything is behind
`CHUMBUCKET_WALLET_ENABLED` (default off).

## How sign-in works

Privy never sees a Supabase token. The BFF mints its own token, and Privy
checks it against the BFF's public key.

- `wallet.privyToken` (signed in, rate limited) returns a ten-minute ES256 JWT:
  - `sub`: the account (`public.users.id`), resolved like every other procedure
    resolves it, so every sign-in of one account gets the same `sub` and the
    same wallet;
  - `aud`: `chumbucket-privy`;
  - `iss`: `BFF_PUBLIC_URL`;
  - `iat`, `exp` (iat + 600) and `jti`.
- The public key is served at `<BFF_PUBLIC_URL>/.well-known/chumbucket-privy-jwks.json`.
  Its `kid` is the key's RFC 7638 thumbprint.
- The apps fetch a new token a minute before the old one expires.

## 1. Make the signing key (once, locally, never printed)

```sh
umask 077
openssl ecparam -name prime256v1 -genkey -noout \
  | openssl pkcs8 -topk8 -nocrypt -out privy-jwt.pem
# Railway: set it straight from the file. No echo, no copy and paste.
railway variables --service <bff-service> --set "PRIVY_JWT_PRIVATE_KEY=$(cat privy-jwt.pem)" >/dev/null
# Then store the file in your password manager and delete it.
rm -P privy-jwt.pem
```

- The BFF accepts PEM (PKCS#8 or SEC1) or a JWK. It also accepts PEM with
  escaped `\n` newlines.
- It only accepts P-256 keys.
- It never logs the key, returns it or puts it in an error.

**Rotating the key:** set a new key and redeploy. The `kid` changes on its
own. Privy re-reads the JWKS, and tokens minted under the old key expire
within ten minutes.

## 2. Privy dashboard

1. **Create the app** (production).
2. **Request JWT login:** Integrations → Built-in → request **Custom
   authentication**.
3. **JWT integration** (User management → Authentication → JWT integration):
   - Environment: **client-side** (the apps call Privy directly).
   - Verification: **JWKS endpoint** =
     `https://<BFF_PUBLIC_URL host>/.well-known/chumbucket-privy-jwks.json`.
     Privy supports ES256 keys in a JWKS.
   - JWT ID claim: **`sub`**.
   - Audience (`aud`): **`chumbucket-privy`**.
   - Privy documents no issuer check, so there is nothing to set for it.
4. **Allowed origins** (Configuration → App settings → Domains):
   - `https://chumbucket.fun`
   - `https://www.chumbucket.fun`
   - `http://localhost:3000` (`next dev`)
   - Any preview deployment by its exact URL; `*.vercel.app` wildcards are
     rejected.
5. **App client** (Configuration → App settings → Clients → Add app client):
   - Allowed app identifiers: iOS bundle id **`dev.cleva.chumbucket`** and
     Android package **`dev.cleva.chumbucket`**.
   - With custom auth, Privy asks for no signing-certificate SHA-256 (that is
     for passkeys and OAuth, which we don't use).
6. **Embedded wallets:**
   - Solana on.
   - Create on login: **off** (the apps create the wallet on first need).
   - Confirmation modals: **off** (the apps hide them too).
   - Keep the default TEE execution.
   - No password.

**Pricing** (privy.io/pricing): free up to 499 monthly active users, 50K
signatures a month and $1M volume. Then $299/mo (500–2,499 users) and $499/mo
(2,500–9,999); enterprise from 10K. The apps start a Privy session only when
something must be signed or the wallet is first set up, not at launch.

## 3. Config keys

| Where | Key | Value |
|---|---|---|
| Railway (BFF) | `CHUMBUCKET_WALLET_ENABLED` | `true`, only after migrations `20261004130000` and `20261004130500` are applied |
| Railway (BFF) | `PRIVY_JWT_PRIVATE_KEY` | the key from step 1 (secret) |
| Railway (BFF) | `BFF_PUBLIC_URL` | the BFF's public https base URL, e.g. `https://chumbucket-calls-bff-production.up.railway.app` |
| Vercel (web) | `NEXT_PUBLIC_CHUMBUCKET_WALLET_ENABLED` | `true` |
| Vercel (web) | `NEXT_PUBLIC_CHUMBUCKET_PRIVY_APP_ID` | the Privy app id (public) |
| Mobile release `--dart-define` | `CHUMBUCKET_WALLET_ENABLED` | `true` |
| Mobile release `--dart-define` | `CHUMBUCKET_PRIVY_APP_ID` | the Privy app id (public) |
| Mobile release `--dart-define` | `CHUMBUCKET_PRIVY_CLIENT_ID` | the app client id from step 2.5 (public) |

The legacy `NEXT_PUBLIC_PRIVY_APP_ID` and `PRIVY_APP_ID` keys are the old
Arena app and are not used for this wallet.

## 4. Mobile build requirements

privy_flutter 0.11.0 brings these build changes:
- **iOS 17 minimum:** Podfile and Runner target raised.
- **Android API 28 minimum.**
- **Gradle packaging exclusion** for a duplicate OSGi manifest.
- **New pods:** PrivySDK 2.16.2 and Factory 2.4.3.

## 5. Safety rules this wallet keeps

- **Before any signature:** every Panta buy is checked against the reviewed
  buy, on the phone and in the browser. The BFF refuses a wallet that is not
  an active linked wallet of the account, at prepare and again at submit. A
  revoked link outranks the sign-in session.
- **Signing out:** signing out, or another account signing in, ends the
  Privy session, including a session left over from an earlier run.
- **Account deletion:** refused with "Cash out first" while the Chumbucket
  wallet holds USDC or SOL above dust or has an open position or unclaimed
  winnings. If any of that cannot be read, deletion is refused too.
