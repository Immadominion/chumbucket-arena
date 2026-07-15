# The Gaffer — backend

The event-sourced engine behind *The Gaffer*: a World Cup staking-prediction game
with an AI manager whose memory lives on Walrus. This repo is the **backend +
game logic** only. The product spec is in [`THE-GAFFER.md`](./THE-GAFFER.md); the
hackathon rules are in [`context.md`](./context.md).

> **Why not plain REST?** The Gaffer is a stateful agent with an append-only,
> evolving memory per player — that's an *event log*, not a table of rows. So the
> core is **event-sourced**: every Call, result, and Hot Take is an immutable
> event; the Dossier, Pots, Leaderboard, and the Gaffer's read are *projections*
> of it. The canonical log lives on **Walrus** (the hackathon's "all state on
> Walrus" requirement, satisfied literally). The API is **typed RPC + live
> subscriptions** (tRPC over WebSocket), so the frontend imports real types and
> gets pushed updates instead of polling.

## Architecture

```
                         commands (tRPC mutations)
  frontend ──────────────────────────────────────────────►  PlayerActor (1 per wallet, serialized)
     ▲                                                            │ validates vs Dossier, appends events
     │  queries + live subscriptions (tRPC/WS)                    ▼
     └───────────────  ReadModel  ◄────── projections ──────  EventStore  ──► Walrus (canonical log)
                        (Dossier / Pots / Leaderboard)             │
                                                                   ├─► MemoryWriter ─► MemoryStore (MemWal / Walrus)
   match feed ─► Engine (open→lock→resolve) ─► Settlement saga ────┘            ▲
   (MatchData port)         │ parimutuel + rating + form + tiers                │ recall / remember
                            └──────────────────────────► the Gaffer (Claude) ───┘  (pre-bet read · verdict · chat)
```

- **Event-sourced core** — `src/domain/events.ts` is the spine. `src/core/eventstore`
  holds the log (in-memory now; Walrus-mirrored next).
- **Actor per player** — `src/core/actor` serializes each player's writes through a
  mailbox; the only writer to their stream. No locks, no races.
- **CQRS read models** — `src/core/projections` fold the log into the Dossier, the
  Pots, and the Leaderboard. Rebuildable from the log on boot.
- **Pure game logic** — `src/game` (parimutuel settlement, Gaffer Rating, Form,
  tiers). Deterministic, unit-tested (`tests/game.test.ts`).
- **The Gaffer** — `src/gaffer` (Claude Opus 4.8 + a deterministic scripted
  fallback). Memory-aware: recalls from Walrus, never invents history.
- **Typed API** — `src/api` (tRPC router + WS). `AppRouter` is the frontend contract.

## Run it

```bash
bun install
bun run smoke       # full loop end-to-end, no keys/network — prints the day1→day2 contrast
bun test            # game-logic unit tests
bun run typecheck   # tsc --noEmit
bun run dev         # the server on :8787 (PORT to override), with --watch
```

With **zero env set** it boots fully self-contained: in-memory event log, the
**scripted** Gaffer, **play-money** custody, **mock** fixtures. Set keys to light
up each real adapter independently (see `.env.example`).

## Integration seams (for the other agents)

Everything that touches the outside world is a port with an in-memory adapter
today and a real adapter as a drop-in. The core never changes.

| Seam | Port | Now | Real adapter |
|---|---|---|---|
| **On-chain / WAL** | `src/ports/Custody.ts` | `PlayLedgerCustody` (default) | `SuiCustody` — **done**: verifies inbound WAL deposits (from-player → Sessions, finalised, replay-deduped) and signs WAL payouts. Round-trip tested on Sui testnet. Set `SESSIONS_WALLET_*` + `WAL_COIN_TYPE` to enable. |
| **Walrus memory** | `src/core/memory/MemoryStore.ts` | `InMemoryMemoryStore` | `WalrusMemoryStore` over `HttpMemWalClient` — confirm the relayer routes + delegate token from `memwal login`. |
| **Football data** | `src/ports/MatchData.ts` | `MockMatchData` | implement `MatchDataProvider` over a World Cup API; set `FOOTBALL_API_BASE`. |
| **The voice** | `src/gaffer/Gaffer.ts` | `ScriptedGaffer` | `ClaudeGaffer` (auto-selected when `ANTHROPIC_API_KEY` is set). |

**Frontend:** import the API contract directly — no codegen.

```ts
import type { AppRouter } from "<this-repo>/src/api/router.ts";
// createTRPCClient<AppRouter>({ links: [...] }) — httpBatchLink + wsLink (splitLink).
// Auth: header `x-wallet: <address>` (HTTP) or connectionParams { wallet } (WS).
```

Key procedures: `health`, `matchday`, `match`, `leaderboard`, `dossier` (public),
`me`/`touchline` (authed), `preBetRead`, `signContract`, `deposit`, `withdraw`,
`makeCall`, `declareHotTake`, `requestVerdict`, `chat`, and subscriptions
`onMatch`, `onDossier`, `onFeed`.

## Deploy (Railway)

A `Dockerfile` (Bun) and `railway.json` are included; health check is `/health`.

```bash
railway up           # from a linked Railway project
```

Set in Railway: `ANTHROPIC_API_KEY`, `MEMWAL_RELAYER_URL` (+ token), the
`SESSIONS_WALLET_*` + `WAL_COIN_TYPE` (real WAL) and `FOOTBALL_API_*` vars as each
seam goes live. `PORT` is injected by Railway automatically.

## Status / next

- ✅ Core loop, settlement, rating, memory write/recall, tRPC HTTP + WS, tests.
- ✅ **`SuiCustody`** — real WAL on the dedicated Sessions wallet: deposit
  verification (from-player → Sessions, finality, replay-deduped) and signed
  payouts. Round-trip tested on Sui testnet:
  `WAL_COIN_TYPE=… bun run scripts/sui-roundtrip-test.ts`. Enable with
  `SESSIONS_WALLET_*` + `WAL_COIN_TYPE`; otherwise it stays on play-money.
- ⬜ **MemWal login** — run the `memwal_login` browser flow, then wire/verify
  `HttpMemWalClient` routes. Until then memory is in-process (the loop still runs).
- ⬜ Walrus-mirror the event log for durable, rebuildable state across restarts.
- ⬜ A live `MatchDataProvider` over a World Cup API.
