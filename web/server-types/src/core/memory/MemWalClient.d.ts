/**
 * Thin client over Walrus Memory (MemWal). The relayer/SDK surface mirrors the
 * three operations we need; this interface lets the rest of the system depend on
 * the *capability*, not the wire format. One concrete implementation talks to the
 * managed relayer; tests use the in-memory store and never touch this.
 *
 * NOTE: the HTTP shapes below follow the MemWal recall/remember/restore surface
 * (namespace + text + query + limit). Confirm against the deployed relayer and
 * its auth (delegate key from `memwal login`) before the first live call.
 */
export interface MemWalRecallHit {
    text: string;
    score?: number;
    createdAt?: number;
    metadata?: Record<string, unknown>;
}
export interface MemWalClient {
    remember(namespace: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
    recall(namespace: string, query: string, limit: number): Promise<MemWalRecallHit[]>;
    restore(namespace: string, limit: number): Promise<{
        count: number;
    }>;
}
export interface HttpMemWalConfig {
    baseUrl: string;
    /** Bearer/delegate token written by `memwal login`. */
    token?: string;
    fetchImpl?: typeof fetch;
}
/**
 * HTTP client against the MemWal relayer. Endpoint paths are the conventional
 * REST projection of the relayer tools; adjust to the real routes once verified.
 */
export declare class HttpMemWalClient implements MemWalClient {
    private readonly baseUrl;
    private readonly token?;
    private readonly doFetch;
    constructor(cfg: HttpMemWalConfig);
    private post;
    remember(namespace: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
    recall(namespace: string, query: string, limit: number): Promise<MemWalRecallHit[]>;
    restore(namespace: string, limit: number): Promise<{
        count: number;
    }>;
}
