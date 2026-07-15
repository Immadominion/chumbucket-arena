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
  createdAt?: number; // unix ms
  metadata?: Record<string, unknown>;
}

export interface MemWalClient {
  remember(
    namespace: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  recall(namespace: string, query: string, limit: number): Promise<MemWalRecallHit[]>;
  restore(namespace: string, limit: number): Promise<{ count: number }>;
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
export class HttpMemWalClient implements MemWalClient {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly doFetch: typeof fetch;

  constructor(cfg: HttpMemWalConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    if (cfg.token) this.token = cfg.token;
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`memwal ${path} ${res.status}: ${await res.text().catch(() => "")}`);
    }
    return (await res.json()) as T;
  }

  async remember(
    namespace: string,
    text: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.post("/remember", { namespace, text, metadata });
  }

  async recall(namespace: string, query: string, limit: number): Promise<MemWalRecallHit[]> {
    const out = await this.post<{ results?: MemWalRecallHit[] }>("/recall", {
      namespace,
      query,
      limit,
    });
    return out.results ?? [];
  }

  async restore(namespace: string, limit: number): Promise<{ count: number }> {
    return this.post<{ count: number }>("/restore", { namespace, limit });
  }
}
