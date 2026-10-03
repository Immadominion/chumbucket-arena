# Chumbucket: positioning

How chumbucket.fun talks about the product. The app's onboarding copy
(`lib/features/onboarding/onboarding_copy.dart` in the mobile repo) and the
dApp Store listing (`publishing/LISTING.md`) follow the same rules; where the
site repeats an app line, it repeats it word for word.

## One line

**FOMO for prediction markets.** See what people call on real prediction
markets. Back them, fade them, or make your own call.

The longer version: Chumbucket is a people-first feed of calls on real Panta
prediction markets (Solana, USDC). You see who called which side, at what
price and how often they have been right; you back them, fade them or dare a
friend, or make your own call for free; and every call becomes a receipt
nobody can edit when Panta settles the market.

## Who it's for

- People who already follow sharp takes on X and want to see which ones hold
  up: who called it, when, at what price.
- People curious about prediction markets who don't know where to start.
  Following people is the way in; nothing costs money until they choose to
  trade.
- People who make calls and want proof: a record built from settled markets,
  not screenshots.

## Three reasons

1. **See who's calling it.** Named people, their side, the price they called
   it at and their record, on your Home first when you follow them.
2. **Your move, free.** Back a call, fade it, dare a friend, or make your own.
   Calls move no money. Trading the position on Panta is optional, real USDC.
3. **Receipts, not hype.** A call locks its side, price and time. Panta
   settles the market and the call becomes a receipt nobody can edit, shared
   as a chumbucket.fun link anyone can open.

## What we can truthfully say

Each line has a source. Change the copy when the source changes.

| Claim | Source |
| --- | --- |
| Calls, backs, fades and dares are free and move no money | Terms §3; app `howCallBody`, `callBody` |
| Every market is a Panta market (Solana mainnet, USDC) | Terms §4; the app is Panta-only (mobile repo `docs/checkpoints/2026-09-28-panta-only.md`) |
| Panta settles every market; we never type in a result | Terms §3 ("Results come only from the market's venue") |
| A locked call can't be edited: side, price at the time, timestamp | Terms §3; dApp Store listing |
| A receipt exists once Panta settles, right or wrong | app `howReceiptBody`, `recordBody` |
| Trades are approved in your own wallet; we never hold funds or keys | Terms §4 |
| You can lose what you put into a trade | Terms §5; app `welcomeMoney` |
| Sign in with a wallet, Google or X | app `signInSubtitle` (Google and X only where switched on in Supabase) |
| Records count only calls the venue decided; a percentage needs 10 | `people.leaderboard` rule from the BFF |
| Shared calls, receipts, profiles and markets open on the web | `/c`, `/u`, `/m` on this site |
| Android, on Solana phones like the Seeker | dApp Store listing (calls build 1.0.34 is a draft, not yet submitted) |

Never claim: user or caller counts, volume, accuracy figures, "top traders",
returns, a web app (until `NEXT_PUBLIC_WEB_APP_URL` points at one that
serves the calls product), country lists (restricted jurisdictions are still
to be confirmed with counsel and Panta, Terms §2), or a notification nobody
sends. The people on the page are only real Chumbucket people from the public
BFF (`calls.feed`, `people.leaderboard`); with few of them, the page says so
rather than filling the space.

## Words

Never: **bet, betting, play money, practice, risk-free, safe, guaranteed,
win money, earn, profit, odds, chance, stake, pot, jackpot, airdrop,
gamble**, "challenge a friend" (it is a **dare**, and it moves no money),
football, TxLINE, escrow. Never "%" for a price (prices are cents or USDC per
share). `tests/webLanding.test.ts` checks the site for these.

Say: **call** (a free, public prediction), **back** (make the same call),
**fade** (make the opposite call), **dare** (invite someone to go on record),
**receipt** (a settled call), **record** (how many they called right),
**on record**, **trade** (optional, real USDC on Panta), **Panta settles it**.

## Voice

- People first: lead with who called it, then what you can do about it.
- Short and plain. One idea per sentence. No exclamation marks.
- FOMO is about seeing calls, never about money. Urgency attaches to free
  things ("Don't miss the call"), never to trading ("don't miss out on
  gains").
- Every mention of trading carries its cost: real USDC, can lose it.
- Other people's calls are not advice; the footer says so.
- "FOMO" is used as the common phrase. It is also the name of another app
  (fomo, by Fomo Labs); never style it like their brand or suggest a link.

## What we learned from the leaders

- **fomo** (App Store "fomo - never miss out", Android `family.fomo.app`):
  "See what friends & top traders are buying in real time." The hook is other people's moves,
  live, with their PnL beside them. We borrow the shape (people first, record
  beside the call), not the money promises ("Catch the next big crypto before
  everyone else").
- **Polymarket**: "The World's Largest Prediction Market." Scale and topic
  navigation (Trending, Politics, Crypto, Sports). We can't claim scale; we
  claim people and proof.
- **Kalshi**: "Trade on anything." Short imperative, regulated-exchange trust.
  Our trust line is narrower and checkable: Panta settles it, receipts can't
  be edited.
