/**
 * Configuration. One typed object assembled from the environment, with safe
 * defaults so the system boots fully in-memory (no keys, no network) for dev,
 * tests, and the smoke run.
 */

import type { Frost } from "./domain/ids.ts";
import type { RateLimitConfig } from "./engine/RateLimiter.ts";

export interface GameConfig {
  rakeBps: number; // basis points of the losers' pool → Manager's Pot
  minParticipants: number; // thin-pool threshold
  minStake: Frost; // smallest allowed stake (FROST)
  namespacePrefix: string; // Walrus namespace prefix, e.g. "gaffer"
  welcomeGrant: Frost; // one-time NON-withdrawable starter bonus (play, don't cash out)
  withdrawFeeBps: number; // house fee on withdrawals — covers on-chain gas + margin
  withdrawFeeMin: Frost; // flat floor so tiny cash-outs still cover ~fixed gas
  rateLimits: RateLimitConfig; // per-wallet buckets + global daily cap on paid LLM calls
  house: HouseConfig; // synthetic house bettors that seed a counterparty per match
}

export interface HouseConfig {
  enabled: boolean; // master switch for house liquidity seeding
  botCount: number; // distinct house wallets (≥2 so player+bots clears minParticipants)
  seedStake: Frost; // each bot's stake per match (FROST)
  bankrollPerBot: Frost; // one-time, float-backed capital per bot
  liquidityCap: Frost; // hard ceiling on total house capital (clamps bankroll × botCount)
}

export interface AppConfig {
  port: number;
  /** Durable event-log path (SQLite). Unset → in-memory (state lost on restart). */
  eventLogPath?: string;
  /** Secret that gates the demo "resolve match now" endpoint. Unset → disabled. */
  demoAdminKey?: string;
  anthropicApiKey?: string;
  /** The Gaffer's voice. Cheapest capable model by default; verdict can upgrade. */
  models: { default: string; verdict: string };
  memwal?: { privateKey: string; accountId: string; serverUrl?: string };
  football?: {
    apiKey: string;
    baseUrl: string;
    competitions: { league: number; season: number }[];
    cacheTtlMs: number;
  };
  /** football-data.org — free tier covers the live World Cup (code "WC"). */
  footballData?: {
    apiKey: string;
    baseUrl: string;
    competitions: string[];
    cacheTtlMs: number;
  };
  solana: {
    rpcUrl: string;
    sessionsAddress?: string;
    sessionsKey?: string;
    usdcMint?: string;
    /** Opt in to Privy MPC custody (no env-var key) instead of the raw keypair. */
    privyCustody?: boolean;
    /** external_id of the Sessions Privy wallet (default "gaffer_sessions"). */
    sessionsExternalId?: string;
  };
  /** Auth / embedded wallets (Privy). Verified server-side; users never see crypto. */
  privy?: { appId: string; appSecret?: string; verificationKey?: string };
  /** Supabase social read model used by the mobile app and indexer. */
  social?: {
    supabaseUrl: string;
    serviceRoleKey: string;
    network: "devnet" | "mainnet-beta";
  };
  /** External indexer/webhook integration settings. */
  indexer?: {
    heliusWebhookAuth?: string;
  };
  /** TxLINE — live World Cup data + on-chain settlement verification. Unset → mock data, verification stubbed to always-pass. */
  txline?: {
    apiBaseUrl: string;
    rpcUrl: string;
    programId: string;
    /** Pre-activated API token (the guest-JWT + on-chain-subscribe dance is a one-time setup step, not runtime config). */
    apiToken: string;
    jwt: string;
  };
  /**
   * The on-chain keeper — drives chumbucket_arena's create_pot/lock_pot/
   * settle_pot/sweep_rake against the SAME fixtures the backend already tracks
   * (via readModel.pots), completely separate from the custodial Engine's
   * off-chain ledger. Opt-in (ONCHAIN_KEEPER_ENABLED=true) so it never runs in
   * tests/CI by default. See src/keeper/onchainDriver.ts.
   */
  onchainKeeper?: OnchainKeeperConfig;
  /**
   * The pull-based reconciler — walks chumbucket_arena's tx history and repairs
   * the Supabase social read model from on-chain truth (positions, settlements,
   * claims). Opt-in via social config; independent of the keeper. See
   * src/indexer/ArenaReconciler.ts.
   */
  reconciler?: ReconcilerConfig;
  game: GameConfig;
}

