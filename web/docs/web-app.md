# The web app (`/app`)

The calls product in a browser, built to the Android app's design and to
the owner's rules: compact and icon-led, stateful (no "updated 3 min ago",
no refresh buttons), full-screen states with the app's own art, truthful
copy. Everything lives under `/app` so a deploy can set
`NEXT_PUBLIC_WEB_APP_URL=/app`.

## Where things live

| Path | What |
| --- | --- |
| `app/app/**` | The routes. Each page is a one-line server component that renders a screen. `layout.tsx` sets `noindex` and mounts the root. |
| `components/webapp/WebAppRoot.tsx` | Mount gate (nothing account-specific renders on the server), the auth gate, the shell. |
| `components/webapp/session.tsx` | Supabase session → `auth.whoami` → canonical user id; wallet, Google and X sign-in; claim @username. |
| `components/webapp/authClient.ts` | The Supabase Auth client (PKCE, session kept in the browser under `cb.web.auth`). |
| `components/webapp/wallets.ts` | Browser Solana wallets through the Wallet Standard: connect and sign one message. Never a transaction. |
| `components/webapp/data.tsx` | React Query, the per-account saved cache, toasts, the minute clock. |
| `components/webapp/queries.ts` | Every read as a hook, with its refetch policy. |
| `components/webapp/Shell.tsx` | Bottom bar (phones), rail (760px+), people column (1180px+). |
| `components/webapp/cards.tsx`, `ResponseSheet.tsx`, `ui.tsx` | Call / market / person cards, the Back · Fade · Dare sheet, the wavy sheet, state screens. |
| `components/webapp/screens/*` | One file per screen. |
| `components/webapp/Icon.tsx` | The Basil icons the Android app ships (CC BY 4.0, credited in Settings). |
| `components/webapp/app.css` | The design system, scoped under `.wa`. |
| `components/webapp/money/*` | Calls with money: the amount row and call button, the call flow sheet, the deposit and wallet sheets, the balance pill, Collect, the owner's pending calls, and the signer lookup. |
| `lib/webapp/*` | Pure logic, tested in the BFF repo (`tests/webApp*.test.ts`): the BFF transport, procedures, formatting, filters, SIWS message, cache, identity rules, paths, the money flows (`money.ts`, `moneyFlow.ts`) and the checks every signature passes first (`pantaBuyCheck.ts`, `transferCheck.ts`, `claimCheck.ts`, `swapCheck.ts`). |
| `public/img/states/*.webp` | The app's Plankton / Karen state art (`assets/images/states`), 384px WebP. |

## How it talks to the BFF

The browser calls the calls BFF directly (it allows any origin) on tRPC's
wire: GET for queries, POST for mutations, superjson envelopes. The
Supabase access token goes in `Authorization: Bearer`, as the app sends it.
Procedures that take the token as input (`auth.whoami`,
`auth.completeProfile`, `auth.claimUsername`) are mutations, so the token is
never in a URL. `people.find` is a mutation for the same reason (a wallet
query stays out of URLs).

Refusals the BFF writes for people (4xx) are shown as they are; failures
(5xx) and network errors get one plain line. A screen with nothing to show
gets a full-screen state with art and one action; a screen with cached data
keeps showing it while it refreshes.

## Sign-in

- **Wallet**: the page finds wallets through the Wallet Standard, connects,
  and asks for one signature over the same Sign-in-with-Solana message the
  app builds (`lib/webapp/siws.ts`), with the page's own host and origin as
  domain and URI. Supabase's Web3 grant turns it into a session.
- **Google / X**: Supabase OAuth with PKCE, returning to the page that
  started it.
- **New account**: `auth.whoami` answers `AUTH_USER_UNLINKED`, and the person
  claims a name and @username (`auth.completeProfile`). An older account
  with no @username is asked once (`auth.claimUsername`), with "Later".

## Stateful by design

Every BFF answer is cached per account in the browser
(`lib/webapp/cache.ts`: one slot per account, a week at most, 1.5 MB at
most, lists trimmed to their first page) and restored before the first
frame. Reads refetch on focus, on reconnect and on a minute interval where
they move (feed, calls, market prices, inbox). Small preferences (Home tab,
Markets filters, Friends tab, leaderboard window) are remembered too.

## Money paths

Calls with money follow the server's switch (`money.status`,
`MONEY_CALLS_ENABLED`; docs/money-api.md in the BFF repo). Off, or on a BFF
without `money.*`, none of this shows and every call is free.

- **Amount row** on the market's lock bar and on Back / Fade:
  `Free · $5 · $10 · $25 · +`, starting on the last amount used in this
  browser, else the server's default, else $5. Free keeps the ink button and
  the existing free call; an amount turns the button pink (`Call YES · $5`)
  and starts the call flow. A SOL-quoted market offers Free only.
- **Call flow** (`money.prepareCall`): the deposit sheet when funds are short
  (the call continues once the balance covers it), a silent gasless top-up
  when SOL is short, then a review in dollars (pay, get if right, fee), the
  wallet's signature and `pantaTrading.submit`. Pending until the BFF says
  FUNDED; a failed or abandoned call offers try again, keep it free, or drop
  it. Home lists the owner's pending calls.
- **Balance pill** in every screen's header opens the wallet sheet: add
  funds, cash out to any Solana wallet, recent activity. **Collect** shows on
  Home and on a won call.
- **Signing**: the Chumbucket wallet or a browser wallet (Wallet Standard),
  always through `checkedSigner` (`lib/webapp/trade.ts`), which checks the
  exact bytes of a buy, a USDC transfer (contract §c), a claim or a gasless
  swap before the wallet sees them. The browser never sends a transaction.
- Receipts and cards say `$5 on YES` for a confirmed fill with its amount;
  the owner's pending call carries a grey mark, never pink.

With money off, a market you have called offers "Trade on Panta" while it is
still open (the Chumbucket wallet, or the Android app).

## Owner actions before linking it

1. Supabase Auth → URL configuration: add `https://chumbucket.fun/app/**`
   (and any preview origin you test on) to the redirect allow-list, so
   Google and X return to the web app. Wallet sign-in on chumbucket.fun uses
   the same domain and URI the Android app already uses.
2. Make sure Google and X (OAuth 2.0, provider `x`) are enabled in Supabase
   Auth, as they are for the app.
3. Set `NEXT_PUBLIC_WEB_APP_URL=/app` on Vercel.

## Rendering it

`/app` renders entirely in the browser, so a screenshot run needs a
session: seed `localStorage["cb.web.auth"]` with a session object whose
`expires_at` is in the future (it is never sent anywhere when the BFF is
stubbed) and route the BFF's host to fixture JSON. Screens were checked at
1440, 390 and 320 (2x).
