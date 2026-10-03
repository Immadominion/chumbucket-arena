# Chumbucket Web (chumbucket.fun)

The public site for Chumbucket, a people-first feed of calls on real Panta
prediction markets, plus the older Arena web client. Next.js App Router, React,
TypeScript and the shared Chumbucket visual language.

## Landing page

`/` is a hand-written rebuild of the Figma page that used to run here: one
component per section in `components/site/landing`, shared tokens and parts
in `components/site`. `docs/website-structure.md` maps every visual element to
its component and its `data-el` hook for motion work, and lists the assets
still to replace.

The public site (landing, share pages, legal pages) ships no Privy, tRPC or
Supabase code: those providers are mounted only by the Arena routes
(`components/AppProviders.tsx`), so the public pages run without that
configuration.

## Share pages

Every link the app shares lands here, rendered server-side from the public
calls BFF (no session) with link-preview images:

| Path | Shows | OG image |
| --- | --- | --- |
| `/` | The landing page: the product, and a real public call from the feed | logo |
| `/c/<callId>` | A call as its receipt (legacy `chg_…` ids still show the Arena challenge) | receipt card |
| `/u/<handle>` | A person's record and public calls | caller card |
| `/m/<marketId>` | A market's question, Panta price and deadline | market card |
| `/.well-known/assetlinks.json` | Android App Links verification | — |

With the app installed and App Links verified, Android opens `/c`, `/u` and
`/m` links directly in the app. Otherwise the page offers "Open in the app"
(an `intent://` on the app's own scheme) and an install fallback
(`NEXT_PUBLIC_ANDROID_INSTALL_URL`). Logic is in `lib/callsBff.ts`,
`lib/assetLinks.ts` and `lib/ogCard.tsx`; tests are in the BFF repo at
`tests/webPublicPages.test.ts`.

## What judges can test

- Browse TxLINE-powered World Cup fixtures.
- Connect a wallet.
- Call HOME, DRAW, or AWAY in a pooled pot.
- Create or accept a direct friend challenge.
- Follow activity through Arena, results, wallet, friends, and claim states.
- Open the proof page and independently simulate the saved TxLINE
  `validate_stat` receipt against public Solana devnet RPC.

## Run

```bash
bun install
bun run dev -- -p 3210          # http://localhost:3210
# Production build, as CI runs it (the Arena pages need the keys to exist):
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder bun run build
```

## Environment

See `.env.example`. Important public settings are:

- `NEXT_PUBLIC_BACKEND_URL`
- `NEXT_PUBLIC_PRIVY_APP_ID`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SOLANA_RPC_URL`
- `NEXT_PUBLIC_CHUMBUCKET_PROGRAM_ID`
- `NEXT_PUBLIC_CHUMBUCKET_USDC_MINT`

Privy is used only for the web wallet/session experience. The Flutter app uses
Solana Mobile Wallet Adapter. Google and X may enrich a profile, but a wallet
signature remains the authority for calls, follows, claims, and other writes.

## Deployment

The web client deploys to Vercel from this repository's `web` directory. The Bun
API, TxLINE keeper, Helius indexer, and social projection service run on Railway.
