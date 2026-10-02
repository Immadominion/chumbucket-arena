/**
 * Panta's own view of a wallet's holdings: `GET /positions/?wallet=`.
 * Docs (read 2026-10-02): https://docs.panta.market/api-reference/positions.md
 *
 * Rows carry share counts and claim eligibility, not dollars: `side`,
 * `shares`, `phase`, `claimable`, `claimed`, `outcome`. A holding with both
 * sides is two rows. The indexer may lag the chain briefly after a purchase,
 * so a missing row is "not reported yet", never "no position".
 *
 * Panta's `positions` budget is 60 requests a minute PER API KEY — shared by
 * every Chumbucket user — so this reader caches per wallet and keeps its own
 * budget below Panta's. When the budget or Panta is unavailable it answers
 * `null` and the caller shows "Panta holdings unavailable", never zeros.
 */
import { utils } from "@coral-xyz/anchor";
import { z } from "zod";
import { systemClock, type Clock } from "./clock.ts";
import { PANTA_BASE_URL } from "./PantaVenue.ts";
import { registerSecret } from "./redact.ts";

const address = z.string().refine(value => {
  try { return value.length >= 32 && value.length <= 44 && utils.bytes.bs58.decode(value).length === 32; }
  catch { return false; }
});
const decimal = z.string().regex(/^(0|[1-9][0-9]{0,30})(\.[0-9]{1,18})?$/);
const rowSchema = z.object({
  marketId: address, category: z.string().nullable().optional(),
  side: z.enum(["yes", "no"]), shares: decimal,
  phase: z.enum(["primary", "secondary", "resolved", "cancelled"]),
  claimable: z.boolean(), claimed: z.boolean(),
  outcome: z.enum(["yes", "no"]).nullable(),
}).passthrough();
const pageSchema = z.object({ wallet: address, positions: z.array(z.unknown()).max(1000) }).passthrough();

export interface PantaHolding {
  venueMarketId: string;
  side: "YES" | "NO";
  shares: string;
  phase: "primary" | "secondary" | "resolved" | "cancelled";
  claimable: boolean;
  claimed: boolean;
  outcome: "YES" | "NO" | null;
}
export interface PantaHoldingsReader {
  /** Null when Panta could not be asked right now. */
  holdings(wallet: string): Promise<PantaHolding[] | null>;
}

export class PantaHoldings implements PantaHoldingsReader {
  private readonly clock: Clock;
  private readonly cache = new Map<string, { at: number; rows: PantaHolding[] }>();
  private readonly calls: number[] = [];
  private pausedUntil = 0;

  constructor(private readonly config: {
    apiKey: string; fetchImpl?: typeof fetch; clock?: Clock; timeoutMs?: number;
    /** Per-wallet freshness. Default 30 s. */
    ttlMs?: number;
    /** Our own share of Panta's 60/min positions budget. Default 40. */
    perMinute?: number;
  }) {
    registerSecret(config.apiKey);
    this.clock = config.clock ?? systemClock;
  }

  async holdings(wallet: string): Promise<PantaHolding[] | null> {
    if (!address.safeParse(wallet).success) return null;
    const now = this.clock.now();
    const hit = this.cache.get(wallet);
    if (hit && now - hit.at < (this.config.ttlMs ?? 30_000)) return hit.rows;
    if (now < this.pausedUntil) return hit?.rows ?? null;
    while (this.calls.length && now - this.calls[0]! >= 60_000) this.calls.shift();
    if (this.calls.length >= (this.config.perMinute ?? 40)) return hit?.rows ?? null;
    this.calls.push(now);
    try {
      const res = await (this.config.fetchImpl ?? fetch)(`${PANTA_BASE_URL}/positions/?${new URLSearchParams({ wallet })}`, {
        method: "GET", headers: { "X-Api-Key": this.config.apiKey }, redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 8_000),
      });
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after"));
        this.pausedUntil = now + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 300) * 1000 : 60_000);
        return hit?.rows ?? null;
      }
      if (!res.ok) return hit?.rows ?? null;
      const text = await res.text();
      if (text.length > 524_288 || text.includes(this.config.apiKey)) return null;
      const page = pageSchema.safeParse(JSON.parse(text));
      if (!page.success || page.data.wallet !== wallet) return hit?.rows ?? null;
      const rows: PantaHolding[] = [];
      for (const item of page.data.positions) {
        const row = rowSchema.safeParse(item);
        // One malformed row must not hide the others; it is simply not shown.
        if (!row.success) continue;
        rows.push({ venueMarketId: row.data.marketId, side: row.data.side === "yes" ? "YES" : "NO", shares: row.data.shares,
          phase: row.data.phase, claimable: row.data.claimable, claimed: row.data.claimed,
          outcome: row.data.outcome === null ? null : row.data.outcome === "yes" ? "YES" : "NO" });
      }
      this.cache.set(wallet, { at: now, rows });
      if (this.cache.size > 2048) this.cache.delete(this.cache.keys().next().value!);
      return rows;
    } catch {
      // Never echo provider bodies, request objects or causes.
      return hit?.rows ?? null;
    }
  }

  /** After a claim or a fill, read the wallet fresh next time. */
  forget(wallet: string): void { this.cache.delete(wallet); }
}