export interface ReconcilerConfig {
  enabled: boolean;
  rpcUrl: string;
  programId: string;
  tickMs: number;
  maxSignaturesPerPass: number;
}

export interface OnchainKeeperConfig {
  enabled: boolean;
  /**
   * Raw Solana secret-key JSON array (Keypair.fromSecretKey shape), inline —
   * for platforms (Railway, etc.) whose deploy upload has no way to ship a
   * gitignored file: it must stay gitignored, so it can never reach a build
   * artifact either, which means it has to travel as a secret env var instead.
   * Takes precedence over keypairPath when both are set.
   */
  keypairJson?: string;
  /** Path to a raw Solana secret-key JSON array (Keypair.fromSecretKey shape). Never committed. */
  keypairPath: string;
  rpcUrl: string;
  /** chumbucket_arena's deployed program id. */
  programId: string;
  /** TxLINE's txoracle program id — the CPI target settle_pot proves against. */
  txoracleProgramId: string;
  txlineApiBaseUrl: string;
  txlineJwt: string;
  txlineApiToken: string;
  /** Only used the one time Config doesn't exist yet on-chain (init_config). */
  rakeBps: number;
  minParticipants: number;
  /** Only used for a fresh init_config — an existing Config already pins its own mint. */
  usdcMint?: string;
  tickMs: number;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Parse "1:2026,39:2025" → [{league:1,season:2026},{league:39,season:2025}]. */
function parseCompetitions(raw: string | undefined): { league: number; season: number }[] | undefined {
  if (!raw) return undefined;
  const out = raw
    .split(",")
    .map((pair) => pair.split(":").map((n) => Number(n.trim())))
    .filter(([l, s]) => Number.isFinite(l) && Number.isFinite(s))
    .map(([league, season]) => ({ league: league as number, season: season as number }));
  return out.length ? out : undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const cfg: AppConfig = {
    port: num(env.PORT, 8787),
    models: {
      default: env.GAFFER_MODEL ?? "claude-haiku-4-5",
      // The Verdict is the shareable, viral artifact — worth the flagship model.
    verdict: env.GAFFER_VERDICT_MODEL ?? "claude-opus-4-8",
    },
    solana: { rpcUrl: env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com" },
    game: {
      rakeBps: num(env.RAKE_BPS, 250),
      minParticipants: num(env.MIN_PARTICIPANTS, 3),
      minStake: BigInt(env.MIN_STAKE_FROST ?? "1000000"), // 1 USDC
      namespacePrefix: env.MEMWAL_NAMESPACE_PREFIX ?? "gaffer",
      // Non-withdrawable starter bonus. 50 USDC on devnet; set lower on mainnet.
      welcomeGrant: BigInt(env.WELCOME_GRANT_FROST ?? "50000000"),
      // Withdrawal fee = max(bps%, flat min) → kept by the house to cover gas.
      withdrawFeeBps: num(env.WITHDRAW_FEE_BPS, 200), // 2%
      withdrawFeeMin: BigInt(env.WITHDRAW_FEE_MIN_FROST ?? "50000"), // 0.05 USDC
      // Rate limits on the paid (Anthropic) endpoints. Buckets are a burst +
      // a slow refill; the global cap is the per-day backstop against Sybils.
      rateLimits: {
        // Chat: 5-message burst, then ~1/min — a real conversation flows, a loop chokes.
        chat: { capacity: num(env.RL_CHAT_BURST, 5), refillMs: num(env.RL_CHAT_REFILL_MS, 60_000) },
        // Verdict: the expensive, deliberate call — 5-minute cooldown (burst of 2).
        verdict: { capacity: num(env.RL_VERDICT_BURST, 2), refillMs: num(env.RL_VERDICT_REFILL_MS, 300_000) },
        // Pre-bet read: fired by the staking UI, so looser — 10 burst, then 1/15s.
        preBetRead: { capacity: num(env.RL_PREBET_BURST, 10), refillMs: num(env.RL_PREBET_REFILL_MS, 15_000) },
        // Hard daily ceiling on ALL model calls, every wallet combined.
        globalDailyCap: num(env.RL_GLOBAL_DAILY_CAP, 3000),
      },
      // House liquidity — seeds a counterparty so solo bets actually settle.
      // Just-in-time (only matches a real player touches) and float-backed.
      house: {
        enabled: (env.HOUSE_LIQUIDITY_ENABLED ?? "true") !== "false",
        botCount: num(env.HOUSE_BOT_COUNT, 3), // one per outcome (HOME/AWAY/DRAW)
        seedStake: BigInt(env.HOUSE_SEED_STAKE_FROST ?? "1000000"), // 1 USDC per bot per match
        bankrollPerBot: BigInt(env.HOUSE_BANKROLL_FROST ?? "10000000"), // 10 USDC one-time per bot
        liquidityCap: BigInt(env.HOUSE_LIQUIDITY_CAP_FROST ?? "30000000"), // 30 USDC total exposure (< float)
      },
    },
  };
  if (env.EVENT_LOG_PATH) cfg.eventLogPath = env.EVENT_LOG_PATH;
  if (env.DEMO_ADMIN_KEY) cfg.demoAdminKey = env.DEMO_ADMIN_KEY;
  if (env.ANTHROPIC_API_KEY) cfg.anthropicApiKey = env.ANTHROPIC_API_KEY;
  if (env.MEMWAL_PRIVATE_KEY && env.MEMWAL_ACCOUNT_ID) {
    cfg.memwal = { privateKey: env.MEMWAL_PRIVATE_KEY, accountId: env.MEMWAL_ACCOUNT_ID };
    if (env.MEMWAL_SERVER_URL) cfg.memwal.serverUrl = env.MEMWAL_SERVER_URL;
  }
  if (env.API_FOOTBALL_KEY) {
    cfg.football = {
      apiKey: env.API_FOOTBALL_KEY,
      baseUrl: env.API_FOOTBALL_BASE ?? "https://v3.football.api-sports.io",
      // World Cup (league 1, season 2026) is the flagship; add more "league:season"
      // pairs (comma-separated) to feature other competitions — it's a platform.
      competitions: parseCompetitions(env.FOOTBALL_COMPETITIONS) ?? [{ league: 1, season: 2026 }],
      cacheTtlMs: num(env.API_FOOTBALL_CACHE_TTL_MS, 900_000), // 15 min — stays under the free tier
    };
  }
  if (env.FOOTBALL_DATA_API_KEY) {
    cfg.footballData = {
      apiKey: env.FOOTBALL_DATA_API_KEY,
      baseUrl: env.FOOTBALL_DATA_BASE ?? "https://api.football-data.org/v4",
      // World Cup ("WC") by default; comma-separated competition codes for more.
      competitions: (env.FOOTBALL_DATA_COMPETITIONS ?? "WC").split(",").map((c) => c.trim()).filter(Boolean),
      cacheTtlMs: num(env.FOOTBALL_DATA_CACHE_TTL_MS, 60_000), // free tier = 10 req/min; cache keeps us ~1/min
    };
  }
  if (env.SESSIONS_WALLET_ADDRESS) cfg.solana.sessionsAddress = env.SESSIONS_WALLET_ADDRESS;
  if (env.SESSIONS_WALLET_KEY) cfg.solana.sessionsKey = env.SESSIONS_WALLET_KEY;
  if (env.USDC_MINT) cfg.solana.usdcMint = env.USDC_MINT;
  if (env.PRIVY_CUSTODY === "true") cfg.solana.privyCustody = true;
  if (env.SESSIONS_EXTERNAL_ID) cfg.solana.sessionsExternalId = env.SESSIONS_EXTERNAL_ID;
  if (env.PRIVY_APP_ID) {
    cfg.privy = { appId: env.PRIVY_APP_ID };
    if (env.PRIVY_APP_SECRET) cfg.privy.appSecret = env.PRIVY_APP_SECRET;
    if (env.PRIVY_VERIFICATION_KEY) cfg.privy.verificationKey = env.PRIVY_VERIFICATION_KEY;
  }
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const network = (env.SOLANA_NETWORK ?? "devnet").toLowerCase();
    cfg.social = {
      supabaseUrl: env.SUPABASE_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
      network: network === "mainnet" || network === "mainnet-beta" ? "mainnet-beta" : "devnet",
    };
  }
  if (env.HELIUS_WEBHOOK_AUTH) {
    cfg.indexer = { heliusWebhookAuth: env.HELIUS_WEBHOOK_AUTH };
  }
  if (env.TXLINE_API_BASE_URL && env.TXLINE_PROGRAM_ID && env.TXLINE_API_TOKEN && env.TXLINE_JWT) {
    cfg.txline = {
      apiBaseUrl: env.TXLINE_API_BASE_URL,
      rpcUrl: env.TXLINE_RPC_URL ?? cfg.solana.rpcUrl,
      programId: env.TXLINE_PROGRAM_ID,
      apiToken: env.TXLINE_API_TOKEN,
      jwt: env.TXLINE_JWT,
    };
  }
  // Opt-in, off by default (never in tests/CI). Needs TxLINE creds either way
  // (for the settlement proof fetch). Deliberately prefers its OWN dedicated
  // KEEPER_TXLINE_* vars over the custodial TXLINE_* ones (falling back to the
  // latter only for local-dev convenience where one TxLINE credential set is
  // shared): setting plain TXLINE_* also flips the CUSTODIAL Engine's matchData
  // + settlementVerifier wiring (see the cfg.txline block above) — a shared
  // production deploy must be able to enable this keeper WITHOUT silently
  // rerouting that separate, unrelated system.
  if (env.ONCHAIN_KEEPER_ENABLED === "true") {
    const txlineApiBaseUrl = env.KEEPER_TXLINE_API_BASE_URL ?? env.TXLINE_API_BASE_URL ?? cfg.txline?.apiBaseUrl;
    const txlineJwt = env.KEEPER_TXLINE_JWT ?? env.TXLINE_JWT ?? cfg.txline?.jwt;
    const txlineApiToken = env.KEEPER_TXLINE_API_TOKEN ?? env.TXLINE_API_TOKEN ?? cfg.txline?.apiToken;
    if (!txlineApiBaseUrl || !txlineJwt || !txlineApiToken) {
      throw new Error(
        "ONCHAIN_KEEPER_ENABLED=true requires KEEPER_TXLINE_API_BASE_URL + KEEPER_TXLINE_JWT + KEEPER_TXLINE_API_TOKEN " +
          "(or the shared TXLINE_API_BASE_URL/TXLINE_JWT/TXLINE_API_TOKEN) — the keeper fetches settlement proofs from TxLINE.",
      );
    }
    cfg.onchainKeeper = {
      enabled: true,
      // Defaults to the repo's own funded devnet admin key (see onchain/gaffer_verifier/devnet-wallet.json —
      // gitignored, confirmed to equal the live devnet Config.admin for chumbucket_arena).
      keypairPath: env.KEEPER_KEYPAIR_PATH ?? "./onchain/gaffer_verifier/devnet-wallet.json",
      ...(env.KEEPER_KEYPAIR_JSON ? { keypairJson: env.KEEPER_KEYPAIR_JSON } : {}),
      rpcUrl: env.ONCHAIN_KEEPER_RPC_URL ?? cfg.txline?.rpcUrl ?? cfg.solana.rpcUrl,
      programId: env.CHUMBUCKET_PROGRAM_ID ?? "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG",
      txoracleProgramId:
        env.CHUMBUCKET_TXORACLE_PROGRAM_ID ?? env.TXLINE_PROGRAM_ID ?? "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
      txlineApiBaseUrl,
      txlineJwt,
      txlineApiToken,
      rakeBps: cfg.game.rakeBps,
      minParticipants: cfg.game.minParticipants,
      ...(env.CHUMBUCKET_USDC_MINT ? { usdcMint: env.CHUMBUCKET_USDC_MINT } : {}),
      tickMs: num(env.ONCHAIN_KEEPER_TICK_MS, 60_000),
    };
  }
  // Reconciler — on by default whenever the Supabase social store is configured
  // (it only reads chain + writes the read model; never signs). Turn off with
  // RECONCILER_ENABLED=false. Shares the keeper's RPC/program by default.
  if (cfg.social && env.RECONCILER_ENABLED !== "false") {
    cfg.reconciler = {
      enabled: true,
      rpcUrl:
        env.RECONCILER_RPC_URL ??
        env.ONCHAIN_KEEPER_RPC_URL ??
        cfg.onchainKeeper?.rpcUrl ??
        cfg.txline?.rpcUrl ??
        cfg.solana.rpcUrl,
      programId:
        env.CHUMBUCKET_PROGRAM_ID ?? cfg.onchainKeeper?.programId ?? "AMFpYiYPCUwiVbYMkhnaCmnSDv226yew17QXLhVWk9CG",
      tickMs: num(env.RECONCILER_TICK_MS, 60_000),
      maxSignaturesPerPass: num(env.RECONCILER_MAX_SIGS, 1000),
    };
  }
  return cfg;
}
