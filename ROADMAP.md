# ChumBucket × TxLINE — Production Roadmap

**Track:** Prediction Markets & Settlement ($12k) · **Deadline:** 2026-07-19 23:59 UTC · **Repo:** `chumbucket-arena`

## North star
ChumBucket's new capability: **bet a mate 1-v-1, or back an outcome in the pool — and settlement is a pure function of a TxLINE Merkle proof on Solana.** No human referee, no house. The demo shows the full loop: create → fund → match ends → settle-by-proof → winner claims.

## Status — 2026-07-11
- ✅ **On-chain engine** (`gaffer_verifier`, Anchor 1.0.2, devnet): parimutuel market + 1-v-1 + draw-refund; settles only via `validate_stat` CPI. **Devnet-proven** — `validate_stat` still returns `true` against the live Argentina–Egypt root.
- ✅ **Clean repo** `chumbucket-arena` (fresh git), coral design system, live hub on real match data.
- ⏳ Product flows, app on-chain wiring, program rebrand, demo.

## Phases

### P1 — Product surface · Jul 11–14
- **Back-it (market) flow** — rebrand the stake page; pick HOME/DRAW/AWAY, live pool odds, lock. **Done when:** a stake goes end-to-end (play-money) and shows in "Your bets".
- **Challenge (1-v-1) flow** — pick side + stake → create → shareable link → opponent accepts & funds → both locked. **Done when:** two browsers create+accept a challenge and both are staked.
- **Settlement / claim UI** — settled state + winner claim + "settled by TxLINE proof" line. **Done when:** a settled challenge shows the winner and a working claim.
- **Kill Gaffer copy** — onboarding, results, wallet, nav, gate, logo. **Done when:** no "Gaffer/Touchline/manager" strings in user-facing UI.

### P2 — On-chain settlement wiring · Jul 13–16 (the differentiator)
- Keeper creates pots/challenges on the Anchor program (devnet) at match-create.
- Custody: fund via Privy Solana (accept-and-fund) — real devnet USDC.
- `settle_pot` driven by a real TxLINE proof bundle; winner claims on-chain.
- Flip the app's `SettlementVerifier` from stub → real TxLINE gate.
- **Done when:** the full lifecycle runs from the UI on devnet — create → fund → settle-by-proof → claim — with exact fund conservation and explorer tx links.

### P3 — ChumBucket program identity · Jul 16
- Rename `gaffer_verifier` → `chumbucket` settlement program, fresh program ID, redeploy devnet, regen IDL/clients. **Done when:** repo + on-chain identity read ChumBucket.

### P4 — Submission · Jul 17–19
- Demo video (≤5 min): the loop, framed as ChumBucket's new capability ("the match decides, not us").
- Public repo hygiene, README, TxLINE endpoints doc, deployed IDs, tech writeup, API feedback.
- Mobile app: point at the new settlement, push a build.
- **Done when:** submitted before the deadline with a working deployed link + video + repo.

## Critical path & risk
- **Highest risk:** P2 on-chain wiring under deadline. **Mitigation:** the settle-by-proof path is already devnet-proven — we're wiring UI→keeper→program, not inventing settlement. **Fallback demo:** the proven Argentina–Egypt fixture.
- **Verify-before-build** (each P2 task): confirm current Privy Solana signing API, `@solana/web3.js` + `@coral-xyz/anchor` 0.32/1.0 client, and the TxLINE proof-bundle endpoint shape before coding.

## Non-negotiables
No token (settle SOL/USDC). Never touch the live mainnet Pinocchio program. Never cite unverified traction. Fix the false "1%/$10" fee copy. No SpongeBob-derivative art.
