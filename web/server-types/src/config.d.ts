/**
 * Configuration. One typed object assembled from the environment, with safe
 * defaults so the system boots fully in-memory (no keys, no network) for dev,
 * tests, and the smoke run.
 */
import type { Frost } from "./domain/ids";
import type { RateLimitConfig } from "./engine/RateLimiter";
export interface GameConfig {
    rakeBps: number;
    minParticipants: number;
    minStake: Frost;
    namespacePrefix: string;
    welcomeGrant: Frost;
    withdrawFeeBps: number;
    withdrawFeeMin: Frost;
    rateLimits: RateLimitConfig;
    house: HouseConfig;
}
export interface HouseConfig {
    enabled: boolean;
    botCount: number;
    seedStake: Frost;
    bankrollPerBot: Frost;
    liquidityCap: Frost;
}
export interface AppConfig {
    port: number;
    /** Durable event-log path (SQLite). Unset → in-memory (state lost on restart). */
    eventLogPath?: string;
    /** Secret that gates the demo "resolve match now" endpoint. Unset → disabled. */
    demoAdminKey?: string;
    anthropicApiKey?: string;
    /** The Gaffer's voice. Cheapest capable model by default; verdict can upgrade. */
    models: {
        default: string;
        verdict: string;
    };
    memwal?: {
        privateKey: string;
        accountId: string;
        serverUrl?: string;
    };
    football?: {
        apiKey: string;
        baseUrl: string;
        competitions: {
            league: number;
            season: number;
        }[];
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
    privy?: {
        appId: string;
        appSecret?: string;
        verificationKey?: string;
    };
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
export declare function loadConfig(env?: Record<string, string | undefined>): AppConfig;
