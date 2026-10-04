# Chumbucket Web (chumbucket.fun)

The public site for Chumbucket, a people-first feed of calls on real Panta
prediction markets, and the signed-in web app at `/app`. Next.js App Router,
React, TypeScript and the shared Chumbucket visual language.

## Landing page

`/` is a hand-written rebuild of the Figma page that used to run here: one
component per section in `components/site/landing`, shared tokens and parts
in `components/site`. `docs/website-structure.md` maps every visual element to
its component and its `data-el` hook for motion work, and lists the assets
still to replace.

The public site (landing, share pages, legal pages) ships no Privy, tRPC or
Supabase code, so the public pages run without that configuration. The web
app (`/app`) loads Supabase Auth only; the legacy Arena client
(`components/AppProviders.tsx`, Privy) is mounted only by old `/c/chg_…`
challenge links.

## Web app (`/app`)

The calls product in the browser, matching the Android app: sign in (wallet,
Google or X; an account is the way in), Home (Following / Global), Markets
(one search-and-filter row), a market with YES / NO and a free call in one
tap, a call with Back / Fade / Dare, your profile and edit, other people,
Activity, friends (add by @username, X handle or wallet, then follow) and
the leaderboard. Trading and adding funds hand off to the Android app.
See `docs/web-app.md` for how it is built and what the owner must configure.

Set `NEXT_PUBLIC_WEB_APP_URL=/app` and the landing's hero links to it.

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

## Retired Arena pages

The football-and-escrow Arena (`/arena`, `/matchday`, `/bet`, `/challenge`,
`/caller`, `/predictions`, `/results`, `/send`, `/wallet`, `/settings`,
`/friends`, `/signin`) is gone; `next.config.ts` redirects those paths to
the web app. Old challenge links (`/c/chg_…`) still render through
`/legacy-challenge`, and `/proof` keeps the saved TxLINE receipt.

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

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`: the web app's
  sign-in (the same Supabase project as the Android app)
- `NEXT_PUBLIC_CALLS_BFF_URL`: the calls BFF the web app calls from the
  browser (defaults to production)
- `NEXT_PUBLIC_WEB_APP_URL`: `/app` once the web app should be linked from
  the landing and the share pages
- `NEXT_PUBLIC_ANDROID_INSTALL_URL`: where "Get the app" goes
- `NEXT_PUBLIC_BACKEND_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`: legacy challenge
  links only

The web app, like the Android app, sends the person's Supabase session to
the BFF as a bearer; the BFF verifies it and decides who is asking. No
procedure takes a user id or a wallet as identity.

## Deployment

The web client deploys to Vercel from this repository's `web` directory. The Bun
API, TxLINE keeper, Helius indexer, and social projection service run on Railway.
