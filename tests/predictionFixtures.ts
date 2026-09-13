/**
 * Shared helpers for the Packet B tests. RECORDED/SYNTHETIC Jupiter payloads
 * only — nothing in this repo ever calls Jupiter, and no real API key exists
 * here. Every JupiterVenue test drives the adapter through an injected fetch.
 */

import type { Clock } from "../src/prediction/clock.ts";
import type { FetchLike } from "../src/prediction/http.ts";

export const T0 = 1_760_000_000_000;

/** A clock whose sleeps are instant but still move time, so backoff is assertable. */
export class TestClock implements Clock {
  private t: number;
  readonly slept: number[] = [];

  constructor(start: number = T0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.t += ms;
  }

  advance(ms: number): void {
    this.t += ms;
  }
}

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

export interface FetchLog {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface StubFetch {
  fetch: FetchLike;
  calls: FetchLog[];
}

/** Build a fetch stub from a handler. Records every call for assertions. */
export function stubFetch(
  handler: (url: URL, log: FetchLog) => Response | Promise<Response>,
): StubFetch {
  const calls: FetchLog[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const log: FetchLog = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(log);
    return handler(new URL(String(input)), log);
  };
  return { fetch: fetchImpl, calls };
}

/** A fetch that never resolves until the request is aborted — for timeout tests. */
export function hangingFetch(): StubFetch {
  const calls: FetchLog[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: undefined,
    });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  };
  return { fetch: fetchImpl, calls };
}

// ── synthetic Jupiter wire payloads ─────────────────────────────────────────

export interface JupMarketFixture {
  marketId: string;
  eventId: string;
  question: string;
  rules: string;
  category?: string;
  status: string;
  outcomes: { side: string; label: string }[];
  openTime?: number | null;
  closeTime?: number | null;
  resolveTime?: number | null;
  resolutionSource?: string | null;
  resolution?: string | null;
  yesPrice?: number | null;
}

export function jupMarket(overrides: Partial<JupMarketFixture> = {}): JupMarketFixture {
  return {
    marketId: "jup-mkt-btc-120k",
    eventId: "jup-evt-btc",
    question: "Will BTC trade above $120,000 before 31 Dec 2026?",
    rules: "Resolves YES if the Coinbase BTC-USD index prints above 120000.00 before the close time.",
    category: "crypto",
    status: "open",
    outcomes: [
      { side: "yes", label: "Yes" },
      { side: "no", label: "No" },
    ],
    openTime: T0 - 86_400_000,
    closeTime: T0 + 86_400_000,
    resolveTime: null,
    resolutionSource: "Coinbase BTC-USD index",
    resolution: null,
    yesPrice: 0.62,
    ...overrides,
  };
}

/** One synthetic market per normalized lifecycle state. */
export const JUP_LIFECYCLE: Record<string, JupMarketFixture> = {
  OPEN: jupMarket({ marketId: "jup-open", status: "open" }),
  CLOSED_PENDING_RESOLUTION: jupMarket({
    marketId: "jup-closed",
    status: "pending_resolution",
    closeTime: T0 - 3_600_000,
  }),
  "RESOLVED-YES": jupMarket({
    marketId: "jup-resolved-yes",
    status: "resolved",
    resolution: "yes",
    resolveTime: T0 - 3_600_000,
    yesPrice: 1,
  }),
  "RESOLVED-NO": jupMarket({
    marketId: "jup-resolved-no",
    status: "settled",
    resolution: "no",
    resolveTime: T0 - 3_600_000,
    yesPrice: 0,
  }),
  CANCELLED: jupMarket({
    marketId: "jup-cancelled",
    status: "voided",
    resolution: "void",
    resolveTime: T0 - 7_200_000,
  }),
  PAUSED: jupMarket({ marketId: "jup-paused", status: "halted" }),
};

export const jupEventsPage = (markets: JupMarketFixture[], nextCursor: string | null = null) => ({
  events: markets.map((m) => ({
    eventId: m.eventId,
    title: `Event ${m.eventId}`,
    category: m.category ?? "crypto",
    markets: [m],
  })),
  nextCursor,
});

export const jupOrderbook = (marketId: string) => ({
  marketId,
  bids: [{ side: "yes", price: 0.6, size: "25000000" }],
  asks: [{ side: "yes", price: 0.64, size: "25000000" }],
  ts: T0,
});

export const jupStatus = () => ({
  trading: true,
  reason: null,
  geoBlocked: false,
  kycRequired: false,
  minimumOrder: "1000000",
  ts: T0,
});

export const jupQuote = (overrides: Record<string, unknown> = {}) => ({
  orderId: "jup-order-1",
  marketId: "jup-open",
  owner: "OwnerAddress111",
  side: "yes",
  size: "5000000",
  status: "quoted",
  price: 0.62,
  transaction: { encoding: "solana-tx-base64", payload: "AQIDBA==", expiresAt: T0 + 60_000 },
  createdAt: T0,
  expiresAt: T0 + 60_000,
  ...overrides,
});

export const jupOrder = (overrides: Record<string, unknown> = {}) => ({
  orderId: "jup-order-1",
  venueOrderId: "jup-venue-1",
  marketId: "jup-open",
  owner: "OwnerAddress111",
  side: "yes",
  size: "5000000",
  filledSize: "5000000",
  status: "filled",
  price: 0.62,
  txSignature: "5xSIGNATUREfake",
  createdAt: T0,
  updatedAt: T0 + 1_000,
  idempotencyKey: "idem-key-0001",
  ...overrides,
});
