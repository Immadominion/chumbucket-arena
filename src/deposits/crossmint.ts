/**
 * Crossmint server transport — the only code that holds the server key.
 *
 * Endpoints (docs/crossmint-deposits.md §2):
 *   PUT  {apiBase}/2025-06-09/users/{userLocator}/linked-wallets/{address}
 *   POST {apiBase}/2022-06-09/orders
 *   GET  {apiBase}/2022-06-09/orders/{orderId}
 *
 * The key travels only in `X-API-KEY`, only to the configured host. Redirects
 * are refused, bodies are bounded, and a failure carries a status and a
 * machine code — never the response body, which can echo request data.
 */

import { CrossmintHttpError } from "./errors.ts";

/** The subset of Crossmint's order object we read. Everything optional. */
export interface CrossmintOrder {
  orderId?: string;
  phase?: string;
  quote?: {
    status?: string;
    expiresAt?: string;
    totalPrice?: { amount?: string; currency?: string };
  };
  lineItems?: Array<{
    chain?: string;
    quote?: {
      status?: string;
      totalPrice?: { amount?: string; currency?: string };
      quantityRange?: { lowerBound?: string; upperBound?: string };
      charges?: Record<string, { amount?: string; currency?: string } | undefined>;
    };
    delivery?: {
      status?: string;
      txId?: string;
      recipient?: { locator?: string; walletAddress?: string };
    };
  }>;
  payment?: {
    status?: string;
    method?: string;
    currency?: string;
    receiptEmail?: string;
    preparation?: { message?: string };
    received?: { amount?: string; currency?: string };
    refunded?: { amount?: string; currency?: string };
    failureReason?: { code?: string; message?: string };
  };
}

export interface CrossmintCreateOrderBody {
  recipient: { walletAddress: string };
  payment: { method: "card"; currency: "usd"; receiptEmail: string };
  lineItems: [{ tokenLocator: string; executionParameters: { mode: "exact-in"; amount: string } }];
  state?: "draft";
}

export interface CrossmintLinkedWallet {
  address?: string;
  chain?: string;
  ownership?: { verified?: boolean };
}

export interface CrossmintTransport {
  linkWallet(input: { userLocator: string; address: string; chain: "solana"; proof?: string }): Promise<CrossmintLinkedWallet>;
  createOrder(body: CrossmintCreateOrderBody): Promise<{ clientSecret: string | null; order: CrossmintOrder }>;
  getOrder(orderId: string): Promise<CrossmintOrder>;
}

const MAX_BODY_BYTES = 256 * 1024;

export class HttpCrossmintTransport implements CrossmintTransport {
  constructor(
    private readonly apiBase: string,
    private readonly serverApiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 12_000,
  ) {
    const parsed = new URL(apiBase);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search) {
      throw new Error("Crossmint API base must be a plain https URL");
    }
  }

  async linkWallet(input: { userLocator: string; address: string; chain: "solana"; proof?: string }): Promise<CrossmintLinkedWallet> {
    const path = `/2025-06-09/users/${encodeLocator(input.userLocator)}/linked-wallets/${encodeURIComponent(input.address)}`;
    const body: Record<string, string> = { chain: input.chain };
    if (input.proof) body.proof = input.proof;
    return (await this.request("PUT", path, body)) as CrossmintLinkedWallet;
  }

  async createOrder(body: CrossmintCreateOrderBody): Promise<{ clientSecret: string | null; order: CrossmintOrder }> {
    const raw = (await this.request("POST", "/2022-06-09/orders", body)) as { clientSecret?: unknown; order?: unknown } | null;
    const order = raw && typeof raw.order === "object" && raw.order ? (raw.order as CrossmintOrder) : null;
    if (!order) throw new CrossmintHttpError(502, null, null);
    return { clientSecret: typeof raw?.clientSecret === "string" ? raw.clientSecret : null, order };
  }

  async getOrder(orderId: string): Promise<CrossmintOrder> {
    const raw = await this.request("GET", `/2022-06-09/orders/${encodeURIComponent(orderId)}`);
    if (!raw || typeof raw !== "object") throw new CrossmintHttpError(502, null, null);
    // Onramp GET returns the order object itself; tolerate an { order } wrapper.
    const wrapped = (raw as { order?: unknown }).order;
    return (wrapped && typeof wrapped === "object" ? wrapped : raw) as CrossmintOrder;
  }

  private async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          "X-API-KEY": this.serverApiKey,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Native errors can carry the URL or headers. Status 0 = no response.
      throw new CrossmintHttpError(0, null, null);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new CrossmintHttpError(res.status || 0, null, null);
    }
    if (text.length > MAX_BODY_BYTES) throw new CrossmintHttpError(502, null, null);
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!res.ok) {
      const record = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
      const code = typeof record.code === "string" && /^[a-z_-]{1,64}$/i.test(record.code) ? record.code : null;
      const params = record.parameters && typeof record.parameters === "object" ? (record.parameters as Record<string, unknown>) : null;
      const limit = params
        ? {
            hoursUntilReset: Number.isFinite(Number(params.hoursUntilReset)) ? Number(params.hoursUntilReset) : null,
            remainingUsd: typeof params.remainingAmount === "string" && /^[0-9]+(\.[0-9]+)?$/.test(params.remainingAmount)
              ? params.remainingAmount
              : null,
          }
        : null;
      throw new CrossmintHttpError(res.status, code, limit);
    }
    if (json === null) throw new CrossmintHttpError(502, null, null);
    return json;
  }
}

/** `userId:chumbucket-<uuid>` keeps its colon; everything else is escaped. */
function encodeLocator(locator: string): string {
  const at = locator.indexOf(":");
  if (at <= 0) throw new Error("A Crossmint user locator needs a type");
  return `${locator.slice(0, at)}:${encodeURIComponent(locator.slice(at + 1))}`;
}
