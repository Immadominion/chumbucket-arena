# Chumbucket Arena

Chumbucket is a social prediction product on Solana. People can call a live
football result, follow people whose judgement they trust, copy a call, or
challenge a friend. TxLINE supplies the match data and cryptographic proof;
Chumbucket's Solana program holds the pot and releases claims only after that
proof validates on-chain.

This repository contains the Arena backend, social indexer, settlement keeper,
Solana program, proof receipt, and Next.js web app. The Flutter mobile client is
in [Chum-Bucket](https://github.com/Immadominion/Chum-Bucket).

## Live build

- Web app: [thegaffer.fun](https://thegaffer.fun) (the domain predates the
  Chumbucket rebrand)
- Arena API: [Railway health](https://chumbucket-arena-production.up.railway.app/health)
- Arena program (devnet):
  [`AMFp...K9CG`](https://explorer.solana.com/address/AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG?cluster=devnet)
- TxLINE oracle (devnet):
  [`6pW6...yP2J`](https://explorer.solana.com/address/6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J?cluster=devnet)
- Original friend-challenge escrow (mainnet):
  [`D6mj...9sF1`](https://explorer.solana.com/address/D6mjMGW1fX8oH3UcwZDh3teWcHEWvghUqaR2aeWD9sF1)

The hackathon Arena uses devnet USDC-like test tokens. The existing mobile
friend-challenge product and its Pinocchio escrow predate this hackathon and are
deployed on mainnet.

## Existing traction

Verified on July 18, 2026:

- Production Supabase: `185` user profiles, `183` linked wallets, `160` push
  notification tokens, `48` friend relationships, and `49` challenge records.
- Original mainnet escrow: `15` successful funded challenge creations locking
  `0.19 SOL`, `13` successful resolutions, and `0.00325 SOL` in protocol fees.
- The new Arena read model already contains `5` markets, `7` positions, `15`
  social prediction activities, and `5` settlement receipts on devnet.

These are deliberately reported as separate measurements. A registered profile
is not presented as an on-chain bettor, and a database challenge record is not
presented as a funded mainnet escrow. Reproduce both reports with
`analyze:product-traction` and `analyze:legacy-usage` below.

## Product flow

1. TxLINE fixtures populate the mobile and web matchday.
2. A user connects a wallet and calls HOME, DRAW, or AWAY.
3. USDC is locked in a pot PDA owned by the Arena program.
4. The keeper waits for a terminal TxLINE score event.
5. It fetches the two-stat Merkle proof and submits `settle_pot`.
6. `settle_pot` binds the proof to the pot's fixture and match window, then CPIs
   into TxLINE's `validate_stat` instruction.
7. Winning positions become claimable. Helius and the reconciler project the
   chain result into feeds, profiles, leaderboards, and notifications.

No operator-supplied score can release a valid pot. A wrong fixture, wrong day
root, non-terminal result, mismatched exact score, or rejected TxLINE predicate
leaves the pot unsettled.

## TxLINE integration

TxLINE is the Arena's primary match and settlement data source:

| Endpoint / primitive | Use |
| --- | --- |
| `GET /api/fixtures/snapshot` | World Cup fixture discovery and matchday |
| `GET /api/scores/snapshot/{fixtureId}` | Terminal status and final score |
| `GET /api/scores/stat-validation?fixtureId=...&seq=...&statKey=1&statKey2=2` | Merkle proof for both teams' goal totals |
| `validate_stat` CPI | On-chain proof of HOME, DRAW, or AWAY |

The adapter deliberately scans the full score snapshot for the highest terminal
sequence (`StatusId` 5, 10, or 13). TxLINE score arrays are not ordered, so using
the last row can settle from a stale in-play event. The proof adapter also
cross-checks the exact score before sending the transaction; the on-chain
predicate then proves the result difference against TxLINE's daily root.

## Architecture

```text
Flutter + MWA                 Next.js + wallet auth
       |                              |
       +----------- tRPC API --------+
                         |
          Railway / Bun Arena service
          |       |        |         |
       TxLINE  Supabase  Helius   SQLite log
          |       social    |      + keeper
          |       graph     |
          +------ Solana devnet -----+
                  Chumbucket Arena
                         |
                  CPI validate_stat
                         |
                    TxLINE oracle
```

- Wallet signatures bind social writes and call metadata to the acting wallet.
- Google and X are optional profile identities; they never replace the wallet
  signature used for money or social authorization.
- Supabase is the social read model. Solana remains authoritative for positions,
  settlement, and claims.
- The Helius webhook and catch-up reconciler are idempotent and cursor-backed, so
  a missed webhook does not lose chain activity.

## Proof receipt

[`receipt-argentina-egypt.json`](onchain/gaffer_verifier/scripts/devnet-lifecycle/receipt-argentina-egypt.json)
contains a complete TxLINE proof bundle captured from a real World Cup feed. The
browser-ready proof page builds an unsigned `validate_stat` transaction and asks
a public Solana RPC to simulate it. A true return value comes from the TxLINE
program reading its own Merkle-root account, not from Chumbucket's backend.

Re-run the proof check with Railway-provided TxLINE credentials:

```bash
DEVNET_JWT=... DEVNET_API_TOKEN=... \
  bun run onchain/gaffer_verifier/scripts/devnet-lifecycle/capture-receipt.ts
```

## Run locally

Backend:

```bash
bun install
bun run typecheck
bun test
bun run dev
```

Web:

```bash
cd web
bun install
bun run build
bun run dev
```

The backend can boot with mock adapters and no secrets. Copy `.env.example` to
configure live TxLINE, Supabase, Privy verification, Helius, and the keeper.

## Verification

- `118` backend tests cover settlement gates, TxLINE wire shapes, proof mapping,
  wallet signatures, social writes, webhooks, reconciliation, claims, and core
  game logic.
- `tsc --noEmit` passes.
- The Next.js production build passes.
- The Flutter client currently has `17` passing tests.

Run the public-chain traction report for the original Chumbucket escrow:

```bash
bun run analyze:legacy-usage
railway run bun scripts/analyze-product-traction.ts
```

It derives successful challenges, SOL locked, resolved fees, cancellations, and
unique signing wallets from the Pinocchio program's mainnet logs.

## TxLINE feedback

What worked well:

- One normalized fixture and score model scales cleanly across the tournament.
- The stat-validation response contains enough material to independently prove
  a result against the Solana root.
- `validate_stat` makes deterministic, permissionless payout logic possible.

Friction we hit:

- Score snapshots are unordered; terminal-event selection needs to be explicit.
- The working two-stat query is `statKey=1&statKey2=2`; a combined `statKeys=1,2`
  form returned `404` during integration.
- `summary.updateStats.minTimestamp`, rather than a top-level response timestamp,
  is the timestamp accepted by `validate_stat`.
- TxLINE may return zstd by default, while Bun fetch could not decompress it in
  our runtime. Sending `Accept-Encoding: identity` made the adapter reliable.
- Proof roots can arrive shortly after the terminal score, so the keeper treats
  an incomplete bundle as retryable and never fabricates a result.

## Repositories

- Mobile: [Immadominion/Chum-Bucket](https://github.com/Immadominion/Chum-Bucket)
- Arena: [Immadominion/chumbucket-arena](https://github.com/Immadominion/chumbucket-arena)
- Original Pinocchio escrow:
  [ubadineke/chumbucket-escrow](https://github.com/ubadineke/chumbucket-escrow)
