/**
 * Per-wallet, per-endpoint token-bucket rate limiter, plus a global daily ceiling
 * on paid LLM calls. Every endpoint a player can use to trigger an Anthropic
 * request — chat, verdict, pre-bet read — gets its own bucket: a small burst for
 * natural use, then a slow refill that throttles a spam loop down to a trickle.
 * The global counter is the backstop: even a Sybil swarm of fresh wallets can't
 * push total model calls past `globalDailyCap` in one UTC day.
 *
 * State is in-process — correct for a single instance (one Railway service). If
 * this ever scales horizontally, move the buckets + daily counter to shared
 * storage (e.g. Redis) so the limits hold across instances.
 */
export interface BucketSpec {
    /** Max tokens — the burst an idle wallet can spend back-to-back. */
    capacity: number;
    /** Milliseconds to refill one token. Sustained rate = 1 request / refillMs. */
    refillMs: number;
}
export type LlmEndpoint = "chat" | "verdict" | "preBetRead";
export interface RateLimitConfig {
    chat: BucketSpec;
    verdict: BucketSpec;
    preBetRead: BucketSpec;
    /** Hard ceiling on total paid LLM calls per UTC day across all wallets. */
    globalDailyCap: number;
}
export declare class RateLimiter {
    private readonly config;
    private readonly buckets;
    private dayKey;
    private dayCount;
    constructor(config: RateLimitConfig);
    /**
     * Charge one token for `wallet` on `endpoint`, to be called immediately before
     * the model request. Throws RATE_LIMITED (→ HTTP 429) when the wallet's bucket
     * is empty or the global daily cap is reached; the global budget is only
     * consumed when the request is actually allowed through.
     */
    charge(endpoint: LlmEndpoint, wallet: string, now?: number): void;
}
