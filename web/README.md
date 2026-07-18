# Chumbucket Arena Web

The browser client for Chumbucket's social prediction markets. It is built with
Next.js App Router, React, TypeScript, and the shared Chumbucket visual language.

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
bun run build
bun run dev
```

The local app is available at `http://localhost:3000`.

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
